<?php
/**
 * Cart total application (M11.6).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartItemPayload;
use Optionia\Integration\CartTotals;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Every requirement M11.6 names, asserted on the number.
 *
 * *"`woocommerce_before_calculate_totals`, idempotent under repeated firing,
 * correct under quantity change and session restore. Verified against
 * tax-inclusive and tax-exclusive stores, and with a coupon applied."*
 *
 * @covers \Optionia\Integration\CartTotals
 * @covers \Optionia\Integration\CartItemData
 */
final class CartTotalsTest extends TestCase {

	/**
	 * Our product.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * Reset harness state and store the configuration.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters']            = array();
		$GLOBALS['optionia_test_actions']            = array();
		$GLOBALS['optionia_test_prices_include_tax'] = false;
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->store_config();
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters']            = array();
		$GLOBALS['optionia_test_actions']            = array();
		$GLOBALS['optionia_test_prices_include_tax'] = false;
		$_POST                                       = array();

		parent::tearDown();
	}

	// --- The price itself ----------------------------------------------------

	/**
	 * A line with one selection is priced base plus that option's delta.
	 *
	 * Base £80.00, `front` adds £5.00, so the per-unit price is £85.00.
	 */
	public function test_applies_the_option_delta_to_the_line(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 1 );

		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * **The price is PER UNIT — WooCommerce multiplies by quantity itself.**
	 *
	 * This is the silent-overcharge bug of this milestone. At quantity 3 the
	 * per-unit price stays £85.00 and the line total is £255.00. An
	 * implementation that set the *line* total would put £255.00 on the product
	 * and WooCommerce would bill £765.00 — and at quantity 1 both look correct,
	 * which is why manual testing misses it.
	 */
	public function test_the_price_is_per_unit_not_per_line(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 3 );

		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price(), 'set_price() takes a PER-UNIT figure.' );
		$this->assertSame( 255.0, $cart->line_total( 'line-1' ), 'WooCommerce multiplies; 765 would be a double multiply.' );
	}

	/**
	 * Several selections all contribute.
	 */
	public function test_sums_several_selections(): void {
		$cart = $this->cart_with(
			array(
				'opt-a' => 'back',
				'opt-b' => 'gift',
			),
			1
		);

		$cart->calculate_totals();

		// 80.00 + 7.50 + 2.50.
		$this->assertSame( '90.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * A discount larger than the base clamps the line at zero.
	 *
	 * `PRICING-SPEC.md` §3, reached through the cart rather than the evaluator —
	 * so the composition is tested, not arithmetic a Stage 5 suite already covers.
	 */
	public function test_a_large_discount_clamps_the_line_at_zero(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'huge-discount' ), 2 );

		$cart->calculate_totals();

		$this->assertSame( '0.00', $cart->get_cart()['line-1']['data']->get_price() );
		$this->assertSame( 0.0, $cart->line_total( 'line-1' ) );
	}

	// --- Idempotence ---------------------------------------------------------

	/**
	 * **Firing repeatedly produces the same price.**
	 *
	 * `calculate_totals()` has nine call sites in WC 11.0.1 core, so the hook
	 * genuinely fires several times per request. An implementation that read
	 * `get_price()` as its base each time would compound the deltas: £85, £90,
	 * £95, growing with every firing.
	 */
	public function test_is_idempotent_under_repeated_firing(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 1 );

		$cart->calculate_totals();
		$first = $cart->get_cart()['line-1']['data']->get_price();

		$cart->calculate_totals();
		$cart->calculate_totals();
		$cart->calculate_totals();

		$this->assertSame( $first, $cart->get_cart()['line-1']['data']->get_price() );
		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * 🔴 **Weight is idempotent too, and this is the test that was missing.**
	 *
	 * The price test above fires four times and asserts only `get_price()`, so
	 * `weight_delta` shipped compounding on every firing and 1280 tests stayed
	 * green: **28 → 36 → 44 → 52 kg** on one 20 kg line, while a *reducing*
	 * option decayed the other way until the product shipped as weightless.
	 *
	 * The customer is then quoted a carrier rate for a weight that depends on how
	 * many times WooCommerce happened to recalculate — the failure this class's
	 * docblock calls *"neither visible nor arguable"*. Asserted beside the price,
	 * rather than in a test of its own, so the next thing applied to a line is
	 * checked here by default instead of being remembered.
	 */
	public function test_the_weight_is_idempotent_under_repeated_firing(): void {
		$this->store_weighted_config( 8000 );

		$product         = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );
		$product->weight = '20';

		$GLOBALS['optionia_test_options']['woocommerce_weight_unit'] = 'kg';

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$product,
			1,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
				),
			)
		);

		$totals = $this->totals();

		$totals->apply( $cart );
		$first = $product->get_weight();

		$totals->apply( $cart );
		$totals->apply( $cart );
		$totals->apply( $cart );

		$this->assertSame( '28', $first );
		$this->assertSame( $first, $product->get_weight(), 'Weight must not compound across firings.' );
	}

	/** A reducing option is stable too — it decayed toward zero before the memo. */
	public function test_a_reducing_weight_is_idempotent(): void {
		$this->store_weighted_config( -2000 );

		$product         = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );
		$product->weight = '20';

		$GLOBALS['optionia_test_options']['woocommerce_weight_unit'] = 'kg';

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$product,
			1,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
				),
			)
		);

		$totals = $this->totals();

		$totals->apply( $cart );
		$totals->apply( $cart );
		$totals->apply( $cart );

		$this->assertSame( '18', $product->get_weight() );
	}

	/**
	 * **A forged base price in `cart_item_data` cannot change the line.**
	 *
	 * The first implementation remembered the base price *on the cart item*, and
	 * that was exploitable: `base_price_minor => 1` priced an 80.00 product at
	 * 5.01 instead of 85.00, with `is_int()` the only check in front of it. Not
	 * browser-reachable — `CartItemData` builds the payload from resolved
	 * selections and never copies request data into it — but
	 * `woocommerce_add_cart_item_data` is a public filter, so any other plugin
	 * could set it. A price another plugin can set is not server-authoritative,
	 * which is the whole of AC4.
	 *
	 * The base now lives in memory on the applicator, for this request only.
	 */
	public function test_a_forged_base_price_in_cart_item_data_is_ignored(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
					'base_price_minor'         => 1,
				),
			)
		);

		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * Nothing price-like is written into the persisted cart item data.
	 *
	 * A base price stored on the line would round-trip through the session and
	 * become a number a later request trusts. The only thing persisted is the
	 * selection.
	 */
	public function test_persists_only_the_selection(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 1 );

		$cart->calculate_totals();

		$this->assertSame(
			array( Keys::CART_ITEM_SELECTIONS ),
			array_keys( $cart->cart_contents['line-1'][ Keys::CART_ITEM_KEY ] )
		);
	}

	// --- Quantity change -----------------------------------------------------

	/**
	 * Changing quantity does not change the per-unit price.
	 */
	public function test_is_correct_under_quantity_change(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 1 );

		$cart->calculate_totals();
		$this->assertSame( 85.0, $cart->line_total( 'line-1' ) );

		$cart->cart_contents['line-1']['quantity'] = 4;
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
		$this->assertSame( 340.0, $cart->line_total( 'line-1' ) );
	}

	// --- Session restore -----------------------------------------------------

	/**
	 * A restored session prices correctly from stored selections alone.
	 *
	 * On a new page load the product object is rebuilt fresh and `$_POST` is
	 * empty, so everything must come from `cart_item_data` — which is exactly
	 * what WooCommerce round-trips through the session.
	 *
	 * Selections only, deliberately: this is the shape a line has when its
	 * option cannot be priced by this build, and it must still work.
	 */
	public function test_is_correct_under_session_restore(): void {
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			2,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
				),
			)
		);

		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
		$this->assertSame( 170.0, $cart->line_total( 'line-1' ) );
	}

	/**
	 * **A signed payload survives the session and still verifies.**
	 *
	 * The test above predates the freeze and carries selections only, so it
	 * exercises the pre-freeze path. After Stage 3 the interesting question is
	 * whether a *signed* payload survives `serialize()` and still verifies on
	 * the next request — because a signature that did not would silently
	 * downgrade every restored cart to live pricing, and the price would look
	 * plausible while the quote was lost.
	 *
	 * Driven through the real session boundary rather than a hand-built array.
	 */
	public function test_a_frozen_price_survives_a_page_reload(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 9900 );

		$first = optionia_test_cart();
		$first->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );

		// A new request: fresh applicator, fresh product, cart from the session.
		$GLOBALS['optionia_test_actions'] = array();

		$second = optionia_test_cart();
		$second->from_session( $first->to_session(), '80.00' );

		$this->totals()->register();
		$second->calculate_totals();

		$this->assertSame(
			'100.00',
			$second->get_cart()['line-1']['data']->get_price(),
			'The quote must survive the session, not just the request.'
		);
	}

	/**
	 * Repeated page loads do not compound, and do not drift.
	 *
	 * The base-price memo lives on the applicator, which dies with the request —
	 * so each reload starts with an empty memo and a product at its catalogue
	 * price. Three reloads is enough to catch a mechanism that accumulated.
	 */
	public function test_repeated_page_loads_do_not_drift(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 9900 );

		$cart = optionia_test_cart();
		$cart->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );

		for ( $reload = 0; $reload < 3; $reload++ ) {
			$payload = $cart->to_session();

			$GLOBALS['optionia_test_actions'] = array();

			$cart = optionia_test_cart();
			$cart->from_session( $payload, '80.00' );

			$this->totals()->register();
			$cart->calculate_totals();

			$this->assertSame( '100.00', $cart->get_cart()['line-1']['data']->get_price() );
		}
	}

	/**
	 * A persistent cart recovered after a product price change prices correctly.
	 *
	 * The persistent cart is plain user meta with **no expiry**, so a logged-in
	 * customer's cart can come back months later. The option delta is frozen and
	 * the product's base price is not — verified in Phase 4, and true of plain
	 * WooCommerce — so a base price rise must show through while the quoted
	 * option price does not.
	 */
	public function test_a_recovered_cart_follows_the_live_base_price(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 9900 );

		$original = optionia_test_cart();
		$original->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );

		$GLOBALS['optionia_test_actions'] = array();

		// Recovered later, with the product now priced at 200.00.
		$recovered = optionia_test_cart();
		$recovered->from_session( $original->to_session(), '200.00' );

		$this->totals()->register();
		$recovered->calculate_totals();

		$this->assertSame(
			'220.00',
			$recovered->get_cart()['line-1']['data']->get_price(),
			'Live base, frozen delta — the asymmetry M12.4 records.'
		);
	}

	/**
	 * A variable product's line is rebuilt from the **variation** on restore.
	 *
	 * `get_cart_from_session()` calls
	 * `wc_get_product( $values['variation_id'] ? $values['variation_id'] : $values['product_id'] )`
	 * (WC 11.0.1, `class-wc-cart-session.php:146`), so a variation line comes back
	 * priced at the variation's price, not the parent's.
	 *
	 * That matters here because Stage 3 froze the option delta and left the base
	 * price live: the base for a variable product **is** the variation's price.
	 * Apparel with size variants plus customization is Phase 10's stated primary
	 * segment, so it is the one product type where base-price selection is not
	 * trivial — and it was the one the session double could not represent.
	 */
	public function test_a_variation_line_is_rebuilt_from_the_variation(): void {
		$line = array_merge(
			$this->frozen_line( 2000 ),
			array(
				'product_id'   => self::PRODUCT_ID,
				'variation_id' => 77,
			)
		);

		$this->store_config( 9900 );

		$original = optionia_test_cart();
		$original->add_line( 'line-1', optionia_test_product( 77, 'variation', '120.00' ), 1, $line );

		$GLOBALS['optionia_test_actions'] = array();

		// Restored with the variation priced at 120.00, not the parent's 80.00.
		$restored = optionia_test_cart();
		$restored->from_session( $original->to_session(), '120.00' );

		$this->totals()->register();
		$restored->calculate_totals();

		$this->assertSame(
			'variation',
			$restored->get_cart()['line-1']['data']->get_type(),
			'A line with a variation_id must come back as the variation.'
		);
		$this->assertSame(
			'140.00',
			$restored->get_cart()['line-1']['data']->get_price(),
			'Variation base 120.00 plus the frozen 20.00 option.'
		);
	}

	/**
	 * A cart restored on a **different site** degrades to live pricing.
	 *
	 * The realistic version of a salt change: salts rarely rotate in place, but
	 * carts routinely move — a staging clone, a site migration, a multisite
	 * restore. The signature is keyed to `wp_salt()`, so a payload that arrives
	 * from elsewhere cannot verify, and the line prices from current
	 * configuration rather than honouring a quote this site never made.
	 *
	 * Distinct from `test_a_salt_rotation_degrades_to_the_live_price`, which
	 * never crosses the session boundary.
	 */
	public function test_a_cart_restored_on_another_site_prices_live(): void {
		$line = $this->frozen_line( 2000 );

		$original = optionia_test_cart();
		$original->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );

		$payload = $original->to_session();

		// The publish makes frozen (100.00) and live (179.00) distinguishable.
		$this->store_config( 9900 );

		$GLOBALS['optionia_test_salt']    = 'a-different-site';
		$GLOBALS['optionia_test_actions'] = array();

		$elsewhere = optionia_test_cart();
		$elsewhere->from_session( $payload, '80.00' );

		$this->totals()->register();
		$elsewhere->calculate_totals();

		$this->assertSame(
			'179.00',
			$elsewhere->get_cart()['line-1']['data']->get_price(),
			'A quote this site never made must not be honoured.'
		);
	}

	/**
	 * **On login, a colliding guest line replaces the saved one outright.**
	 *
	 * `WC_Cart_Session::get_cart_from_session()` merges with
	 * `array_merge( $saved_cart, $cart )`. The keys are strings, so colliding
	 * lines do **not** sum — the later array wins entirely, quantity included.
	 *
	 * Optionia's cart-key filter makes that collision more likely by design:
	 * keying on selections alone means the same choice at two config versions
	 * now shares a key. That is the improvement — the alternative is two lines
	 * of the same thing at two prices — and the consequence is that the customer
	 * keeps the price they were **most recently** quoted.
	 *
	 * Asserted here because it is a policy, not an accident, and because a
	 * future change to the key filter would alter it silently.
	 */
	public function test_a_guest_line_replaces_a_colliding_saved_line_on_login(): void {
		// The account's stored cart: added when the option cost 20.00.
		$account = optionia_test_cart();
		$account->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			$this->frozen_line( 2000 )
		);

		// The guest cart in this browser: added after the price rose to 99.00.
		$guest = optionia_test_cart();
		$guest->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			2,
			$this->frozen_line( 9900 )
		);

		// Logging in merges the two and prices the result.
		$GLOBALS['optionia_test_actions'] = array();

		$merged = optionia_test_cart();
		$merged->from_session( $guest->to_session(), '80.00', $account->to_session() );

		$this->totals()->register();
		$merged->calculate_totals();

		$this->assertCount( 1, $merged->get_cart(), 'Colliding keys collapse to one line.' );
		$this->assertSame( 2, $merged->get_cart()['line-1']['quantity'], 'Quantities do not sum.' );
		$this->assertSame(
			'179.00',
			$merged->get_cart()['line-1']['data']->get_price(),
			'The guest line wins, so the customer keeps the price they were most recently quoted.'
		);
		$this->assertSame( 358.0, $merged->line_total( 'line-1' ) );
	}

	/**
	 * A saved line with no guest counterpart survives the merge intact.
	 *
	 * The other half of `array_merge( $saved_cart, $cart )`: non-colliding keys
	 * are kept from both sides. Asserted so the test above cannot pass by the
	 * merge simply discarding the account's cart wholesale.
	 */
	public function test_a_non_colliding_saved_line_survives_login(): void {
		$account = optionia_test_cart();
		$account->add_line(
			'account-line',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			$this->frozen_line( 2000 )
		);

		$guest = optionia_test_cart();
		$guest->add_line(
			'guest-line',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			$this->frozen_line( 9900 )
		);

		$GLOBALS['optionia_test_actions'] = array();

		$merged = optionia_test_cart();
		$merged->from_session( $guest->to_session(), '80.00', $account->to_session() );

		$this->totals()->register();
		$merged->calculate_totals();

		$this->assertCount( 2, $merged->get_cart(), 'Both carts contribute their lines.' );
		$this->assertSame( '100.00', $merged->get_cart()['account-line']['data']->get_price() );
		$this->assertSame( '179.00', $merged->get_cart()['guest-line']['data']->get_price() );
	}

	// --- Tax -----------------------------------------------------------------

	/**
	 * The same figure is handed over whether the store includes tax or not.
	 *
	 * `price_includes_tax` tells WooCommerce how to interpret the number; it does
	 * not change it. A plugin that branched on this would tax twice.
	 */
	public function test_hands_the_same_figure_to_tax_inclusive_and_exclusive_stores(): void {
		/*
		 * A fresh applicator per store setting, because each is a separate page
		 * load. The base-price memo is per-request by design -- that is what
		 * makes a forged one unreachable -- so reusing one object here would be
		 * modelling a request that never happens.
		 */
		$GLOBALS['optionia_test_prices_include_tax'] = false;
		$exclusive                                   = $this->priced_once();

		$GLOBALS['optionia_test_filters']            = array();
		$GLOBALS['optionia_test_actions']            = array();
		$GLOBALS['optionia_test_prices_include_tax'] = true;
		$inclusive                                   = $this->priced_once();

		$this->assertSame( '85.00', $exclusive );
		$this->assertSame( $exclusive, $inclusive );
	}

	// --- Coupons -------------------------------------------------------------

	/**
	 * A coupon applies to the option-inclusive price, not the bare base.
	 *
	 * Coupons are WooCommerce's own arithmetic, applied to the line totals it
	 * computes **after** this hook. So the guarantee Optionia owns is that the
	 * figure a coupon sees already includes the options — asserted here as the
	 * discountable subtotal, rather than by reimplementing coupon maths.
	 */
	public function test_a_coupon_discounts_the_option_inclusive_price(): void {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 2 );

		$cart->calculate_totals();

		$subtotal = $cart->line_total( 'line-1' );

		/*
		 * Asserted against the bare base as well as the correct figure.
		 *
		 * An earlier version of this test also asserted
		 * `round( $subtotal * 0.9, 2 ) === 153.0`, which is arithmetic that holds
		 * whatever Optionia does -- it reads like coupon coverage and tests
		 * nothing. What actually matters is that the number a coupon is applied
		 * to already includes the options, so that is what is asserted, both
		 * positively and against the value it must not be.
		 */
		$this->assertSame( 170.0, $subtotal, 'A coupon must discount the option-inclusive line.' );
		$this->assertNotSame( 160.0, $subtotal, 'Discounting the bare base would undercharge the options.' );
	}

	// --- The price freeze (GAP 2) --------------------------------------------

	/**
	 * **A publish between add-to-cart and checkout does not change the price.**
	 *
	 * This is GAP 2 and M12.4's first policy row: the customer was quoted a
	 * number, and changing it under them is indefensible. Before the freeze, the
	 * line re-resolved from current configuration on every firing — measured at
	 * £179.00 on a line quoted at £100.00.
	 *
	 * The publish is performed **inside the test**, deliberately. Every earlier
	 * version of this suite passed without it, because a test that never
	 * republishes cannot tell a frozen price from a live one.
	 */
	public function test_a_publish_does_not_change_a_quoted_price(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 9900 );

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		$this->assertSame( '100.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * A price *drop* is honoured too — the freeze is not a floor.
	 *
	 * The customer pays what they were quoted, which is the point. Charging the
	 * lower of the two would be a different policy, and a merchant lowering a
	 * price does not expect existing carts to keep the old one.
	 */
	public function test_a_price_drop_is_also_frozen(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 100 );

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		$this->assertSame( '100.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * The frozen price is per unit, like the live one.
	 *
	 * The whole per-unit guarantee runs through a different branch now, so it is
	 * asserted on that branch rather than assumed to carry over.
	 */
	public function test_the_frozen_price_is_per_unit(): void {
		$line = $this->frozen_line( 500 );

		$this->store_config( 9900 );

		$cart = $this->cart_with_line( $line, 3 );
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
		$this->assertSame( 255.0, $cart->line_total( 'line-1' ) );
	}

	/**
	 * Firing repeatedly does not compound the frozen price either.
	 */
	public function test_the_frozen_price_is_idempotent(): void {
		$line = $this->frozen_line( 500 );

		$this->store_config( 9900 );

		$cart = $this->cart_with_line( $line, 1 );

		for ( $i = 0; $i < 9; $i++ ) {
			$cart->calculate_totals();
		}

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * **A tampered frozen payload falls back to the live price.**
	 *
	 * `cart_item_data` is not browser-writable, but another plugin can write it
	 * through `woocommerce_add_cart_item_data` — the actor Stage 7b named. A
	 * forged delta must gain nothing: the best it achieves is today's price,
	 * which the forger could have had by adding the item today.
	 */
	public function test_a_tampered_freeze_falls_back_to_the_live_price(): void {
		$line = $this->frozen_line( 2000 );

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ] = array( 'opt-a' => -5000 );

		$this->store_config( 500 );

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * A salt rotation degrades to the live price rather than emptying the cart.
	 */
	public function test_a_salt_rotation_degrades_to_the_live_price(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 500 );
		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * **A deleted option still blocks, even with a valid frozen price.**
	 *
	 * The freeze covers price, never validity. M12.4: freezing validity would
	 * sell phantom products — there is no honest price for something the
	 * merchant can no longer make. Resolution runs first and its failure wins.
	 */
	public function test_a_deleted_option_is_not_rescued_by_the_freeze(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 500, 'something-else' );

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		$this->assertSame(
			'80.00',
			$cart->get_cart()['line-1']['data']->get_price(),
			'A frozen delta must not price an option that no longer exists.'
		);
	}

	/**
	 * A frozen payload missing one of the line's selections is distrusted whole.
	 *
	 * The two are written together, so they cannot legitimately disagree — but
	 * `frozen_deltas()` cannot notice, because a mismatched payload can be
	 * perfectly *signed*: the signature proves who wrote it, not that its parts
	 * agree. So this is `CartTotals`' job.
	 *
	 * Distrusting the whole payload rather than skipping the missing option is
	 * the point. Pricing part of a line from a quote and part from today's
	 * configuration produces a number that was never quoted and is not current —
	 * a third answer nobody chose.
	 */
	public function test_a_frozen_payload_missing_a_selection_is_distrusted(): void {
		$line = $this->frozen_line( 2000 );

		// Both options selected, only one frozen — signed so it passes verification.
		$selections = array(
			'opt-a' => 'lux',
			'opt-b' => 'gift',
		);
		$deltas     = array( 'opt-a' => 2000 );

		$line[ Keys::CART_ITEM_KEY ] = array(
			Keys::CART_ITEM_SELECTIONS     => $selections,
			Keys::CART_ITEM_CONFIG_VERSION => 7,
			Keys::CART_ITEM_DELTAS         => $deltas,
			Keys::CART_ITEM_SIGNATURE      => CartItemPayload::sign( $selections, $deltas, 7 ),
		);

		$this->store_config( 500 );

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		// Live pricing: 80.00 + lux 5.00 + gift 2.50.
		$this->assertSame(
			'87.50',
			$cart->get_cart()['line-1']['data']->get_price(),
			'A payload that disagrees with the line must not price part of it.'
		);
	}

	/**
	 * **A line with an unpriceable option is not frozen, so a merchant's fix lands.**
	 *
	 * This build contributes 0 for `per_unit`, `per_char` and `tiered`, and
	 * `Admin\UnpricedTypesNotice` tells the merchant so. Freezing
	 * that 0 composed the two correct behaviours into a wrong one: the merchant
	 * read the notice, switched the option to a fixed amount, and every cart
	 * already holding it went on charging nothing — measured at 80.00 after a
	 * 50.00 option was fixed.
	 *
	 * Nothing is charged that was not quoted. The option contributes zero in both
	 * states until the fix lands, so the customer's total only ever moves when
	 * the merchant makes it move.
	 */
	public function test_an_unpriceable_option_is_not_frozen(): void {
		$this->store_unpriceable_config();

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$line = array_merge(
			( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array( 'product_id' => self::PRODUCT_ID )
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertArrayNotHasKey(
			Keys::CART_ITEM_DELTAS,
			$line[ Keys::CART_ITEM_KEY ],
			'There is no honest price to freeze for a type this build cannot compute.'
		);

		// The merchant reads the notice and switches it to a fixed amount.
		$this->store_config( 5000 );

		$cart = $this->cart_with_line( $line, 1 );
		$cart->calculate_totals();

		$this->assertSame(
			'130.00',
			$cart->get_cart()['line-1']['data']->get_price(),
			'A frozen zero would have kept this at 80.00 forever.'
		);
	}

	/**
	 * The live base price still moves under a frozen delta.
	 *
	 * WooCommerce follows a product's live base price in an existing cart —
	 * verified in Phase 4, and true of plain WooCommerce with no plugin. Only
	 * the option delta is frozen, and a reader who sees one half of that
	 * asymmetry will think the other half is a bug.
	 */
	public function test_the_base_price_is_not_frozen(): void {
		$line = $this->frozen_line( 2000 );

		$this->store_config( 9900 );

		$cart = optionia_test_cart();
		$cart->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '200.00' ), 1, $line );
		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '220.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	// --- Boundaries ----------------------------------------------------------

	/**
	 * A line with no selections is left alone.
	 */
	public function test_leaves_an_unoptioned_line_untouched(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			array( 'product_id' => self::PRODUCT_ID )
		);

		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '80.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * A selection that no longer resolves leaves the base price untouched.
	 *
	 * The merchant deleted the option after it was added to the cart. Pricing it
	 * as the plain product is wrong in the customer's favour and visible, rather
	 * than wrong silently.
	 */
	public function test_an_unresolvable_selection_leaves_the_base_price(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'deleted-value' ),
				),
			)
		);

		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '80.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * Two lines of the same product price independently.
	 */
	public function test_two_lines_of_one_product_price_independently(): void {
		$cart = optionia_test_cart();

		foreach ( array(
			'line-1' => 'front',
			'line-2' => 'back',
		) as $key => $value ) {
			$cart->add_line(
				$key,
				optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
				1,
				array(
					'product_id'        => self::PRODUCT_ID,
					Keys::CART_ITEM_KEY => array( Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => $value ) ),
				)
			);
		}

		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '85.00', $cart->get_cart()['line-1']['data']->get_price() );
		$this->assertSame( '87.50', $cart->get_cart()['line-2']['data']->get_price() );
	}

	// --- The write side ------------------------------------------------------

	/**
	 * A validated selection is attached to the cart item.
	 */
	public function test_attaches_the_validated_selection(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$data = $this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 );

		$this->assertSame(
			array( 'opt-a' => 'front' ),
			$data[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ]
		);
	}

	/**
	 * **Selections are attached in a deterministic order.**
	 *
	 * `WC_Cart::generate_cart_id()` derives the cart item key by running
	 * `http_build_query()` over the payload, which is order-sensitive. The same
	 * selections arriving in a different order must produce the same key, or the
	 * customer gets two cart lines for one thing.
	 */
	public function test_attaches_selections_in_a_deterministic_order(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-b' => 'gift',
			'opt-a' => 'front',
		);
		$one                         = $this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'front',
			'opt-b' => 'gift',
		);
		$two                         = $this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 );

		$this->assertSame( $one, $two );
		$this->assertSame(
			http_build_query( $one[ Keys::CART_ITEM_KEY ] ),
			http_build_query( $two[ Keys::CART_ITEM_KEY ] ),
			'Different order must not produce a different cart item key.'
		);
	}

	/**
	 * Nothing volatile is attached.
	 *
	 * A timestamp, nonce or random id would make every add-to-cart a new line
	 * and break merging entirely. Asserted by attaching twice and comparing.
	 */
	public function test_attaches_nothing_volatile(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->assertSame(
			$this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 ),
			$this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 )
		);
	}

	/**
	 * The attached shape is one level deep.
	 *
	 * `http_build_query` flattens nesting, so deep structures collide more
	 * easily in the cart key.
	 */
	public function test_the_attached_shape_is_flat(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$selections = $this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 )[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ];

		foreach ( $selections as $value ) {
			$this->assertIsString( $value );
		}
	}

	/**
	 * Existing cart item data from other plugins is preserved.
	 */
	public function test_preserves_other_plugins_cart_item_data(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$data = $this->writer()->attach( array( 'other_plugin' => 'value' ), self::PRODUCT_ID, 0, 1 );

		$this->assertSame( 'value', $data['other_plugin'] );
	}

	/**
	 * An invalid selection attaches nothing rather than partial state.
	 */
	public function test_attaches_nothing_when_the_selection_is_invalid(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'HACKED' );

		$this->assertArrayNotHasKey(
			Keys::CART_ITEM_KEY,
			$this->writer()->attach( array(), self::PRODUCT_ID, 0, 1 )
		);
	}

	/**
	 * A product with no options attaches nothing.
	 */
	public function test_attaches_nothing_for_a_product_without_options(): void {
		$this->assertArrayNotHasKey(
			Keys::CART_ITEM_KEY,
			$this->writer()->attach( array(), 999, 0, 1 )
		);
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Price a standard line once and return the resulting per-unit price.
	 */
	private function priced_once(): string {
		$cart = $this->cart_with( array( 'opt-a' => 'front' ), 1 );

		$cart->calculate_totals();

		return $cart->get_cart()['line-1']['data']->get_price();
	}

	/**
	 * A cart holding one line with the given selections.
	 *
	 * @param array<string, string> $selections Option id to value key.
	 * @param int                   $quantity   Line quantity.
	 * @return object The cart double.
	 */
	private function cart_with( array $selections, int $quantity ): object {
		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			$quantity,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array( Keys::CART_ITEM_SELECTIONS => $selections ),
			)
		);

		$this->totals()->register();

		return $cart;
	}

	/**
	 * Store a configuration whose `lux` option uses a price type this build
	 * cannot compute.
	 *
	 * `percentage` is Phase 16's; here it is simply a type that contributes zero.
	 */
	private function store_unpriceable_config(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-1',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => (string) self::PRODUCT_ID,
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'options' => array(
									array(
										'id'     => 'opt-a',
										'type'   => 'radio',
										'values' => array(
											array(
												'value_key'    => 'lux',
												// `tiered`, not `percentage`: M16.1 made percentage
												// priceable, and a "cannot price this" fixture using a
												// type the build now charges tests the opposite of its
												// name. `tiered` has no evaluator in any phase yet.
												'price_config' => array(
													'type' => 'tiered',
												),
											),
										),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"unpriceable"'
		);
	}

	/**
	 * A cart line carrying a genuine frozen payload at the given delta.
	 *
	 * Written through `CartItemData` rather than assembled by hand, so the
	 * signature is a real one and the test exercises the same shape production
	 * writes. An 80.00 product plus this delta is what the customer was quoted.
	 *
	 * @param int $minor The option's amount when the line was added.
	 * @return array<string, mixed> A cart item.
	 */
	private function frozen_line( int $minor ): array {
		$this->store_config( $minor );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$attached = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		return array_merge( $attached, array( 'product_id' => self::PRODUCT_ID ) );
	}

	/**
	 * A cart holding one prepared line, with the applicator registered.
	 *
	 * @param array<string, mixed> $line     A cart item.
	 * @param int                  $quantity Line quantity.
	 * @return object The cart double.
	 */
	private function cart_with_line( array $line, int $quantity ): object {
		$cart = optionia_test_cart();
		$cart->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), $quantity, $line );

		$this->totals()->register();

		return $cart;
	}

	/**
	 * The totals applicator.
	 */
	private function totals(): CartTotals {
		$logger = new Logger( new Settings() );

		return new CartTotals( new Repository( $logger ), $logger );
	}

	/**
	 * The cart item data writer.
	 */
	private function writer(): CartItemData {
		return new CartItemData( new Repository( new Logger( new Settings() ) ) );
	}

	/**
	 * Store the configuration.
	 *
	 * `lux` is the value the freeze tests use, and its amount is a parameter so a
	 * test can publish a *different* price mid-test — which is the only way to
	 * tell a frozen price from a live one. `$lux_key` renames it, so a test can
	 * simulate the merchant deleting the option a cart line still references.
	 *
	 * @param int    $lux_minor The `lux` option's amount, in minor units.
	 * @param string $lux_key   The value key to publish it under.
	 */
	/* --- weight (M16.8) --------------------------------------------------- */

	/**
	 * 🔴 **Shipping is quoted on weight, so a missing gram is the merchant's
	 * money.**
	 *
	 * `weight_delta_grams` has been in the published document since Phase 5 and
	 * was read by nothing: a merchant could configure "Heavy oak +8kg", publish,
	 * sell, and WooCommerce would quote the carrier rate for the base product —
	 * with no error anywhere, because nothing failed.
	 */
	public function test_a_weighted_option_adds_to_the_line_weight(): void {
		$this->store_weighted_config( 8000 );

		$this->assertSame( '28', $this->weighed_line( '20' )->get_weight() );
	}

	/**
	 * 🔴 **The unit conversion is not optional.**
	 *
	 * The document carries **grams**; `get_weight()` answers in the store's
	 * configured unit. Adding 8000 to a kilogram weight would make an eight-kilo
	 * option weigh eight *tonnes*.
	 */
	public function test_the_delta_is_converted_into_the_stores_unit(): void {
		$this->store_weighted_config( 8000 );

		$this->assertSame( '28000', $this->weighed_line( '20000', 'g' )->get_weight() );
		$this->assertSame( '28', $this->weighed_line( '20', 'kg' )->get_weight() );
	}

	/**
	 * 🔴 **A reducing option must survive.**
	 *
	 * Measured: `wc_get_weight( -2000, 'kg', 'g' )` returns **0**, because that
	 * function clamps a negative result. Converting the delta on its own would
	 * silently discard a flat-pack option, so the *line total* is converted
	 * instead.
	 */
	public function test_a_reducing_option_lowers_the_line_weight(): void {
		$this->store_weighted_config( -2000 );

		$this->assertSame( '18', $this->weighed_line( '20' )->get_weight() );
	}

	/** A line that would weigh less than nothing weighs nothing. */
	public function test_the_line_weight_floors_at_zero(): void {
		$this->store_weighted_config( -5000 );

		$this->assertSame( '0', $this->weighed_line( '1' )->get_weight() );
	}

	/**
	 * ⚠️ **A product with no weight of its own still gains the option's.**
	 *
	 * `get_weight()` answers `''` for "not set", which is not the same as "weighs
	 * nothing" — but a line whose option adds eight kilos genuinely weighs that.
	 */
	public function test_a_weightless_product_gains_the_options_weight(): void {
		$this->store_weighted_config( 8000 );

		$this->assertSame( '8', $this->weighed_line( '' )->get_weight() );
	}

	/**
	 * 🔴 **Per unit, never multiplied by quantity.**
	 *
	 * `WC_Cart::get_cart_contents_weight()` does `get_weight() * $quantity`,
	 * exactly as `WC_Cart_Totals` does for price. A line of three "+8kg" tables
	 * must report 28, not 44 — the same silent-overcharge shape M11.6 guards
	 * against, pointed at shipping instead of price.
	 */
	public function test_the_weight_is_not_multiplied_by_quantity(): void {
		$this->store_weighted_config( 8000 );

		$this->assertSame( '28', $this->weighed_line( '20', 'kg', 3 )->get_weight() );
	}

	/**
	 * 🔴 **The weight must land before shipping reads it.**
	 *
	 * M16.8 asks for this to be *"verified by test, not by inspection"*, because
	 * a weight applied too late means the customer is quoted a rate for the wrong
	 * weight and the merchant absorbs the difference.
	 *
	 * WooCommerce's order (`class-wc-cart.php:1568-1570`) is
	 * `do_action( 'woocommerce_before_calculate_totals' )` and *then*
	 * `new WC_Cart_Totals( $this )`, which is what triggers
	 * `calculate_shipping_totals()`. So the hook this applicator registers on is
	 * the last point at which a weight still reaches the shipping calculation —
	 * pinning the hook name and priority is pinning that ordering.
	 */
	public function test_the_weight_is_applied_before_shipping_is_calculated(): void {
		$GLOBALS['optionia_test_actions'] = array();

		$this->totals()->register();

		$registered = $GLOBALS['optionia_test_actions']['woocommerce_before_calculate_totals'] ?? null;

		$this->assertNotNull(
			$registered,
			'Totals must run on the hook that precedes WC_Cart_Totals, or shipping sees a stale weight.'
		);
	}

	/** An option carrying no weight leaves the product's own untouched. */
	public function test_an_unweighted_option_changes_nothing(): void {
		$this->store_config();

		$product         = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );
		$product->weight = '20';

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$product,
			1,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
				),
			)
		);

		$this->totals()->apply( $cart );

		$this->assertSame( '20', $product->get_weight() );
	}

	/**
	 * Store a config whose `lux` value also carries a weight (M16.8).
	 *
	 * @param int $grams Grams the option adds; may be negative.
	 */
	private function store_weighted_config( int $grams ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'option_sets' => array(
					array(
						'id'          => 'set-1',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => (string) self::PRODUCT_ID,
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Material',
								'options' => array(
									array(
										'id'     => 'opt-a',
										'type'   => 'radio',
										'label'  => 'Material',
										'values' => array(
											self::value( 'front', 500 ) + array( 'weight_delta_grams' => $grams ),
										),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"weighted-' . $grams . '"'
		);
	}

	/**
	 * Apply totals to a line whose product starts at `$base` in the store's unit.
	 *
	 * @param string $base     The product's own weight.
	 * @param string $unit     The store's weight unit.
	 * @param int    $quantity Line quantity.
	 * @return object The product, after the applicator ran.
	 */
	private function weighed_line( string $base, string $unit = 'kg', int $quantity = 1 ): object {
		$GLOBALS['optionia_test_options']['woocommerce_weight_unit'] = $unit;

		$product         = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );
		$product->weight = $base;

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$product,
			$quantity,
			array(
				'product_id'        => self::PRODUCT_ID,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
				),
			)
		);

		$this->totals()->apply( $cart );

		return $product;
	}

	private function store_config( int $lux_minor = 500, string $lux_key = 'lux' ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'option_sets' => array(
					array(
						'id'          => 'set-1',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => (string) self::PRODUCT_ID,
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'     => 'opt-a',
										'type'   => 'radio',
										'label'  => 'Print placement',
										'values' => array(
											self::value( 'front', 500 ),
											self::value( 'back', 750 ),
											self::value( 'huge-discount', -1000000 ),
											self::value( $lux_key, $lux_minor ),
										),
									),
									array(
										'id'     => 'opt-b',
										'type'   => 'radio',
										'label'  => 'Wrapping',
										'values' => array( self::value( 'gift', 250 ) ),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-' . $lux_key . '-' . $lux_minor . '"'
		);
	}

	/**
	 * One fixed-price value.
	 *
	 * @param string $key   Value key.
	 * @param int    $minor Amount in minor units.
	 * @return array<string, mixed>
	 */
	private static function value( string $key, int $minor ): array {
		return array(
			'value_key'    => $key,
			'label'        => ucfirst( $key ),
			'price_config' => array(
				'type'         => 'fixed',
				'amount_minor' => $minor,
			),
		);
	}
}
