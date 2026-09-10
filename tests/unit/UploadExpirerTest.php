<?php
/**
 * Releasing the files of abandoned carts, and refusing to release anything else.
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
use PHPUnit\Framework\TestCase;

/**
 * `UploadExpirer` deleting expired, unclaimed uploads.
 *
 * 🔴 **`expired()` had no callers and no way to be tested** — the wpdb stub had
 * no `get_results()`, so the one method standing between an abandoned cart and a
 * permanent disk leak could not be exercised at all.
 *
 * @covers \Optionia\Upload\UploadExpirer
 */
final class UploadExpirerTest extends TestCase {

	/**
	 * The uploads root for this test.
	 *
	 * @var string
	 */
	private string $base = '';

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-exp-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);

		$GLOBALS['wpdb']                  = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_log']     = array();
	}

	protected function tearDown(): void {
		unset(
			$GLOBALS['optionia_test_upload_dir'],
			$GLOBALS['wpdb'],
			$GLOBALS['optionia_test_log']
		);

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

	/** A well-formed upload token. */
	private function token( string $seed = 'a' ): string {
		return str_repeat( $seed, 64 );
	}

	private function expirer(): UploadExpirer {
		$logger = new Logger( new Settings() );

		return new UploadExpirer( new UploadRepository(), new UploadStore( $logger ), $logger );
	}

	/**
	 * Put a real file in the store and return its name.
	 *
	 * @param string $name Stored name.
	 */
	private function storedFile( string $name ): string {
		$logger    = new Logger( new Settings() );
		$directory = ( new UploadStore( $logger ) )->directory();

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $directory . '/' . $name, 'bytes' );

		return $directory . '/' . $name;
	}

	/**
	 * Messages logged at one level.
	 *
	 * @param string $level The level to filter to.
	 * @return array<int, string>
	 */
	private function logged( string $level ): array {
		return array_values(
			array_map(
				static fn ( array $entry ): string => (string) $entry['message'],
				array_filter(
					$GLOBALS['optionia_test_log'] ?? array(),
					static fn ( array $entry ): bool => $level === $entry['level']
				)
			)
		);
	}

	/* --- the release itself ---------------------------------------------- */

	/**
	 * 🔴 **The gap this class closes.** Without it an abandoned cart's file sat
	 * on the merchant's disk forever: the sweeper skips it because it has a row,
	 * and nothing else read `expires_at` at all.
	 */
	public function test_it_deletes_the_file_and_then_the_row(): void {
		$path = $this->storedFile( 'gone.pdf' );

		$GLOBALS['wpdb']->results = array(
			array(
				'token'       => $this->token(),
				'stored_name' => 'gone.pdf',
			),
		);
		$GLOBALS['wpdb']->var     = null;

		$released = $this->expirer()->expire();

		$this->assertSame( 1, $released );
		$this->assertFileDoesNotExist( $path, 'The file must go.' );
		$this->assertCount( 1, $GLOBALS['wpdb']->deletes, 'The row must go too.' );
		$this->assertSame(
			array( 'token' => $this->token() ),
			$GLOBALS['wpdb']->deletes[0]['where']
		);
	}

	/**
	 * 🔴 **A file a real order refers to is never deleted.**
	 *
	 * `claim()` can fail — the database can refuse the statement — leaving a paid
	 * order's row looking abandoned. `OrderLineItem` writes the token into
	 * `_optionia_selections` at priority 10, inside WooCommerce's transaction and
	 * before any claim is attempted, so the order is the record that survives
	 * that failure. Deleting on the row's word alone would destroy artwork
	 * somebody paid for.
	 */
	public function test_a_file_an_order_refers_to_is_kept(): void {
		$path = $this->storedFile( 'paid.pdf' );

		$GLOBALS['wpdb']->results = array(
			array(
				'token'       => $this->token(),
				'stored_name' => 'paid.pdf',
			),
		);
		// An order's item meta matches the token.
		$GLOBALS['wpdb']->var = 7;

		$released = $this->expirer()->expire();

		$this->assertSame( 0, $released );
		$this->assertFileExists( $path, 'A paid order keeps its artwork.' );
		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/**
	 * 🔴 **A referenced row is claimed, not merely skipped.**
	 *
	 * Skipping leaves `expires_at` in the past forever, and `expired()` orders
	 * by that column ascending — so the row returns at the *front* of every
	 * hourly batch. Enough of them fill `BATCH` permanently and the genuinely
	 * abandoned files behind them are never reached, silently disabling the
	 * cleanup this class exists to perform.
	 */
	public function test_a_referenced_row_is_claimed_to_its_order(): void {
		$this->storedFile( 'paid.pdf' );

		$GLOBALS['wpdb']->results  = array(
			array(
				'token'       => $this->token(),
				'stored_name' => 'paid.pdf',
			),
		);
		$GLOBALS['wpdb']->var      = 7;
		$GLOBALS['wpdb']->affected = 1;

		$this->expirer()->expire();

		$claims = array_filter(
			$GLOBALS['wpdb']->queries,
			static fn ( string $sql ): bool => false !== stripos( $sql, 'UPDATE' )
		);

		$this->assertNotSame( array(), $claims, 'The row must be claimed, so it stops returning.' );
		$this->assertStringContainsString( 'order_id IS NULL', implode( ' ', $claims ) );
	}

	/**
	 * ⚠️ **A failed repair still keeps the file.**
	 *
	 * The row belongs to an order either way, and deleting it is the one
	 * outcome that cannot be undone.
	 */
	public function test_a_referenced_row_whose_repair_fails_is_still_kept(): void {
		$path = $this->storedFile( 'paid.pdf' );

		$GLOBALS['wpdb']->results  = array(
			array(
				'token'       => $this->token(),
				'stored_name' => 'paid.pdf',
			),
		);
		$GLOBALS['wpdb']->var      = 7;
		$GLOBALS['wpdb']->affected = false;

		$this->assertSame( 0, $this->expirer()->expire() );
		$this->assertFileExists( $path );
		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/** Keeping such a file is an error, because promotion should have happened. */
	public function test_keeping_a_referenced_file_is_reported(): void {
		$this->storedFile( 'paid.pdf' );

		$GLOBALS['wpdb']->results = array(
			array(
				'token'       => $this->token(),
				'stored_name' => 'paid.pdf',
			),
		);
		$GLOBALS['wpdb']->var     = 7;

		$this->expirer()->expire();

		$this->assertNotSame( array(), $this->logged( 'error' ) );
	}

	/** Nothing expired means nothing done, and no directory work. */
	public function test_it_does_nothing_when_no_row_has_expired(): void {
		$GLOBALS['wpdb']->results = array();

		$this->assertSame( 0, $this->expirer()->expire() );
		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/**
	 * ⚠️ **A row whose file is already gone must still lose its row.**
	 *
	 * Otherwise the same row comes back on every pass forever, and the log fills
	 * with a failure nobody can act on.
	 */
	public function test_a_row_whose_file_is_missing_is_still_removed(): void {
		$GLOBALS['wpdb']->results = array(
			array(
				'token'       => $this->token(),
				'stored_name' => 'never-written.pdf',
			),
		);
		$GLOBALS['wpdb']->var     = null;

		$this->assertSame( 1, $this->expirer()->expire() );
		$this->assertCount( 1, $GLOBALS['wpdb']->deletes );
	}

	/**
	 * A row missing the fields this needs is left untouched.
	 *
	 * @dataProvider malformed
	 *
	 * @param array<string, mixed> $row A row that cannot be acted on.
	 */
	public function test_a_malformed_row_is_left_alone( array $row ): void {
		$GLOBALS['wpdb']->results = array( $row );
		$GLOBALS['wpdb']->var     = null;

		$this->assertSame( 0, $this->expirer()->expire() );
		$this->assertSame( array(), $GLOBALS['wpdb']->deletes );
	}

	/**
	 * ⚠️ Without a stored name there is no file to delete, and deleting the row
	 * would strand whatever file it named.
	 *
	 * @return array<string, array{0: array<string, mixed>}>
	 */
	public static function malformed(): array {
		return array(
			'no token'       => array( array( 'stored_name' => 'x.pdf' ) ),
			'no stored name' => array( array( 'token' => str_repeat( 'a', 64 ) ) ),
			'empty token'    => array(
				array(
					'token'       => '',
					'stored_name' => 'x.pdf',
				),
			),
		);
	}
}
