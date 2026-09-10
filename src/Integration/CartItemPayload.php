<?php
/**
 * The shape Optionia stores on a cart line, and the two operations on it.
 *
 * A cart line's `cart_item_data['optionia']` carries two kinds of thing, and the
 * difference is the whole reason this class exists:
 *
 * | Sub-key          | Kind      | In the cart item key? |
 * |------------------|-----------|-----------------------|
 * | `selections`     | identity  | **yes** -- different selections are different lines |
 * | `config_version` | audit     | no |
 * | `deltas`         | audit     | no |
 * | `signature`      | audit     | no |
 *
 * ## Why the audit fields must be pruned before hashing
 *
 * `WC_Cart::generate_cart_id()` hashes the **whole** `cart_item_data` payload, so
 * a field that changes when a merchant publishes splits what should be one line.
 * Measured: the same selection with `config_version` 7 and 8 produced two
 * different keys, and M12.1's own acceptance requires them to merge.
 *
 * ## One caller, and why the second never materialised
 *
 * `prune()` is used by **`CartItemKey`** alone, so identical selections merge
 * across a publish.
 *
 * Stage 1 predicted a second caller: reorder (M12.8), stripping the audit fields
 * so a replayed order reprices instead of inheriting the prices it was bought
 * at. Reading WooCommerce rather than reasoning about it showed the obligation
 * does not exist --
 * `apply_filters( 'woocommerce_order_again_cart_item_data', array(), ... )`
 * (WC 11.0.1, `includes/class-wc-cart-session.php:587`) starts from an **empty
 * array**. Nothing is replayed, so there is nothing to strip:
 * `Integration\OrderAgain` *constructs* a payload holding selections and nothing
 * else. Corrected 2026-09-01 in Stage 8; this docblock still said "two callers"
 * until the Phase 12 audit caught it.
 *
 * The helper stays shared rather than being inlined into its one caller. What it
 * encodes -- which fields are identity and which are audit -- is a decision the
 * signature, the cart key and the reorder payload all depend on, and
 * `AUDIT_KEYS` is the single list they read. Mutation-proven load-bearing:
 * emptying it, or removing `config_version` alone, both break cart merging
 * across a publish.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Reads, prunes and signs Optionia's cart item payload.
 */
final class CartItemPayload {

	/**
	 * Sub-keys that are audit data, not identity.
	 *
	 * Listed rather than derived so adding a field is a deliberate decision about
	 * which kind it is. A new identity field changes what merges; a new audit
	 * field must be added here or it starts splitting cart lines.
	 *
	 * @var array<int, string>
	 */
	private const AUDIT_KEYS = array(
		Keys::CART_ITEM_CONFIG_VERSION,
		Keys::CART_ITEM_DELTAS,
		Keys::CART_ITEM_SIGNATURE,
		Keys::CART_ITEM_LABELS,
		Keys::CART_ITEM_SET_IDS,
		Keys::CART_ITEM_SKU_SUFFIXES,
	);

	/**
	 * Not instantiable -- this is a namespace for pure functions over the payload.
	 */
	private function __construct() {
	}

	/**
	 * The same `cart_item_data`, with Optionia's audit fields removed.
	 *
	 * **Surgical, deliberately.** `woocommerce_cart_id` fires for every
	 * add-to-cart of every product, and by the time it runs every plugin has
	 * already contributed through `woocommerce_add_cart_item_data`
	 * (`class-wc-cart.php:1294`, then `:1297`). A prune that rebuilt the payload
	 * from Optionia's own fields would destroy other plugins' keys -- two
	 * distinct gift-wrap lines from a competing plugin would merge into one.
	 *
	 * So: a payload with no Optionia key is returned **untouched**, and one with
	 * an Optionia key keeps every other key exactly as it was.
	 *
	 * @param array<string, mixed> $cart_item_data Full cart item data.
	 * @return array<string, mixed> The same data, minus Optionia's audit fields.
	 */
	public static function prune( array $cart_item_data ): array {
		if ( ! isset( $cart_item_data[ Keys::CART_ITEM_KEY ] ) || ! is_array( $cart_item_data[ Keys::CART_ITEM_KEY ] ) ) {
			return $cart_item_data;
		}

		foreach ( self::AUDIT_KEYS as $audit_key ) {
			unset( $cart_item_data[ Keys::CART_ITEM_KEY ][ $audit_key ] );
		}

		return $cart_item_data;
	}

	/**
	 * A signature over the frozen payload.
	 *
	 * ## Why a signature rather than a bound
	 *
	 * The obvious alternative -- clamp the stored delta against the current
	 * configuration -- collapses on inspection. `min( frozen, current )` *is* the
	 * forgery it is meant to stop: a forged lower delta simply wins. And the
	 * frozen value cannot be re-derived, because `Config\Repository::store()`
	 * overwrites, so exactly one configuration version exists at any moment.
	 *
	 * Signing is what makes a value checkable without the data that produced it.
	 *
	 * ## Why `wp_hash()` and not the store token
	 *
	 * `Keys::OPTION_STORE_TOKEN` is the cloud credential. Reusing it here would
	 * widen its blast radius, and it is **deleted on disconnect** -- every cart
	 * line's signature would break at once, on a store that can still be selling.
	 * `wp_hash()` is WordPress's own keyed hash over `wp_salt()`: always present,
	 * unrelated to the connection, and rotated only when a site owner rotates
	 * salts.
	 *
	 * Key order is normalised before hashing. Two customers choosing the same
	 * options in a different order must produce the same signature, for the same
	 * reason they must produce the same cart key.
	 *
	 * ## Why the product is deliberately not part of the signature
	 *
	 * A payload signed on one product therefore verifies on another. That was
	 * examined rather than overlooked, and it is not exploitable: option ids are
	 * the index key in `Engine\SelectionResolver::index_options()`, so two
	 * products sharing an option id are sharing **the same option** -- the same
	 * set, at the same price. Replaying a frozen delta onto another product
	 * replays the number that product already had.
	 *
	 * Binding the product would also be wrong in a way that costs something: an
	 * option set assigned to many products, or reassigned between them, would
	 * invalidate every existing cart line for no benefit. Recorded here so the
	 * absence reads as a decision rather than an oversight.
	 *
	 * @param array<string, string> $selections Option id to value key.
	 * @param array<string, int>    $deltas     Option id to minor units.
	 * @param int                   $version    The `config_version` priced against.
	 * @return string Hex signature, or an empty string when signing is unavailable.
	 */
	public static function sign( array $selections, array $deltas, int $version ): string {
		if ( ! function_exists( 'wp_hash' ) ) {
			return '';
		}

		ksort( $selections );
		ksort( $deltas );

		return (string) wp_hash(
			wp_json_encode( $selections ) . '|' . wp_json_encode( $deltas ) . '|' . $version,
			'auth'
		);
	}

	/**
	 * Whether a stored payload's signature still verifies.
	 *
	 * Compared with `hash_equals()` rather than `===`, for the usual reason: a
	 * timing-variable comparison of a secret-derived value is a side channel, and
	 * this one is reachable on every cart page load.
	 *
	 * @param array<string, mixed> $optionia The `cart_item_data['optionia']` array.
	 * @return bool True when the frozen values are the ones this site signed.
	 */
	public static function verify( array $optionia ): bool {
		$signature = $optionia[ Keys::CART_ITEM_SIGNATURE ] ?? null;

		if ( ! is_string( $signature ) || '' === $signature ) {
			return false;
		}

		$selections = $optionia[ Keys::CART_ITEM_SELECTIONS ] ?? null;
		$deltas     = $optionia[ Keys::CART_ITEM_DELTAS ] ?? null;
		$version    = $optionia[ Keys::CART_ITEM_CONFIG_VERSION ] ?? null;

		if ( ! is_array( $selections ) || ! is_array( $deltas ) || ! is_int( $version ) ) {
			return false;
		}

		$expected = self::sign( $selections, $deltas, $version );

		if ( '' === $expected ) {
			return false;
		}

		return hash_equals( $expected, $signature );
	}

	/**
	 * The per-option deltas a line should be priced and *described* with.
	 *
	 * **One question, asked in three places, and it must get one answer.**
	 * `Integration\CartTotals` prices the line, `Integration\OrderLineItem`
	 * records what was charged, and `Integration\CartDisplay` shows the customer
	 * a breakdown. Each reads the same `cart_item_data` from a different hook, so
	 * each could reach its own verdict on whether the frozen payload is usable --
	 * and twice already they did:
	 *
	 * - Stage 6: an order recorded a delta of 20.00 on a line charged 179.00,
	 *   because only the pricing path re-checked the signature.
	 * - Stage 7: the cart breakdown would have shown "(+20.00)" beside a line
	 *   total computed from 99.00, for the same reason.
	 *
	 * Both were the same defect on different surfaces. This method is the fix for
	 * the class of defect rather than its instances: a caller either gets the
	 * frozen deltas, or `null` meaning "price and describe from current
	 * configuration".
	 *
	 * A payload whose deltas do not cover every live selection is refused whole.
	 * The two are written together and cannot legitimately disagree, so a
	 * mismatch means the payload is not describing this line -- and pricing part
	 * of a line from a quote and part from today produces a number nobody chose.
	 *
	 * @param array<string, mixed>  $item       A cart item.
	 * @param array<string, string> $selections The line's live, resolved selections.
	 * @return array<string, int>|null Trusted deltas, or null to use current config.
	 */
	public static function trusted_deltas( array $item, array $selections ): ?array {
		$frozen = self::frozen_deltas( $item );

		if ( null === $frozen ) {
			return null;
		}

		$trusted = array();

		foreach ( array_keys( $selections ) as $option_id ) {
			if ( ! array_key_exists( $option_id, $frozen ) ) {
				return null;
			}

			$trusted[ $option_id ] = $frozen[ $option_id ];
		}

		return $trusted;
	}

	/**
	 * The frozen deltas from a cart line, if they can be trusted.
	 *
	 * Returns `null` when there is no frozen payload, or when its signature does
	 * not verify -- and the caller then prices from the **current** configuration.
	 *
	 * **An unverifiable freeze is simply not a freeze.** Refusing the line
	 * instead would empty every cart in the store the moment a site owner rotated
	 * their salts, which is a routine security action. Falling back gains a
	 * tamperer nothing -- they get today's price -- and degrades exactly to the
	 * behaviour Phase 11 shipped, which is a known-safe state rather than an
	 * unknown one.
	 *
	 * @param array<string, mixed> $item A cart item.
	 * @return array<string, int>|null Frozen deltas, or null to price from current config.
	 */
	public static function frozen_deltas( array $item ): ?array {
		$optionia = $item[ Keys::CART_ITEM_KEY ] ?? null;

		if ( ! is_array( $optionia ) || ! self::verify( $optionia ) ) {
			return null;
		}

		$deltas = $optionia[ Keys::CART_ITEM_DELTAS ];
		$clean  = array();

		foreach ( $deltas as $option_id => $delta ) {
			if ( ! is_int( $delta ) ) {
				return null;
			}

			$clean[ (string) $option_id ] = $delta;
		}

		return $clean;
	}
}
