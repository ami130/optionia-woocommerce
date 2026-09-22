<?php
/**
 * Serving a stored file to an authorised merchant.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadArchive;
use Optionia\Upload\UploadDownload;
use Optionia\Upload\UploadImage;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

/**
 * `UploadDownload` and the four things it refuses.
 *
 * ⚠️ **The refusals are what these tests can reach.** A successful download ends
 * in `exit`, which would take the test runner with it, and the suite uses no
 * process isolation. So the success path is asserted up to the point where the
 * bytes would be written — every branch that decides *whether* a merchant sees a
 * customer's file is covered, and only the writing of the body is not.
 *
 * @covers \Optionia\Upload\UploadDownload
 */
final class UploadDownloadTest extends TestCase {

	/**
	 * The uploads root for this test.
	 *
	 * @var string
	 */
	private string $base = '';

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-dl-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);

		$GLOBALS['wpdb']                  = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_can']     = true;

		$_GET = array();
	}

	protected function tearDown(): void {
		unset(
			$GLOBALS['optionia_test_upload_dir'],
			$GLOBALS['wpdb'],
			$GLOBALS['optionia_test_can']
		);

		$_GET = array();

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
	private function token(): string {
		return str_repeat( 'a', 64 );
	}

	private function download(): UploadDownload {
		$logger = new Logger( new Settings() );

		$uploads = new UploadRepository();
		$store   = new UploadStore( $logger );

		return new UploadDownload(
			$uploads,
			$store,
			new UploadArchive( $uploads, $store, $logger ),
			new UploadLink(),
			new UploadImage( $logger ),
			$logger
		);
	}

	/**
	 * Ask for a file, as the admin screen's link does.
	 *
	 * @param string      $token The token requested.
	 * @param string|null $nonce Override the nonce; null sends a valid one.
	 */
	private function request( string $token, ?string $nonce = null ): void {
		$_GET = array(
			Keys::ARG_DOWNLOAD_TOKEN => $token,
			'_wpnonce'               => $nonce ?? ( 'nonce:' . Keys::NONCE_DOWNLOAD ),
		);
	}

	/**
	 * Run the handler and return why it stopped, or '' when it did not.
	 */
	private function refusal(): string {
		try {
			$this->download()->maybe_download();
		} catch ( \Optionia_Test_Halt $halt ) {
			return $halt->getMessage();
		}

		return '';
	}

	/* --- requests that are not ours -------------------------------------- */

	/**
	 * ⚠️ **`admin_init` fires on every admin request.** A handler that acted on
	 * anything but its own query argument would run on every page in wp-admin.
	 */
	public function test_it_ignores_a_request_that_asks_for_nothing(): void {
		$_GET = array();

		$this->assertSame( '', $this->refusal(), 'An unrelated admin request must pass through.' );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'Nothing may reach the database.' );
	}

	/* --- the guards ------------------------------------------------------ */

	/**
	 * 🔴 **Capability before anything else.**
	 *
	 * Checked before the nonce and before the lookup, so a user without the
	 * capability learns nothing about whether the file exists.
	 */
	public function test_it_refuses_a_user_without_the_capability(): void {
		$GLOBALS['optionia_test_can'] = false;

		$this->request( $this->token() );

		$this->assertStringContainsString( 'not allowed', $this->refusal() );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'No lookup may happen for an unauthorised user.' );
	}

	/**
	 * 🔴 **A download is a data-revealing admin GET, so it carries a nonce.**
	 *
	 * The weakness recorded for `NONCE_UPLOAD` is specific to logged-out
	 * visitors, for whom a nonce reduces to action + tick. This request is always
	 * authenticated, so the nonce is tied to the merchant's own session.
	 */
	public function test_it_refuses_a_missing_or_wrong_nonce(): void {
		$this->request( $this->token(), 'not-the-nonce' );

		$this->assertStringContainsString( 'expired', $this->refusal() );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries );
	}

	/**
	 * 🔴 **An emailed signature authorises the archive, never one named file.**
	 *
	 * It is minted over an *order*, so it can only say "this order's files" — the
	 * file argument is not in the signed material and never could be, since the
	 * link is minted before anyone knows which file will be asked for. Without
	 * this, one forwarded link would authorise any token its holder cared to
	 * name.
	 */
	public function test_an_order_signature_cannot_authorise_a_single_file(): void {
		$expires = time() + UploadLink::LIFETIME;

		$_GET = array(
			Keys::ARG_DOWNLOAD_TOKEN     => $this->token(),
			Keys::ARG_DOWNLOAD_SIGNATURE => wp_hash( 'optionia-order-files|64|' . $expires ),
			Keys::ARG_DOWNLOAD_EXPIRES   => $expires,
		);

		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'victim.pdf',
			'size_bytes'    => 10,
		);

		$this->assertStringContainsString( 'expired', $this->refusal() );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'No file may be looked up.' );
	}

	/**
	 * 🔴 **Naming an order alongside the file does not smuggle it through.**
	 *
	 * This is the case the guard actually exists for. With the order present the
	 * signature *verifies*, so `UploadLink`'s own `order_id <= 0` check does not
	 * fire — and only the dispatch order was sending the request to the archive
	 * rather than to the named file. Mutation proved that: removing the guard
	 * left the previous test green, because it was really exercising the layer
	 * below.
	 */
	public function test_a_signature_cannot_smuggle_a_file_alongside_its_order(): void {
		$expires = time() + UploadLink::LIFETIME;

		$_GET = array(
			Keys::ARG_DOWNLOAD_TOKEN     => $this->token(),
			Keys::ARG_DOWNLOAD_ORDER     => 64,
			Keys::ARG_DOWNLOAD_SIGNATURE => wp_hash( 'optionia-order-files|64|' . $expires ),
			Keys::ARG_DOWNLOAD_EXPIRES   => $expires,
		);

		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'e5f1c2.pdf',
			'original_name' => 'victim.pdf',
			'size_bytes'    => 10,
		);

		/*
		 * Refused outright: a signature cannot speak for a request that names a
		 * file, so the combination is rejected before either path is chosen.
		 */
		$this->assertStringContainsString( 'expired', $this->refusal() );
		$this->assertSame(
			array(),
			array_filter(
				$GLOBALS['wpdb']->queries,
				static fn ( string $sql ): bool => false !== strpos( $sql, 'e5f1c2' )
			),
			'The named file may not be reached.'
		);
	}

	/**
	 * 🔴 **A preview needs the merchant's own session, never an emailed link.**
	 *
	 * A preview names one *file*, and a signature is minted over an *order* — so
	 * it cannot speak for this request. The order screen supplies a nonce; an
	 * inbox cannot.
	 */
	public function test_an_emailed_signature_cannot_fetch_a_preview(): void {
		$expires = time() + UploadLink::LIFETIME;

		$_GET = array(
			Keys::ARG_DOWNLOAD_TOKEN     => $this->token(),
			Keys::ARG_DOWNLOAD_PREVIEW   => 1,
			Keys::ARG_DOWNLOAD_SIGNATURE => wp_hash( 'optionia-order-files|64|' . $expires ),
			Keys::ARG_DOWNLOAD_EXPIRES   => $expires,
		);

		$this->assertStringContainsString( 'expired', $this->refusal() );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'No file may be looked up.' );
	}

	/**
	 * ⚠️ **A value that is not token-shaped never reaches the table.**
	 *
	 * @dataProvider malformed
	 *
	 * @param string $token The value offered.
	 */
	public function test_it_refuses_a_token_that_is_not_one( string $token ): void {
		$this->request( $token );

		$this->assertStringContainsString( 'could not be found', $this->refusal() );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries );
	}

	/**
	 * Values a token cannot be.
	 *
	 * @return array<string, array{0: string}>
	 */
	public static function malformed(): array {
		return array(
			'empty'     => array( '' ),
			'too short' => array( str_repeat( 'a', 63 ) ),
			'too long'  => array( str_repeat( 'a', 65 ) ),
			'not hex'   => array( str_repeat( 'z', 64 ) ),
			'a path'    => array( '../../../wp-config.php' ),
			'uppercase' => array( str_repeat( 'A', 64 ) ),
		);
	}

	/** A token naming no row is refused, and says so plainly. */
	public function test_it_refuses_a_token_with_no_row(): void {
		$GLOBALS['wpdb']->rows = null;

		$this->request( $this->token() );

		$this->assertStringContainsString( 'could not be found', $this->refusal() );
	}

	/**
	 * 🔴 **An unreadable file is refused before a single header is written.**
	 *
	 * This used to fail *after* the headers, so the client received
	 * `Content-Type: application/octet-stream`, a `Content-Length`, and then a
	 * `wp_die()` HTML page as the body — a "download" that saved an error page
	 * under the customer's own filename. Once a header is out there is no way
	 * back, so the last thing that can fail has to happen first.
	 */
	public function test_an_unreadable_file_is_refused_before_any_header(): void {
		$logger    = new Logger( new Settings() );
		$directory = ( new UploadStore( $logger ) )->directory();
		$path      = $directory . '/locked.pdf';

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $path, '%PDF-1.7' );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_chmod -- making a file unreadable is the condition under test.
		chmod( $path, 0000 );

		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'locked.pdf',
			'original_name' => 'art.pdf',
			'size_bytes'    => 8,
		);

		$this->request( $this->token() );
		$refusal = $this->refusal();

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_chmod -- restored so teardown can remove it.
		chmod( $path, 0644 );

		$this->assertStringContainsString( 'could not be read', $refusal );
		$this->assertSame(
			array(),
			array_filter( headers_list(), static fn ( string $h ): bool => false !== stripos( $h, 'Content-Disposition' ) ),
			'No download header may be sent for a file that cannot be opened.'
		);
	}

	/**
	 * 🔴 **A row can outlive its file**, when expiry or a sweep runs between the
	 * order screen rendering and the merchant clicking. Said plainly, because
	 * the artwork is gone and that is what the merchant needs to know.
	 */
	public function test_it_reports_a_row_whose_file_has_gone(): void {
		$GLOBALS['wpdb']->rows = array(
			'token'         => $this->token(),
			'stored_name'   => 'missing.pdf',
			'original_name' => 'art.pdf',
			'size_bytes'    => 10,
		);

		$this->request( $this->token() );

		$this->assertStringContainsString( 'no longer stored', $this->refusal() );
	}
}
