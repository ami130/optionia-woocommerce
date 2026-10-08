<?php
/**
 * Pulling a finished print file onto the merchant's own site (M26e.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Design\RenderCollector;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

/**
 * `Design\RenderCollector` stores what the cloud rendered, and only that.
 *
 * @covers \Optionia\Design\RenderCollector
 */
final class RenderCollectorTest extends TestCase {

	/** A minimal but genuine PNG header. */
	private const PNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";

	protected function setUp(): void {
		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_orders']     = array();
		$GLOBALS['optionia_test_doing_cron'] = true;
		$GLOBALS['optionia_test_http']       = array(
			'status' => 200,
			'body'   => self::PNG,
		);

		update_option( Keys::OPTION_CONNECTION_STATE, 'connected', false );
		update_option( Keys::OPTION_STORE_TOKEN, 'tok_live_abc', false );
	}

	protected function tearDown(): void {
		$found = glob( sys_get_temp_dir() . '/optionia-test-uploads/*' );

		foreach ( is_array( $found ) ? $found : array() as $file ) {
			if ( is_file( $file ) ) {
				wp_delete_file( $file );
			}
		}
	}

	private function collector(): RenderCollector {
		$settings = new Settings();
		$logger   = new Logger( $settings );

		return new RenderCollector(
			new Client( $settings, $logger, new CircuitBreaker( $logger ), new ResponseValidator() ),
			new UploadStore( $logger ),
			new UploadLink( $settings, $logger ),
			$logger
		);
	}

	/**
	 * An order whose line has been rendered but not collected.
	 *
	 * @param int $id Order id.
	 */
	private function renderedOrder( int $id ): object {
		$order = optionia_test_order( $id );
		$order->update_meta_data( Keys::META_RENDER_IDS, (string) wp_json_encode( array( 11 => 'render-1' ) ) );

		$GLOBALS['optionia_test_orders'][ $id ] = $order;

		return $order;
	}

	/** The filenames recorded on an order. */
	private function storedFiles( object $order ): array {
		$raw = json_decode( (string) $order->get_meta( Keys::META_RENDER_FILES ), true );

		return is_array( $raw ) ? $raw : array();
	}

	public function test_it_stores_a_rendered_file(): void {
		$order = $this->renderedOrder( 70 );

		$this->assertSame( 1, $this->collector()->drain() );

		$files = $this->storedFiles( $order );

		$this->assertArrayHasKey( 11, $files );
		$this->assertStringEndsWith( '.png', (string) $files[11] );
	}

	/**
	 * 🔴 **The bytes land in the guarded directory**, where `UploadStore` puts
	 * a customer's uploads — because a print file is a customer's artwork and a
	 * probe showed `wp-content/uploads/` answers 200 to anyone with the path.
	 */
	public function test_the_bytes_reach_the_guarded_directory(): void {
		$order = $this->renderedOrder( 71 );

		$this->collector()->drain();

		$name      = (string) ( $this->storedFiles( $order )[11] ?? '' );
		$directory = ( new UploadStore( new Logger( new Settings() ) ) )->directory();

		$this->assertNotSame( '', $name );
		$this->assertFileExists( $directory . '/' . $name );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- reading a local file this test just wrote.
		$written = (string) file_get_contents( $directory . '/' . $name );

		$this->assertSame( self::PNG, $written );
	}

	/**
	 * 📌 **A 404 is "not ready yet", not a failure.** The cloud answers it until
	 * the worker has rasterised, and the next pass asks again.
	 */
	public function test_a_job_not_yet_rendered_stores_nothing(): void {
		$order = $this->renderedOrder( 72 );

		$GLOBALS['optionia_test_http'] = array(
			'status' => 404,
			'body'   => '{"error":{"code":"NOT_FOUND"}}',
		);

		$this->assertSame( 0, $this->collector()->drain() );
		$this->assertSame( array(), $this->storedFiles( $order ) );

		/*
		 * 🔴 **And the batch CONTINUES to the next order.** Treating a 404 as a
		 * hard failure would stop on the first job that has simply not rendered
		 * yet, so one slow render would block every other order's collection.
		 *
		 * ⚠️ **Asserted on the requests MADE, not on what was stored.** Two
		 * earlier versions of this assertion passed with the mutant in place:
		 * counting stored files cannot distinguish "stopped early" from
		 * "nothing was ready", and the stub answers every URL identically so a
		 * second 200 order proves nothing either. The call log does.
		 */
		$second = optionia_test_order( 78 );
		$second->update_meta_data( Keys::META_RENDER_IDS, (string) wp_json_encode( array( 11 => 'render-2' ) ) );
		$GLOBALS['optionia_test_orders'][78] = $second;

		$GLOBALS['optionia_test_http_calls']  = array();
		$GLOBALS['optionia_test_http_by_url'] = array();

		$this->collector()->drain();

		$asked = array();

		foreach ( $GLOBALS['optionia_test_http_calls'] as $call ) {
			$asked[] = (string) ( $call['url'] ?? '' );
		}

		$joined = implode( ' ', $asked );

		$this->assertStringContainsString( 'render-1', $joined );
		$this->assertStringContainsString( 'render-2', $joined );
	}

	/**
	 * 🔴 **A truncated print file still looks like a file and prints as
	 * damage** — worse than a missing one, because nobody investigates a file
	 * that exists. `Content-Length` is compared before anything is written.
	 */
	public function test_a_short_download_is_discarded(): void {
		$order = $this->renderedOrder( 73 );

		$GLOBALS['optionia_test_http'] = array(
			'status'  => 200,
			'body'    => self::PNG,
			'headers' => array( 'content-length' => (string) ( strlen( self::PNG ) + 500 ) ),
		);

		$this->assertSame( 0, $this->collector()->drain() );
		$this->assertSame( array(), $this->storedFiles( $order ) );
	}

	/**
	 * ⚠️ **A body that is not a PNG means something else answered** — a proxy
	 * error page, a login wall. Writing it would leave a `.png` no print shop
	 * can open, and then tell the cloud to release bytes never received.
	 */
	public function test_a_body_that_is_not_a_png_is_discarded(): void {
		$order = $this->renderedOrder( 74 );

		$GLOBALS['optionia_test_http'] = array(
			'status' => 200,
			'body'   => '<html>login</html>',
		);

		$this->assertSame( 0, $this->collector()->drain() );
		$this->assertSame( array(), $this->storedFiles( $order ) );
	}

	/** A disconnected store collects nothing: every request would be a 401. */
	public function test_a_disconnected_store_collects_nothing(): void {
		$this->renderedOrder( 75 );

		update_option( Keys::OPTION_CONNECTION_STATE, 'disconnected', false );
		delete_option( Keys::OPTION_STORE_TOKEN );

		$this->assertSame( 0, $this->collector()->drain() );
	}

	/**
	 * ⚠️ **An already-collected line is not fetched again.** The cloud has
	 * released its buffer and would answer 404 for ever; re-fetching would also
	 * write a second copy of the same artwork.
	 */
	/**
	 * ⚠️ **A SECOND line on an order that has already collected its first.**
	 *
	 * 🔴 **The obvious version of this test proved nothing.** An order with
	 * both meta keys set is filtered out by `pending_orders()` before the
	 * per-line guard is ever reached, so removing that guard left every
	 * assertion passing. Here the order is still pending — line 12 has no file
	 * — which forces the guard to decide about line 11 on its own.
	 */
	public function test_an_already_collected_line_is_not_fetched_again(): void {
		$order = optionia_test_order( 76 );
		$order->update_meta_data(
			Keys::META_RENDER_IDS,
			(string) wp_json_encode(
				array(
					11 => 'render-1',
					12 => 'render-2',
				)
			)
		);
		$order->update_meta_data(
			Keys::META_RENDER_FILES,
			(string) wp_json_encode( array( 11 => 'already.png' ) )
		);

		$GLOBALS['optionia_test_orders'][76] = $order;

		/*
		 * Only line 12 is outstanding, so exactly one file may be stored and
		 * line 11's recorded name must be untouched.
		 */
		$this->assertSame( 1, $this->collector()->drain() );

		$files = $this->storedFiles( $order );

		$this->assertSame( 'already.png', (string) $files[11] );
		$this->assertStringEndsWith( '.png', (string) $files[12] );
	}

	/** An order with no render ids is never looked at. */
	public function test_an_order_with_no_renders_is_ignored(): void {
		$GLOBALS['optionia_test_orders'][77] = optionia_test_order( 77 );

		$this->assertSame( 0, $this->collector()->drain() );
	}
	/* --- a render the cloud gave up on (M26e.6) ---------------------------- */

	/**
	 * 🔴 **A 404 on the file route means one of two OPPOSITE things**, and
	 * guessing cost a merchant their print file. The cloud answers it while a
	 * job is still rasterising AND after it has been given up on — so treating
	 * every 404 as "ask again next pass" retried a dead render on every cron
	 * run for ever, and nothing ever told the merchant.
	 */
	public function test_a_failed_render_is_recorded_on_the_order(): void {
		$order = $this->renderedOrder( 80 );

		$GLOBALS['optionia_test_http_by_url'] = array(
			'/file'    => array(
				'status' => 404,
				'body'   => '{"error":{"code":"NOT_FOUND"}}',
			),
			'renders/' => array(
				'status' => 200,
				'body'   => '{"data":{"status":"failed","lastError":"the stored scene could not be serialized","attempts":3}}',
			),
		);

		$this->assertSame( 0, $this->collector()->drain() );

		$recorded = json_decode( (string) $order->get_meta( Keys::META_RENDER_FAILURES ), true );

		$this->assertIsArray( $recorded );
		$this->assertStringContainsString( 'could not be serialized', (string) $recorded[11] );
	}

	/**
	 * ⚠️ **A line already recorded as failed is never asked about again.** The
	 * cloud answers 404 for a dead job for ever; without this the collector
	 * re-asks on every pass, which is the loop M26e.6 exists to stop.
	 */
	public function test_a_recorded_failure_is_not_asked_about_again(): void {
		$order = $this->renderedOrder( 81 );

		$order->update_meta_data(
			Keys::META_RENDER_FAILURES,
			(string) wp_json_encode( array( 11 => 'already given up on' ) )
		);

		$GLOBALS['optionia_test_http_calls'] = array();

		$this->collector()->drain();

		$this->assertSame( 0, count( $GLOBALS['optionia_test_http_calls'] ), 'a dead line must not be re-fetched' );
	}

	/**
	 * 📌 **A job still rasterising is NOT a failure.** The same 404, a
	 * different answer — and recording it would abandon a render that was
	 * about to succeed.
	 */
	public function test_a_render_still_preparing_is_not_recorded_as_failed(): void {
		$order = $this->renderedOrder( 82 );

		$GLOBALS['optionia_test_http_by_url'] = array(
			'/file'    => array(
				'status' => 404,
				'body'   => '{"error":{"code":"NOT_FOUND"}}',
			),
			'renders/' => array(
				'status' => 200,
				'body'   => '{"data":{"status":"preparing","lastError":null,"attempts":0}}',
			),
		);

		$this->collector()->drain();

		$this->assertSame( '', (string) $order->get_meta( Keys::META_RENDER_FAILURES ) );
	}

	/**
	 * ⚠️ **A status this build does not recognise is treated as "not yet".** A
	 * newer cloud adding a state must not make an older plugin abandon a
	 * render it would have collected.
	 */
	public function test_an_unknown_status_is_not_recorded_as_failed(): void {
		$order = $this->renderedOrder( 83 );

		$GLOBALS['optionia_test_http_by_url'] = array(
			'/file'    => array(
				'status' => 404,
				'body'   => '{"error":{"code":"NOT_FOUND"}}',
			),
			'renders/' => array(
				'status' => 200,
				'body'   => '{"data":{"status":"quarantined","lastError":null,"attempts":1}}',
			),
		);

		$this->collector()->drain();

		$this->assertSame( '', (string) $order->get_meta( Keys::META_RENDER_FAILURES ) );
	}

	/**
	 * 🔴 **A file that arrived missing a layer is recorded as incomplete**
	 * (F173), and still stored — a print file missing one badge beats no file.
	 */
	public function test_an_incomplete_file_is_recorded_as_partial(): void {
		$order = $this->renderedOrder( 84 );

		$GLOBALS['optionia_test_http_by_url'] = array(
			'/collected' => array(
				'status' => 200,
				'body'   => '{"data":{"collected":true}}',
			),
			'/file'      => array(
				'status' => 200,
				'body'   => self::PNG,
			),
			'renders/'   => array(
				'status' => 200,
				'body'   => '{"data":{"status":"ready","lastError":"unreachable: https://cdn.test/badge.png","attempts":1}}',
			),
		);

		$this->assertSame( 1, $this->collector()->drain() );

		$partial = json_decode( (string) $order->get_meta( Keys::META_RENDER_PARTIAL ), true );

		$this->assertIsArray( $partial );
		$this->assertStringContainsString( 'unreachable', (string) $partial[11] );
	}
}
