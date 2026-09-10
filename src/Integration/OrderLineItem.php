<?php
/**
 * Persists a cart line's options onto the order (M12.5).
 *
 * `woocommerce_checkout_create_order_line_item` fires once per line, **before**
 * `$order->add_item( $item )` (WC 11.0.1, `includes/class-wc-checkout.php:598`
 * then `:600`), so meta added here is written with the item and needs no second
 * save.
 *
 * One hook covers both checkout worlds: the Store API delegates to
 * `wc()->checkout->create_order_line_items()`
 * (`src/StoreApi/Utilities/OrderController.php:839`), which is the same method
 * the classic checkout uses.
 *
 * ## Two tiers, and two different hiding mechanisms
 *
 * | Tier | Keys | Purpose |
 * |---|---|---|
 * | **Visible** | `Finish`, `Engraving` -- the option's own label | Renders in print, packing slips, emails, CSV export |
 * | **Hidden** | `_optionia_*` | Machine payload: ids, keys, deltas, version |
 *
 * The visible tier is the whole of [M12.6b](#m126b--fulfilment-output): merchants
 * fulfil from a printed sheet or a job queue, not from a screen, and WooCommerce
 * renders order item meta into all of those **if the keys are human-readable**.
 * A key chosen for developer convenience -- `_optionia_sel_a3f9` -- renders as
 * noise or is hidden entirely.
 *
 * ⚠️ **The underscore prefix is not enough on its own.** Phase 4 assumed it was.
 * It governs *customer-facing* output only; on the **admin order screen** an
 * underscore-prefixed key appeared twice -- once read-only and once as an
 * **editable input** a merchant could change. The admin screen uses an explicit
 * allow-list, `OrderItemMetaUtil::get_hidden_keys()`, filtered by
 * `woocommerce_hidden_order_itemmeta`, so every machine key is registered there
 * as well. Two mechanisms, both required.
 *
 * ## HPOS
 *
 * Barely relevant here, and worth saying so because the milestone's "verified
 * with HPOS enabled and disabled" reads like the main risk. HPOS moves *order*
 * meta to `wc_orders_meta`; **order item** meta stays in
 * `woocommerce_order_itemmeta` and `OrdersTableDataStore` does not touch it.
 * Writing through the CRUD API (`$item->add_meta_data()`) rather than
 * `wc_add_order_item_meta()` keeps it identical under both -- which is what
 * Phase 4 measured on orders #29 and #31.
 *
 * ## What a reorder may replay
 *
 * Everything here is written, because an order is a **record** and a record with
 * holes in it cannot answer a support question. But
 * [M12.8](#m128--refunds-edits-and-edge-cases) must replay **selections only**:
 * a reorder is a new purchase, so it reprices from current configuration. The
 * frozen delta and `config_version` on an order describe what *was* bought, not
 * what a new cart should cost.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\Keys;
use Optionia\Support\Money;

defined( 'ABSPATH' ) || exit;

/**
 * Writes Optionia's cart data onto an order line item.
 */
final class OrderLineItem {

	/**
	 * The hook both checkout worlds fire, once per line.
	 */
	public const HOOK = 'woocommerce_checkout_create_order_line_item';

	/**
	 * Machine keys that must never appear as editable admin inputs.
	 *
	 * Registered with `woocommerce_hidden_order_itemmeta` because the underscore
	 * prefix alone does not hide them there -- see the class docblock.
	 *
	 * @var array<int, string>
	 */
	private const HIDDEN_KEYS = array(
		Keys::META_SELECTIONS,
		Keys::META_CONFIG_VERSION,
		Keys::META_OPTION_SET_ID,
		Keys::META_PRICE_DELTA,
		Keys::META_SKU_SUFFIX,
	);

	/**
	 * Register the order-line hook and the admin hidden-key filter.
	 */
	public function register(): void {
		add_action( self::HOOK, array( $this, 'attach' ), 10, 3 );
		add_filter( 'woocommerce_hidden_order_itemmeta', array( $this, 'hide_machine_keys' ) );
	}

	/**
	 * The machine keys this plugin writes.
	 *
	 * @return array<int, string>
	 */
	public static function hidden_keys(): array {
		return self::HIDDEN_KEYS;
	}

	/**
	 * Add our machine keys to the admin screen's hidden allow-list.
	 *
	 * @param mixed $keys Keys WooCommerce and other plugins already hide.
	 * @return array<int, string>
	 */
	public function hide_machine_keys( $keys ): array {
		$existing = is_array( $keys ) ? $keys : array();

		return array_values( array_unique( array_merge( $existing, self::HIDDEN_KEYS ) ) );
	}

	/**
	 * Write a line's options onto the order item.
	 *
	 * @param mixed $item          The order line item.
	 * @param mixed $cart_item_key The cart item key; unused.
	 * @param mixed $values        The cart item, carrying Optionia's payload.
	 */
	public function attach( $item, $cart_item_key = null, $values = null ): void {
		unset( $cart_item_key );

		if ( ! is_object( $item ) || ! method_exists( $item, 'add_meta_data' ) ) {
			return;
		}

		$optionia = is_array( $values ) ? ( $values[ Keys::CART_ITEM_KEY ] ?? null ) : null;

		if ( ! is_array( $optionia ) ) {
			return;
		}

		$selections = $optionia[ Keys::CART_ITEM_SELECTIONS ] ?? null;

		if ( ! is_array( $selections ) || array() === $selections ) {
			return;
		}

		$this->add_visible_meta( $item, $selections, $optionia );
		$this->add_hidden_meta( $item, $selections, $optionia );
	}

	/**
	 * The human-readable pairs a merchant fulfils from.
	 *
	 * Keyed by the option's **label**, not its id, because WooCommerce renders
	 * order item meta keys verbatim into packing slips, emails and CSV exports.
	 * `Finish: Luxury` is a fulfilment instruction; `opt-a: lux` is not.
	 *
	 * Falls back to the id when no label was snapshotted, so a line always
	 * renders something rather than vanishing from the packing slip.
	 *
	 * @param object               $item       The order line item.
	 * @param array<string, mixed> $selections Option id to value key.
	 * @param array<string, mixed> $optionia   The line's Optionia payload.
	 */
	private function add_visible_meta( object $item, array $selections, array $optionia ): void {
		$labels = $optionia[ Keys::CART_ITEM_LABELS ] ?? array();
		$labels = is_array( $labels ) ? $labels : array();

		foreach ( $selections as $option_id => $value_key ) {
			$option_id = (string) $option_id;
			$label     = $labels[ $option_id ] ?? null;

			$name  = is_array( $label ) && isset( $label['option'] ) && is_scalar( $label['option'] ) && '' !== (string) $label['option']
				? (string) $label['option']
				: $option_id;
			$value = is_array( $label ) && isset( $label['value'] ) && is_scalar( $label['value'] ) && '' !== (string) $label['value']
				? (string) $label['value']
				: (string) $value_key;

			/*
			 * Not truncated, and deliberately so: an engraving can be 200
			 * characters and a truncated engraving is a wrong product
			 * manufactured. M12.6b names this explicitly.
			 */
			$item->add_meta_data( $name, $value, true );
		}
	}

	/**
	 * The machine payload, for anything that has to reason about the line later.
	 *
	 * JSON-encoded rather than one key per option, because order item meta is a
	 * flat key/value table: a line with twenty options would otherwise add twenty
	 * hidden rows, and the admin screen would have to hide each one by name.
	 *
	 * @param object               $item       The order line item.
	 * @param array<string, mixed> $selections Option id to value key.
	 * @param array<string, mixed> $optionia   The line's Optionia payload.
	 */
	private function add_hidden_meta( object $item, array $selections, array $optionia ): void {
		$item->add_meta_data( Keys::META_SELECTIONS, wp_json_encode( $selections ), true );

		$set_ids = $optionia[ Keys::CART_ITEM_SET_IDS ] ?? null;

		if ( is_array( $set_ids ) && array() !== $set_ids ) {
			$item->add_meta_data( Keys::META_OPTION_SET_ID, wp_json_encode( array_values( $set_ids ) ), true );
		}

		/*
		 * 🔴 **The SKU suffixes, and the only place they are applied.**
		 *
		 * M16.8 wanted them on the product's own SKU. `WC_Product::set_sku()`
		 * calls `wc_product_has_unique_sku()` and **throws `WC_Data_Exception`**
		 * on a duplicate -- and two cart lines of one product with the same
		 * option produce identical SKUs, so the duplicate is the normal case
		 * rather than the odd one. An uncaught throw on
		 * `woocommerce_before_calculate_totals` takes the cart page down, which
		 * is worse than the silent gap it would be fixing. It also runs a
		 * database query per cart line, on a hook that fires nine times per
		 * request.
		 *
		 * Fulfilment reads the order, not the cart, so the order is where the
		 * code belongs. Keyed by option id rather than pre-joined: a separator is
		 * a merchant's convention -- `-OAK-LG` or `_OAK_LG` -- and inventing one
		 * here would bake it in for every integration.
		 *
		 * Written whether or not the price freeze verified, unlike the deltas
		 * below. A suffix records **what was ordered**, not what was charged, and
		 * a warehouse still has to pick the right variant when a salt rotation
		 * invalidated a signature.
		 */
		$sku_suffixes = $optionia[ Keys::CART_ITEM_SKU_SUFFIXES ] ?? null;

		if ( is_array( $sku_suffixes ) && array() !== $sku_suffixes ) {
			$item->add_meta_data( Keys::META_SKU_SUFFIX, wp_json_encode( $sku_suffixes ), true );
		}

		/*
		 * The frozen values are recorded **only if the freeze was the price the
		 * customer actually paid**.
		 *
		 * `Integration\CartTotals` prices from the frozen deltas when the
		 * signature verifies and from current configuration when it does not --
		 * a salt rotation, a site migration, a payload another plugin rewrote.
		 * This class reads the same `cart_item_data` but is a different hook, so
		 * without repeating the check it would copy the stale figures onto the
		 * order regardless.
		 *
		 * Measured before this guard existed: after a salt rotation a line was
		 * charged 179.00 while the order recorded `_optionia_price_delta` of
		 * 20.00 and `config_version` 7. A refund calculated from that meta would
		 * have been wrong by 79.00 -- a false number on a business record, in
		 * exactly the case the fallback was designed to survive gracefully.
		 *
		 * `CartItemPayload::trusted_deltas()` is the same method `CartTotals` and
		 * `CartDisplay` ask, so the three cannot disagree: either all trust the
		 * payload or none do. When it declines, the line was priced live and
		 * there is no quoted delta to record -- the order still carries the
		 * selections, the labels and the set ids, which is what a support
		 * conversation needs.
		 *
		 * It must be `trusted_deltas()` and not `frozen_deltas()`. The weaker
		 * method verifies the signature but not that the deltas *cover* the
		 * line's selections, and this class used it until the Stage 0-7 audit.
		 * Measured: a signed payload holding one delta for a two-option line was
		 * priced live at 105.00 while the order recorded 20.00 -- the exact
		 * defect this guard was added in Stage 6 to prevent, surviving in the fix
		 * for it because Stage 7 generalised the helper without retrofitting the
		 * caller. Fourth appearance of the same seam in four stages.
		 */
		$deltas = CartItemPayload::trusted_deltas( array( Keys::CART_ITEM_KEY => $optionia ), $selections );

		if ( null === $deltas || array() === $deltas ) {
			return;
		}

		$version = $optionia[ Keys::CART_ITEM_CONFIG_VERSION ] ?? null;

		if ( is_int( $version ) ) {
			$item->add_meta_data( Keys::META_CONFIG_VERSION, $version, true );
		}

		/*
		 * Stored as a decimal string, not minor units.
		 *
		 * Everything inside the plugin is integer minor units, and stays that
		 * way. But this value is read by refund tooling, exports and human beings
		 * -- an order screen showing `_optionia_price_delta: 2000` on a 20.00
		 * option invites exactly the wrong conclusion.
		 */
		$total = 0;

		foreach ( $deltas as $delta ) {
			if ( is_int( $delta ) ) {
				$total += $delta;
			}
		}

		$item->add_meta_data( Keys::META_PRICE_DELTA, Money::from_minor( $total )->to_decimal_string(), true );
	}
}
