# Integration Point Catalogue — M2.5

**Verified against WooCommerce 11.0.1 source**, not documentation. File and line
references are real and checkable.

This is the reference document Phases 10, 11, and 12 are built against.

## The seven core hooks

| # | Hook | Type | Source | Purpose |
|---|---|---|---|---|
| 1 | `woocommerce_before_add_to_cart_button` | action | `templates/single-product/add-to-cart/*.php` | Render options on the product page |
| 2 | `woocommerce_add_to_cart_validation` | filter | `includes/class-wc-form-handler.php:981` | Reject an invalid selection before it enters the cart |
| 3 | `woocommerce_add_cart_item_data` | filter | `includes/class-wc-cart.php:1294` | Attach selection data to the cart item |
| 4 | `woocommerce_before_calculate_totals` | action | `includes/class-wc-cart.php` | Apply the trusted price |
| 5 | `woocommerce_get_item_data` | filter | `includes/wc-template-functions.php:4538` | Display selections in the cart |
| 6 | `woocommerce_checkout_create_order_line_item` | action | `includes/class-wc-checkout.php` | Persist selections to order line meta |
| 7 | `woocommerce_after_order_itemmeta` | action | `includes/admin/meta-boxes/views/html-order-item.php` | Admin order display |

## Verified signatures

```php
// 2 — note: TWO call sites with DIFFERENT signatures
apply_filters( 'woocommerce_add_to_cart_validation', true, $product_id, $quantity );  // :981
apply_filters( 'woocommerce_add_to_cart_validation', true, $item, $quantity );        // :1013

// 3
apply_filters( 'woocommerce_add_cart_item_data',
               $cart_item_data, $product_id, $variation_id, $quantity );

// 5
apply_filters( 'woocommerce_get_item_data', $item_data, $cart_item );
```

### Finding 1 — `add_to_cart_validation` has two call sites

Line 981 passes `$product_id`; line 1013 passes `$item` (an array). A callback assuming an
integer will misbehave on the second path. **Type-check the second argument rather than
assuming.**

### Finding 2 — `woocommerce_get_item_data` is ALSO used by the Store API

```
includes/wc-template-functions.php:4538      → classic cart template
src/StoreApi/Schemas/V1/CartItemSchema.php:170 → BLOCK cart
```

This is a significant and welcome discovery for AC7. The same filter feeds both the classic
cart and the block cart, so **cart display may work in block themes without a separate
Store API integration.**

Caveat: the block path starts from `array()` while the template path receives existing
`$item_data`. Behaviour must be verified in both, not assumed identical — but the surface
is shared, which is better than the plan assumed.

## Finding 3 — cart item key generation (critical for M12.1)

`WC_Cart::generate_cart_id( $product_id, $variation_id, $variation, $cart_item_data )`

```php
$id_parts = array( $product_id );
// + variation_id if set
// + concatenated variation key/values
// + concatenated cart_item_data key/values:
foreach ( $cart_item_data as $key => $value ) {
    if ( is_array( $value ) || is_object( $value ) ) {
        $value = http_build_query( $value );
    }
    $cart_item_data_key .= trim( $key ) . trim( $value );
}
```

**Implications for the design:**

1. **Cart item keys already incorporate `cart_item_data`.** Two different option selections
   naturally produce different cart lines, and identical selections merge — the behaviour
   M12.1 requires, provided by WooCommerce itself.
2. **Arrays are serialized via `http_build_query`, which is order-sensitive.** The same
   selections in a different key order produce a *different* hash and therefore a spurious
   second cart line. **Selection data must be canonically sorted before being attached.**
   This is a real bug waiting to happen.
3. Any transient/volatile value in `cart_item_data` (a timestamp, a nonce, a random id)
   would break merging entirely. Keep the payload deterministic.

## Baseline observation

Order #22's line item has **0 meta entries** on a clean install. Anything appearing there
later is unambiguously ours — a useful assertion for tests.

## Still to verify

- `woocommerce_before_calculate_totals` exact firing count per request
- Store API `ExtendSchema` for the *checkout* block (cart display looks covered by Finding 2)
- Whether `woocommerce_before_add_to_cart_button` fires for all four product types

---

## Finding 4 — the render hook fires in DIFFERENT PLACES per product type

Verified by grepping `templates/single-product/add-to-cart/` in WC 11.0.1:

| Template | fires `woocommerce_before_add_to_cart_button`? |
|---|---|
| `simple.php` | ✅ directly |
| `grouped.php` | ✅ directly |
| `external.php` | ✅ directly |
| **`variable.php`** | ❌ **NOT directly** |

`variable.php` instead exposes:

```
woocommerce_before_add_to_cart_form
woocommerce_before_variations_form
woocommerce_after_variations_table
woocommerce_before_single_variation
woocommerce_single_variation
woocommerce_after_single_variation
woocommerce_after_variations_form
woocommerce_after_add_to_cart_form
```

`woocommerce_before_add_to_cart_button` **does** fire for variable products — but from
`variation-add-to-cart-button.php:15`, which renders **inside the variation form and only
once a variation is selected.**

### Why this matters (changes M10.5)

Hooking only `woocommerce_before_add_to_cart_button` produces this behaviour on a variable
product:

- Page loads with no variation chosen → **options do not render at all**
- Customer picks a variation → options appear
- Customer changes variation → the variation form re-renders, and options are **wiped or
  duplicated** depending on implementation

That is broken UX for exactly the merchants this product targets (apparel with
size/colour variants *plus* customization).

### The correct approach

- **Simple / grouped / external:** `woocommerce_before_add_to_cart_button` is correct.
- **Variable:** render at `woocommerce_after_variations_table` (or
  `woocommerce_before_add_to_cart_form`) so options exist independently of variation
  selection, and use the `found_variation` / `reset_data` JS events to re-evaluate rules and
  recompute the price when the variation changes.

The two paths must be deliberately chosen per product type, not assumed uniform.

### External products

`external.php` fires the hook, but an external product has **no cart** — it links offsite.
Optionia must render nothing for `external`. Confirmed as "not applicable" in M10.5, and now
verified as a real code path that would otherwise render dead options.
