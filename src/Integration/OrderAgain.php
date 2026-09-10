<?php
/**
 * Rebuilds a cart line when a customer reorders (M12.8).
 *
 * 🔴 **Proven broken in Phase 4.** Replaying a past order was rejected outright,
 * because the add-to-cart validator read `$_POST` while the selection lived in
 * order item meta. Phase 11 Stage 6 fixed the reading half --
 * `Integration\AddToCartRequest` takes selections from `cart_item_data` on the
 * six-argument reorder call site -- but nothing put them there.
 *
 * ## The format gap this class exists to close
 *
 * The two sides were written against different shapes, and neither was wrong:
 *
 * ```text
 * order meta   _optionia_selections = '{"opt-a":"lux"}'    JSON string
 * cart wants   optionia.selections  = ['opt-a' => 'lux']   PHP array
 * ```
 *
 * `M12.5` encodes because order item meta is a flat key/value table and a line
 * with twenty options would otherwise add twenty rows. The cart carries a real
 * array because `WC_Cart::generate_cart_id()` hashes it. So this decodes.
 *
 * ## Selections only, and why that is the whole of "reprice"
 *
 * M12.8 requires a reorder to **reprice from current configuration**: it is a new
 * purchase, so the frozen-price argument that protects a mid-session cart does
 * not apply. The order also carries `config_version` and the frozen deltas, and
 * replaying those would make the reordered line inherit prices from a purchase
 * that may be a year old.
 *
 * That is achieved by *not writing them*, not by stripping them afterwards.
 * `woocommerce_order_again_cart_item_data` starts from `array()` (WC 11.0.1,
 * `includes/class-wc-cart-session.php:587`) -- WooCommerce replays nothing, so
 * this class chooses what the line carries. A payload holding selections and no
 * signature is exactly the shape `Integration\CartTotals` already prices from
 * current configuration, so repricing needs no code of its own.
 *
 * Re-validation is likewise already built: the reorder path runs
 * `woocommerce_add_to_cart_validation` at six arguments, so
 * `Integration\AddToCartValidator` refuses an option since deleted, and
 * `Integration\CheckoutValidator` blocks one that disappears later. A stored
 * payload is a *record*, not an authority.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Carries a past order's selections into a new cart line.
 */
final class OrderAgain {

	/**
	 * The filter WooCommerce applies once per line being replayed.
	 */
	public const HOOK = 'woocommerce_order_again_cart_item_data';

	/**
	 * Register the reorder hook.
	 */
	public function register(): void {
		add_filter( self::HOOK, array( $this, 'rebuild' ), 10, 2 );
	}

	/**
	 * Rebuild one line's Optionia payload from its order item meta.
	 *
	 * @param mixed $cart_item_data What the line will carry; empty from WooCommerce.
	 * @param mixed $item           The order line item being replayed.
	 * @return array<string, mixed>
	 */
	public function rebuild( $cart_item_data, $item = null ): array {
		$data = is_array( $cart_item_data ) ? $cart_item_data : array();

		if ( ! is_object( $item ) || ! method_exists( $item, 'get_meta' ) ) {
			return $data;
		}

		$selections = $this->selections_from( $item );

		if ( array() === $selections ) {
			return $data;
		}

		/*
		 * Sorted, for the same reason `Integration\CartItemData` sorts:
		 * `WC_Cart::generate_cart_id()` hashes this payload textually, so an
		 * order whose meta happens to be in a different key order would produce a
		 * different cart line from an identical fresh selection -- and a customer
		 * would see two lines for one thing.
		 */
		ksort( $selections );

		/*
		 * Selections and nothing else. See the class docblock: the frozen price
		 * and its `config_version` describe the *original* purchase, and a
		 * reorder is a new one.
		 */
		$data[ Keys::CART_ITEM_KEY ] = array(
			Keys::CART_ITEM_SELECTIONS => $selections,
		);

		return $data;
	}

	/**
	 * The selections an order line recorded, decoded.
	 *
	 * Written by `Integration\OrderLineItem` as a JSON object under
	 * `Keys::META_SELECTIONS`. Anything else -- a line from before this plugin,
	 * a value another plugin overwrote, malformed JSON -- yields no selections,
	 * and the line is replayed as a plain product rather than as a guess.
	 *
	 * @param object $item The order line item.
	 * @return array<string, string> Option id to value key.
	 */
	private function selections_from( object $item ): array {
		$raw = $item->get_meta( Keys::META_SELECTIONS );

		if ( ! is_string( $raw ) || '' === $raw ) {
			return array();
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) ) {
			return array();
		}

		$selections = array();

		foreach ( $decoded as $option_id => $value_key ) {
			/*
			 * Both halves must be scalar. A non-scalar reaching the cart would
			 * be refused by `SelectionResolver` anyway, but it would also be
			 * hashed into the cart item key on the way -- so it is dropped here,
			 * where the shape is still ours to control.
			 */
			if ( ! is_scalar( $option_id ) || ! is_scalar( $value_key ) ) {
				continue;
			}

			$selections[ (string) $option_id ] = (string) $value_key;
		}

		return $selections;
	}
}
