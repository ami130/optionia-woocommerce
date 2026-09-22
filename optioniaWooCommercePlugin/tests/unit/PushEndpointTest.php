<?php
/**
 * The inbound push, and what a forged one can achieve (M9.4).
 *
 * This route is **public** — the cloud is a server with no WordPress identity,
 * so a capability check would refuse every genuine push and accept none. The
 * signature is the authentication, and these tests are what stands behind that
 * decision.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\FetchesFromCloud;
use Optionia\Api\Response;
use Optionia\Config\Repository;
use Optionia\Config\Synchroniser;
use Optionia\Connection\PushEndpoint;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;
use WP_REST_Request;

/**
 * A push wakes a pull, or is refused.
 *
 * @covers \Optionia\Connection\PushEndpoint
 * @covers \Optionia\Connection\PushSignature
 */
final class PushEndpointTest extends TestCase {

	/** The credential both sides share. */
	private const CREDENTIAL = 'store-credential-abc';

	/** A representative push body. */
	private const BODY = '{"event":"config.updated","config_version":8}';

	/**
	 * How many pulls the synchroniser made.
	 *
	 * @var int
	 */
	private int $pulls = 0;

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options']     = array();
		$GLOBALS['optionia_test_actions']     = array();
		$GLOBALS['optionia_test_rest_routes'] = array();

		$this->pulls = 0;

		update_option( Keys::OPTION_STORE_TOKEN, self::CREDENTIAL, false );

		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );
	}

	/**
	 * A logger over real settings.
	 */
	private function logger(): Logger {
		return new Logger( new Settings() );
	}

	/**
	 * An endpoint whose pulls are counted.
	 */
	private function endpoint(): PushEndpoint {
		$counter = function (): void {
			++$this->pulls;
		};

		$client = new class( $counter ) implements FetchesFromCloud {

			/**
			 * Called on each fetch.
			 *
			 * @var callable
			 */
			private $counter;

			/**
			 * Construct.
			 *
			 * @param callable $counter Called on each fetch.
			 */
			public function __construct( callable $counter ) {
				$this->counter = $counter;
			}

			/**
			 * Fetch a path.
			 *
			 * @param string                $path    Path.
			 * @param array<string, mixed>  $query   Query.
			 * @param array<string, string> $headers Headers.
			 */
			public function get( string $path, array $query = array(), array $headers = array() ): Response {
				( $this->counter )();

				return Response::success( 304, array() );
			}
		};

		$logger     = $this->logger();
		$repository = new Repository( $logger );

		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(),
			),
			'W/"store-7"'
		);

		return new PushEndpoint( new Synchroniser( $client, $repository, $logger ), $logger );
	}

	/**
	 * Build a request signed with the given key.
	 *
	 * @param string      $key       Signing key.
	 * @param int|null    $timestamp Unix seconds; defaults to now.
	 * @param string|null $body      Raw body.
	 */
	private function request( string $key, ?int $timestamp = null, ?string $body = null ): WP_REST_Request {
		$timestamp = $timestamp ?? time();
		$body      = $body ?? self::BODY;

		return new WP_REST_Request(
			array(
				'X-Optionia-Signature' => 'sha256=' . hash_hmac( 'sha256', $timestamp . '.' . $body, $key ),
				'X-Optionia-Timestamp' => (string) $timestamp,
			),
			$body
		);
	}

	/**
	 * A genuine push triggers exactly one pull.
	 */
	public function test_a_signed_push_wakes_a_pull(): void {
		$response = $this->endpoint()->handle( $this->request( self::CREDENTIAL ) );

		$this->assertSame( 200, $response->get_status() );
		$this->assertTrue( $response->get_data()['accepted'] );
		$this->assertSame( 1, $this->pulls );
	}

	/**
	 * A push signed with the wrong key reaches nothing.
	 *
	 * The assertion that matters is `pulls`, not the status: refusing after
	 * doing the work would be a refusal in name only.
	 */
	public function test_a_forged_push_is_refused_and_pulls_nothing(): void {
		$response = $this->endpoint()->handle( $this->request( 'not-the-credential' ) );

		$this->assertSame( 401, $response->get_status() );
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * A captured push cannot be replayed later.
	 */
	public function test_a_stale_push_is_refused(): void {
		$response = $this->endpoint()->handle( $this->request( self::CREDENTIAL, time() - 600 ) );

		$this->assertSame( 401, $response->get_status() );
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * A future timestamp is refused too.
	 *
	 * The window is absolute, not one-sided: a signature dated tomorrow would
	 * otherwise stay valid until tomorrow.
	 */
	public function test_a_future_push_is_refused(): void {
		$response = $this->endpoint()->handle( $this->request( self::CREDENTIAL, time() + 600 ) );

		$this->assertSame( 401, $response->get_status() );
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * The timestamp is inside the signed material.
	 *
	 * Signing the body alone would let an attacker replay a captured push with
	 * a fresh timestamp — the freshness check answering a question the
	 * signature never asked.
	 */
	public function test_the_timestamp_cannot_be_swapped(): void {
		$signed = time() - 600;
		$body   = self::BODY;

		$request = new WP_REST_Request(
			array(
				// Signature over the old timestamp.
				'X-Optionia-Signature' => 'sha256=' . hash_hmac( 'sha256', $signed . '.' . $body, self::CREDENTIAL ),
				// Presented with a fresh one.
				'X-Optionia-Timestamp' => (string) time(),
			),
			$body
		);

		$this->assertSame( 401, $this->endpoint()->handle( $request )->get_status() );
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * A modified body invalidates the signature.
	 */
	public function test_a_tampered_body_is_refused(): void {
		$timestamp = time();

		$request = new WP_REST_Request(
			array(
				'X-Optionia-Signature' => 'sha256=' . hash_hmac( 'sha256', $timestamp . '.' . self::BODY, self::CREDENTIAL ),
				'X-Optionia-Timestamp' => (string) $timestamp,
			),
			'{"event":"config.updated","config_version":9999}'
		);

		$this->assertSame( 401, $this->endpoint()->handle( $request )->get_status() );
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * A store holding no credential refuses everything.
	 *
	 * There is nothing to verify against, so no request can be from the cloud.
	 */
	public function test_a_store_with_no_credential_refuses_every_push(): void {
		delete_option( Keys::OPTION_STORE_TOKEN );

		$this->assertSame(
			401,
			$this->endpoint()->handle( $this->request( self::CREDENTIAL ) )->get_status()
		);
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * A credential-less store refuses a signature computed with the empty key.
	 *
	 * This is the attack the empty-credential guard in `PushSignature` exists
	 * to stop, and it is not the same test as the one above.
	 *
	 * Above, the attacker signs with the real credential and is refused because
	 * they do not have it — which would hold with or without the guard. Here the
	 * attacker signs with `''`, and that is the whole point: `hash_hmac` accepts
	 * an empty key, so without the guard the *expected* signature is computed
	 * with `''` too, and both sides agree. The forgery needs no secret at all.
	 *
	 * A store sits credential-less between disconnect and reconnect, so this is
	 * a reachable state and not a theoretical one.
	 */
	public function test_a_credential_less_store_refuses_a_signature_forged_with_the_empty_key(): void {
		delete_option( Keys::OPTION_STORE_TOKEN );

		$response = $this->endpoint()->handle( $this->request( '' ) );

		$this->assertSame(
			401,
			$response->get_status(),
			'An empty-key signature is computable by anyone and must never verify.'
		);
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * Missing headers are refused rather than crashing.
	 */
	public function test_a_push_with_no_headers_is_refused(): void {
		$response = $this->endpoint()->handle( new WP_REST_Request( array(), self::BODY ) );

		$this->assertSame( 401, $response->get_status() );
		$this->assertSame( 0, $this->pulls );
	}

	/**
	 * A non-numeric timestamp is refused explicitly.
	 *
	 * `(int) 'abc'` is `0`, which fails the window anyway — but by accident,
	 * and an accident is not a check.
	 */
	public function test_a_junk_timestamp_is_refused(): void {
		$request = new WP_REST_Request(
			array(
				'X-Optionia-Signature' => 'sha256=' . hash_hmac( 'sha256', 'abc.' . self::BODY, self::CREDENTIAL ),
				'X-Optionia-Timestamp' => 'abc',
			),
			self::BODY
		);

		$this->assertSame( 401, $this->endpoint()->handle( $request )->get_status() );
	}

	/**
	 * A failed sync still answers 200.
	 *
	 * The delivery record is about whether the message arrived. Reporting a
	 * failure would have the cloud retry a push at a store whose own sync is
	 * broken — fixing nothing and doubling the traffic.
	 */
	public function test_a_failed_sync_still_accepts_the_push(): void {
		$logger = $this->logger();

		$client = $this->createMock( FetchesFromCloud::class );
		$client->method( 'get' )->willReturn( Response::failure( 500, 'server_error', 'Down.' ) );

		$endpoint = new PushEndpoint(
			new Synchroniser( $client, new Repository( $logger ), $logger ),
			$logger
		);

		$response = $endpoint->handle( $this->request( self::CREDENTIAL ) );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'sync_failed', PushEndpoint::last()['outcome'] );
	}

	/**
	 * The route is declared where the cloud will look for it.
	 */
	public function test_the_route_is_registered(): void {
		$this->endpoint()->register_route();

		$key = Keys::REST_NAMESPACE . Keys::REST_ROUTE_PUSH;

		$this->assertArrayHasKey( $key, $GLOBALS['optionia_test_rest_routes'] );
		$this->assertSame( 'POST', $GLOBALS['optionia_test_rest_routes'][ $key ]['methods'] );
	}

	/**
	 * The push URL is a REST route, not the browser callback.
	 *
	 * `Connection\Handshake::callback_url()` points at an admin screen — a
	 * server posting there reaches a login page. Confusing the two would make
	 * every push fail in a way that looks like a network problem.
	 */
	public function test_the_push_url_is_not_the_admin_callback(): void {
		$this->assertStringContainsString( 'wp-json/optionia/v1/push', PushEndpoint::url() );
		$this->assertStringNotContainsString( 'admin.php', PushEndpoint::url() );
	}

	/**
	 * The outcome is recorded for System Status.
	 */
	public function test_the_outcome_is_recorded(): void {
		$this->endpoint()->handle( $this->request( self::CREDENTIAL ) );

		$last = PushEndpoint::last();

		$this->assertIsArray( $last );
		$this->assertTrue( $last['accepted'] );
		$this->assertSame( 'synced', $last['outcome'] );
	}

	/**
	 * The handshake tells the cloud where to push.
	 *
	 * Without this the column stays null and the push has nowhere to go — the
	 * failure would look like a cloud problem while being entirely local, and
	 * would only show as storefronts that update in fifteen minutes rather than
	 * seconds.
	 */
	public function test_the_handshake_sends_the_push_url(): void {
		$captured = null;

		$client = $this->createMock( \Optionia\Api\PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array( 'authorize_url' => 'https://app.test/c' ) );
			}
		);

		( new \Optionia\Connection\Handshake( $client ) )->begin();

		$this->assertSame( PushEndpoint::url(), $captured['push_url'] );
		$this->assertNotSame(
			$captured['callback'],
			$captured['push_url'],
			'The push URL is a REST route; the callback is a browser redirect.'
		);
	}

	/** Nothing recorded before the first push. */
	public function test_last_is_null_before_any_push(): void {
		$this->assertNull( PushEndpoint::last() );
	}
}
