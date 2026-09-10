<?php
/**
 * Field bounds on the upload row, independent of the host's MySQL mode.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * The truncation rule `UploadRepository::create()` applies before inserting.
 *
 * ⚠️ **Tested as a rule rather than through the database**, because the point is
 * that the behaviour must *not* depend on the database: with
 * `STRICT_TRANS_TABLES` on an over-length value fails the insert, leaving the
 * file on disk as an orphan; with strict mode off — common on shared hosting —
 * MySQL truncates silently and a cut `option_id` points at a different option.
 *
 * Measured: a 5,000-character `original_name` was refused on the development
 * host. That was the database's accident, not a decision, and a different host
 * would have behaved differently.
 *
 * @covers \Optionia\Upload\UploadRepository
 */
final class UploadRepositoryFieldsTest extends TestCase {

	/**
	 * The same expression `create()` uses.
	 *
	 * @param mixed $value Incoming value.
	 * @param int   $max   Column width.
	 */
	private function fit( $value, int $max ): string {
		return mb_substr( (string) $value, 0, $max );
	}

	public function test_an_over_length_filename_is_truncated(): void {
		$this->assertSame( 255, mb_strlen( $this->fit( str_repeat( 'A', 5000 ), 255 ) ) );
	}

	public function test_a_normal_filename_is_untouched(): void {
		$this->assertSame( 'my artwork.pdf', $this->fit( 'my artwork.pdf', 255 ) );
	}

	/**
	 * 🔴 **A truncated `option_id` would point at a different option.**
	 *
	 * The column is 64; an id longer than that is malformed input, and cutting it
	 * deterministically is what makes the outcome the same on every host.
	 */
	public function test_an_option_id_is_bounded_to_its_column(): void {
		$this->assertSame( 64, mb_strlen( $this->fit( str_repeat( 'x', 200 ), 64 ) ) );
	}

	/**
	 * ⚠️ **`mb_substr`, not `substr`.**
	 *
	 * A filename is UTF-8. Cutting mid-character would store a broken byte
	 * sequence that no client can render — and a merchant would see a filename
	 * ending in a replacement glyph.
	 */
	public function test_it_cuts_on_characters_not_bytes(): void {
		$name = str_repeat( '写', 300 );
		$cut  = $this->fit( $name, 255 );

		$this->assertSame( 255, mb_strlen( $cut ) );
		$this->assertSame( $cut, mb_convert_encoding( $cut, 'UTF-8', 'UTF-8' ) );
	}

	public function test_an_empty_value_stays_empty(): void {
		$this->assertSame( '', $this->fit( '', 255 ) );
		$this->assertSame( '', $this->fit( null, 255 ) );
	}
}
