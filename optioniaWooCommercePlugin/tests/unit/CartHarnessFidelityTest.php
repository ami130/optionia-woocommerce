<?php
/**
 * The cart double is faithful to WooCommerce (M11.6 groundwork).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Tests the test harness, deliberately.
 *
 * Stage 6 shipped an `apply_filters()` stub that ignored `accepted_args`, which
 * made a correctly registered validator and a badly registered one behave
 * identically here while diverging in production — a suite that could not fail
 * for the reason it existed. The fix was found only because something else broke.
 *
 * M11.6's whole risk is the same shape: a stub that does not multiply by
 * quantity would make a correct per-unit implementation and a broken line-total
 * one produce the same number. So the double's fidelity is asserted, not assumed.
 *
 * @coversNothing
 */
final class CartHarnessFidelityTest extends TestCase {

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters']            = array();
		$GLOBALS['optionia_test_actions']            = array();
		$GLOBALS['optionia_test_prices_include_tax'] = false;
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters']            = array();
		$GLOBALS['optionia_test_actions']            = array();
		$GLOBALS['optionia_test_prices_include_tax'] = false;

		parent::tearDown();
	}

	/**
	 * `get_price()` returns a decimal string, as WooCommerce does.
	 *
	 * Not an int and not a float. Stage 5's audit found `"10.50"` truncating to
	 * `10` under an `int` type hint; a stub returning a clean int would have
	 * hidden that, and would hide the next one.
	 */
	public function test_get_price_returns_a_decimal_string(): void {
		$product = optionia_test_product( 1, 'simple', '10.50' );

		$this->assertIsString( $product->get_price() );
		$this->assertSame( '10.50', $product->get_price() );
	}

	/**
	 * `set_price()` stores what it is given, without cleaning it up.
	 *
	 * A stub that rounded or validated here would conceal a plugin handing
	 * WooCommerce a float or an unclamped figure.
	 */
	public function test_set_price_does_not_sanitise(): void {
		$product = optionia_test_product( 1, 'simple', '10.00' );

		$product->set_price( 12.345 );

		$this->assertSame( '12.345', $product->get_price() );
	}

	/**
	 * **The line total is per-unit price times quantity.**
	 *
	 * This is the assertion the whole harness exists for. `WC_Cart_Totals`
	 * multiplies (WC 11.0.1, `includes/class-wc-cart-totals.php:233`), so a
	 * per-unit price of 35.00 at quantity 3 is a line of 105.00 — and a plugin
	 * that had set the *line* total instead would produce 315.00 here.
	 */
	public function test_line_total_multiplies_by_quantity(): void {
		$cart = optionia_test_cart();
		$cart->add_line( 'k1', optionia_test_product( 1, 'simple', '35.00' ), 3 );

		$this->assertSame( 105.0, $cart->line_total( 'k1' ) );
	}

	/**
	 * Quantity one is the case that hides the bug.
	 *
	 * Per-unit and per-line agree at quantity 1, which is why a line-total
	 * implementation looks correct in casual testing and overcharges in the cart.
	 */
	public function test_quantity_one_hides_the_difference(): void {
		$cart = optionia_test_cart();
		$cart->add_line( 'k1', optionia_test_product( 1, 'simple', '35.00' ), 1 );

		$this->assertSame( 35.0, $cart->line_total( 'k1' ) );
	}

	/**
	 * Two lines of the same product price independently.
	 *
	 * `wc_get_product()` ends at `new $classname( $product_id )`, a fresh object
	 * per call, so `set_price()` on one cart line cannot leak into another line
	 * of the same product carrying different options.
	 */
	public function test_two_lines_of_one_product_do_not_share_a_price(): void {
		$cart = optionia_test_cart();
		$cart->add_line( 'k1', optionia_test_product( 7, 'simple', '20.00' ), 1 );
		$cart->add_line( 'k2', optionia_test_product( 7, 'simple', '20.00' ), 1 );

		$cart->get_cart()['k1']['data']->set_price( '25.00' );

		$this->assertSame( 25.0, $cart->line_total( 'k1' ) );
		$this->assertSame( 20.0, $cart->line_total( 'k2' ), 'A shared product object would make this 25.' );
	}

	/**
	 * Extra cart item data survives, keyed as WooCommerce keys it.
	 *
	 * `WC_Cart_Session::get_cart_from_session()` does
	 * `array_merge( $values, array( 'data' => $product ) )`, so custom keys
	 * round-trip with no work — which is what M12.1 will rely on.
	 */
	public function test_custom_cart_item_data_survives(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'k1',
			optionia_test_product( 1, 'simple', '10.00' ),
			1,
			array( 'optionia' => array( 'selections' => array( 'opt-a' => 'front' ) ) )
		);

		$item = $cart->get_cart()['k1'];

		$this->assertSame( array( 'opt-a' => 'front' ), $item['optionia']['selections'] );
		$this->assertSame( 1, $item['quantity'] );
	}

	/**
	 * The session boundary drops the product object and keeps everything else.
	 *
	 * `WC_Cart_Session::get_cart_for_session()` unsets exactly one key —
	 * `data`, the product object — and copies the rest verbatim. That single
	 * omission is why Optionia's `cart_item_data` round-trips with no work, and
	 * a double that dropped more (or less) would make every session test below
	 * meaningless.
	 */
	public function test_the_session_drops_only_the_product_object(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'k1',
			optionia_test_product( 7, 'simple', '10.00' ),
			2,
			array(
				'product_id' => 7,
				'optionia'   => array( 'selections' => array( 'opt-a' => 'front' ) ),
			)
		);

		$stored = unserialize( $cart->to_session() );

		$this->assertArrayNotHasKey( 'data', $stored['k1'], 'The product object is rebuilt, not stored.' );
		$this->assertSame( 2, $stored['k1']['quantity'] );
		$this->assertSame(
			array( 'opt-a' => 'front' ),
			$stored['k1']['optionia']['selections'],
			'Custom cart item data must survive untouched.'
		);
	}

	/**
	 * Restoring rebuilds the product at its **current** catalogue price.
	 *
	 * This is what makes a page reload a real test rather than a repeat of the
	 * same request. `get_cart_from_session()` calls `wc_get_product()`, so any
	 * price Optionia set on the previous request is gone and has to be applied
	 * again — which is exactly the idempotence question, one request later.
	 */
	public function test_restoring_rebuilds_the_product_at_its_current_price(): void {
		$cart = optionia_test_cart();
		$cart->add_line( 'k1', optionia_test_product( 7, 'simple', '10.00' ), 1, array( 'product_id' => 7 ) );

		$cart->get_cart()['k1']['data']->set_price( '99.00' );

		$restored = optionia_test_cart();
		$restored->from_session( $cart->to_session(), '10.00' );

		$this->assertSame(
			'10.00',
			$restored->get_cart()['k1']['data']->get_price(),
			'A price set last request must not survive into the next one.'
		);
	}

	/**
	 * A round-trip preserves the line, its quantity and its data.
	 */
	public function test_a_session_round_trip_preserves_the_line(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'k1',
			optionia_test_product( 7, 'simple', '10.00' ),
			3,
			array(
				'product_id' => 7,
				'optionia'   => array( 'selections' => array( 'opt-a' => 'front' ) ),
			)
		);

		$restored = optionia_test_cart();
		$restored->from_session( $cart->to_session() );

		$this->assertSame( 3, $restored->get_cart()['k1']['quantity'] );
		$this->assertSame(
			array( 'opt-a' => 'front' ),
			$restored->get_cart()['k1']['optionia']['selections']
		);
	}

	/**
	 * A corrupt session payload yields no lines and no PHP warnings.
	 *
	 * Not a production concern — WooCommerce calls `maybe_unserialize()` itself,
	 * so a corrupt session fails before Optionia sees anything. It is asserted
	 * because a double that emitted `unserialize(): Error at offset 0` would send
	 * a future test author looking for a production signal that does not exist.
	 *
	 * @dataProvider provide_corrupt_payloads
	 *
	 * @param string $payload Something that is not a serialised cart.
	 */
	public function test_a_corrupt_session_payload_yields_no_lines( string $payload ): void {
		$cart = optionia_test_cart();
		$cart->from_session( $payload );

		$this->assertSame( array(), $cart->get_cart() );
	}

	/**
	 * Payloads that are not a serialised cart.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_corrupt_payloads(): array {
		return array(
			'not serialised' => array( 'garbage' ),
			'truncated'      => array( 'a:1:{s:2:"k1";' ),
			'empty'          => array( '' ),
			'a scalar'       => array( 'i:42;' ),
		);
	}

	/**
	 * A variation line is rebuilt from the variation, not the parent.
	 *
	 * `get_cart_from_session()` uses
	 * `wc_get_product( $values['variation_id'] ? $values['variation_id'] : $values['product_id'] )`
	 * (WC 11.0.1, `class-wc-cart-session.php:146`). A double that always rebuilt
	 * the parent could not represent a variable product, which is the one type
	 * where the base price is not the parent's.
	 */
	public function test_a_variation_line_is_rebuilt_from_the_variation(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'k1',
			optionia_test_product( 77, 'variation', '120.00' ),
			1,
			array(
				'product_id'   => 41,
				'variation_id' => 77,
			)
		);

		$restored = optionia_test_cart();
		$restored->from_session( $cart->to_session(), '120.00' );

		$this->assertSame( 'variation', $restored->get_cart()['k1']['data']->get_type() );
		$this->assertSame( 77, $restored->get_cart()['k1']['data']->get_id() );
	}

	/**
	 * The login merge keeps the later cart's line on a collision.
	 *
	 * `get_cart_from_session()` does `array_merge( $saved_cart, $cart )` with
	 * string keys, so colliding lines do not sum — the guest cart wins. The
	 * double must model that, or the merge test above would be asserting against
	 * a merge this harness invented.
	 */
	public function test_the_login_merge_lets_the_guest_cart_win(): void {
		$account = optionia_test_cart();
		$account->add_line(
			'shared',
			optionia_test_product( 7, 'simple', '10.00' ),
			1,
			array(
				'product_id' => 7,
				'tag'        => 'account',
			)
		);
		$account->add_line( 'only-account', optionia_test_product( 7, 'simple', '10.00' ), 1, array( 'product_id' => 7 ) );

		$guest = optionia_test_cart();
		$guest->add_line(
			'shared',
			optionia_test_product( 7, 'simple', '10.00' ),
			5,
			array(
				'product_id' => 7,
				'tag'        => 'guest',
			)
		);

		$merged = optionia_test_cart();
		$merged->from_session( $guest->to_session(), '10.00', $account->to_session() );

		$this->assertCount( 2, $merged->get_cart(), 'Non-colliding lines survive from both carts.' );
		$this->assertSame( 5, $merged->get_cart()['shared']['quantity'], 'Quantities do not sum.' );
		$this->assertSame( 'guest', $merged->get_cart()['shared']['tag'], 'The guest line wins outright.' );
	}

	/**
	 * `calculate_totals()` fires the hook, and can fire it repeatedly.
	 *
	 * `calculate_totals()` has nine call sites in WC 11.0.1 core, so anything
	 * hooked here must be idempotent. The double must therefore be able to
	 * express repeated firing.
	 */
	public function test_calculate_totals_fires_the_hook_each_time(): void {
		$fired = 0;

		add_action(
			'woocommerce_before_calculate_totals',
			static function () use ( &$fired ): void {
				++$fired;
			}
		);

		$cart = optionia_test_cart();
		$cart->calculate_totals();
		$cart->calculate_totals();
		$cart->calculate_totals();

		$this->assertSame( 3, $fired );
	}

	/**
	 * The hook receives the cart, as WooCommerce passes it.
	 */
	public function test_the_hook_receives_the_cart(): void {
		$received = null;

		add_action(
			'woocommerce_before_calculate_totals',
			static function ( $cart ) use ( &$received ): void {
				$received = $cart;
			}
		);

		$cart = optionia_test_cart();
		$cart->calculate_totals();

		$this->assertSame( $cart, $received );
	}

	/**
	 * The tax setting is readable and does not change the arithmetic.
	 *
	 * `price_includes_tax` tells WooCommerce how to interpret the figure; it does
	 * not change it. A plugin that branched on this would tax twice, so the
	 * double must show the same line total either way.
	 */
	public function test_the_tax_setting_does_not_change_the_line_total(): void {
		$cart = optionia_test_cart();
		$cart->add_line( 'k1', optionia_test_product( 1, 'simple', '35.00' ), 2 );

		$GLOBALS['optionia_test_prices_include_tax'] = false;
		$exclusive                                   = $cart->line_total( 'k1' );

		$GLOBALS['optionia_test_prices_include_tax'] = true;
		$inclusive                                   = $cart->line_total( 'k1' );

		$this->assertTrue( wc_prices_include_tax() );
		$this->assertSame( $exclusive, $inclusive );
	}
}
