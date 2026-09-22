<?php
/**
 * Image-specific handling: dimensions, then orientation, then metadata (M15.3).
 *
 * ## Why the order cannot be rearranged
 *
 * 🔴 **Reading dimensions is free; decoding is what kills the request.** Measured
 * over HTTP on this host: `getimagesize()` on a crafted 20000×20000 PNG header
 * reported the size for **536 bytes** of memory, where decoding the same image
 * would need ~1.5 GB. So the ceiling is checked from the header, and only a file
 * that passes is ever decoded.
 *
 * ⚠️ **This is not only a decompression-bomb defence.** On a 128 MB host — common
 * shared hosting — a 48 MP photo needs 183 MB decoded and takes the request with
 * it. That is an ordinary customer with a DSLR, not an attacker, and a fatal
 * error mid-upload is indistinguishable to them from a broken site.
 *
 * ## What "strip EXIF" actually means here
 *
 * ✏️ **ADR-041 first said "strip everything except Orientation", and measurement
 * showed that is impossible.** GD writes no EXIF at all, so a re-encode removes
 * every tag including the one to be kept — verified: a JPEG carrying
 * `Orientation=6` and GPS data came back from `imagejpeg()` with neither.
 *
 * So Orientation is **consumed**, not preserved: read the tag, rotate the pixels,
 * re-encode. The photo arrives the right way up carrying no metadata.
 *
 * 🔴 **GPS is why this matters.** A customer photographing artwork at home embeds
 * their home coordinates, and forwarding those to a merchant is a data-protection
 * problem nobody consented to. **Orientation is why it cannot simply be dropped
 * unread** — an unrotated portrait photo prints sideways, which is a refund.
 *
 * ⚠️ **Documents never enter this path.** `getimagesize()` answers `false` for a
 * PDF — verified — so `.pdf`, `.ai` and friends are neither measured nor decoded
 * nor re-encoded. Conflating the two is how a PDF ends up through an image
 * editor.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Dimension limits and metadata removal for uploaded images.
 */
final class UploadImage {

	/**
	 * Megapixel ceiling when a merchant configures none.
	 *
	 * ⚠️ **Chosen for the smallest host, not this one.** ~24 MP is the practical
	 * limit at a 128 MB `memory_limit`; this development site measures 512 MB
	 * over HTTP and would carry four times that. A default sized for the generous
	 * host would fatal on the modest one, and the failure lands on a customer
	 * mid-purchase rather than on whoever picked the number.
	 *
	 * A merchant who knows their host can raise it with `max_megapixels`.
	 */
	public const DEFAULT_MAX_MEGAPIXELS = 24.0;

	/**
	 * Bytes one pixel occupies once decoded.
	 *
	 * GD holds a truecolour image as four bytes per pixel regardless of the
	 * source format, so a 12 MP JPEG of a few megabytes becomes ~46 MB in memory.
	 * The file size on disk says nothing useful about this.
	 */
	private const BYTES_PER_PIXEL = 4;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build the handler over the logger.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Whether this file is an image at all.
	 *
	 * A `false` here is not a failure — it is a PDF, and documents skip every
	 * step in this class.
	 *
	 * @param string $path Absolute path.
	 */
	public function is_image( string $path ): bool {
		return array() !== $this->dimensions( $path );
	}

	/**
	 * Whether an image decodes to actual pixels, not merely a plausible header.
	 *
	 * 🔴 **A header is a claim; a decode is a verification.** Measured against
	 * the real `finfo` and `wp_check_filetype_and_ext()`, a file of nothing but
	 * a format signature and a script tag was accepted for five extensions:
	 *
	 * ```text
	 * "GIF89a<script>alert(1)</script>"                 accepted as .gif
	 * "\x89PNG\r\n\x1a\n<script>alert(1)</script>"        accepted as .png
	 * "\xFF\xD8\xFF\xE0<script>alert(1)</script>"          accepted as .jpg
	 * ```
	 *
	 * `finfo` reads the signature and stops; `getimagesize()` reads the header
	 * and stops — it reported **1634493810x1948791081** for that PNG rather than
	 * refusing it. Only a full decode notices there is no image behind the
	 * header.
	 *
	 * ⚠️ **This runs AFTER the pixel budget, never before.** The budget exists
	 * because decoding a crafted 20000x20000 PNG needs ~1.5 GB where reading its
	 * header needs 536 bytes; decoding first to check validity would be the
	 * decompression bomb the budget prevents.
	 *
	 * ⚠️ **Documents are not images and are not decoded.** A PDF answers `false`
	 * from `dimensions()`, so it never reaches the decode and is not judged by
	 * it. Its structure is verified by its magic bytes in `UploadContent`.
	 *
	 * Nothing was exploitable through this before: the download path sends
	 * `application/octet-stream` with `nosniff` and `attachment`, and the
	 * preview path re-encodes to fresh pixels — measured, a polyglot produced an
	 * empty preview rather than passing bytes through. This closes the file at
	 * the door instead of relying on every future reader to be careful.
	 *
	 * @param string $path Absolute path.
	 */
	public function decodes( string $path ): bool {
		if ( ! is_readable( $path ) || ! function_exists( 'imagecreatefromstring' ) ) {
			/*
			 * No GD means no decode, and refusing every image on such a host
			 * would be worse than the hazard: the file is still never executed
			 * by the web server, never served inline, and never previewed
			 * without re-encoding. `thumbnail()` makes the same judgement.
			 */
			return true;
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local upload, not a URL.
		$bytes = file_get_contents( $path );

		if ( false === $bytes || '' === $bytes ) {
			return false;
		}

		// Suppressed for the same reason `dimensions()` suppresses: a malformed
		// image is a customer's mistake, and a warning on a storefront is not an
		// answer. The `false` return carries the information.
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- the return value is the check.
		$image = @imagecreatefromstring( $bytes );

		if ( false === $image ) {
			return false;
		}

		imagedestroy( $image );

		return true;
	}

	/**
	 * Width and height from the file's header, without decoding it.    /**
	 * Width and height from the file's header, without decoding it.
	 *
	 * @param string $path Absolute path.
	 * @return array{0: int, 1: int}|array{}
	 */
	public function dimensions( string $path ): array {
		if ( ! is_readable( $path ) ) {
			return array();
		}

		/*
		 * Suppressed deliberately: `getimagesize()` emits a warning for anything
		 * that is not an image, and "this is a PDF" is the ordinary case here,
		 * not an error worth printing to a customer mid-purchase.
		 */
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- see above; the return value is the check.
		$size = @getimagesize( $path );

		if ( ! is_array( $size ) || ! isset( $size[0], $size[1] ) ) {
			return array();
		}

		return array( (int) $size[0], (int) $size[1] );
	}

	/**
	 * A small preview of an image, as raw JPEG bytes.
	 *
	 * 🔴 **Re-encoded, never the customer's bytes.** ADR-041 guarantees an
	 * uploaded file reaches the merchant *"as a download rather than something a
	 * browser renders inline"*, and its stated reason is active content — a PDF
	 * carrying `/JS`, an SVG carrying a script. Decoding an image to a pixel
	 * buffer and writing a fresh JPEG keeps **only pixels**: no EXIF, no embedded
	 * payload, nothing that survives to be executed. What the browser renders is
	 * a file this plugin authored, not one a customer supplied.
	 *
	 * ⚠️ **Only for images, and only when GD is present.** A PDF or an AI file
	 * has no preview without a document renderer this phase deliberately does not
	 * ship, and `getimagesize()` answers false for one — so a document simply
	 * gets no thumbnail rather than a broken one.
	 *
	 * @param string $path Absolute path to the stored file.
	 * @param int    $edge Longest edge of the preview, in pixels.
	 * @return string JPEG bytes, or '' when no preview can be made.
	 */
	public function thumbnail( string $path, int $edge = 96 ): string {
		$size = $this->dimensions( $path );

		if ( array() === $size || $edge < 1 ) {
			return '';
		}

		if ( ! $this->within_pixel_budget( $path ) ) {
			// The same bomb defence the upload path applies: a crafted header can
			// promise more pixels than the host can decode.
			return '';
		}

		if ( ! function_exists( 'imagecreatefromstring' ) || ! function_exists( 'imagejpeg' ) ) {
			return '';
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents, WordPress.PHP.NoSilencedErrors.Discouraged -- a local stored file, not a remote URL; an unreadable one returns false, which is the check.
		$bytes = @file_get_contents( $path );

		if ( false === $bytes ) {
			return '';
		}

		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a file GD cannot decode returns false; that is the check.
		$source = @imagecreatefromstring( $bytes );

		if ( false === $source ) {
			$this->logger->warning( 'Could not decode an image to preview it.' );

			return '';
		}

		list( $width, $height ) = $size;
		$scale                  = min( $edge / max( 1, $width ), $edge / max( 1, $height ), 1.0 );
		$target                 = imagecreatetruecolor( max( 1, (int) round( $width * $scale ) ), max( 1, (int) round( $height * $scale ) ) );

		imagecopyresampled(
			$target,
			$source,
			0,
			0,
			0,
			0,
			imagesx( $target ),
			imagesy( $target ),
			$width,
			$height
		);

		imagedestroy( $source );

		ob_start();
		imagejpeg( $target, null, 70 );
		$preview = (string) ob_get_clean();

		imagedestroy( $target );

		return $preview;
	}

	/**
	 * Whether an image is small enough to decode safely.
	 *
	 * ⚠️ **A non-image passes.** This answers "is it too big to decode", and a
	 * PDF is never decoded, so the question does not apply. Refusing here would
	 * refuse every document.
	 *
	 * @param string $path           Absolute path.
	 * @param float  $max_megapixels The option's ceiling, or 0 for the default.
	 */
	public function within_pixel_budget( string $path, float $max_megapixels = 0.0 ): bool {
		$size = $this->dimensions( $path );

		if ( array() === $size ) {
			return true;
		}

		$ceiling = $max_megapixels > 0 ? $max_megapixels : self::DEFAULT_MAX_MEGAPIXELS;
		$pixels  = $size[0] * $size[1];

		if ( $pixels <= 0 ) {
			// A header claiming zero pixels is malformed, not permissive.
			return false;
		}

		return $pixels <= (int) round( $ceiling * 1000000 );
	}

	/**
	 * How much memory decoding this image would need, in bytes.
	 *
	 * Exposed so a caller — and a test — can reason about the ceiling rather than
	 * trusting a magic number.
	 *
	 * @param string $path Absolute path.
	 */
	public function decoded_bytes( string $path ): int {
		$size = $this->dimensions( $path );

		return array() === $size ? 0 : $size[0] * $size[1] * self::BYTES_PER_PIXEL;
	}

	/**
	 * Rotate by the EXIF orientation and rewrite the file without metadata.
	 *
	 * Returns true when the file is left in a safe state — **including when it is
	 * not an image at all**, since a PDF needs nothing done to it.
	 *
	 * ⚠️ **Only JPEG carries EXIF worth consuming.** PNG and GIF have no
	 * orientation tag, and re-encoding them would cost a decode for nothing —
	 * which is the one thing this class exists to avoid.
	 *
	 * 🔴 **The caller must have checked `within_pixel_budget()` first.** This
	 * decodes, and decoding an unbounded image is the failure the budget prevents.
	 *
	 * @param string $path Absolute path to the uploaded file.
	 */
	public function consume_metadata( string $path ): bool {
		$size = $this->dimensions( $path );

		if ( array() === $size ) {
			// Not an image: nothing to rotate, nothing to strip.
			return true;
		}

		if ( ! $this->is_jpeg( $path ) ) {
			/*
			 * PNG and GIF carry no orientation tag, and GD writes no ancillary
			 * chunks on re-encode anyway. Leaving them untouched avoids a decode
			 * that would gain nothing.
			 */
			return true;
		}

		if ( ! function_exists( 'imagecreatefromjpeg' ) || ! function_exists( 'imagejpeg' ) ) {
			/*
			 * No GD. The file keeps its metadata, which is a privacy shortfall
			 * rather than a security hole — so it is logged and allowed rather
			 * than refusing an upload the merchant may still need.
			 */
			$this->logger->warning( 'GD is unavailable; image metadata was not removed.' );

			return true;
		}

		$orientation = $this->orientation( $path );

		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a corrupt image returns false; that is the check.
		$image = @imagecreatefromjpeg( $path );

		if ( false === $image ) {
			$this->logger->warning( 'Could not decode an image to remove its metadata.' );

			return false;
		}

		$rotated = $this->apply_orientation( $image, $orientation );

		/*
		 * Quality 90: high enough that a re-encode is not visible on print
		 * artwork, low enough that a customer's 12 MP photo does not grow. The
		 * alternative — copying the original bytes — is what carries the GPS
		 * data this method exists to remove.
		 */
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a write failure returns false; that is the check.
		$written = @imagejpeg( $rotated, $path, 90 );

		imagedestroy( $rotated );

		if ( ! $written ) {
			$this->logger->warning( 'Could not rewrite an image without its metadata.' );
		}

		return (bool) $written;
	}

	/**
	 * The EXIF orientation tag, or 1 when there is none.
	 *
	 * @param string $path Absolute path.
	 */
	private function orientation( string $path ): int {
		if ( ! function_exists( 'exif_read_data' ) ) {
			return 1;
		}

		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a file with no EXIF returns false, which is ordinary.
		$exif = @exif_read_data( $path );

		if ( ! is_array( $exif ) || ! isset( $exif['Orientation'] ) || ! is_numeric( $exif['Orientation'] ) ) {
			return 1;
		}

		return (int) $exif['Orientation'];
	}

	/**
	 * Apply an EXIF orientation to a decoded image.
	 *
	 * The six values that change the picture are handled; 1 is "already correct"
	 * and anything else is treated as 1, because a malformed tag must not rotate
	 * a customer's artwork to a guess.
	 *
	 * @param \GdImage|resource $image       Decoded image.
	 * @param int               $orientation EXIF orientation value.
	 * @return \GdImage|resource
	 */
	private function apply_orientation( $image, int $orientation ) {
		if ( ! function_exists( 'imagerotate' ) ) {
			return $image;
		}

		switch ( $orientation ) {
			case 3:
				$rotated = imagerotate( $image, 180, 0 );
				break;

			case 6:
				// EXIF 6 means "rotate 90° clockwise to view"; GD rotates
				// counter-clockwise, hence -90.
				$rotated = imagerotate( $image, -90, 0 );
				break;

			case 8:
				$rotated = imagerotate( $image, 90, 0 );
				break;

			default:
				return $image;
		}

		if ( false === $rotated ) {
			return $image;
		}

		imagedestroy( $image );

		return $rotated;
	}

	/**
	 * Whether the file is a JPEG, by its own bytes.
	 *
	 * @param string $path Absolute path.
	 */
	private function is_jpeg( string $path ): bool {
		$size = $this->dimensions( $path );

		if ( array() === $size ) {
			return false;
		}

		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- see dimensions().
		$info = @getimagesize( $path );

		return is_array( $info ) && isset( $info[2] ) && IMAGETYPE_JPEG === $info[2];
	}
}
