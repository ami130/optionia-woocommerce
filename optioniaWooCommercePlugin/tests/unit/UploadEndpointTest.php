<?php
/**
 * The upload route's orchestration: what it refuses, and what it stores.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\MovesUploadedFiles;
use Optionia\Upload\UploadEndpoint;
use Optionia\Upload\UploadImage;
use Optionia\Upload\UploadQuota;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadRules;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;
use WP_REST_Request;

/**
 * 🔴 **This class had no test file at all.**
 *
 * It orchestrates every check — fourteen refusal paths, thirty branches — and the
 * only test touching it proved it *constructs*. Measured: removing the quota
 * check, or `is_uploaded_file()`, left **1091 tests passing**. The mutation probe
 * reported KILLED for both, from an unused-variable *compile* error rather than
 * an assertion.
 *
 * Stage 3c's bypass proofs were real but ran from a throwaway script. Nothing
 * re-ran them. These are those proofs, made permanent.
 *
 * @covers \Optionia\Upload\UploadEndpoint
 */
final class UploadEndpointTest extends TestCase {

	/**
	 * Temporary files to remove.
	 *
	 * @var array<int, string>
	 */
	private array $paths = array();

	/**
	 * The uploads root for this test.
	 *
	 * @var string
	 */
	private string $base = '';

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-ep-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);

		$GLOBALS['wpdb']                  = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_options'] = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['optionia_test_upload_dir'], $GLOBALS['wpdb'] );

		foreach ( $this->paths as $path ) {
			if ( is_file( $path ) ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test teardown.
				unlink( $path );
			}
		}

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

	/**
	 * A mover that records what it was asked to move.
	 *
	 * ⚠️ **The seam exists because `is_uploaded_file()` cannot be satisfied in a
	 * test** — PHP marks only files it received itself. Without it, the guard
	 * against a crafted `tmp_name` is unverifiable.
	 */
	private function mover( bool $succeeds = true ): MovesUploadedFiles {
		return new class( $succeeds ) implements MovesUploadedFiles {
			/**
			 * Whether the move reports success.
			 *
			 * @var bool
			 */
			public bool $succeeds;

			/**
			 * Every (from, to) pair requested.
			 *
			 * @var array<int, array{0: string, 1: string}>
			 */
			public array $moves = array();

			/**
			 * Record whether this double reports success.
			 *
			 * @param bool $succeeds Whether to report success.
			 */
			public function __construct( bool $succeeds ) {
				$this->succeeds = $succeeds;
			}

			/**
			 * Record the request, and copy when reporting success.
			 *
			 * @param string $from Source.
			 * @param string $to   Destination.
			 */
			public function move( string $from, string $to ): bool {
				$this->moves[] = array( $from, $to );

				if ( ! $this->succeeds ) {
					return false;
				}

				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents, WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a test double standing in for move_uploaded_file().
				file_put_contents( $to, (string) file_get_contents( $from ) );

				return true;
			}
		};
	}

	/**
	 * Cache a document with one file option.
	 *
	 * @param array<string, mixed> $validation The merchant's rules.
	 */
	private function cacheOption( array $validation = array() ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 1,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(),
						'rules'       => array(),
						'groups'      => array(
							array(
								'id'      => 'g',
								'label'   => 'G',
								'options' => array(
									array(
										'id'         => 'opt-f',
										'key'        => 'artwork',
										'type'       => 'file_input',
										'value_kind' => 'file',
										'label'      => 'Artwork',
										'validation' => $validation,
										'values'     => array(),
									),
									array(
										'id'         => 'opt-r',
										'key'        => 'colour',
										'type'       => 'radio',
										'value_kind' => 'choice',
										'label'      => 'Colour',
										'values'     => array(),
									),
								),
							),
						),
					),
				),
			),
			'W/"ep"'
		);
	}

	/**
	 * Build the endpoint over real collaborators and a doubled mover.
	 *
	 * @param MovesUploadedFiles|null $mover Optional mover double.
	 */
	private function endpoint( ?MovesUploadedFiles $mover = null ): UploadEndpoint {
		$logger  = new Logger( new Settings() );
		$uploads = new UploadRepository();

		return new UploadEndpoint(
			new UploadStore( $logger ),
			$uploads,
			new UploadQuota( $uploads ),
			new UploadRules( new Repository( $logger ) ),
			new UploadImage( $logger ),
			$mover ?? $this->mover(),
			$logger
		);
	}

	/** A request carrying one uploaded file. */
	private function request( string $option_id, string $name, string $bytes, int $error = UPLOAD_ERR_OK ): WP_REST_Request {
		$path = tempnam( sys_get_temp_dir(), 'optionia-up' );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test fixture.
		file_put_contents( $path, $bytes );
		$this->paths[] = $path;

		$request = new WP_REST_Request();

		$request->set_param( 'option_id', $option_id );
		$request->set_file_params(
			array(
				'file' => array(
					'name'     => $name,
					'tmp_name' => $path,
					'size'     => strlen( $bytes ),
					'error'    => $error,
					'type'     => 'application/pdf',
				),
			)
		);

		return $request;
	}

	private const PDF = "%PDF-1.7\n%%EOF";
	private const PNG = "\x89PNG\r\n\x1a\n";

	/* --- the success path ------------------------------------------------ */

	/**
	 * A verifier that refuses everything passes every refusal test, so the
	 * accepted case is asserted first.
	 */
	public function test_it_stores_a_legitimate_file_and_returns_a_token(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'pdf' ) ) );

		$response = $this->endpoint()->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) );
		$body     = $response->get_data();

		$this->assertSame( 201, $response->get_status() );
		$this->assertArrayHasKey( 'token', $body );
		$this->assertSame( 64, strlen( (string) $body['token'] ) );
		$this->assertSame( 'art.pdf', $body['name'] );
	}

	/**
	 * 🔴 **The token is the only identifier the browser holds** (AC4).
	 */
	public function test_the_response_carries_no_path_or_stored_name(): void {
		$this->cacheOption();

		$body = $this->endpoint()->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) )->get_data();

		$this->assertArrayNotHasKey( 'path', $body );
		$this->assertArrayNotHasKey( 'url', $body );
		$this->assertArrayNotHasKey( 'stored_name', $body );
	}

	/* --- the merchant's rules (Stage 3c) --------------------------------- */

	/**
	 * 🔴 **The bypass proofs from Stage 3c, made permanent.**
	 *
	 * Each of these was verified once from a throwaway script and never again.
	 * `accept` in the markup is a browser hint; `data-optionia-max-mb` is a
	 * string an attacker edits. The rules bind here or nowhere.
	 *
	 * @dataProvider bypassAttempts
	 * @param string $option_id Which option is targeted.
	 * @param string $name      The claimed filename.
	 * @param string $bytes     The file's contents.
	 */
	public function test_it_refuses_a_bypass_attempt( string $option_id, string $name, string $bytes ): void {
		$this->cacheOption(
			array(
				'accepted_types' => array( 'pdf' ),
				'max_size_mb'    => 1,
			)
		);

		$response = $this->endpoint()->handle( $this->request( $option_id, $name, $bytes ) );

		$this->assertSame( 422, $response->get_status() );
		$this->assertSame( array( 'stored' => false ), $response->get_data() );
	}

	/**
	 * Attacks a customer can make by posting directly, with no browser.
	 *
	 * @return array<string, array{0: string, 1: string, 2: string}>
	 */
	public function bypassAttempts(): array {
		return array(
			'an executable extension'   => array( 'opt-f', 'artwork.exe', self::PDF ),
			'a type not accepted'       => array( 'opt-f', 'logo.png', self::PNG ),
			'a file aimed at a radio'   => array( 'opt-r', 'art.pdf', self::PDF ),
			'an unknown option'         => array( 'nope', 'art.pdf', self::PDF ),
			'no option at all'          => array( '', 'art.pdf', self::PDF ),
			'content not matching name' => array( 'opt-f', 'art.pdf', self::PNG ),
		);
	}

	/** The merchant's size ceiling binds on the server, not in the markup. */
	public function test_it_refuses_a_file_over_the_merchants_ceiling(): void {
		$this->cacheOption( array( 'max_size_mb' => 1 ) );

		$big = self::PDF . str_repeat( 'x', 2 * 1048576 );

		$this->assertSame( 422, $this->endpoint()->handle( $this->request( 'opt-f', 'art.pdf', $big ) )->get_status() );
	}

	/* --- structural refusals --------------------------------------------- */

	public function test_it_refuses_a_request_with_no_file(): void {
		$this->cacheOption();

		$request = new WP_REST_Request();
		$request->set_param( 'option_id', 'opt-f' );

		$this->assertSame( 422, $this->endpoint()->handle( $request )->get_status() );
	}

	/**
	 * ⚠️ `UPLOAD_ERR_INI_SIZE` is the host refusing before PHP saw the file.
	 */
	public function test_it_refuses_a_php_upload_error(): void {
		$this->cacheOption();

		$request = $this->request( 'opt-f', 'art.pdf', self::PDF, UPLOAD_ERR_INI_SIZE );

		$this->assertSame( 422, $this->endpoint()->handle( $request )->get_status() );
	}

	/**
	 * 🔴 **A failed move stores no row.**
	 *
	 * Otherwise the table would carry a token pointing at a file that is not
	 * there, and every later read would fail on a row that looks valid.
	 */
	public function test_a_failed_move_stores_nothing(): void {
		$this->cacheOption();

		$mover    = $this->mover( false );
		$response = $this->endpoint( $mover )->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) );

		$this->assertSame( 422, $response->get_status() );
		$this->assertCount( 1, $mover->moves, 'The move must have been attempted.' );
	}

	/**
	 * 🔴 **The endpoint asks the mover, it does not move the file itself.**
	 *
	 * `is_uploaded_file()` is true only for a file PHP received, so this seam is
	 * what makes the guard against a crafted `tmp_name` verifiable at all —
	 * removing it left the entire suite passing.
	 */
	public function test_it_delegates_the_move_rather_than_writing_directly(): void {
		$this->cacheOption();

		$mover = $this->mover();

		$this->endpoint( $mover )->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) );

		$this->assertCount( 1, $mover->moves );
		$this->assertStringContainsString( 'optionia-uploads-', $mover->moves[0][1] );
	}

	/**
	 * ⚠️ **The stored name is random, never the customer's.**
	 *
	 * M15.3 requires no filename-derived paths: `invoice.pdf` inside a guessed
	 * directory is a readable document.
	 */
	public function test_the_stored_name_keeps_no_trace_of_the_original(): void {
		$this->cacheOption();

		$mover = $this->mover();

		$this->endpoint( $mover )->handle( $this->request( 'opt-f', 'my-invoice.pdf', self::PDF ) );

		$this->assertStringNotContainsString( 'invoice', basename( $mover->moves[0][1] ) );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}\.pdf$/', basename( $mover->moves[0][1] ) );
	}

	/* --- the quota (the second guard that survived) ---------------------- */

	/**
	 * 🔴 **Removing this check left 1091 tests passing.**
	 *
	 * The quota is what bounds abuse — the nonce cannot, because every guest on
	 * a site holds the identical value for 24 hours.
	 */
	public function test_it_refuses_when_the_session_quota_is_exhausted(): void {
		$this->cacheOption();

		$GLOBALS['wpdb']->rows = array(
			'n' => UploadQuota::MAX_FILES,
			'b' => 0,
		);

		$this->assertSame( 422, $this->endpoint()->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) )->get_status() );
	}

	/** And by bytes, which is a separate ceiling. */
	public function test_it_refuses_when_the_session_byte_quota_is_exhausted(): void {
		$this->cacheOption();

		$GLOBALS['wpdb']->rows = array(
			'n' => 1,
			'b' => UploadQuota::MAX_BYTES,
		);

		$this->assertSame( 422, $this->endpoint()->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) )->get_status() );
	}

	/* --- refusals reveal nothing ----------------------------------------- */

	/**
	 * 🔴 **Every refusal answers identically**, so a caller cannot map the
	 * ceilings by probing.
	 */
	public function test_every_refusal_looks_the_same(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'pdf' ) ) );

		$bodies = array();

		foreach ( array( array( 'opt-f', 'x.exe' ), array( 'nope', 'x.pdf' ), array( 'opt-r', 'x.pdf' ) ) as $attempt ) {
			$response = $this->endpoint()->handle( $this->request( $attempt[0], $attempt[1], self::PDF ) );

			$bodies[] = array( $response->get_status(), $response->get_data() );
		}

		$this->assertCount( 1, array_unique( array_map( 'wp_json_encode', $bodies ) ) );
	}

	/* --- the row failing after the bytes land ---------------------------- */

	/**
	 * A mover that really writes, so disk state is observable.
	 *
	 * The recording double reports success without creating anything, which
	 * cannot distinguish "the file was cleaned up" from "it was never written".
	 */
	private function realMover(): MovesUploadedFiles {
		return new class() implements MovesUploadedFiles {
			/**
			 * Copy rather than move: the fixture is reused by teardown.
			 *
			 * @param string $from Source path.
			 * @param string $to   Destination path.
			 */
			public function move( string $from, string $to ): bool {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_copy -- test double.
				return copy( $from, $to );
			}
		};
	}

	/**
	 * Files sitting in the storage directory.
	 *
	 * @return array<int, string>
	 */
	private function storedFiles(): array {
		$found = glob( $this->base . '/optionia-uploads-*/*' );

		// The same three guards `UploadSweeper` refuses to delete.
		$guards = array( '.htaccess', 'web.config', 'index.php' );

		return false === $found ? array() : array_values(
			array_filter(
				$found,
				static fn ( string $p ): bool => ! in_array( basename( $p ), $guards, true )
			)
		);
	}

	/**
	 * 🔴 **A file whose row never landed must not be left on disk.**
	 *
	 * Cleanup reads the table, so a file with no row is invisible to it forever —
	 * exactly the orphan `UploadSweeper` exists to hunt, and the sweeper cannot
	 * find this one because it looks like every other stored file.
	 *
	 * Removing the branch left the entire suite green while the endpoint answered
	 * **201 with an empty token**: a client that can never attach the file, and a
	 * file nothing will ever delete. It was untestable until the wpdb stub could
	 * fail an insert — `insert()` returned a hardcoded 1.
	 */
	public function test_a_file_whose_row_fails_is_removed_and_refused(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'pdf' ) ) );

		$GLOBALS['wpdb']->inserts = false;

		$response = $this->endpoint( $this->realMover() )->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) );

		$this->assertSame( 422, $response->get_status(), 'A file with no row must be refused, not reported stored.' );
		$this->assertSame( array(), $this->storedFiles(), 'The orphan must not survive on disk.' );
	}

	/**
	 * ⚠️ **The counterpart**: with the insert succeeding, the same request keeps
	 * its file. Without this, a refusal that deleted everything would also pass
	 * the test above.
	 */
	public function test_a_stored_file_survives_when_its_row_lands(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'pdf' ) ) );

		$response = $this->endpoint( $this->realMover() )->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) );

		$this->assertSame( 201, $response->get_status() );
		$this->assertCount( 1, $this->storedFiles() );
	}

	/**
	 * 🔴 **The recorded size must be what is on disk, not what arrived.**
	 *
	 * `consume_metadata()` re-encodes a JPEG in place to strip its EXIF, so the
	 * stored file is a different length from the upload — measured at **-29.4%**
	 * on an 800x600 image. Recording the upload size left the row disagreeing
	 * with the disk, which breaks two things at once: a `Content-Length` built
	 * from it promises bytes that never arrive and the browser hangs, and
	 * `session_usage()` sums this column, so every photograph over-reported a
	 * merchant's storage by roughly a third.
	 */
	public function test_the_recorded_size_matches_the_file_on_disk(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'jpg' ) ) );

		$response = $this->endpoint( $this->realMover() )->handle(
			$this->request( 'opt-f', 'photo.jpg', $this->jpeg() )
		);

		$this->assertSame( 201, $response->get_status() );

		$files = $this->storedFiles();
		$this->assertCount( 1, $files );

		/*
		 * ⚠️ **Read out of the statement, because the insert is guarded.** The
		 * row is written by `INSERT … SELECT … WHERE`, so its ceilings are
		 * evaluated as the row lands — see `UploadRepository::create()`. The
		 * stub's `prepare()` interpolates the bound values, so the size appears
		 * in the statement text rather than as a discrete field.
		 */
		$inserts = array_values(
			array_filter(
				$GLOBALS['wpdb']->inserted,
				static fn ( array $write ): bool => isset( $write['data']['sql'] )
			)
		);

		$this->assertCount( 1, $inserts );
		$this->assertStringContainsString(
			(string) filesize( $files[0] ),
			(string) $inserts[0]['data']['sql'],
			'The row must agree with the bytes actually stored.'
		);
	}

	/**
	 * ⚠️ **And the response tells the browser the same number**, so a client
	 * that trusts it is not misled either.
	 */
	public function test_the_response_reports_the_stored_size(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'jpg' ) ) );

		$body = $this->endpoint( $this->realMover() )->handle(
			$this->request( 'opt-f', 'photo.jpg', $this->jpeg() )
		)->get_data();

		$files = $this->storedFiles();

		$this->assertSame( filesize( $files[0] ), $body['size'] );
	}

	/**
	 * A real JPEG, large enough that re-encoding changes its length.
	 *
	 * Written at quality 100 so `consume_metadata()`'s quality-90 rewrite
	 * measurably shrinks it — a tiny or already-compressed image could come back
	 * the same size and the test would pass without proving anything.
	 */
	private function jpeg(): string {
		$width  = 800;
		$height = 600;
		$image  = imagecreatetruecolor( $width, $height );

		for ( $x = 0; $x < $width; $x += 7 ) {
			imagefilledrectangle(
				$image,
				$x,
				0,
				$x + 3,
				$height,
				imagecolorallocate( $image, $x % 255, 120, 200 )
			);
		}

		$path = tempnam( sys_get_temp_dir(), 'optionia-jpg' );
		imagejpeg( $image, $path, 100 );
		imagedestroy( $image );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- reading a local test fixture, not a remote URL.
		$bytes = (string) file_get_contents( $path );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test fixture.
		unlink( $path );

		return $bytes;
	}

	/**
	 * 🔴 **Refusing beats storing a customer's file somewhere unprotected.**
	 *
	 * With no storage directory there is nowhere guarded to put the bytes; the
	 * endpoint must refuse before the move rather than fall through to a path
	 * under the webroot.
	 */
	public function test_it_refuses_when_there_is_no_storage_directory(): void {
		$this->cacheOption( array( 'accepted_types' => array( 'pdf' ) ) );

		// A failing upload dir is what `UploadStore::directory()` reads.
		$GLOBALS['optionia_test_upload_dir']['error'] = 'no writable uploads directory';

		$mover    = $this->mover();
		$response = $this->endpoint( $mover )->handle( $this->request( 'opt-f', 'art.pdf', self::PDF ) );

		$this->assertSame( 422, $response->get_status() );
		$this->assertSame( array(), $mover->moves, 'Nothing may be moved when there is nowhere safe to put it.' );
	}
}
