<?php
/**
 * Whether a file's bytes are what its name claims.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Upload\UploadContent;
use PHPUnit\Framework\TestCase;

/**
 * 🔴 **Everything before this checked a *claim*.** `UploadRules` tests the
 * extension a customer sent against the policy a merchant set; this is the first
 * question about the file itself.
 *
 * @covers \Optionia\Upload\UploadContent
 */
final class UploadContentTest extends TestCase {

	/**
	 * Temporary files to remove.
	 *
	 * @var array<int, string>
	 */
	private array $paths = array();

	protected function tearDown(): void {
		foreach ( $this->paths as $path ) {
			if ( is_file( $path ) ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test teardown; WP_Filesystem is not bootstrapped in unit tests.
				unlink( $path );
			}
		}

		$this->paths = array();

		unset( $GLOBALS['optionia_test_extra_mimes'] );
	}

	/**
	 * Write bytes to a temporary file.
	 *
	 * @param string $bytes Contents.
	 */
	private function file( string $bytes ): string {
		$path = tempnam( sys_get_temp_dir(), 'optionia-content' );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- see above.
		file_put_contents( $path, $bytes );
		$this->paths[] = $path;

		return $path;
	}

	/**
	 * 🔴 **Real images, not signatures.**
	 *
	 * `PNG` and `JPEG` were the format signature and nothing else -- eight and
	 * four bytes. Every test naming "a real PNG" was therefore uploading exactly
	 * the shape of a **polyglot**: a header with no image behind it, which is
	 * what a scripted payload disguised as an image looks like.
	 *
	 * That is why they broke when the decode check landed, and the break was the
	 * check working. A fixture that stands in for the safe case has to *be* the
	 * safe case, or the test cannot tell the two apart.
	 *
	 * These are genuine 1x1 images produced by GD, so they decode. The PDF is
	 * unchanged: a document is verified by its magic bytes, never decoded.
	 */
	private const PNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x09pHYs\x00\x00\x0e\xc4\x00\x00\x0e\xc4\x01\x95+\x0e\x1b\x00\x00\x00\x0cIDAT\x08\x99c\x60\x60\x60\x00\x00\x00\x04\x00\x01\xa3\x0a\x15\xe3\x00\x00\x00\x00IEND\xaeB\x60\x82";
	private const PDF = "%PDF-1.7\n%%EOF";

	/**
	 * A genuine 1x1 JPEG, built rather than embedded.
	 *
	 * Seven hundred bytes of base64 in a constant would be unreadable, and the
	 * point of the fixture is that it decodes -- which GD producing it
	 * guarantees more honestly than a literal nobody can verify by eye.
	 */
	private static function jpeg(): string {
		$image = imagecreatetruecolor( 1, 1 );

		ob_start();
		imagejpeg( $image, null, 80 );
		$bytes = (string) ob_get_clean();

		imagedestroy( $image );

		return $bytes;
	}

	public function test_a_real_pdf_matches_a_pdf_claim(): void {
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::PDF ), 'art.pdf' ) );
	}

	public function test_a_real_png_matches_a_png_claim(): void {
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::PNG ), 'logo.png' ) );
	}

	/**
	 * 🔴 **The gap WordPress leaves, closed by the magic-byte check.**
	 *
	 * Measured over HTTP: `PK\x03\x04…` named `a.pdf` is **accepted as a PDF** by
	 * `wp_check_filetype_and_ext()`, because `finfo` answers
	 * `application/octet-stream` and the extension is then trusted. ZIP is the
	 * container behind `.docx`, `.xlsx` and much else, so this is not exotic.
	 */
	public function test_a_zip_claiming_to_be_a_pdf_is_refused(): void {
		$zip = "PK\x03\x04" . str_repeat( 'A', 200 );

		$this->assertFalse( UploadContent::matches_claim( $this->file( $zip ), 'art.pdf' ) );
	}

	/**
	 * ⚠️ **At offset zero, not "somewhere near the start".**
	 *
	 * Readers tolerate leading slack before `%PDF-`; tolerating it here would
	 * accept a file with arbitrary bytes prepended, which is how a polyglot is
	 * built.
	 */
	public function test_a_pdf_signature_after_padding_is_refused(): void {
		$padded = str_repeat( ' ', 300 ) . self::PDF;

		$this->assertFalse( UploadContent::matches_claim( $this->file( $padded ), 'art.pdf' ) );
	}

	public function test_a_php_script_named_jpg_is_refused(): void {
		$php = '<?php system( $_GET["c"] ); ?>';

		$this->assertFalse( UploadContent::matches_claim( $this->file( $php ), 'photo.jpg' ) );
	}

	public function test_an_html_page_named_pdf_is_refused(): void {
		$html = '<html><script>alert(1)</script></html>';

		$this->assertFalse( UploadContent::matches_claim( $this->file( $html ), 'art.pdf' ) );
	}

	/**
	 * 🔴 **`proper_filename` is a refusal here, not a rename.**
	 *
	 * WordPress sets it when the content is a *different allowed type* from the
	 * extension, and on a media-library upload it renames the file and proceeds.
	 * That is right for a merchant uploading their own image and wrong for a
	 * customer's artwork: a merchant accepting only PDF must not silently receive
	 * a PNG because WordPress was willing to rename it.
	 */
	public function test_a_png_named_jpg_is_refused_rather_than_renamed(): void {
		$this->assertFalse( UploadContent::matches_claim( $this->file( self::PNG ), 'photo.jpg' ) );
	}

	/**
	 * ✅ `.ai` is accepted — an Illustrator file *is* a PDF.
	 *
	 * It works only because `application/pdf` is already in WordPress's
	 * allowlist, so the scoped map adds an *extension* rather than a type.
	 */
	public function test_an_illustrator_file_is_accepted(): void {
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::PDF ), 'art.ai' ) );
	}

	/**
	 * 🔴 **`.eps` is refused, and this test records why rather than a bug.**
	 *
	 * `wp_check_filetype_and_ext()` ends by testing the detected type against
	 * `get_allowed_mime_types()` **directly**, ignoring the `$mimes` argument —
	 * `wp-includes/functions.php:3324`. `application/postscript` is not in that
	 * list, so no scoped map can introduce it, and the only alternative is the
	 * global `upload_mimes` filter that ADR-041 rejects.
	 *
	 * If WordPress ever allows PostScript by default this test fails, which is
	 * the right moment to revisit the decision.
	 */
	public function test_an_eps_file_is_refused(): void {
		$eps = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\n";

		$this->assertFalse( UploadContent::matches_claim( $this->file( $eps ), 'art.eps' ) );
	}

	public function test_a_file_with_no_extension_is_refused(): void {
		$this->assertFalse( UploadContent::matches_claim( $this->file( self::PDF ), 'artwork' ) );
	}

	public function test_an_unreadable_path_is_refused(): void {
		$this->assertFalse( UploadContent::matches_claim( '/no/such/file', 'art.pdf' ) );
	}

	public function test_an_empty_file_is_refused(): void {
		$this->assertFalse( UploadContent::matches_claim( $this->file( '' ), 'art.pdf' ) );
	}

	/**
	 * A jpeg claiming to be a jpeg is the ordinary case and must pass.
	 *
	 * Asserted because a verifier that refuses everything passes every test that
	 * only checks refusals.
	 */
	public function test_a_real_jpeg_is_accepted(): void {
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::jpeg() ), 'photo.jpg' ) );
	}

	/** The environment probe answers honestly on this host. */
	public function test_it_reports_whether_it_can_verify(): void {
		$this->assertSame( extension_loaded( 'fileinfo' ), UploadContent::can_verify() );
	}

	/* --- browser-executable types (3f) --------------------------------- */

	/**
	 * Restore the platform's own allowlist between tests.
	 */
	private function allowExtra( array $mimes ): void {
		$GLOBALS['optionia_test_extra_mimes'] = $mimes;
	}

	/**
	 * ⚠️ WordPress refuses SVG by default, so this passes for the platform's
	 * reason rather than the plugin's. The test below is the one that matters.
	 */
	public function test_an_svg_is_refused_by_default(): void {
		$svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

		$this->assertFalse( UploadContent::matches_claim( $this->file( $svg ), 'logo.svg' ) );
	}

	/**
	 * 🔴 **The exposure Stage 3f closes.**
	 *
	 * WordPress blocking SVG is a **default**, not a guarantee. Measured on the
	 * running site: one `add_filter( 'upload_mimes', … )` — exactly what an
	 * SVG-support plugin does — and the same scripted SVG was **accepted**.
	 *
	 * M15.3 requires *"SVG rejected by default"*; leaning on WordPress's default
	 * makes that requirement a merchant's plugin choice.
	 */
	public function test_an_svg_stays_refused_when_a_plugin_allows_it(): void {
		$this->allowExtra( array( 'svg' => 'image/svg+xml' ) );

		$svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

		$this->assertFalse( UploadContent::matches_claim( $this->file( $svg ), 'logo.svg' ) );
	}

	/**
	 * ⚠️ **A different list from `UploadStore::EXECUTABLE_EXTENSIONS`.**
	 *
	 * That one stops the *server* running a file. XML is harmless to the server
	 * and dangerous in a **browser** — and M15.5 will put customer files in front
	 * of a logged-in administrator.
	 */
	public function test_xml_stays_refused_when_a_plugin_allows_it(): void {
		$this->allowExtra( array( 'xml' => 'text/xml' ) );

		$xml = '<?xml version="1.0"?><root><![CDATA[x]]></root>';

		$this->assertFalse( UploadContent::matches_claim( $this->file( $xml ), 'data.xml' ) );
	}

	/**
	 * ⚠️ **The comparison is case-insensitive, and nothing else tested that.**
	 *
	 * ✏️ Found by mutation: removing `strtolower()` killed the mutant only
	 * through a *compile* error, not an assertion — so the normalisation was
	 * unverified. A MIME type is case-insensitive by RFC 2045, `finfo`
	 * conventionally lowercases, but a `upload_mimes` filter is merchant code
	 * and may not.
	 */
	public function test_the_denylist_ignores_mime_case(): void {
		$this->allowExtra( array( 'svg' => 'IMAGE/SVG+XML' ) );

		$svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

		$this->assertFalse( UploadContent::matches_claim( $this->file( $svg ), 'logo.svg' ) );
	}

	/**
	 * 🔴 **The guard must not refuse what the phase exists for.**
	 *
	 * A verifier that refuses everything passes every test that only checks
	 * refusals, so the widened allowlist is asserted to leave real artwork alone.
	 */
	public function test_real_artwork_still_passes_with_svg_enabled(): void {
		$this->allowExtra( array( 'svg' => 'image/svg+xml' ) );

		$this->assertTrue( UploadContent::matches_claim( $this->file( self::PDF ), 'art.pdf' ) );
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::PNG ), 'logo.png' ) );
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::jpeg() ), 'photo.jpg' ) );
	}

	// --- Polyglots: a signature is a claim, a decode is a verification -------

	/**
	 * 🔴 **A file that is only a format signature is refused.**
	 *
	 * Measured against the real `finfo` and `wp_check_filetype_and_ext()` before
	 * this check existed: a file of nothing but a header and a script tag was
	 * **accepted** for five extensions. `finfo` reads the signature and stops,
	 * and `getimagesize()` reads the header and stops — it answered
	 * **1634493810x1948791081** for the PNG rather than refusing it.
	 *
	 * Nothing was exploitable: the download path sends `application/octet-stream`
	 * with `nosniff` and `attachment`, and the preview re-encodes to fresh
	 * pixels. This closes the file at the door rather than relying on every
	 * future reader of a stored file to be careful.
	 *
	 * ⚠️ **`.pdf` is deliberately absent.** `%PDF-` followed by anything is a
	 * structurally plausible PDF, and a document is never decoded — its
	 * guarantee is the magic-byte check plus a download that no browser renders.
	 *
	 * @dataProvider provide_polyglots
	 *
	 * @param string $filename What the customer called it.
	 * @param string $bytes    A header, and nothing behind it.
	 */
	public function test_a_header_with_no_image_behind_it_is_refused( string $filename, string $bytes ): void {
		$this->assertFalse( UploadContent::matches_claim( $this->file( $bytes ), $filename ) );
	}

	/**
	 * One per raster format the upload endpoint accepts.
	 *
	 * @return array<string, array{0: string, 1: string}>
	 */
	public static function provide_polyglots(): array {
		$script = '<script>alert(1)</script>';

		return array(
			'a GIF header and a script tag'  => array( 'x.gif', 'GIF89a' . $script ),
			'a PNG header and a script tag'  => array( 'x.png', "\x89PNG\r\n\x1a\n" . $script ),
			'a JPEG header and a script tag' => array( 'x.jpg', "\xFF\xD8\xFF\xE0" . $script ),
			'a TIFF header and a script tag' => array( 'x.tif', "II\x2A\x00" . $script ),
		);
	}

	/**
	 * 🔴 **A sane header with a corrupt body is refused by the DECODE.**
	 *
	 * The cases above are caught before the decode runs: their headers claim
	 * absurd dimensions -- the PNG one reports 1634493810x1948791081 -- so the
	 * pixel ceiling refuses them first. That is defence in depth working, and it
	 * meant a mutation making the decode always succeed **survived**.
	 *
	 * This file's header says 1x1, so it passes the ceiling and reaches
	 * `imagecreatefromstring()`, which is the only thing that can notice the
	 * body is not an image. It is the case that proves the decode is load
	 * bearing rather than decorative.
	 */
	public function test_a_sane_header_with_a_corrupt_body_is_refused(): void {
		$corrupt = substr( self::PNG, 0, 33 ) . str_repeat( "\x00", 40 );

		$this->assertFalse( UploadContent::matches_claim( $this->file( $corrupt ), 'logo.png' ) );
	}

	/**
	 * And the control: a genuine image of the same format still passes.    /**
	 * And the control: a genuine image of the same format still passes.
	 *
	 * Without this the test above is satisfied by refusing everything, which is
	 * the failure mode a security check is most likely to have.
	 */
	public function test_a_genuine_image_still_passes(): void {
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::PNG ), 'logo.png' ) );
		$this->assertTrue( UploadContent::matches_claim( $this->file( self::jpeg() ), 'photo.jpg' ) );
	}
}
