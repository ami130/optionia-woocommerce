# Pricing specification

**Normative for both implementations.** `Optionia\Engine` in the WordPress plugin
computes what a customer is charged; the cloud's `common/` computes what a
merchant is shown while authoring. Where they disagree, a customer sees one price
and is charged another, so this document is the thing they agree *with* rather
than with each other.

> **This file is shared across two git repositories.** Byte-identical copies live
> in `optioniaWooCommercePlugin/tests/fixtures/shared/` and
> `optioniaWooCommerceBackend/test/fixtures/shared/`, both under the hash gate in
> `bin/check-shared-fixtures.sh`. Editing one copy fails that repository's build
> until the other matches. The reasoning is in M11.0c: CI checks out one
> repository at a time, so a document only one side can see is a document one
> side will diverge from.

## 1. Money is integer minor units

Every amount in this document, in the config document, and inside both
evaluators is an **integer count of the currency's smallest unit**. `1000` is
£10.00 in a 2-decimal currency, ¥1000 in a 0-decimal one, and 1.000 KWD in a
3-decimal one. The number of decimals is a property of the *currency*, never of
the amount.

Floats are never used for money at any point, including intermediates.
`0.1 + 0.2 !== 0.3` in binary floating point, and a total that drifts is a total
that differs between two machines computing the same order.

## 2. What is computed today

**`fixed` and `percentage`.**

A `fixed` price contributes its `amount_minor` to the line, once, whenever its
value is selected.

A `percentage` price contributes `basis_points` of the **product's own base
price**, rounded by §4. Basis points because a percentage is not expressible in
integers: 12.5% has no integer form, and storing `12.5` as a float reintroduces
exactly the imprecision minor units exist to avoid. 12.5% is `1250`.

### A percentage is of the base, never of a running total

Two 50% options on an 80.00 product add 40.00 **each**:

```text
base 8000, two options at basis_points 5000
  of the base           : 4000 + 4000 → 16000   <- normative
  of the running total  : 4000 + 6000 → 18000
```

Compounding would make the line total depend on the **order** options are
summed in. That order is not defined by the published schema, is not visible to
the customer, and would differ between an evaluator that iterates the document
and one that iterates the submitted selection. Taking every percentage of the
base makes the sum commutative, which is the same property §3 relies on.

### A percentage with no rate is not 100%

`{type: percentage}` with `basis_points` missing or non-integer contributes
**nothing and is reported**, exactly as an unimplemented type is. It is a broken
publish, and the alternatives are worse: defaulting to `0` makes it
indistinguishable from a merchant who meant free, and coercing a non-integer
turns `"500"` into a charge nobody configured.

A `per_char` price contributes `amount_minor` for each character the customer
typed beyond `free_characters`, counted by `measure()` (§5):

```text
delta = max(0, measure(text) - free_characters) * amount_minor
```

### Where each type may appear

**`price_config` prices a chosen value. `pricing` prices an option.** These are
different fields carrying different types, and a reader must not accept one
where the other belongs:

| Field | Lives on | Types | Why |
|---|---|---|---|
| `price_config` | a **value** | `fixed`, `percentage` | A choice is priced by which value was chosen |
| `pricing` | an **option** | `per_char`, `per_unit`, `tiered` | The field has no values; the price hangs on the field |

An option with no values — text, date, number, file — cannot carry
`price_config`, because there is no value row to put it on. `per_char`,
`per_unit` and `tiered` are the three types this specification defines at the
option level, and they are the three whose amount depends on **what the customer
supplied** rather than on which value they picked.

⚠️ **`per_unit` was listed under `price_config` until M16.2, and `tiered` until
M16.3. Both were wrong, in the same way.** Each prices a quantity, and the only
options producing a quantity are the number types — which have no values. On a
chosen value they would have had nothing to bracket or multiply.

**And `per_char` applies only to an option the customer types into.** The
evaluator dispatches on `type` and has no view of what kind of answer an option
produces, so without this rule it charges for the length of whatever string
arrives:

```text
per_char on a FILE option   ->  a 64-character upload token  ->  32.00
per_char on a DATE option   ->  "2026-10-01"                 ->   5.00
per_char on a NUMBER option ->  "12345"                      ->   2.50
```

A customer paying 32.00 for the length of a hash they never typed is not a
configuration a merchant could have meant. A `hidden` option is excluded for a
subtler reason: its value kind *is* text, but its value is the merchant's own
`default_value` and never customer input.

An implementation refuses this combination where the option's type is known and
reports it as unpriced — it does not charge, and it does not stay silent.

An evaluator meeting a type in the wrong place **contributes nothing**, and
reports it exactly as it reports an unimplemented type. Deciding independently
what an option-level `fixed` means is how two implementations begin to disagree.

### `free_characters`

Subtracted from the count, never from the charge, and the result **floors at
zero**:

```text
measure "HELLO" = 5, free 3, amount 50  ->  (5 - 3) * 50 = 100
measure "HI"    = 2, free 3, amount 50  ->  max(0, -1) * 50 = 0   <- normative
```

Without the floor a short answer would produce a **negative** delta — a discount
for typing less, which no merchant configured and which a customer could farm by
leaving the field nearly empty. A discount is expressed by a negative
`amount_minor`, deliberately, so `free_characters` never needs to produce one.

`amount_minor` may still be negative, and then the arithmetic is unchanged: the
floor applies to the **character count**, not to the delta. §3's line-total clamp
is what stops a negative delta paying out.

Absent `free_characters` means `0` — charge from the first character. The cloud
defaults it rather than requiring it, so a merchant who never thought about it
gets the simple behaviour.

### `per_unit`

A `per_unit` price contributes `amount_minor` for each unit the customer asked
for, on an option that produces a number:

```text
delta = round(max(0, quantity) * amount_minor)
```

**`per_unit` applies only to an option that produces a number** — the same rule
`per_char` has for typed text, and for the same reason: the evaluator dispatches
on `type` and would otherwise multiply by whatever the answer happens to be. A
date answer of `"2026-10-01"` is not a quantity, and a text answer is not one
either.

**The quantity is the OPTION's own number, never the cart quantity.**
`WC_Cart_Totals` computes a line as `price × cart_quantity`, so a total handed
back with the cart quantity already folded in is multiplied twice — the silent
overcharge this specification's §3 exists to prevent. "£2 per centimetre" prices
one item of 30cm at £60 whether the customer buys one or ten; WooCommerce
multiplies afterwards.

#### The quantity floors at zero, and the amount carries the sign

Exactly as `per_char` floors the character count. A customer submitting `-5`
would otherwise produce a **negative delta** — a discount for asking for less
than nothing. A discount is expressed by a negative `amount_minor`, so the
quantity never needs to be negative for one to exist.

#### Fractional quantities are allowed, and rounded by §4

"£2.50 per metre × 1.5m" is a real measurement, and refusing it would make the
number types unpriceable for anything measured. So the product may be fractional
and is rounded **half up away from zero** — the same rule §4 states for
percentages, for the same reason: two implementations rounding differently
disagree by a minor unit on real orders.

```text
amount 250, quantity 1.5   ->  round(375)    = 375
amount 250, quantity 0.005 ->  round(1.25)   = 1
amount -250, quantity 1.5  ->  round(-375)   = -375
```

A merchant who wants whole units sets `integer_only`, which the validation rules
already enforce. The pricing rule does not second-guess that choice.

#### The quantity is bounded

A number option's answer is customer-supplied and, unlike text, has **no length
ceiling** — a customer can submit `1e20` where the merchant set no `max`. At the
maximum configurable amount, a quantity of about nine million leaves the safe
range in §3.

So an implementation checks the product **before** it commits, and reports a
quantity it cannot price rather than raising: a storefront must not go down
because a customer typed a long number.

**And a quantity is capped at 1,000,000 whatever the merchant configured.** Text
has had an absolute ceiling since M11 — 5,000 graphemes, which a merchant cannot
raise — and a quantity had none. Measured at 2.00 per unit with no `max`
configured: `9999999999999` produced a line worth 20,000,000,000,078.00,
arithmetically correct and not a total any merchant meant to be reachable.

A backstop for the **absence** of configuration, not a second limit competing
with the merchant's: a configured `max` is checked first and believed. Over the
ceiling the option is **reported as unpriced** — not clamped, which would invent
a number nobody chose, and not zeroed silently, which would make the option free
at a boundary. *"Contributes nothing and says so"* applies here exactly as it
does to a type this build cannot price.

#### No free allowance, deliberately

`per_char` has `free_characters`; `per_unit` has no `free_units`, and that
asymmetry is intended. Free characters model a merchant absorbing a short
engraving; a free-unit allowance is a **volume discount**, which is what `tiered`
expresses — with brackets a merchant can see. Two mechanisms for one intent is
two places for them to disagree.

### `tiered`

A `tiered` price picks the bracket the customer's quantity falls in, then prices
every unit at that bracket's amount:

```text
delta = round(max(0, quantity) * amount_minor(of the matching tier))
```

**It brackets the OPTION's own number, not the cart quantity** — the rule
`per_unit` already states, for the same reasons. So `tiered` is `per_unit` with
the amount chosen by a lookup rather than fixed:

```text
rope: 1-9m @ 1.00/m, 10m+ @ 0.80/m
  customer asks for  9m  ->  9 x 1.00 = 9.00
  customer asks for 10m  -> 10 x 0.80 = 8.00
```

⚠️ **"Buy ten of this product, get a discount" is not what this expresses**, and
this plugin does not express it. That is cart-level pricing — WooCommerce's own
domain and its coupon extensions' — and reaching it would mean folding the cart
quantity into a per-unit price WooCommerce multiplies again. It is also why
`per_unit` has no `free_units`: a volume discount is a `tiered` price with
brackets a merchant can see, rather than a second mechanism.

#### Both bounds are inclusive, and the brackets are contiguous

`min_quantity` and `max_quantity` are both **inclusive**, so a tier ending at 9
and the next starting at 10 covers 9, 10 and everything between with no
ambiguity. That is not a new decision: the authoring schema has refused overlaps
and gaps since Phase 7, and `next.min > previous.max + 1` is an error naming the
quantities that would fall between.

`max_quantity: null` means open-ended and is stated explicitly, never omitted — a
reader must tell "no upper bound" from "not specified".

**The bracket is chosen by `min_quantity` alone: the last tier whose
`min_quantity` does not exceed the quantity.** Because the set is contiguous from
1 and ends open-ended, that is the same tier `max_quantity` would select for
every whole number — `max_quantity` is a cross-check the authoring schema
enforces, not a second rule the evaluator applies.

⚠️ **It differs for a FRACTIONAL quantity, which is why the rule is stated this
way.** Tiers are whole numbers; a quantity need not be. With tiers `1-9` and
`10+`, a quantity of `9.5` satisfies neither `<= 9` nor `>= 10`, so a
both-bounds match would leave it unpriced — a customer paying nothing for 9.5
metres of rope. Selecting by `min_quantity` puts it in `1-9`, which is what a
merchant reading *"under 10 metres"* means.

#### Every quantity from 1 upward must be covered

The schema refused gaps *between* tiers and permitted them at both ends: a set
starting at 5 left 1–4 unpriced, and a set ending at 20 left 21 upward unpriced.
Both are now refused at authoring, because a bracket set that does not cover a
quantity the customer can enter is a configuration whose behaviour nobody
decided.

So the **first tier starts at 1** and the **last tier is open-ended**. A merchant
who wants a minimum order sets `min` on the option, which is a validation rule
and produces a message a customer can act on — not a price that silently
disappears.

An evaluator meeting a quantity no tier covers still **contributes nothing and
reports it**, because a published document is input rather than authority and can
predate the rule.

### Still unimplemented

Nothing. All five published price types are implemented.

An evaluator meeting a type it does not implement **contributes nothing and says
so** — it does not guess, and it does not fail the line. A storefront that cannot
price something must not show a total that excludes it silently; Phase 10's
estimate hides itself instead, which is the same rule one layer up.

## 3. Order of operations, and the floor

```text
line_total = max(0, base_price_minor + sum(deltas))     // per single unit
```

Deltas are summed first, and the result is clamped **once, at the end**.

### Per unit, not per line

**Everything in this section is per single unit.** Quantity never enters the
formula, and the plugin must never multiply by it.

WooCommerce does that itself. `WC_Cart_Totals` reads the per-unit price off the
product and multiplies (WC 11.0.1, `includes/class-wc-cart-totals.php:233`):

```php
$item->price = wc_add_number_precision_deep( (float) $cart_item['data']->get_price() * (float) $cart_item['quantity'] );
```

So a plugin that hands WooCommerce a *line* total has its option deltas
multiplied by quantity **twice** — a quantity-3 line charging three times the
option price on top of an already-multiplied base. That is the silent-overcharge
failure of this formula, and it is silent precisely because quantity 1 looks
correct.

The floor is unaffected by which one you pick, which is why the distinction is
easy to miss: quantity is a positive multiplier, so
`clamp(x) × qty == clamp(x × qty)`. The formula is the same either way; only the
number you hand to WooCommerce differs.

Tax is likewise WooCommerce's job. `price_includes_tax` comes from the store
setting, so the figure above is given in the store's own convention and
inclusive/exclusive correctness follows. A plugin that adjusts for tax here taxes
twice.

Order within the sum is unobservable for `fixed`, because integer addition
commutes. The **clamp is not commutative**, and the difference is a real one:

```text
base 3000, deltas [-5000, +400]
  clamped at each step : 400
  clamped at the end   :   0     ← normative
```

Clamping per step would let a merchant configure a large discount followed by a
small addition and have the line *rise* from zero — a discount that pays out.
Clamping once at the end means a line that has gone negative stays at zero
whatever follows it.

**The floor is on the line, not on the delta.** A single option may be negative;
that is what a discount option *is*. Clamping each delta at zero would silently
turn a −£50 discount into £0 and charge full price, which is a different wrong
answer rather than a safe one.

### The safe range is JavaScript's, in both languages

Every amount, and every intermediate sum, must satisfy:

```text
|value| ≤ 9007199254740991        (2^53 − 1)
```

Both implementations refuse anything larger, and refuse it **at the same
point** — which takes deliberate effort, because the two languages do not
naturally agree:

| | refuses above | at 1e9 per delta |
|---|---|---|
| TypeScript | `Number.MAX_SAFE_INTEGER` ≈ 9.0e15 | 9,007,199 deltas |
| PHP integers | `PHP_INT_MAX` ≈ 9.2e18 | 9,223,372,036 deltas |

A thousand-fold gap. Left alone, the storefront would compute totals the cloud
declines to compute: the two sides would disagree about whether a cart is even
*representable*, which is worse than either answer on its own. A cross-language
contract can only promise what both sides can keep, so the stricter floor is the
shared one and PHP refuses values it could carry perfectly well.

The failure modes differ too, which is why neither side may skip the check. Past
`PHP_INT_MAX` a PHP integer silently becomes a float and `is_int()` turns false
on something that still prints like a number; past 2^53 JavaScript stays a
number and quietly loses units.

The bound is checked **at every step**, not once on the result: a sum can leave
the range and come back — `2^53 + 1 − 1` is `2^53`, which passes a final check
having already lost a unit.

Nothing legitimate approaches this. The schema caps one amount at 1e9 and
`AUTHORING_LIMITS` caps a set at 20,000 options, so the largest reachable total
is 2.0e13 — about 450× under the bound. The rule exists for the case where those
caps are bypassed.

## 4. Rounding: half up, **away from zero**

Rounding applies wherever a computation is not exact — today only `percentage`,
which is Phase 16's, but the rule is stated here because it is normative for both
languages and both must implement it the same way.

```text
round(+2.5) → +3
round(-2.5) → -3      ← away from zero, not toward positive infinity
```

**The qualifier is the whole point.** PHP's `round()` and
`Support\Money::percentage()` round away from zero. JavaScript's `Math.round`
rounds toward positive infinity, so it agrees on positives and disagrees on every
negative half:

| Discount | Exact | PHP | `Math.round` |
|---|---|---|---|
| 5% of 10 minor | −0.5 | **−1** | 0 |
| 5% of 30 minor | −1.5 | **−2** | −1 |
| 25% of 10 minor | −2.5 | **−3** | −2 |

A specification saying only "half up" is satisfied by `Math.round` and wrong on
every discount landing on a half. **A TypeScript implementation must not use
`Math.round`** — it computes the quotient and remainder in integer space, as
`Money::percentage()` does, and rounds on the absolute value before reapplying
the sign.

Half-up was chosen because it matches WooCommerce's own rounding, so an Optionia
total agrees with a WooCommerce total computed the same way.

### Precision

Intermediates stay in integer space: `minor × basis_points / 10000`, with the
division performed as integer division plus an explicit remainder test. There is
no floating-point intermediate to round, which is why the rule above is about
*ties* rather than about accumulated error.

## 5. Measuring text

One function, `measure(text)`, backs **`per_char` pricing, the character counter,
and `min_length` / `max_length` validation**, in both languages. Not "the same
rule implemented three times" — the same function.

In `optionia-app` the price and the counter were written separately: `"AB CD"` is
charged as five characters while the counter shows four. Display and server agree
with each other, which is why it survived — it is not a pricing bug but a
**credibility** one, on engraving.

### Normalise, then measure

```text
measure(text) = grapheme_count(trim_outer_whitespace(text))
```

**Normalisation runs first, always.** Phase 14 gives text options a
merchant-configurable `trim_whitespace`, and a setting that changed the count
*after* measuring would make the pipeline non-deterministic even though the
function is not.

### Graphemes, not bytes or code points

A grapheme cluster is what a customer sees and what an engraving machine cuts.
One flag is one character because one flag is one mark in the material.

| Input | bytes | code points | **graphemes** |
|---|---|---|---|
| `café` (combining accent) | 6 | 5 | **4** |
| `👨‍👩‍👧` | 18 | 5 | **1** |
| `🇬🇧` | 8 | 2 | **1** |

PHP uses `grapheme_strlen()` (ext-intl); TypeScript uses `Intl.Segmenter` with
`granularity: 'grapheme'`. Verified equal on twenty-six cases including combining
marks, ZWJ sequences, regional-indicator flags and skin-tone modifiers.

### Whitespace: trim the ends, keep the middle

`"AB CD"` measures **5**. `"John Smith"` measures **10**.

The space between two words **is engraved**. Charging nine for a name that cuts
ten characters charges for less than the machine produces, and every complaint
becomes a merchant explaining why a space was free.

Leading and trailing whitespace is different: a typing artefact that engraves
nothing and nobody intends to buy. Stripped — including the non-breaking space
and byte-order mark that a bare `trim()` leaves in place, which arrive by paste
from a word processor and render as nothing.

### Why the cloud has functions and the plugin has a class

`Support\Money` in the plugin is a value type with a `decimals` field. The cloud
has plain functions over integer minor units instead, and the asymmetry is
deliberate.

`Money` reads its decimals from **WooCommerce**. The cloud has no WooCommerce:
every field the plugin sends over connect and heartbeat was checked — nineteen of
them, including `wc_version` — and none carries a currency or a decimal count. A
cloud-side `Money` would have to hardcode 2, which is wrong for JPY and KWD, or
carry a field nothing can fill.

Minor units need no scale to add. Scale decides only how an amount is *shown*,
and that is the storefront's job. Option prices carry no currency anywhere in the
schema either — `option_value` has `priceType` and `priceAmountMinor` and nothing
else — so the multi-currency mixing a scale check guards against cannot arise in
this path.

The two sides therefore agree on **values**, not on types, and the shared fixture
is what holds them to it.

## 6. Currencies

Nothing in this document is currency-specific, because every amount is already
minor units. A 0-decimal currency (JPY) and a 3-decimal one (KWD) differ only in
how a minor amount is *displayed*, which is the storefront's concern and not the
evaluator's.

The one consequence worth stating: a "round to the nearest penny" rule would be
wrong for both. §4 rounds to the nearest **minor unit**, whatever that unit is.

### One store, one currency — and what that costs

**A published amount is in the currency the store used when it was published,
and it is never converted.** The document carries no currency field, by design:
a number that means different things in two places is a rounding error waiting
to reach a merchant's revenue.

That is a complete answer for a single-currency store. Under a **currency
switcher** — WOOCS, Aelia, WPML Multicurrency — it is a limitation, and the
types split two ways:

| Type | Under a switcher | Why |
|---|---|---|
| `percentage` | **converts** | Relative to the product's base, which the switcher already converted |
| `fixed` | does **not** convert | An absolute amount with no rate to apply |
| `per_unit` | does **not** convert | Absolute, per unit |
| `per_char` | does **not** convert | Absolute, per character |
| `tiered` | does **not** convert | Absolute, per bracket |

So "gift wrap +500" published as £5.00 charges **$5.00** when a customer
switches to USD — arithmetically correct and materially different.

**This is stated rather than fixed, deliberately.** The exchange rate lives in
the switcher plugin, each with its own API; reading one means depending on
software this project does not control, and guessing one means charging a number
nobody configured. Per-currency amounts would be a schema change, a dashboard
change and a publishing change together.

**A merchant who needs currency-relative option pricing has `percentage`**,
which converts correctly *because* it is relative. That is the honest
workaround, and it is why this limitation is worth naming rather than hiding.

### What the storefront previews, and what it does not

**The browser totals `fixed` prices and nothing else.** Four of the five types
show no live estimate, and that is a decision rather than an omission:

| Type | Previewed? | Why |
|---|---|---|
| `fixed` | **yes** | The amount is on the value the customer clicks |
| `percentage` | no | Needs the product's base price, which the browser is not sent |
| `per_char`, `per_unit`, `tiered` | no | Priced on the **option**, and the markup carries prices on **values** |

An option the browser cannot total makes the estimate **hide itself** rather than
show a partial number — a total that silently omits a 50% surcharge is worse than
no total, because it looks complete.

⚠️ **This is the same rule one layer up.** An evaluator meeting a type it cannot
price contributes nothing *and says so* (§2); a storefront that cannot total a
line shows nothing *and hides the field*. Neither guesses.

The price a customer is charged is always the server's. `AC3` — the storefront
never blocks on the API — and `AC4` — the browser sends identifiers, never
amounts — both point the same way: a preview is a courtesy, and a wrong one is
worse than none.

### Decimal count is read live, and that is correct

`wc_get_price_decimals()` is read at the moment an amount is rendered, never
cached, so a switcher's change is picked up. The consequence is that the **same
stored integer means different amounts in different currencies**: `500` renders
as `5.00`, `500` and `0.500` at 2, 0 and 3 decimals.

An order's own record is safe from this: the amount is written as a **string**
when the order is placed, so a later currency change cannot reinterpret it. Only
live pricing re-derives from minor units, and a cart is priced now by
definition.

⚠️ **A cart outlives a currency change, and its frozen deltas do not move.**
That is the sharpest edge of this limitation and the one a merchant meets first.
Measured on the real cart path, with the store's base currency switched from a
2-decimal to a 0-decimal one between add-to-cart and checkout:

```text
2 decimals   base 80.00   frozen {"w":500}   ->  charged  85.00
0 decimals   base 80      frozen {"w":500}   ->  charged 580
```

The delta was frozen as a count of minor units, which is correct — but 500 minor
units meant £5.00 when it was quoted and ¥500 after the switch. Nothing is
recomputed, because recomputing is exactly what the price freeze exists to
prevent: the customer was quoted a number and a publish must not change it under
them.

**So a currency change is not a safe operation while carts are live**, and this
specification does not make it one. Its scope is what an evaluator computes; the
lifecycle question belongs to whoever changes the currency.

## 7. What enforces this

A specification nobody checks is a convention. These are the mechanisms:

| Rule | Enforced by |
|---|---|
| Integer minor units | `Support\Money` refuses floats; the schema requires integers |
| The line-total floor | `pricing-fixtures.json`, including a case where a later addition cannot revive a clamped line |
| Rounding away from zero | Negative boundary cases in the same fixture — positives agree in both languages and prove nothing |
| One `measure()` | Ten measure cases in the same fixture, read by both suites, each asserting it ran as many as the file declares |
| This file not drifting | `bin/check-shared-fixtures.sh` in both repositories, plus `bin/check-fixture-parity.sh` in the working tree that holds both |
