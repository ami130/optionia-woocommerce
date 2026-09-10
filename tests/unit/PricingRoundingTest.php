<?php
/**
 * Rounding, driven by the shared cross-language fixture.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Money;
use PHPUnit\Framework\TestCase;

/**
 * `Money::percentage()` against the cases the TypeScript side reads.
 *
 * **Half up, away from zero** — and the qualifier is the whole point.
 * JavaScript's `Math.round` rounds toward positive infinity, so it agrees on
 * every positive tie and disagrees on every negative one: a 5% discount on 30
 * minor units is −2 here and −1 there.
 *
 * Nothing diverges today, because Phase 11 ships `fixed` only and integer
 * addition does not round. M16.1 is where it would bite, with two evaluators
 * already written — so the cases exist now, in the file both languages read.
 *
 * @covers \Optionia\Support\Money
 */
final class PricingRoundingTest extends TestCase {

	/**
	 * Every rounding case from the shared fixture.
	 *
	 * @dataProvider provide_rounding_cases
	 *
	 * @param int    $minor        Base amount in minor units.
	 * @param int    $basis_points Percentage in basis points.
	 * @param int    $expected     Expected result in minor units.
	 * @param string $label        Case name, for the failure message.
	 */
	public function test_rounding_matches_the_shared_fixture( int $minor, int $basis_points, int $expected, string $label ): void {
		$this->assertSame(
			$expected,
			Money::from_minor( $minor, 2 )->percentage( $basis_points )->minor(),
			$label
		);
	}

	/**
	 * The rounding cases, read from the file both languages share.
	 *
	 * @return array<string, array{0: int, 1: int, 2: int, 3: string}>
	 */
	public static function provide_rounding_cases(): array {
		$decoded = self::fixture();

		$cases = array();

		foreach ( $decoded['rounding_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(int) $case['minor'],
				(int) $case['basis_points'],
				(int) $case['expect'],
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * Every declared rounding case ran.
	 *
	 * A hash proves both repositories hold the same bytes; it does not prove
	 * either executed them.
	 */
	public function test_every_declared_rounding_case_ran(): void {
		$this->assertSame(
			(int) self::fixture()['rounding_case_count'],
			count( self::provide_rounding_cases() )
		);
	}

	/**
	 * At least three cases are negative ties.
	 *
	 * Positive ties agree in both languages, so a suite holding only those would
	 * pass for the wrong reason — it would prove the two implementations agree
	 * where they never disagreed.
	 */
	public function test_the_fixture_covers_negative_ties(): void {
		$negative = 0;

		foreach ( self::fixture()['rounding_cases'] as $case ) {
			if ( (int) $case['basis_points'] < 0 ) {
				++$negative;
			}
		}

		$this->assertGreaterThanOrEqual(
			3,
			$negative,
			'Positive ties agree in PHP and JavaScript; only negatives distinguish the rounding modes.'
		);
	}

	/**
	 * Rounding is symmetric about zero.
	 *
	 * Asserted directly as well as through the fixture: this is the property the
	 * specification names, and a fixture could be edited to agree with a broken
	 * implementation while this cannot.
	 */
	public function test_rounding_is_symmetric_about_zero(): void {
		$this->assertSame( 1, Money::from_minor( 10, 2 )->percentage( 500 )->minor() );
		$this->assertSame( -1, Money::from_minor( 10, 2 )->percentage( -500 )->minor() );
		$this->assertSame( 3, Money::from_minor( 10, 2 )->percentage( 2500 )->minor() );
		$this->assertSame( -3, Money::from_minor( 10, 2 )->percentage( -2500 )->minor() );
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

		if ( ! is_array( $decoded ) || ! isset( $decoded['rounding_cases'] ) ) {
			throw new \RuntimeException( 'Shared fixture holds no rounding_cases array.' );
		}

		return $decoded;
	}
}
