<?php
/**
 * The one measure function, driven by the shared cross-language fixture.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\Text;
use PHPUnit\Framework\TestCase;

/**
 * `measure()` and `normalise()`, asserted against the fixture the TypeScript
 * side reads.
 *
 * @covers \Optionia\Engine\Text
 */
final class TextMeasureTest extends TestCase {

	/**
	 * Every case from the shared fixture measures as declared.
	 *
	 * **The cases come from the file, not from this test.** Two implementations
	 * that merely intend to agree is how the `optionia-app` bug happened —
	 * pricing counted five characters for `"AB CD"` while the counter beside the
	 * field showed four. `bin/check-shared-fixtures.sh` hashes this file in both
	 * repositories, so a case added here without being added there fails the
	 * build.
	 *
	 * @dataProvider provide_measure_cases
	 *
	 * @param string $text     Input.
	 * @param int    $expected Expected grapheme count after normalising.
	 * @param string $label    Case name, for the failure message.
	 */
	public function test_measure_matches_the_shared_fixture( string $text, int $expected, string $label ): void {
		$this->assertSame( $expected, Text::measure( $text ), $label );
	}

	/**
	 * The measure cases, read from the fixture both languages share.
	 *
	 * @return array<string, array{0: string, 1: int, 2: string}>
	 * @throws \RuntimeException When the shared fixture is missing or malformed.
	 */
	public static function provide_measure_cases(): array {
		$path = __DIR__ . '/../fixtures/shared/pricing-fixtures.json';
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local test fixture, not a URL.
		$raw = file_get_contents( $path );

		if ( false === $raw ) {
			throw new \RuntimeException( 'Shared fixture missing: ' . esc_html( $path ) );
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) || ! isset( $decoded['measure_cases'] ) || ! is_array( $decoded['measure_cases'] ) ) {
			throw new \RuntimeException( 'Shared fixture holds no measure_cases array.' );
		}

		$cases = array();

		foreach ( $decoded['measure_cases'] as $case ) {
			$cases[ (string) $case['name'] ] = array(
				(string) $case['text'],
				(int) $case['expect'],
				(string) $case['name'],
			);
		}

		return $cases;
	}

	/**
	 * The fixture's declared count matches what this suite actually ran.
	 *
	 * A hash proves both repositories hold the same bytes. It does not prove
	 * either one *executed* them — a runner looping fewer cases than the file
	 * declares passes every checksum ever written. The gate asserts this from
	 * outside; this asserts it from inside, where the loop actually happens.
	 */
	public function test_every_declared_measure_case_ran(): void {
		$path = __DIR__ . '/../fixtures/shared/pricing-fixtures.json';
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local test fixture, not a URL.
		$decoded = json_decode( (string) file_get_contents( $path ), true );

		$this->assertSame(
			(int) $decoded['measure_case_count'],
			count( self::provide_measure_cases() ),
			'The fixture declares a different number of measure cases than this suite runs.'
		);
	}

	/**
	 * Normalising strips the ends and leaves the middle alone.
	 *
	 * Asserted separately because `measure()` normalises internally, so a broken
	 * `normalise()` could still produce a right-looking count on symmetric input.
	 */
	public function test_normalise_trims_only_the_ends(): void {
		$this->assertSame( 'AB CD', Text::normalise( '  AB CD  ' ) );
		$this->assertSame( 'AB CD', Text::normalise( "\tAB CD\n" ) );
		$this->assertSame( 'AB  CD', Text::normalise( 'AB  CD' ), 'Inner whitespace is engraved and must survive.' );
		$this->assertSame( '', Text::normalise( '   ' ) );
	}

	/**
	 * A non-breaking space at the end is invisible and must not be charged for.
	 *
	 * It arrives by paste from a word processor, renders as nothing, and a bare
	 * `trim()` would leave it in place.
	 */
	public function test_normalise_strips_invisible_outer_whitespace(): void {
		$this->assertSame( 'AB', Text::normalise( "AB\u{00A0}" ) );
		$this->assertSame( 'AB', Text::normalise( "\u{FEFF}AB" ) );
	}
}
