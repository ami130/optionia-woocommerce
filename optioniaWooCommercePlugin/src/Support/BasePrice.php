<?php
/**
 * What a product costs before any option is added.
 *
 * ## Why this exists at all
 *
 * `Engine\SelectionResolver::resolve()` takes a `$base_minor`, and until M16.1
 * **nothing read it except the line-total sum**. Three of its five callers
 * passed a literal `0`, which was harmless while `fixed` was the only priced
 * type: a flat amount does not depend on what the product costs.
 *
 * M16.1 made the base load-bearing. A `percentage` is computed *from* it, so a
 * caller passing `0` gets a delta of `0` for an option that should charge — and
 * the two callers doing that were `Integration\CartItemData`, which **freezes**
 * the delta onto the cart line, and `Integration\CartDisplay`, which shows it to
 * the customer.
 *
 * 🔴 **Measured, on the real cart path:** a 50% option on an 80.00 product was
 * frozen at `{"opt-a":0}`, signed, and charged **80.00**. Every unit test
 * passed, because every one of them called `resolve()` directly with a base --
 * matching the one caller that was already correct.
 *
 * ## Why a class rather than a third copy of five lines
 *
 * `Integration\AddToCartValidator` and `Integration\CartTotals` had already
 * written this lookup independently, and they disagreed: the validator resolves
 * a **variation** id before the parent, and the totals class does not need to
 * because WooCommerce hands it the resolved product object. A third copy would
 * have been a third opportunity to get the variation rule wrong, on the path
 * that freezes a price into the order.
 *
 * ## Why it is not in `Engine\`
 *
 * It calls `wc_get_product()`. `Engine/` is a port of TypeScript logic held to
 * shared fixtures and must not touch WordPress -- the architecture gate enforces
 * that. The base is an *input* to the engine, gathered out here.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * The base price of a product, in integer minor units.
 */
final class BasePrice {

	/**
	 * Not instantiable -- this is a namespace for one function.
	 */
	private function __construct() {
	}

	/**
	 * A product's own price in minor units, or 0 when it cannot be determined.
	 *
	 * **A variation's price wins over its parent's.** A parent variable product
	 * commonly has no price of its own, or carries the range's lowest -- so
	 * pricing a percentage off the parent charges the wrong amount for every
	 * variation except the cheapest.
	 *
	 * **0 on failure, not an exception.** Every failure here is a product that
	 * cannot be priced -- WooCommerce absent, an id that resolves to nothing, a
	 * malformed price string -- and in all three the safe answer is that a
	 * percentage contributes nothing. Refusing the line instead would take a
	 * storefront down over a lookup, and guessing at a base would charge a number
	 * nobody configured. The line then prices as the plain product, which is
	 * wrong in the customer's favour and visible.
	 *
	 * @param int $product_id   The product.
	 * @param int $variation_id The chosen variation, or 0 for none.
	 * @return int Base price in minor units; 0 when unavailable.
	 */
	public static function minor( int $product_id, int $variation_id = 0 ): int {
		if ( ! function_exists( 'wc_get_product' ) ) {
			return 0;
		}

		$id = $variation_id > 0 ? $variation_id : $product_id;

		if ( $id <= 0 ) {
			return 0;
		}

		$product = wc_get_product( $id );

		if ( ! is_object( $product ) || ! method_exists( $product, 'get_price' ) ) {
			return 0;
		}

		$money = Money::try_from_decimal( $product->get_price() );

		return null === $money ? 0 : $money->minor();
	}
}
