<?php
/**
 * The step between a price config and a delta, driven by the shared fixture.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Engine\SelectionResolver;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartTotals;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Money;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * A published price config, against a base, yields a delta.
 *
 * ## Why this file exists at all
 *
 * The shared fixture already tested both ENDS of pricing and neither tested the
 * middle. `PricingTest` reads the main `cases`, which hand the summer deltas
 * that are **already computed** -- so it proves addition and clamping.
 * `PricingRoundingTest` reads `rounding_cases`, which call
 * `Money::percentage(10, 500)` directly -- so it proves rounding.
 *
 * Nothing proved that a `{type: percentage, basis_points: 500}` config on a base
 * of 10 produces a delta of 1. That derivation is exactly where two evaluators
 * diverge while both suites stay green, because each half is correct in
 * isolation: PHP could read `basis_points` as a percent and TypeScript as a
 * fraction, and every existing test in both repositories would still pass.
 *
 * So these cases go through `SelectionResolver::resolve()` -- the real entry
 * point, with a real published document -- rather than calling `delta_for()`
 * through reflection. A private method proven in isolation is not proof that the
 * public path reaches it, and reaching it is half of what M16.1 changed.
 *
 * @covers \Optionia\Engine\SelectionResolver
 * @covers \Optionia\Engine\Pricing
 */
final class PriceConfigDeltaTest extends TestCase {

	/**
	 * The product the cart-path test prices.
	 */
	private const PRODUCT_ID = 4242;

	/**
	 * A variation of that product, priced where its parent is not.
	 */
	private const VARIATION_ID = 4243;



	/**
	 * Restore the store's decimal count, however a test ended.
	 *
	 * 🔴 **Restoring inline was not enough.** The bootstrap resets
	 * `optionia_test_decimals` at **load**, not per test, so a test that set it
	 * and then failed before its restore line left every later test seeing the
	 * changed value -- measured: a test that sets 0 and throws leaves the next
	 * one rendering `500` where it expects `5.00`.
	 *
	 * That turns one failure into a cascade whose cause is invisible, and the
	 * bootstrap's own docblock already said this belonged here. `tearDown` runs
	 * whether a test passes, fails or throws, which is the whole difference.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_decimals'] = 2;

		parent::tearDown();
	}

	/**
	 * Every config case from the shared fixture, through the public evaluator.
	 *
	 * @dataProvider provide_config_cases
	 *
	 * @param int                  $base_minor Product base price, in minor units.
	 * @param array<string, mixed> $config     The published `price_config`.
	 * @param int                  $expected   Expected delta, in minor units.
	 * @param string|null          $unpriced   Type expected to be recorded, if any.
	 * @param string               $label      Case name, for the failure message.
	 */
	public function test_config_yields_the_shared_delta( int $base_minor, array $config, int $expected, ?string $unpriced, string $label ): void {
		$result = SelectionResolver::resolve(
			self::document( $config ),
			array( 'opt' => 'val' ),
			$base_minor
		);

		$this->assertTrue( $result->is_ok(), $label . ' -- resolution failed' );

		$value = $result->value();

		$this->assertSame( array( 'opt' => $expected ), $value['deltas'], $label );

		/*
		 * The total is asserted as well as the delta.
		 *
		 * A delta that is right and a total that ignores it is a live
		 * undercharge, and the two are computed by different code -- `delta_for()`
		 * and `Pricing::sum_deltas()`. `max(0, ...)` because the clamp is
		 * normative: a base of 0 with a negative delta totals 0, not a refund.
		 */
		$this->assertSame(
			max( 0, $base_minor + $expected ),
			$value['total_minor'],
			$label . ' -- total'
		);

		if ( null === $unpriced ) {
			$this->assertSame( array(), $value['unpriced'], $label . ' -- nothing should be unpriced' );
		} else {
			$this->assertContains( $unpriced, $value['unpriced'], $label . ' -- unpriced type' );
		}
	}

	/**
	 * The config cases, read from the file both languages share.
	 *
	 * @return array<string, array{0: int, 1: array<string, mixed>, 2: int, 3: string|null, 4: string}>
	 */
	public static function provide_config_cases(): array {
		$cases = array();

		foreach ( self::fixture()['config_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(int) $case['base_minor'],
				(array) $case['config'],
				(int) $case['expect_delta'],
				isset( $case['expect_unpriced'] ) ? (string) $case['expect_unpriced'] : null,
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * Every declared config case ran.
	 *
	 * A hash proves both repositories hold the same bytes; it does not prove
	 * either executed them. Measured on the sibling suites: a provider truncated
	 * to one row passes every grep the gate performs, and only this assertion
	 * catches it.
	 */
	public function test_every_declared_config_case_ran(): void {
		$this->assertSame(
			(int) self::fixture()['config_case_count'],
			count( self::provide_config_cases() )
		);
	}

	/**
	 * A percentage is taken of the base, never of the running total.
	 *
	 * Two 50% options on 80.00 add 40.00 each -- 160.00, not 180.00. Compounding
	 * would make the total depend on option order, which the published schema
	 * does not define and the customer cannot see.
	 *
	 * Asserted directly rather than through the fixture because a single-option
	 * fixture case cannot distinguish the two: with one percentage, base and
	 * running total are the same number.
	 */
	public function test_percentages_do_not_compound(): void {
		$half     = array(
			'type'         => 'percentage',
			'basis_points' => 5000,
		);
		$document = self::document_of(
			array(
				self::option( 'a', $half ),
				self::option( 'b', $half ),
			)
		);

		$result = SelectionResolver::resolve(
			$document,
			array(
				'a' => 'val',
				'b' => 'val',
			),
			8000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame(
			array(
				'a' => 4000,
				'b' => 4000,
			),
			$result->value()['deltas']
		);
		$this->assertSame( 16000, $result->value()['total_minor'] );
	}

	/**
	 * A percentage this build charges is not reported as unpriceable.
	 *
	 * The admin notice and the cart logger both name the implemented types, and
	 * before M16.1 both said `fixed` as a bare string. Widening the evaluator
	 * without widening them would charge the percentage correctly and warn that
	 * it had not been charged -- which trains merchants to ignore a warning that
	 * is right the next time.
	 */
	public function test_a_charged_percentage_is_not_called_unpriceable(): void {
		$this->assertContains( 'percentage', SelectionResolver::PRICED_TYPES );

		$result = SelectionResolver::resolve(
			self::document(
				array(
					'type'         => 'percentage',
					'basis_points' => 5000,
				)
			),
			array( 'opt' => 'val' ),
			8000
		);

		$this->assertSame( array(), $result->value()['unpriced'] );
	}

	/**
	 * 🔴 A percentage survives the real cart path: frozen, then charged.
	 *
	 * Every other test in this file calls `SelectionResolver::resolve()` directly
	 * **with a base** -- which matched the one caller that was already passing
	 * one, and hid the defect that made this whole stage inert.
	 *
	 * Three of the resolver's five callers passed a literal `0` for
	 * `$base_minor`. That was harmless while `fixed` was the only priced type: a
	 * flat amount does not depend on what the product costs. M16.1 made the base
	 * load-bearing, and one of those callers -- `Integration\CartItemData` --
	 * **freezes and signs** the delta onto the cart line.
	 *
	 * Measured before the fix: a 50% option on an 80.00 product froze at
	 * `{"opt-a":0}` and the line charged **80.00**, with 1294 tests green. The
	 * freeze had previously been skipped for percentages only because they were
	 * reported as unpriced -- so removing them from `unpriced` enabled a freeze
	 * that had always been wrong.
	 *
	 * So this drives the production classes end to end rather than the engine:
	 * `CartItemData::attach()` then `CartTotals::apply()`, which is the path a
	 * customer takes. A unit test of the resolver cannot catch this class of
	 * defect, because the resolver was never the thing that was wrong.
	 */
	public function test_a_percentage_is_frozen_and_charged_through_the_cart(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			self::published_percentage_document(),
			'W/"pct"'
		);

		$product = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );
		$attached                    = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertSame(
			array( 'opt-a' => 4000 ),
			$attached[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ] ?? null,
			'A percentage must freeze at its real amount, not at a percentage of zero.'
		);

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$product,
			1,
			array_merge( $attached, array( 'product_id' => self::PRODUCT_ID ) )
		);

		( new CartTotals( new Repository( new Logger( new Settings() ) ), new Logger( new Settings() ) ) )
			->apply( $cart );

		$this->assertSame(
			'120.00',
			$product->get_price(),
			'A 50% option on an 80.00 product charges 120.00.'
		);
	}

	/**
	 * 🔴 An over-range percentage is refused, not thrown.
	 *
	 * `Pricing::percentage_of()` raises `RangeException`, and the only try/catch
	 * in `resolve()` wraps `sum_deltas()` -- far below where a percentage is
	 * computed. So the exception escaped the resolver into
	 * `woocommerce_before_calculate_totals`, where an uncaught throw fatals cart
	 * AND checkout.
	 *
	 * The rate here is `100000`: the cloud schema's own maximum, so this is a
	 * **legal publish**. The base comes from WooCommerce rather than the cloud
	 * and is bounded only by `PHP_INT_MAX`, so the schema cap does not prevent
	 * it.
	 *
	 * Reported as unpriced, which is what an over-range `fixed` amount already
	 * effectively does. Two price types must not disagree about what an
	 * impossible number means.
	 */
	public function test_an_over_range_percentage_is_reported_rather_than_thrown(): void {
		$result = SelectionResolver::resolve(
			self::document(
				array(
					'type'         => 'percentage',
					'basis_points' => 100000,
				)
			),
			array( 'opt' => 'val' ),
			900719925474099
		);

		$this->assertTrue( $result->is_ok(), 'An over-range percentage must not take the storefront down.' );
		$this->assertSame( array( 'opt' => 0 ), $result->value()['deltas'] );
		$this->assertContains(
			'percentage',
			$result->value()['unpriced'],
			'A percentage that could not be computed must be reported, not silently zero.'
		);
	}

	/**
	 * 🔴 A variation's own price is the base, not its parent's.
	 *
	 * A parent variable product commonly has **no price of its own**, or carries
	 * the range's lowest. Pricing a percentage off the parent therefore charges a
	 * percentage of nothing, or the wrong amount for every variation except the
	 * cheapest -- and the amount is frozen onto the line.
	 *
	 * Written because the rule survived mutation: deleting the variation branch
	 * from `Support\BasePrice` left all 1296 tests green. Only
	 * `AddToCartValidator` had ever resolved a variation, and its own suite never
	 * exercised the difference -- so the rule was correct by inheritance rather
	 * than by test, which is how the copies would have drifted.
	 */
	public function test_a_variation_prices_from_its_own_price_not_its_parent(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			self::published_percentage_document(),
			'W/"pct-var"'
		);

		// The parent carries no price, exactly as WooCommerce leaves a variable
		// product whose variations differ.
		optionia_test_product( self::PRODUCT_ID, 'variable', '0' );
		optionia_test_product( self::VARIATION_ID, 'variation', '80.00' );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );
		$attached                    = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, self::VARIATION_ID, 1 );
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertSame(
			array( 'opt-a' => 4000 ),
			$attached[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ] ?? null,
			'A percentage on a variation prices off the variation, not the priceless parent.'
		);
	}

	/**
	 * A published document assigning one percentage option to the test product.
	 *
	 * @return array<string, mixed>
	 */
	private static function published_percentage_document(): array {
		return array(
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
							'id'      => 'g',
							'options' => array(
								array(
									'id'     => 'opt-a',
									'type'   => 'radio',
									'values' => array(
										array(
											'value_key'    => 'lux',
											'price_config' => array(
												'type' => 'percentage',
												'basis_points' => 5000,
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
		);
	}

	/**
	 * Every `per_char` case from the shared fixture, through the evaluator.
	 *
	 * `measure_cases` prove text -> a count and `config_cases` prove a config ->
	 * a delta; neither proved the step between. That gap is not hypothetical:
	 * it is the `optionia-app` bug this whole specification exists to prevent,
	 * where pricing counted five characters while the counter beside the field
	 * showed four. Both halves were self-consistent, which is why it survived.
	 *
	 * @dataProvider provide_text_price_cases
	 *
	 * @param string               $text     What the customer typed.
	 * @param array<string, mixed> $pricing  The option's published `pricing`.
	 * @param int                  $expected Expected delta, in minor units.
	 * @param string|null          $unpriced Type expected to be reported, if any.
	 * @param string               $label    Case name, for the failure message.
	 */
	public function test_per_char_yields_the_shared_delta( string $text, array $pricing, int $expected, ?string $unpriced, string $label ): void {
		$result = SelectionResolver::resolve( self::text_document( $pricing ), array( 'opt' => $text ), 8000 );

		$this->assertTrue( $result->is_ok(), $label . ' -- resolution failed' );
		$this->assertSame( array( 'opt' => $expected ), $result->value()['deltas'], $label );

		/*
		 * The count and the delta must stay paired.
		 *
		 * A text option that resolves without appending a delta breaks
		 * `CartItemData`'s positional pairing and silently defeats the price
		 * freeze -- measured before M16.2, at 130.00 on an 85.00 quote.
		 */
		$this->assertCount(
			count( $result->value()['resolved'] ),
			$result->value()['deltas'],
			$label . ' -- one delta per accepted selection'
		);

		/*
		 * Same shape as the unit cases, so a `per_char` case CAN assert the
		 * reporting half. None does today, because `per_char` cannot reach its
		 * overflow guard: 5000 graphemes at the schema's maximum amount is 5e12,
		 * comfortably inside the safe range. The capability exists so the next
		 * reportable condition is expressible rather than requiring this test to
		 * be rewritten.
		 */
		if ( null === $unpriced ) {
			$this->assertSame( array(), $result->value()['unpriced'], $label . ' -- nothing should be reported' );
		} else {
			$this->assertContains( $unpriced, $result->value()['unpriced'], $label . ' -- must be reported' );
		}
	}

	/**
	 * The text-price cases, read from the file both languages share.
	 *
	 * @return array<string, array{0: string, 1: array<string, mixed>, 2: int, 3: string}>
	 */
	public static function provide_text_price_cases(): array {
		$cases = array();

		foreach ( self::fixture()['text_price_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(string) $case['text'],
				(array) $case['pricing'],
				(int) $case['expect_delta'],
				isset( $case['expect_unpriced'] ) ? (string) $case['expect_unpriced'] : null,
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * Every declared text-price case ran.
	 */
	public function test_every_declared_text_price_case_ran(): void {
		$this->assertSame(
			(int) self::fixture()['text_price_case_count'],
			count( self::provide_text_price_cases() )
		);
	}

	/**
	 * 🔴 A text option contributes a delta, so the price freeze still works.
	 *
	 * `$deltas` was appended **only in the value branch**, while `resolved`
	 * included text, date, number and file answers too. `deltas_by_option()`
	 * pairs the two positionally and refuses to pair them at all when the counts
	 * differ -- so any line carrying a text field froze an **empty** array,
	 * signed it, and priced live instead.
	 *
	 * Measured before this fix, with a plain gift-message field beside a 5.00
	 * option and nothing unpriceable anywhere: quoted **85.00**, merchant
	 * republished the option at 50.00, customer charged **130.00**. M12.4's
	 * price freeze, silently defeated by a free text field.
	 *
	 * The republish is what makes this test the real one. Without it the line
	 * prices correctly from current configuration and the defect is invisible.
	 */
	public function test_a_text_option_does_not_defeat_the_price_freeze(): void {
		$this->publish_text_and_choice( 500 );

		$product = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'message' => 'Happy birthday',
			'finish'  => 'oak',
		);
		$attached                    = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertSame(
			array(
				'finish'  => 500,
				'message' => 0,
			),
			$attached[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ] ?? null,
			'A free text field must carry a zero delta, not break the pairing.'
		);

		// The merchant republishes while the line sits in the cart.
		$this->publish_text_and_choice( 5000 );

		$cart = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$product,
			1,
			array_merge( $attached, array( 'product_id' => self::PRODUCT_ID ) )
		);

		( new CartTotals( new Repository( new Logger( new Settings() ) ), new Logger( new Settings() ) ) )
			->apply( $cart );

		$this->assertSame(
			'85.00',
			$product->get_price(),
			'The customer was quoted 85.00; a republish must not charge them 130.00.'
		);
	}

	/**
	 * A text field and a priced choice on one product.
	 *
	 * @param int $amount The choice's amount, in minor units.
	 */
	private function publish_text_and_choice( int $amount ): void {
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
								'id'      => 'g',
								'options' => array(
									array(
										'id'         => 'message',
										'type'       => 'text',
										'value_kind' => 'text',
									),
									array(
										'id'     => 'finish',
										'type'   => 'radio',
										'values' => array(
											array(
												'value_key'    => 'oak',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => $amount,
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
			'W/"' . $amount . '"'
		);
	}

	/**
	 * A published document carrying one text option priced at the option level.
	 *
	 * @param array<string, mixed> $pricing The option's `pricing`.
	 * @return array<int, array<string, mixed>>
	 */
	private static function text_document( array $pricing ): array {
		return self::document_of(
			array(
				array(
					'id'         => 'opt',
					'type'       => 'text',
					'value_kind' => 'text',
					'pricing'    => $pricing,
				),
			)
		);
	}

	/**
	 * 🔴 `per_char` charges only an option the customer TYPES into.
	 *
	 * `option_delta()` dispatches on `pricing.type` and has no view of what kind
	 * of answer the option produces, so without a guard it charges for the length
	 * of whatever string arrives. Measured:
	 *
	 * ```text
	 * per_char on a FILE option   -> a 64-character upload token -> 32.00
	 * per_char on a DATE option   -> "2026-10-01"                ->  5.00
	 * per_char on a NUMBER option -> "12345"                     ->  2.50
	 * ```
	 *
	 * A customer paying 32.00 for the length of a hash they never typed is not a
	 * configuration any merchant meant.
	 *
	 * `hidden` is the subtle one: its `value_kind` IS `text`, so a `is_free_text`
	 * check alone lets it through — but its value is the merchant's own
	 * `default_value`, so charging bills a customer for a campaign tag they
	 * cannot see.
	 *
	 * @dataProvider provide_non_typed_kinds
	 *
	 * @param array<string, mixed> $option One option that is not typed into.
	 * @param string               $answer The answer it produces.
	 */
	public function test_per_char_does_not_charge_an_option_nobody_types_into( array $option, string $answer ): void {
		$option['pricing'] = array(
			'type'            => 'per_char',
			'amount_minor'    => 50,
			'free_characters' => 0,
		);

		$result = SelectionResolver::resolve(
			self::document_of( array( $option ) ),
			array( 'opt' => $answer ),
			8000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt' => 0 ), $result->value()['deltas'] );
		$this->assertContains(
			'per_char',
			$result->value()['unpriced'],
			'Reported, not silently zero -- a merchant must be told rather than undercharged.'
		);
	}

	/**
	 * Every option kind whose answer the customer does not type.
	 *
	 * @return array<string, array{0: array<string, mixed>, 1: string}>
	 */
	public static function provide_non_typed_kinds(): array {
		return array(
			'a file, whose answer is a 64-character upload token' => array(
				array(
					'id'         => 'opt',
					'type'       => 'file',
					'value_kind' => 'file',
				),
				str_repeat( 'a', 64 ),
			),
			'a date, whose answer is a formatted string'   => array(
				array(
					'id'         => 'opt',
					'type'       => 'date',
					'value_kind' => 'date',
				),
				'2026-10-01',
			),
			'a number, whose answer is a canonical figure' => array(
				array(
					'id'         => 'opt',
					'type'       => 'number',
					'value_kind' => 'number',
					'min'        => 0,
					'max'        => 99999,
				),
				'12345',
			),
			'a hidden field, whose answer is the merchant\'s own' => array(
				array(
					'id'            => 'opt',
					'type'          => 'hidden',
					'value_kind'    => 'text',
					'default_value' => 'campaign-a',
				),
				'ignored',
			),
		);
	}

	/**
	 * Every `per_unit` case from the shared fixture, through the evaluator.
	 *
	 * A quantity has a far wider input range than a character count: `measure()`
	 * returns a non-negative integer by construction, while a number option
	 * accepts fractions and negatives unless the merchant configured otherwise.
	 * These cases carry the three properties no arithmetic gets right by
	 * accident -- a negative floored, a fraction rounded, and a negative amount
	 * surviving that floor.
	 *
	 * @dataProvider provide_unit_price_cases
	 *
	 * @param string               $quantity What the customer supplied.
	 * @param array<string, mixed> $pricing  The option's published `pricing`.
	 * @param int                  $expected Expected delta, in minor units.
	 * @param string|null          $unpriced Type expected to be reported, if any.
	 * @param string               $label    Case name, for the failure message.
	 */
	public function test_per_unit_yields_the_shared_delta( string $quantity, array $pricing, int $expected, ?string $unpriced, string $label ): void {
		$result = SelectionResolver::resolve( self::number_document( $pricing ), array( 'opt' => $quantity ), 8000 );

		$this->assertTrue( $result->is_ok(), $label . ' -- resolution failed' );
		$this->assertSame( array( 'opt' => $expected ), $result->value()['deltas'], $label );

		/*
		 * 🔴 **The reporting half is asserted, not assumed.**
		 *
		 * This asserted `unpriced` was ALWAYS empty until the M16.2 audit, which
		 * locked in a defect: at the overflow boundary the option became free and
		 * said nothing, while the TypeScript twin reported it. The fixture could
		 * not see the disagreement because no case carried an expectation for
		 * this half.
		 *
		 * "Contributes nothing **and says so**" is two claims, and a suite that
		 * checks one of them proves half a specification.
		 */
		if ( null === $unpriced ) {
			$this->assertSame( array(), $result->value()['unpriced'], $label . ' -- nothing should be reported' );
		} else {
			$this->assertContains( $unpriced, $result->value()['unpriced'], $label . ' -- must be reported' );
		}
	}

	/**
	 * The unit-price cases, read from the file both languages share.
	 *
	 * @return array<string, array{0: string, 1: array<string, mixed>, 2: int, 3: string|null, 4: string}>
	 */
	public static function provide_unit_price_cases(): array {
		$cases = array();

		foreach ( self::fixture()['unit_price_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(string) $case['quantity'],
				(array) $case['pricing'],
				(int) $case['expect_delta'],
				isset( $case['expect_unpriced'] ) ? (string) $case['expect_unpriced'] : null,
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * Every declared unit-price case ran.
	 */
	public function test_every_declared_unit_price_case_ran(): void {
		$this->assertSame(
			(int) self::fixture()['unit_price_case_count'],
			count( self::provide_unit_price_cases() )
		);
	}

	/**
	 * 🔴 `per_unit` charges only an option that produces a NUMBER.
	 *
	 * The counterpart to `per_char`'s typed-text rule, and the same defect
	 * shape: `option_delta()` dispatches on `pricing.type` and would otherwise
	 * multiply by whatever the answer happens to be. A date answer of
	 * `"2026-10-01"` is not a quantity, and neither is an engraving.
	 *
	 * @dataProvider provide_non_numeric_kinds
	 *
	 * @param array<string, mixed> $option One option that produces no number.
	 * @param string               $answer The answer it produces.
	 */
	public function test_per_unit_does_not_charge_an_option_without_a_number( array $option, string $answer ): void {
		$option['pricing'] = array(
			'type'         => 'per_unit',
			'amount_minor' => 200,
		);

		$result = SelectionResolver::resolve( self::document_of( array( $option ) ), array( 'opt' => $answer ), 8000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt' => 0 ), $result->value()['deltas'] );
		$this->assertContains( 'per_unit', $result->value()['unpriced'] );
	}

	/**
	 * Every option kind whose answer is not a quantity.
	 *
	 * @return array<string, array{0: array<string, mixed>, 1: string}>
	 */
	public static function provide_non_numeric_kinds(): array {
		return array(
			'text, whose answer is an engraving'         => array(
				array(
					'id'         => 'opt',
					'type'       => 'text',
					'value_kind' => 'text',
				),
				'HELLO',
			),
			'a date, whose answer is a formatted string' => array(
				array(
					'id'         => 'opt',
					'type'       => 'date',
					'value_kind' => 'date',
				),
				'2026-10-01',
			),
			'a file, whose answer is an upload token'    => array(
				array(
					'id'         => 'opt',
					'type'       => 'file',
					'value_kind' => 'file',
				),
				str_repeat( 'a', 64 ),
			),
		);
	}

	/**
	 * 🔴 An unbounded quantity is reported, not thrown.
	 *
	 * A number option's answer has **no length ceiling** the way text does: a
	 * customer can submit `1e20`-scale digits wherever the merchant configured no
	 * `max`, and at the schema's maximum amount a quantity near nine million
	 * already leaves the safe range.
	 *
	 * An uncaught throw here reaches `woocommerce_before_calculate_totals` and
	 * takes cart and checkout down -- the defect M16.1's audit found in
	 * `percentage`, which is why this is guarded before it can repeat.
	 */
	public function test_an_unbounded_quantity_is_reported_rather_than_thrown(): void {
		$result = SelectionResolver::resolve(
			self::number_document(
				array(
					'type'         => 'per_unit',
					'amount_minor' => 1000000000,
				)
			),
			array( 'opt' => '99999999999999999999' ),
			8000
		);

		$this->assertTrue( $result->is_ok(), 'A huge quantity must not take the storefront down.' );
		$this->assertSame( array( 'opt' => 0 ), $result->value()['deltas'] );
	}

	/**
	 * 🔴 The quantity is the OPTION's own, never the cart quantity.
	 *
	 * `WC_Cart_Totals` computes a line as `price x cart_quantity`, so a delta
	 * with the cart quantity already folded in is multiplied twice -- the silent
	 * overcharge M11.6 exists to prevent, and the one this phase's architecture
	 * gate watches for.
	 *
	 * "GBP 2 per centimetre" prices one item of 30cm at GBP 60 whether the
	 * customer buys one or ten. The resolver takes no cart quantity at all, which
	 * is what makes that true by construction -- asserted here so a future
	 * signature change has to break a named test.
	 */
	public function test_the_delta_is_per_line_not_per_cart_quantity(): void {
		$document = self::number_document(
			array(
				'type'         => 'per_unit',
				'amount_minor' => 200,
			)
		);

		$this->assertSame(
			array( 'opt' => 600 ),
			SelectionResolver::resolve( $document, array( 'opt' => '3' ), 8000 )->value()['deltas'],
			'Three units at 2.00 is 6.00, whatever the cart quantity.'
		);

		$reflection = new \ReflectionMethod( SelectionResolver::class, 'resolve' );

		/*
		 * ⚠️ **An exact list, not a "does not contain quantity" check.** A
		 * blacklist passes for every parameter nobody thought to forbid; this
		 * makes any signature change a decision somebody has to write down here.
		 *
		 * ✅ **Back to four.** M18.2 added a fifth, `allow_many`, so the
		 * multi-select fence could be tested from behind it; M18.3 removed the
		 * fence and the parameter together. This gate caught the addition on
		 * its first run, which is the argument for an exact list.
		 */
		$this->assertSame(
			array( 'option_sets', 'selections', 'base_minor', 'today' ),
			array_map(
				static fn( \ReflectionParameter $p ): string => $p->getName(),
				$reflection->getParameters()
			),
			'The resolver must not learn about cart quantity: WooCommerce already multiplies by it.'
		);
	}

	/**
	 * A published document carrying one number option priced per unit.
	 *
	 * @param array<string, mixed> $pricing The option's `pricing`.
	 * @return array<int, array<string, mixed>>
	 */
	private static function number_document( array $pricing ): array {
		return self::document_of(
			array(
				array(
					'id'         => 'opt',
					'type'       => 'number',
					'value_kind' => 'number',
					'pricing'    => $pricing,
				),
			)
		);
	}

	/**
	 * Every `tiered` case from the shared fixture, through the evaluator.
	 *
	 * The only pricing type whose amount comes from a **lookup**, so an
	 * off-by-one at a boundary charges the wrong *rate* for every unit rather
	 * than being out by a minor unit. The boundary cases are the point: exactly
	 * the lower bound, exactly the upper bound, one below, one above.
	 *
	 * @dataProvider provide_tier_price_cases
	 *
	 * @param string               $quantity What the customer supplied.
	 * @param array<string, mixed> $pricing  The option's published `pricing`.
	 * @param int                  $expected Expected delta, in minor units.
	 * @param string|null          $unpriced Type expected to be reported, if any.
	 * @param string               $label    Case name, for the failure message.
	 */
	public function test_tiered_yields_the_shared_delta( string $quantity, array $pricing, int $expected, ?string $unpriced, string $label ): void {
		$result = SelectionResolver::resolve( self::number_document( $pricing ), array( 'opt' => $quantity ), 8000 );

		$this->assertTrue( $result->is_ok(), $label . ' -- resolution failed' );
		$this->assertSame( array( 'opt' => $expected ), $result->value()['deltas'], $label );

		if ( null === $unpriced ) {
			$this->assertSame( array(), $result->value()['unpriced'], $label . ' -- nothing should be reported' );
		} else {
			$this->assertContains( $unpriced, $result->value()['unpriced'], $label . ' -- must be reported' );
		}
	}

	/**
	 * The tier cases, read from the file both languages share.
	 *
	 * @return array<string, array{0: string, 1: array<string, mixed>, 2: int, 3: string|null, 4: string}>
	 */
	public static function provide_tier_price_cases(): array {
		$cases = array();

		foreach ( self::fixture()['tier_price_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(string) $case['quantity'],
				(array) $case['pricing'],
				(int) $case['expect_delta'],
				isset( $case['expect_unpriced'] ) ? (string) $case['expect_unpriced'] : null,
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * Every declared tier case ran.
	 */
	public function test_every_declared_tier_price_case_ran(): void {
		$this->assertSame(
			(int) self::fixture()['tier_price_case_count'],
			count( self::provide_tier_price_cases() )
		);
	}

	/**
	 * 🔴 The bracket is chosen by `min_quantity`, whatever order the tiers arrive in.
	 *
	 * The published document preserves whatever order the dashboard stored. A
	 * lookup that took the first match, or trusted the array to be sorted, would
	 * price by whichever bracket happened to come first -- charging the 50+ rate
	 * for a quantity of 5 on a document that is entirely valid.
	 *
	 * Asserted with the tiers deliberately reversed, which the schema permits
	 * because it sorts before validating.
	 */
	public function test_the_bracket_does_not_depend_on_tier_order(): void {
		$reversed = array(
			'type'  => 'tiered',
			'tiers' => array(
				array(
					'min_quantity' => 50,
					'max_quantity' => null,
					'amount_minor' => 60,
				),
				array(
					'min_quantity' => 10,
					'max_quantity' => 49,
					'amount_minor' => 80,
				),
				array(
					'min_quantity' => 1,
					'max_quantity' => 9,
					'amount_minor' => 100,
				),
			),
		);

		$this->assertSame(
			array( 'opt' => 500 ),
			SelectionResolver::resolve( self::number_document( $reversed ), array( 'opt' => '5' ), 8000 )->value()['deltas'],
			'Five metres at the 1-9 rate, whichever order the brackets were stored in.'
		);

		$this->assertSame(
			array( 'opt' => 3000 ),
			SelectionResolver::resolve( self::number_document( $reversed ), array( 'opt' => '50' ), 8000 )->value()['deltas'],
			'Fifty metres at the 50+ rate.'
		);
	}

	/**
	 * 🔴 `tiered` charges only an option that produces a NUMBER.
	 *
	 * It shares `per_unit`'s guard rather than carrying its own, so this asserts
	 * the sharing holds: a `tiered` price on a text option has no quantity to
	 * bracket, and charging for the length of an engraving is not what any
	 * merchant configured.
	 */
	public function test_tiered_does_not_charge_an_option_without_a_number(): void {
		$option = array(
			'id'         => 'opt',
			'type'       => 'text',
			'value_kind' => 'text',
			'pricing'    => array(
				'type'  => 'tiered',
				'tiers' => array(
					array(
						'min_quantity' => 1,
						'max_quantity' => null,
						'amount_minor' => 100,
					),
				),
			),
		);

		$result = SelectionResolver::resolve( self::document_of( array( $option ) ), array( 'opt' => 'HELLO' ), 8000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt' => 0 ), $result->value()['deltas'] );
		$this->assertContains( 'tiered', $result->value()['unpriced'] );
	}

	/**
	 * Which price types follow a base a currency switcher converted.
	 *
	 * 🔴 **`percentage` converts and the other four do not**, and a merchant
	 * relying on either behaviour needs it to be true rather than intended.
	 * `PRICING-SPEC.md` §6 states the split as a table; this executes it.
	 *
	 * The pair of bases is the point. A single base cannot express "does not
	 * convert" at all -- the assertion is that one type's delta *changes* with
	 * the base and the other's does not.
	 *
	 * @dataProvider provide_currency_cases
	 *
	 * @param array<string, mixed> $config   The published `price_config`.
	 * @param int                  $base_a   The base before conversion.
	 * @param int                  $base_b   The base after it.
	 * @param int                  $delta_a  Expected delta at the first base.
	 * @param int                  $delta_b  Expected delta at the second.
	 * @param bool                 $converts Whether the type follows the base.
	 * @param string|null          $answer   The customer's answer, for option-level types.
	 * @param string               $label    Case name, for the failure message.
	 */
	public function test_currency_conversion_follows_the_shared_split( array $config, int $base_a, int $base_b, int $delta_a, int $delta_b, bool $converts, ?string $answer, string $label ): void {
		/*
		 * Value-level and option-level types need different documents.
		 *
		 * `fixed` and `percentage` price a chosen value; `per_char`, `per_unit`
		 * and `tiered` price the option, and the case carries the answer the
		 * customer supplied. A case with no `answer` is a value-level one --
		 * which is also how the fixture distinguishes them without a second flag.
		 */
		if ( null === $answer ) {
			$document  = self::document( $config );
			$selection = array( 'opt' => 'val' );
		} else {
			$document  = self::document_of(
				array(
					array(
						'id'         => 'opt',
						'type'       => 'per_char' === ( $config['type'] ?? '' ) ? 'text' : 'number',
						'value_kind' => 'per_char' === ( $config['type'] ?? '' ) ? 'text' : 'number',
						'pricing'    => $config,
					),
				)
			);
			$selection = array( 'opt' => $answer );
		}

		$got_a = SelectionResolver::resolve( $document, $selection, $base_a )->value()['deltas']['opt'];
		$got_b = SelectionResolver::resolve( $document, $selection, $base_b )->value()['deltas']['opt'];

		$this->assertSame( $delta_a, $got_a, $label . ' -- at the first base' );
		$this->assertSame( $delta_b, $got_b, $label . ' -- at the converted base' );

		if ( $converts ) {
			$this->assertNotSame( $got_a, $got_b, $label . ' -- a relative type must follow the base' );
		} else {
			$this->assertSame( $got_a, $got_b, $label . ' -- an absolute amount must not move with the base' );
		}
	}

	/**
	 * The currency cases, read from the file both languages share.
	 *
	 * @return array<string, array{0: array<string, mixed>, 1: int, 2: int, 3: int, 4: int, 5: bool, 6: string|null, 7: string}>
	 */
	public static function provide_currency_cases(): array {
		$cases = array();

		foreach ( self::fixture()['currency_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(array) $case['config'],
				(int) $case['base_minor_a'],
				(int) $case['base_minor_b'],
				(int) $case['expect_delta_a'],
				(int) $case['expect_delta_b'],
				(bool) $case['converts'],
				isset( $case['answer'] ) ? (string) $case['answer'] : null,
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * Every declared currency case ran.
	 */
	public function test_every_declared_currency_case_ran(): void {
		$this->assertSame(
			(int) self::fixture()['currency_case_count'],
			count( self::provide_currency_cases() )
		);
	}

	/**
	 * 🔴 A delta is minor units, so its meaning depends on the store's decimals.
	 *
	 * The same stored integer is `5.00` in a 2-decimal currency, `500` in a
	 * 0-decimal one and `0.500` in a 3-decimal one -- a hundredfold swing in
	 * either direction, from a document that deliberately carries no currency.
	 *
	 * `wc_get_price_decimals()` was hardcoded to 2 in the test harness until
	 * M16.6, so neither JPY nor KWD could be exercised while `PRICING-SPEC.md`
	 * §6 discussed both. This is the assertion that stub gap was hiding.
	 *
	 * @dataProvider provide_decimal_counts
	 *
	 * @param int    $decimals The store's decimal count.
	 * @param string $expected How 500 minor units render.
	 */
	public function test_a_delta_renders_by_the_stores_decimal_count( int $decimals, string $expected ): void {
		$GLOBALS['optionia_test_decimals'] = $decimals;

		$this->assertSame( $expected, Money::from_minor( 500 )->to_decimal_string() );
	}

	/**
	 * The decimal counts WooCommerce actually ships with.
	 *
	 * @return array<string, array{0: int, 1: string}>
	 */
	public static function provide_decimal_counts(): array {
		return array(
			'JPY, no decimals'  => array( 0, '500' ),
			'GBP, two decimals' => array( 2, '5.00' ),
			'KWD, three'        => array( 3, '0.500' ),
		);
	}

	/**
	 * 🔴 Rounding is to the nearest MINOR unit, whatever that unit is.
	 *
	 * `PRICING-SPEC.md` §6 names this: a "round to the nearest penny" rule would
	 * be wrong for both JPY and KWD. The evaluator never sees a decimal count at
	 * all, which is what makes it true -- asserted here so a future change that
	 * introduced one has to break a named test.
	 */
	public function test_the_evaluator_is_indifferent_to_the_decimal_count(): void {
		$document = self::document(
			array(
				'type'         => 'percentage',
				'basis_points' => 5000,
			)
		);
		$deltas   = array();

		foreach ( array( 0, 2, 3 ) as $decimals ) {
			$GLOBALS['optionia_test_decimals'] = $decimals;

			$deltas[] = SelectionResolver::resolve( $document, array( 'opt' => 'val' ), 8000 )->value()['deltas']['opt'];
		}

		$this->assertSame(
			array( 4000, 4000, 4000 ),
			$deltas,
			'A delta is a count of minor units; the store\'s decimals govern display alone.'
		);
	}

	/**
	 * 🔴 A frozen delta is minor units, and a currency change does not move it.
	 *
	 * The sharpest edge of the "one store, one currency" position, and the one a
	 * merchant meets first. A delta is frozen at add-to-cart as a **count of
	 * minor units**; switching the store's base currency changes what a minor
	 * unit is, and nothing recomputes the frozen number -- because recomputing is
	 * exactly what the price freeze exists to prevent.
	 *
	 * Measured through the production classes: a line quoted at 85.00 with two
	 * decimals charges **580** after a switch to zero, since the frozen `500`
	 * meant 5.00 when quoted and 500 afterwards.
	 *
	 * Asserted rather than merely documented, because `PRICING-SPEC.md` §6 and
	 * `docs/OPTION-TYPES.md` both now state the number -- and a documented
	 * number nobody executes is the drift this project's gates exist to stop.
	 */
	public function test_a_frozen_delta_does_not_follow_a_currency_change(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			self::published_fixed_document(),
			'W/"cur"'
		);

		$GLOBALS['optionia_test_decimals'] = 2;

		$product = optionia_test_product( self::PRODUCT_ID, 'simple', '80.00' );

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );
		$attached                    = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertSame(
			array( 'opt-a' => 500 ),
			$attached[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ] ?? null,
			'Frozen as a count of minor units, which is what makes the rest follow.'
		);

		// The merchant switches the store's base currency while the cart lives.
		$GLOBALS['optionia_test_decimals'] = 0;

		$switched = optionia_test_product( self::PRODUCT_ID, 'simple', '80' );
		$cart     = optionia_test_cart();
		$cart->add_line(
			'line-1',
			$switched,
			1,
			array_merge( $attached, array( 'product_id' => self::PRODUCT_ID ) )
		);

		( new CartTotals( new Repository( new Logger( new Settings() ) ), new Logger( new Settings() ) ) )
			->apply( $cart );

		$this->assertSame(
			'580',
			$switched->get_price(),
			'The frozen 500 minor units now mean 500, not 5.00 -- a currency change is not safe while carts are live.'
		);
	}

	/**
	 * A published document assigning one fixed-price option to the test product.
	 *
	 * @return array<string, mixed>
	 */
	private static function published_fixed_document(): array {
		return array(
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
							'id'      => 'g',
							'options' => array(
								array(
									'id'     => 'opt-a',
									'type'   => 'radio',
									'values' => array(
										array(
											'value_key'    => 'lux',
											'price_config' => array(
												'type' => 'fixed',
												'amount_minor' => 500,
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
		);
	}

	/**
	 * A published document carrying one option with one priced value.
	 *
	 * @param array<string, mixed> $config The value's `price_config`.
	 * @return array<int, array<string, mixed>>
	 */
	private static function document( array $config ): array {
		return self::document_of( array( self::option( 'opt', $config ) ) );
	}

	/**
	 * A published document wrapping the given options in one set and one group.
	 *
	 * Options nest under `groups`, not directly on the set -- a shape worth
	 * building in one place, since a document missing that level resolves to no
	 * options at all and every case fails identically at `is_ok()`, which reads
	 * like a pricing bug rather than a malformed fixture.
	 *
	 * @param array<int, array<string, mixed>> $options The options to publish.
	 * @return array<int, array<string, mixed>>
	 */
	private static function document_of( array $options ): array {
		return array(
			array(
				'id'     => 'set',
				'groups' => array(
					array( 'options' => $options ),
				),
			),
		);
	}

	/**
	 * One select option whose single value carries the given price config.
	 *
	 * @param string               $id     The option id; its value is always `val`.
	 * @param array<string, mixed> $config The value's `price_config`.
	 * @return array<string, mixed>
	 */
	private static function option( string $id, array $config ): array {
		return array(
			'id'     => $id,
			'type'   => 'select',
			'values' => array(
				array(
					'value_key'    => 'val',
					'price_config' => $config,
				),
			),
		);
	}

	/**
	 * The shared fixture, decoded.
	 *
	 * @return array<string, mixed>
	 * @throws \RuntimeException When the fixture is missing or malformed.
	 */
	private static function fixture(): array {
		$path = __DIR__ . '/../fixtures/shared/pricing-fixtures.json';
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local test fixture, not a URL.
		$raw = file_get_contents( $path );

		if ( false === $raw ) {
			throw new \RuntimeException( 'Shared fixture missing: ' . esc_html( $path ) );
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) || ! isset( $decoded['config_cases'] ) ) {
			throw new \RuntimeException( 'Shared fixture holds no config_cases array.' );
		}

		return $decoded;
	}
}
