<?php
/**
 * The add-to-cart security boundary (M11.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\AddToCartValidator;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Every call site, exercised at its own arity.
 *
 * `woocommerce_add_to_cart_validation` is applied from five places in WC 11.0.1
 * with three different arities. M11.5's own words: "a missed call site here is
 * not an omission in coverage, it is a path where nothing checks." So each site
 * is driven separately, through `apply_filters()` with exactly the arguments
 * WooCommerce supplies there — never one test standing in for another.
 *
 * @covers \Optionia\Integration\AddToCartValidator
 * @covers \Optionia\Integration\AddToCartRequest
 * @covers \Optionia\Engine\SelectionResolver
 */
final class AddToCartValidatorTest extends TestCase {

	/**
	 * Product id used throughout.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * Reset harness state and store a configuration with one required option.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters']    = array();
		$GLOBALS['optionia_test_notices']    = array();
		$GLOBALS['optionia_test_doing_ajax'] = false;

		$this->store_config();
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters']    = array();
		$GLOBALS['optionia_test_notices']    = array();
		$GLOBALS['optionia_test_doing_ajax'] = false;
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		parent::tearDown();
	}

	// --- Registration --------------------------------------------------------

	/**
	 * Registered exactly once, not once per call site.
	 *
	 * **Measured, and the opposite of the obvious design.** `accepted_args`
	 * belongs to the *registration*, not to the call site, and WordPress runs
	 * every registration at every site. Five registrations therefore ran the
	 * callback five times on each add-to-cart, and the three made at three
	 * arguments never saw `$cart_item_data` — so a perfectly valid reorder was
	 * refused by the three invocations that could not see its selection.
	 */
	public function test_registers_exactly_once(): void {
		$this->validator()->register();

		$this->assertCount(
			1,
			$GLOBALS['optionia_test_filters'][ AddToCartValidator::HOOK ] ?? array(),
			'One registration covers every call site; five would vote against each other.'
		);
	}

	/**
	 * At the widest arity any call site uses — six.
	 *
	 * **This is the assertion that would have caught the milestone's own bug.**
	 * M11.5 said "register with five arguments"; `class-wc-cart-session.php:615`
	 * supplies six, and at five its `$cart_item_data` — the only place the
	 * selection exists on the reorder path — is silently dropped.
	 *
	 * `WP_Hook::apply_filters()` passes everything available when
	 * `accepted_args >= $num_args`, so registering wide costs the shorter sites
	 * nothing: they simply pass fewer, and PHP's defaults fill the rest.
	 */
	public function test_registers_above_the_widest_call_sites_arity(): void {
		$this->validator()->register();

		$registered = $GLOBALS['optionia_test_filters'][ AddToCartValidator::HOOK ][0];

		$this->assertSame( 6, AddToCartValidator::max_accepted_args(), 'Two sites supply six.' );
		$this->assertGreaterThan(
			AddToCartValidator::max_accepted_args(),
			$registered['accepted_args'],
			'Registering AT the maximum makes a seventh argument invisible; the headroom is the detector.'
		);
		$this->assertSame( AddToCartValidator::registered_arity(), $registered['accepted_args'] );
	}

	/**
	 * All six known call sites stay recorded, including the Store API.
	 *
	 * The map is what justifies the arity. It has been wrong four times — two,
	 * three, five, now six — every time because a search covered one directory
	 * less than WooCommerce has. Stage 6 and Stage 7 both grepped `includes/`
	 * and stopped; `src/StoreApi/Utilities/CartController.php:335` was found only
	 * during Phase 12 analysis.
	 */
	public function test_records_every_known_call_site(): void {
		$this->assertSame( 6, AddToCartValidator::call_site_count() );
		$this->assertArrayHasKey(
			'store_api_cart',
			AddToCartValidator::call_sites(),
			'The block cart and block checkout validate through the Store API.'
		);
		$this->assertSame(
			array( 3, 3, 5, 6, 3, 6 ),
			array_values( AddToCartValidator::call_sites() )
		);
	}

	/**
	 * A call site supplying more arguments than we know about is reported.
	 *
	 * The only detector of a **new** WooCommerce call site this plugin can have:
	 * every static check reads our own map, so it can confirm our bookkeeping and
	 * never WooCommerce's behaviour. `WP_Hook` caps delivery at `accepted_args`,
	 * so this works *only* because the registration carries headroom.
	 *
	 * It warns rather than refuses — an unrecognised argument is not an attack,
	 * and failing a customer's add-to-cart over stale documentation of ours would
	 * be the wrong trade.
	 */
	public function test_reports_a_call_site_with_more_arguments_than_recorded(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->validator()->register();

		$passed = apply_filters(
			AddToCartValidator::HOOK,
			true,
			self::PRODUCT_ID,
			1,
			0,
			array(),
			array(),
			'a seventh argument from some future WooCommerce'
		);

		$this->assertTrue( $passed, 'An unknown extra argument must not refuse the customer.' );
	}

	// --- Site 1: class-wc-form-handler.php:981, simple product, 3 args --------

	/**
	 * A valid selection passes on the simple-product path.
	 */
	public function test_site_1_simple_product_accepts_a_valid_selection(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->assertTrue( $this->fire( 3 ) );
	}

	/**
	 * An unknown value key is refused there.
	 */
	public function test_site_1_simple_product_refuses_an_unknown_value(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'HACKED' );

		$this->assertFalse( $this->fire( 3 ) );
		$this->assertNotEmpty( $GLOBALS['optionia_test_notices'] );
	}

	/**
	 * 🔴 **A length error must not read as "that selection is not available".**
	 *
	 * Every code but `required` fell through to a generic message telling the
	 * customer to *review the options*. For someone who typed a long engraving
	 * that is both wrong — nothing is unavailable — and unactionable: reviewing
	 * the options will never reveal that their text was too long.
	 */
	public function test_over_long_text_says_the_text_is_too_long(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'front',
			'opt-t' => 'far too long for ten characters',
		);

		$this->assertFalse( $this->fire( 3 ) );

		$notices = $GLOBALS['optionia_test_notices'];
		$this->assertNotEmpty( $notices );
		$this->assertStringContainsString( 'longer than', $notices[0]['message'] );
		$this->assertStringNotContainsString( 'not available', $notices[0]['message'] );
	}

	/**
	 * ⚠️ **A different message, because a different action fixes it.**
	 *
	 * The per-request budget fires only when every individual field was
	 * acceptable and the total was not — so telling the customer to shorten
	 * *the* field would name something that is not over its limit.
	 */
	public function test_too_much_text_overall_says_so(): void {
		/*
		 * ✏️ **Two earlier versions of this test passed for the wrong reason.**
		 *
		 * First with `max_length: 10`, where 70,000 characters tripped the
		 * *per-option* limit; then without one, where `ABSOLUTE_MAX_LENGTH`
		 * (5000) caught it. Both measured as `too_long`, and the budget message
		 * was never reached either way.
		 *
		 * The budget fires **only** when every individual field is acceptable and
		 * the total is not — which by construction needs several fields. Twenty
		 * options at 4000 characters is 80 KB total with no single field over
		 * 5000.
		 */
		$this->store_config_with_many_text_options( 20, 4000 );

		$selections = array( 'opt-a' => 'front' );

		for ( $i = 0; $i < 20; $i++ ) {
			$selections[ "opt-t{$i}" ] = str_repeat( 'a', 4000 );
		}

		$_POST[ Keys::FIELD_PREFIX ] = $selections;

		$this->assertFalse( $this->fire( 3 ) );

		$notices = $GLOBALS['optionia_test_notices'];
		$this->assertNotEmpty( $notices );
		$this->assertStringContainsString( 'too much text', $notices[0]['message'] );
		$this->assertStringNotContainsString( 'not available', $notices[0]['message'] );
	}

	/**
	 * An unknown value still gets the deliberately unspecific message.
	 *
	 * Naming the option ids a product does or does not have would answer, for
	 * anyone who asked, what another tenant's configuration looks like.
	 */
	public function test_an_unknown_value_keeps_the_generic_message(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'HACKED' );

		$this->assertFalse( $this->fire( 3 ) );

		$notices = $GLOBALS['optionia_test_notices'];
		$this->assertStringContainsString( 'not available', $notices[0]['message'] );
	}

	// --- Site 2: class-wc-form-handler.php:1013, order-again, 3 args ---------

	/**
	 * The second argument is an **array**, not a product id.
	 *
	 * M11.5 warns about exactly this. A callback that runs `absint()` on it
	 * raises a notice and derives a meaningless product id; the request
	 * normaliser type-checks instead.
	 */
	public function test_site_2_accepts_an_order_item_array_without_error(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->validator()->register();

		$passed = apply_filters(
			AddToCartValidator::HOOK,
			true,
			array(
				'product_id' => self::PRODUCT_ID,
				'quantity'   => 1,
			),
			1
		);

		$this->assertTrue( $passed );
	}

	/**
	 * And it still enforces, rather than passing everything through.
	 */
	public function test_site_2_refuses_an_unknown_value_from_an_array_item(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'HACKED' );

		$this->validator()->register();

		$passed = apply_filters(
			AddToCartValidator::HOOK,
			true,
			array( 'product_id' => self::PRODUCT_ID ),
			1
		);

		$this->assertFalse( $passed );
	}

	// --- Site 3: class-wc-form-handler.php:1063, variable product, 5 args ----

	/**
	 * The variable-product path validates too.
	 *
	 * Phase 10's primary segment is apparel: variants *plus* customization. A
	 * callback registered at three arguments never reaches this site's extra
	 * arguments, which is why the registration is per-site.
	 */
	public function test_site_3_variable_product_validates(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->assertTrue( $this->fire( 5 ) );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'HACKED' );

		$this->assertFalse( $this->fire( 5 ) );
	}

	// --- Site 4: class-wc-cart-session.php:615, reorder, 6 args --------------

	/**
	 * Reorder validates from `cart_item_data`, with no `$_POST` at all.
	 *
	 * `populate_cart_from_order()` rebuilds each line from order item meta and
	 * never populates `$_POST`. A `$_POST`-only validator does not merely skip
	 * validation here — it **blocks reorder entirely**, because the selection it
	 * demands is absent by construction.
	 *
	 * The payload here is built by hand so this test exercises the six-argument
	 * site in isolation. `Integration\CartItemData` writes the same shape for
	 * real — `Keys::CART_ITEM_KEY` → `Keys::CART_ITEM_SELECTIONS` — so the two
	 * sides meet; `CartTotalsTest` asserts the write, and this asserts the read.
	 */
	public function test_site_4_reorder_validates_from_cart_item_data(): void {
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->validator()->register();

		$passed = apply_filters(
			AddToCartValidator::HOOK,
			true,
			self::PRODUCT_ID,
			1,
			0,
			array(),
			array(
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'front' ),
				),
			)
		);

		$this->assertTrue( $passed, 'A reordered line carries its selection in cart_item_data.' );
	}

	/**
	 * A tampered reorder payload is still refused.
	 */
	public function test_site_4_reorder_refuses_a_tampered_payload(): void {
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->validator()->register();

		$passed = apply_filters(
			AddToCartValidator::HOOK,
			true,
			self::PRODUCT_ID,
			1,
			0,
			array(),
			array(
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => 'HACKED' ),
				),
			)
		);

		$this->assertFalse( $passed );
	}

	// --- Site 5: class-wc-ajax.php:520, shop loop, 3 args --------------------

	/**
	 * The AJAX path refuses a product that has options.
	 *
	 * `WC_AJAX::add_to_cart()` reads only `product_id` and `quantity`, and calls
	 * `add_to_cart()` with no `cart_item_data`. There is nothing to validate, so
	 * approving would be a bypass with a checkmark.
	 */
	public function test_site_5_ajax_refuses_a_product_with_options(): void {
		$GLOBALS['optionia_test_doing_ajax'] = true;

		$this->assertFalse( $this->fire( 3 ) );
		$this->assertNotEmpty(
			$GLOBALS['optionia_test_notices'],
			'The customer must be told to open the product page.'
		);
	}

	/**
	 * But an AJAX request that **does** carry a selection is accepted.
	 *
	 * This test asserted the opposite until 2026-09-01, and it was wrong — it
	 * encoded the bug rather than the requirement. Its premise, "WooCommerce
	 * would not forward it", is false whenever a selection is actually present:
	 * `WC_AJAX::add_to_cart()` never *collects* option fields, so a request that
	 * has them did not come from there. It came from
	 * `WC_Form_Handler::add_to_cart_action()`, which runs on `wp_loaded` — fired
	 * during AJAX too — and which does forward `cart_item_data`.
	 *
	 * The practical cost of the old behaviour: any theme submitting the product
	 * form over AJAX, a common pattern for quick-add and off-canvas carts, had
	 * every add-to-cart refused with the customer's valid selection in `$_POST`.
	 * Nothing was mispriced — it failed closed — but the merchant saw "add to
	 * cart does nothing" with no message and no cause.
	 */
	public function test_site_5_ajax_accepts_a_request_that_carries_a_selection(): void {
		$GLOBALS['optionia_test_doing_ajax'] = true;
		$_POST[ Keys::FIELD_PREFIX ]         = array( 'opt-a' => 'front' );

		$this->assertTrue(
			$this->fire( 3 ),
			'A selection in the request means this is a form post, not the shop-loop button.'
		);
	}

	/**
	 * A product whose options are all optional is still refused over AJAX.
	 *
	 * **This is why the branch is narrowed rather than deleted.** With no
	 * required option, resolution accepts an empty selection — correctly, since
	 * nothing is missing — so the resolver alone would let the shop-loop button
	 * add a line with none of the product's options on it. That is the original
	 * hole, and only this case reopens it.
	 */
	public function test_site_5_ajax_refuses_a_product_whose_options_are_all_optional(): void {
		$this->store_config( false );

		$GLOBALS['optionia_test_doing_ajax'] = true;
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertFalse( $this->fire( 3 ) );
	}

	/**
	 * Skipping an optional option on the **product page** is allowed.
	 *
	 * The mirror of the AJAX refusal, and the assertion that stops it widening.
	 * With no required option, an empty selection is a customer who looked at the
	 * options and chose none — which is what "optional" means. Only the shop-loop
	 * button, where the options were never shown at all, is refused.
	 *
	 * Without this, dropping the `wp_doing_ajax()` half of the condition passed
	 * every other test while refusing ordinary add-to-cart on any product whose
	 * options are all optional.
	 */
	public function test_a_product_page_add_may_skip_optional_options(): void {
		$this->store_config( false );

		$GLOBALS['optionia_test_doing_ajax'] = false;
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertTrue( $this->fire( 3 ) );
	}

	/**
	 * A product with no options is untouched on the AJAX path.
	 */
	public function test_site_5_ajax_allows_a_product_without_options(): void {
		$GLOBALS['optionia_test_doing_ajax'] = true;

		$this->validator()->register();

		$this->assertTrue( apply_filters( AddToCartValidator::HOOK, true, 999, 1 ) );
	}

	// --- Site 6: StoreApi/CartController.php:335, block cart, 6 args ---------

	/**
	 * The Store API path validates a selection like any other.
	 *
	 * **This is the block cart and the block checkout.** It was missing from
	 * `CALL_SITES` until Phase 12 analysis — Stage 6 and Stage 7 both grepped
	 * `includes/` and called it exhaustive, and the Store API lives in `src/`.
	 * It was already covered by the arity-6 registration, but by luck rather than
	 * by design, and M11.5's own rule is that each site is exercised by its own
	 * test rather than one standing in for the others.
	 *
	 * The path is genuinely distinct, not a relabelled site 4: `cart_item_data`
	 * is declared with a default of `[]` (WC 11.0.1,
	 * `src/StoreApi/Routes/V1/CartAddItem.php:122`), so this exercises
	 * `AddToCartRequest`'s empty-array branch — an array is present, but carries
	 * no Optionia key, so the selection must still be read from the request.
	 */
	public function test_site_6_store_api_accepts_a_valid_selection(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->assertTrue( $this->fire_store_api() );
	}

	/**
	 * And refuses a forged one.
	 */
	public function test_site_6_store_api_refuses_a_forged_value(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'HACKED' );

		$this->assertFalse( $this->fire_store_api() );
	}

	/**
	 * And enforces a required option that was never chosen.
	 *
	 * The case [M12.4](#m124--checkout-integrity) depends on: a block checkout
	 * must not complete with a required option missing.
	 */
	public function test_site_6_store_api_enforces_a_required_option(): void {
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertFalse( $this->fire_store_api() );
	}

	/**
	 * An empty `cart_item_data` does not mask a selection in the request.
	 *
	 * The Store API always supplies the sixth argument, defaulted to `array()`.
	 * A request normaliser that treated *any* array as authoritative would read
	 * an empty selection here and refuse every block add-to-cart — so this
	 * asserts the branch that distinguishes "an array with no Optionia key" from
	 * "an array carrying selections", which is what the reorder path sends.
	 */
	public function test_site_6_an_empty_cart_item_data_does_not_mask_the_request(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->assertTrue(
			$this->fire_store_api(),
			'An empty sixth argument must fall through to the request, not stand in for it.'
		);
	}

	// --- Enforcement rules ---------------------------------------------------

	/**
	 * A required option that was not chosen is refused.
	 */
	public function test_refuses_a_missing_required_option(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array();

		$this->assertFalse( $this->fire( 3 ) );
	}

	/**
	 * An option id this product does not have is refused, not ignored.
	 *
	 * Ignoring unknown keys would let a request carry another product's options
	 * — or another tenant's — without complaint. "It had no effect on the price"
	 * is a weaker guarantee than "it was refused".
	 */
	public function test_refuses_an_option_key_from_another_product(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a'          => 'front',
			'other-tenant-1' => 'whatever',
		);

		$this->assertFalse( $this->fire( 3 ) );
	}

	/**
	 * An array where a scalar belongs is refused.
	 *
	 * The shape that makes a naive `(string)` cast emit a notice and coerce to
	 * `"Array"`. Phase 4 confirmed WooCommerce repels it; this refuses it
	 * explicitly rather than relying on that.
	 */
	public function test_refuses_an_array_where_a_scalar_belongs(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => array( 'front' ) );

		$this->assertFalse( $this->fire( 3 ) );
	}

	/**
	 * A price injected into the request changes nothing.
	 *
	 * **This is AC4.** The injected fields are not filtered or sanitised — they
	 * are never read. The selection resolves from the cached config and the
	 * request passes with the price the merchant configured.
	 */
	public function test_injected_price_fields_are_never_read(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );
		$_POST['price']              = '1';
		$_POST['delta']              = '99999';
		$_POST['amount_minor']       = '-500000';

		$this->assertTrue( $this->fire( 3 ) );

		unset( $_POST['price'], $_POST['delta'], $_POST['amount_minor'] );
	}

	/**
	 * A refusal by another plugin is not overturned.
	 */
	public function test_does_not_overturn_an_earlier_refusal(): void {
		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'front' );

		$this->validator()->register();

		$this->assertFalse( apply_filters( AddToCartValidator::HOOK, false, self::PRODUCT_ID, 1 ) );
	}

	/**
	 * A product with no configured options is left alone.
	 */
	public function test_allows_a_product_with_no_options(): void {
		$this->validator()->register();

		$this->assertTrue( apply_filters( AddToCartValidator::HOOK, true, 999, 1 ) );
	}

	/**
	 * An unusable product argument neither refuses nor errors.
	 *
	 * `null`, `false` and an empty array reach this filter from paths that have
	 * already failed for their own reasons. Refusing would add a confusing
	 * second error; erroring would be worse.
	 *
	 * @dataProvider provide_unusable_products
	 *
	 * @param mixed $product Whatever the call site passed.
	 */
	public function test_tolerates_an_unusable_product_argument( $product ): void {
		$this->validator()->register();

		$this->assertTrue( apply_filters( AddToCartValidator::HOOK, true, $product, 1 ) );
	}

	/**
	 * Shapes that are not a usable product id.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_unusable_products(): array {
		return array(
			'null'        => array( null ),
			'false'       => array( false ),
			'empty array' => array( array() ),
			'zero'        => array( 0 ),
			'a string'    => array( 'not-a-product' ),
		);
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Fire the filter with the argument count a given call site supplies.
	 *
	 * @param int $arity How many arguments the site passes.
	 * @return bool The filtered result.
	 */
	private function fire( int $arity ): bool {
		$this->validator()->register();

		if ( 5 === $arity ) {
			return (bool) apply_filters( AddToCartValidator::HOOK, true, self::PRODUCT_ID, 1, 0, array() );
		}

		return (bool) apply_filters( AddToCartValidator::HOOK, true, self::PRODUCT_ID, 1 );
	}

	/**
	 * Fire the Store API call site: six arguments, `cart_item_data` defaulted.
	 *
	 * Separate from `fire()` because the shape is the point — `CartAddItem.php`
	 * declares `'cart_item_data' => []`, so the sixth argument is always present
	 * and usually empty.
	 */
	private function fire_store_api(): bool {
		$this->validator()->register();

		return (bool) apply_filters(
			AddToCartValidator::HOOK,
			true,
			self::PRODUCT_ID,
			1,
			0,
			array(),
			array()
		);
	}

	/**
	 * A validator over the real repository.
	 */
	private function validator(): AddToCartValidator {
		$logger = new Logger( new Settings() );

		return new AddToCartValidator( new Repository( $logger ), $logger );
	}

	/**
	 * Store a configuration: one radio with two values.
	 *
	 * @param bool $required Whether the option is required. The optional case is
	 *                       what makes the AJAX branch load-bearing.
	 */
	/**
	 * A configuration whose text options are individually fine and jointly are not.
	 *
	 * The only shape that reaches the per-request budget: `ABSOLUTE_MAX_LENGTH`
	 * refuses any single field over 5000, so exceeding 64 KB requires several.
	 *
	 * @param int $count Number of text options.
	 * @param int $chars Characters submitted to each.
	 */
	private function store_config_with_many_text_options( int $count, int $chars ): void {
		$options = array(
			array(
				'id'          => 'opt-a',
				'type'        => 'radio',
				'label'       => 'Print placement',
				'is_required' => false,
				'values'      => array(
					array(
						'value_key' => 'front',
						'label'     => 'Front',
					),
				),
			),
		);

		for ( $i = 0; $i < $count; $i++ ) {
			$options[] = array(
				'id'          => "opt-t{$i}",
				'type'        => 'text_field',
				'value_kind'  => 'text',
				'label'       => "Engraving {$i}",
				'is_required' => false,
				'values'      => array(),
			);
		}

		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 11,
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
								'label'   => 'Customization',
								'options' => $options,
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-11"'
		);

		unset( $chars );
	}

	private function store_config( bool $required = true, bool $with_limit = true ): void {
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
										'is_required' => $required,
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

									/*
									 * A text option beside the radio, so the
									 * length errors below have something to
									 * fire on. `max_length` is small on purpose:
									 * a test asserting a message should not need
									 * to build 5000 characters to see it.
									 */
									array(
										'id'          => 'opt-t',
										'type'        => 'text_field',
										'value_kind'  => 'text',
										'label'       => 'Engraving',
										'is_required' => false,
										'values'      => array(),
										'validation'  => $with_limit ? array( 'max_length' => 10 ) : array(),
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
}
