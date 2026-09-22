<?php
/**
 * Removing stored files the database has forgotten.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadExpirer;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadStore;
use Optionia\Upload\UploadSweeper;
use PHPUnit\Framework\TestCase;

/**
 * ✏️ **3g was planned as "purge files stored before validation existed", and
 * measurement showed there is nothing to purge** — every check runs before
 * storage, and a `file_input` option only became authorable in the same
 * unreleased version as the checks.
 *
 * 🔴 **The durable problem is the opposite: files with no row.** Orphan cleanup
 * reads the *table*, so a file it does not know about is invisible forever — a
 * crash between writing and recording, an uninstall that could not delete, a
 * restored database backup older than the uploads.
 *
 * @covers \Optionia\Upload\UploadSweeper
 */
final class UploadSweeperTest extends TestCase {

	/**
	 * The uploads root for this test.
	 *
	 * @var string
	 */
	private string $base = '';

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-sweep-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);

		$GLOBALS['wpdb'] = new \Optionia_Test_Wpdb();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['optionia_test_upload_dir'], $GLOBALS['wpdb'] );

		$this->removeTree( $this->base );
	}

	/**
	 * Delete a directory and everything in it, dotfiles included.
	 *
	 * @param string $dir Absolute path.
	 */
	private function removeTree( string $dir ): void {
		if ( ! is_dir( $dir ) ) {
			return;
		}

		$entries = scandir( $dir );

		foreach ( false === $entries ? array() : $entries as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}

			$path = $dir . '/' . $entry;

			if ( is_dir( $path ) ) {
				$this->removeTree( $path );
			} else {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test teardown.
				unlink( $path );
			}
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- test teardown.
		rmdir( $dir );
	}

	private function sweeper(): UploadSweeper {
		$logger = new Logger( new Settings() );

		return new UploadSweeper( new UploadStore( $logger ), $logger );
	}

	/** The store's directory, created and guarded. */
	private function directory(): string {
		return ( new UploadStore( new Logger( new Settings() ) ) )->directory();
	}

	/**
	 * Write a stored file, optionally aged past the grace period.
	 *
	 * @param string $name  File name.
	 * @param bool   $aged  Whether to backdate it.
	 */
	private function storedFile( string $name, bool $aged = true ): string {
		$path = $this->directory() . '/' . $name;

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $path, 'bytes' );

		if ( $aged ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch -- backdating a fixture; WP_Filesystem has no equivalent.
			touch( $path, time() - UploadSweeper::GRACE_SECONDS - 60 );
		}

		return $path;
	}

	/**
	 * 🔴 **The case this class exists for.**
	 */
	public function test_it_removes_a_file_with_no_row(): void {
		$orphan = $this->storedFile( 'abandoned.pdf' );

		$this->assertSame( 1, $this->sweeper()->sweep() );
		$this->assertFileDoesNotExist( $orphan );
	}

	/**
	 * 🔴 **A file the table knows is a customer's live upload.**
	 *
	 * Deleting one would lose artwork a merchant is about to print.
	 */
	public function test_it_keeps_a_file_the_table_knows(): void {
		$known = $this->storedFile( 'live.pdf' );

		$GLOBALS['wpdb']->columns = array( 'live.pdf' );

		$this->assertSame( 0, $this->sweeper()->sweep() );
		$this->assertFileExists( $known );
	}

	/**
	 * 🔴 **The grace period is the difference between a sweeper and a race.**
	 *
	 * A file is written by `move_uploaded_file()` and recorded milliseconds
	 * later. A sweep in that gap would delete an upload that succeeded.
	 */
	public function test_it_spares_a_file_younger_than_the_grace_period(): void {
		$fresh = $this->storedFile( 'just-written.pdf', false );

		$this->assertSame( 0, $this->sweeper()->sweep() );
		$this->assertFileExists( $fresh );
	}

	/**
	 * ⚠️ **The guard files are ours and must survive**, or the directory stops
	 * being protected on every host that reads them.
	 */
	public function test_it_never_removes_the_guard_files(): void {
		$directory = $this->directory();

		foreach ( array( '.htaccess', 'web.config', 'index.php' ) as $guard ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch -- backdating a fixture; WP_Filesystem has no equivalent.
			touch( $directory . '/' . $guard, time() - UploadSweeper::GRACE_SECONDS - 60 );
		}

		$this->sweeper()->sweep();

		$this->assertFileExists( $directory . '/.htaccess' );
		$this->assertFileExists( $directory . '/web.config' );
		$this->assertFileExists( $directory . '/index.php' );
	}

	/**
	 * ⚠️ **A symlink is never followed out of the store.**
	 *
	 * A sweeper that follows one deletes whatever it points at — which is how a
	 * cleanup job removes a merchant's own files.
	 */
	public function test_it_refuses_to_follow_a_symlink(): void {
		// The store creates the base; the target sits beside it, outside the store.
		$this->directory();

		$outside = $this->base . '/not-ours.txt';

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $outside, 'someone else' );

		$link = $this->directory() . '/link.pdf';

		symlink( $outside, $link );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch -- backdating a fixture; WP_Filesystem has no equivalent.
		touch( $link, time() - UploadSweeper::GRACE_SECONDS - 60 );

		$this->sweeper()->sweep();

		$this->assertFileExists( $outside, 'The symlink target must survive.' );
	}

	/** Several orphans go in one pass. */
	public function test_it_removes_several_orphans(): void {
		$this->storedFile( 'a.pdf' );
		$this->storedFile( 'b.png' );
		$this->storedFile( 'c.jpg' );

		$this->assertSame( 3, $this->sweeper()->sweep() );
	}

	/** Known and unknown files in the same directory are separated correctly. */
	public function test_it_removes_only_the_unknown(): void {
		$keep   = $this->storedFile( 'keep.pdf' );
		$remove = $this->storedFile( 'remove.pdf' );

		$GLOBALS['wpdb']->columns = array( 'keep.pdf' );

		$this->assertSame( 1, $this->sweeper()->sweep() );
		$this->assertFileExists( $keep );
		$this->assertFileDoesNotExist( $remove );
	}

	/** An empty store is not an error. */
	public function test_an_empty_directory_sweeps_nothing(): void {
		$this->directory();

		$this->assertSame( 0, $this->sweeper()->sweep() );
	}

	/**
	 * 🔴 **An unusable directory sweeps nothing rather than guessing.**
	 *
	 * Sweeping a path this plugin could not create would be sweeping someone
	 * else's.
	 */
	public function test_it_sweeps_nothing_when_storage_is_unavailable(): void {
		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => '',
			'baseurl' => '',
			'error'   => 'Disk full',
		);

		$this->assertSame( 0, $this->sweeper()->sweep() );
	}

	/**
	 * The batch bound keeps a cron run off a customer's page load.
	 */
	public function test_the_batch_is_bounded(): void {
		$this->assertGreaterThan( 0, UploadSweeper::BATCH );
		$this->assertLessThanOrEqual( 1000, UploadSweeper::BATCH );
	}

	/**
	 * ⚠️ The grace period must sit between a request and the orphan TTL.
	 *
	 * Shorter than a request risks deleting a live upload; longer than the TTL
	 * makes the sweeper slower than the thing it backs up.
	 */
	/**
	 * 🔴 **The hourly pass must run expiry, not only the sweep.**
	 *
	 * They clean up opposite things: the sweep removes files whose row is
	 * missing, expiry removes rows whose deadline has passed. Wiring only the
	 * sweep left every abandoned cart's file on disk forever, which is the gap
	 * `UploadExpirer` exists to close — and a class nothing calls is exactly how
	 * `expired()` came to have no callers in the first place.
	 *
	 * ⚠️ Asserted through the query the expirer issues rather than a double:
	 * `UploadExpirer` is `final`, and the point is that the real one is invoked.
	 */
	public function test_the_due_pass_expires_before_it_sweeps(): void {
		$logger = new Logger( new Settings() );

		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['wpdb']->queries         = array();

		$sweeper = new UploadSweeper(
			new UploadStore( $logger ),
			$logger,
			new UploadExpirer( new UploadRepository(), new UploadStore( $logger ), $logger )
		);

		$sweeper->on_sweep_due();

		$asked = array_filter(
			$GLOBALS['wpdb']->queries,
			static fn ( string $sql ): bool => false !== stripos( $sql, 'expires_at' )
		);

		$this->assertNotSame( array(), $asked, 'The hourly pass must ask which uploads have expired.' );
	}

	public function test_the_grace_period_is_between_a_request_and_the_ttl(): void {
		$this->assertGreaterThanOrEqual( 600, UploadSweeper::GRACE_SECONDS );
		$this->assertLessThan( \Optionia\Upload\UploadRepository::ORPHAN_TTL, UploadSweeper::GRACE_SECONDS );
	}
}
