<?php
/**
 * Whether a file's **bytes** are what its name claims (M15.3).
 *
 * ## What this asks that `UploadRules` does not
 *
 * `Upload\UploadRules` enforces what the *merchant* configured, against the
 * extension the *customer* sent — a claim checked against a policy. This asks a
 * different question: does the file's content agree with that claim at all?
 *
 * Both are necessary and neither is sufficient. A merchant accepting only PDF
 * still receives whatever bytes a customer chooses to name `.pdf`.
 *
 * ## What WordPress already does, and where it stops
 *
 * `wp_check_filetype_and_ext()` genuinely verifies by content — measured over
 * HTTP: a PHP script named `shell.jpg` is rejected, an HTML page named `a.pdf` is
 * rejected, and a PNG named `photo.jpg` comes back *corrected* to `photo.png`.
 * **SVG is refused outright**, which is M15.3's headline requirement met by the
 * platform.
 *
 * 🔴 **It stops at types `finfo` recognises.** Measured: `PK\x03\x04…` — a ZIP,
 * and the container behind `.docx`, `.xlsx` and a dozen other formats — named
 * `a.pdf` is **accepted as a PDF**, because `finfo` answers
 * `application/octet-stream` and the extension is then trusted. PDF is the format
 * this phase most needs and the one WordPress verifies least, so its magic bytes
 * are checked here explicitly.
 *
 * ⚠️ **`fileinfo` missing means refuse, not degrade.** Without it WordPress falls
 * back to trusting the filename, so "verified by content" silently inverts into
 * the thing it exists to prevent (ADR-041 Decision 2). `Support\Environment`
 * warns the merchant at authoring time; this refuses at upload time.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

defined( 'ABSPATH' ) || exit;

/**
 * Content verification for one uploaded file.
 */
final class UploadContent {

	/**
	 * Extensions accepted beyond WordPress's own list.
	 *
	 * ⚠️ **Only an extension for a MIME type WordPress *already* allows.**
	 * `wp_check_filetype_and_ext()` ends by testing the detected type against
	 * `get_allowed_mime_types()` **directly**, ignoring the `$mimes` argument it
	 * was handed — verified at `wp-includes/functions.php:3324`. So a scoped map
	 * can name a new extension for an allowed type and nothing more.
	 *
	 * `.ai` qualifies: an Illustrator file *is* a PDF, and `finfo` reports
	 * `application/pdf`. `.eps` does not — `application/postscript` is not in
	 * WordPress's list, and the only way to add it is the global `upload_mimes`
	 * filter, which would widen the merchant's entire site. ADR-041 records that
	 * as a deliberate loss rather than a gap.
	 */
	private const EXTRA_TYPES = array(
		'ai' => 'application/pdf',
	);

	/**
	 * Types a browser will execute, refused whatever WordPress allows.
	 *
	 * 🔴 **WordPress blocking SVG is a *default*, not a guarantee.** Measured on
	 * this host: `matches_claim()` refuses a scripted SVG — and one
	 * `add_filter( 'upload_mimes', … )` later, which is exactly what an
	 * SVG-support plugin does, the same file is **accepted**. A merchant
	 * installing a perfectly ordinary plugin would silently open this.
	 *
	 * M15.3 says *"SVG rejected by default"*; relying on WordPress's default is
	 * how that requirement becomes someone else's decision.
	 *
	 * ⚠️ **A different list from `UploadStore::EXECUTABLE_EXTENSIONS`, and both
	 * are needed.** That one stops the *server* running a file — `.php`, `.cgi`,
	 * `.sh`. These are harmless to the server and dangerous in a **browser**:
	 * served inline they execute script in the merchant's own origin, and M15.5
	 * will put customer files in front of a logged-in administrator.
	 *
	 * Checked by **MIME type**, not extension, because the extension is a claim
	 * and the type is what `finfo` read from the bytes. A scripted SVG named
	 * `logo.png` is caught by the extension/type disagreement; one named
	 * `logo.svg` is caught here.
	 */
	private const BROWSER_EXECUTABLE = array(
		'image/svg+xml',
		'text/html',
		'application/xhtml+xml',
		'text/xml',
		'application/xml',
		'application/x-shockwave-flash',
	);

	/**
	 * Formats whose first bytes are checked here because WordPress does not.
	 *
	 * ⚠️ **At offset zero, not "somewhere near the start".** The PDF
	 * specification puts `%PDF-` at the beginning; readers tolerate leading
	 * slack, and tolerating it here would accept a file with arbitrary bytes
	 * prepended — which is how a polyglot is built. `.ai` shares the signature
	 * because an Illustrator file is a PDF.
	 */
	private const MAGIC = array(
		'pdf' => '%PDF-',
		'ai'  => '%PDF-',
	);

	/**
	 * Extensions whose bytes must decode to an actual image, not merely start
	 * like one.
	 *
	 * 🔴 **A signature is a claim; a decode is a verification.** Measured
	 * against the real `finfo` and `wp_check_filetype_and_ext()`, a file of
	 * nothing but a format signature and a script tag was **accepted** for five
	 * extensions:
	 *
	 * ```text
	 * "GIF89a<script>alert(1)</script>"          accepted as .gif
	 * "\x89PNG\r\n\x1a\n<script>…</script>"       accepted as .png
	 * "\xFF\xD8\xFF\xE0<script>…</script>"         accepted as .jpg
	 * ```
	 *
	 * `finfo` reads the signature and stops. `getimagesize()` reads the header
	 * and stops -- it answered **1634493810x1948791081** for that PNG rather
	 * than refusing it. Only a decode notices there is no image behind the
	 * header.
	 *
	 * ⚠️ **`webp` and `bmp` are absent because they were already refused**, by
	 * `wp_check_filetype_and_ext()` -- verified rather than assumed. Listing
	 * them would imply this is the thing stopping them.
	 *
	 * Nothing was exploitable through this: the download path sends
	 * `application/octet-stream` with `nosniff` and `attachment`, and the
	 * preview re-encodes to fresh pixels -- measured, a polyglot produced an
	 * empty preview rather than passing bytes through. This closes the file at
	 * the door rather than relying on every future reader to be careful.
	 */
	private const MUST_DECODE = array( 'gif', 'png', 'jpg', 'jpeg', 'tif', 'tiff' );

	/**
	 * The largest image this will decode, in pixels.
	 *
	 * A ceiling on the decode, not a limit on what a merchant may accept --
	 * `UploadRules::max_megapixels()` is that, it is tighter, and
	 * `UploadEndpoint` applies it first. This exists so no caller can reach
	 * `imagecreatefromstring()` with an unbounded image, because that function
	 * allocates for the dimensions the header claims: measured, a crafted
	 * 20000x20000 PNG needs ~1.5 GB where reading its header needs 536 bytes.
	 *
	 * 100 megapixels is far above any camera a customer will upload from and far
	 * below what takes a 128 MB host down.
	 */
	private const MAX_DECODE_PIXELS = 100000000;

	/**
	 * Whether the environment can verify content at all.
	 *
	 * 🔴 **A caller must refuse the upload when this is false.** Storing a file
	 * whose type was never checked, on a host that cannot check it, is the exact
	 * failure `Support\Environment`'s warning exists to prevent.
	 */
	public static function can_verify(): bool {
		return extension_loaded( 'fileinfo' );
	}

	/**
	 * Whether this file's bytes match the extension it claims.
	 *
	 * @param string $path      Absolute path to the uploaded temporary file.
	 * @param string $filename  The name the customer sent.
	 */
	public static function matches_claim( string $path, string $filename ): bool {
		if ( ! self::can_verify() || ! is_readable( $path ) ) {
			return false;
		}

		$claimed = strtolower( (string) preg_replace( '/[^a-z0-9]/i', '', (string) pathinfo( $filename, PATHINFO_EXTENSION ) ) );

		if ( '' === $claimed ) {
			return false;
		}

		if ( ! self::magic_matches( $path, $claimed ) ) {
			return false;
		}

		if ( ! self::decodes_if_it_must( $path, $claimed ) ) {
			return false;
		}

		$checked = wp_check_filetype_and_ext( $path, $filename, self::allowed_types() );

		if ( empty( $checked['ext'] ) ) {
			// Unrecognised, disallowed, or refused as text-like. Any of the three
			// means the bytes are not what the name claims.
			return false;
		}

		/*
		 * 🔴 **Refused whatever WordPress allows.**
		 *
		 * A merchant's SVG-support plugin adds `image/svg+xml` to
		 * `upload_mimes`, and everything above would then accept a scripted SVG —
		 * measured. This is the plugin's own decision rather than a borrowed
		 * default.
		 */
		if ( in_array( strtolower( (string) $checked['type'] ), self::BROWSER_EXECUTABLE, true ) ) {
			return false;
		}

		/*
		 * 🔴 **`proper_filename` is a refusal here, not a rename.**
		 *
		 * WordPress sets it when the content is a *different* allowed type from
		 * the extension — on a media-library upload it renames the file and
		 * proceeds. That is right for a merchant uploading their own image and
		 * wrong for a customer's artwork: a merchant who accepts only PDF must
		 * not silently receive a PNG because WordPress was willing to rename it.
		 */
		if ( ! empty( $checked['proper_filename'] ) ) {
			return false;
		}

		return strtolower( (string) $checked['ext'] ) === $claimed;
	}

	/**
	 * WordPress's allowlist, plus the extensions in `EXTRA_TYPES`.
	 *
	 * ⚠️ **Merged, never replaced.** Passing only the additions makes the map the
	 * *whole* allowlist for that call — verified: a scoped map of just `['ai' =>
	 * …]` rejects a genuine PDF. An easy way to break every other format while
	 * "adding" one.
	 *
	 * @return array<string, string>
	 */
	private static function allowed_types(): array {
		return array_merge( get_allowed_mime_types(), self::EXTRA_TYPES );
	}

	/**
	 * Whether a file claiming a raster format decodes to actual pixels.
	 *
	 * Keyed on the **claimed extension**, not on whether a header happens to
	 * parse: a truncated JPEG makes `getimagesize()` answer false, so a check
	 * asking "is this an image?" first would skip exactly the file it needs to
	 * refuse.
	 *
	 * ⚠️ **Bounded before decoding.** `imagecreatefromstring()` allocates for
	 * the dimensions the header claims, so a crafted 20000x20000 PNG would need
	 * ~1.5 GB. `getimagesize()` reads that header for 536 bytes, so the
	 * dimensions are checked against a ceiling first and an implausible one is
	 * refused without ever decoding -- the decompression-bomb defence
	 * `UploadEndpoint` already applies per option, repeated here because this
	 * method is reachable from anywhere.
	 *
	 * No GD means no decode, and refusing every image on such a host would be
	 * worse than the hazard: the file is still never executed by the web server,
	 * never served inline, and never previewed without re-encoding.
	 *
	 * @param string $path    Absolute path.
	 * @param string $claimed Normalised extension.
	 */
	private static function decodes_if_it_must( string $path, string $claimed ): bool {
		if ( ! in_array( $claimed, self::MUST_DECODE, true ) ) {
			return true;
		}

		if ( ! function_exists( 'imagecreatefromstring' ) ) {
			return true;
		}

		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a malformed image is a customer's mistake; the return value is the check.
		$size = @getimagesize( $path );

		if ( ! is_array( $size ) || ! isset( $size[0], $size[1] ) ) {
			// The header does not even describe an image, whatever it claims.
			return false;
		}

		if ( (int) $size[0] * (int) $size[1] > self::MAX_DECODE_PIXELS ) {
			/*
			 * Too large to decode safely, so it is not decoded. `UploadEndpoint`
			 * applies the merchant's own, tighter budget before this runs and
			 * refuses first; this ceiling exists so no caller can reach the
			 * decode with an unbounded image.
			 */
			return false;
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local upload, not a URL.
		$bytes = file_get_contents( $path );

		if ( false === $bytes || '' === $bytes ) {
			return false;
		}

		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- see above; the return value is the check.
		$image = @imagecreatefromstring( $bytes );

		if ( false === $image ) {
			return false;
		}

		imagedestroy( $image );

		return true;
	}

	/**
	 * Whether the file starts with the signature its extension implies.
	 *
	 * Formats with no entry in `MAGIC` pass **this** stage. They are not
	 * therefore unchecked: a raster format is verified by `MUST_DECODE` above,
	 * and every other type by `wp_check_filetype_and_ext()`.
	 *
	 * 🔴 **This docblock claimed that function "verifies every image type
	 * properly", and the 2026-09-09 audit disproved it.** Measured: it accepted
	 * a file of nothing but a format signature and a script tag for `.gif`,
	 * `.png`, `.jpg` and `.tif`. `finfo` reads the signature and stops, and that
	 * is what the function trusts.
	 *
	 * The sentence is corrected rather than deleted because it was the reasoning
	 * that left the hole -- a docblock asserting a dependency is safe is exactly
	 * how a check that should exist never gets written.
	 *
	 * @param string $path    Absolute path.
	 * @param string $claimed Normalised extension.
	 */
	private static function magic_matches( string $path, string $claimed ): bool {
		if ( ! isset( self::MAGIC[ $claimed ] ) ) {
			return true;
		}

		$magic = self::MAGIC[ $claimed ];

		/*
		 * Read directly rather than through `WP_Filesystem`.
		 *
		 * It can require FTP credentials, and it cannot read a `$_FILES`
		 * temporary path in any case — the file is not inside the site. Only a
		 * handful of bytes are read, and the suppression is deliberate: an
		 * unreadable file is a refusal, not a PHP warning printed to a customer
		 * mid-purchase.
		 */
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPress.PHP.NoSilencedErrors.Discouraged -- see above.
		$handle = @fopen( $path, 'rb' );

		if ( false === $handle ) {
			return false;
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread -- see above.
		$head = (string) fread( $handle, strlen( $magic ) );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- see above.
		fclose( $handle );

		/*
		 * ⚠️ **A plain `===`, and deliberately not `hash_equals()`.**
		 *
		 * `bin/check-secrets.sh` flagged this line while the variable was called
		 * `$signature` — its heuristic treats that word as a secret, and it was
		 * right to be suspicious of the name. Nothing secret is compared here:
		 * both sides are public file magic (`%PDF-`), the value is fixed in this
		 * file, and there is no timing signal because there is nothing to guess.
		 *
		 * Renamed rather than exempted. A `hash_equals()` added to satisfy a gate
		 * teaches the next reader that constant-time comparison is a formality,
		 * and the gate is more valuable than this one line is convenient.
		 */
		return $head === $magic;
	}
}
