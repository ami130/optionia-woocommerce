<?php
/**
 * The real move, using PHP's own upload verification.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Moves an uploaded file into protected storage.
 */
final class UploadMover implements MovesUploadedFiles {

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build the mover over the logger.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Move a file PHP received as an upload.
	 *
	 * 🔴 **`is_uploaded_file()` first, and `move_uploaded_file()` rather than
	 * `rename()`.** Both verify the source came from PHP's own upload handling,
	 * so a crafted `tmp_name` pointing at a system file cannot be moved into the
	 * store — the request would otherwise hand an attacker a copy of anything
	 * the web user can read.
	 *
	 * @param string $from Temporary path from `$_FILES`.
	 * @param string $to   Destination inside protected storage.
	 */
	public function move( string $from, string $to ): bool {
		if ( ! is_uploaded_file( $from ) ) {
			$this->logger->warning( 'Refused a file that was not a PHP upload.' );

			return false;
		}

		return move_uploaded_file( $from, $to );
	}
}
