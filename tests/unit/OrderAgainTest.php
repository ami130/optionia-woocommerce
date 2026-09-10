<?php
/**
 * Reorder (M12.8).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\AddToCartValidator;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartTotals;
use Optionia\Integration\OrderAgain;
use Optionia\Integration\OrderLineItem;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * A past order replayed into a new cart.
 *
 * Phase 4 proved this broken: replaying an order was rejected outright, because
 * the validator read `$_POST` while the selection lived in order item meta.
 * Phase 11 fixed the reading half; nothing put the selections where it looked.
 *
 * @covers \Optionia\Integration\OrderAgain
 */
final class OrderAgainTest extends TestCase {

	/**
	 * Product under test.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_notices'] = array();
		$GLOBALS['optionia_test_salt']    = 'test-salt';
		unset( $_POST[ Keys::FIELD_PREFIX ] );
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_notices'] = array();
		$_POST                            = array();

		parent::tearDown();
	}

	// --- The format gap ------------------------------------------------------

	/**
	 * **A past order's selections reach the new cart line.**
	 *
	 * The two sides were written against different shapes and neither was wrong:
	 * order meta is a JSON string under `_optionia_selections` (a flat key/value
	 * table would otherwise take one row per option), while the cart carries a
	 * real array because `generate_cart_id()` hashes it. This closes that gap.
	 */
	public function test_a_past_orders_selections_reach_the_cart(): void {
		$rebuilt = ( new OrderAgain() )->rebuild( array(), $this->ordered_item() );

		$this->assertSame(
			array( 'opt-a' => 'lux' ),
			$rebuilt[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ]
		);
	}

	/**
	 * **Only the selections are replayed.**
	 *
	 * A reorder is a new purchase, so the frozen price and its `config_version`
	 * — which describe the *original* purchase — must not come with it. That is
	 * achieved by not writing them: `woocommerce_order_again_cart_item_data`
	 * starts from `array()`, so WooCommerce replays nothing and this class
	 * chooses what the line carries.
	 */
	public function test_the_frozen_price_is_not_replayed(): void {
		$payload = ( new OrderAgain() )->rebuild( array(), $this->ordered_item() )[ Keys::CART_ITEM_KEY ];

		$this->assertSame( array( Keys::CART_ITEM_SELECTIONS ), array_keys( $payload ) );
	}

	// --- The three requirements, end to end ----------------------------------

	/**
	 * **A reorder reprices from current configuration.**
	 *
	 * Bought when Luxury cost 20.00; the merchant has since raised it to 99.00.
	 * The new line must cost 179.00, not the 100.00 originally paid — and it does
	 * so with no repricing code, because a payload holding selections and no
	 * signature is exactly the shape `CartTotals` already prices live.
	 */
	public function test_a_reorder_reprices_from_current_config(): void {
		$item = $this->ordered_item();

		$this->store_config( 9900 );

		$rebuilt = ( new OrderAgain() )->rebuild( array(), $item );

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			array_merge(
				$rebuilt,
				array(
					'product_id' => self::PRODUCT_ID,
					'quantity'   => 1,
				)
			)
		);

		$this->totals()->register();
		$cart->calculate_totals();

		$this->assertSame( '179.00', $cart->get_cart()['line-1']['data']->get_price() );
	}

	/**
	 * A reorder is re-validated, and an unchanged one is accepted.
	 */
	public function test_a_valid_reorder_is_accepted(): void {
		$rebuilt = ( new OrderAgain() )->rebuild( array(), $this->ordered_item() );

		$this->assertTrue( $this->validate( $rebuilt ) );
	}

	/**
	 * **A reorder referencing a discontinued option is refused.**
	 *
	 * M12.8's acceptance, and the reason a stored payload is a *record* rather
	 * than an authority. The refusal comes from `AddToCartValidator`, which the
	 * reorder call site already runs at six arguments — so this asserts the
	 * composition, not a second implementation.
	 */
	public function test_a_reorder_of_a_discontinued_option_is_refused(): void {
		$item = $this->ordered_item();

		$this->store_config( 2000, 'gone' );

		$rebuilt = ( new OrderAgain() )->rebuild( array(), $item );

		$this->assertFalse( $this->validate( $rebuilt ) );
		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'], 'The customer must be told why.' );
	}

	// --- Ordering ------------------------------------------------------------

	/**
	 * Selections are sorted, so a reorder merges with an identical fresh add.
	 *
	 * `generate_cart_id()` hashes the payload textually. An order whose meta
	 * happened to be in a different key order would otherwise produce a separate
	 * cart line from the same selection chosen afresh.
	 */
	public function test_selections_are_sorted(): void {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, '{"opt-z":"1","opt-a":"2"}', true );

		$rebuilt = ( new OrderAgain() )->rebuild( array(), $item );

		$this->assertSame(
			array( 'opt-a', 'opt-z' ),
			array_keys( $rebuilt[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ] )
		);
	}

	// --- Boundaries ----------------------------------------------------------

	/**
	 * A line with no Optionia meta is replayed as a plain product.
	 *
	 * @dataProvider provide_unusable_meta
	 *
	 * @param mixed $meta Whatever `_optionia_selections` holds.
	 */
	public function test_unusable_meta_yields_no_payload( $meta ): void {
		$item = optionia_test_order_item();

		if ( null !== $meta ) {
			$item->add_meta_data( Keys::META_SELECTIONS, $meta, true );
		}

		$this->assertArrayNotHasKey(
			Keys::CART_ITEM_KEY,
			( new OrderAgain() )->rebuild( array(), $item )
		);
	}

	/**
	 * Meta shapes an order line might carry.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_unusable_meta(): array {
		return array(
			'absent'          => array( null ),
			'empty string'    => array( '' ),
			'malformed json'  => array( '{"opt-a":' ),
			'json scalar'     => array( '"lux"' ),
			'json empty'      => array( '{}' ),
			'already decoded' => array( array( 'opt-a' => 'lux' ) ),
		);
	}

	/**
	 * Non-scalar members are dropped rather than carried into the cart key.
	 *
	 * `SelectionResolver` would refuse them anyway, but they would be hashed into
	 * the cart item key on the way — so they are dropped here, where the shape is
	 * still ours to control.
	 */
	public function test_non_scalar_members_are_dropped(): void {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, '{"opt-a":"lux","opt-b":["array"]}', true );

		$rebuilt = ( new OrderAgain() )->rebuild( array(), $item );

		$this->assertSame(
			array( 'opt-a' => 'lux' ),
			$rebuilt[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ]
		);
	}

	/**
	 * Other plugins' reorder data is preserved.
	 */
	public function test_other_plugins_data_is_preserved(): void {
		$rebuilt = ( new OrderAgain() )->rebuild( array( 'gift' => 'yes' ), $this->ordered_item() );

		$this->assertSame( 'yes', $rebuilt['gift'] );
	}

	/**
	 * An item that cannot yield meta is tolerated.
	 */
	public function test_an_item_without_get_meta_is_tolerated(): void {
		$this->assertSame( array(), ( new OrderAgain() )->rebuild( array(), new \stdClass() ) );
	}

	/**
	 * A non-array first argument does not break the filter chain.
	 */
	public function test_a_non_array_cart_item_data_is_tolerated(): void {
		$this->assertIsArray( ( new OrderAgain() )->rebuild( null, null ) );
	}

	// --- Registration --------------------------------------------------------

	/**
	 * The reorder filter is registered once.
	 */
	public function test_registers_the_reorder_filter(): void {
		( new OrderAgain() )->register();

		$this->assertCount( 1, $GLOBALS['optionia_test_filters'][ OrderAgain::HOOK ] ?? array() );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * An order line item recorded when Luxury cost 20.00.
	 *
	 * Built through the real writer, so the meta is exactly production's shape.
	 *
	 * @return object The order item double.
	 */
	private function ordered_item(): object {
		$this->store_config( 2000 );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$line = array_merge(
			( new CartItemData( $this->repository() ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array(
				'product_id' => self::PRODUCT_ID,
				'quantity'   => 1,
			)
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		return $item;
	}

	/**
	 * Run a rebuilt payload through the six-argument reorder call site.
	 *
	 * @param array<string, mixed> $cart_item_data The rebuilt payload.
	 */
	private function validate( array $cart_item_data ): bool {
		$logger = new Logger( new Settings() );

		( new AddToCartValidator( $this->repository(), $logger ) )->register();

		return (bool) apply_filters(
			AddToCartValidator::HOOK,
			true,
			self::PRODUCT_ID,
			1,
			0,
			array(),
			$cart_item_data
		);
	}

	/**
	 * The totals applicator.
	 */
	private function totals(): CartTotals {
		$logger = new Logger( new Settings() );

		return new CartTotals( $this->repository(), $logger );
	}

	/**
	 * The configuration cache.
	 */
	private function repository(): Repository {
		return new Repository( new Logger( new Settings() ) );
	}

	/**
	 * Store a configuration offering `$value_key` at `$minor`.
	 *
	 * @param int    $minor     The option's amount, in minor units.
	 * @param string $value_key The value key to publish.
	 */
	private function store_config( int $minor, string $value_key = 'lux' ): void {
		$this->repository()->store(
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
										'id'          => 'opt-a',
										'type'        => 'radio',
										'label'       => 'Finish',
										'is_required' => true,
										'values'      => array(
											array(
												'value_key' => $value_key,
												'label' => 'Luxury',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => $minor,
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
			'W/"' . $value_key . '-' . $minor . '"'
		);
	}
}
