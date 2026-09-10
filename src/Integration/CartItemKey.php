<?php
/**
 * Keeps identical selections on one cart line across a configuration publish.
 *
 * `WC_Cart::generate_cart_id()` derives a cart line's key by hashing the whole
 * `cart_item_data` payload (WC 11.0.1, `includes/class-wc-cart.php:1123`):
 *
 * ```php
 * foreach ( $cart_item_data as $key => $value ) {
 *     if ( is_array( $value ) || is_object( $value ) ) {
 *         $value = http_build_query( $value );
 *     }
 *     $cart_item_data_key .= trim( $key ) . trim( $value );
 * }
 * ```
 *
 * That is exactly what makes different selections become different lines, and it
 * is also why [M12.1](#m121--cart-item-data-model)'s audit fields cannot simply
 * be added to the payload: `config_version` changes on **every** publish, so the
 * same selection added on either side of one produces two keys. Measured before
 * this class existed:
 *
 * ```text
 * selections only      946bd5f2596c
 * + config_version 7   b74fd65635db
 * + config_version 8   9abc20ca2894   <- a different line
 * ```
 *
 * A customer would add "Luxury" on Monday, the merchant would publish an
 * unrelated edit, and adding "Luxury" again on Tuesday would give them two lines
 * of quantity 1 -- contradicting M12.1's own acceptance criterion.
 *
 * So the key is computed from the payload with Optionia's audit fields pruned.
 * The identity of a line is its **selections**; everything else is a record of
 * how it was priced.
 *
 * ## Why this filter is written defensively
 *
 * `woocommerce_cart_id` fires for every add-to-cart of every product in the
 * store, including products Optionia has never touched. It is not our hook, it
 * is one we are borrowing, and the failure mode of getting it wrong is other
 * plugins' cart lines merging into each other. Hence: a payload with no Optionia
 * key is returned byte-for-byte untouched, and one with an Optionia key keeps
 * every other plugin's data exactly as it was.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Recomputes the cart item key from a line's identity alone.
 */
final class CartItemKey {

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Whether the core-algorithm mismatch has already been reported.
	 *
	 * The check below runs on every add-to-cart; a divergence would be true for
	 * all of them, and one warning is as informative as a thousand.
	 *
	 * @var bool
	 */
	private bool $reported_mismatch = false;

	/**
	 * Build over the logger.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Register the cart-id filter.
	 */
	public function register(): void {
		add_filter( 'woocommerce_cart_id', array( $this, 'filter' ), 10, 5 );
	}

	/**
	 * Return the key this line should have.
	 *
	 * @param mixed $cart_id        The key WooCommerce computed.
	 * @param mixed $product_id     Product id.
	 * @param mixed $variation_id   Variation id, or 0.
	 * @param mixed $variation      Chosen variation attributes.
	 * @param mixed $cart_item_data Full cart item data, after every plugin has contributed.
	 * @return string The key to use.
	 */
	public function filter( $cart_id, $product_id = null, $variation_id = null, $variation = null, $cart_item_data = null ): string {
		$id = (string) $cart_id;

		/*
		 * An early return, not the safety mechanism.
		 *
		 * Measured: removing this guard changes no key. `CartItemPayload::prune()`
		 * is a no-op on a payload with no Optionia entry, so `recompute()`
		 * reproduces exactly the id WooCommerce just handed us. The protection
		 * for other plugins' cart lines lives in `prune()` being surgical, and
		 * this only avoids two hashes we already know the answer to.
		 *
		 * Kept because it makes the intent legible at the top of the method, and
		 * because the hashing is not free on a cart page that adds many lines.
		 */
		if ( ! is_array( $cart_item_data ) || ! isset( $cart_item_data[ Keys::CART_ITEM_KEY ] ) ) {
			return $id;
		}

		$parts = array(
			is_numeric( $product_id ) ? (int) $product_id : 0,
			is_numeric( $variation_id ) ? (int) $variation_id : 0,
			is_array( $variation ) ? $variation : array(),
		);

		/*
		 * The self-check from FINDING 1c.
		 *
		 * This class reimplements `generate_cart_id()`'s hashing, because there is
		 * no way to ask WooCommerce for "the key you would have computed from this
		 * other payload". If WooCommerce ever changes that algorithm, ours silently
		 * diverges -- and since we *return* ours, WooCommerce uses it. Nothing
		 * crashes; keys stay internally consistent. But lines already stored in a
		 * session stop matching, so a customer sees duplicate lines once, after a
		 * WooCommerce update, with no way to connect the two events.
		 *
		 * The unpruned payload must reproduce the id WooCommerce just handed us. If
		 * it does not, the algorithm moved: leave the key alone and say so.
		 */
		if ( $this->recompute( $parts, $cart_item_data ) !== $id ) {
			$this->report_mismatch();

			return $id;
		}

		return $this->recompute( $parts, CartItemPayload::prune( $cart_item_data ) );
	}

	/**
	 * `generate_cart_id()`'s hashing, over a payload of our choosing.
	 *
	 * Deliberately verbatim, including the `trim()` calls and the
	 * `http_build_query()` on nested values -- the point is to agree with core,
	 * not to be tidier than it.
	 *
	 * @param array{0:int,1:int,2:array<string,mixed>} $parts          Product id, variation id, variation attributes.
	 * @param array<string, mixed>                     $cart_item_data The payload to hash.
	 * @return string The cart item key.
	 */
	private function recompute( array $parts, array $cart_item_data ): string {
		list( $product_id, $variation_id, $variation ) = $parts;

		$id_parts = array( $product_id );

		if ( $variation_id && 0 !== $variation_id ) {
			$id_parts[] = $variation_id;
		}

		if ( array() !== $variation ) {
			$variation_key = '';

			foreach ( $variation as $key => $value ) {
				$variation_key .= trim( (string) $key ) . trim( (string) $value );
			}

			$id_parts[] = $variation_key;
		}

		if ( array() !== $cart_item_data ) {
			$data_key = '';

			foreach ( $cart_item_data as $key => $value ) {
				if ( is_array( $value ) || is_object( $value ) ) {
					$value = http_build_query( $value );
				}

				$data_key .= trim( (string) $key ) . trim( (string) $value );
			}

			$id_parts[] = $data_key;
		}

		return md5( implode( '_', $id_parts ) );
	}

	/**
	 * Report, once, that core's cart-id algorithm no longer matches ours.
	 */
	private function report_mismatch(): void {
		if ( $this->reported_mismatch ) {
			return;
		}

		$this->reported_mismatch = true;

		$this->logger->warning(
			'WooCommerce computes cart item keys differently than this version expects; leaving keys unchanged.',
			array(
				'consequence' => 'options may produce a duplicate cart line until the plugin is updated',
			)
		);
	}
}
