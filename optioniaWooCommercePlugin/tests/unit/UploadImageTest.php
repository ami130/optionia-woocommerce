<?php
/**
 * Dimension limits before decoding, and metadata consumed after.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadImage;
use PHPUnit\Framework\TestCase;

/**
 * 🔴 **Reading dimensions is free; decoding is what kills the request.**
 *
 * Measured over HTTP: `getimagesize()` on a crafted 20000×20000 PNG header
 * reported the size for **536 bytes** of memory, where decoding the same image
 * would need ~1.5 GB.
 *
 * @covers \Optionia\Upload\UploadImage
 */
final class UploadImageTest extends TestCase {

	/**
	 * Files to remove.
	 *
	 * @var array<int, string>
	 */
	private array $paths = array();

	protected function tearDown(): void {
		foreach ( $this->paths as $path ) {
			if ( is_file( $path ) ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test teardown.
				unlink( $path );
			}
		}

		$this->paths = array();
	}

	private function images(): UploadImage {
		return new UploadImage( new Logger( new Settings() ) );
	}

	/** A path this test owns. */
	private function path( string $suffix = '' ): string {
		$path          = tempnam( sys_get_temp_dir(), 'optionia-img' ) . $suffix;
		$this->paths[] = $path;

		return $path;
	}

	/**
	 * A PNG **header** claiming a size, with no pixel data.
	 *
	 * This is the decompression bomb in miniature: a few dozen bytes on disk
	 * describing an image no host can decode.
	 */
	private function pngHeader( int $width, int $height ): string {
		$path = $this->path( '.png' );

		file_put_contents( // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
			$path,
			"\x89PNG\r\n\x1a\n" . pack( 'N', 13 ) . 'IHDR'
				. pack( 'NN', $width, $height ) . "\x08\x02\x00\x00\x00"
		);

		return $path;
	}

	/** A real, decodable JPEG. */
	private function jpeg( int $width = 40, int $height = 30 ): string {
		$path  = $this->path( '.jpg' );
		$image = imagecreatetruecolor( $width, $height );

		imagefilledrectangle( $image, 0, 0, $width - 1, $height - 1, imagecolorallocate( $image, 10, 90, 180 ) );
		imagejpeg( $image, $path, 92 );
		imagedestroy( $image );

		return $path;
	}

	/**
	 * A JPEG carrying a real EXIF block: `Orientation` plus a GPS tag.
	 *
	 * Built by hand because GD cannot write EXIF — which is the whole reason a
	 * re-encode removes it.
	 */
	private function jpegWithExif( int $orientation ): string {
		$plain = (string) file_get_contents( $this->jpeg() ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.

		$tiff  = "II\x2a\x00" . pack( 'V', 8 );
		$tiff .= pack( 'v', 2 );
		$tiff .= pack( 'v', 0x0112 ) . pack( 'v', 3 ) . pack( 'V', 1 ) . pack( 'v', $orientation ) . pack( 'v', 0 );
		$tiff .= pack( 'v', 0x8825 ) . pack( 'v', 4 ) . pack( 'V', 1 ) . pack( 'V', 38 );
		$tiff .= pack( 'V', 0 );
		$tiff .= pack( 'v', 1 ) . pack( 'v', 1 ) . pack( 'v', 2 ) . pack( 'V', 2 ) . "N\x00\x00\x00" . pack( 'V', 0 );

		$app1 = "Exif\x00\x00" . $tiff;
		$path = $this->path( '.jpg' );

		file_put_contents( // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
			$path,
			substr( $plain, 0, 2 ) . "\xFF\xE1" . pack( 'n', strlen( $app1 ) + 2 ) . $app1 . substr( $plain, 2 )
		);

		return $path;
	}

	/* --- dimensions ------------------------------------------------------ */

	public function test_it_reads_dimensions_from_a_header(): void {
		$this->assertSame( array( 8000, 6000 ), $this->images()->dimensions( $this->pngHeader( 8000, 6000 ) ) );
	}

	/**
	 * ⚠️ **A PDF is not an image, and that is not a failure.**
	 *
	 * `getimagesize()` answers false for one — verified over HTTP — so documents
	 * skip every step in this class.
	 */
	public function test_a_pdf_is_not_an_image(): void {
		$path = $this->path( '.pdf' );

		file_put_contents( $path, "%PDF-1.7\n%%EOF" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.

		$this->assertFalse( $this->images()->is_image( $path ) );
		$this->assertSame( array(), $this->images()->dimensions( $path ) );
	}

	public function test_an_unreadable_path_has_no_dimensions(): void {
		$this->assertSame( array(), $this->images()->dimensions( '/no/such/file' ) );
	}

	/* --- the pixel budget ------------------------------------------------ */

	/**
	 * 🔴 **The decompression bomb: tiny on disk, unbounded in memory.**
	 */
	public function test_it_refuses_an_image_beyond_the_budget(): void {
		$bomb = $this->pngHeader( 20000, 20000 );

		$this->assertLessThan( 200, filesize( $bomb ), 'The bomb must be small on disk.' );
		$this->assertFalse( $this->images()->within_pixel_budget( $bomb ) );
	}

	/**
	 * ⚠️ **Not only a bomb defence — an ordinary DSLR photo exceeds it.**
	 *
	 * 48 MP needs 183 MB decoded, which takes a 128 MB host with it. That is a
	 * real customer, and the default ceiling is sized for the smallest host
	 * rather than this one.
	 */
	public function test_a_48_megapixel_photo_exceeds_the_default(): void {
		$this->assertFalse( $this->images()->within_pixel_budget( $this->pngHeader( 8000, 6000 ) ) );
	}

	public function test_a_12_megapixel_photo_is_within_the_default(): void {
		$this->assertTrue( $this->images()->within_pixel_budget( $this->pngHeader( 4000, 3000 ) ) );
	}

	/** A merchant who knows their host can raise the ceiling. */
	public function test_a_configured_ceiling_overrides_the_default(): void {
		$big = $this->pngHeader( 8000, 6000 );

		$this->assertFalse( $this->images()->within_pixel_budget( $big ) );
		$this->assertTrue( $this->images()->within_pixel_budget( $big, 60.0 ) );
	}

	/** And can lower it, for a small logo field. */
	public function test_a_configured_ceiling_can_be_stricter(): void {
		$this->assertFalse( $this->images()->within_pixel_budget( $this->pngHeader( 4000, 3000 ), 0.5 ) );
	}

	/**
	 * ⚠️ **A document passes the budget**, because it is never decoded.
	 * Refusing here would refuse every PDF.
	 */
	public function test_a_non_image_passes_the_budget(): void {
		$path = $this->path( '.pdf' );

		file_put_contents( $path, "%PDF-1.7\n%%EOF" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.

		$this->assertTrue( $this->images()->within_pixel_budget( $path ) );
	}

	/** The arithmetic behind the ceiling, so it is not a magic number. */
	public function test_it_reports_what_decoding_would_cost(): void {
		$this->assertSame( 8000 * 6000 * 4, $this->images()->decoded_bytes( $this->pngHeader( 8000, 6000 ) ) );
	}

	/* --- metadata -------------------------------------------------------- */

	/**
	 * 🔴 **GPS is why this matters.**
	 *
	 * A customer photographing artwork at home embeds their home coordinates,
	 * and forwarding those to a merchant is a data-protection problem nobody
	 * consented to.
	 */
	public function test_it_removes_gps_and_every_other_tag(): void {
		$path = $this->jpegWithExif( 1 );

		$this->assertStringContainsString( "Exif\x00\x00", (string) file_get_contents( $path ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.

		$this->assertTrue( $this->images()->consume_metadata( $path ) );

		$this->assertStringNotContainsString( "Exif\x00\x00", (string) file_get_contents( $path ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.
	}

	/**
	 * 🔴 **Orientation is *consumed*, not preserved.**
	 *
	 * ✏️ ADR-041 first said "strip everything except Orientation", and
	 * measurement showed that is impossible: GD writes no EXIF, so a re-encode
	 * removes every tag. The rotation is applied to the pixels instead — a
	 * 40×30 image rotated 90° becomes 30×40.
	 */
	public function test_orientation_6_rotates_the_pixels(): void {
		$path = $this->jpegWithExif( 6 );

		$this->assertSame( array( 40, 30 ), $this->images()->dimensions( $path ) );

		$this->images()->consume_metadata( $path );

		$this->assertSame( array( 30, 40 ), $this->images()->dimensions( $path ) );
	}

	public function test_orientation_8_rotates_the_other_way(): void {
		$path = $this->jpegWithExif( 8 );

		$this->images()->consume_metadata( $path );

		$this->assertSame( array( 30, 40 ), $this->images()->dimensions( $path ) );
	}

	/** 180° keeps the shape; the pixels turn. */
	public function test_orientation_3_keeps_the_dimensions(): void {
		$path = $this->jpegWithExif( 3 );

		$this->images()->consume_metadata( $path );

		$this->assertSame( array( 40, 30 ), $this->images()->dimensions( $path ) );
	}

	/**
	 * ⚠️ A malformed tag must not rotate a customer's artwork to a guess.
	 */
	public function test_an_unknown_orientation_leaves_the_image_alone(): void {
		$path = $this->jpegWithExif( 99 );

		$this->images()->consume_metadata( $path );

		$this->assertSame( array( 40, 30 ), $this->images()->dimensions( $path ) );
	}

	/**
	 * ⚠️ **A document is left untouched.** Sending a PDF through an image editor
	 * is how print-ready artwork gets corrupted.
	 */
	public function test_it_leaves_a_document_untouched(): void {
		$path  = $this->path( '.pdf' );
		$bytes = "%PDF-1.7\n%%EOF";

		file_put_contents( $path, $bytes ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.

		$this->assertTrue( $this->images()->consume_metadata( $path ) );
		$this->assertSame( $bytes, file_get_contents( $path ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.
	}

	/**
	 * A PNG carries no orientation tag, so re-encoding it would cost a decode
	 * for nothing — the one thing this class exists to avoid.
	 */
	public function test_a_png_is_not_re_encoded(): void {
		$path   = $this->pngHeader( 100, 100 );
		$before = (string) file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.

		$this->images()->consume_metadata( $path );

		$this->assertSame( $before, file_get_contents( $path ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.
	}

	/** A corrupt image is reported, not silently accepted. */
	public function test_a_corrupt_jpeg_reports_failure(): void {
		$path = $this->path( '.jpg' );

		// A valid JPEG header followed by nothing decodable.
		file_put_contents( $path, "\xFF\xD8\xFF\xE0" . str_repeat( "\x00", 40 ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.

		$this->assertFalse( $this->images()->is_image( $path ) );
	}

	/* --- previews -------------------------------------------------------- */

	/** An image yields a small JPEG preview. */
	public function test_it_previews_an_image(): void {
		$preview = $this->images()->thumbnail( $this->jpeg( 400, 300 ) );

		$this->assertNotSame( '', $preview );
		$this->assertSame( "\xff\xd8", substr( $preview, 0, 2 ), 'A preview must be a JPEG.' );
	}

	/** The preview is bounded by the edge asked for. */
	public function test_a_preview_fits_the_requested_edge(): void {
		$preview = $this->images()->thumbnail( $this->jpeg( 400, 300 ), 96 );
		$size    = getimagesizefromstring( $preview );

		$this->assertIsArray( $size );
		$this->assertLessThanOrEqual( 96, $size[0] );
		$this->assertLessThanOrEqual( 96, $size[1] );
		$this->assertSame( 96, $size[0], 'The long edge should reach the bound.' );
	}

	/** A smaller image is never blown up. */
	public function test_a_small_image_is_not_enlarged(): void {
		$size = getimagesizefromstring( $this->images()->thumbnail( $this->jpeg( 40, 30 ), 96 ) );

		$this->assertSame( array( 40, 30 ), array( $size[0], $size[1] ) );
	}

	/**
	 * 🔴 **Nothing from the customer's file survives into the preview.**
	 *
	 * This is what lets a preview render inline at all. ADR-041 guarantees an
	 * *uploaded* file reaches the merchant as a download rather than something a
	 * browser renders, and its stated reason is active content. A preview is
	 * decoded to pixels and re-encoded, so the bytes the browser receives are a
	 * file this plugin authored — no EXIF, no GPS, no embedded payload.
	 */
	public function test_a_preview_carries_none_of_the_originals_metadata(): void {
		$path     = $this->jpegWithExif( 6 );
		$original = (string) file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test fixture.
		$preview  = $this->images()->thumbnail( $path );

		$this->assertStringContainsString( "Exif\x00\x00", $original, 'The fixture must carry EXIF to begin with.' );
		$this->assertStringNotContainsString( "Exif\x00\x00", $preview, 'No EXIF may survive the re-encode.' );
		$this->assertStringNotContainsString( "\x88\x25", $preview, 'No GPS tag may survive.' );
	}

	/**
	 * ⚠️ **A document gets no preview rather than a broken one.** A PDF has none
	 * without a renderer this phase deliberately does not ship, and
	 * `getimagesize()` answers false for one.
	 */
	public function test_a_document_has_no_preview(): void {
		$path = $this->path( '.pdf' );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $path, "%PDF-1.7\n%%EOF" );

		$this->assertSame( '', $this->images()->thumbnail( $path ) );
	}

	/** A header promising more pixels than the host can decode is refused. */
	public function test_a_pixel_bomb_has_no_preview(): void {
		$this->assertSame( '', $this->images()->thumbnail( $this->pngHeader( 20000, 20000 ) ) );
	}

	/** A missing file has no preview. */
	public function test_a_missing_file_has_no_preview(): void {
		$this->assertSame( '', $this->images()->thumbnail( '/no/such/file.jpg' ) );
	}
}
