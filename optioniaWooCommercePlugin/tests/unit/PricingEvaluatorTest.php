<?php
/**
 * Line-total evaluation, driven by the shared cross-language fixture.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\Pricing;
use PHPUnit\Framework\TestCase;

/**
 * `Pricing::sum_deltas()` against the cases the TypeScript side reads.
 *
 * Until this file existed the eighteen pricing cases in `pricing-fixtures.json`
 * were executed by TypeScript alone — a fixture that proved TypeScript agrees
 * with itself. Cross-language agreement is the entire reason the file is shared,
 * so the same numbers are asserted here, from the same bytes.
 *
 * @covers \Optionia\Engine\Pricing
 */
final class PricingEvaluatorTest extends TestCase {

	/**
	 * Every fixed-price case in the shared fixture.
	 *
	 * @dataProvider provide_pricing_cases
	 *
	 * @param string     $name        The case's own description, for failure output.
	 * @param int        $base_minor  Base price in minor units.
	 * @param array<int> $deltas      Selected option contributions.
	 * @param int        $expect      The normative line total.
	 */
	public function test_shared_pricing_cases( string $name, int $base_minor, array $deltas, int $expect ): void {
		$this->assertSame(
			$expect,
			Pricing::sum_deltas( $base_minor, $deltas ),
			'Shared fixture case diverges from the TypeScript evaluator: ' . $name
		);
	}

	/**
	 * The fixture's own cases, plus the generated ones expanded.
	 *
	 * @return array<string, array{string, int, array<int>, int}>
	 * @throws \RuntimeException When the fixture is missing or malformed.
	 */
	public static function provide_pricing_cases(): array {
		$fixture = self::fixture();
		$rows    = array();

		foreach ( $fixture['cases'] as $case ) {
			$rows[ $case['name'] ] = array(
				$case['name'],
				$case['base_minor'],
				$case['deltas'],
				$case['expect_minor'],
			);
		}

		/*
		 * Expanded here rather than stored expanded, because the point of these
		 * two cases is the *size*: 20,000 deltas is one full option set at
		 * AUTHORING_LIMITS. Storing them literally would add ~200 KB to a file
		 * both repos vendor and every gate hashes.
		 */
		foreach ( $fixture['generated_cases'] as $case ) {
			$rows[ $case['name'] ] = array(
				$case['name'],
				$case['base_minor'],
				array_fill( 0, $case['repeat_count'], $case['repeat_delta'] ),
				$case['expect_minor'],
			);
		}

		return $rows;
	}

	/**
	 * The fixture declares how many cases it holds; the count must match.
	 *
	 * A provider silently yielding fewer rows than the file describes is the
	 * failure this suite would otherwise not notice — every remaining case would
	 * still pass.
	 */
	public function test_every_declared_case_is_executed(): void {
		$fixture = self::fixture();

		$this->assertCount(
			$fixture['case_count'] + $fixture['generated_case_count'],
			self::provide_pricing_cases(),
			'The provider does not execute every case the fixture declares.'
		);
		$this->assertGreaterThanOrEqual( 16, $fixture['case_count'] );
		$this->assertGreaterThanOrEqual( 2, $fixture['generated_case_count'] );
	}

	/**
	 * The clamp lands on the total, not on each delta.
	 *
	 * `PRICING-SPEC.md` §3 is explicit, and the two readings differ on ordinary
	 * merchant configuration: a large discount followed by a small addition.
	 * Clamping per step lets that line rise back off zero — a discount that pays
	 * out.
	 */
	public function test_clamp_applies_once_to_the_total(): void {
		$this->assertSame( 0, Pricing::sum_deltas( 3000, array( -5000, 400 ) ) );
	}

	/**
	 * A negative delta survives to the sum.
	 *
	 * Clamping a single delta would turn every discount option into a no-op.
	 */
	public function test_a_single_negative_delta_discounts(): void {
		$this->assertSame( 2500, Pricing::sum_deltas( 3000, array( -500 ) ) );
	}

	/**
	 * Order within the sum is unobservable.
	 */
	public function test_delta_order_does_not_change_the_total(): void {
		$forward = Pricing::sum_deltas( 3000, array( -5000, 400, 250 ) );
		$reverse = Pricing::sum_deltas( 3000, array( 250, 400, -5000 ) );

		$this->assertSame( $forward, $reverse );
	}

	/**
	 * The shared bound is the fixture's, not this file's.
	 *
	 * `Support\Money` refuses above `PHP_INT_MAX`; this refuses a thousand-fold
	 * earlier so that both languages refuse the same inputs. A value PHP could
	 * carry perfectly well is rejected here on purpose — that is the contract.
	 *
	 * Read from the shared fixture rather than written as a literal. Measured:
	 * with the bound hardcoded in both suites and stated in the specification,
	 * the specification could be edited to claim a *different* bound, both
	 * hashes re-pinned, and every gate still passed. The number the whole
	 * cross-language reconciliation rests on was the one number the cross-repo
	 * mechanism did not protect.
	 */
	public function test_the_bound_matches_the_shared_fixture(): void {
		$fixture = self::fixture();

		$this->assertSame(
			$fixture['bound_minor'],
			Pricing::MAX_MINOR,
			'The evaluator and the shared fixture disagree about the safe range.'
		);
	}

	/**
	 * Every bound case in the shared fixture, accepted or refused as declared.
	 *
	 * @dataProvider provide_bound_cases
	 *
	 * @param string     $name       The case's own description, for failure output.
	 * @param int        $base_minor Base price in minor units.
	 * @param array<int> $deltas     Selected option contributions.
	 * @param int|null   $expect     The normative line total, or null when it throws.
	 * @param bool       $throws     Whether the case must be refused.
	 */
	public function test_shared_bound_cases( string $name, int $base_minor, array $deltas, ?int $expect, bool $throws ): void {
		if ( $throws ) {
			$this->expectException( \RangeException::class );
			Pricing::sum_deltas( $base_minor, $deltas );

			return;
		}

		$this->assertSame(
			$expect,
			Pricing::sum_deltas( $base_minor, $deltas ),
			'Shared bound case diverges from the TypeScript evaluator: ' . $name
		);
	}

	/**
	 * The fixture's bound cases.
	 *
	 * @return array<string, array{string, int, array<int>, int|null, bool}>
	 * @throws \RuntimeException When the fixture is missing or malformed.
	 */
	public static function provide_bound_cases(): array {
		$rows = array();

		foreach ( self::fixture()['bound_cases'] as $case ) {
			$rows[ $case['name'] ] = array(
				$case['name'],
				$case['base_minor'],
				$case['deltas'],
				$case['expect_minor'],
				$case['throws'],
			);
		}

		return $rows;
	}

	/**
	 * The bound provider executes every case the fixture declares.
	 */
	public function test_every_declared_bound_case_is_executed(): void {
		$fixture = self::fixture();

		$this->assertCount(
			$fixture['bound_case_count'],
			self::provide_bound_cases(),
			'The bound provider does not execute every case the fixture declares.'
		);
		$this->assertGreaterThanOrEqual( 6, $fixture['bound_case_count'] );
	}

	/**
	 * A sum that leaves the safe range and returns is still refused.
	 *
	 * This is why the check runs each step rather than once at the end: the
	 * final total here is in range, and the intermediate one is not.
	 */
	public function test_refuses_a_sum_that_overflows_and_returns(): void {
		$this->expectException( \RangeException::class );
		Pricing::sum_deltas( Pricing::MAX_MINOR, array( 1, -1 ) );
	}

	/**
	 * The floor refuses out-of-range input on its own, not only via the sum.
	 */
	public function test_clamp_refuses_out_of_range(): void {
		$this->expectException( \RangeException::class );
		Pricing::clamp_to_zero( -( Pricing::MAX_MINOR + 2 ) );
	}

	/**
	 * A negative base with no options still clamps.
	 */
	public function test_a_negative_total_clamps_to_zero(): void {
		$this->assertSame( 0, Pricing::clamp_to_zero( -1 ) );
		$this->assertSame( 0, Pricing::clamp_to_zero( 0 ) );
		$this->assertSame( 1, Pricing::clamp_to_zero( 1 ) );
	}

	/**
	 * Non-integer input is refused, not silently truncated.
	 *
	 * **This is the divergence the audit found, and it needed no bad caller to
	 * reach.** An `int` type hint coerces rather than guards whenever the
	 * *calling* file is not `strict_types` — and WooCommerce is not, while
	 * `WC_Product::get_price()` returns the string `"10.50"`. Hinted `int`, that
	 * became `10`: fifty minor units lost, no error raised, and TypeScript
	 * throwing `RangeError` on the identical input.
	 *
	 * These cases are asserted from a `strict_types` file, so they prove the
	 * check itself rather than the hint. `Pricing.php` takes `mixed` precisely so
	 * this test can reach the guard at all.
	 *
	 * @dataProvider provide_non_integers
	 *
	 * @param mixed $value Something that is not an integer.
	 */
	public function test_refuses_non_integer_base( $value ): void {
		$this->expectException( \InvalidArgumentException::class );
		Pricing::sum_deltas( $value, array() );
	}

	/**
	 * The same guard applies to a delta, not only to the base.
	 *
	 * @dataProvider provide_non_integers
	 *
	 * @param mixed $value Something that is not an integer.
	 */
	public function test_refuses_non_integer_delta( $value ): void {
		$this->expectException( \InvalidArgumentException::class );
		Pricing::sum_deltas( 1000, array( $value ) );
	}

	/**
	 * And to the floor, which is public and callable on its own.
	 *
	 * @dataProvider provide_non_integers
	 *
	 * @param mixed $value Something that is not an integer.
	 */
	public function test_clamp_refuses_non_integer( $value ): void {
		$this->expectException( \InvalidArgumentException::class );
		Pricing::clamp_to_zero( $value );
	}

	/**
	 * The shapes WordPress and WooCommerce actually hand out.
	 *
	 * `"10.50"` is `WC_Product::get_price()`. `10.5` is what a tax filter
	 * returns. `null` is an unset meta value. `true` is what a mis-wired
	 * `filter_var` produces. Every one of them coerces to a plausible integer
	 * under a hint, which is why each is named rather than left to a generic
	 * "invalid input" case.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_non_integers(): array {
		return array(
			'a float with a fractional part' => array( 10.5 ),
			'a float that is integral'       => array( 10.0 ),
			'a numeric string'               => array( '10.50' ),
			'an integer-looking string'      => array( '10' ),
			'a non-numeric string'           => array( 'abc' ),
			'null'                           => array( null ),
			'a boolean'                      => array( true ),
			'an array'                       => array( array( 10 ) ),
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

		if ( ! is_array( $decoded ) || ! isset( $decoded['cases'], $decoded['generated_cases'], $decoded['bound_cases'] ) ) {
			throw new \RuntimeException( 'Shared fixture holds no cases/generated_cases/bound_cases arrays.' );
		}

		return $decoded;
	}
}
