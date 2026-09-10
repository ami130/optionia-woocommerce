<?php
/**
 * The checkout re-validation boundary (M12.4, GAP 4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CheckoutValidator;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadQuota;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadTokenCheck;
use PHPUnit\Framework\TestCase;

/**
 * A cart line whose option no longer exists must not reach an order.
 *
 * Phase 4 shipped one: order #32, HTTP 200, `"Finish: Luxury"` charged for an
 * option the merchant had already deleted. Nothing re-validated it.
 *
 * @covers \Optionia\Integration\CheckoutValidator
 */
final class CheckoutValidatorTest extends TestCase {

	/**
	 * Product under test.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_notices'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_salt']    = 'test-salt';
		unset( $_POST[ Keys::FIELD_PREFIX ] );
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_notices'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$_POST                            = array();

		parent::tearDown();
	}

	// --- Files that expired while the line sat in the cart --------------------

	/**
	 * 🔴 **A file can expire while the line waits in the cart.**
	 *
	 * `UploadTokenCheck` runs at add-to-cart and nothing re-ran it, while
	 * `ORPHAN_TTL` counts from the *upload*. The 72-hour TTL is deliberately
	 * longer than WooCommerce's 48-hour guest cart — but a logged-in customer's
	 * cart lives in `_woocommerce_persistent_cart_*` user meta and does not
	 * expire on that schedule at all, so it can outlive the file by weeks.
	 *
	 * Without this the expirer deletes the file (the order-meta guard cannot
	 * save it — a cart is not an order), checkout completes, and the merchant
	 * receives an order with no artwork. That is exactly what this class exists
	 * to prevent for a deleted option.
	 */
	public function test_a_file_that_expired_in_the_cart_blocks_checkout(): void {
		$token = str_repeat( 'a', 64 );
		$line  = $this->file_line( $token );

		$GLOBALS['wpdb']->rows = null;

		$this->file_validator()->validate( $this->cart_with( $line ) );

		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'], 'No notice means the order is created.' );
		$this->assertSame( 'error', $GLOBALS['optionia_test_notices'][0]['type'] );
	}

	/**
	 * 🔴 **The message must say "upload it again", not "remove it".**
	 *
	 * The option is perfectly available; the customer's file expired. Telling
	 * them the option is unavailable and asking them to remove the product is
	 * both wrong and the one action that does not fix it.
	 */
	public function test_the_message_asks_for_the_file_rather_than_blaming_the_option(): void {
		$token = str_repeat( 'a', 64 );
		$line  = $this->file_line( $token );

		$GLOBALS['wpdb']->rows = null;

		$this->file_validator()->validate( $this->cart_with( $line ) );

		$message = $GLOBALS['optionia_test_notices'][0]['message'];

		$this->assertStringContainsString( 'upload it again', $message );
		$this->assertStringContainsString( 'Artwork', $message, 'The option must be named.' );
		$this->assertStringNotContainsString( 'no longer available on', $message );
	}

	/** A live file lets checkout proceed. */
	public function test_a_live_file_does_not_block_checkout(): void {
		$token = str_repeat( 'a', 64 );
		$line  = $this->file_line( $token );

		$GLOBALS['wpdb']->rows = array(
			'token'    => $token,
			'order_id' => null,
		);

		$this->file_validator()->validate( $this->cart_with( $line ) );

		$this->assertSame( array(), $GLOBALS['optionia_test_notices'] );
	}

	// --- The blocking behaviour ----------------------------------------------

	/**
	 * **A deleted option blocks checkout.**
	 *
	 * The whole milestone. `woocommerce_check_cart_items` cannot refuse anything
	 * itself — it is a plain action — so the contract is an error notice:
	 * `class-wc-checkout.php:1409` creates no order while
	 * `wc_notice_count( 'error' )` is non-zero, and the Store API converts the
	 * same notice into a 409.
	 */
	public function test_a_deleted_option_blocks_checkout(): void {
		$line = $this->line_then_delete_the_option();

		$this->validator()->validate( $this->cart_with( $line ) );

		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'], 'No notice means the order is created.' );
		$this->assertSame( 'error', $GLOBALS['optionia_test_notices'][0]['type'] );
	}

	/**
	 * The message names the option, using the label snapshotted at add-to-cart.
	 *
	 * M12.8's acceptance: "a message naming the option, not a generic validation
	 * error." The configuration no longer holds the label — that is what being
	 * deleted means — so the name has to come from `Keys::CART_ITEM_LABELS`.
	 */
	public function test_the_message_names_the_option(): void {
		$line = $this->line_then_delete_the_option();

		$this->validator()->validate( $this->cart_with( $line ) );

		$this->assertStringContainsString(
			'Finish',
			$GLOBALS['optionia_test_notices'][0]['message'],
			'An option id like "opt-a" tells a customer nothing.'
		);
	}

	/**
	 * With no snapshotted label, the message is generic rather than absent.
	 *
	 * A line written before labels were stored, or one another plugin wrote.
	 * Blocking still has to happen; only the wording degrades.
	 */
	public function test_a_line_without_labels_still_blocks(): void {
		$line = $this->line_then_delete_the_option();

		unset( $line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ] );

		$this->validator()->validate( $this->cart_with( $line ) );

		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'] );
		$this->assertStringContainsString( 'no longer available', $GLOBALS['optionia_test_notices'][0]['message'] );
	}

	/**
	 * A valid line raises nothing.
	 *
	 * The half that is easy to lose: a validator that blocked everything would
	 * pass every test above.
	 */
	public function test_a_valid_line_is_not_blocked(): void {
		$this->store_config( 'lux' );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'yes',
		);

		$line = array_merge(
			( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array( 'product_id' => self::PRODUCT_ID )
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->validator()->validate( $this->cart_with( $line ) );

		$this->assertSame( array(), $GLOBALS['optionia_test_notices'] );
	}

	/**
	 * A line with no Optionia data is ignored entirely.
	 *
	 * The hook fires for every cart in the store, most of which have nothing to
	 * do with this plugin.
	 */
	public function test_a_line_without_optionia_data_is_ignored(): void {
		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ),
			1,
			array( 'product_id' => self::PRODUCT_ID )
		);

		$this->validator()->validate( $cart );

		$this->assertSame( array(), $GLOBALS['optionia_test_notices'] );
	}

	/**
	 * **The message names only the option that failed.**
	 *
	 * The line carries `Finish` and `Engraving`; only `Finish` was deleted. An
	 * earlier version named both, telling the customer something false about an
	 * option that still works and sending them looking for a problem that did not
	 * exist.
	 */
	public function test_the_message_names_only_the_failing_option(): void {
		$line = $this->line_then_delete_the_option();

		$this->validator()->validate( $this->cart_with( $line ) );

		$message = $GLOBALS['optionia_test_notices'][0]['message'];

		$this->assertStringContainsString( 'Finish', $message );
		$this->assertStringNotContainsString(
			'Engraving',
			$message,
			'Engraving still works; naming it sends the customer after a phantom.'
		);
	}

	/**
	 * **A newly-required option is described as added, not removed.**
	 *
	 * A merchant adding a required option to a product already in someone's cart
	 * is a resolution failure too — but calling it "no longer available" is the
	 * opposite of what happened. Nothing was removed; something was added.
	 */
	public function test_a_newly_required_option_says_it_must_be_chosen(): void {
		$this->store_config( 'lux' );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'yes',
		);

		$line = array_merge(
			( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array( 'product_id' => self::PRODUCT_ID )
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		// The merchant now makes Gift Wrap required.
		$this->store_config( 'lux', true );

		$this->validator()->validate( $this->cart_with( $line ) );

		$message = $GLOBALS['optionia_test_notices'][0]['message'];

		$this->assertStringContainsString( 'must now be chosen', $message );
		$this->assertStringNotContainsString( 'no longer available', $message );
	}

	/**
	 * And it names the new option from the **live** configuration.
	 *
	 * The snapshot cannot hold it — the option did not exist when the line was
	 * written — but the configuration does, right now. Without that fallback the
	 * customer is told to choose `opt-new`, a merchant's slug.
	 */
	public function test_a_newly_required_option_is_named_from_live_config(): void {
		$this->store_config( 'lux' );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'yes',
		);

		$line = array_merge(
			( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array( 'product_id' => self::PRODUCT_ID )
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->store_config( 'lux', true );

		$this->validator()->validate( $this->cart_with( $line ) );

		$this->assertStringContainsString( 'Gift Wrap', $GLOBALS['optionia_test_notices'][0]['message'] );
		$this->assertStringNotContainsString( 'opt-new', $GLOBALS['optionia_test_notices'][0]['message'] );
	}

	// --- Idempotence ---------------------------------------------------------

	/**
	 * **Repeated firing raises one notice, not several.**
	 *
	 * Two of the four call sites are page *views* — the cart and checkout
	 * shortcodes — so a customer sitting on the cart page triggers this
	 * repeatedly. Three copies of the same message is a worse experience than
	 * the problem it describes.
	 */
	public function test_repeated_firing_raises_one_notice(): void {
		$line      = $this->line_then_delete_the_option();
		$cart      = $this->cart_with( $line );
		$validator = $this->validator();

		$validator->validate( $cart );
		$validator->validate( $cart );
		$validator->validate( $cart );

		$this->assertCount( 1, $GLOBALS['optionia_test_notices'] );
	}

	/**
	 * Two broken lines are both reported.
	 *
	 * The de-duplication is per cart item, not per request — a customer with two
	 * unsellable lines needs to know about both.
	 */
	public function test_two_broken_lines_are_both_reported(): void {
		$line = $this->line_then_delete_the_option();

		$cart = optionia_test_cart();
		$cart->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );
		$cart->add_line( 'line-2', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );

		$this->validator()->validate( $cart );

		$this->assertCount( 2, $GLOBALS['optionia_test_notices'] );
	}

	// --- Registration --------------------------------------------------------

	/**
	 * One registration covers every surface that fires the hook.
	 */
	public function test_registers_once_for_every_surface(): void {
		$this->validator()->register();

		$this->assertCount( 1, $GLOBALS['optionia_test_actions'][ CheckoutValidator::HOOK ] ?? array() );
	}

	/**
	 * All four surfaces stay recorded.
	 *
	 * The plan named two — checkout submission and the Store API. The cart and
	 * checkout **shortcodes** fire it too, and those are page views rather than
	 * submissions, which is what makes idempotence a requirement.
	 */
	public function test_records_every_surface_that_fires_the_hook(): void {
		$this->assertSame( 4, CheckoutValidator::call_site_count() );

		foreach ( array( 'checkout_submission', 'cart_page_view', 'checkout_page_view', 'store_api_cart' ) as $site ) {
			$this->assertArrayHasKey( $site, CheckoutValidator::call_sites() );
		}
	}

	/**
	 * Firing the hook runs the validator.
	 *
	 * Driven through `do_action()` rather than by calling `validate()`, so the
	 * registration itself is exercised.
	 */
	public function test_firing_the_hook_blocks_a_broken_line(): void {
		$line = $this->line_then_delete_the_option();
		$cart = $this->cart_with( $line );

		$this->validator()->register();

		do_action( CheckoutValidator::HOOK, $cart );

		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'] );
	}

	// --- Boundaries ----------------------------------------------------------

	/**
	 * A product whose configuration has gone entirely is refused.
	 *
	 * The merchant unassigned the set, or the plugin was disconnected. The line
	 * still claims options, so it is exactly as unsellable as a deleted one.
	 */
	public function test_a_line_whose_config_vanished_is_refused(): void {
		$line = $this->line_then_delete_the_option();

		( new Repository( new Logger( new Settings() ) ) )->clear();

		$this->validator()->validate( $this->cart_with( $line ) );

		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'] );
	}

	/**
	 * A missing cart neither blocks nor errors.
	 */
	public function test_a_missing_cart_is_tolerated(): void {
		$this->validator()->validate( null );

		$this->assertSame( array(), $GLOBALS['optionia_test_notices'] );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * A cart line added while `lux` existed, after the merchant deleted it.
	 *
	 * @return array<string, mixed> A cart item.
	 */
	private function line_then_delete_the_option(): array {
		$this->store_config( 'lux' );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'lux',
			'opt-b' => 'yes',
		);

		$line = array_merge(
			( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array( 'product_id' => self::PRODUCT_ID )
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->store_config( 'gone' );

		return $line;
	}

	/**
	 * A cart line carrying one file option, and the config that describes it.
	 *
	 * @param string $token The token the line records.
	 * @return array<string, mixed>
	 */
	private function file_line( string $token ): array {
		// Only the file tests need a database; the rest of this suite has none.
		$GLOBALS['wpdb'] = new \Optionia_Test_Wpdb();

		$this->store_file_config();

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-f' => $token );

		$line = array_merge(
			( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )->attach( array(), self::PRODUCT_ID, 0, 1 ),
			array( 'product_id' => self::PRODUCT_ID )
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		return $line;
	}

	/** Store a configuration whose only option is a file. */
	private function store_file_config(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 1,
				'option_sets'    => array(
					array(
						'id'          => 'set-f',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => (string) self::PRODUCT_ID,
								'priority'    => 0,
							),
						),
						'rules'       => array(),
						'groups'      => array(
							array(
								'id'      => 'g',
								'label'   => 'G',
								'options' => array(
									array(
										'id'          => 'opt-f',
										'key'         => 'artwork',
										'type'        => 'file_input',
										'value_kind'  => 'file',
										'label'       => 'Artwork',
										'is_required' => false,
										'values'      => array(),
									),
								),
							),
						),
					),
				),
			),
			'W/"cv-file"'
		);
	}

	/**
	 * A validator whose token check answers from the wpdb stub.
	 */
	private function file_validator(): CheckoutValidator {
		$logger  = new Logger( new Settings() );
		$uploads = new UploadRepository();

		return new CheckoutValidator(
			new Repository( $logger ),
			$logger,
			new UploadTokenCheck( $uploads, new UploadQuota( $uploads ) )
		);
	}

	/**
	 * A cart holding one line.
	 *
	 * @param array<string, mixed> $line A cart item.
	 * @return object The cart double.
	 */
	private function cart_with( array $line ): object {
		$cart = optionia_test_cart();
		$cart->add_line( 'line-1', optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' ), 1, $line );

		return $cart;
	}

	/**
	 * The validator under test.
	 */
	private function validator(): CheckoutValidator {
		$logger = new Logger( new Settings() );

		return new CheckoutValidator( new Repository( $logger ), $logger );
	}

	/**
	 * Store a configuration with two options, and optionally a third.
	 *
	 * **Two options is the point, not padding.** Every earlier version of this
	 * suite used one, which made "name every option on the line" and "name only
	 * the failing one" produce identical output — so the suite could not see that
	 * a broken `Finish` and a working `Engraving` were both being reported as
	 * unavailable.
	 *
	 * @param string $value_key      The value key `opt-a` offers. Change it to simulate a deletion.
	 * @param bool   $extra_required Add a newly-required option the cart line predates.
	 */
	private function store_config( string $value_key, bool $extra_required = false ): void {
		$options = array(
			array(
				'id'     => 'opt-a',
				'type'   => 'radio',
				'label'  => 'Finish',
				'values' => array(
					array(
						'value_key'    => $value_key,
						'label'        => 'Luxury',
						'price_config' => array(
							'type'         => 'fixed',
							'amount_minor' => 2000,
						),
					),
				),
			),
			array(
				'id'     => 'opt-b',
				'type'   => 'radio',
				'label'  => 'Engraving',
				'values' => array(
					array(
						'value_key'    => 'yes',
						'label'        => 'Yes',
						'price_config' => array(
							'type'         => 'fixed',
							'amount_minor' => 500,
						),
					),
				),
			),
		);

		if ( $extra_required ) {
			$options[] = array(
				'id'          => 'opt-new',
				'type'        => 'radio',
				'label'       => 'Gift Wrap',
				'is_required' => true,
				'values'      => array(
					array(
						'value_key' => 'yes',
						'label'     => 'Yes',
					),
				),
			);
		}

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
								'options' => $options,
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"' . $value_key . ( $extra_required ? '-req' : '' ) . '"'
		);
	}
}
