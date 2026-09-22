<?php
/**
 * The one filesystem operation an upload cannot perform in a test.
 *
 * 🔴 **`is_uploaded_file()` is true only for a file PHP itself received.** No
 * test can create one, so the guard that depends on it — the defence against a
 * crafted `tmp_name` pointing at `/etc/passwd` — could not be exercised, and a
 * mutation removing it left **1091 tests passing**. Measured, not assumed.
 *
 * This is the same seam `Api\FetchesFromCloud` gives `Config\Synchroniser`: a
 * boundary narrow enough to describe what the caller needs and wide enough to
 * stand in for. The production implementation still calls the real functions;
 * the interface exists so a test can prove the endpoint *asks*.
 *
 * ⚠️ **Narrow on purpose.** A test double for "the filesystem" would let the
 * endpoint reach anything; this can move one uploaded file and nothing else.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

defined( 'ABSPATH' ) || exit;

/**
 * Moving a PHP upload into permanent storage.
 */
interface MovesUploadedFiles {

	/**
	 * Move a file PHP received as an upload.
	 *
	 * ⚠️ **Must refuse a path PHP did not receive.** That check is the whole
	 * point of the interface: a caller can hand this any string, and only a
	 * genuine upload may be moved.
	 *
	 * @param string $from Temporary path from `$_FILES`.
	 * @param string $to   Destination inside protected storage.
	 */
	public function move( string $from, string $to ): bool;
}
