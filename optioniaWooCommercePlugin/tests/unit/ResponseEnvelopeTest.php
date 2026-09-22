<?php
/**
 * The plugin speaks the API's envelope (ADR-009).
 *
 * Every cloud response is `{"data": ..., "meta": {...}}` and every error is
 * `{"error": {"code": ..., "message": ...}, "meta": {...}}`. The plugin read
 * neither: it took the envelope's outer level as the payload, so against the
 * real API the handshake returned null, the callback stored no token, and the
 * heartbeat recorded no version — the whole connection flow, broken.
 *
 * Both suites passed the entire time. The backend's e2e asserts
 * `body.data.authorize_url`; every plugin fixture was flat. Each side was
 * internally consistent and disagreed with the other, which is why the fixtures
 * here are written as the wire actually carries them.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Repository;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\Heartbeat;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Real wire shapes, end to end.
 *
 * @covers \Optionia\Api\Client
 */
final class ResponseEnvelopeTest extends TestCase {

	/**
	 * The `meta` block the interceptor attaches to every response.
	 */
	private const META = '"meta":{"requestId":"01a0","timestamp":"2026-08-28T00:00:00.000Z"}';

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();

		// `Connection\Callback` refuses a caller without the capability, and
		// other suites leave this false. Without resetting it these tests pass
		// alone and fail in a full run — an ordering dependency, not a bug in
		// the code under test.
		$GLOBALS['optionia_test_can'] = true;
	}

	/**
	 * A client whose next response is the given body.
	 *
	 * @param string $body   Raw response body, exactly as the wire carries it.
	 * @param int    $status HTTP status.
	 */
	private function client( string $body, int $status = 200 ): Client {
		$GLOBALS['optionia_test_http'] = array(
			'status'  => $status,
			'body'    => $body,
			'headers' => array(),
		);

		$settings = new Settings();
		$logger   = new Logger( $settings );

		return new Client( $settings, $logger, new CircuitBreaker( $logger ), new ResponseValidator( $logger ) );
	}

	/**
	 * An enveloped success body.
	 *
	 * @param string $payload JSON for the `data` key.
	 */
	private function enveloped( string $payload ): string {
		return '{"data":' . $payload . ',' . self::META . '}';
	}

	/**
	 * The handshake reads `authorize_url` through the envelope.
	 */
	public function test_handshake_reads_through_the_envelope(): void {
		$handshake = new Handshake(
			$this->client( $this->enveloped( '{"authorize_url":"https://app.optionia.test/connect?request=r1"}' ) )
		);

		$this->assertSame( 'https://app.optionia.test/connect?request=r1', $handshake->begin() );
	}

	/**
	 * The callback stores the credential the envelope carries.
	 */
	public function test_callback_reads_through_the_envelope(): void {
		$handshake = new Handshake(
			$this->client( $this->enveloped( '{"authorize_url":"https://app.optionia.test/connect?request=r1"}' ) )
		);
		$handshake->begin();

		$stored = get_option( Keys::OPTION_HANDSHAKE, array() );

		$callback = new Callback(
			$this->client( $this->enveloped( '{"token":"tok-1","store_id":"s1","tenant_name":"Acme Ltd"}' ) )
		);

		$result = $callback->handle(
			array(
				'optionia_connect' => '1',
				'code'             => 'authorization-code',
				'state'            => $stored['state'],
			)
		);

		$this->assertSame( Callback::RESULT_CONNECTED, $result );
		$this->assertSame( 'tok-1', get_option( Keys::OPTION_STORE_TOKEN ) );
		$this->assertSame( 'Acme Ltd', get_option( Keys::OPTION_CONNECTION_TENANT ) );
	}

	/**
	 * The heartbeat records the version the envelope carries.
	 */
	public function test_heartbeat_reads_through_the_envelope(): void {
		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );

		$logger = new Logger( new Settings() );

		$heartbeat = new Heartbeat(
			$this->client( $this->enveloped( '{"config_version":9,"status":"connected","reauthorize":false}' ) ),
			new Repository( $logger ),
			$logger
		);

		$this->assertTrue( $heartbeat->send() );

		$last = Heartbeat::last();

		$this->assertIsArray( $last );
		$this->assertSame( 9, $last['cloud_config_version'] );
	}

	/**
	 * A cloud error surfaces its message, not "HTTP 400".
	 *
	 * The message is the one sentence telling a merchant what to fix. The
	 * previous extraction looked for a *string* under `error`, found the
	 * envelope's array, skipped it, and reported the status code instead.
	 */
	public function test_error_message_is_read_from_the_envelope(): void {
		$response = $this->client(
			'{"error":{"code":"VALIDATION_FAILED","message":"site_url must be https."},' . self::META . '}',
			400
		)->post( '/connect/initiate' );

		$this->assertFalse( $response->is_ok() );
		$this->assertSame( 'site_url must be https.', $response->error_message() );
	}

	/**
	 * An error body that never reached the application still yields a message.
	 *
	 * A proxy or gateway does not speak this API's envelope, and that is exactly
	 * when a merchant most needs to see what happened.
	 *
	 * Uses 403 rather than a 5xx deliberately: `is_retryable()` retries 429 and
	 * every 5xx, so a 502 fixture makes this test sleep through two real backoff
	 * delays. The assertion is about reading the message, not about retrying —
	 * paying three seconds for coverage this test does not claim would be a
	 * tax on every future run.
	 */
	public function test_unenveloped_error_body_still_yields_a_message(): void {
		$response = $this->client( '{"message":"Blocked by upstream proxy."}', 403 )
			->post( '/connect/initiate' );

		$this->assertSame( 'Blocked by upstream proxy.', $response->error_message() );
	}

	/**
	 * A body with no envelope is passed through unchanged.
	 *
	 * `/health` is served unwrapped by design. Treating a missing `data` key as
	 * an error would refuse it.
	 */
	public function test_body_without_an_envelope_is_returned_as_is(): void {
		$response = $this->client( '{"status":"ok","uptime":42}' )->post( '/health' );

		$this->assertTrue( $response->is_ok() );
		$this->assertSame(
			array(
				'status' => 'ok',
				'uptime' => 42,
			),
			$response->data()
		);
	}

	/**
	 * A null `data` is an empty payload, not a malformed response.
	 *
	 * The interceptor writes `data: null` for a 204-style handler rather than
	 * omitting the key.
	 */
	public function test_null_data_is_an_empty_payload(): void {
		$response = $this->client( '{"data":null,' . self::META . '}' )->post( '/store/heartbeat' );

		$this->assertTrue( $response->is_ok() );
		$this->assertSame( array(), $response->data() );
	}

	/**
	 * `meta` never reaches a caller.
	 *
	 * Transport detail. A caller reading `requestId` would be depending on the
	 * envelope, which is the coupling this unwrapping removes.
	 */
	public function test_meta_is_not_exposed_to_callers(): void {
		$response = $this->client( $this->enveloped( '{"token":"tok-1"}' ) )->post( '/connect/exchange' );

		$this->assertArrayNotHasKey( 'meta', $response->data() );
		$this->assertSame( array( 'token' => 'tok-1' ), $response->data() );
	}
}
