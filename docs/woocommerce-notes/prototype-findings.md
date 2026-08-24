# Phase 4 — Prototype Findings

Observed on WordPress 7.1 / WooCommerce 11.0.1 / PHP 8.4, Storefront theme with
block cart and checkout, HPOS enabled. Every statement below was produced by
running the probe and reading the result, not by reading source.

---

## ✅ Confirmed: the render hook differs by product type

The probe registered on two hooks and logged which one fired:

```
[render] #1 product=20 type=simple   hook=woocommerce_before_add_to_cart_button
[render] #1 product=23 type=variable hook=woocommerce_after_variations_table
[render] #2 SKIPPED duplicate for product 23
```

Confirms M2.5 Finding 4 by observation. Two consequences for
[M10.5](../../developePlan.md#m105--product-type-coverage):

1. A simple-product-only test would have passed while leaving Phase 10 with a
   broken assumption.
2. **The variable product reached the render path twice.** Without the
   `static $rendered` guard it would have printed two option blocks. Any
   production renderer needs the same idempotency guard.

---

## ✅ Confirmed: `before_calculate_totals` fires repeatedly

Measured in a single request that added three items:

```
before_calculate_totals: 5 fires
add_cart_item_data:      3 fires
```

**Five fires in one request.** A non-idempotent price application would have
compounded $80 → $100 → $120 → …

The probe stayed correct because it recomputes from `get_regular_price()` every
time rather than adding to the current price:

```php
$base  = Money::from_decimal( $product->get_regular_price() );
$total = $base->plus( Money::from_minor( $delta ) );
$product->set_price( $total->to_decimal_string() );
```

**Rule for Phase 11:** never read the current price and add to it. Always
recompute from the base. This is the single most important implementation detail
found in Phase 4.

---

## ⚠️ CORRECTION: the session-restore hook is NOT required for custom data

The Phase 4 spec was amended before execution to claim that
`woocommerce_get_cart_item_from_session` is required, or the price silently
reverts on reload. **Testing disproved that.** The amendment was too strong.

Disabling the filter entirely and loading the cart in a fresh session still
produced the correct $100.00 with the selection intact.

The reason is in `class-wc-cart-session.php:235`:

```php
$session_data = array_merge(
    $values,                     // ← ALL stored cart item data, including ours
    array( 'data' => $product )  // only the product object is replaced
);
```

WooCommerce persists the whole `cart_item_data` array in the session and merges
it back wholesale. Only the `WC_Product` object is re-fetched. Custom keys
survive automatically.

**What is actually true:**

| Claim | Verdict |
|---|---|
| Custom cart item data survives reload without any filter | ✅ true |
| The *product object* is re-fetched fresh each load | ✅ true |
| Therefore a price set via `set_price()` at add-to-cart time is discarded | ✅ true |
| …but `before_calculate_totals` re-applies it on every load | ✅ true — this is what actually saves it |
| The session filter is required for correctness | ❌ **false** |

**Why keep the filter anyway:** it is the correct place to normalise, migrate, or
validate stored data when the config schema version changes — a real need in
[Phase 9](../../developePlan.md#phase-9--config-sync--cache). It is defensive, not load-bearing.

**Action taken:** the M4.5 amendment has been corrected in `developePlan.md` to
state this accurately rather than leaving an overstated claim in the plan.

---

## ✅ Confirmed: the scalar trap is real and silent

The probe deliberately emitted two display rows — one scalar, one array.

**Classic cart path** (`apply_filters( 'woocommerce_get_item_data', … )`):

```
CLASSIC path sees 2 rows:
   Probe Finish     = Premium
   Probe Array Test = ARRAY(4)
```

**Block cart path** (`GET /wp-json/wc/store/v1/cart`):

```json
"item_data": [ { "key": "Probe Finish", "value": "Premium" } ]
```

The array row is **gone**. No error, no warning, no log entry.

This is `StoreApi\Schemas\V1\CartItemSchema:172`:

```php
foreach ( $data as $data_value ) {
    if ( ! is_scalar( $data_value ) ) { continue 2; }  // drops the WHOLE element
}
```

**Consequences for [M12.2](../../developePlan.md#m122--cart-display):**

- Every value passed to `woocommerce_get_item_data` must be a **pre-formatted
  scalar string**. Join multi-select values before returning.
- A developer testing only on a classic cart would ship this and never see it.
- `Support\Assert::scalar()` exists precisely for this and should be used at that
  boundary.

The earlier spec text — "the block case is expected to fail" — was wrong in the
opposite direction: block cart *works*, and that is what makes the trap dangerous.

---

## ✅ Confirmed: cart item keys separate and merge correctly

```
add 'luxury'  → 1 row
add 'premium' → 2 rows   (different selection = separate line)
add 'premium' → 2 rows   (identical selection = merged, qty 2)
final total: 280.00 = (80+20) + 2 × (80+10)
```

`WC_Cart::generate_cart_id()` hashes `cart_item_data`, so this is free — no
custom key logic needed.

**But** the probe sorts its payload with `ksort()` before attaching, because
`http_build_query()` is order-sensitive. Unsorted data would hash differently for
identical selections and create spurious duplicate rows. Phase 4 has one option
so this could not surface here; it is latent and must be honoured in
[M12.1](../../developePlan.md#m121--cart-item-data-model).

---

## ✅ Confirmed: order meta survives both storage backends

Order #29, total $100.00.

| Backend | Storage class | Meta present |
|---|---|---|
| HPOS | `OrdersTableDataStore` | ✅ `Finish: Luxury` |
| Legacy | `WC_Order_Data_Store_CPT` | ✅ `Finish: Luxury` |

Toggled via `wp wc cot disable` / `enable` after running `wp wc cot sync`. Using
the CRUD API (`$item->add_meta_data()`) rather than direct SQL is what makes this
backend-agnostic.

**Sync prerequisite confirmed necessary.** With sync off, orders exist only in
`wp_wc_orders`; toggling without backfilling first would have shown missing
orders and read as a plugin bug.

---

## ✅ Confirmed: meta key naming controls fulfilment output

Two keys were written deliberately:

```
Finish                 → VISIBLE  → renders in email and print
_optionia_probe_data   → hidden   → machine payload, correctly excluded
```

`get_formatted_meta_data()` returned **1 row** — the human-readable one only.

This validates the [M12.6b](../../developePlan.md#m126b--fulfilment-output) meta-key strategy: WooCommerce renders order item
meta into emails, print views and PDF-invoice plugins automatically, but only for
keys without a leading underscore. A key like `_optionia_sel_a3f9` would be
invisible to a merchant fulfilling from paper.

---

## ⚠️ Environment gotcha: WooCommerce "Coming Soon" mode

The first render test produced zero output and looked like a plugin failure. The
cause was `woocommerce_coming_soon = yes`, which serves a placeholder page
instead of the real product template — so no WooCommerce product hooks fire at
all.

Worth knowing for support: a merchant reporting "options don't appear" may simply
have their store in Coming Soon mode. Add this to the
[System Status](../../developePlan.md#m36--logging-and-diagnostics) report and to troubleshooting docs.

---

## Summary of design rules earned

1. **Recompute price from base every time.** `before_calculate_totals` fires
   ~5×/request.
2. **Guard the renderer against double-firing.** Variable products reach it twice.
3. **Every cart display value must be a scalar string.** Block cart silently drops
   anything else.
4. **Sort selection data before attaching to `cart_item_data`.** The cart key hash
   is order-sensitive.
5. **Use human-readable order meta keys.** Underscore-prefixed keys never reach
   the merchant's printed output.
6. **Use the CRUD API for order meta.** It is what makes HPOS and legacy both work.
7. **The session filter is defensive, not required.** Keep it for schema
   migration, not for correctness.

---

# Round 2 — gaps closed

A recheck found six exit criteria that had been marked complete on partial
evidence. All six were then closed properly. Two produced new findings.

## ✅ Real HTTP checkout (was: synthesized)

Order #29 had been built in PHP with the line-item hook fired manually. That
proves the hook works, not that a real checkout calls it.

Order #31 was placed through `POST /wp-json/wc/store/v1/checkout`:

```
created_via: store-api      ← a genuine checkout path
status:      processing
total:       200.00          = 2 × (80 + 20)
line meta:   Finish: Luxury
```

**Environment prerequisite discovered:** checkout returns HTTP 400 —
*"Sorry, this order requires a shipping option"* — until a shipping method exists
in the zone. A store with no shipping method cannot complete checkout at all.
Worth surfacing in troubleshooting docs.

## ✅ Variable product end-to-end (was: render only)

Previously verified only that it *rendered*. Now taken to cart and priced:

```
Large  + Premium  → 4000   (30.00 + 10.00)
Small  + Premium  → 3000   (20.00 + 10.00)
Large  + Luxury   → 5000   (30.00 + 20.00)
distinct cart lines: 3
```

**Variation id and option data both participate in the cart key independently.**
Changing either the variation or the option produces a separate line, and the
variation's own price is the base the option delta is added to. No interference
between the two mechanisms.

## ✅ Quantity (was: untested)

```
add qty 3            → line total 30000   = 3 × (80 + 20)
update to qty 5      → line total 50000   = 5 × (80 + 20)
```

The option delta multiplies with quantity correctly and does not compound across
the ~5 `before_calculate_totals` fires.

## ✅ Invalid input rejected

```
POST probe_finish=HACKED  →  cart items: 0
```

Whitelist validation holds. The value never reaches the cart.

## ✅ Admin order screen renders the option

Loaded `/wp-admin/admin.php?page=wc-orders&action=edit&id=31` over real HTTP:
`Finish` and `Luxury` both present.

## ✅ Print / email template renders the option

Rendered `emails/email-order-details.php` — the partial WooCommerce uses for
customer email and print output:

```
Finish visible:      YES
Luxury visible:      YES
hidden key leaked:   no
value truncated:     no
```

---

## ⚠️ NEW FINDING: the underscore prefix does NOT hide meta from the admin screen

This corrects an assumption carried since Phase 3.

`_optionia_probe_data` appeared **twice** on the admin order screen — once in the
read-only `display_meta` table and once as an editable form field:

```html
<th>_optionia_probe_data:</th>
<td><p>{"delta":2000,"key":"probe_finish",…</p></td>

<input name="meta_key[5][48]" value="_optionia_probe_data" />
```

The underscore prefix hides meta from **customer-facing** output only. The admin
order screen uses a completely different mechanism —
`OrderItemMetaUtil::get_hidden_keys()`, filtered by
`woocommerce_hidden_order_itemmeta`, which is an explicit allow-list of core keys
(`_qty`, `_tax_class`, `_product_id`, …):

```php
return apply_filters( 'woocommerce_hidden_order_itemmeta', array(
    '_qty', '_tax_class', '_product_id', '_variation_id',
    '_line_subtotal', '_line_total', … ) );
```

**Consequences for [M12.5](../../developePlan.md#m125--order-persistence):**

1. Machine payload keys **must** be registered via
   `woocommerce_hidden_order_itemmeta`, or merchants see raw JSON on every order.
2. Worse, the key is rendered as an **editable input**. A merchant could alter the
   stored payload by hand, so nothing downstream may trust it without
   re-validation.
3. Two separate mechanisms must both be handled: underscore prefix for
   customer-facing output, and the filter for the admin screen.

This would have shipped unnoticed — the data was correct, the customer-facing
output was correct, and only the merchant's own screen was wrong.

---

# Round 3 — adversarial testing

Seven attacks and edge cases the earlier rounds never attempted. Two produced
findings that change later milestones.

## 🔴 A deleted option still completes checkout

`luxury` was removed from the option config **while it sat in a customer's
cart**. Checkout then succeeded:

```
Order #32    HTTP 200    status: processing
Total:       $100.00
Line meta:   "Finish: Luxury"      ← the option no longer exists
```

Nothing re-validated the selection at checkout. An option the merchant had
discontinued was charged for and sent to fulfilment.

**This is not a probe defect.** The prototype is hardcoded and has no config
system, so it cannot re-validate. What it proves is that
[M12.4](../../developePlan.md#m124--checkout-integrity) is load-bearing rather than precautionary — without checkout
re-validation, this behaviour ships.

**Two policies, deliberately different** (now written into M12.4):

| Situation | Policy |
|---|---|
| Option **price** changed since add-to-cart | Honour the captured `config_version` — the customer was quoted a price |
| Option **deleted** or disabled | **Block checkout** — there is no honest price for something that no longer exists |

Freezing price is customer-fair. Freezing *validity* sells phantom products.

## ⚠️ Base price is live; option price is frozen

Two behaviours that appear contradictory:

```
product base 80.00 -> 200.00   cart follows live      -> 220.00
option delta 20.00 -> 99.00    cart keeps stored      -> 100.00
```

The first was tested with the probe **deactivated**: plain WooCommerce behaves
identically. So the live-base-price behaviour is inherited from the platform, not
introduced by us.

The asymmetry is therefore real but only half ours. The frozen option price is the
deliberate choice, and it matches M12.4's stated policy. Recorded so it is an
explicit decision rather than an accident nobody noticed.

## ✅ Every price-tampering attack repelled

| Attack | Result |
|---|---|
| `price=1` and `delta=99999` injected into the POST body | Ignored — correct $80.00 |
| Selection sent as an array (`probe_finish[]=a&probe_finish[]=b`) | Rejected; cart empty; **no PHP warning emitted** |
| Unknown value (`probe_finish=HACKED`) | Rejected; cart empty |
| Negative quantity (`-5`) | Rejected by WooCommerce |
| Absurd quantity (`999999`) | Capped at 9999 by WooCommerce; total $999,900 correct, no overflow |

AC4 holds under direct attack: when only selection **keys** are trusted and every
price is looked up server-side, the browser cannot influence what is charged.

The array case is worth noting — a naive `(string)` cast would have emitted
`Array to string conversion` into the merchant's error log on every attempt.
Checking `isset()` then whitelisting avoids that.

---

## Final tally

**Phase 4 earned 8 design rules and corrected 3 assumptions:**

1. The session-restore hook is defensive, not load-bearing.
2. A leading underscore does not hide order meta from the admin screen.
3. Checkout does not re-validate selections against config — M12.4 must.

All three were found by testing something that had already been marked complete.

---

# Round 4 — the reorder path

An audit noticed that `add_to_cart_validation`'s **second call site** — the one
passing an array instead of an int — had never actually been triggered, despite
the probe carrying defensive code for it. Triggering it found a real bug.

## 🔴 Reorder is silently blocked

Replaying order #31 through the reorder path:

```
[add_to_cart_validation] #1 arg2=ARRAY resolved=20 qty=2
  item 20 passed=false          ← reorder REJECTED
```

The type-check worked: the array was handled and the product id resolved
correctly. The failure is one level deeper.

**Root cause: the data source differs, not just the argument type.**

```
$_POST['probe_finish'] set?   NO

order item meta holds it instead:
   Finish                 = Luxury
   _optionia_probe_data   = {"delta":2000,…}
```

On a normal add-to-cart the selection arrives in `$_POST`. On a reorder there is
no form submission at all — WooCommerce replays a past order, and the selection
lives in **order item meta**. A validator that only reads `$_POST` finds nothing,
concludes the required option is missing, and rejects the whole reorder.

**The merchant-visible symptom:** "Order again" fails with *"please choose a
finish"* on a product the customer already bought successfully. Nothing in the
error suggests why.

## What Phase 12 must do

The validator needs **two input sources**, chosen by call site:

| Path | Selection comes from | Call site |
|---|---|---|
| Add to cart | `$_POST` | `class-wc-form-handler.php:981` (int) |
| Order again | Order item meta | `class-wc-form-handler.php:1013` (array) |

Type-checking the second argument is necessary but **not sufficient** — the
earlier finding stopped one step short. The array signature is the *signal* that
the data source has changed.

Also worth noting: reorder is precisely where the
[M12.4](../../developePlan.md#m124--checkout-integrity) re-validation policy
matters most. A past order may contain an option that has since been deleted,
renamed or repriced, so replaying it must re-check validity against current
config rather than trusting the stored payload.

**Status:** documented, not fixed. The probe is a throwaway and reorder is
out of its scope; the finding belongs to
[M12.8](../../developePlan.md#m128--refunds-edits-and-edge-cases).
