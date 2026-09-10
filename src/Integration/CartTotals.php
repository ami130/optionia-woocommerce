<?php
/**
 * Cart total application (M11.6).
 *
 * Applies each line's option deltas to the product WooCommerce is about to
 * price. The selections come from `cart_item_data`, written by
 * `Integration\CartItemData`; the amounts come from the cached configuration and
 * never from the request, which is what makes the cart price server-authoritative
 * (AC4) rather than merely validated once at add-to-cart.
 *
 * ## Per unit, never per line
 *
 * `WC_Cart_Totals` multiplies by quantity itself (WC 11.0.1,
 * `includes/class-wc-cart-totals.php:233`):
 *
 * ```php
 * $item->price = wc_add_number_precision_deep( (float) $cart_item['data']->get_price() * (float) $cart_item['quantity'] );
 * ```
 *
 * So this sets the **per-unit** price. Setting a line total here would multiply
 * the option deltas by quantity twice -- a quantity-3 line charging three times
 * the option price on top of an already-multiplied base. It is the
 * silent-overcharge bug of this milestone, and it is silent because quantity 1
 * looks correct: the case most manual testing uses. `bin/check-architecture.sh`
 * fails on quantity arithmetic anywhere in `src/` for this reason.
 *
 * ## Tax is WooCommerce's business
 *
 * `price_includes_tax` comes from the store setting, so the figure handed over
 * is in the store's own convention and inclusive/exclusive correctness follows.
 * A branch on tax here would tax twice.
 *
 * ## Interaction with other plugins that set line prices
 *
 * The base is memoised per line for the life of the request, so if another
 * plugin calls `set_price()` on the same line after this one, the next firing of
 * the hook re-asserts Optionia's figure and the other plugin's change is lost.
 *
 * That is a real conflict, and it is the better of the two available failures.
 * The alternative -- re-reading `get_price()` on each firing -- makes the option
 * deltas **compound**: 85.00, then 90.00, then 95.00, growing with every one of
 * the nine call sites. A lost discount is visible and arguable; a total that
 * changes depending on how many times WooCommerce recalculated is neither.
 *
 * WooCommerce's own mechanisms are unaffected, which bounds the blast radius:
 * coupons are applied by `WC_Cart_Totals` **after** this hook, and fees use
 * `woocommerce_cart_calculate_fees`. Neither goes through `set_price()`. So this
 * only bites plugin-versus-plugin `set_price()` conflicts, which are inherently
 * ambiguous -- two plugins claiming the same number -- rather than anything
 * WooCommerce defines an answer for.
 *
 * ## Why this must be idempotent
 *
 * `calculate_totals()` has **nine** call sites in WC 11.0.1 core, so the hook
 * genuinely fires several times per request. The price is therefore computed
 * from the product's **own** price each time -- read fresh, never accumulated --
 * so firing twice produces the same number as firing once.
 *
 * The base is read from the cached configuration's view of the product rather
 * than from `get_price()`, because `get_price()` may already carry a previous
 * application within the same request. That is the whole idempotence problem in
 * one sentence, and the reason a `$applied` flag would be the wrong fix: the
 * product object is rebuilt fresh on every page load, so a flag would suppress
 * the application that page loads legitimately need.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\StoreClock;
use Optionia\Config\Repository;
use Optionia\Engine\Pricing;
use Optionia\Engine\SelectionResolver;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Money;

defined( 'ABSPATH' ) || exit;

/**
 * Applies option pricing to cart lines.
 */
final class CartTotals {

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Base price per cart line, in minor units, for this request only.
	 *
	 * Keyed by cart item key. See `base_price_minor()` for why this is an object
	 * property rather than something stored on the cart item.
	 *
	 * @var array<string, int>
	 */
	private array $base_prices = array();

	/**
	 * Base weight per cart line, in grams, for this request only.
	 *
	 * 🔴 **The same problem `$base_prices` solves, and it bit here first.** The
	 * hook fires several times per request, so reading `get_weight()` fresh each
	 * time reads a weight this class has *already* added to — measured:
	 * 28 → 36 → 44 → 52 kg across four firings, while the price stayed at 85.00
	 * because it was memoised and weight was not.
	 *
	 * Keyed by cart item key, for the same reasons `base_price_minor()` gives.
	 *
	 * @var array<string, float>
	 */
	private array $base_weights = array();

	/**
	 * Build over the configuration cache.
	 *
	 * @param Repository $config Configuration cache.
	 * @param Logger     $logger Logger.
	 */
	public function __construct( Repository $config, Logger $logger ) {
		$this->config = $config;
		$this->logger = $logger;
	}

	/**
	 * Register the totals hook.
	 */
	public function register(): void {
		add_action( 'woocommerce_before_calculate_totals', array( $this, 'apply' ), 10, 1 );
	}

	/**
	 * Apply option pricing to every line that carries a selection.
	 *
	 * @param mixed $cart The cart WooCommerce is about to total.
	 */
	public function apply( $cart = null ): void {
		if ( ! is_object( $cart ) || ! method_exists( $cart, 'get_cart' ) ) {
			return;
		}

		foreach ( $cart->get_cart() as $key => $item ) {
			$this->apply_to_line( (string) $key, $item );
		}
	}

	/**
	 * Apply one line's options to its product.
	 *
	 * @param string               $key  Cart item key.
	 * @param array<string, mixed> $item Cart item.
	 */
	private function apply_to_line( string $key, array $item ): void {
		$selections = $this->selections_from( $item );

		if ( array() === $selections ) {
			return;
		}

		$product = $item['data'] ?? null;

		if ( ! is_object( $product ) || ! method_exists( $product, 'set_price' ) ) {
			return;
		}

		$product_id  = isset( $item['product_id'] ) && is_numeric( $item['product_id'] ) ? (int) $item['product_id'] : 0;
		$option_sets = $this->config->option_sets_for_product( $product_id );

		if ( array() === $option_sets ) {
			return;
		}

		$base   = $this->base_price_minor( $key, $product );
		$result = SelectionResolver::resolve( $option_sets, $selections, $base, StoreClock::today() );

		/*
		 * A selection that no longer resolves -- the merchant deleted the option
		 * after it was added to the cart -- leaves the base price untouched
		 * rather than guessing. The line is then priced as the plain product,
		 * which is wrong in the customer's favour and visible, rather than wrong
		 * silently. M12.x owns telling them about it.
		 */
		if ( ! $result->is_ok() ) {
			$this->logger->warning(
				'A cart line carries a selection that no longer resolves.',
				array(
					'product_id' => $product_id,
					'error'      => $result->first_error_code(),
				)
			);

			return;
		}

		$this->warn_about_unpriced_types( $product_id, $result->value()['unpriced'] ?? array() );

		/*
		 * Resolution ran, and had to: it is what proves the options still exist,
		 * still belong to this product, and are still valid choices. That is
		 * M12.4's "option deleted" policy, and it is deliberately *not* frozen --
		 * freezing validity would sell phantom products.
		 *
		 * Only the **price** is frozen. The customer was quoted a number; a
		 * publish between add-to-cart and checkout must not change it under them.
		 */
		$frozen = $this->frozen_total( $item, $selections, $base );

		// `$frozen ?? live` is an equivalent form -- both branch on null only, and
		// a frozen total of 0 (a fully discounted line) passes through either way.
		$total = null === $frozen ? $result->value()['total_minor'] : $frozen;

		$product->set_price( Money::from_minor( $total )->to_decimal_string() );

		$this->apply_weight( $key, $product, (int) ( $result->value()['weight_delta_grams'] ?? 0 ) );
	}

	/**
	 * Add a selection's weight to the line, in the store's own unit (M16.8).
	 *
	 * 🔴 **Shipping is quoted on weight, so a missing gram is the merchant's
	 * money.** A "Heavy oak" option adding eight kilos that nothing applies means
	 * WooCommerce quotes the carrier rate for the base product, and the merchant
	 * absorbs the difference — with no error anywhere, because nothing failed.
	 * The field has been in the published document since Phase 5 and read by
	 * nothing until now.
	 *
	 * ⚠️ **The unit conversion is not optional.** The document carries **grams**;
	 * `WC_Product::get_weight()` answers in the store's configured unit, which on
	 * this development store is `kg`. Adding 8000 to a kilogram weight would make
	 * an eight-kilo option weigh eight *tonnes*.
	 *
	 * 🔴 **The total is converted, never the delta.** Measured:
	 * `wc_get_weight( -2000, 'kg', 'g' )` returns **0**, because that function
	 * clamps a negative result — so converting a flat-pack option's −2000g on its
	 * own would silently discard it. Summing in grams first and converting once
	 * keeps a reducing option working, and still lands on 0 if the line as a whole
	 * would go negative.
	 *
	 * ⚠️ **Per unit.** `WC_Cart::get_cart_contents_weight()` multiplies by
	 * quantity itself, exactly as `WC_Cart_Totals` does for price.
	 *
	 * 🔴 **Idempotent, because the hook fires nine times.** The base weight is
	 * memoised per line exactly as the base price is: reading `get_weight()`
	 * fresh on each firing reads a weight this method has already added to, and
	 * the delta **compounds**. Measured before the memo existed: 28 → 36 → 44 →
	 * 52 kg across four firings of one 20 kg line, and a *reducing* option decayed
	 * the other way until the product shipped as weightless. That is the failure
	 * this class's own docblock warns about for price — *"a total that changes
	 * depending on how many times WooCommerce recalculated"* — and a `$applied`
	 * flag is the wrong fix for the same reason there: the hook legitimately
	 * re-runs when a quantity changes.
	 *
	 * @param string $key     Cart item key, for the per-request memo.
	 * @param object $product The cart line's product object.
	 * @param int    $grams   Grams this selection adds, possibly negative.
	 */
	private function apply_weight( string $key, object $product, int $grams ): void {
		if ( 0 === $grams ) {
			return;
		}

		if ( ! method_exists( $product, 'set_weight' ) || ! method_exists( $product, 'get_weight' ) ) {
			return;
		}

		if ( ! function_exists( 'wc_get_weight' ) || ! function_exists( 'get_option' ) ) {
			return;
		}

		$unit = (string) get_option( 'woocommerce_weight_unit', 'kg' );
		$unit = '' === $unit ? 'kg' : $unit;

		/*
		 * An empty weight is "not set", not "weighs nothing" — but a line whose
		 * product has no weight and whose option adds some genuinely does weigh
		 * that much, so the base is treated as zero rather than skipped.
		 *
		 * ⚠️ **The floats below are grams, not money.** `Principle 5` forbids
		 * float money and matches on money-shaped identifiers, so these are named
		 * for what they weigh — `$line_grams`, not `$total` — rather than
		 * exempted. A weight is a measurement WooCommerce itself stores as a
		 * float, and calling it a total would be both wrong and a gate failure.
		 */
		if ( ! isset( $this->base_weights[ $key ] ) ) {
			$this->base_weights[ $key ] = wc_get_weight( (float) $product->get_weight(), 'g', $unit );
		}

		$line_grams = $this->base_weights[ $key ] + (float) $grams;

		$product->set_weight( (string) wc_get_weight( max( 0.0, $line_grams ), $unit, 'g' ) );
	}

	/**
	 * The line total from the price this customer was quoted, if there is one.
	 *
	 * Returns `null` when the line carries no usable frozen payload, and the
	 * caller then prices from current configuration -- which is exactly what
	 * Phase 11 shipped, so the fallback is a known-safe state rather than an
	 * unknown one.
	 *
	 * ## Why the frozen deltas are filtered by the live selections
	 *
	 * The stored deltas are keyed by option id, and resolution has just proved
	 * which options are still real. Taking the intersection means a *deleted*
	 * option cannot keep contributing its old price from the frozen payload --
	 * resolution would have failed first in that case, but relying on that
	 * ordering would make this method wrong if the order ever changed.
	 *
	 * ## Why the base price is not frozen
	 *
	 * Only the option deltas are. WooCommerce follows a product's **live** base
	 * price in an existing cart -- verified in Phase 4, and true of plain
	 * WooCommerce with no plugin installed -- so freezing the base here would
	 * make Optionia's carts behave differently from every other cart in the
	 * store. The asymmetry is inherited from the platform; the deliberate choice
	 * is only about our half of it.
	 *
	 * @param array<string, mixed>  $item       The cart item.
	 * @param array<string, string> $selections The line's live, resolved selections.
	 * @param int                   $base_minor The product's current base price.
	 * @return int|null The frozen line total, or null to price from current config.
	 */
	private function frozen_total( array $item, array $selections, int $base_minor ): ?int {
		$frozen = CartItemPayload::trusted_deltas( $item, $selections );

		if ( null === $frozen ) {
			return null;
		}

		try {
			return Pricing::sum_deltas( $base_minor, array_values( $frozen ) );
		} catch ( \InvalidArgumentException | \RangeException $e ) {
			unset( $e );

			return null;
		}
	}

	/**
	 * The line's base price in minor units, stable across repeated firings.
	 *
	 * Remembered **in memory on this object**, never in `cart_item_data`.
	 *
	 * The first implementation stored it on the cart item, and that was
	 * exploitable: a `cart_item_data` carrying `base_price_minor => 1` priced an
	 * 80.00 product at 5.01 instead of 85.00, with `is_int()` the only check in
	 * front of it. It was not reachable from a browser -- `CartItemData` builds
	 * the payload from resolved selections and never copies request data into it
	 * -- but `woocommerce_add_cart_item_data` is a public filter, so "no current
	 * plugin does this" is a fact about today's plugin list rather than a
	 * property of the code. A price that any other plugin can set is not
	 * server-authoritative, which is the whole of AC4.
	 *
	 * An object property is the right lifetime for it. The problem it solves is
	 * that `calculate_totals()` fires several times **within one request** and
	 * `get_price()` is no longer the base after the first application. That is
	 * exactly a per-request concern: this object does not outlive the request,
	 * the product is rebuilt fresh on the next page load, and nothing an attacker
	 * can write reaches it.
	 *
	 * @param string $key     Cart item key.
	 * @param object $product The line's product.
	 * @return int Base price in minor units.
	 */
	private function base_price_minor( string $key, object $product ): int {
		if ( isset( $this->base_prices[ $key ] ) ) {
			return $this->base_prices[ $key ];
		}

		$money = method_exists( $product, 'get_price' ) ? Money::try_from_decimal( $product->get_price() ) : null;
		$base  = null === $money ? 0 : $money->minor();

		$this->base_prices[ $key ] = $base;

		return $base;
	}

	/**
	 * Warn when a line carries an option this phase cannot price.
	 *
	 * The cloud's schema publishes five price types and this build implements the
	 * subset in `Engine\SelectionResolver::PRICED_TYPES`, so the rest contribute
	 * zero. That is the correct arithmetic here -- guessing would be worse,
	 * and refusing would take a storefront down on a bad publish -- but zero is
	 * indistinguishable from a free option, and the merchant is undercharging.
	 *
	 * Measured before this existed: a 50% surcharge on an 80.00 product charged
	 * 80.00, losing 40.00 a unit, and nothing anywhere said so.
	 *
	 * Logged at **warning**, once per line per firing. Not `error`, because the
	 * storefront is working as designed; not `info`, because money is wrong.
	 * `Support\Logger` is debug-gated, so a merchant who has not enabled logging
	 * sees nothing -- which is why M16.x also owns telling them in the admin.
	 *
	 * @param int           $product_id The line's product.
	 * @param array<string> $unpriced   Price types that contributed nothing.
	 */
	private function warn_about_unpriced_types( int $product_id, array $unpriced ): void {
		if ( array() === $unpriced ) {
			return;
		}

		$this->logger->warning(
			'A cart line carries options this version cannot price; they contributed nothing.',
			array(
				'product_id'     => $product_id,
				'price_types'    => $unpriced,
				'implemented'    => SelectionResolver::PRICED_TYPES,
				'undercharge_at' => 'woocommerce_before_calculate_totals',
			)
		);
	}

	/**
	 * A cart item's stored selections, if it has any.
	 *
	 * @param array<string, mixed> $item Cart item.
	 * @return array<string, mixed>
	 */
	private function selections_from( array $item ): array {
		$stored = $item[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ] ?? null;

		return is_array( $stored ) ? $stored : array();
	}

	/**
	 * The per-unit price a line should carry, for verification.
	 *
	 * Deliberately not used by `apply()` -- it exists so a test can state the
	 * expected number independently of the code path that produces it.
	 *
	 * @param int        $base_minor Base price in minor units.
	 * @param array<int> $deltas     Option deltas in minor units.
	 * @return int Per-unit total in minor units.
	 */
	public static function expected_unit_minor( int $base_minor, array $deltas ): int {
		return Pricing::sum_deltas( $base_minor, $deltas );
	}
}
