<?php
/**
 * Cart display in both cart worlds (M12.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Frontend\OptionView;
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

		/*
		 * 🔴 **Two global stores leak between tests, and both were measured.**
		 *
		 * The **product registry** is keyed by id, so
		 * `test_a_product_with_no_price_states_no_base` registering product 41
		 * at `'0'` would hand every later test a free product.
		 *
		 * The **settings option** is worse: `subtotal_display()` calls
		 * `Settings::save()`, which writes `optionia_settings` — and every later
		 * `new Settings()` re-reads it, so an itemised test silently ran in
		 * subtotal mode. ✏️ **Measured:** a test passing alone failed in the
		 * suite with `Customisation` where `Finish` belonged. `flush()` clears
		 * only the per-instance cache, so it cannot help here.
		 */
		$GLOBALS['optionia_test_products'] = array();
		delete_option( Keys::OPTION_SETTINGS );

		parent::tearDown();
	}

	// --- What the customer sees ----------------------------------------------

	/**
	 * Each chosen option becomes a row, named and valued by its labels.
	 */
	public function test_each_option_becomes_a_labelled_row(): void {
		$rows = $this->rows();

		$this->assertSame( 'Finish', $rows[0]['key'] );
		$this->assertSame( 'Luxury (+£20.00)', $rows[0]['value'] );
		$this->assertSame( 'Gift wrap', $rows[1]['key'] );
	}

	/**
	 * A zero-priced option shows no price.
	 *
	 * `Gift wrap: Yes (+£0.00)` reads like a mistake — a free option is just a
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

		$this->assertSame( 'Luxury (-£15.00)', $rows[0]['value'] );
	}

	/**
	 * **The breakdown agrees with the line total when the freeze falls back.**
	 *
	 * `CartTotals` prices from current configuration when the signature does not
	 * verify. A breakdown reading the stored deltas regardless would show
	 * `(+£20.00)` beside a line total computed from 99.00 — the cart contradicting
	 * itself on the customer's screen.
	 *
	 * Both ask `CartItemPayload::trusted_deltas()`, so they cannot disagree.
	 */
	public function test_the_breakdown_follows_the_price_when_the_freeze_falls_back(): void {
		$line = $this->line();

		$this->store_config( 9900 );
		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$rows = $this->display()->item_data( array(), $line );

		$this->assertSame(
			'Luxury (+£99.00)',
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

		$rows = $this->display()->item_data( array(), $line );

		$this->assertSame( 'Luxury (+£20.00)', $rows[0]['value'] );
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

		$rows = $this->display()->item_data( array(), $line );

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

		$rows = $this->display()->item_data( $existing, $this->line() );

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
			$this->display()->item_data( $existing, $cart_item )
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
		$this->assertSame( array(), $this->display()->item_data( null, null ) );
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

		$rows = $this->display()->item_data( array(), $line );

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

		$rows = $this->display()->item_data( array(), $line );

		$this->assertStringContainsString( 'Tom & Jerry', $rows[0]['value'] );
	}

	public function test_a_line_without_labels_falls_back_to_ids(): void {
		$line = $this->line();

		unset( $line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ] );

		$rows = $this->display()->item_data( array(), $line );

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

		$rows = $this->display()->item_data( array(), $line );

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

		$rows = $this->display()->item_data( array(), $line );

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

		$rows = $this->display()->item_data( array(), $line );

		$this->assertSame( 'opt-a', $rows[0]['key'] );
	}

	// --- Registration --------------------------------------------------------

	/**
	 * One registration serves both cart worlds.
	 */
	public function test_registers_once_for_both_carts(): void {
		$this->display()->register();

		$this->assertCount( 1, $GLOBALS['optionia_test_filters'][ CartDisplay::HOOK ] ?? array() );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * 🔴 **A multi-select is ONE row, naming every chosen value and one price.**
	 *
	 * ⚠️ **This asserted the opposite until M18.3.** While the fence stood the
	 * line showed nothing; before the fence it showed the raw option id and the
	 * word `"Array"`, because `$label['option']` is null for a list and
	 * `(string)` on an array coerces. Measured here now: `Extras` /
	 * `Red, Blue (+£3.00)`.
	 *
	 * 🔴 **One row, not two**, and one summed price beside it — the reason
	 * ADR-061 keyed `deltas` by option and summed across values rather than
	 * keeping a per-value list. A per-value list would have no row to render
	 * itself into.
	 */
	public function test_a_multi_select_is_one_row_naming_every_value(): void {
		$rows = $this->many_rows( array( 'red', 'blue' ) );

		$this->assertCount( 1, $rows );
		$this->assertSame( 'Extras', $rows[0]['key'] );
		$this->assertSame( 'Red, Blue (+£3.00)', $rows[0]['value'] );
	}

	/**
	 * 🔴 **The row never contains the string "Array".**
	 *
	 * Asserted separately from the exact text because this is the defect, and a
	 * later change to the separator or the price format should not be able to
	 * take the guard with it.
	 */
	public function test_a_multi_select_row_never_coerces_an_array(): void {
		$rows = $this->many_rows( array( 'red', 'blue' ) );

		$this->assertStringNotContainsString( 'Array', $rows[0]['value'] );
		$this->assertStringNotContainsString( 'opt-a', $rows[0]['key'] );
	}

	/**
	 * ⚠️ The control: a single-value line still renders its row and price.
	 *
	 * Without it, the assertion above would be satisfied by a display that had
	 * stopped rendering anything.
	 */
	public function test_a_single_value_line_still_shows_its_row(): void {
		$this->store_many_config( 'one' );

		$rows = $this->display()->item_data( array(), $this->many_line( 'red' ) );

		$this->assertCount( 1, $rows );
		$this->assertSame( 'Extras', $rows[0]['key'] );
		$this->assertSame( 'Red (+£1.00)', $rows[0]['value'] );
	}

	/**
	 * 🔴 **One row per OPTION, with one price beside it.**
	 *
	 * The measurement ADR-061 turns on for this consumer: the display asks for
	 * an option's *total* contribution, never "what did the second chosen value
	 * cost?". That is why `deltas` becomes summed-per-option rather than a
	 * per-value list — a list would have no row to render itself into.
	 *
	 * 📌 **M18.2 must keep this shape.** A multi-select row reads
	 * `Extras: Red, Blue (+£3.00)` — one row, one summed price.
	 */
	public function test_a_row_carries_one_price_for_one_option(): void {
		$this->store_many_config( 'one' );

		$rows = $this->display()->item_data( array(), $this->many_line( 'red' ) );

		$this->assertCount( 1, $rows );
		$this->assertArrayHasKey( 'key', $rows[0] );
		$this->assertArrayHasKey( 'value', $rows[0] );
	}

	/**
	 * Rows for a line answering the `many` option however the caller says.
	 *
	 * @param mixed $answer What the customer submitted.
	 * @return array<int, array<string, mixed>>
	 */
	private function many_rows( $answer ): array {
		$this->store_many_config();

		return $this->display()->item_data( array(), $this->many_line( $answer ) );
	}

	/**
	 * A line built by the real writer against the multi-select configuration.
	 *
	 * @param mixed $answer What the customer submitted for `opt-a`.
	 * @return array<string, mixed>
	 */
	private function many_line( $answer ): array {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => $answer );

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
	 * A configuration whose only option declares the given cardinality.
	 *
	 * 🔴 **The net M18.1 did not have** — `cardinality` appeared in no consumer
	 * suite, so a multi-select could break the displayed breakdown with every
	 * test here green.
	 *
	 * @param string $cardinality What the option declares.
	 */
	private function store_many_config( string $cardinality = 'many' ): void {
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
										'type'        => 'checkbox',
										'cardinality' => $cardinality,
										'label'       => 'Extras',
										'values'      => array(
											array(
												'value_key' => 'red',
												'label' => 'Red',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 100,
												),
											),
											array(
												'value_key' => 'blue',
												'label' => 'Blue',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 200,
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
			'W/"many-' . $cardinality . '"'
		);
	}

	/**
	 * Display rows for a standard line.
	 *
	 * @param int $lux_minor The `lux` option's amount.
	 * @return array<int, array<string, mixed>>
	 */
	private function rows( int $lux_minor = 2000 ): array {
		return $this->display()->item_data( array(), $this->line( $lux_minor ) );
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
	 * 🔴 **The base, so the breakdown adds up** (M21b.1).
	 *
	 * Without it a customer reads `Finish: Luxury (+£10.50)` beside a line total
	 * of 110.50 and has to infer the 100 — the arithmetic this phase exists to
	 * stop them doing.
	 */
	public function test_an_itemised_line_states_the_base_price(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertSame( 'Base price', $rows[0]['key'] );
		$this->assertSame( '£100.00', $rows[0]['value'] );
	}

	/**
	 * ⚠️ **Omitted when zero, not printed as `0.00`.** A product with no price
	 * of its own is a configuration a merchant should see as blank rather than
	 * as free.
	 */
	public function test_a_product_with_no_price_states_no_base(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '0' );

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		foreach ( $rows as $row ) {
			$this->assertNotSame( 'Base price', $row['key'] );
		}
	}

	/**
	 * 🔴 **One "customisation" line instead of one per option** (ADR-110).
	 *
	 * A storefront preference, not an option-set one: a product carrying two
	 * sets must render one way.
	 */
	public function test_the_subtotal_mode_sums_every_selection(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->subtotal_display()->item_data( array(), $this->line( 1050 ) );

		$this->assertSame( 'Base price', $rows[0]['key'] );
		$this->assertSame( 'Customisation', $rows[1]['key'] );
		$this->assertSame( '+£10.50', $rows[1]['value'] );
	}

	/**
	 * ⚠️ **The two modes must agree about the amount.** A merchant switching
	 * between them should see the presentation change, never the number.
	 */
	public function test_both_modes_report_the_same_contribution(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$itemised = $this->display()->item_data( array(), $this->line( 1050 ) );
		$subtotal = $this->subtotal_display()->item_data( array(), $this->line( 1050 ) );

		$this->assertStringContainsString( '10.50', (string) $itemised[1]['value'] );
		$this->assertStringContainsString( '10.50', (string) $subtotal[1]['value'] );
	}

	/**
	 * 🔴 **A free choice still priced, and both modes must say so.**
	 *
	 * ✏️ **This asserted the row vanished.** That was the `with_price()` rule
	 * borrowed one level up, where it means something else: there a zero says
	 * *"this choice is free"*, and summed across a line it would say *"nothing
	 * priced"* — which is a different and false claim when an option did price.
	 */
	public function test_both_modes_report_a_free_choice(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$itemised = $this->display()->item_data( array(), $this->line( 0 ) );
		$subtotal = $this->subtotal_display()->item_data( array(), $this->line( 0 ) );

		/*
		 * Itemised still lists the choice — it just carries no price suffix,
		 * because `with_price()` suppresses a zero. Subtotal must not hide the
		 * fact that an option priced at all, so it reports `+0.00` rather than
		 * vanishing: the two modes agree that something was priced.
		 */

		/*
		 * Base plus both options itemised; base plus one customisation line in
		 * subtotal. ✏️ **This expected two rows each** — written while a leaked
		 * settings option was quietly running the itemised case in subtotal
		 * mode, so the expectation was fitted to a bug rather than to the rule.
		 */
		$this->assertCount( 3, $itemised );
		$this->assertCount( 2, $subtotal );
		$this->assertSame( 'Base price', $subtotal[0]['key'] );
		$this->assertSame( 'Customisation', $subtotal[1]['key'] );
	}

	// --- The supported integration point (M21b.5) ----------------------------

	/**
	 * 🔴 **The one supported way another plugin reaches this breakdown**
	 * (ADR-111). Before it, a cart drawer had a choice between copying
	 * `SelectionResolver` and scraping the DOM — and the plugin exposed exactly
	 * **one** filter in total, for template resolution.
	 */
	public function test_an_integration_can_adjust_the_rows(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows ): array {
				return array_slice( $rows, 0, 1 );
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertCount( 1, $rows );
		$this->assertSame( 'Base price', $rows[0]['key'] );
	}

	/**
	 * ⚠️ **The filter sees the cart item**, so an integration can decide per
	 * line rather than per store — a drawer that renders one product specially
	 * cannot be written against rows alone.
	 */
	public function test_the_filter_receives_the_cart_item(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$seen = null;

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows, $cart_item ) use ( &$seen ): array {
				$seen = $cart_item;

				return $rows;
			},
			10,
			2
		);

		$this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertIsArray( $seen );
		$this->assertArrayHasKey( Keys::CART_ITEM_KEY, (array) $seen );
	}

	/**
	 * 🔴 **AC4 applies to a filter as much as to a document.** A callback
	 * returning something other than a list is ignored rather than trusted:
	 * *"anything unrecognised must degrade to correct totals with a plain
	 * breakdown, never to a wrong number."*
	 *
	 * A cart rendering nothing because an integration returned `null` is worse
	 * than one that ignores it.
	 */
	public function test_a_malformed_return_is_ignored(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function () {
				return null;
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertNotSame( array(), $rows );
		$this->assertSame( 'Base price', $rows[0]['key'] );
	}

	/**
	 * 🔴 **A callback's bad row must not reach either cart** (F17).
	 *
	 * `CartItemSchema::get_item_data()` discards the **whole element** when any
	 * value is not scalar — silently — while the classic template renders it.
	 * Measured before the row guard existed: a callback appending a row whose
	 * `value` was an array produced **four rows on classic and three on
	 * blocks**, which is the divergence this class opens by describing.
	 */
	public function test_a_row_with_a_non_scalar_value_is_dropped(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows ): array {
				$rows[] = array(
					'key'   => 'Gift note',
					'value' => array( 'a', 'b' ),
				);

				return $rows;
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		foreach ( $rows as $row ) {
			$this->assertIsScalar( $row['value'] );
			$this->assertIsScalar( $row['key'] );
		}

		$this->assertNotContains( 'Gift note', array_column( $rows, 'key' ) );
	}

	/**
	 * ⚠️ **One bad row costs that row, not the whole integration.** Discarding
	 * everything a callback returned over a single malformed entry would throw
	 * away correct work a merchant installed on purpose.
	 */
	public function test_a_good_row_survives_alongside_a_bad_one(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows ): array {
				$rows[] = array(
					'key'   => 'Broken',
					'value' => array( 'x' ),
				);
				$rows[] = array(
					'key'   => 'Gift message',
					'value' => 'Happy birthday',
				);

				return $rows;
			},
			10,
			2
		);

		$keys = array_column( $this->display()->item_data( array(), $this->line( 1050 ) ), 'key' );

		$this->assertContains( 'Gift message', $keys );
		$this->assertNotContains( 'Broken', $keys );
	}

	/**
	 * 🔴 **A hand-built row gets this class's own output rules.**
	 *
	 * An integration that returns a bare `key`/`value` pair has not set
	 * `display` or either hidden key. Without normalising, its row would render
	 * **unescaped** on the classic cart and be hidden by neither surface — the
	 * filter would have become a way around the escaping every other row gets.
	 */
	public function test_a_hand_built_row_is_escaped_and_carries_both_hidden_keys(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows ): array {
				$rows[] = array(
					'key'   => 'Engraving',
					'value' => '<img src=x onerror=alert(1)>',
				);

				return $rows;
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );
		$last = end( $rows );

		$this->assertSame( 'Engraving', $last['key'] );
		$this->assertStringNotContainsString( '<img', $last['display'] );
		$this->assertArrayHasKey( self::BLOCK_HIDDEN_KEY, $last );
		$this->assertFalse( $last['hidden'] );
	}

	/**
	 * ⚠️ **Rows this class did not build are passed through untouched.**
	 *
	 * The classic cart hands the filter WooCommerce's own rows — variation
	 * attributes, and rows from other plugins. Normalising those through
	 * `row()` stamped Optionia's keys onto another plugin's data; five existing
	 * tests caught it. A row that arrives unchanged must leave unchanged.
	 */
	public function test_an_untouched_foreign_row_is_not_rewritten(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$foreign = array(
			'key'   => 'Size',
			'value' => 'Large',
		);

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows ): array {
				return $rows;
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array( $foreign ), $this->line( 1050 ) );

		$this->assertSame( $foreign, $rows[0] );
	}

	/**
	 * 🔴 **A callback that leaves nothing usable is ignored** (AC4).
	 *
	 * *"Anything unrecognised must degrade to correct totals with a plain
	 * breakdown, never to a wrong number"* — and a line showing no breakdown at
	 * all, beside a total that includes the options, is a wrong number by
	 * omission.
	 */
	public function test_a_callback_returning_only_rubbish_is_ignored(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function (): array {
				return array( 'not a row', 42 );
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertNotSame( array(), $rows );
		$this->assertSame( 'Base price', $rows[0]['key'] );
	}

	/**
	 * ⚠️ **A non-array element is dropped without taking the good rows with
	 * it.** A callback that appends a bare string beside real rows must not put
	 * a scalar where both carts expect a `key`/`value` pair — `wc_get_formatted_
	 * cart_item_data()` reads `$data['key']` on the classic side and would emit
	 * a PHP warning on a string.
	 *
	 * Written because a mutation removing the `is_array()` row check
	 * **survived**: the only test exercising it returned rubbish *exclusively*,
	 * so the empty-result fallback masked the missing guard.
	 */
	public function test_a_non_array_element_is_dropped_beside_good_rows(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function ( array $rows ): array {
				$rows[] = 'not a row at all';

				return $rows;
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertNotSame( array(), $rows );

		foreach ( $rows as $row ) {
			$this->assertIsArray( $row );
		}
	}

	/**
	 * ⚠️ **But an honest empty answer stays empty.** A line with no options has
	 * no rows to show, and a callback agreeing must not be overridden into
	 * printing something.
	 */
	public function test_an_empty_result_on_an_empty_line_stays_empty(): void {
		add_filter(
			'optionia_cart_item_rows',
			static function (): array {
				return array();
			},
			10,
			2
		);

		$this->assertSame( array(), $this->display()->item_data( array(), array( 'product_id' => 7 ) ) );
	}

	/**
	 * 🔴 **A drawer that renders its own markup can say "none"** (F20).
	 *
	 * The README's own use case — *"a cart drawer that renders its own
	 * markup"* — could not be served by `optionia_cart_item_rows` alone:
	 * returning an empty array is indistinguishable from a callback that
	 * crashed, and `sanitise()` restores the breakdown rather than let a broken
	 * integration leave a customer reading an unexplained total. Suppression is
	 * declared here instead, which is a sentence only written on purpose.
	 */
	public function test_an_integration_can_suppress_every_row(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_rows_suppressed',
			static function (): bool {
				return true;
			},
			10,
			2
		);

		$this->assertSame( array(), $this->display()->item_data( array(), $this->line( 1050 ) ) );
	}

	/**
	 * ⚠️ **Suppressing Optionia's breakdown is not licence to erase another
	 * plugin's row.** The classic cart hands this filter WooCommerce's own
	 * variation attributes; a drawer hiding option rows must leave those alone.
	 */
	public function test_suppression_leaves_foreign_rows_alone(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$foreign = array(
			'key'   => 'Size',
			'value' => 'Large',
		);

		add_filter(
			'optionia_cart_rows_suppressed',
			static function (): bool {
				return true;
			},
			10,
			2
		);

		$this->assertSame(
			array( $foreign ),
			$this->display()->item_data( array( $foreign ), $this->line( 1050 ) )
		);
	}

	/**
	 * ⚠️ **Only `true` suppresses.** A callback returning a truthy string or a
	 * `1` has probably returned the wrong variable, and this is the filter that
	 * blanks a breakdown — the one place to read a loose value strictly.
	 */
	public function test_a_truthy_non_boolean_does_not_suppress(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_rows_suppressed',
			static function () {
				return 'yes';
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertNotSame( array(), $rows );
		$this->assertSame( 'Base price', $rows[0]['key'] );
	}

	/**
	 * 🔴 **The distinction F20 turned on: an empty return is still not
	 * suppression.** A callback that returns nothing without declaring
	 * suppression is treated as broken, and the plain breakdown is shown.
	 */
	public function test_an_empty_return_without_the_opt_out_still_restores_rows(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		add_filter(
			'optionia_cart_item_rows',
			static function (): array {
				return array();
			},
			10,
			2
		);

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertNotSame( array(), $rows );
		$this->assertSame( 'Base price', $rows[0]['key'] );
	}

	/**
	 * ⚠️ **The opt-out sees the cart item**, so a drawer can suppress one line
	 * rather than the whole store.
	 */
	public function test_the_opt_out_receives_the_cart_item(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$seen = null;

		add_filter(
			'optionia_cart_rows_suppressed',
			static function ( $suppressed, $cart_item ) use ( &$seen ) {
				$seen = $cart_item;

				return $suppressed;
			},
			10,
			2
		);

		$this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertIsArray( $seen );
		$this->assertArrayHasKey( Keys::CART_ITEM_KEY, (array) $seen );
	}

	// --- How money is written (M21b.3) ---------------------------------------

	/**
	 * 🔴 **The cart writes money the way the storefront writes it.**
	 *
	 * ✏️ **It printed `Money::to_decimal_string()`** — documented as *"suitable
	 * for handing back to WooCommerce"*, a **wire** format. So a breakdown read
	 * `10.50` beside a storefront label reading `10.50`, and a store with comma
	 * decimals saw them on one surface and not the other. Nothing caught it:
	 * eight assertions pinned the **numbers** and none pinned the **format**.
	 *
	 * `OptionView::money()` is shared rather than copied, so a store's
	 * separators cannot be right on one surface and wrong on the other.
	 */
	public function test_a_price_is_written_the_way_the_storefront_writes_it(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertSame( OptionView::money( 10000 ), $rows[0]['value'] );
		$this->assertSame( 'Luxury (+' . OptionView::money( 1050 ) . ')', $rows[1]['value'] );
	}

	/**
	 * ⚠️ **Zero carries no sign.** It reaches `signed()` only when a line's
	 * contributions cancel (F11), and `-0.00` would read as a discount of
	 * nothing — which a customer checking their total would have to stop and
	 * puzzle over.
	 */
	public function test_a_cancelled_contribution_carries_no_sign(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->subtotal_display()->item_data( array(), $this->offsetting_line() );

		$this->assertSame( OptionView::money( 0 ), $rows[1]['value'] );
	}

	/**
	 * 📌 **Tax is deliberately absent, on every surface.** `PRICING-SPEC.md`:
	 * *"the figure above is given in the store's own convention and
	 * inclusive/exclusive correctness follows. A plugin that adjusts for tax
	 * here taxes twice."* The storefront label and the JS estimate are tax-blind
	 * for the same reason, so this pins a **system** property rather than one
	 * class's behaviour.
	 */
	public function test_the_breakdown_does_not_adjust_for_tax(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$GLOBALS['optionia_test_prices_include_tax'] = true;
		$inclusive                                   = $this->display()->item_data( array(), $this->line( 1050 ) );

		$GLOBALS['optionia_test_prices_include_tax'] = false;
		$exclusive                                   = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertSame( $exclusive[0]['value'], $inclusive[0]['value'] );
		$this->assertSame( $exclusive[1]['value'], $inclusive[1]['value'] );
	}

	// --- The four core cart surfaces (M21b.2) --------------------------------

	/**
	 * 🔴 **One filter serves all four core surfaces**, verified in WooCommerce's
	 * own source rather than assumed:
	 *
	 * ```text
	 * wc-template-functions.php:4538   wc_get_formatted_cart_item_data()
	 *                                    → classic cart template
	 *                                    → mini-cart widget (mini-cart.php:80)
	 * CartItemSchema.php:170           Store API
	 *                                    → Cart block
	 *                                    → Checkout block order summary
	 * ```
	 *
	 * So M21b.2 is **verification, not implementation**: a row that is correct
	 * here is correct in all four, and a row that is wrong is wrong in all four.
	 * What differs between them is not the data but what each does with a row it
	 * dislikes — which is what the next two tests pin.
	 */
	public function test_every_row_survives_the_store_api_scalar_filter(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		$this->assertNotSame( array(), $rows );

		foreach ( $rows as $row ) {
			foreach ( $row as $value ) {
				/*
				 * `CartItemSchema::get_item_data()` discards the **whole
				 * element** if any value is not scalar — silently, with no error
				 * and no log line. A developer testing only the classic cart
				 * ships that and never sees it.
				 */
				$this->assertIsScalar( $value );
			}
		}
	}

	/**
	 * ⚠️ **Each surface reads a different "hidden" key**, and a row must be
	 * visible in both worlds or the breakdown exists on one and not the other.
	 */
	public function test_every_row_is_visible_in_both_cart_worlds(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );

		foreach ( $rows as $row ) {
			$this->assertArrayHasKey( 'hidden', $row );
			$this->assertArrayHasKey( '__experimental_woocommerce_blocks_hidden', $row );
			$this->assertFalse( $row['hidden'] );
			$this->assertFalse( $row['__experimental_woocommerce_blocks_hidden'] );
		}
	}

	/**
	 * 🔴 **The base row must survive both too.** It is the row M21b.1 added, so
	 * it is the one with no history of being rendered on either surface.
	 */
	public function test_the_base_row_is_scalar_and_visible(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->display()->item_data( array(), $this->line( 1050 ) );
		$base = $rows[0];

		$this->assertSame( 'Base price', $base['key'] );
		$this->assertIsScalar( $base['value'] );
		$this->assertIsScalar( $base['display'] );
		$this->assertFalse( $base['hidden'] );
		$this->assertFalse( $base['__experimental_woocommerce_blocks_hidden'] );
	}

	/**
	 * 🔴 **Offsetting prices must not erase the row** (F11).
	 *
	 * A `+10.50` option beside a `-10.50` discount sums to **zero**, and the
	 * first version tested `0 !== $total` — so the row vanished and a customer
	 * saw a base price with no sign that two options had priced at all.
	 * Itemised mode listed both, so the modes disagreed about **visibility**
	 * while agreeing about the amount.
	 *
	 * ⚠️ **Reachable, not theoretical.** `PRICING-SPEC.md`: *"a discount is
	 * expressed by a negative `amount_minor`"*.
	 */
	public function test_offsetting_prices_still_report_a_customisation(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->subtotal_display()->item_data( array(), $this->offsetting_line() );

		$this->assertSame( 'Base price', $rows[0]['key'] );
		$this->assertSame( 'Customisation', $rows[1]['key'] );
		$this->assertSame( '£0.00', $rows[1]['value'] );
	}

	/**
	 * ⚠️ **And itemised mode still lists both**, so the two agree that
	 * something priced even when the amounts cancel.
	 */
	public function test_itemised_lists_both_offsetting_choices(): void {
		optionia_test_product( self::PRODUCT_ID, 'simple', '100.00' );

		$rows = $this->display()->item_data( array(), $this->offsetting_line() );

		/* Base, plus one row per option — the discount signed by `Money`. */
		$this->assertCount( 3, $rows );
		$this->assertSame( 'Luxury (+£10.50)', $rows[1]['value'] );
		$this->assertSame( 'Yes (-£10.50)', $rows[2]['value'] );
		$this->assertSame( 'Luxury (+£10.50)', $rows[1]['value'] );
		$this->assertSame( 'Yes (-£10.50)', $rows[2]['value'] );
	}

	/**
	 * A line whose two options price `+10.50` and `-10.50`.
	 *
	 * @return array<string, mixed>
	 */
	private function offsetting_line(): array {
		$this->store_offsetting_config();

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'yes',
		);

		$line = ( new CartItemData( $this->repository() ) )->attach( array(), self::PRODUCT_ID, 0, 1 );

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		/*
		 * ⚠️ **`attach()` returns only the optionia payload**, so the ids a real
		 * cart item carries have to be merged in — exactly as `line()` does.
		 * Without `product_id` the base price reads 0 and its row disappears,
		 * which is a test failure that blames the code for the fixture.
		 */
		return array_merge(
			$line,
			array(
				'product_id' => self::PRODUCT_ID,
				'quantity'   => 1,
			)
		);
	}

	/**
	 * A configuration whose second option is a discount of the same size.
	 */
	private function store_offsetting_config(): void {
		$this->store_config( 1050 );

		/*
		 * Re-stored rather than patched in place: `Repository` caches within a
		 * request, so editing the option behind it leaves the cache holding the
		 * old document — which reads as the discount having no effect.
		 */
		$config = get_option( Keys::OPTION_CONFIG, array() );

		$config['option_sets'][0]['groups'][0]['options'][1]['values'][0]['price_config'] = array(
			'type'         => 'fixed',
			'amount_minor' => -1050,
		);

		$this->repository()->store( $config );
	}

	/**
	 * A display in the `subtotal` mode (ADR-110).
	 */
	private function subtotal_display(): CartDisplay {
		$settings = new Settings();
		$settings->save( array( Keys::SETTING_CART_BREAKDOWN => 'subtotal' ) );

		return new CartDisplay( $this->repository(), $settings );
	}

	/**
	 * A display in the default `itemised` mode (M21b.1, ADR-110).
	 *
	 * ⚠️ **Built through one helper, not seventeen constructor calls.** The
	 * breakdown mode arrived as a second constructor argument, and a test file
	 * that repeats a constructor makes every later dependency a seventeen-line
	 * edit. `Settings` with nothing stored returns the fallback, which is the
	 * itemised default.
	 */
	private function display(): CartDisplay {
		return new CartDisplay( $this->repository(), new Settings() );
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
