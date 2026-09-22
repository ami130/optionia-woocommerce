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
use Optionia\Support\Settings;
use Optionia\Support\BasePrice;
use Optionia\Frontend\OptionView;
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
	 * Merchant settings, for the breakdown mode (M21b.1, ADR-110).
	 *
	 * @var Settings
	 */
	private Settings $settings;

	/**
	 * Build over the configuration cache.
	 *
	 * @param Repository $config   Configuration cache.
	 * @param Settings   $settings Merchant settings.
	 */
	public function __construct( Repository $config, Settings $settings ) {
		$this->config   = $config;
		$this->settings = $settings;
	}

	/**
	 * How this storefront shows a customised line (M21b.1, ADR-110).
	 *
	 * 🔴 **A storefront preference, not an option-set one.** A product carrying
	 * two option sets must render one way, and `PublishedOptionSet` has no
	 * settings field by design — so this lives in the plugin's own settings,
	 * where `get()` already falls back for a key nobody has set.
	 *
	 * `itemised` is the default because it is the honest framing: a customer
	 * seeing *"Finish: Luxury (+10.50)"* can check the arithmetic, where a bare
	 * *"Customisation: +10.50"* asks them to trust it.
	 */
	private function itemised(): bool {
		return 'subtotal' !== $this->settings->get( Keys::SETTING_CART_BREAKDOWN, 'itemised' );
	}

	/**
	 * Register the display filter.
	 */
	public function register(): void {
		add_filter( self::HOOK, array( $this, 'item_data' ), 10, 2 );
	}

	/**
	 * Add a row per chosen option, and let an integration adjust them.
	 *
	 * 🔴 **The one supported way another plugin reaches this breakdown**
	 * (M21b.5, ADR-111). A cart drawer that renders its own markup, a theme that
	 * wants the base row elsewhere, or an integration that must relabel a row has
	 * a named filter rather than a choice between copying `SelectionResolver` and
	 * scraping the DOM.
	 *
	 * ⚠️ **Filtered HERE rather than inside the builder**, which has **five**
	 * return points — an early exit for a line with no options, no payload, no
	 * selections, and the subtotal mode's own return. A filter on one of those
	 * would silently not apply to the other four.
	 *
	 * ⚠️ **AC4 applies to a filter as much as to a document.** A callback that
	 * returns something other than a list of rows is ignored rather than
	 * trusted: a cart that renders nothing because an integration returned
	 * `null` is worse than one that ignores it, and *"anything unrecognised must
	 * degrade to correct totals with a plain breakdown, never to a wrong
	 * number."*
	 *
	 * @param mixed $item_data Rows other plugins and core have already added.
	 * @param mixed $cart_item The cart item.
	 * @return array<int, array<string, mixed>>
	 */
	public function item_data( $item_data, $cart_item = null ): array {
		$rows = $this->rows_for( $item_data, $cart_item );

		/**
		 * Filters the option rows Optionia adds to a cart line.
		 *
		 * @param array<int, array<string, mixed>> $rows      The rows, each a
		 *                                                    `key`/`value` pair
		 *                                                    with both hidden
		 *                                                    flags set.
		 * @param mixed                            $cart_item The cart item.
		 */
		$filtered = apply_filters( 'optionia_cart_item_rows', $rows, $cart_item );

		/*
		 * A callback that returned a non-list is ignored entirely. `is_array()`
		 * alone is not enough, though — see `sanitise()`, which is what makes
		 * the README's *"every value must be a scalar"* a rule the plugin
		 * enforces rather than one it asks integrations to remember.
		 */
		if ( ! is_array( $filtered ) ) {
			return $rows;
		}

		/**
		 * Filters whether Optionia renders no option rows on this cart line.
		 *
		 * 🔴 **The documented use case needed a way to say "none", and an empty
		 * array could not be it** (F20). A cart drawer that renders its own
		 * markup returns no rows — and so does a callback that crashed halfway
		 * or mistyped a variable name. `sanitise()` cannot tell those apart, so
		 * it restores the breakdown rather than let a broken integration leave
		 * a customer reading a total with nothing explaining it.
		 *
		 * ⚠️ **Suppression is therefore declared, not inferred.** Returning
		 * `true` here is a sentence an integration can only write on purpose,
		 * which is exactly the difference the empty array could not carry.
		 *
		 * @param bool  $suppressed Whether to render no option rows.
		 * @param mixed $cart_item  The cart item.
		 */
		if ( true === apply_filters( 'optionia_cart_rows_suppressed', false, $cart_item ) ) {
			/*
			 * The rows this class would have added are dropped; anything core
			 * and other plugins had already put on the line survives, because
			 * suppressing Optionia's breakdown is not licence to erase a
			 * variation attribute.
			 */
			return is_array( $item_data ) ? $item_data : array();
		}

		return $this->sanitise( $filtered, $rows );
	}

	/**
	 * Rows an integration returned, reduced to the ones both carts can render.
	 *
	 * 🔴 **`is_array()` on the return value was never the whole guard.** A
	 * callback can return a perfectly good list containing one bad row, and the
	 * bad row is the dangerous case: `CartItemSchema::get_item_data()` discards
	 * the **whole element** if any value is not scalar, with no error and no log
	 * line, while the classic cart template renders it happily.
	 *
	 * Measured before this existed: a callback appending
	 * `array( 'key' => 'Gift note', 'value' => array( 'a', 'b' ) )` produced
	 * **four rows on classic and three on blocks** — the precise divergence this
	 * class's docblock opens by describing, reintroduced through the filter that
	 * was added to prevent integrations from needing their own renderer.
	 *
	 * ⚠️ **A bad row is dropped; the rest are kept.** Discarding the callback's
	 * whole result over one malformed row would throw away correct work, and
	 * returning the unfiltered rows would silently undo an integration the
	 * merchant installed on purpose. Dropping the single row is the only
	 * outcome where every surface still agrees.
	 *
	 * ⚠️ **A row that arrived unchanged is passed through untouched.** Rewriting
	 * every row through `row()` was the first attempt and it was wrong: the
	 * classic cart hands this filter WooCommerce's **own** rows — variation
	 * attributes, and rows from other plugins — and normalising those stamped
	 * Optionia's `display` and hidden keys onto data belonging to someone else.
	 * Five existing tests caught it. Only rows the callback actually introduced
	 * or altered are rebuilt.
	 *
	 * @param array<mixed>                     $filtered What the callback returned.
	 * @param array<int, array<string, mixed>> $fallback The rows as built here.
	 * @return array<int, array<string, mixed>>
	 */
	private function sanitise( array $filtered, array $fallback ): array {
		$clean = array();

		foreach ( $filtered as $row ) {
			/*
			 * ⚠️ **Explicit, though the scalar check below would also catch a
			 * non-array.** `'not a row'['key'] ?? null` is `null` rather than a
			 * warning, so removing this line changes no behaviour — a mutation
			 * of it **survives**, and that is a property of the code, not a gap
			 * in the tests. It stays because the next reader should not have to
			 * rediscover that `??` silently swallows an illegal string offset.
			 */
			if ( ! is_array( $row ) ) {
				continue;
			}

			/*
			 * Untouched rows go straight through. `in_array()` with strict
			 * comparison is the test for "this is one of the rows we handed
			 * over", which covers both our own rows and the ones core and
			 * other plugins had already added.
			 */
			if ( in_array( $row, $fallback, true ) ) {
				$clean[] = $row;

				continue;
			}

			$key   = $row['key'] ?? null;
			$value = $row['value'] ?? null;

			/*
			 * Both halves must be scalar. `key` is the option's name and
			 * `value` what was chosen; either one non-scalar makes the Store
			 * API drop the row, so neither can be trusted from a callback.
			 */
			if ( ! is_scalar( $key ) || ! is_scalar( $value ) ) {
				continue;
			}

			$clean[] = $this->row( (string) $key, (string) $value );
		}

		/*
		 * 🔴 **A callback that produced nothing usable is ignored**, exactly as
		 * one that returned `null` is. AC4: *"anything unrecognised must degrade
		 * to correct totals with a plain breakdown, never to a wrong number"* —
		 * and a cart line showing no breakdown at all, beside a total that
		 * includes the options, is a wrong number by omission.
		 *
		 * ⚠️ **Deliberately not `array() === $clean` alone.** An integration
		 * whose honest answer is *"show no option rows on this line"* returns an
		 * empty array from a `$fallback` that was also empty — a line with no
		 * options — and that must stay empty rather than be overridden.
		 */
		if ( array() === $clean && array() !== $fallback ) {
			return $fallback;
		}

		return $clean;
	}

	/**
	 * The rows themselves, before any integration has seen them.
	 *
	 * @param mixed $item_data Rows other plugins and core have already added.
	 * @param mixed $cart_item The cart item.
	 * @return array<int, array<string, mixed>>
	 */
	private function rows_for( $item_data, $cart_item = null ): array {
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

		/*
		 * 🔴 **The base, so the breakdown adds up** (M21b.1).
		 *
		 * Without it a customer reads *"Finish: Luxury (+10.50)"* beside a line
		 * total of £110.50 and has to infer the £100 — which is the arithmetic
		 * this phase exists to stop them doing. The deltas are already resolved
		 * against this same number by `deltas_for()`, so showing it cannot
		 * disagree with what is charged.
		 *
		 * ⚠️ **Omitted when it is zero**, not printed as `0.00`: a product with
		 * no price of its own is a configuration a merchant should see as blank
		 * rather than as free.
		 */
		$base = BasePrice::minor(
			(int) ( $cart_item['product_id'] ?? 0 ),
			(int) ( $cart_item['variation_id'] ?? 0 )
		);

		if ( ! $this->itemised() ) {
			/*
			 * One "customisation" line instead of one per option (ADR-110). The
			 * sum is over the same deltas the itemised rows would print, so the
			 * two modes cannot disagree about the total.
			 */
			$total = 0;

			foreach ( $deltas as $delta ) {
				$total += (int) $delta;
			}

			if ( 0 !== $base ) {
				$rows[] = $this->row(
					__( 'Base price', 'optionia' ),
					OptionView::money( $base )
				);
			}

			/*
			 * 🔴 **"Nothing priced" and "the prices cancelled" are different
			 * facts, and only the first is silence.**
			 *
			 * ✏️ **This tested `0 !== $total` and hid both.** A `+10.50` option
			 * beside a `-10.50` discount — authorable, since *"a discount is
			 * expressed by a negative `amount_minor`"* — summed to zero and the
			 * row vanished, so the customer saw a base price and no sign that
			 * two options had priced at all. Itemised mode showed both rows, so
			 * the two modes disagreed about **visibility** while agreeing about
			 * the amount.
			 *
			 * ⚠️ **The zero rule was borrowed from `with_price()`, where it
			 * means something else.** There, a zero says *"this one choice is
			 * free"*. Summed across a line it says *"these choices cancel out"*,
			 * which is information a customer checking their total needs.
			 *
			 * `$deltas` carries an entry per **priced** option whatever its
			 * amount, so its emptiness is the honest test for "nothing priced".
			 */
			if ( array() !== $deltas ) {
				$rows[] = $this->row( __( 'Customisation', 'optionia' ), $this->signed( $total ) );
			}

			return $rows;
		}

		if ( 0 !== $base ) {
			$rows[] = $this->row(
				__( 'Base price', 'optionia' ),
				OptionView::money( $base )
			);
		}

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

		return $value . ' (' . $this->signed( $minor ) . ')';
	}

	/**
	 * A contribution with its sign, as both breakdown modes print it.
	 *
	 * ⚠️ **Shared deliberately.** The itemised rows and the single subtotal must
	 * format the same amount the same way, or a merchant switching modes sees a
	 * number change that did not.
	 *
	 * @param int $minor Minor units; negative is a discount.
	 */
	private function signed( int $minor ): string {
		/*
		 * 🔴 **Formatted the way the storefront formats**, not as a wire value.
		 *
		 * ✏️ **This printed `Money::to_decimal_string()`**, documented as
		 * *"suitable for handing back to WooCommerce"* — so a breakdown showed
		 * `10.50` beside a storefront label showing `£10.50`, and a store with
		 * comma decimals or a thousands separator saw them on one surface and
		 * not the other. `OptionView::money()` is the one answer to *"how does
		 * this store write money"*, shared rather than copied.
		 *
		 * ⚠️ **Tax is deliberately not applied here**, on any surface.
		 * `PRICING-SPEC.md`: *"the figure above is given in the store's own
		 * convention and inclusive/exclusive correctness follows. A plugin that
		 * adjusts for tax here taxes twice."*
		 */
		$amount = OptionView::money( abs( $minor ) );

		if ( 0 === $minor ) {
			/*
			 * ⚠️ **Zero is neither a surcharge nor a discount**, and reaches here
			 * only when a line's contributions cancel (F11) — `-0.00` would read
			 * as a discount of nothing. Measured: taking the absolute value
			 * without this branch produced exactly that.
			 */
			return $amount;
		}

		return $minor > 0 ? '+' . $amount : '-' . $amount;
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
}
