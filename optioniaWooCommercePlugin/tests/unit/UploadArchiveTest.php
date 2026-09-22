<?php
/**
 * Collecting an order's files into one archive.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadArchive;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

/**
 * `UploadArchive` building a bulk download.
 *
 * @covers \Optionia\Upload\UploadArchive
 */
final class UploadArchiveTest extends TestCase {

	/**
	 * The uploads root for this test.
	 *
	 * @var string
	 */
	private string $base = '';

	/**
	 * Rows `find()` should answer with, keyed by token.
	 *
	 * @var array<string, array<string, mixed>>
	 */
	private array $rows = array();

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-zip-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);

		$GLOBALS['wpdb']                  = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_options'] = array();
		$this->rows                       = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['optionia_test_upload_dir'], $GLOBALS['wpdb'] );

		$this->removeTree( $this->base );
	}

	/**
	 * Delete a directory and everything in it.
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

	private function archive(): UploadArchive {
		$logger = new Logger( new Settings() );

		return new UploadArchive( new UploadRepository(), new UploadStore( $logger ), $logger );
	}

	/**
	 * Store a real file and register the row `find()` will answer with.
	 *
	 * @param string $token         The file's token.
	 * @param string $original_name What the customer called it.
	 * @param string $bytes         The file's contents.
	 */
	private function storeFile( string $token, string $original_name, string $bytes ): void {
		$logger    = new Logger( new Settings() );
		$directory = ( new UploadStore( $logger ) )->directory();
		$stored    = substr( $token, 0, 12 ) . '.pdf';

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $directory . '/' . $stored, $bytes );

		$this->rows[ $token ] = array(
			'token'         => $token,
			'stored_name'   => $stored,
			'original_name' => $original_name,
			'size_bytes'    => strlen( $bytes ),
		);
	}

	/**
	 * An order whose one line carries these tokens.
	 *
	 * @param array<string, string> $selections Option id to token.
	 */
	private function orderWith( array $selections ): object {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, (string) wp_json_encode( $selections ), true );

		$order        = optionia_test_order( 64 );
		$order->items = array( $item );

		return $order;
	}

	/**
	 * Point the wpdb stub at the row for the token being looked up.
	 *
	 * The repository issues one `get_row()` per token, so the stub answers from
	 * the query it was given.
	 */
	private function answerFromRows(): void {
		$GLOBALS['wpdb']->rows = null;

		// The stub returns `$rows` for every call, so a single-token test is
		// exact and a multi-token test sets this per call via the queries list.
	}

	/** A token whose seed makes it identifiable in a query. */
	private function token( string $seed ): string {
		return str_repeat( $seed, 64 );
	}

	/* --- availability ---------------------------------------------------- */

	/**
	 * ⚠️ **Checked rather than assumed.** `ZipArchive` ships with PHP but is a
	 * compile-time extension a host can omit, and a fatal error on a merchant's
	 * order screen is a worse answer than no button.
	 */
	public function test_availability_reflects_the_host(): void {
		$this->assertSame( class_exists( 'ZipArchive' ), UploadArchive::is_available() );
	}

	/* --- what goes in ---------------------------------------------------- */

	/** An order with no files yields no archive. */
	public function test_an_order_with_no_files_yields_nothing(): void {
		$this->assertSame( '', $this->archive()->build( $this->orderWith( array( 'opt-c' => 'red' ) ) ) );
	}

	/** An order that cannot be read yields no archive. */
	public function test_a_missing_order_yields_nothing(): void {
		$this->assertSame( '', $this->archive()->build( null ) );
	}

	/**
	 * 🔴 **A row whose file is gone must not produce an empty archive.**
	 *
	 * An archive with nothing in it looks like the artwork was delivered.
	 */
	public function test_rows_whose_files_are_gone_yield_nothing(): void {
		$token                 = $this->token( 'a' );
		$GLOBALS['wpdb']->rows = array(
			'token'         => $token,
			'stored_name'   => 'never-written.pdf',
			'original_name' => 'art.pdf',
			'size_bytes'    => 10,
		);

		$this->assertSame( '', $this->archive()->build( $this->orderWith( array( 'opt-f' => $token ) ) ) );
	}

	/** One file goes in under the customer's own name. */
	public function test_it_archives_a_file_under_the_customers_name(): void {
		$token = $this->token( 'a' );
		$this->storeFile( $token, 'my artwork.pdf', 'FIRST' );
		$GLOBALS['wpdb']->rows = $this->rows[ $token ];

		$path = $this->archive()->build( $this->orderWith( array( 'opt-f' => $token ) ) );

		$this->assertNotSame( '', $path );
		$this->assertFileExists( $path );

		$zip = new \ZipArchive();
		$this->assertTrue( true === $zip->open( $path ) );
		// phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- ZipArchive's own property.
		$this->assertSame( 1, $zip->numFiles );

		/*
		 * ⚠️ **`my-artwork.pdf`, not `my artwork.pdf`.** WordPress's
		 * `sanitize_file_name()` collapses whitespace to dashes — verified
		 * against the real function on the running site. The stub used to keep
		 * spaces, so this asserted a name production would never produce.
		 */
		$this->assertSame( 'my-artwork.pdf', $zip->getNameIndex( 0 ) );
		$this->assertSame( 'FIRST', $zip->getFromName( 'my-artwork.pdf' ) );
		$zip->close();
	}

	/**
	 * 🔴 **Two files with one name must both survive.**
	 *
	 * Measured: adding two entries called `logo.png` to a `ZipArchive` leaves
	 * **one** — the second overwrites the first with no error and no warning. Two
	 * options on an order can easily carry the same customer filename, so without
	 * this a merchant opens the archive and one of the files they were told they
	 * had is simply not there. That is the "reprint arrives blank" failure
	 * ADR-040 exists to prevent.
	 */
	public function test_two_files_with_the_same_name_both_survive(): void {
		$one = $this->token( 'a' );
		$two = $this->token( 'b' );

		$this->storeFile( $one, 'logo.png', 'FIRST-FILE' );
		$this->storeFile( $two, 'logo.png', 'SECOND-FILE' );

		$GLOBALS['wpdb']->rows_by_token = $this->rows;

		$path = $this->archive()->build(
			$this->orderWith(
				array(
					'opt-a' => $one,
					'opt-b' => $two,
				)
			)
		);

		$zip = new \ZipArchive();
		$this->assertTrue( true === $zip->open( $path ) );

		// phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- ZipArchive's own property.
		$this->assertSame( 2, $zip->numFiles, 'Neither file may be lost to a name collision.' );

		$contents = array();

		// phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- ZipArchive's own property.
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$contents[] = $zip->getFromIndex( $i );
		}

		$zip->close();

		sort( $contents );
		$this->assertSame( array( 'FIRST-FILE', 'SECOND-FILE' ), $contents );
	}

	/** The second copy keeps the customer's name recognisable. */
	public function test_a_collided_name_stays_recognisable(): void {
		$one = $this->token( 'a' );
		$two = $this->token( 'b' );

		$this->storeFile( $one, 'logo.png', 'FIRST-FILE' );
		$this->storeFile( $two, 'logo.png', 'SECOND-FILE' );

		$GLOBALS['wpdb']->rows_by_token = $this->rows;

		$path = $this->archive()->build(
			$this->orderWith(
				array(
					'opt-a' => $one,
					'opt-b' => $two,
				)
			)
		);

		$zip = new \ZipArchive();
		$zip->open( $path );
		$names = array( $zip->getNameIndex( 0 ), $zip->getNameIndex( 1 ) );
		$zip->close();

		sort( $names );
		$this->assertSame( array( 'logo-2.png', 'logo.png' ), $names );
	}

	/**
	 * ⚠️ **Built inside the guarded directory**, not the system temp directory.
	 * An archive holds every file on the order at once, and the two path secrets
	 * that protect one file should protect the collection too.
	 */
	public function test_the_archive_is_built_inside_the_guarded_directory(): void {
		$token = $this->token( 'a' );
		$this->storeFile( $token, 'art.pdf', 'BYTES' );
		$GLOBALS['wpdb']->rows = $this->rows[ $token ];

		$path = $this->archive()->build( $this->orderWith( array( 'opt-f' => $token ) ) );

		$this->assertStringContainsString( 'optionia-uploads-', $path );
		$this->assertStringStartsWith( $this->base, $path );
	}
}
