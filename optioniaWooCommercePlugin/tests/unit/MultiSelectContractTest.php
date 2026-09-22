<?php
/**
 * What a multi-select must satisfy to be sellable (M18.3).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SelectionResolver;
use PHPUnit\Framework\TestCase;

/**
 * The standing contract for an option that takes several answers.
 *
 * 🔴 **This file was `MultiSelectFenceTest`, and most of it outlived the
 * fence.** ADR-060 fenced `cardinality: many` off between M18.1 and M18.3,
 * because the resolver could accept an array the cart could not carry. M18.3
 * removed that fence — and these tests stayed, because they never really
 * asserted the fence: they assert the properties that made removing it safe.
 *
 * ⚠️ **Three tests did go with it.** Two asserted a `many` option was refused
 * outright. The third was **inverted rather than deleted**, and that inversion
 * is the clearest record of what the fence cost: while it stood, the renderer
 * skipped the option and the resolver still demanded it, so a merchant marking
 * one required made the product **unbuyable**.
 *
 * What remains is the contract: a multi-select pairs by option, its values sort
 * into the merchant's authored order, only `checkbox` may take several answers,
 * and a required one must be answered.
 *
 * @covers \Optionia\Engine\SelectionResolver
 */
final class MultiSelectContractTest extends TestCase {

	/**
	 * ⚠️ The control: a single-value option prices normally.
	 *
	 * Without it, the multi-select assertions here would be satisfied by a
	 * resolver that had stopped pricing anything at all.
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
	 * 🔴 **A multi-select line can be paired, which is what M18.2 changed.**
	 *
	 * ⚠️ **Rewritten, not deleted — ADR-060 said it should be.** It used to
	 * assert the *opposite*: that one selection carrying two deltas was a count
	 * mismatch, so `deltas_by_option()` returned `array()`, `trusted_deltas()`
	 * returned null and **the line priced live** — 16c's mechanism, which
	 * historically quoted 85.00 and charged 130.00.
	 *
	 * ADR-061 closed that by keying `deltas` on the option id and summing across
	 * its chosen values. The question the old test asked — *"can a multi-select
	 * line still be paired?"* — outlives the fence, so it is asked here in the
	 * affirmative rather than dropped.
	 *
	 * 🔴 **Asserted on the NUMBER, not just the count.** 300 is 100 + 200; a
	 * resolver that keyed correctly but priced only the first value would give
	 * equal counts and a wrong total, which is exactly the silent shape this
	 * whole stage exists to prevent.
	 */
	public function test_a_many_result_pairs_by_option(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertTrue( $result->is_ok() );

		$selections = $result->value()['resolved'];
		$deltas     = $result->value()['deltas'];

		$this->assertSame(
			count( $selections ),
			count( $deltas ),
			'One entry per option on both sides, or the pairing cannot be keyed.'
		);
		$this->assertSame( array( 'opt-a' => 300 ), $deltas );
		$this->assertSame(
			1000 + array_sum( $deltas ),
			$result->value()['total_minor'],
			'The paired deltas must account for the whole line.'
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
			1000
		);

		$backward = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'blue', 'red' ) ),
			1000
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
	 * 🔴 **A required multi-select must be answered, like any other option.**
	 *
	 * ⚠️ **This test asserted the OPPOSITE while the fence stood**, and the
	 * inversion is the point. Between M18.1 and M18.3 the renderer skipped a
	 * `many` option while the required pass still demanded it — so a merchant
	 * who marked one required made the product **unbuyable**: "Please choose all
	 * required options" with nothing on the page to choose. Both halves of the
	 * fence were individually correct; only together did they strand the
	 * customer.
	 *
	 * M18.3 removed the fence, so the option is on the page and requiring it is
	 * simply correct. Kept rather than deleted because the property it guards —
	 * that what the storefront renders and what the resolver demands agree — is
	 * what the dead end was made of.
	 */
	public function test_a_required_multi_select_must_be_answered(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array(), 1000 );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_REQUIRED,
			$result->get_errors()[0]['code']
		);
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
	 * 🔴 **A `radio` declaring `many` is refused — one shirt, not two sizes.**
	 *
	 * Measured before this guard: `ok=true total=1500`. A radio is
	 * single-choice *by definition*, and `cardinality` alone never asked what
	 * the type could do — so a crafted payload bought Small **and** Large on one
	 * line and was charged for both.
	 *
	 * ⚠️ **Unreachable through the dashboard today is not the same as safe.**
	 * The backend registry allows `MANY` for no type at all, so this needs a
	 * crafted payload or a mis-published document — but AC4 makes the document
	 * input rather than authority, and **M18.3 adds `MANY` to the registry**.
	 * The guard lands first.
	 */
	public function test_a_radio_declaring_many_is_refused(): void {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][0]['type'] = 'radio';

		$result = SelectionResolver::resolve(
			$sets,
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertFalse(
			$result->is_ok(),
			'A radio must not accept two answers, whatever its cardinality says.'
		);
	}

	/**
	 * 🔴 **Every type outside the whitelist is refused, not just `radio`.**
	 *
	 * ⚠️ **A whitelist, so an unrecognised type takes the SINGLE-value path** —
	 * the same safe direction an unknown cardinality takes. A blacklist would
	 * pass every type nobody thought to forbid, and `file_input` at `many` is
	 * the worst of those: it bypasses every upload-token path, each of which
	 * reads one token per option.
	 */
	public function test_only_checkbox_may_take_several_answers(): void {
		foreach ( array( 'dropdown', 'date_picker', 'file_input', 'text_field', 'a_type_from_a_newer_cloud' ) as $type ) {
			$sets = self::sets( 'many' );

			$sets[0]['groups'][0]['options'][0]['type'] = $type;

			$result = SelectionResolver::resolve(
				$sets,
				array( 'opt-a' => array( 'red', 'blue' ) ),
				1000
			);

			$this->assertFalse(
				$result->is_ok(),
				$type . ' must not take several answers.'
			);
		}
	}

	/**
	 * ⚠️ The control: `checkbox` at `many` still resolves.
	 *
	 * Without it, both assertions above would be satisfied by a whitelist that
	 * had become empty — which refuses multi-select entirely rather than
	 * refusing the wrong types.
	 */
	public function test_checkbox_is_on_the_whitelist(): void {
		$result = SelectionResolver::resolve(
			self::sets( 'many' ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt-a' => 300 ), $result->value()['deltas'] );
	}

	/**
	 * 🔴 **`max_selections` is enforced, and it never was before M18.3a.**
	 *
	 * ADR-057 recorded these as *"authorable per option and enforced nowhere,
	 * because there is nothing to count"* and said the multi-select stage would
	 * make them mean something. M18.1 to M18.3 built the whole array path and
	 * left both rules unread — a merchant capping an option at two got three.
	 *
	 * ⚠️ **Server-side, though the browser could limit ticking.** AC4 makes the
	 * request untrusted: a crafted payload carries twenty values for an option
	 * capped at two, and each one is a price.
	 */
	public function test_more_values_than_max_selections_are_refused(): void {
		$result = SelectionResolver::resolve(
			self::bounded( array( 'max_selections' => 1 ) ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_TOO_MANY,
			$result->get_errors()[0]['code']
		);
	}

	/**
	 * 🔴 **`min_selections` is enforced, with its OWN code.**
	 *
	 * Distinct from `ERROR_REQUIRED` because the actions differ: a customer who
	 * ticked one box for an option demanding two *answered* it, and telling
	 * them to "choose all required options" sends them looking for a field they
	 * already filled. The same reasoning `ERROR_TOO_SHORT` records for text.
	 */
	public function test_fewer_values_than_min_selections_are_refused(): void {
		$result = SelectionResolver::resolve(
			self::bounded( array( 'min_selections' => 2 ) ),
			array( 'opt-a' => array( 'red' ) ),
			1000
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_TOO_FEW,
			$result->get_errors()[0]['code']
		);
	}

	/**
	 * 🔴 **Duplicates cannot satisfy a minimum.**
	 *
	 * The count is taken **after** deduplication, so `["red","red","red"]` is
	 * one choice however it was submitted. Counting the raw payload would let a
	 * customer meet a minimum of three by ticking one box thrice — billed once,
	 * dressed as three — which is the shape M11.5 exists to prevent.
	 */
	public function test_duplicates_do_not_satisfy_a_minimum(): void {
		$result = SelectionResolver::resolve(
			self::bounded( array( 'min_selections' => 3 ) ),
			array( 'opt-a' => array( 'red', 'red', 'red' ) ),
			1000
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			SelectionResolver::ERROR_TOO_FEW,
			$result->get_errors()[0]['code']
		);
	}

	/**
	 * ⚠️ The control: a selection inside both bounds resolves and prices.
	 *
	 * Without it, the three assertions above would be satisfied by a resolver
	 * that had started refusing every multi-select.
	 */
	public function test_a_selection_within_its_bounds_still_prices(): void {
		$result = SelectionResolver::resolve(
			self::bounded(
				array(
					'min_selections' => 1,
					'max_selections' => 2,
				)
			),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1300, $result->value()['total_minor'] );
	}

	/**
	 * ⚠️ **An untouched optional option is not "too few".**
	 *
	 * `min_selections` is not a second `is_required`: it speaks only once the
	 * customer has chosen something. An empty answer is the required pass's
	 * business, and reporting both would name one field twice.
	 */
	public function test_an_untouched_option_is_not_too_few(): void {
		$result = SelectionResolver::resolve(
			self::bounded( array( 'min_selections' => 2 ) ),
			array( 'opt-a' => array() ),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1000, $result->value()['total_minor'] );
	}

	/**
	 * ⚠️ **A malformed bound is no bound, not a refusal.**
	 *
	 * The document is input rather than authority (AC4). Refusing every
	 * selection because a limit arrived as `"two"` would take a product off
	 * sale over a typo in a field the customer cannot see — the same direction
	 * `max_length()` takes for text.
	 */
	public function test_a_malformed_bound_is_ignored(): void {
		$result = SelectionResolver::resolve(
			self::bounded( array( 'max_selections' => 'two' ) ),
			array( 'opt-a' => array( 'red', 'blue' ) ),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1300, $result->value()['total_minor'] );
	}

	/**
	 * A configuration with the given selection bounds.
	 *
	 * @param array<string, mixed> $validation The option's validation rules.
	 * @return array<int, array<string, mixed>>
	 */
	private static function bounded( array $validation ): array {
		$sets = self::sets( 'many' );

		$sets[0]['groups'][0]['options'][0]['validation'] = $validation;

		return $sets;
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
