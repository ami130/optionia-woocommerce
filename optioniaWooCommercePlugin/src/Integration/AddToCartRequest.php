<?php
/**
 * One shape for five call sites (M11.5).
 *
 * `woocommerce_add_to_cart_validation` is applied from five places in
 * WooCommerce 11.0.1, and no two of them agree on what they pass:
 *
 * ```text
 * class-wc-form-handler.php:981    3 args   (true, $product_id, $quantity)
 * class-wc-form-handler.php:1013   3 args   (true, $item, $quantity)          <- $item is an ARRAY
 * class-wc-form-handler.php:1063   5 args   (..., $variation_id, $variations)
 * class-wc-cart-session.php:615    6 args   (..., $variations, $cart_item_data) <- REORDER
 * class-wc-ajax.php:520            3 args   (true, $product_id, $quantity)
 * ```
 *
 * Every difference between them is absorbed here, so the validator itself sees
 * one shape and can be reasoned about once. The alternative -- five callbacks,
 * or one callback full of `is_array()` branches -- is where a security boundary
 * grows a hole nobody notices, because only one of the five paths gets read
 * carefully.
 *
 * ## Why the selection is not read from `$_POST` here
 *
 * The reorder site has no `$_POST`. `WC_Cart_Session::populate_cart_from_order()`
 * rebuilds each line from **order item meta** via the
 * `woocommerce_order_again_cart_item_data` filter and passes the result as the
 * sixth argument. A validator that reads `$_POST` and nothing else does not
 * merely skip validation there -- it rejects every reordered line, because the
 * selection it demands is absent by construction. That is the Phase 4 finding
 * recorded against M12.1, and it lands on this class first.
 *
 * So the selection has two sources, in priority order: `$cart_item_data` when
 * the caller supplied it, `$_POST` otherwise.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * A normalised add-to-cart attempt, whatever call site produced it.
 */
final class AddToCartRequest {

	/**
	 * Product id, always an int, never a variation id.
	 *
	 * @var int
	 */
	private int $product_id;

	/**
	 * Variation id, or 0 for a non-variable product.
	 *
	 * @var int
	 */
	private int $variation_id;

	/**
	 * Raw selections, keyed by option id. Values are unvalidated.
	 *
	 * @var array<string, mixed>
	 */
	private array $selections;

	/**
	 * Which of the five call sites produced this.
	 *
	 * @var string
	 */
	private string $source;

	/**
	 * Build a normalised request.
	 *
	 * @param int                  $product_id   Product id.
	 * @param int                  $variation_id Variation id, or 0.
	 * @param array<string, mixed> $selections   Raw selections keyed by option id.
	 * @param string               $source       Originating call site.
	 */
	private function __construct( int $product_id, int $variation_id, array $selections, string $source ) {
		$this->product_id   = $product_id;
		$this->variation_id = $variation_id;
		$this->selections   = $selections;
		$this->source       = $source;
	}

	/**
	 * Build from whatever the filter handed over.
	 *
	 * @param mixed                     $product_or_item Product id, or the order-again `$item` array.
	 * @param int|null                  $variation_id    Variation id when the site supplies one.
	 * @param array<string, mixed>|null $cart_item_data  Reorder payload when the site supplies one.
	 * @param string                    $source          Originating call site.
	 */
	public static function from_filter( $product_or_item, ?int $variation_id, ?array $cart_item_data, string $source ): self {
		return new self(
			self::product_id_from( $product_or_item ),
			null === $variation_id ? 0 : $variation_id,
			self::selections_from( $cart_item_data ),
			$source
		);
	}

	/**
	 * The product id, whichever shape the call site used.
	 *
	 * **`class-wc-form-handler.php:1013` passes an array, not an id.** It is the
	 * order-again path, and `$item` is a `WC_Order_Item_Product`-shaped value.
	 * `absint()` on it raises a notice and yields a meaningless number, so the
	 * type is checked rather than assumed -- exactly what M11.5 warns about.
	 *
	 * @param mixed $product_or_item Product id, or an order item.
	 * @return int Product id, or 0 when none can be determined.
	 */
	private static function product_id_from( $product_or_item ): int {
		if ( is_int( $product_or_item ) ) {
			return $product_or_item;
		}

		if ( is_object( $product_or_item ) && method_exists( $product_or_item, 'get_product_id' ) ) {
			return (int) $product_or_item->get_product_id();
		}

		if ( is_array( $product_or_item ) ) {
			$id = $product_or_item['product_id'] ?? $product_or_item['id'] ?? 0;

			return is_scalar( $id ) ? (int) $id : 0;
		}

		/*
		 * A numeric string is accepted because WooCommerce is not `strict_types`
		 * and `$_POST['add-to-cart']` reaches some paths unconverted. Anything
		 * else -- null, bool, object without the method -- becomes 0, which the
		 * validator treats as "no product", not as product zero.
		 */
		return is_numeric( $product_or_item ) ? (int) $product_or_item : 0;
	}

	/**
	 * The raw selections, from the reorder payload or from `$_POST`.
	 *
	 * Nothing here is trusted or validated; that is the validator's job. This
	 * only settles *where* to look, which differs by call site.
	 *
	 * @param array<string, mixed>|null $cart_item_data Reorder payload, when present.
	 * @return array<string, mixed>
	 */
	private static function selections_from( ?array $cart_item_data ): array {
		if ( null !== $cart_item_data && isset( $cart_item_data[ Keys::CART_ITEM_KEY ] ) ) {
			$stored = $cart_item_data[ Keys::CART_ITEM_KEY ];

			if ( is_array( $stored ) && isset( $stored[ Keys::CART_ITEM_SELECTIONS ] ) && is_array( $stored[ Keys::CART_ITEM_SELECTIONS ] ) ) {
				return $stored[ Keys::CART_ITEM_SELECTIONS ];
			}

			return is_array( $stored ) ? $stored : array();
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- Read-only; WooCommerce verifies the add-to-cart nonce, and nothing here is trusted.
		$posted = $_POST[ Keys::FIELD_PREFIX ] ?? null;

		return is_array( $posted ) ? wp_unslash( $posted ) : array();
	}

	/**
	 * Product id, or 0 when the call site gave nothing usable.
	 */
	public function product_id(): int {
		return $this->product_id;
	}

	/**
	 * Variation id, or 0.
	 */
	public function variation_id(): int {
		return $this->variation_id;
	}

	/**
	 * Raw, unvalidated selections keyed by option id.
	 *
	 * @return array<string, mixed>
	 */
	public function selections(): array {
		return $this->selections;
	}

	/**
	 * Which call site produced this, for logging.
	 */
	public function source(): string {
		return $this->source;
	}
}
