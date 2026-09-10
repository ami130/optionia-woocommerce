<?php
/**
 * Rule evaluation, driven by the shared cross-language fixture.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\RuleEvaluator;
use PHPUnit\Framework\TestCase;

/**
 * `RuleEvaluator::evaluate()` against the cases the TypeScript side reads.
 *
 * Until this file existed the rule cases in `rule-fixtures.json` were executed by
 * TypeScript alone — a fixture proving TypeScript agrees with itself.
 * Cross-language agreement is the entire reason the file is shared.
 *
 * 🔴 **Every case asserts `expect_passes`, not only the final state.** 16b's
 * lesson: the pricing fixture proved both ends and neither language proved the
 * middle. For rules the interesting failures are **cascade depth** and **cap
 * behaviour**, and neither is visible in a final state — an evaluator that
 * settled in one pass where the fixture says two has a different cascade and the
 * same answer, until the day it does not.
 *
 * @covers \Optionia\Engine\RuleEvaluator
 */
final class RuleEvaluatorTest extends TestCase {

	/**
	 * Every rule case in the shared fixture.
	 *
	 * @dataProvider provide_rule_cases
	 *
	 * @param array<string, mixed> $fixture_case One fixture case.
	 */
	public function test_rule_cases_match_the_shared_fixture( array $fixture_case ): void {
		$options_under = self::options_under( $fixture_case );

		$outcome = RuleEvaluator::evaluate(
			$fixture_case['rules'],
			$fixture_case['answers'],
			$options_under
		);

		$this->assertSame(
			(bool) $fixture_case['expect_refused'],
			null !== $outcome['refused'],
			$fixture_case['name'] . ' — refusal'
		);

		// 🔴 The middle, not only the ends.
		$this->assertSame(
			$fixture_case['expect_passes'],
			$outcome['passes'],
			$fixture_case['name'] . ' — pass count'
		);

		/*
		 * ⚠️ **Compared as a map, not as an ordered list.** `assertSame` on
		 * arrays is order-sensitive, and a rule set's states are keyed by target
		 * id — the order they were inserted is the order the rules happened to
		 * fire, which M17.2 makes explicitly meaningless.
		 *
		 * Measured: a two-rule cascade produced the same two states as the cloud
		 * with the keys the other way round, and only the ordering differed. An
		 * assertion that fails on that is asserting something the specification
		 * refuses to define.
		 */
		$expected = $fixture_case['expect_states'];
		$actual   = self::stated( $outcome['states'] );

		ksort( $expected );
		ksort( $actual );

		$this->assertSame( $expected, $actual, $fixture_case['name'] . ' — states' );
	}

	/**
	 * 🔴 **The assertion that makes this a shared fixture rather than a file.**
	 *
	 * A provider truncated to one row passes every per-case assertion. Comparing
	 * the executed count against the fixture's own declared count is what caught
	 * exactly that in the pricing suite, and it is the check
	 * `bin/check-shared-fixtures.sh` requires to exist.
	 */
	public function test_the_provider_executes_every_declared_case(): void {
		$fixture = self::fixture();

		$this->assertCount(
			$fixture['rule_case_count'],
			self::provide_rule_cases(),
			'The provider does not execute every rule case the fixture declares.'
		);
		$this->assertGreaterThanOrEqual( 20, $fixture['rule_case_count'] );
	}

	/**
	 * The pass cap must be the same number in both languages.
	 *
	 * The fixture carries a case that reaches it and expects a refusal, so a
	 * different cap here would fail that case — this asserts the constant
	 * directly as well, because a cap that merely *happens* to agree is a cap
	 * nobody decided.
	 */
	public function test_the_pass_cap_matches_the_cloud(): void {
		$this->assertSame( 10, RuleEvaluator::MAX_PASSES );
	}

	/**
	 * Cases from the shared fixture.
	 *
	 * @return array<string, array{0: array<string, mixed>}>
	 */
	public static function provide_rule_cases(): array {
		$cases = array();

		foreach ( self::fixture()['rule_cases'] as $fixture_case ) {
			$cases[ $fixture_case['name'] ] = array( $fixture_case );
		}

		return $cases;
	}

	/**
	 * Every option in a case controls its own answer.
	 *
	 * The document supplies containment — a group target controls the options
	 * inside it — but these cases target options directly, so the map is
	 * identity over every id the case mentions.
	 *
	 * @param array<string, mixed> $fixture_case One fixture case.
	 *
	 * @return array<string, array<int, string>>
	 */
	private static function options_under( array $fixture_case ): array {
		$ids = array();

		foreach ( $fixture_case['rules'] as $rule ) {
			$ids[ $rule['target_id'] ] = true;

			foreach ( $rule['conditions'] as $condition ) {
				/*
				 * ⚠️ The fixture deliberately carries **unreadable** conditions,
				 * to pin that both languages treat one as `false` rather than
				 * skipping it. This map only needs the ids it can see; a
				 * condition with none contributes nothing, exactly as it
				 * contributes nothing to the evaluation.
				 */
				if ( is_array( $condition ) && isset( $condition['option_id'] ) ) {
					$ids[ $condition['option_id'] ] = true;
				}
			}
		}

		foreach ( array_keys( $fixture_case['answers'] ) as $id ) {
			$ids[ $id ] = true;
		}

		$map = array();

		foreach ( array_keys( $ids ) as $id ) {
			$map[ $id ] = array( $id );
		}

		return $map;
	}

	/**
	 * States in the fixture's own shape: only what a rule actually decided.
	 *
	 * @param array<string, array<string, mixed>> $states Raw evaluator output.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function stated( array $states ): array {
		$out = array();

		foreach ( $states as $target_id => $state ) {
			$stated = array();

			if ( true === $state['hidden'] ) {
				$stated['hidden'] = true;
			}

			if ( null !== $state['required'] ) {
				$stated['required'] = $state['required'];
			}

			if ( null !== $state['price_minor'] ) {
				$stated['price_minor'] = $state['price_minor'];
			}

			if ( null !== $state['default_value_key'] ) {
				$stated['default_value_key'] = $state['default_value_key'];
			}

			if ( array() !== $stated ) {
				$out[ $target_id ] = $stated;
			}
		}

		return $out;
	}

	/**
	 * The shared fixture, decoded.
	 *
	 * @return array<string, mixed>
	 * @throws \RuntimeException When the fixture is missing or malformed.
	 */
	private static function fixture(): array {
		$path = __DIR__ . '/../fixtures/shared/rule-fixtures.json';
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local test fixture, not a URL.
		$raw = file_get_contents( $path );

		if ( false === $raw ) {
			throw new \RuntimeException( 'Shared rule fixture missing: ' . esc_html( $path ) );
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) || ! isset( $decoded['rule_cases'], $decoded['rule_case_count'] ) ) {
			throw new \RuntimeException( 'Shared rule fixture holds no rule_cases array.' );
		}

		return $decoded;
	}
}
