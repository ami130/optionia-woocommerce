<?php
/**
 * The one writer of Optionia's cart item data (M11.6, extended by M12.1).
 *
 * `Integration\AddToCartValidator` resolves a selection and refuses a bad one.
 * Until this class existed it then **discarded the good one**, so a validated
 * selection reached the cart as nothing. This attaches it.
 *
 * ## Why the write lives in Phase 11 rather than waiting for M12.1
 *
 * M11.6 requires the cart total to be "correct under quantity change and
 * **session restore**". Session restore is persistence by definition: the
 * selection has to survive a page load, which means it has to be in
 * `cart_item_data`. A milestone cannot be satisfied without the thing it
 * depends on.
 *
 * The concern that kept it out was duplicate writers -- the divergence shape
 * this project keeps paying for. That concern does not apply here, because this
 * is not a second writer: M12.1 adds **sibling** keys under
 * `Keys::CART_ITEM_KEY` (resolved labels, per-option deltas, `config_version`,
 * a selection hash) and extends *this* class. `Keys::CART_ITEM_SELECTIONS` keeps
 * one owner throughout, which is the discipline the concern was protecting.
 *
 * ## Three constraints from `WC_Cart::generate_cart_id()`
 *
 * WooCommerce derives the cart item key from `cart_item_data`, so different
 * selections become different lines and identical ones merge -- no key logic is
 * needed here. But the derivation is textual (WC 11.0.1,
 * `includes/class-wc-cart.php:1123`):
 *
 * ```php
 * foreach ( $cart_item_data as $key => $value ) {
 *     if ( is_array( $value ) || is_object( $value ) ) {
 *         $value = http_build_query( $value );   // ORDER-SENSITIVE
 *     }
 *     $cart_item_data_key .= trim( $key ) . trim( $value );
 * }
 * ```
 *
 * 1. **Sorted.** `http_build_query` is order-sensitive, so the same selections
 *    in a different key order hash differently and produce a spurious duplicate
 *    line. `ksort()` below is not tidiness; it is the single easiest bug to
 *    introduce here.
 * 2. **Nothing volatile.** A timestamp, nonce or random id would make every
 *    add-to-cart a new line and break merging entirely. Only selection keys and
 *    value keys are attached.
 * 3. **Flat.** `http_build_query` flattens nesting, so deep structures collide
 *    more easily. The shape is one level: `option_id => value_key`.
 *
 * Verified in Phase 4: adding `luxury` then `premium` produced two lines, and
 * adding `premium` again merged. Variable products hash the variation id and the
 * option key independently, giving three distinct lines for three combinations.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\StoreClock;
use Optionia\Config\Repository;
use Optionia\Engine\SelectionResolver;
use Optionia\Support\BasePrice;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Attaches validated selections to a cart item.
 */
final class CartItemData {

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Build a writer over the configuration cache.
	 *
	 * @param Repository $config Configuration cache.
	 */
	public function __construct( Repository $config ) {
		$this->config = $config;
	}

	/**
	 * Register the hook WooCommerce collects cart item data from.
	 */
	public function register(): void {
		add_filter( 'woocommerce_add_cart_item_data', array( $this, 'attach' ), 10, 4 );
	}

	/**
	 * Attach the validated selection to a cart item.
	 *
	 * Runs inside `WC_Cart::add_to_cart()`, after
	 * `woocommerce_add_to_cart_validation` has already refused anything invalid.
	 * The selection is resolved **again** here rather than carried over from the
	 * validator: passing state between two filters through a property would make
	 * the result depend on invocation order, and re-resolving against the same
	 * cached config is cheap and cannot disagree with itself.
	 *
	 * @param mixed $cart_item_data Existing cart item data.
	 * @param mixed $product_id     Product id.
	 * @param mixed $variation_id   Variation id, or 0.
	 * @param mixed $quantity       Quantity; unused, never part of the payload.
	 * @return array<string, mixed> Cart item data, with selections attached when there are any.
	 */
	public function attach( $cart_item_data, $product_id = null, $variation_id = null, $quantity = null ): array {
		unset( $quantity );

		$data = is_array( $cart_item_data ) ? $cart_item_data : array();
		$id   = is_numeric( $product_id ) ? (int) $product_id : 0;

		/*
		 * The variation id is USED since M16.1, having been discarded before it.
		 *
		 * It was surplus while the base price was not: a `fixed` amount is the
		 * same whichever variation was chosen. A `percentage` is not, and a
		 * parent variable product commonly carries no price of its own -- so
		 * pricing off the parent charges a percentage of nothing, on the path
		 * that freezes the amount onto the line.
		 */
		$variation = is_numeric( $variation_id ) ? (int) $variation_id : 0;

		if ( 0 === $id ) {
			return $data;
		}

		$option_sets = $this->config->option_sets_for_product( $id );

		if ( array() === $option_sets ) {
			return $data;
		}

		$request = AddToCartRequest::from_filter( $id, null, null, 'add_cart_item_data' );

		/*
		 * 🔴 **The base price, not `0`.**
		 *
		 * This call passed a literal `0` until M16.1, which was harmless while
		 * `fixed` was the only priced type -- a flat amount does not depend on
		 * what the product costs. A `percentage` does, and the delta computed
		 * here is **frozen and signed** onto the cart line a few lines below.
		 *
		 * Measured before this argument existed: a 50% option on an 80.00 product
		 * froze at `{"opt-a":0}` and the line charged 80.00, with every unit test
		 * green -- because they all called the resolver directly with a base.
		 */
		$result = SelectionResolver::resolve(
			$option_sets,
			$request->selections(),
			BasePrice::minor( $id, $variation ),
			StoreClock::today()
		);

		/*
		 * A failed resolution attaches nothing rather than throwing. The
		 * validator has already refused this add-to-cart, so reaching here with
		 * an invalid selection means another plugin overrode that refusal --
		 * in which case the line should carry no Optionia state at all rather
		 * than partial state that later code would trust.
		 */
		if ( ! $result->is_ok() ) {
			return $data;
		}

		$selections = $result->value()['resolved'];

		if ( array() === $selections ) {
			return $data;
		}

		/*
		 * Already keyed by option id -- no pairing to do, and that is the point.
		 *
		 * 🔴 **This used to pair positionally, and the order mattered.**
		 * `SelectionResolver` returned deltas as a positional list in the order
		 * it walked the selections, so this had to run BEFORE the `ksort()`
		 * below: sorting first and pairing afterwards mismatched them. Measured
		 * then, a customer submitting a 9000 option before a 100 option had the
		 * two swapped, charging 100 for the expensive one -- nothing failed
		 * loudly, the cart was simply wrong.
		 *
		 * ADR-061 removed that whole class of bug by keying `deltas` at the
		 * source. A multi-select made the positional invariant unsatisfiable --
		 * one selection carrying two deltas -- and the count guard then returned
		 * an empty pairing, which froze onto the line and made it **price
		 * live**. There is no ordering requirement left here to get wrong.
		 */
		$deltas = $result->value()['deltas'];

		// Constraint 1: deterministic order, or the same selection makes two lines.
		ksort( $selections );
		ksort( $deltas );

		/*
		 * The frozen price, captured here because it cannot be recovered later.
		 *
		 * `Config\Repository::store()` overwrites, so exactly one configuration
		 * version exists at a time: once a merchant publishes, the price this
		 * customer was quoted is gone from everywhere except this array. That is
		 * why the delta is stored rather than recomputed, and it is the whole of
		 * M12.4's "the customer was quoted a price; changing it under them is
		 * indefensible".
		 *
		 * Signed, because a stored price is a price something else could write.
		 * `cart_item_data` is not browser-writable -- verified: `WC_AJAX` never
		 * reads it, the form handler never fills it from `$_POST`, and the Store
		 * API hardcodes `'cart_item_data' => []` -- but another plugin can, via
		 * `woocommerce_add_cart_item_data`, and Stage 7b's rule holds: a price
		 * another plugin can set is not server-authoritative.
		 *
		 * None of these three fields belongs in the cart item key, which is why
		 * `CartItemKey` prunes them before hashing. They record how a line was
		 * priced; they are not part of what makes it that line.
		 *
		 * They cost session storage: measured at **1.8x** the selections-only
		 * payload for a fifty-option line -- 1,582 bytes to 2,806 -- so an
		 * extreme twenty-line cart carries roughly 55 KB. That is comfortably
		 * inside what WooCommerce sessions already hold, and it is the price of
		 * being able to honour a quote after a publish. Recorded so a future
		 * "why is `wc_sessions` large" question starts from a number.
		 */

		/*
		 * A line containing an option this build cannot price is **not frozen**.
		 *
		 * Phase 11 contributes 0 for `percentage`, `per_unit`, `per_char` and
		 * `tiered`, which is the right arithmetic and is why
		 * `Admin\UnpricedTypesNotice` exists to tell the merchant. Freezing that
		 * 0 composes the two behaviours into something neither intended: the
		 * merchant reads the notice, switches the option to a fixed amount, and
		 * every cart already holding it goes on charging nothing -- measured, a
		 * line stayed at 80.00 after the merchant fixed a 50.00 option.
		 *
		 * Both parts are individually correct, and together they make a
		 * merchant-facing notice misleading: it asks for a change that visibly
		 * does nothing.
		 *
		 * So the freeze is skipped rather than the zero being stored. Skipping
		 * means the line prices from current configuration, which is exactly what
		 * it did before this milestone -- so the customer sees 0 for the option
		 * while it is unpriceable, and the corrected price the moment the merchant
		 * fixes it. Nothing is charged that was not quoted: the option contributes
		 * nothing in either state until the fix lands.
		 *
		 * The selections are still stored. They are the line's identity, and they
		 * are what M12.5 writes to the order.
		 */
		$labels = $result->value()['labels'] ?? array();
		ksort( $labels );

		$set_ids = $result->value()['set_ids'] ?? array();
		sort( $set_ids );

		/*
		 * Sorted by option id, so one configuration produces one SKU.
		 *
		 * The resolver returns these in the order it walked the selections, which
		 * is the order they arrived in -- so two customers choosing the same
		 * options in different orders would otherwise get different codes for an
		 * identical product.
		 */
		$sku_suffixes = $result->value()['sku_suffixes'] ?? array();
		ksort( $sku_suffixes );

		if ( array() !== ( $result->value()['unpriced'] ?? array() ) ) {
			$data[ Keys::CART_ITEM_KEY ] = array(
				Keys::CART_ITEM_SELECTIONS   => $selections,
				Keys::CART_ITEM_LABELS       => $labels,
				Keys::CART_ITEM_SET_IDS      => $set_ids,
				Keys::CART_ITEM_SKU_SUFFIXES => $sku_suffixes,
			);

			return $data;
		}

		$version = $this->config->config_version();

		$data[ Keys::CART_ITEM_KEY ] = array(
			Keys::CART_ITEM_SELECTIONS     => $selections,
			Keys::CART_ITEM_CONFIG_VERSION => $version,
			Keys::CART_ITEM_DELTAS         => $deltas,
			Keys::CART_ITEM_SIGNATURE      => CartItemPayload::sign( $selections, $deltas, $version ),

			/*
			 * Outside the signature on purpose. See `Keys::CART_ITEM_LABELS`:
			 * signing the names would make a rename invalidate the price freeze,
			 * and a rename is not a price change.
			 */
			Keys::CART_ITEM_LABELS         => $labels,
			Keys::CART_ITEM_SET_IDS        => $set_ids,

			/*
			 * Outside the signature, like labels and set ids: it records what the
			 * warehouse picks, not what the customer pays. Signing it would make
			 * a merchant editing a suffix invalidate the price freeze.
			 */
			Keys::CART_ITEM_SKU_SUFFIXES   => $sku_suffixes,
		);

		return $data;
	}
}
