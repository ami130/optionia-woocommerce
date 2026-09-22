<?php
/**
 * Builds one archive of every file an order carries (M15.5, Stage 5c).
 *
 * ## Why a merchant needs this
 *
 * A print shop fulfilling an order with six uploads should not click six links
 * and hunt six files out of a downloads folder. `Admin\OrderFiles` gives each
 * file its own link; this gives the whole order in one.
 *
 * ## What goes in, and what cannot
 *
 * 🔴 **The tokens come from the order's own line items, never from the
 * request.** A caller names an *order id* and nothing else, so there is no way
 * to assemble an archive of files that belong to someone else's order by
 * guessing tokens. That is the same source `UploadRetention` trusts to decide
 * what an order owns, and it is why the capability check is a sufficient gate.
 *
 * ## Duplicate names lose files, silently
 *
 * 🔴 **Measured:** adding two entries called `logo.png` to a `ZipArchive` leaves
 * **one** entry — the second overwrites the first with no error and no warning.
 * Two options on one order can easily carry the same customer filename, so
 * without de-duplication a merchant would open the archive and simply not find
 * one of the files they were told they had. Names are made unique instead.
 *
 * ## Why a temporary file
 *
 * ⚠️ **`ZipArchive` writes to a path, not a stream**, so an archive has to exist
 * on disk before it can be sent. It is built inside the guarded upload directory
 * rather than the system temp directory: the same two secrets that protect a
 * customer's file protect an archive of *all* of them, and the system temp
 * directory is world-readable on many hosts.
 *
 * `UploadSweeper` cannot take it mid-build — it deletes only files older than an
 * hour with no row — and it is removed as soon as it has been sent. If a request
 * dies before that, the sweeper is the safety net that eventually removes it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Collects an order's uploads into a single archive.
 */
final class UploadArchive {

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Protected storage.
	 *
	 * @var UploadStore
	 */
	private UploadStore $store;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build over the table, storage and the logger.
	 *
	 * @param UploadRepository $uploads Upload table.
	 * @param UploadStore      $store   Protected storage.
	 * @param Logger           $logger  Logger.
	 */
	public function __construct( UploadRepository $uploads, UploadStore $store, Logger $logger ) {
		$this->uploads = $uploads;
		$this->store   = $store;
		$this->logger  = $logger;
	}

	/**
	 * Whether this host can build an archive at all.
	 *
	 * ⚠️ **Checked rather than assumed.** `ZipArchive` ships with PHP but is not
	 * guaranteed — it is a compile-time extension a host can omit, and a fatal
	 * error on a merchant's order screen is a worse answer than no button.
	 */
	public static function is_available(): bool {
		return class_exists( 'ZipArchive' );
	}

	/**
	 * Build an archive of an order's files.
	 *
	 * @param mixed $order The order whose files are wanted.
	 * @return string Absolute path to the archive, or '' when none could be made.
	 */
	public function build( $order ): string {
		if ( ! self::is_available() ) {
			return '';
		}

		$rows = $this->rows_for( $order );

		if ( array() === $rows ) {
			return '';
		}

		$directory = $this->store->directory();

		if ( '' === $directory ) {
			return '';
		}

		$path = wp_tempnam( 'optionia-order-files.zip', $directory );

		if ( '' === (string) $path ) {
			return '';
		}

		$zip = new \ZipArchive();

		if ( true !== $zip->open( (string) $path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE ) ) {
			$this->logger->warning( 'Could not create an archive of an order\'s files.' );

			wp_delete_file( (string) $path );

			return '';
		}

		$used  = array();
		$added = 0;

		foreach ( $rows as $row ) {
			$file = $directory . '/' . (string) $row['stored_name'];

			if ( ! is_file( $file ) ) {
				continue;
			}

			if ( $zip->addFile( $file, $this->unique_name( (string) $row['original_name'], $used ) ) ) {
				++$added;
			}
		}

		$zip->close();

		if ( 0 === $added ) {
			// Every row outlived its file. An empty archive is worse than none:
			// it looks like the artwork was delivered.
			wp_delete_file( (string) $path );

			return '';
		}

		return (string) $path;
	}

	/**
	 * A name no other entry in this archive is using.
	 *
	 * 🔴 **Measured: `ZipArchive` overwrites silently.** Two entries called
	 * `logo.png` leave one file in the archive, with no error — so a merchant
	 * opens it and one of the uploads they were told they had is simply not
	 * there. Suffixing keeps every file, and keeps the customer's own name
	 * recognisable rather than replacing it with the meaningless stored one.
	 *
	 * @param string              $name The customer's filename.
	 * @param array<string, true> $used Names already in this archive.
	 */
	private function unique_name( string $name, array &$used ): string {
		$name = sanitize_file_name( '' === $name ? 'file' : $name );
		$name = '' === $name ? 'file' : $name;

		if ( ! isset( $used[ $name ] ) ) {
			$used[ $name ] = true;

			return $name;
		}

		$extension = (string) pathinfo( $name, PATHINFO_EXTENSION );
		$stem      = (string) pathinfo( $name, PATHINFO_FILENAME );
		$suffix    = 2;

		do {
			$candidate = $stem . '-' . $suffix . ( '' === $extension ? '' : '.' . $extension );
			++$suffix;
		} while ( isset( $used[ $candidate ] ) );

		$used[ $candidate ] = true;

		return $candidate;
	}

	/**
	 * The upload rows an order still has.
	 *
	 * @param mixed $order The order.
	 * @return array<int, array<string, mixed>>
	 */
	private function rows_for( $order ): array {
		$rows = array();

		foreach ( UploadTokens::in_order( $order ) as $token ) {
			$row = $this->uploads->find( $token );

			if ( null === $row ) {
				continue;
			}

			$stored = isset( $row['stored_name'] ) ? (string) $row['stored_name'] : '';

			if ( '' === $stored ) {
				continue;
			}

			$row['original_name'] = isset( $row['original_name'] ) ? (string) $row['original_name'] : '';
			$row['stored_name']   = $stored;

			$rows[] = $row;
		}

		return $rows;
	}
}
