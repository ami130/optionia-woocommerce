<?php
/**
 * Cart display in both cart worlds (M12.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\CartDisplay;
use Optionia\Integration\CartItemData;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * One filter serves classic and block cart; three constraints bite on one side.
 *
 * @covers \Optionia\Integration\CartDisplay
 */
final class CartDisplayTest extends TestCase {

	/**
	 * Product under test.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * The Store API's hidden key, spelled out rather than referenced.
	 *
	 * Written literally so a rename of the production constant is a **failing
	 * test** rather than a silent agreement between two copies of the same
	 * mistake. The `__experimental_` prefix is WooCommerce's own stability
	 * warning; if core renames it, this must fail.
	 */
	private const BLOCK_HIDDEN_KEY = '__experimental_woocommerce_blocks_hidden';

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters'] = array();
		$GLOBALS['optionia_test_salt']    = 'test-salt';
		unset( $_POST[ Keys::FIELD_PREFIX ] );
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters'] = array();
		$_POST                            = array();

		parent::tearDown();
	}

	// --- What the customer sees ----------------------------------------------

	/**
	 * Each chosen option becomes a row, named and valued by its labels.
	 */
	public function test_each_option_becomes_a_labelled_row(): void {
		$rows = $this->rows();

		$this->assertSame( 'Finish', $rows[0]['key'] );
		$this->assertSame( 'Luxury (+20.00)', $rows[0]['value'] );
		$this->assertSame( 'Gift wrap', $rows[1]['key'] );
	}

	/**
	 * A zero-priced option shows no price.
	 *
	 * `Gift wrap: Yes (+0.00)` reads like a mistake — a free option is just a
	 * choice, not a charge of nothing.
	 */
	public function test_a_zero_priced_option_shows_no_price(): void {
		$this->assertSame( 'Yes', $this->rows()[1]['value'] );
	}

	/**
	 * A discount shows its own sign rather than a plus.
	 */
	public function test_a_discount_shows_a_negative(): void {
		$rows = $this->rows( -1500 );

		$this->assertSame( 'Luxury (-15.00)', $rows[0]['value'] );
	}

	/**
	 * **The breakdown agrees with the line total when the freeze falls back.**
	 *
	 * `CartTotals` prices from current configuration when the signature does not
	 * verify. A breakdown reading the stored deltas regardless would show
	 * `(+20.00)` beside a line total computed from 99.00 — the cart contradicting
	 * itself on the customer's screen.
	 *
	 * Both ask `CartItemPayload::trusted_deltas()`, so they cannot disagree.
	 */
	public function test_the_breakdown_follows_the_price_when_the_freeze_falls_back(): void {
		$line = $this->line();

		$this->store_config( 9900 );
		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertSame(
			'Luxury (+99.00)',
			$rows[0]['value'],
			'The breakdown must describe the price actually charged.'
		);
	}

	/**
	 * And it honours the freeze when the signature does verify.
	 *
	 * The other half — a display that always showed live prices would pass the
	 * test above while breaking the quote.
	 */
	public function test_the_breakdown_honours_a_verified_freeze(): void {
		$line = $this->line();

		$this->store_config( 9900 );

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertSame( 'Luxury (+20.00)', $rows[0]['value'] );
	}

	/**
	 * An option that no longer resolves shows no price rather than inventing one.
	 *
	 * `CheckoutValidator` blocks the order and says why; a made-up price here
	 * would be a second, quieter wrong answer.
	 */
	public function test_an_unresolvable_option_shows_no_price(): void {
		$line = $this->line();

		$this->store_config( 2000, 'gone' );
		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertSame( 'Luxury', $rows[0]['value'] );
	}

	// --- The block-cart constraints ------------------------------------------

	/**
	 * **Every value in every row is scalar, or the block cart drops the row.**
	 *
	 * `CartItemSchema::get_item_data()` discards the *whole element* when any
	 * value is non-scalar — silently, with no error or log line. Phase 4 measured
	 * it: two rows on classic, one on blocks. A developer testing only the
	 * classic cart ships this and never sees it.
	 *
	 * This applies the Store API's own test to our output.
	 */
	public function test_every_row_survives_the_store_api_scalar_check(): void {
		foreach ( $this->rows() as $row ) {
			foreach ( $row as $key => $value ) {
				$this->assertIsScalar(
					$value,
					sprintf( 'A non-scalar "%s" makes the block cart discard the entire row.', $key )
				);
			}
		}
	}

	/**
	 * **Both hidden keys are present, because the two paths read different ones.**
	 *
	 * The classic template reads `hidden`; the Store API reads
	 * `__experimental_woocommerce_blocks_hidden` and only *derives* `hidden` from
	 * it. Setting the experimental key alone leaves the row visible on classic.
	 */
	public function test_both_hidden_keys_are_set(): void {
		$row = $this->rows()[0];

		$this->assertArrayHasKey( 'hidden', $row, 'The classic cart template reads this one.' );
		$this->assertArrayHasKey( self::BLOCK_HIDDEN_KEY, $row, 'The Store API reads this one.' );
		$this->assertFalse( $row['hidden'] );
		$this->assertFalse( $row[ self::BLOCK_HIDDEN_KEY ] );
	}

	/**
	 * The row carries `display` as well as `value`.
	 *
	 * The classic template falls back to `value` when `display` is absent, but
	 * relying on that fallback means the two paths render from different fields.
	 */
	public function test_rows_carry_both_value_and_display(): void {
		$row = $this->rows()[0];

		$this->assertSame( $row['value'], $row['display'] );
	}

	// --- Not breaking other plugins ------------------------------------------

	/**
	 * Existing rows are appended to, never replaced.
	 *
	 * The block path starts from `array()` while the classic template passes a
	 * populated list — so a callback returning only its own rows would erase
	 * variation attributes on classic and nothing on blocks. Exactly the kind of
	 * asymmetry that ships untested.
	 */
	public function test_existing_rows_are_preserved(): void {
		$existing = array(
			array(
				'key'   => 'Size',
				'value' => 'Large',
			),
		);

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( $existing, $this->line() );

		$this->assertSame( 'Size', $rows[0]['key'] );
		$this->assertCount( 3, $rows );
	}

	/**
	 * A line with no Optionia data is left exactly as it was.
	 *
	 * @dataProvider provide_foreign_items
	 *
	 * @param mixed $cart_item Something this plugin did not write.
	 */
	public function test_a_foreign_line_is_untouched( $cart_item ): void {
		$existing = array(
			array(
				'key'   => 'Size',
				'value' => 'Large',
			),
		);

		$this->assertSame(
			$existing,
			( new CartDisplay( $this->repository() ) )->item_data( $existing, $cart_item )
		);
	}

	/**
	 * Cart items with nothing of ours in them.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_foreign_items(): array {
		return array(
			'no optionia key'    => array( array( 'product_id' => 41 ) ),
			'optionia not array' => array( array( Keys::CART_ITEM_KEY => 'garbage' ) ),
			'no selections'      => array( array( Keys::CART_ITEM_KEY => array() ) ),
			'empty selections'   => array( array( Keys::CART_ITEM_KEY => array( Keys::CART_ITEM_SELECTIONS => array() ) ) ),
			'not an array'       => array( null ),
		);
	}

	/**
	 * A non-array first argument does not break the filter chain.
	 */
	public function test_a_non_array_item_data_is_tolerated(): void {
		$this->assertSame( array(), ( new CartDisplay( $this->repository() ) )->item_data( null, null ) );
	}

	// --- Fallbacks -----------------------------------------------------------

	/**
	 * With no snapshotted labels, ids are shown rather than nothing.
	 *
	 * A line written before labels existed still has to render. An unhelpful
	 * name beats a missing row.
	 */
	/**
	 * 🔴 **`display` is rendered as HTML, and `text_field` makes the value a
	 * customer's own words.**
	 *
	 * Every value before free text was a merchant-authored label from the config
	 * document, so escaping here was moot. It is not any more, and this is the
	 * first place a typed value becomes markup.
	 *
	 * `Engine\SelectionResolver::clean_text()` strips tags before storing — this
	 * is the second layer, because a value can also arrive from a reorder payload
	 * or a cart row that predates that sanitising.
	 */
	public function test_a_dangerous_label_is_escaped_for_display(): void {
		$line = $this->line();

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ]['opt-a'] = array(
			'option' => 'Engraving',
			'value'  => '<img src=x onerror=alert(1)>',
		);

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertStringNotContainsString( '<img', $rows[0]['display'] );
		$this->assertStringContainsString( '&lt;img', $rows[0]['display'] );
	}

	/**
	 * ⚠️ **And `value` stays raw**, because it is the machine-readable half.
	 *
	 * The Store API serialises it as JSON rather than HTML, and escaping it would
	 * show a customer `&amp;` in their own engraving.
	 */
	public function test_the_machine_readable_value_is_not_escaped(): void {
		$line = $this->line();

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ]['opt-a'] = array(
			'option' => 'Engraving',
			'value'  => 'Tom & Jerry',
		);

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertStringContainsString( 'Tom & Jerry', $rows[0]['value'] );
	}

	public function test_a_line_without_labels_falls_back_to_ids(): void {
		$line = $this->line();

		unset( $line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ] );

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertSame( 'opt-a', $rows[0]['key'] );
		$this->assertStringContainsString( 'lux', $rows[0]['value'] );
	}

	/**
	 * An array label is joined rather than passed through.
	 *
	 * This is the scalar constraint at its source: a label that arrived as an
	 * array would otherwise make the block cart discard the whole row.
	 */
	public function test_an_array_label_is_joined(): void {
		$line = $this->line();

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ]['opt-a']['value'] = array( 'Red', 'Large' );

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertIsScalar( $rows[0]['value'] );
		$this->assertStringContainsString( 'Red, Large', $rows[0]['value'] );
	}

	/**
	 * 🔴 **A non-scalar label that is not an array falls back, rather than
	 * killing the cart page.**
	 *
	 * Found 2026-09-01 by mutation: deleting the final `is_scalar()` guard in
	 * `text()` passed all 735 tests, and it is not an equivalent mutant. An
	 * **object** is neither an array — so the joining above does not fire — nor
	 * scalar, so `(string) $label` throws a fatal `Error`. Measured directly:
	 *
	 * ```text
	 * object label, guard removed → FATAL: Error
	 * null   label, guard removed → 'FALLBACK'   (safe by accident)
	 * ```
	 *
	 * The payload is reachable: another plugin can write `cart_item_data`, and it
	 * survives a session round-trip. A fatal here is the **whole cart page**, not
	 * one row — worse than the silent row-drop the scalar rule exists to prevent.
	 *
	 * Both cases are driven because only one of them is dangerous, and a test
	 * covering only the safe one would look like coverage while proving nothing.
	 *
	 * @dataProvider provide_unusable_labels
	 *
	 * @param mixed $label What the payload holds where a label should be.
	 */
	public function test_an_unusable_label_falls_back_instead_of_fataling( $label ): void {
		$line = $this->line();

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ]['opt-a']['value'] = $label;

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertIsScalar( $rows[0]['value'] );
		$this->assertStringContainsString( 'lux', $rows[0]['value'], 'It should fall back to the value key.' );
	}

	/**
	 * Label shapes a payload might carry where a string belongs.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_unusable_labels(): array {
		return array(
			'an object' => array( new \stdClass() ),
			'null'      => array( null ),
			'a boolean' => array( false ),
		);
	}

	/**
	 * The same guard on the *option name* side.
	 *
	 * `text()` is called twice per row — once for the name, once for the value —
	 * and a test covering only one leaves the other free to regress.
	 */
	public function test_an_unusable_option_name_falls_back(): void {
		$line = $this->line();

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ]['opt-a']['option'] = new \stdClass();

		$rows = ( new CartDisplay( $this->repository() ) )->item_data( array(), $line );

		$this->assertSame( 'opt-a', $rows[0]['key'] );
	}

	// --- Registration --------------------------------------------------------

	/**
	 * One registration serves both cart worlds.
	 */
	public function test_registers_once_for_both_carts(): void {
		( new CartDisplay( $this->repository() ) )->register();

		$this->assertCount( 1, $GLOBALS['optionia_test_filters'][ CartDisplay::HOOK ] ?? array() );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Display rows for a standard line.
	 *
	 * @param int $lux_minor The `lux` option's amount.
	 * @return array<int, array<string, mixed>>
	 */
	private function rows( int $lux_minor = 2000 ): array {
		return ( new CartDisplay( $this->repository() ) )->item_data( array(), $this->line( $lux_minor ) );
	}

	/**
	 * A cart line written by the real writer, so the shape is production's.
	 *
	 * @param int $lux_minor The `lux` option's amount.
	 * @return array<string, mixed>
	 */
	private function line( int $lux_minor = 2000 ): array {
		$this->store_config( $lux_minor );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'yes',
		);

		$line = ( new CartItemData( $this->repository() ) )->attach( array(), self::PRODUCT_ID, 0, 1 );

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		return array_merge(
			$line,
			array(
				'product_id' => self::PRODUCT_ID,
				'quantity'   => 1,
			)
		);
	}

	/**
	 * The configuration cache.
	 */
	private function repository(): Repository {
		return new Repository( new Logger( new Settings() ) );
	}

	/**
	 * Store a two-option configuration.
	 *
	 * @param int    $lux_minor The `lux` option's amount, in minor units.
	 * @param string $lux_key   The value key to publish `lux` under.
	 */
	private function store_config( int $lux_minor, string $lux_key = 'lux' ): void {
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
										'id'     => 'opt-a',
										'type'   => 'radio',
										'label'  => 'Finish',
										'values' => array(
											array(
												'value_key' => $lux_key,
												'label' => 'Luxury',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => $lux_minor,
												),
											),
										),
									),
									array(
										'id'     => 'opt-b',
										'type'   => 'radio',
										'label'  => 'Gift wrap',
										'values' => array(
											array(
												'value_key' => 'yes',
												'label' => 'Yes',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 0,
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
			'W/"' . $lux_key . '-' . $lux_minor . '"'
		);
	}
}
