# Block vs Classic — M2.8

Verified against WooCommerce 11.0.1 on this site, 2026-08-21.

## The headline finding

**This site's cart and checkout are already BLOCK-based**, despite Storefront (a classic
theme) being active:

```
woocommerce_cart_page_id     = 9   → <!-- wp:woocommerce/cart -->
woocommerce_checkout_page_id = 10  → <!-- wp:woocommerce/checkout -->
```

This is the modern WooCommerce default. It means **the block path is not a future edge case
to handle later — it is the primary path on a fresh install.** AC7 is not defensive
future-proofing; it is the baseline requirement.

Theme choice and cart/checkout implementation are **orthogonal**: a classic theme can (and
here does) use block cart/checkout. Testing "on Storefront" therefore proves nothing about
which cart path was exercised.

## What is shared, and what is not

| Surface | Mechanism |
|---|---|
| Product page render | Classic PHP templates + hooks (block product pages are still uncommon) |
| **Cart display** | **`woocommerce_get_item_data` — SHARED by both paths** |
| Checkout display | Store API schema; needs `ExtendSchema` |
| Cart/order storage | Identical — `cart_item_data`, order item meta |

Confirmed shared filter call sites:

```
includes/wc-template-functions.php:4538         → classic cart template
src/StoreApi/Schemas/V1/CartItemSchema.php:170  → block cart (Store API)
```

## Constraint 1 — item data must be SCALAR on the block path

`CartItemSchema.php:172-179`:

```php
foreach ( $data as $data_value ) {
    if ( ! is_scalar( $data_value ) ) {
        continue 2;   // silently DROPS the whole element
    }
}
```

A non-scalar value in any field of an item-data element causes the **entire element to be
silently discarded** in block cart — while still rendering fine in classic cart.

**Consequence:** an array value (e.g. a multi-select's selected values, or an uploaded-file
descriptor) works in classic cart and *vanishes* in block cart, with no error. This is
precisely the kind of bug that ships unnoticed.

**Rule:** every value passed through `woocommerce_get_item_data` must be a pre-formatted
scalar string. Join arrays before returning; never hand the filter a nested structure.

## Constraint 2 — the `hidden` flag uses an experimental key

`CartItemSchema.php:192-196`:

```php
if ( array_key_exists( '__experimental_woocommerce_blocks_hidden', $item_data_element ) ) {
    $item_data_element['hidden'] = $item_data_element['__experimental_woocommerce_blocks_hidden'];
}
```

Hiding an item-data row in block cart requires the key
`__experimental_woocommerce_blocks_hidden`. The `__experimental_` prefix is an explicit
stability warning — it may be renamed. Isolate it behind one helper so a rename is a
one-line change, and cover it with a compatibility test.

## Constraint 3 — `wp_kses_post` is applied to every value

`format_item_data_element()` runs `array_map( 'wp_kses_post', ... )`. Markup in a label or
value is filtered on the block path. Do not rely on raw HTML surviving; plan for plain text.

## Store API extension mechanism

Available and usable:

```
src/StoreApi/Schemas/ExtendSchema.php:20   final class ExtendSchema
                                    :85   register_endpoint_data( $args )
```

Needed for the **checkout** block and for anything beyond simple cart-item display.

## Implications for the plan

1. Block cart/checkout is the **default**, not an edge case — AC7 confirmed as baseline.
2. Cart display may need **no** separate block work (shared filter) — but only if values are
   scalar strings.
3. The scalar constraint is a **correctness requirement in M12.2**, not a nicety.
4. Test matrix must vary cart/checkout implementation *independently* of theme.
5. `__experimental_` key must be wrapped, not used inline.
