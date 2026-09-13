<?php
/**
 * Multi-select resolution (M18.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SelectionResolver;
use PHPUnit\Framework\TestCase;

/**
 * What changes when an option declares `cardinality: many`.
 *
 * 🔴 **The first half of a path ADR-057 splits across three stages.** This one
 * proves the resolver accepts, validates and prices an array. Carrying it
 * through the cart, the order and the analytics report is 18-2; opening the
 * registry so a merchant can author it is 18-3.
 *
 * ⚠️ **Every assertion is on a NUMBER or a SHAPE, never on `is_ok()` alone.**
 * A resolver that accepted an array and priced one entry of it would satisfy any
 * test asking only whether the request succeeded — and that is exactly the
 * defect this stage exists to remove.
 *
 * @covers \Optionia\Engine\SelectionResolver
 */
final class MultiSelectResolutionTest extends TestCase {

	/**
	 * Two chosen values contribute two deltas, and both are charged.
	 *
	 * 🔴 **The defect this replaces was silent.** Before M18.1 every checkbox
	 * shared one field name, so `red&blue` reached PHP as `blue` alone — the
	 * customer was charged 1.00 for a 3.00 selection and the resolver reported
	 * success. Measured.
	 */
	public function test_every_chosen_value_is_charged(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000,
			null,
			true
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1300, $result->value()['total_minor'] );

		/*
		 * 🔴 **One entry for the option, carrying BOTH values' prices** (ADR-061).
		 *
		 * Until M18.2 this asserted `assertCount( 2, ... )` — one delta per
		 * chosen value — which was the positional shape that broke the pairing
		 * downstream. The number is the stronger assertion anyway: 300 is
		 * 100 + 200, and a resolver that priced only `red` would report 100.
		 */
		$this->assertSame( array( 'opt-a' => 300 ), $result->value()['deltas'] );
	}

	/**
	 * `resolved` carries a list for `many`, and a scalar for `one`.
	 *
	 * ⚠️ **The shape is the contract with M18.2.** `CartItemData` freezes this
	 * map onto the line and `OrderLineItem` writes it to the order meta a
	 * merchant fulfils from, so what it holds decides what those two must learn
	 * to read.
	 */
	public function test_resolved_carries_a_list_only_for_many(): void {
		$many = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			0,
			null,
			true
		);

		$this->assertSame( array( 'opt-a' => array( 'red', 'blue' ) ), $many->value()['resolved'] );

		$one = SelectionResolver::resolve( self::sets( 'one' ), array( 'opt-a' => 'red' ) );

		$this->assertSame( array( 'opt-a' => 'red' ), $one->value()['resolved'] );
	}

	/**
	 * 🔴 An array is refused for an option that does not declare `many`.
	 *
	 * The probe the original scalar gate was written for, and it must survive:
	 * `cardinality` is the merchant's declaration, and a payload sending an
	 * array to a single-value option is not a typo.
	 */
	public function test_an_array_is_refused_for_a_single_value_option(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'one' ),
			array( 'opt-a' => array( 'red', 'blue' ) )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_NOT_SCALAR, $result->get_errors()[0]['code'] );
	}

	/**
	 * ...and an unrecognised cardinality takes the single-value path.
	 *
	 * The safe direction: a document from a newer cloud naming a cardinality
	 * this build does not know must not hand an array to nine consumers that
	 * expect a scalar.
	 */
	public function test_an_unknown_cardinality_is_treated_as_one(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'several' ),
			array( 'opt-a' => array( 'red' ) )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_NOT_SCALAR, $result->get_errors()[0]['code'] );
	}

	/**
	 * 🔴 A nested array is refused, not stringified.
	 *
	 * `[['x']]` is the same probe one level down. Reaching `(string)` would emit
	 * a notice and coerce to `"Array"`, which would then be looked up as a value
	 * key and reported as merely unknown — a misleading error for a hostile
	 * payload.
	 */
	public function test_a_nested_array_is_refused(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', array( 'x' ) ) ),
			0,
			null,
			true
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_NOT_SCALAR, $result->get_errors()[0]['code'] );
	}

	/**
	 * 🔴 One bad key refuses the whole option, never half of it.
	 *
	 * A line that priced `red` and silently dropped `ghost` would charge a total
	 * the customer cannot account for — M11.5's whole subject.
	 */
	public function test_one_unknown_value_refuses_the_whole_option(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'ghost' ) ),
			1000,
			null,
			true
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_VALUE, $result->get_errors()[0]['code'] );
	}

	/**
	 * 🔴 The same value twice is charged once.
	 *
	 * A double-submit or a forged payload, and charging twice is the shape a
	 * customer disputes. 1100 is one `red`; 1200 would be two.
	 */
	public function test_a_duplicate_value_is_charged_once(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'red' ) ),
			1000,
			null,
			true
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1100, $result->value()['total_minor'] );
		$this->assertSame( array( 'opt-a' => array( 'red' ) ), $result->value()['resolved'] );
	}

	/**
	 * An empty array is an unanswered option, not an error.
	 *
	 * A browser posts nothing for an untouched multi-select; an empty array is
	 * what a script sends. Treating it as absent is what makes the two agree.
	 */
	public function test_an_empty_array_answers_nothing(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array() ),
			1000,
			null,
			true
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1000, $result->value()['total_minor'] );
		$this->assertArrayNotHasKey( 'opt-a', $result->value()['resolved'] );
	}

	/**
	 * ...and is still refused when the merchant marked the option required.
	 *
	 * The control. Without it, "an empty array answers nothing" would be
	 * satisfied by a resolver that ignored required options entirely.
	 */
	public function test_an_empty_array_still_fails_a_required_option(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array( 'opt-a' => array() ), 0, null, true );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_REQUIRED, $result->get_errors()[0]['code'] );
	}

	/**
	 * 🔴 **A `set_price` rule reprices ONE value of a multi-select, not all.**
	 *
	 * ADR-049 makes `set_price` *replace* a value's own price rather than add to
	 * it, and `set_price_for()` is asked **per value** precisely so a rule
	 * targeting one choice does not reprice its siblings. Nothing tested that
	 * against a multi-select until M18.2 — the composition existed and was
	 * unprotected.
	 *
	 * ⚠️ **Asserted on the summed number.** `red` keeps its authored 1.00 and
	 * `blue` is repriced to 50.00, so the option contributes 5100. A resolver
	 * that applied the rule to every chosen value would report 10000, and one
	 * that applied it to none would report 300 — both are single-number
	 * mistakes this catches.
	 */
	public function test_a_set_price_rule_reprices_only_its_own_value(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][] = array(
			'id'     => 'opt-t',
			'type'   => 'radio',
			'values' => array(
				array(
					'id'        => 'val-yes',
					'value_key' => 'yes',
				),
			),
		);

		$sets[0]['rules'] = array(
			array(
				'id'           => 'r1',
				'target_type'  => 'value',
				'target_id'    => 'v2',
				'action'       => 'set_price',
				'action_value' => array(
					'type'         => 'fixed',
					'amount_minor' => 5000,
				),
				'match_type'   => 'all',
				'conditions'   => array(
					array(
						'option_id' => 'opt-t',
						'operator'  => 'equals',
						'value'     => 'yes',
					),
				),
				'sort_order'   => 10,
			),
		);

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-t' => 'yes',
				'opt-a' => array( 'red', 'blue' ),
			),
			1000,
			null,
			true
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame(
			5100,
			$result->value()['deltas']['opt-a'],
			'Only the targeted value is repriced; its sibling keeps its own price.'
		);
		$this->assertSame(
			1000 + array_sum( $result->value()['deltas'] ),
			$result->value()['total_minor']
		);
	}

	/**
	 * 🔴 A rule-hidden value is caught in ANY position, not just the first.
	 *
	 * A guard reading `$chosen_keys[0]` would accept a payload whose second
	 * entry names a choice the customer's own answers removed — and the price
	 * for it would reach the line.
	 */
	public function test_a_hidden_value_is_caught_in_a_later_position(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][] = array(
			'id'     => 'opt-t',
			'type'   => 'radio',
			'values' => array(
				array(
					'id'        => 'val-yes',
					'value_key' => 'yes',
				),
			),
		);

		$sets[0]['rules'] = array(
			array(
				'id'          => 'r-1',
				'target_type' => 'value',
				'target_id'   => 'v2',
				'action'      => 'hide',
				'match_type'  => 'all',
				'conditions'  => array(
					array(
						'option_id' => 'opt-t',
						'operator'  => 'equals',
						'value'     => 'yes',
					),
				),
				'sort_order'  => 10,
			),
		);

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-t' => 'yes',
				'opt-a' => array( 'red', 'blue' ),
			),
			0,
			null,
			true
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_HIDDEN_BY_RULE, $result->get_errors()[0]['code'] );
	}

	/**
	 * Weight accumulates across every chosen value.
	 *
	 * ⚠️ **The one structure that already worked.** `weight_grams` uses `+=`, so
	 * it summed correctly before this stage — asserted so a refactor to a
	 * per-option assignment is a failing test rather than a silent undercharge
	 * on shipping.
	 */
	public function test_weight_sums_across_chosen_values(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][0]['values'][0]['weight_delta_grams'] = 500;
		$sets[0]['groups'][0]['options'][0]['values'][1]['weight_delta_grams'] = 250;

		$result = SelectionResolver::resolve( $sets, array( 'opt-a' => array( 'red', 'blue' ) ), 0, null, true );

		$this->assertSame( 750, $result->value()['weight_delta_grams'] );
	}

	/**
	 * One option with two values, at the cardinality a test asks for.
	 *
	 * @param string $cardinality What the option declares.
	 * @return array<int, array<string, mixed>>
	 */
	private static function sets( string $cardinality ): array {
		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
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
										'id'           => 'v1',
										'value_key'    => 'red',
										'label'        => 'Red',
										'price_config' => array(
											'type'         => 'fixed',
											'amount_minor' => 100,
										),
									),
									array(
										'id'           => 'v2',
										'value_key'    => 'blue',
										'label'        => 'Blue',
										'price_config' => array(
											'type'         => 'fixed',
											'amount_minor' => 200,
										),
									),
								),
							),
						),
					),
				),
				'rules'  => array(),
			),
		);
	}
}
