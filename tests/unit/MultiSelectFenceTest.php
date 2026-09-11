<?php
/**
 * The multi-select fence (M18.1, removed by M18.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SelectionResolver;
use PHPUnit\Framework\TestCase;

/**
 * A `many` document is refused until the cart can carry one.
 *
 * 🔴 **This file is the wall behind the fence M18.1 moved.** Before that stage
 * a `cardinality: many` document hit `ERROR_NOT_SCALAR` and the line was
 * refused — fail-closed by accident. M18.1 taught the resolver to accept an
 * array, which is correct and necessary, but nine consumers downstream still
 * expect a scalar. Between the two stages, accepting is the dangerous direction.
 *
 * ⚠️ **`MultiSelectResolutionTest` is its mirror.** That file passes
 * `$allow_many = true` to prove the resolution logic M18.2 will unfence; this
 * one passes nothing, which is what all five production callers pass.
 *
 * 🔴 **M18.2 deletes this whole file**, along with the guard and the parameter.
 * If it is still here when the cart carries multi-select, it is testing a fence
 * around an open gate.
 *
 * @covers \Optionia\Engine\SelectionResolver
 */
final class MultiSelectFenceTest extends TestCase {

	/**
	 * 🔴 A `many` option is refused by default, with its own code.
	 *
	 * The code matters as much as the refusal. `ERROR_NOT_SCALAR` would tell a
	 * merchant reading a log that a customer sent a malformed payload, when in
	 * fact they published an option this build cannot sell.
	 */
	public function test_a_many_option_is_refused_by_default(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_MANY_UNSUPPORTED,
			$result->get_errors()[0]['code']
		);
	}

	/**
	 * 🔴 **Refused even when the payload is a harmless single scalar.**
	 *
	 * The case that tempts a narrower guard. A `many` option answered with one
	 * value prices correctly today — so a fence reading the *payload* would let
	 * it through, and the merchant's multi-select would work until the first
	 * customer ticked a second box. The guard reads the option's declaration
	 * instead, which is the thing that does not vary per request.
	 */
	public function test_a_many_option_is_refused_even_for_a_single_answer(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => 'red' ),
			1000
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_MANY_UNSUPPORTED,
			$result->get_errors()[0]['code']
		);
	}

	/**
	 * ⚠️ The control: a `one` option is untouched by the fence.
	 *
	 * Without this, "many is refused" would be satisfied by a resolver that had
	 * stopped pricing anything at all.
	 */
	public function test_a_single_value_option_still_prices(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'one' ),
			array( 'opt-a' => 'red' ),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1100, $result->value()['total_minor'] );
	}

	/**
	 * 🔴 **The defect the fence exists to prevent, measured at its source.**
	 *
	 * `CartItemData::deltas_by_option()` pairs `resolved` with `deltas`
	 * POSITIONALLY and returns `array()` when the counts disagree —
	 * `trusted_deltas()` then finds no key, returns null, and **the line prices
	 * live**. This is the 16c mechanism, which historically quoted 85.00 and
	 * charged 130.00.
	 *
	 * Asserted here rather than in the cart because it is a property of the
	 * SHAPE: one selection carrying two deltas is a count mismatch by
	 * arithmetic, whatever the cart does with it. If M18.2 makes the pairing
	 * key-based, this test should be rewritten, not deleted — the question
	 * "can a multi-select line still be paired?" outlives the fence.
	 */
	public function test_a_many_result_would_break_positional_pairing(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000,
			null,
			true
		);

		$this->assertTrue( $result->is_ok() );

		$selections = $result->value()['resolved'];
		$deltas     = $result->value()['deltas'];

		$this->assertCount( 1, $selections );
		$this->assertCount( 2, $deltas );
		$this->assertNotSame(
			count( $selections ),
			count( $deltas ),
			'Positional pairing survives only while these counts agree.'
		);
	}

	/**
	 * 🔴 Chosen values are sorted into the MERCHANT'S order, not the click order.
	 *
	 * WooCommerce derives a cart line's key by hashing `cart_item_data`, so two
	 * customers reaching the same visible configuration must produce identical
	 * payloads. Measured before the fix: `["red","blue"]` and `["blue","red"]`
	 * hashed differently and split one product into two cart lines.
	 *
	 * ⚠️ **`ksort()` in `CartItemData` does not cover this** — it sorts option
	 * ids, the outer map, and says nothing about values within one option.
	 */
	public function test_value_order_is_normalised_to_the_authored_order(): void {
		$forward = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000,
			null,
			true
		);

		$backward = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'blue', 'red' ) ),
			1000,
			null,
			true
		);

		$this->assertSame(
			array( 'opt-a' => array( 'red', 'blue' ) ),
			$forward->value()['resolved']
		);
		$this->assertSame(
			$forward->value()['resolved'],
			$backward->value()['resolved'],
			'Two click orders must reach one cart line.'
		);
	}

	/**
	 * 🔴 **A fenced multi-select must not make the product UNBUYABLE.**
	 *
	 * The composition defect, and the reason each half of the fence needed
	 * testing against the other. `Renderer::option_markup()` skips a `many`
	 * option, so the customer never sees it — but the required pass still
	 * demanded it, returning `ERROR_REQUIRED` for a field that was never
	 * rendered. The customer reads "Please choose all required options" with
	 * nothing to choose, and **no amount of clicking fixes it**.
	 *
	 * ⚠️ **Both halves were right alone.** The renderer treated the option as
	 * absent; the resolver treated it as present-and-mandatory. Only together
	 * did they produce a dead end — which is why this assertion is on the
	 * product being sellable, not on an error code.
	 */
	public function test_a_required_multi_select_does_not_block_the_product(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array(), 1000 );

		$this->assertTrue(
			$result->is_ok(),
			'A skipped option must not be demanded; the product would be unbuyable.'
		);
		$this->assertSame( 1000, $result->value()['total_minor'] );
	}

	/**
	 * ⚠️ The control: a genuine required option still blocks.
	 *
	 * Without this, "a required multi-select does not block" would be satisfied
	 * by a resolver that had stopped enforcing `is_required` at all — which is
	 * the M11.5 overcharge shape, not a fix.
	 */
	public function test_a_required_single_value_option_still_blocks(): void {
		$sets = self::sets( 'one' );

		$sets[0]['groups'][0]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array(), 1000 );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_REQUIRED,
			$result->get_errors()[0]['code']
		);
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
