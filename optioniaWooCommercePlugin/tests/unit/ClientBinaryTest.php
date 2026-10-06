<?php
/**
 * Fetching bytes through the same transport that fetches JSON (M26e.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * `Api\Client::get_binary()` carries a print file without decoding it.
 *
 * 🔴 **The reason this shares `Client` rather than being its own transport.**
 * The circuit breaker, retry budget, size cap, AC3 refusal and 401 revocation
 * hook are protections that took measurement to get right. A second transport
 * for binary is how one of them quietly goes missing on one code path — a
 * revoked credential that never moved the store to `REVOKED` on binary routes
 * would be exactly the ambiguity M8.1b calls the biggest source of support
 * tickets. These tests pin that the sharing is real, not nominal.
 *
 * @covers \Optionia\Api\Client
 * @covers \Optionia\Api\BinaryResponse
 */
final class ClientBinaryTest extends TestCase {

	/** A one-pixel PNG: a real signature, and bytes JSON cannot represent. */
	private const PNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\xff\xfe";

	protected function setUp(): void {
		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_actions']    = array();
		$GLOBALS['optionia_test_doing_cron'] = true;
		$GLOBALS['optionia_test_http']       = array(
			'status' => 200,
			'body'   => self::PNG,
		);
	}

	private function client(): Client {
		$settings = new Settings();
		$logger   = new Logger( $settings );

		return new Client( $settings, $logger, new CircuitBreaker( $logger ), new ResponseValidator() );
	}

	/**
	 * 🔴 **The bytes survive intact.** `json_decode` on a PNG fails, so a
	 * binary route that went through the JSON path would answer
	 * `invalid_response` for every real print file.
	 */
	public function test_it_returns_the_body_unchanged(): void {
		$response = $this->client()->get_binary( '/store/renders/abc/file' );

		$this->assertTrue( $response->is_ok() );
		$this->assertSame( self::PNG, $response->bytes() );
	}

	/**
	 * ⚠️ **Counted in octets.** `mb_strlen` would report a length that matches
	 * nothing on disk and would not compare against `Content-Length`.
	 */
	public function test_it_reports_size_in_bytes(): void {
		$response = $this->client()->get_binary( '/store/renders/abc/file' );

		$this->assertSame( strlen( self::PNG ), $response->size() );
	}

	/**
	 * 📌 **`Content-Length` reaches the caller**, which is what lets a truncated
	 * download be told from a complete one. A partial print file looks like a
	 * file and prints as damage.
	 */
	public function test_it_carries_content_length(): void {
		$GLOBALS['optionia_test_http']['headers'] = array( 'content-length' => '21' );

		$response = $this->client()->get_binary( '/store/renders/abc/file' );

		$this->assertSame( '21', $response->header( 'content-length' ) );
	}

	/**
	 * 🔴 **A refused credential must still announce itself on a binary route.**
	 * This is the protection most easily lost to a separate transport: without
	 * it the cloud revokes, binary pulls fail, and the settings screen goes on
	 * saying "Connected".
	 */
	public function test_a_401_still_announces_revocation(): void {
		$GLOBALS['optionia_test_http'] = array(
			'status' => 401,
			'body'   => '{"error":{"code":"UNAUTHENTICATED"}}',
		);

		$fired = array();

		add_action(
			'optionia_unauthorized',
			static function ( $path ) use ( &$fired ): void {
				$fired[] = $path;
			}
		);

		$response = $this->client()->get_binary( '/store/renders/abc/file' );

		$this->assertFalse( $response->is_ok() );
		$this->assertSame( array( '/store/renders/abc/file' ), $fired );
	}

	/**
	 * ⚠️ **A failure carries no bytes.** Returning a previous body on an error
	 * would hand a caller the wrong order's artwork.
	 */
	public function test_a_failure_carries_no_bytes(): void {
		$GLOBALS['optionia_test_http'] = array(
			'status' => 404,
			'body'   => '{"error":{"code":"NOT_FOUND"}}',
		);

		$response = $this->client()->get_binary( '/store/renders/abc/file' );

		$this->assertFalse( $response->is_ok() );
		$this->assertSame( '', $response->bytes() );
		$this->assertSame( 404, $response->status() );
	}

	/**
	 * 🔴 **A later failure never serves the earlier call's print file.**
	 *
	 * ⚠️ **What this does NOT prove, recorded rather than implied.** `Client`
	 * clears `$binary_bytes` before and after each binary call, and **removing
	 * either clear leaves every test here passing** — measured, both ways
	 * separately and together. A probe with both removed and a transport error
	 * on the second call still returned an empty body, because
	 * `BinaryResponse::failure()` carries `''` by construction and the
	 * `! is_ok()` guard returns before the bytes are read. The clears are
	 * therefore **equivalent mutants**: real defence in depth, and not
	 * observable through this class's public surface.
	 *
	 * 📌 **They stay.** The guard and the clears protect the same property by
	 * different means, and the one that would be load-bearing if the guard ever
	 * moved is the cheaper of the two to keep.
	 */
	public function test_a_later_failure_does_not_return_the_earlier_bytes(): void {
		$client = $this->client();

		$first = $client->get_binary( '/store/renders/one/file' );
		$this->assertSame( self::PNG, $first->bytes() );

		$GLOBALS['optionia_test_http'] = array(
			'status' => 404,
			'body'   => '{"error":{"code":"NOT_FOUND"}}',
		);

		$second = $client->get_binary( '/store/renders/two/file' );

		$this->assertSame( '', $second->bytes() );
	}

	/**
	 * 🔴 **AC3 holds for binary too**: nothing on a customer-facing page render
	 * may block on the API. A pull that ran during a render would put a cloud
	 * round-trip on a shopper's page load.
	 */
	public function test_it_refuses_during_a_frontend_render(): void {
		$GLOBALS['optionia_test_doing_cron'] = false;

		$response = $this->client()->get_binary( '/store/renders/abc/file' );

		$this->assertFalse( $response->is_ok() );
		$this->assertSame( 'frontend_render', $response->error_code() );
	}

	/**
	 * ⚠️ **JSON callers are unaffected.** `get()` must still decode, or this
	 * change would have broken every existing route to add one.
	 */
	public function test_json_requests_still_decode(): void {
		$GLOBALS['optionia_test_http'] = array(
			'status' => 200,
			'body'   => '{"data":{"ok":true}}',
		);

		$response = $this->client()->get( '/store/config' );

		$this->assertTrue( $response->is_ok() );
		$this->assertSame( array( 'ok' => true ), $response->data() );
	}
}
