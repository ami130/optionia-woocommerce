<?php
/**
 * Rules meeting the resolver (M17.8).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SelectionResolver;
use PHPUnit\Framework\TestCase;

/**
 * What changes once `resolve()` evaluates rules before it validates selections.
 *
 * Separate from `SelectionResolverTest` because these assert a different thing:
 * that suite proves `config × selections → deltas`, and this one proves the
 * **order** — that whether a submitted value is legal depends on the rule
 * outcome, which is only true if rules run first.
 *
 * 🔴 **Every assertion here is on an outcome, never on an exit code.** Phase 16
 * shipped two defects behind green suites (16b, 16c), both because a test
 * asserted that something was accepted rather than what it produced. A rule that
 * silently failed to fire would pass any test checking only `is_ok()`.
 *
 * @covers \Optionia\Engine\SelectionResolver
 */
final class RuleDrivenResolutionTest extends TestCase {

	/**
	 * Submitting a value for a rule-hidden option fails validation.
	 *
	 * M17.4's clause, and the first of the two Phase 17 criteria 17-8 owes.
	 * `ERROR_HIDDEN_BY_RULE` rather than `ERROR_UNKNOWN_OPTION`: the product has
	 * the option, and the customer's own earlier answer took it off the page.
	 */
	public function test_a_value_for_a_rule_hidden_option_is_refused(): void {
		$result = SelectionResolver::resolve(
			self::sets_with_rule( 'hide', 'option', 'opt-b' ),
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			)
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame(
			array(
				array(
					'code'   => SelectionResolver::ERROR_HIDDEN_BY_RULE,
					'field'  => 'opt-b',
					'params' => array(),
				),
			),
			$result->get_errors()
		);
	}

	/**
	 * A rule-hidden option is neither charged nor stored.
	 *
	 * ADR-051, and the second criterion. **Asserted on the number and on the
	 * stored map together**, because 16c's defect was exactly the mismatch: a
	 * value dropped from one and kept in the other. `deltas_by_option()` pairs
	 * them positionally and returns empty when the counts differ, which silently
	 * defeats the price freeze — measured then as a line quoted at 85.00 and
	 * charged at 130.00.
	 *
	 * The customer here submits nothing for the hidden option, so this is the
	 * honest path rather than the forged one above.
	 */
	public function test_a_rule_hidden_option_is_neither_charged_nor_stored(): void {
		$result = SelectionResolver::resolve(
			self::sets_with_rule( 'hide', 'option', 'opt-b' ),
			array( 'opt-a' => 'yes' ),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1000, $result->value()['total_minor'] );
		$this->assertSame( array( 'opt-a' => 'yes' ), $result->value()['resolved'] );
		$this->assertCount( 1, $result->value()['deltas'] );
	}

	/**
	 * A hidden option is not required, even when the merchant marked it so.
	 *
	 * Requiring an answer to a question the customer cannot see is an unbuyable
	 * product: the form refuses and names a field that is not on the page.
	 */
	public function test_a_hidden_option_is_never_required(): void {
		$sets = self::sets_with_rule( 'hide', 'option', 'opt-b' );

		$sets[0]['groups'][1]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array( 'opt-a' => 'yes' ) );

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * With the rule not firing, the same option IS required.
	 *
	 * The control for the test above. Without it, a mutation that skipped the
	 * required pass entirely would pass — the assertion "no error" is satisfied
	 * just as well by a check that never runs.
	 */
	public function test_the_same_option_is_required_when_the_rule_does_not_fire(): void {
		$sets = self::sets_with_rule( 'hide', 'option', 'opt-b' );

		$sets[0]['groups'][1]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array( 'opt-a' => 'no' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_REQUIRED, $result->get_errors()[0]['code'] );
		$this->assertSame( 'opt-b', $result->get_errors()[0]['field'] );
	}

	/**
	 * Hiding a GROUP hides every option inside it.
	 *
	 * The containment index's reason to exist: a rule names a target, and only
	 * an option holds an answer.
	 */
	public function test_hiding_a_group_hides_the_options_it_contains(): void {
		$result = SelectionResolver::resolve(
			self::sets_with_rule( 'hide', 'group', 'group-b' ),
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			)
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_HIDDEN_BY_RULE, $result->get_errors()[0]['code'] );
	}

	/**
	 * 🔴 Hiding one VALUE does not hide the option that owns it.
	 *
	 * The asymmetry `hidden_options()` exists to preserve. `index_containment()`
	 * maps a value to its option — the right answer to *"where does this target
	 * live"* and the wrong answer to *"what does hiding it clear"*. Measured
	 * before `hidden_options()` read `target_type`: a rule hiding one value
	 * emptied the whole option, and its other three choices became unsubmittable.
	 */
	public function test_hiding_one_value_leaves_the_options_other_values_choosable(): void {
		$result = SelectionResolver::resolve(
			self::sets_with_rule( 'hide', 'value', 'val-extra' ),
			array(
				'opt-a' => 'yes',
				'opt-b' => 'plain',
			)
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame(
			array(
				'opt-a' => 'yes',
				'opt-b' => 'plain',
			),
			$result->value()['resolved']
		);
	}

	/**
	 * ...but the hidden value itself is refused.
	 *
	 * The other half of the pair above. Reported as hidden rather than unknown:
	 * the key is real and the merchant authored it, so telling the customer it
	 * does not exist would send them hunting for a typo they did not make.
	 */
	public function test_the_hidden_value_itself_is_refused(): void {
		$result = SelectionResolver::resolve(
			self::sets_with_rule( 'hide', 'value', 'val-extra' ),
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			)
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_HIDDEN_BY_RULE, $result->get_errors()[0]['code'] );
	}

	/**
	 * `set_price` replaces the value's own price rather than adding to it.
	 *
	 * ADR-049. The value is authored at 250 and the rule sets 900: a total of
	 * 900 over the base proves replacement, 1150 would prove addition, and
	 * asserting only `is_ok()` would prove neither.
	 */
	public function test_set_price_replaces_the_authored_value_price(): void {
		$sets = self::sets_with_rule( 'set_price', 'option', 'opt-b' );

		$sets[0]['rules'][0]['action_value'] = array( 'amount_minor' => 900 );

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1900, $result->value()['total_minor'] );
	}

	/**
	 * `set_price` against an option-level price is refused and reported.
	 *
	 * ADR-049's second half. `per_char` holds a **rate**, not an amount, so a
	 * flat override would charge the same for a 3-character engraving as for a
	 * 300-character one. The cloud refuses the combination at publish; AC4 makes
	 * the document input rather than authority, so a stale cache can still
	 * deliver it and this reports rather than trusts.
	 */
	public function test_set_price_against_option_level_pricing_is_reported_not_applied(): void {
		$sets = self::sets_with_rule( 'set_price', 'option', 'opt-b' );

		$sets[0]['rules'][0]['action_value']           = array( 'amount_minor' => 900 );
		$sets[0]['groups'][1]['options'][0]['pricing'] = array(
			'type'         => 'per_char',
			'amount_minor' => 10,
		);

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertContains( 'per_char', $result->value()['unpriced'] );
		$this->assertNotSame( 1900, $result->value()['total_minor'] );
	}

	/**
	 * A cascade deeper than the pass limit refuses the whole resolution.
	 *
	 * ADR-050. Proceeding with whatever the last pass produced would make the
	 * price depend on where the loop was cut. Publish-time cycle detection
	 * should make this unreachable from the dashboard; it is enforced anyway,
	 * because a document from an older or newer cloud is still one this build
	 * has to survive.
	 *
	 * ⚠️ **A chain, not a cycle.** A cycle would be caught at publish and
	 * *converges* here anyway — once hides accumulate, a rule whose condition
	 * its own hide cleared stays hidden, which is what makes the fixed point
	 * monotone. Twelve links is the cheapest thing the ten-pass cap actually
	 * refuses, and the shared fixture pins the same shape.
	 */
	public function test_a_cascade_deeper_than_the_pass_limit_is_refused(): void {
		$options = array();
		$rules   = array();
		$answers = array();

		for ( $i = 0; $i <= 12; $i++ ) {
			$options[] = array(
				'id'     => "opt-$i",
				'type'   => 'radio',
				'values' => array(
					array(
						'id'        => "val-$i",
						'value_key' => 'x',
					),
				),
			);

			$answers[ "opt-$i" ] = 'x';

			if ( $i > 0 ) {
				$rules[] = self::rule( "r-$i", 'hide', 'option', "opt-$i", 'opt-' . ( $i - 1 ), 'is_empty', null );
			}
		}

		// The first link fires on an answer that is present, starting the chain.
		$rules[0] = self::rule( 'r-1', 'hide', 'option', 'opt-1', 'opt-0', 'is_not_empty', null );

		$result = SelectionResolver::resolve(
			array(
				array(
					'id'     => 'set-1',
					'groups' => array(
						array(
							'id'      => 'group-a',
							'options' => $options,
						),
					),
					'rules'  => $rules,
				),
			),
			$answers
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_RULES_UNSETTLED, $result->get_errors()[0]['code'] );
	}

	/**
	 * A document with no rules resolves exactly as it did before 17-8.
	 *
	 * The regression this stage most had to avoid: `resolve()` is the path every
	 * add-to-cart takes, and the overwhelming majority of documents carry no
	 * rules at all.
	 */
	public function test_a_document_without_rules_is_unaffected(): void {
		$sets = self::sets_with_rule( 'hide', 'option', 'opt-b' );

		unset( $sets[0]['rules'] );

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1250, $result->value()['total_minor'] );
		$this->assertSame(
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			),
			$result->value()['resolved']
		);
	}

	/**
	 * Two sets, and a rule in one reads an option in the other.
	 *
	 * `index_rules()` flattens across sets for this reason: a product may match
	 * several, and evaluating each separately could not settle a rule that
	 * spans them.
	 */
	public function test_a_rule_in_one_set_can_hide_an_option_in_another(): void {
		$sets   = self::sets_with_rule( 'hide', 'option', 'opt-b' );
		$sets[] = array(
			'id'     => 'set-2',
			'groups' => array(
				array(
					'id'      => 'group-c',
					'options' => array(
						array(
							'id'     => 'opt-c',
							'type'   => 'radio',
							'values' => array(
								array(
									'id'        => 'val-c',
									'value_key' => 'cee',
								),
							),
						),
					),
				),
			),
			'rules'  => array(
				self::rule( 'r-2', 'hide', 'option', 'opt-c', 'opt-a', 'equals', 'yes' ),
			),
		);

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-a' => 'yes',
				'opt-c' => 'cee',
			)
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_HIDDEN_BY_RULE, $result->get_errors()[0]['code'] );
		$this->assertSame( 'opt-c', $result->get_errors()[0]['field'] );
	}

	/**
	 * `sort_order` never decides a price.
	 *
	 * ADR-052, and M17.4a's finding: while `sortOrder` was consulted, two
	 * `set_price` rules of 500 and 700 produced order-dependent totals in both
	 * languages identically. The same two rules are resolved here in both
	 * document orders and must agree.
	 */
	public function test_two_set_price_rules_agree_whichever_order_they_arrive_in(): void {
		$first  = self::sets_with_set_price_pair( false );
		$second = self::sets_with_set_price_pair( true );

		$selections = array(
			'opt-a' => 'yes',
			'opt-b' => 'extra',
		);

		$a = SelectionResolver::resolve( $first, $selections, 1000 );
		$b = SelectionResolver::resolve( $second, $selections, 1000 );

		$this->assertTrue( $a->is_ok() );
		$this->assertTrue( $b->is_ok() );
		$this->assertSame( $a->value()['total_minor'], $b->value()['total_minor'] );

		/*
		 * ⚠️ **Agreeing is not enough** — two orders returning the same WRONG
		 * number would satisfy the assertion above, and that is precisely the
		 * failure mode this test exists to catch. So the outcome is pinned too:
		 * the conflict cancels, the authored 250 is not silently substituted,
		 * and the merchant is told.
		 */
		$this->assertSame( 1000, $a->value()['total_minor'] );
		$this->assertContains( SelectionResolver::UNPRICED_RULE_CONFLICT, $a->value()['unpriced'] );
		$this->assertContains( SelectionResolver::UNPRICED_RULE_CONFLICT, $b->value()['unpriced'] );
	}

	/**
	 * 🔴 Hiding a value does not erase the answer of a customer who chose another.
	 *
	 * The defect M17.8's audit found, and the reason `index_containment()` maps a
	 * value to **nothing**. The old mapping sent a value target to its owning
	 * option — right for *"where does this live"*, wrong for *"whose answer
	 * disappears"* — so hiding one choice deleted the answer of a customer who
	 * had picked a different one, and unrelated rules reading that option then
	 * fired.
	 *
	 * ⚠️ **The assertion is on the THIRD option**, not on the one that owns the
	 * hidden value. `hidden_options()` filtered value targets correctly one layer
	 * up, which is exactly why this went unseen for four stages: the corruption
	 * happened underneath the filter, and only a rule reading the erased answer
	 * can see it.
	 */
	public function test_hiding_a_value_does_not_erase_the_answer_another_rule_reads(): void {
		$sets = self::sets_with_rule( 'hide', 'value', 'val-extra' );

		$sets[0]['groups'][] = array(
			'id'      => 'group-c',
			'options' => array(
				array(
					'id'     => 'opt-c',
					'type'   => 'radio',
					'values' => array(
						array(
							'id'        => 'val-c',
							'value_key' => 'cee',
						),
					),
				),
			),
		);

		// Fires only if opt-b's answer went missing -- and it must not.
		$sets[0]['rules'][] = self::rule( 'r-2', 'hide', 'option', 'opt-c', 'opt-b', 'is_empty', null );

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-a' => 'yes',
				'opt-b' => 'plain',
				'opt-c' => 'cee',
			)
		);

		$this->assertTrue( $result->is_ok(), 'opt-b is answered, so opt-c must not be hidden' );
		$this->assertArrayHasKey( 'opt-c', $result->value()['resolved'] );
	}

	/**
	 * 🔴 `set_price` reaches a text option, which has no values to look up.
	 *
	 * The second defect the audit found: `set_price_for()` had one call site,
	 * inside the branch that resolves a *chosen value*, so a rule targeting a
	 * text, number, date or file option was neither applied nor reported.
	 * Measured before the fix — this exact configuration charged **1000**, the
	 * bare base, and `unpriced` was empty. A silent undercharge.
	 */
	public function test_set_price_applies_to_a_text_option(): void {
		$result = SelectionResolver::resolve( self::sets_with_text_rule( null ), self::text_answers(), 1000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1900, $result->value()['total_minor'] );
	}

	/**
	 * ...and is refused, not applied, where the option prices itself.
	 *
	 * ADR-049 §3: *"the evaluator ignores the `set_price` and adds the type to
	 * `unpriced`"* — so the merchant's own `per_char` still charges, and the
	 * discarded rule is reported rather than silently dropped. 1050 is base plus
	 * five characters at 10; 1900 would mean the rule won.
	 */
	public function test_set_price_against_per_char_is_reported_and_the_authored_rate_still_applies(): void {
		$result = SelectionResolver::resolve(
			self::sets_with_text_rule(
				array(
					'type'         => 'per_char',
					'amount_minor' => 10,
				)
			),
			self::text_answers(),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1050, $result->value()['total_minor'] );
		$this->assertContains( 'per_char', $result->value()['unpriced'] );
	}

	/**
	 * A conflicting pair on a text option cancels, exactly as on a choice.
	 *
	 * The `false`-versus-`null` distinction reaches `option_delta()` too: a
	 * cancelled conflict must not fall back to the authored pricing there
	 * either.
	 */
	public function test_a_conflicting_set_price_on_a_text_option_charges_nothing(): void {
		$sets = self::sets_with_text_rule(
			array(
				'type'         => 'per_char',
				'amount_minor' => 10,
			)
		);

		$high                 = $sets[0]['rules'][0];
		$high['id']           = 'r-high';
		$high['action_value'] = array( 'amount_minor' => 700 );
		$sets[0]['rules'][]   = $high;

		$result = SelectionResolver::resolve( $sets, self::text_answers(), 1000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1000, $result->value()['total_minor'] );
		$this->assertContains( SelectionResolver::UNPRICED_RULE_CONFLICT, $result->value()['unpriced'] );
	}

	/**
	 * The answers the three text cases share.
	 *
	 * @return array<string, string>
	 */
	private static function text_answers(): array {
		return array(
			'opt-a' => 'yes',
			'opt-t' => 'HELLO',
		);
	}

	/**
	 * One trigger and one text option carrying a `set_price` rule of 900.
	 *
	 * @param ?array<string, mixed> $pricing Option-level pricing, or null for none.
	 * @return array<int, array<string, mixed>>
	 */
	private static function sets_with_text_rule( ?array $pricing ): array {
		$text = array(
			'id'         => 'opt-t',
			'type'       => 'text_field',
			'value_kind' => 'text',
		);

		if ( null !== $pricing ) {
			$text['pricing'] = $pricing;
		}

		$rule                 = self::rule( 'r-1', 'set_price', 'option', 'opt-t', 'opt-a', 'equals', 'yes' );
		$rule['action_value'] = array( 'amount_minor' => 900 );

		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array(
								'id'     => 'opt-a',
								'type'   => 'radio',
								'values' => array(
									array(
										'id'        => 'val-yes',
										'value_key' => 'yes',
									),
								),
							),
							$text,
						),
					),
				),
				'rules'  => array( $rule ),
			),
		);
	}

	/**
	 * 🔴 A hidden group does not hide a *value* that happens to share its id.
	 *
	 * `hidden_values()` reads `target_type` rather than trusting the id alone,
	 * and this is the case that proves it must. Ids are UUIDv7 in the cloud, so
	 * two objects never collide by accident — but **AC4 makes the document input
	 * rather than authority**, and a forged or corrupted one can carry whatever
	 * ids it likes. A payload that made a group id equal a value id would
	 * otherwise refuse a choice the customer could legitimately make.
	 *
	 * Added by the follow-up audit, which found the guard surviving mutation:
	 * removing the type check broke no test, because every fixture used distinct
	 * ids. A guard nothing can fail is a guard nobody knows is load-bearing.
	 */
	public function test_a_hidden_group_does_not_hide_a_value_sharing_its_id(): void {
		$shared = 'collides-with-a-group';

		$result = SelectionResolver::resolve(
			array(
				array(
					'id'     => 'set-1',
					'groups' => array(
						array(
							'id'      => $shared,
							'options' => array(
								array(
									'id'     => 'opt-b',
									'type'   => 'radio',
									'values' => array(
										array(
											'id'        => 'val-b',
											'value_key' => 'bee',
										),
									),
								),
							),
						),
						array(
							'id'      => 'group-a',
							'options' => array(
								array(
									'id'     => 'opt-a',
									'type'   => 'radio',
									'values' => array(
										array(
											'id'        => 'val-yes',
											'value_key' => 'yes',
										),
									),
								),
								array(
									'id'     => 'opt-c',
									'type'   => 'radio',
									'values' => array(
										// Same id as the group hidden above.
										array(
											'id'        => $shared,
											'value_key' => 'cee',
										),
									),
								),
							),
						),
					),
					'rules'  => array(
						self::rule( 'r-1', 'hide', 'group', $shared, 'opt-a', 'equals', 'yes' ),
					),
				),
			),
			array(
				'opt-a' => 'yes',
				'opt-c' => 'cee',
			)
		);

		$this->assertTrue( $result->is_ok(), 'The group is hidden; the value merely shares its id.' );
		$this->assertArrayHasKey( 'opt-c', $result->value()['resolved'] );
	}

	/**
	 * 🔴 `unrequire` lifts a merchant's authored `is_required`.
	 *
	 * ⚠️ **This is a decision, not a specification.** ADR-052 settles `require`
	 * against `unrequire` *between rules* — restrictive wins — and is silent on
	 * rule-versus-authoring. The resolver reads a rule that fired as replacing
	 * the merchant's answer in both directions, on the grounds that `unrequire`
	 * is otherwise an action that can never do anything: every option it could
	 * target is either already optional or authored required.
	 *
	 * Pinned here because the follow-up audit found the branch **surviving
	 * mutation** — rewriting it so an authored `is_required` always wins broke no
	 * test. An undecided behaviour that is also unproven is one nobody can tell
	 * has changed. Carried to 17-11; if the exit audit decides the other way,
	 * this test is the thing that changes with it.
	 */
	public function test_unrequire_lifts_an_authored_required_flag(): void {
		$sets = self::sets_with_rule( 'unrequire', 'option', 'opt-b' );

		$sets[0]['groups'][1]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array( 'opt-a' => 'yes' ) );

		$this->assertTrue( $result->is_ok(), 'The rule fired, so the authored flag no longer applies.' );
	}

	/**
	 * ...and the same option is still required when that rule does not fire.
	 *
	 * The control. Without it, a mutation that skipped the required pass
	 * altogether would satisfy the assertion above — "no error" is produced just
	 * as well by a check that never runs.
	 */
	public function test_the_authored_required_flag_stands_when_unrequire_does_not_fire(): void {
		$sets = self::sets_with_rule( 'unrequire', 'option', 'opt-b' );

		$sets[0]['groups'][1]['options'][0]['is_required'] = true;

		$result = SelectionResolver::resolve( $sets, array( 'opt-a' => 'no' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_REQUIRED, $result->get_errors()[0]['code'] );
	}

	/**
	 * A `set_price` on the chosen value beats one on the whole option.
	 *
	 * The more specific statement wins, the same way a value's `price_config` is
	 * more specific than the option's `pricing`. Both rules fire here — 900 on
	 * the option, 300 on the value — so a total of 1300 proves the value won and
	 * 1900 would prove it did not.
	 *
	 * Found surviving mutation by the follow-up audit: no test targeted a
	 * `value` with `set_price` at all, so removing the precedence changed
	 * nothing.
	 */
	public function test_a_value_set_price_beats_an_option_set_price(): void {
		$sets = self::sets_with_rule( 'set_price', 'option', 'opt-b' );

		$sets[0]['rules'][0]['action_value'] = array( 'amount_minor' => 900 );

		$on_value                 = self::rule( 'r-2', 'set_price', 'value', 'val-extra', 'opt-a', 'equals', 'yes' );
		$on_value['action_value'] = array( 'amount_minor' => 300 );
		$sets[0]['rules'][]       = $on_value;

		$result = SelectionResolver::resolve(
			$sets,
			array(
				'opt-a' => 'yes',
				'opt-b' => 'extra',
			),
			1000
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 1300, $result->value()['total_minor'] );
	}

	/**
	 * Two sets whose rules differ only in document order.
	 *
	 * @param bool $reversed Whether to emit the pair the other way round.
	 * @return array<int, array<string, mixed>>
	 */
	private static function sets_with_set_price_pair( bool $reversed ): array {
		$sets = self::sets_with_rule( 'set_price', 'option', 'opt-b' );

		$low  = self::rule( 'r-low', 'set_price', 'option', 'opt-b', 'opt-a', 'equals', 'yes' );
		$high = self::rule( 'r-high', 'set_price', 'option', 'opt-b', 'opt-a', 'equals', 'yes' );

		$low['action_value']  = array( 'amount_minor' => 500 );
		$high['action_value'] = array( 'amount_minor' => 700 );

		$sets[0]['rules'] = $reversed ? array( $high, $low ) : array( $low, $high );

		return $sets;
	}

	/**
	 * Two options in one group, plus one rule keyed on the first.
	 *
	 * `opt-a` is the trigger and is never itself a target, so a test can change
	 * the rule's target freely without changing what fires it.
	 *
	 * @param string $action      The rule's action.
	 * @param string $target_type `option`, `group` or `value`.
	 * @param string $target_id   What the rule acts on.
	 * @return array<int, array<string, mixed>>
	 */
	private static function sets_with_rule( string $action, string $target_type, string $target_id ): array {
		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array(
								'id'     => 'opt-a',
								'type'   => 'radio',
								'values' => array(
									array(
										'id'        => 'val-yes',
										'value_key' => 'yes',
									),
									array(
										'id'        => 'val-no',
										'value_key' => 'no',
									),
								),
							),
						),
					),
					array(
						'id'      => 'group-b',
						'options' => array(
							array(
								'id'     => 'opt-b',
								'type'   => 'radio',
								'values' => array(
									array(
										'id'           => 'val-extra',
										'value_key'    => 'extra',
										'price_config' => array(
											'type'         => 'fixed',
											'amount_minor' => 250,
										),
									),
									array(
										'id'        => 'val-plain',
										'value_key' => 'plain',
									),
								),
							),
						),
					),
				),
				'rules'  => array(
					self::rule( 'r-1', $action, $target_type, $target_id, 'opt-a', 'equals', 'yes' ),
				),
			),
		);
	}

	/**
	 * One published rule, in document shape.
	 *
	 * @param string $id           The rule's id.
	 * @param string $action       What it does.
	 * @param string $target_type  `option`, `group` or `value`.
	 * @param string $target_id    What it acts on.
	 * @param string $condition_on The option its condition reads.
	 * @param string $operator     The comparison.
	 * @param mixed  $operand      What to compare against, or null for a unary operator.
	 * @return array<string, mixed>
	 */
	private static function rule(
		string $id,
		string $action,
		string $target_type,
		string $target_id,
		string $condition_on,
		string $operator,
		$operand
	): array {
		$condition = array(
			'option_id' => $condition_on,
			'operator'  => $operator,
		);

		if ( null !== $operand ) {
			$condition['value'] = $operand;
		}

		return array(
			'id'          => $id,
			'target_type' => $target_type,
			'target_id'   => $target_id,
			'action'      => $action,
			'match_type'  => 'all',
			'conditions'  => array( $condition ),
			'sort_order'  => 10,
		);
	}
}
