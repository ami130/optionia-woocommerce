<?php
/**
 * Removes stored files the database has forgotten (M15.3, M15.4).
 *
 * ## Why this is not "purge unvalidated files"
 *
 * ✏️ **3g was planned as "purge anything stored before validation existed", and
 * measurement showed there is nothing to purge.** Every check —
 * `UploadRules`, `UploadContent`, `UploadImage` — runs *before* the byte offset
 * where `UploadStore::directory()` is called, verified by position in the
 * endpoint. And a file could only ever have been stored against an authorable
 * `file_input` option, which arrived in the same unreleased version as the checks
 * themselves. The vulnerable window never shipped.
 *
 * 🔴 **The durable problem is the opposite one: files with no row.** Orphan
 * cleanup (M15.4) reads the *table*, so a file the table does not know about is
 * invisible to it — forever. Four ways that happens:
 *
 * - a crash between `move_uploaded_file()` and the row insert;
 * - `uninstall.php` removing the table while a file could not be deleted, then a
 *   reinstall;
 * - a merchant restoring a database backup older than their uploads;
 * - any future code path that writes before it records.
 *
 * The endpoint already deletes the file when its own insert fails. This is for
 * the cases no request is alive to handle.
 *
 * ⚠️ **Deletes only what it can prove is unknown**, and only inside the plugin's
 * own salt-derived directory. A sweeper that guesses is one that removes a
 * merchant's media library on a bad glob.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Activation\Activator;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Reconciles the upload directory against the upload table.
 */
final class UploadSweeper {

	/**
	 * How long a file must exist before it is considered orphaned, in seconds.
	 *
	 * 🔴 **This grace period is the difference between a sweeper and a race.**
	 * A file is written by `move_uploaded_file()` and recorded a few
	 * milliseconds later; a sweep running in that gap would delete a file whose
	 * row is about to exist, and the customer would lose an upload that
	 * succeeded.
	 *
	 * An hour is far longer than any request, and far shorter than the 72-hour
	 * orphan TTL — so a genuinely abandoned file is still removed long before
	 * the table would have expired it.
	 */
	public const GRACE_SECONDS = 3600;

	/**
	 * Most files removed in one pass.
	 *
	 * Cron runs on a customer's request, so an unbounded sweep would put a
	 * directory listing and a thousand unlinks in front of whoever happened to
	 * load a page. The remainder is taken by the next run.
	 */
	public const BATCH = 200;

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
	 * Releases uploads whose deadline has passed, or null.
	 *
	 * @var UploadExpirer|null
	 */
	private ?UploadExpirer $expirer;

	/**
	 * Listen for the sweep event.
	 *
	 * ⚠️ **Attached to the existing sync event rather than a new schedule.**
	 * `Support\Cron` deliberately knows only how to schedule and delegate —
	 * giving it a sweeper dependency would make it the second place that knows
	 * about uploads. Hooking the same action keeps the schedule in one place and
	 * this class's knowledge in this class.
	 *
	 * Registered outside `is_admin()`: cron fires on a customer's request, and an
	 * admin-only registration would leave the sweep attached to nothing on the
	 * requests that actually run it.
	 */
	public function register(): void {
		add_action( Keys::CRON_SYNC_CONFIG, array( $this, 'on_sweep_due' ) );
	}

	/**
	 * Sweep, but not on every run.
	 *
	 * 🔴 **Sync runs every fifteen minutes; a directory listing does not need
	 * to.** An orphan is a rare accident, not a steady state, and reading a
	 * directory plus a `SELECT` on every quarter-hour would put disk work in
	 * front of a customer's page load ninety-six times a day for nothing.
	 *
	 * Once an hour is four times more often than the shortest thing it protects
	 * — a file's one-hour grace period — and far more often than the 72-hour
	 * orphan TTL needs.
	 */
	public function on_sweep_due(): void {
		$last = (int) get_option( Keys::OPTION_LAST_SWEEP, 0 );

		if ( $last > 0 && ( time() - $last ) < HOUR_IN_SECONDS ) {
			return;
		}

		update_option( Keys::OPTION_LAST_SWEEP, time(), false );

		/*
		 * ⚠️ **Expiry first, then the sweep.** Releasing a row deletes its file
		 * and then the row; if that pair is interrupted between the two, the
		 * file is left with no row — exactly what the sweep removes. Running
		 * them in this order lets the same hourly pass finish the job rather
		 * than leaving the remains for an hour.
		 */
		if ( null !== $this->expirer ) {
			$this->expirer->expire();
		}

		$this->sweep();
	}

	/**
	 * Build the sweeper over storage and the logger.
	 *
	 * @param UploadStore        $store   Protected storage.
	 * @param Logger             $logger  Logger.
	 * @param UploadExpirer|null $expirer Releases expired uploads; optional so
	 *                                    the sweep can be exercised alone.
	 */
	public function __construct( UploadStore $store, Logger $logger, ?UploadExpirer $expirer = null ) {
		$this->store   = $store;
		$this->logger  = $logger;
		$this->expirer = $expirer;
	}

	/**
	 * Delete stored files that no row refers to.
	 *
	 * @return int How many files were removed.
	 */
	public function sweep(): int {
		$directory = $this->store->directory();

		if ( '' === $directory ) {
			// No usable directory means nothing of ours is stored; sweeping a
			// path we could not create would be sweeping someone else's.
			return 0;
		}

		$entries = scandir( $directory );

		if ( false === $entries ) {
			$this->logger->warning( 'Could not read the upload directory to sweep it.' );

			return 0;
		}

		$known   = $this->known_names();
		$cutoff  = time() - self::GRACE_SECONDS;
		$removed = 0;

		foreach ( $entries as $entry ) {
			if ( $removed >= self::BATCH ) {
				break;
			}

			if ( ! $this->is_sweepable( $directory, $entry, $known, $cutoff ) ) {
				continue;
			}

			wp_delete_file( $directory . '/' . $entry );
			++$removed;
		}

		if ( $removed > 0 ) {
			/*
			 * Warned rather than logged at debug: a file with no row means
			 * something failed between writing and recording, and a merchant's
			 * support conversation should be able to see that it happened.
			 */
			$this->logger->warning(
				'Removed stored files with no database record.',
				array( 'removed' => $removed )
			);
		}

		return $removed;
	}

	/**
	 * Whether one directory entry may be deleted.
	 *
	 * ⚠️ **Every condition here is a refusal to act on a guess.** The guard files
	 * are ours and must stay; a directory is not something this sweeper created;
	 * a symlink must never be followed out of the store; a file younger than the
	 * grace period may simply be mid-request; and a name the table knows is a
	 * customer's live upload.
	 *
	 * @param string              $directory Absolute directory path.
	 * @param string              $entry     Directory entry name.
	 * @param array<string, true> $known     Names the table refers to.
	 * @param int                 $cutoff    Files newer than this are spared.
	 */
	private function is_sweepable( string $directory, string $entry, array $known, int $cutoff ): bool {
		if ( '.' === $entry || '..' === $entry ) {
			return false;
		}

		// The guards this plugin writes are not uploads.
		if ( in_array( $entry, array( '.htaccess', 'web.config', 'index.php' ), true ) ) {
			return false;
		}

		$path = $directory . '/' . $entry;

		if ( is_link( $path ) || ! is_file( $path ) ) {
			return false;
		}

		if ( isset( $known[ $entry ] ) ) {
			return false;
		}

		$modified = filemtime( $path );

		return false !== $modified && $modified < $cutoff;
	}

	/**
	 * Every `stored_name` the table refers to.
	 *
	 * ⚠️ **Read in one query, and a failure means sweep nothing.** A partial list
	 * would make live uploads look orphaned, so an empty result from a failed
	 * query must not be mistaken for "the table is empty".
	 *
	 * @return array<string, true>
	 */
	private function known_names(): array {
		global $wpdb;

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		/*
		 * The table name is interpolated because an identifier cannot be a
		 * placeholder. It is built from a hardcoded suffix in `Keys` and the
		 * trusted `$wpdb->prefix`, so no caller input reaches it.
		 */
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$names = $wpdb->get_col( "SELECT stored_name FROM `{$table}`" );

		if ( ! is_array( $names ) ) {
			return array();
		}

		$known = array();

		foreach ( $names as $name ) {
			$known[ (string) $name ] = true;
		}

		return $known;
	}
}
