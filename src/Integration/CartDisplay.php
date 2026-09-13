<?php
/**
 * Shows a customer what they chose, in both cart worlds (M12.2).
 *
 * `woocommerce_get_item_data` serves classic **and** block cart -- verified in
 * WC 11.0.1:
 *
 * ```text
 * includes/wc-template-functions.php:4538        classic cart template
 * src/StoreApi/Schemas/V1/CartItemSchema.php:170 block cart (Store API)
 * ```
 *
 * One filter, two renderers, and three constraints that only bite on one side.
 *
 * ## 1. Every value must be a scalar, or the row vanishes
 *
 * `CartItemSchema::get_item_data()` walks each element and discards the **whole
 * element** if any value is not scalar:
 *
 * ```php
 * foreach ( $data as $data_value ) {
 *     if ( ! is_scalar( $data_value ) ) { continue 2; }
 * }
 * ```
 *
 * No error, no warning, no log line. Phase 4 measured it: a probe emitting one
 * scalar row and one array row produced **two rows on classic and one on
 * blocks**. A developer testing only the classic cart ships this and never sees
 * it. So arrays are joined into strings here, before they leave.
 *
 * ## 2. Hiding a row needs TWO keys, not one
 *
 * The two paths read different keys, and the plan for this milestone named only
 * the block one:
 *
 * | Path | Key |
 * |---|---|
 * | classic (`wc-template-functions.php:4545`) | `hidden` |
 * | block (`CartItemSchema.php:193`) | `__experimental_woocommerce_blocks_hidden` |
 *
 * The block path *derives* `hidden` from the experimental key, so setting only
 * the experimental one leaves the row visible on classic. Both are set together
 * in `row()`, so a future core rename is a one-line change here.
 *
 * ## 3. `wp_kses_post` runs on every value
 *
 * `format_item_data_element()` maps it over the whole element, so markup does
 * not survive intact. Everything here is plain text by construction.
 *
 * ## Why the prices shown are not simply the stored ones
 *
 * The frozen deltas on a cart line are only meaningful when their signature
 * verifies. `Integration\CartTotals` already prices from current configuration
 * when it does not -- so a breakdown reading the stored numbers regardless would
 * show `(+20.00)` beside a line total computed from 99.00, contradicting itself
 * on the customer's screen. Both ask `CartItemPayload::trusted_deltas()`, which
 * is the single answer to that question.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\StoreClock;
use Optionia\Config\Repository;
use Optionia\Engine\SelectionResolver;
use Optionia\Support\Keys;
use Optionia\Support\BasePrice;
use Optionia\Support\Money;
use Optionia\Support\OptionLabel;

defined( 'ABSPATH' ) || exit;

/**
 * Renders a cart line's chosen options for both cart implementations.
 */
final class CartDisplay {

	/**
	 * The filter both cart worlds apply.
	 */
	public const HOOK = 'woocommerce_get_item_data';

	/**
	 * The key the classic cart template reads to hide a row.
	 */
	private const HIDDEN_CLASSIC = 'hidden';

	/**
	 * The key the Store API reads to hide a row.
	 *
	 * The `__experimental_` prefix is a stability warning from WooCommerce, not
	 * decoration. It is written in exactly one place so a core rename is a
	 * one-line change.
	 */
	private const HIDDEN_BLOCK = '__experimental_woocommerce_blocks_hidden';

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Build over the configuration cache.
	 *
	 * @param Repository $config Configuration cache.
	 */
	public function __construct( Repository $config ) {
		$this->config = $config;
	}

	/**
	 * Register the display filter.
	 */
	public function register(): void {
		add_filter( self::HOOK, array( $this, 'item_data' ), 10, 2 );
	}

	/**
	 * Add a row per chosen option.
	 *
	 * @param mixed $item_data Rows other plugins and core have already added.
	 * @param mixed $cart_item The cart item.
	 * @return array<int, array<string, mixed>>
	 */
	public function item_data( $item_data, $cart_item = null ): array {
		/*
		 * The block path starts from `array()` while the classic template passes
		 * a populated list, so this appends rather than replacing -- a callback
		 * that returned only its own rows would erase variation attributes on the
		 * classic cart and nothing on blocks.
		 */
		$rows = is_array( $item_data ) ? $item_data : array();

		if ( ! is_array( $cart_item ) ) {
			return $rows;
		}

		$optionia = $cart_item[ Keys::CART_ITEM_KEY ] ?? null;

		if ( ! is_array( $optionia ) ) {
			return $rows;
		}

		$selections = $optionia[ Keys::CART_ITEM_SELECTIONS ] ?? null;

		if ( ! is_array( $selections ) || array() === $selections ) {
			return $rows;
		}

		$labels = is_array( $optionia[ Keys::CART_ITEM_LABELS ] ?? null ) ? $optionia[ Keys::CART_ITEM_LABELS ] : array();
		$deltas = $this->deltas_for( $cart_item, $selections );

		foreach ( $selections as $option_id => $value_key ) {
			$option_id = (string) $option_id;
			$label     = $labels[ $option_id ] ?? null;

			/*
			 * 🔴 **Read through `OptionLabel`, which knows both stored shapes.**
			 *
			 * `$label['option']` is `null` when the label is a *list* — the
			 * `cardinality: many` shape — so this fell back to the option id,
			 * and `(string) $value_key` on the selection array coerced to the
			 * literal `"Array"`. Measured: this method reached
			 * `Array to string conversion` on a multi-select line.
			 *
			 * ⚠️ **One row per option, whatever its cardinality**, so
			 * `Extras: Red, Blue (+3.00)` is a single row carrying the option's
			 * summed contribution. `OrderLineItem` and `CheckoutValidator` read
			 * the same way through the same class.
			 */
			$name  = OptionLabel::name( $label, $option_id );
			$value = OptionLabel::value( $label, $value_key );

			$rows[] = $this->row( $name, $this->with_price( $value, $deltas[ $option_id ] ?? null ) );
		}

		return $rows;
	}

	/**
	 * The per-option deltas this line may be described with.
	 *
	 * Trusted frozen deltas when the signature verifies, current configuration
	 * otherwise -- the same choice `CartTotals` makes when pricing, through the
	 * same method, so the breakdown and the line total cannot disagree.
	 *
	 * @param array<string, mixed>  $cart_item  The cart item.
	 * @param array<string, string> $selections The line's selections.
	 * @return array<string, int> Option id to minor units.
	 */
	private function deltas_for( array $cart_item, array $selections ): array {
		$trusted = CartItemPayload::trusted_deltas( $cart_item, $selections );

		if ( null !== $trusted ) {
			return $trusted;
		}

		$product_id  = isset( $cart_item['product_id'] ) && is_numeric( $cart_item['product_id'] ) ? (int) $cart_item['product_id'] : 0;
		$option_sets = $this->config->option_sets_for_product( $product_id );

		if ( array() === $option_sets ) {
			return array();
		}

		/*
		 * The base price, for the same reason `CartItemData` needs it: a
		 * `percentage` is computed from it, and a `0` here would print
		 * "Finish: Luxury" with no price beside an option the cart is charging
		 * for. The breakdown and the total must not disagree.
		 *
		 * The variation id comes off the cart item, which is where WooCommerce
		 * records it; a line with none reads 0 and falls back to the parent.
		 */
		$variation_id = isset( $cart_item['variation_id'] ) && is_numeric( $cart_item['variation_id'] )
			? (int) $cart_item['variation_id']
			: 0;

		$result = SelectionResolver::resolve(
			$option_sets,
			$selections,
			BasePrice::minor( $product_id, $variation_id ),
			StoreClock::today()
		);

		if ( ! $result->is_ok() ) {
			/*
			 * A selection that no longer resolves. `CheckoutValidator` blocks the
			 * order and tells the customer why; showing an invented price here
			 * would be a second, quieter wrong answer.
			 */
			return array();
		}

		/*
		 * Already keyed by option id (ADR-061) -- returned as it comes.
		 *
		 * 🔴 **This was the SECOND positional pairing, and it was written
		 * independently of the one in `CartItemData`.** Both did
		 * `array_combine( array_keys( $resolved ), $amounts )` over a delta list
		 * the resolver had walked in arrival order; Stage 2 shipped that bug
		 * once by sorting the selections before pairing them.
		 *
		 * ⚠️ **Two implementations of one rule is how they come to disagree.**
		 * `CartItemPayload`'s docblock says this question is asked in three
		 * places and must get one answer -- and a multi-select broke the pairing
		 * here in a different way than it broke the freeze, so the customer's
		 * *displayed breakdown* and the price they were *charged* could have
		 * parted company. Measured before ADR-061: this method reached
		 * `Array to string conversion` on a `many` line.
		 */
		return $result->value()['deltas'];
	}

	/**
	 * A value with its price appended, when there is one worth showing.
	 *
	 * A zero contributes nothing and gets no suffix: `Gift wrap: Yes (+0.00)`
	 * reads like a mistake. A negative is a discount and shows its own sign.
	 *
	 * @param string   $value The chosen value's label.
	 * @param int|null $minor The option's contribution, in minor units.
	 */
	private function with_price( string $value, ?int $minor ): string {
		if ( null === $minor || 0 === $minor ) {
			return $value;
		}

		$amount = Money::from_minor( $minor )->to_decimal_string();
		$signed = $minor > 0 ? '+' . $amount : $amount;

		return $value . ' (' . $signed . ')';
	}

	/**
	 * One display row, in the shape both cart worlds accept.
	 *
	 * Every value is a scalar string. `wp_kses_post` runs over the element on the
	 * block path regardless, so nothing here relies on markup surviving.
	 *
	 * @param string $name  The option's name.
	 * @param string $value The chosen value, possibly with a price.
	 * @return array<string, mixed>
	 */
	private function row( string $name, string $value ): array {
		/*
		 * 🔴 **`display` is rendered as HTML; `value` is not.**
		 *
		 * Every value here used to be a merchant-authored label from the config
		 * document, so escaping was moot. `text_field` changes that: the value is
		 * whatever a **customer typed**, and this is the first place it becomes
		 * markup.
		 *
		 * `Engine\SelectionResolver::clean_text()` already strips tags before
		 * storing — this is the second layer, at the point of output, because a
		 * value can also arrive from a reorder payload or a legacy cart row that
		 * predates that sanitising.
		 *
		 * `key` and `value` stay raw: `value` is the machine-readable half that
		 * the Store API serialises as JSON, and escaping it would show a customer
		 * `&amp;` in their own engraving.
		 */
		return array(
			'key'                => $name,
			'value'              => $value,
			'display'            => esc_html( $value ),
			self::HIDDEN_CLASSIC => false,
			self::HIDDEN_BLOCK   => false,
		);
	}

	/**
	 * A displayable string from a possibly-missing label.
	 *
	 * Arrays are joined rather than passed through: a non-scalar value makes the
	 * Store API discard the **entire row**, silently, while the classic cart
	 * renders it. That asymmetry is the single easiest way to ship a cart that
	 * looks right in testing and loses a row in production.
	 *
	 * @param mixed  $label    The label, if there is one.
	 * @param string $fallback What to show when there is not.
	 */
	private function text( $label, string $fallback ): string {
		if ( is_array( $label ) ) {
			$label = implode( ', ', array_filter( $label, 'is_scalar' ) );
		}

		if ( ! is_scalar( $label ) ) {
			return $fallback;
		}

		$text = trim( (string) $label );

		return '' !== $text ? $text : $fallback;
	}
}
