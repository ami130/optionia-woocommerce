<?php
/**
 * Cart-line identity across a configuration publish (M12.1, GAP 1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartItemKey;
use Optionia\Integration\CartItemPayload;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * A cart line's identity is its selections, not how it was priced.
 *
 * @covers \Optionia\Integration\CartItemKey
 * @covers \Optionia\Integration\CartItemPayload
 */
final class CartItemKeyTest extends TestCase {

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
		$GLOBALS['optionia_test_salt']    = 'test-salt';
		unset( $_POST[ Keys::FIELD_PREFIX ] );
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters'] = array();
		$GLOBALS['optionia_test_salt']    = 'test-salt';
		$_POST                            = array();

		parent::tearDown();
	}

	// --- GAP 1 ---------------------------------------------------------------

	/**
	 * **The same selection merges across a configuration publish.**
	 *
	 * This is GAP 1, and it is the reason this class exists. Without the filter,
	 * `config_version` 7 and 8 hash to different keys, so a customer who adds
	 * "Luxury" on Monday and again on Tuesday — with an unrelated publish in
	 * between — gets two lines of quantity 1 rather than one of quantity 2,
	 * contradicting M12.1's own acceptance criterion.
	 */
	public function test_the_same_selection_merges_across_a_publish(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$before = $this->attach_with( 7, 2000 );
		$after  = $this->attach_with( 8, 9900 );

		$this->assertNotSame(
			$this->core_key( $before ),
			$this->core_key( $after ),
			'Precondition: unfiltered, the payloads differ — that is the bug.'
		);
		$this->assertSame(
			$this->filtered_key( $before ),
			$this->filtered_key( $after ),
			'Filtered, the same selection is the same line.'
		);
	}

	/**
	 * Different selections still produce different lines.
	 *
	 * The half of the guarantee that is easy to lose while fixing the other half:
	 * a filter that merged everything would pass the test above.
	 */
	public function test_different_selections_still_split(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );
		$lux                         = $this->attach_with( 7, 2000 );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'prem' );
		$prem                        = $this->attach_with( 7, 2000 );

		$this->assertNotSame( $this->filtered_key( $lux ), $this->filtered_key( $prem ) );
	}

	/**
	 * Selection key order does not change the line.
	 */
	public function test_selection_order_does_not_change_the_key(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-b' => 'gift',
			'opt-a' => 'lux',
		);
		$one                         = $this->attach_with( 7, 2000 );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'gift',
		);
		$two                         = $this->attach_with( 7, 2000 );

		$this->assertSame( $this->filtered_key( $one ), $this->filtered_key( $two ) );
	}

	// --- Not breaking other plugins ------------------------------------------

	/**
	 * A payload with no Optionia key is returned untouched.
	 *
	 * `woocommerce_cart_id` fires for **every** add-to-cart of every product.
	 * Rewriting a key we have no business rewriting would merge other plugins'
	 * distinct cart lines into one.
	 *
	 * @dataProvider provide_foreign_payloads
	 *
	 * @param array<string, mixed> $cart_item_data A payload Optionia did not write.
	 */
	public function test_a_payload_without_optionia_is_untouched( array $cart_item_data ): void {
		$original = $this->core_key( $cart_item_data );

		$this->assertSame( $original, $this->filtered_key( $cart_item_data ) );
	}

	/**
	 * Payloads Optionia has no business rewriting.
	 *
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function provide_foreign_payloads(): array {
		return array(
			'another plugin only' => array( array( 'gift_wrap' => 'yes' ) ),
			'empty'               => array( array() ),
			'optionia not array'  => array( array( Keys::CART_ITEM_KEY => 'garbage' ) ),
		);
	}

	/**
	 * Another plugin's data still splits lines.
	 *
	 * Two lines that differ only in a competing plugin's field must stay two
	 * lines, even though both carry Optionia selections.
	 */
	public function test_another_plugins_data_still_splits_lines(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$yes         = $this->attach_with( 7, 2000 );
		$yes['gift'] = 'yes';
		$no          = $this->attach_with( 7, 2000 );
		$no['gift']  = 'no';

		$this->assertNotSame( $this->filtered_key( $yes ), $this->filtered_key( $no ) );
	}

	// --- The self-check ------------------------------------------------------

	/**
	 * A changed core algorithm leaves keys alone rather than diverging silently.
	 *
	 * This class reimplements `generate_cart_id()`'s hashing, because there is no
	 * way to ask WooCommerce what it *would* compute from a different payload. If
	 * that algorithm ever changes, ours diverges — and since we return ours,
	 * WooCommerce uses it. Nothing crashes, but sessions holding lines keyed the
	 * old way stop matching, and a customer sees duplicate lines once.
	 *
	 * Simulated by handing the filter a `$cart_id` that our recomputation cannot
	 * reproduce: it must decline to rewrite.
	 */
	public function test_leaves_the_key_alone_when_core_hashes_differently(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$payload = $this->attach_with( 7, 2000 );
		$foreign = 'a-key-this-plugin-could-never-have-computed';

		$this->assertSame(
			$foreign,
			$this->key()->filter( $foreign, self::PRODUCT_ID, 0, array(), $payload )
		);
	}

	// --- Pruning -------------------------------------------------------------

	/**
	 * Pruning removes every audit field and keeps the selections.
	 */
	public function test_pruning_keeps_identity_and_drops_audit_fields(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );

		$pruned = CartItemPayload::prune( $this->attach_with( 7, 2000 ) )[ Keys::CART_ITEM_KEY ];

		$this->assertSame( array( Keys::CART_ITEM_SELECTIONS ), array_keys( $pruned ) );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Store a configuration and attach a cart payload against it.
	 *
	 * @param int $version The document's `config_version`.
	 * @param int $minor   The `lux` option's amount, in minor units.
	 * @return array<string, mixed> Cart item data.
	 */
	private function attach_with( int $version, int $minor ): array {
		$repository = new Repository( new Logger( new Settings() ) );

		$repository->store(
			array(
				'config_version' => $version,
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
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => $minor,
												),
											),
											array(
												'value_key'    => 'prem',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 100,
												),
											),
										),
									),
									array(
										'id'     => 'opt-b',
										'type'   => 'radio',
										'values' => array(
											array(
												'value_key'    => 'gift',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 250,
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
			'W/"v' . $version . '-' . $minor . '"'
		);

		return ( new CartItemData( $repository ) )->attach( array(), self::PRODUCT_ID, 0, 1 );
	}

	/**
	 * `generate_cart_id()`'s hashing, verbatim, for a payload.
	 *
	 * Written out rather than shared with production so a change to the
	 * production copy cannot make both agree on the wrong thing.
	 *
	 * @param array<string, mixed> $cart_item_data Cart item data.
	 * @return string The key WooCommerce would compute.
	 */
	private function core_key( array $cart_item_data ): string {
		$id_parts = array( self::PRODUCT_ID );

		if ( array() !== $cart_item_data ) {
			$data_key = '';

			foreach ( $cart_item_data as $key => $value ) {
				if ( is_array( $value ) || is_object( $value ) ) {
					$value = http_build_query( $value );
				}

				$data_key .= trim( (string) $key ) . trim( (string) $value );
			}

			$id_parts[] = $data_key;
		}

		return md5( implode( '_', $id_parts ) );
	}

	/**
	 * The key after the filter has run.
	 *
	 * @param array<string, mixed> $cart_item_data Cart item data.
	 * @return string The final cart item key.
	 */
	private function filtered_key( array $cart_item_data ): string {
		return $this->key()->filter(
			$this->core_key( $cart_item_data ),
			self::PRODUCT_ID,
			0,
			array(),
			$cart_item_data
		);
	}

	/**
	 * The filter under test.
	 */
	private function key(): CartItemKey {
		return new CartItemKey( new Logger( new Settings() ) );
	}
}
