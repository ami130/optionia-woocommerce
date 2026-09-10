<?php
/**
 * The adversarial suite (M11.7).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Engine\SelectionResolver;
use Optionia\Integration\AddToCartValidator;
use Optionia\Integration\CartItemPayload;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Every tamper attempt M11.7 names, in one place.
 *
 * **Acceptance, in the milestone's own words:** every attack yields either a
 * validation error or the correct price. Never a wrong price. So each test here
 * asserts the *outcome*, and where the request is allowed through it asserts the
 * **number** — Stage 6's audit found an AC4 test that only checked "the request
 * passed", under which a mutation reading `$_POST['delta']` survived with the
 * price wrong and the suite green.
 *
 * Phase 4 ran a subset of these against the prototype and all were repelled.
 * This is the same set against the real validator, plus the cases the prototype
 * could not reach.
 *
 * @covers \Optionia\Integration\AddToCartValidator
 * @covers \Optionia\Engine\SelectionResolver
 */
final class AdversarialAddToCartTest extends TestCase {

	/**
	 * Our product.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * A product belonging to nobody in this store's config.
	 */
	private const FOREIGN_PRODUCT_ID = 99;

	/**
	 * Reset harness state and store this store's configuration.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters']    = array();
		$GLOBALS['optionia_test_notices']    = array();
		$GLOBALS['optionia_test_doing_ajax'] = false;
		unset( $_POST[ Keys::FIELD_PREFIX ], $_REQUEST['add-to-cart'] );

		$this->store_config();
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters']    = array();
		$GLOBALS['optionia_test_notices']    = array();
		$GLOBALS['optionia_test_doing_ajax'] = false;
		$_POST                               = array();
		$_REQUEST                            = array();

		parent::tearDown();
	}

	// --- Injected price fields ----------------------------------------------

	/**
	 * An injected price field is never read, and the total is unchanged.
	 *
	 * The Phase 4 probe's headline attack: `price=1`, `delta=99999`. It is
	 * repelled not by filtering those names but by never consulting the request
	 * for an amount — a stronger guarantee than a blocklist somebody must keep
	 * current.
	 *
	 * @dataProvider provide_price_field_names
	 *
	 * @param string $field Field an attacker might inject.
	 */
	public function test_an_injected_price_field_cannot_change_the_total( string $field ): void {
		$_POST[ $field ] = '1';

		$result = SelectionResolver::resolve( $this->sets(), array( 'opt-a' => 'front' ), 8000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 8500, $result->value()['total_minor'], 'Price came from the request, not the config.' );
	}

	/**
	 * Names a tampered request might use.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_price_field_names(): array {
		return array(
			'price'          => array( 'price' ),
			'delta'          => array( 'delta' ),
			'amount_minor'   => array( 'amount_minor' ),
			'total_minor'    => array( 'total_minor' ),
			'line_total'     => array( 'line_total' ),
			'optionia_price' => array( 'optionia_price' ),
			'cost'           => array( 'cost' ),
			'subtotal'       => array( 'subtotal' ),
			'fee'            => array( 'fee' ),
		);
	}

	/**
	 * A negative injected amount cannot discount the line.
	 */
	public function test_an_injected_negative_amount_cannot_discount(): void {
		$_POST['delta']        = '-999999';
		$_POST['amount_minor'] = '-999999';

		$result = SelectionResolver::resolve( $this->sets(), array( 'opt-a' => 'back' ), 8000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 8750, $result->value()['total_minor'] );
	}

	// --- Tampered keys -------------------------------------------------------

	/**
	 * A modified value key is refused.
	 */
	public function test_a_modified_value_key_is_refused(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front-CHEAP' );

		$this->assertFalse( $this->fire() );
	}

	/**
	 * An option key from another product in the same store is refused.
	 */
	public function test_an_option_key_from_another_product_is_refused(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a'       => 'front',
			'opt-foreign' => 'anything',
		);

		$this->assertFalse( $this->fire() );
	}

	/**
	 * An option key from **another tenant's** store is refused.
	 *
	 * The multi-tenant case, and the one that matters most commercially: the
	 * cache holds exactly one store's configuration, so another tenant's option
	 * ids are simply absent and resolution refuses them. Asserted against a real
	 * second-store fixture rather than an invented key, so the test would fail if
	 * the cache ever merged two stores' documents.
	 */
	public function test_an_option_key_from_another_tenant_is_refused(): void {
		$foreign = $this->foreign_tenant_option_id();

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a'  => 'front',
			$foreign => 'their-value',
		);

		$this->assertFalse( $this->fire() );

		$result = SelectionResolver::resolve( $this->sets(), array( $foreign => 'their-value' ) );

		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_OPTION, $result->first_error_code() );
	}

	/**
	 * A product this store has no configuration for is left alone.
	 *
	 * Not an attack, but the boundary beside it: refusing here would break every
	 * ordinary product in the store.
	 */
	public function test_a_product_without_options_is_not_refused(): void {
		$this->validator()->register();

		$this->assertTrue( apply_filters( AddToCartValidator::HOOK, true, self::FOREIGN_PRODUCT_ID, 1 ) );
	}

	// --- Wrong shapes --------------------------------------------------------

	/**
	 * An array where a scalar is expected is refused.
	 *
	 * The Phase 4 probe sent `probe_finish[]`. It is the shape that makes a naive
	 * `(string)` cast emit a notice and coerce to `"Array"`.
	 */
	public function test_an_array_where_a_scalar_belongs_is_refused(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => array( 'front' ) );

		$this->assertFalse( $this->fire() );
	}

	/**
	 * Deeply nested arrays are refused without recursion.
	 */
	public function test_a_deeply_nested_array_is_refused(): void {
		$nested = 'front';

		for ( $i = 0; $i < 50; $i++ ) {
			$nested = array( $nested );
		}

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => $nested );

		$this->assertFalse( $this->fire() );
	}

	/**
	 * The selection container itself being a scalar is tolerated.
	 *
	 * `optionia=garbage` rather than `optionia[opt-a]=front`. It must refuse
	 * (the required option is missing) rather than error.
	 */
	public function test_a_scalar_selection_container_is_refused_not_fatal(): void {
		$_POST[ Keys::FIELD_PREFIX ] = 'garbage';

		$this->assertFalse( $this->fire() );
	}

	// --- Text content --------------------------------------------------------

	/**
	 * Unicode and emoji in a value key are refused, not mangled.
	 *
	 * M11.7 names these against *text inputs*, which Phase 16 owns — no text type
	 * renders yet (`templates/options/` holds one file). What can be asserted now
	 * is that they cannot be smuggled through a **value key**: the resolver
	 * matches against the cached config's keys, so anything not in that list is
	 * refused whatever its bytes.
	 *
	 * @dataProvider provide_hostile_text
	 *
	 * @param string $value Hostile value key.
	 */
	public function test_hostile_text_in_a_value_key_is_refused( string $value ): void {
		$result = SelectionResolver::resolve( $this->sets(), array( 'opt-a' => $value ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_VALUE, $result->first_error_code() );
	}

	/**
	 * Byte sequences that break naive comparison or storage.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_hostile_text(): array {
		return array(
			'emoji'             => array( '👨‍👩‍👧' ),
			'accented'          => array( 'frönt' ),
			'combining mark'    => array( "fro\xCC\x88nt" ),
			'rtl override'      => array( "front\xE2\x80\xAE" ),
			'zero-width joiner' => array( "fro\xE2\x80\x8Dnt" ),
			'null byte'         => array( "front\x00" ),
			'trailing space'    => array( 'front ' ),
			'leading space'     => array( ' front' ),
			'uppercase'         => array( 'FRONT' ),
			'sql-ish'           => array( "front' OR '1'='1" ),
			'html'              => array( '<script>alert(1)</script>' ),

			/*
			 * `front` alone is deliberately absent: it is the VALID key, and a
			 * provider row asserting it is refused would be asserting the bug.
			 * Oversized input has its own test below, where the length is what
			 * is being exercised rather than the bytes.
			 */
		);
	}

	/**
	 * One option set holding a single free-text option.
	 *
	 * @param array<string, mixed> $extras Extra option fields.
	 * @return array<int, array<string, mixed>>
	 */
	private function text_sets( array $extras = array() ): array {
		return array(
			array(
				'id'     => 'set-a',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array_merge(
								array(
									'id'          => 'opt-t',
									'type'        => 'text_field',
									'label'       => 'Engraving',
									'value_kind'  => 'text',
									'is_required' => false,
									'values'      => array(),
								),
								$extras
							),
						),
					),
				),
			),
		);
	}

	/**
	 * 🔴 **Text breaks the assumption every test above rests on.**
	 *
	 * Every attack in this suite asserts `ERROR_UNKNOWN_VALUE` — the `value_key`
	 * lookup refusing anything a merchant did not author. That lookup is what
	 * made `AddToCartRequest`'s *"nothing here is trusted"* survivable.
	 *
	 * A `text_field` has **no value set**, so *every one of those payloads is
	 * accepted*. The defence is no longer refusal but sanitising, and these
	 * assert what actually survives into the cart.
	 *
	 * @dataProvider provide_hostile_engraving
	 *
	 * @param string $typed    What the customer submits.
	 * @param string $expected What must be stored.
	 */
	public function test_hostile_text_is_sanitised_not_refused( string $typed, string $expected ): void {
		$result = SelectionResolver::resolve( $this->text_sets(), array( 'opt-t' => $typed ) );

		$this->assertTrue( $result->is_ok(), 'Typed text is accepted; the defence is sanitising, not refusal.' );
		$this->assertSame( $expected, $result->value()['resolved']['opt-t'] ?? '' );
	}

	/**
	 * Hostile input a customer can type into an engraving field.
	 *
	 * @return array<string, array{string, string}>
	 */
	public static function provide_hostile_engraving(): array {
		return array(
			// Markup is stripped, contents and all.
			'script tag'     => array( '<script>alert(1)</script>Bob', 'Bob' ),
			'uppercase tag'  => array( '<SCRIPT>alert(1)</SCRIPT>Bob', 'Bob' ),
			'style tag'      => array( '<style>body{x:1}</style>Bob', 'Bob' ),
			'bold tag'       => array( '<b>Bob</b>', 'Bob' ),
			'onclick attr'   => array( '<a href="x" onclick="y()">Bob</a>', 'Bob' ),

			// Control characters and nulls are removed; the text survives.
			'null byte'      => array( "Bob\x00", 'Bob' ),
			'bell character' => array( "Bo\x07b", 'Bob' ),

			/*
			 * ⚠️ **Not everything hostile-looking is refused, deliberately.**
			 * An apostrophe and the word OR are ordinary characters a customer
			 * may want engraved; the protection against SQL injection is
			 * parameterised queries, not a blocklist that would refuse
			 * "O'Brien". Storage is safe; display escapes.
			 */
			'sql-looking'    => array( "O'Brien OR 1=1", "O'Brien OR 1=1" ),
			'ampersand'      => array( 'Mum & Dad', 'Mum & Dad' ),

			// Inner spacing is engraved and survives; the ends do not.
			'inner spaces'   => array( 'Mum  &  Dad', 'Mum  &  Dad' ),
			'outer spaces'   => array( '   Bob   ', 'Bob' ),
		);
	}

	/**
	 * 🔴 **A megabyte engraving is refused even with no limit configured.**
	 *
	 * Measured before the ceiling existed: **1,000,000 characters** were accepted
	 * and stored — into cart session storage and then order meta — because
	 * `max_length` is optional and nothing else capped it. It resolved in 5ms, so
	 * this is a storage attack rather than a CPU one, and it lands on a merchant
	 * who simply never opened the field.
	 *
	 * `ABSOLUTE_MAX_LENGTH` is the backstop for *absent* configuration. It equals
	 * the ceiling the API's schema already puts on `maxLength`, so no
	 * configuration a merchant can express is affected.
	 *
	 * @dataProvider provide_oversized_engraving
	 *
	 * @param int $length Characters submitted.
	 */
	public function test_an_unbounded_engraving_is_refused( int $length ): void {
		$result = SelectionResolver::resolve(
			$this->text_sets(),
			array( 'opt-t' => str_repeat( 'a', $length ) )
		);

		$this->assertFalse( $result->is_ok(), "{$length} characters must not be accepted." );
		$this->assertSame( SelectionResolver::ERROR_TOO_LONG, $result->first_error_code() );
	}

	/**
	 * Lengths that must be refused when no limit is configured.
	 *
	 * @return array<string, array{int}>
	 */
	public static function provide_oversized_engraving(): array {
		return array(
			'just over the ceiling' => array( 5001 ),
			'a hundred kilobytes'   => array( 100000 ),
			'a megabyte'            => array( 1000000 ),
		);
	}

	/** At the ceiling exactly, with no limit configured, is still accepted. */
	public function test_text_at_the_absolute_ceiling_is_accepted(): void {
		$result = SelectionResolver::resolve(
			$this->text_sets(),
			array( 'opt-t' => str_repeat( 'a', 5000 ) )
		);

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * ⚠️ **A merchant cannot raise the ceiling from a document.**
	 *
	 * The API caps `maxLength` at 5000, so a larger number in a config document
	 * did not come from the dashboard — a hand-edited cache, or a compromised
	 * delivery. The resolver takes the lower of the two rather than trusting it.
	 */
	public function test_a_document_cannot_raise_the_ceiling(): void {
		$result = SelectionResolver::resolve(
			$this->text_sets( array( 'validation' => array( 'max_length' => 999999 ) ) ),
			array( 'opt-t' => str_repeat( 'a', 6000 ) )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_TOO_LONG, $result->first_error_code() );
	}

	/**
	 * Several text options, each within its own limit.
	 *
	 * @param int $count Number of text options.
	 * @param int $chars Characters submitted to each.
	 * @return array{array<int, array<string, mixed>>, array<string, string>}
	 */
	private function many_text_options( int $count, int $chars ): array {
		$options    = array();
		$selections = array();

		for ( $i = 0; $i < $count; $i++ ) {
			$options[]                = array(
				'id'          => "opt-{$i}",
				'type'        => 'text_field',
				'label'       => "Engraving {$i}",
				'value_kind'  => 'text',
				'is_required' => false,
				'values'      => array(),
			);
			$selections[ "opt-{$i}" ] = str_repeat( 'a', $chars );
		}

		return array(
			array(
				array(
					'id'     => 'set-a',
					'groups' => array(
						array(
							'id'      => 'group-a',
							'options' => $options,
						),
					),
				),
			),
			$selections,
		);
	}

	/**
	 * 🔴 **A per-option ceiling does not bound a request.**
	 *
	 * `ABSOLUTE_MAX_LENGTH` caps one field at 5000 **graphemes**, and neither
	 * half of that is what storage costs. Measured before the budget existed:
	 *
	 * - **50 options x 5000 characters = 244 KB** accepted in one add-to-cart,
	 *   and `optionsPerGroup` is 200 — so nearer a megabyte per cart line.
	 * - **5000 family emoji = 88 KB**, entirely within a 5000-*character* limit,
	 *   because a grapheme is one engraved mark and may be 18 bytes.
	 *
	 * Neither is an attack: both are configurations a merchant could author. The
	 * budget bounds what a cart session and order meta must hold without telling
	 * anyone their engraving field is too long.
	 */
	public function test_a_flood_of_text_options_is_refused(): void {
		list( $sets, $selections ) = $this->many_text_options( 50, 5000 );

		$result = SelectionResolver::resolve( $sets, $selections );

		$this->assertFalse( $result->is_ok(), '244 KB of text must not be accepted.' );
		$this->assertSame( SelectionResolver::ERROR_TOO_MUCH_TEXT, $result->first_error_code() );
	}

	/**
	 * 🔴 **Graphemes are not bytes, and the budget is in bytes.**
	 *
	 * 5000 family emoji is exactly 5000 characters — within any limit a merchant
	 * can set — and 88 KB on disk.
	 */
	public function test_multibyte_text_within_the_character_limit_is_still_bounded(): void {
		$sets = $this->text_sets();

		$result = SelectionResolver::resolve(
			$sets,
			array( 'opt-t' => str_repeat( "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", 5000 ) )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_TOO_MUCH_TEXT, $result->first_error_code() );
	}

	/**
	 * ⚠️ **Realistic products must still work.** The budget is worthless if it
	 * refuses the orders it exists to protect.
	 *
	 * @dataProvider provide_realistic_text_products
	 *
	 * @param int    $count Number of text options.
	 * @param int    $chars Characters in each.
	 * @param string $label What the product is.
	 */
	public function test_a_realistic_product_is_accepted( int $count, int $chars, string $label ): void {
		list( $sets, $selections ) = $this->many_text_options( $count, $chars );

		$result = SelectionResolver::resolve( $sets, $selections );

		$this->assertTrue( $result->is_ok(), "{$label} must be accepted." );
	}

	/**
	 * Shapes a real order takes, measured against the 64 KB budget.
	 *
	 * @return array<string, array{int, int, string}>
	 */
	public static function provide_realistic_text_products(): array {
		return array(
			'an engraved ring'    => array( 1, 50, 'One short engraving' ),
			'signage, ten fields' => array( 10, 200, 'Ten lines of signage text' ),
			'three max-length'    => array( 3, 5000, 'Three fields at the character ceiling' ),
			'thirteen max-length' => array( 13, 5000, 'Thirteen at the ceiling — 63.5 KB' ),
		);
	}

	/**
	 * The per-option error wins when one field alone is too long.
	 *
	 * A customer who overran *their own* field must be told that, not handed a
	 * whole-request error they cannot act on.
	 */
	public function test_a_single_overlong_field_reports_its_own_error(): void {
		$result = SelectionResolver::resolve(
			$this->text_sets(),
			array( 'opt-t' => str_repeat( 'a', 6000 ) )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_TOO_LONG, $result->first_error_code() );
	}

	/**
	 * 🔴 **A hidden field is the one type whose value a customer must not set.**
	 *
	 * Every other type asks the customer a question. A hidden field carries the
	 * *merchant's* data — a batch code, a fulfilment route — and "hidden" means
	 * hidden from the page, not from anyone with developer tools.
	 *
	 * Measured before the resolver branch existed: a posted `FORGED-BY-CUSTOMER`
	 * replaced the merchant's own `campaign-a`, and nothing said so. This is the
	 * adversarial case for the type, and it belongs here beside the other
	 * forgeries rather than only in the resolver's own suite.
	 *
	 * @dataProvider provide_forged_hidden_values
	 *
	 * @param string $posted What an attacker submits.
	 */
	public function test_a_hidden_value_cannot_be_forged_from_the_request( string $posted ): void {
		$sets = array(
			array(
				'id'     => 'set-a',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array(
								'id'            => 'opt-h',
								'type'          => 'hidden',
								'label'         => 'Fulfilment route',
								'value_kind'    => 'text',
								'is_required'   => false,
								'values'        => array(),
								'default_value' => 'route-standard',
							),
						),
					),
				),
			),
		);

		$result = SelectionResolver::resolve( $sets, array( 'opt-h' => $posted ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame(
			'route-standard',
			$result->value()['resolved']['opt-h'],
			'The merchant configured this value; the request must not change it.'
		);
	}

	/**
	 * Values an attacker might post for a hidden field.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_forged_hidden_values(): array {
		return array(
			'a different route' => array( 'route-express-free' ),
			'markup'            => array( '<script>alert(1)</script>' ),
			'empty'             => array( '' ),
			'a long string'     => array( str_repeat( 'x', 5000 ) ),
		);
	}

	/**
	 * A hundred-kilobyte value key is refused without exhausting memory.
	 */
	public function test_an_oversized_value_key_is_refused(): void {
		$result = SelectionResolver::resolve(
			$this->sets(),
			array( 'opt-a' => str_repeat( 'a', 100000 ) )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_VALUE, $result->first_error_code() );
	}

	/**
	 * A thousand junk selections are all refused, and reported.
	 */
	public function test_a_flood_of_unknown_options_is_refused(): void {
		$flood = array();

		for ( $i = 0; $i < 1000; $i++ ) {
			$flood[ 'junk-' . $i ] = 'x';
		}

		$result = SelectionResolver::resolve( $this->sets(), $flood );

		$this->assertFalse( $result->is_ok() );
		$this->assertGreaterThanOrEqual( 1000, count( $result->get_errors() ) );
	}

	// --- Quantity ------------------------------------------------------------

	/**
	 * Quantity cannot influence the resolved price.
	 *
	 * **WooCommerce owns quantity, and Optionia must not touch it.** Phase 4
	 * confirmed core rejects `-5` and caps `999999` at 9999. The guarantee here
	 * is narrower and is Optionia's own: whatever quantity arrives, the *per-unit*
	 * figure this plugin computes is identical, because quantity never enters
	 * `PRICING-SPEC.md` §3. A plugin that multiplied here would be charging the
	 * option deltas twice once `WC_Cart_Totals` multiplies again.
	 *
	 * @dataProvider provide_hostile_quantities
	 *
	 * @param mixed $quantity Whatever the request carried.
	 */
	public function test_quantity_cannot_change_the_per_unit_price( $quantity ): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->validator()->register();

		$this->assertTrue( apply_filters( AddToCartValidator::HOOK, true, self::PRODUCT_ID, $quantity ) );

		$result = SelectionResolver::resolve( $this->sets(), array( 'opt-a' => 'front' ), 8000 );

		$this->assertSame( 8500, $result->value()['total_minor'], 'Quantity must not enter the per-unit price.' );
	}

	/**
	 * Quantities a tampered request might carry.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_hostile_quantities(): array {
		return array(
			'negative'    => array( -5 ),
			'zero'        => array( 0 ),
			'absurd'      => array( 999999 ),
			'float'       => array( 2.5 ),
			'string'      => array( '3' ),
			'non-numeric' => array( 'lots' ),
			'null'        => array( null ),
			'array'       => array( array( 3 ) ),
		);
	}

	// --- The frozen payload --------------------------------------------------

	/**
	 * A forged frozen delta cannot lower the price.
	 *
	 * The newest attack surface in the plugin, and it is a *stored* one rather
	 * than a request one. `cart_item_data` is not browser-writable — verified in
	 * WC 11.0.1: `WC_AJAX::add_to_cart()` never reads it, the form handler never
	 * fills it from `$_POST`, and the Store API hardcodes
	 * `'cart_item_data' => []`. WooCommerce sessions are server-side, so a
	 * customer cannot edit what is stored either.
	 *
	 * The actor is **another plugin**, writing through
	 * `woocommerce_add_cart_item_data` — the same one Stage 7b named when it
	 * found `base_price_minor` forgeable. The signature is what makes a stored
	 * price checkable without the configuration that produced it, which is gone
	 * the moment a merchant publishes.
	 *
	 * @dataProvider provide_forged_freezes
	 *
	 * @param array<string, mixed> $optionia A payload with one field altered.
	 */
	public function test_a_forged_frozen_payload_is_refused( array $optionia ): void {
		$this->assertNull(
			CartItemPayload::frozen_deltas( array( Keys::CART_ITEM_KEY => $optionia ) ),
			'A payload whose signature does not cover it must not be honoured.'
		);
	}

	/**
	 * One field altered per case, the signature left as it was.
	 *
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function provide_forged_freezes(): array {
		$selections = array( 'opt-a' => 'front' );
		$deltas     = array( 'opt-a' => 500 );

		$genuine = array(
			Keys::CART_ITEM_SELECTIONS     => $selections,
			Keys::CART_ITEM_CONFIG_VERSION => 7,
			Keys::CART_ITEM_DELTAS         => $deltas,
			Keys::CART_ITEM_SIGNATURE      => CartItemPayload::sign( $selections, $deltas, 7 ),
		);

		$cases = array();

		$cases['delta forged negative']                           = $genuine;
		$cases['delta forged negative'][ Keys::CART_ITEM_DELTAS ] = array( 'opt-a' => -100000 );

		$cases['delta forged to zero']                           = $genuine;
		$cases['delta forged to zero'][ Keys::CART_ITEM_DELTAS ] = array( 'opt-a' => 0 );

		$cases['version forged']                                   = $genuine;
		$cases['version forged'][ Keys::CART_ITEM_CONFIG_VERSION ] = 999;

		$cases['selection swapped']                               = $genuine;
		$cases['selection swapped'][ Keys::CART_ITEM_SELECTIONS ] = array( 'opt-a' => 'back' );

		$cases['signature stripped'] = $genuine;
		unset( $cases['signature stripped'][ Keys::CART_ITEM_SIGNATURE ] );

		$cases['signature blanked']                              = $genuine;
		$cases['signature blanked'][ Keys::CART_ITEM_SIGNATURE ] = '';

		$cases['signature from another line']                              = $genuine;
		$cases['signature from another line'][ Keys::CART_ITEM_SIGNATURE ] = CartItemPayload::sign(
			array( 'opt-a' => 'back' ),
			array( 'opt-a' => 750 ),
			7
		);

		$cases['extra option injected']                           = $genuine;
		$cases['extra option injected'][ Keys::CART_ITEM_DELTAS ] = array(
			'opt-a'    => 500,
			'injected' => -99999,
		);

		return array_map( static fn ( array $payload ): array => array( $payload ), $cases );
	}

	/**
	 * A genuine frozen payload is honoured, so the cases above are not passing
	 * because nothing is ever honoured.
	 */
	public function test_a_genuine_frozen_payload_is_honoured(): void {
		$selections = array( 'opt-a' => 'front' );
		$deltas     = array( 'opt-a' => 500 );

		$line = array(
			Keys::CART_ITEM_KEY => array(
				Keys::CART_ITEM_SELECTIONS     => $selections,
				Keys::CART_ITEM_CONFIG_VERSION => 7,
				Keys::CART_ITEM_DELTAS         => $deltas,
				Keys::CART_ITEM_SIGNATURE      => CartItemPayload::sign( $selections, $deltas, 7 ),
			),
		);

		$this->assertSame( $deltas, CartItemPayload::frozen_deltas( $line ) );
	}

	// --- Direct GET bypass ---------------------------------------------------

	/**
	 * `?add-to-cart=41` with no selections is refused.
	 *
	 * WooCommerce reads `$_REQUEST['add-to-cart']`
	 * (`class-wc-form-handler.php:914`) and lands on the **same** three-argument
	 * filter site as the product form (`:981`). So the GET bypass is not a
	 * separate hole: it is site 1 with an empty `$_POST`, and a required option
	 * refuses it. Asserted because "it happens to be the same site" is exactly
	 * the kind of reasoning that stops being true after an upgrade.
	 */
	public function test_a_direct_get_add_to_cart_is_refused(): void {
		$_REQUEST['add-to-cart'] = (string) self::PRODUCT_ID;

		$this->assertFalse( $this->fire(), 'A GET add-to-cart carries no selections and must not pass.' );
	}

	/**
	 * A GET request carrying a forged selection is still resolved, not trusted.
	 */
	public function test_a_get_request_with_a_forged_selection_is_refused(): void {
		$_REQUEST['add-to-cart']     = (string) self::PRODUCT_ID;
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front-FREE' );

		$this->assertFalse( $this->fire() );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Fire the three-argument call site.
	 */
	private function fire(): bool {
		$this->validator()->register();

		return (bool) apply_filters( AddToCartValidator::HOOK, true, self::PRODUCT_ID, 1 );
	}

	/**
	 * A validator over the real repository.
	 */
	private function validator(): AddToCartValidator {
		$logger = new Logger( new Settings() );

		return new AddToCartValidator( new Repository( $logger ), $logger );
	}

	/**
	 * This store's option sets, as the cache holds them.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function sets(): array {
		return ( new Repository( new Logger( new Settings() ) ) )->option_sets_for_product( self::PRODUCT_ID );
	}

	/**
	 * An option id belonging to a different tenant's store.
	 *
	 * Built by storing a second store's document, reading an option id out of it,
	 * then restoring ours — so the id is a real one from a real configuration
	 * rather than a string invented to fail.
	 */
	private function foreign_tenant_option_id(): string {
		$repository = new Repository( new Logger( new Settings() ) );

		$repository->store(
			array(
				'option_sets' => array(
					array(
						'id'          => 'their-set',
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
								'id'      => 'their-group',
								'options' => array(
									array(
										'id'     => 'their-tenant-opt-9',
										'type'   => 'radio',
										'values' => array( array( 'value_key' => 'their-value' ) ),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"other-tenant"'
		);

		$theirs = $repository->option_sets_for_product( self::PRODUCT_ID );
		$id     = (string) $theirs[0]['groups'][0]['options'][0]['id'];

		$this->store_config();

		return $id;
	}

	/**
	 * Store this store's configuration: one required radio, two values.
	 */
	private function store_config(): void {
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
										'id'          => 'opt-a',
										'type'        => 'radio',
										'label'       => 'Print placement',
										'is_required' => true,
										'values'      => array(
											array(
												'value_key' => 'front',
												'label' => 'Front',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 500,
												),
											),
											array(
												'value_key' => 'back',
												'label' => 'Back',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 750,
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
			'W/"store-11"'
		);
	}

	// --- Stock, and the guarantee Optionia makes about it (M16.9) -------------

	/**
	 * 🔴 **A refusal already made is never overturned.**
	 *
	 * M16.9's first acceptance criterion: *"option selection must not bypass
	 * WooCommerce's own stock check; a customer cannot order an out-of-stock
	 * product because they configured it."*
	 *
	 * The plugin contains **no stock logic at all** -- deliberately, because an
	 * option is not a SKU -- so the entire guarantee rests on one line: a
	 * `$passed` that is not `true` is returned unchanged, before any resolution
	 * runs. WooCommerce sets it to `false` for an out-of-stock product, a
	 * quantity above what remains, or a sold-individually item already in the
	 * cart.
	 *
	 * ⚠️ **Nothing asserted it until M16.6.** Every test in this suite passed
	 * `true`, and no test anywhere mentioned stock -- so the guard was one
	 * deletion away from letting an out-of-stock product be ordered, with a
	 * green suite.
	 *
	 * The falsy values are enumerated rather than just `false` because the
	 * filter is public: another plugin may return `0`, `null` or `''`, and
	 * `true !== $passed` treats all of them as a refusal. A `=== false` check
	 * would have let three of the four through.
	 *
	 * The other half of the rule -- that Optionia may turn `true` into `false`
	 * -- is what every other test in this suite asserts. Together: a refusal is
	 * never overturned, and a valid-looking selection is still checked.
	 *
	 * @dataProvider provide_refusals
	 *
	 * @param mixed $verdict What an earlier filter returned.
	 */
	public function test_a_refusal_by_woocommerce_is_never_overturned( $verdict ): void {
		/*
		 * `register()` first, and that is not incidental.
		 *
		 * Without it the filter has no listener and `apply_filters` returns its
		 * input unchanged -- so this test passed while the guard was **deleted
		 * entirely**. Measured: two mutations, the guard removed and `=== false`
		 * substituted for `true !== `, both survived. A test that never reaches
		 * the code it names proves nothing about it.
		 */
		$this->validator()->register();

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		/*
		 * 🔴 **Every arity, not just the three-argument one.**
		 *
		 * `CALL_SITES` names six sites at three arities, and the FIVE-argument
		 * one is `form_handler_variable` -- the variable-product path, which is
		 * exactly the case M16.9 documents as "the variation's stock governs".
		 * Testing only the three-argument site left that claim asserted by
		 * nothing, which is the original defect one layer in.
		 */
		$results = array(
			'3 args, a simple product'   => apply_filters( AddToCartValidator::HOOK, $verdict, self::PRODUCT_ID, 1 ),
			'5 args, a variable product' => apply_filters( AddToCartValidator::HOOK, $verdict, self::PRODUCT_ID, 1, 0, array() ),
			'6 args, the Store API'      => apply_filters( AddToCartValidator::HOOK, $verdict, self::PRODUCT_ID, 1, 0, array(), array() ),
		);

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		foreach ( $results as $site => $passed ) {
			/*
			 * `assertNotTrue`, not `assertFalse( (bool) $passed )`.
			 *
			 * The cast would accept `0` or `''` as a refusal, and WooCommerce
			 * treats anything but `true` as one -- so a change that started
			 * returning a falsy non-boolean would pass a cast-based assertion
			 * while breaking the contract this method documents. The rule is
			 * "not `true`", so that is what is asserted.
			 */
			$this->assertNotTrue(
				$passed,
				sprintf( 'An out-of-stock refusal must survive a valid option selection (%s).', $site )
			);
		}
	}

	/**
	 * Everything WooCommerce or another plugin might return as "no".
	 *
	 * @return array<string, array{0: mixed}>
	 */
	public static function provide_refusals(): array {
		return array(
			'false, as WooCommerce returns'    => array( false ),
			'0, from a plugin using integers'  => array( 0 ),
			'null, from one returning nothing' => array( null ),
			'the empty string'                 => array( '' ),
		);
	}
}
