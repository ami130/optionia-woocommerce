<?php
/**
 * The daily authenticated ping (M8.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Repository;
use Optionia\Connection\Heartbeat;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadRepository;
use PHPUnit\Framework\TestCase;

/**
 * Heartbeat reports the environment and records what the cloud replies.
 *
 * @covers \Optionia\Connection\Heartbeat
 */
final class HeartbeatTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();

		// Reset the transport too. A 401 left over from the revocation tests
		// would otherwise leak into whichever test ran next, and a suite that
		// passes because of stale state is worse than one that fails.
		$GLOBALS['optionia_test_http'] = array(
			'status'  => 200,
			'body'    => '{"data":{}}',
			'headers' => array(),
		);
	}

	/**
	 * A repository with a cached document of a known age.
	 *
	 * @param int $age_seconds How long ago it was fetched.
	 */
	private function repository_cached_seconds_ago( int $age_seconds ): Repository {
		$repository = new Repository( new Logger( new Settings() ) );
		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 3,
				'option_sets'    => array(),
			),
			'etag-3'
		);

		// Backdate the fetch so cache_age_seconds has something to measure.
		$meta               = get_option( Keys::OPTION_CONFIG_META, array() );
		$meta['fetched_at'] = time() - $age_seconds;
		update_option( Keys::OPTION_CONFIG_META, $meta, false );

		return $repository;
	}

	/**
	 * Drive the state machine to connected through a legal path.
	 */
	private function connect(): void {
		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );
	}

	/**
	 * Build a heartbeat around a client double.
	 *
	 * @param PostsToCloud $client     Transport.
	 * @param Repository   $repository Config cache.
	 */
	private function heartbeat( PostsToCloud $client, Repository $repository ): Heartbeat {
		return new Heartbeat( $client, $repository, new Logger( new Settings() ), new UploadRepository() );
	}

	/**
	 * The payload carries the environment the support team needs.
	 */
	public function test_payload_reports_environment_and_cache_state(): void {
		$this->connect();
		$repository = $this->repository_cached_seconds_ago( 120 );

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				$captured = array(
					'path' => $path,
					'body' => $body,
				);

				return Response::success( 200, array( 'config_version' => 3 ) );
			}
		);

		$this->heartbeat( $client, $repository )->send();

		$this->assertSame( '/store/heartbeat', $captured['path'] );
		$this->assertSame( OPTIONIA_VERSION, $captured['body']['plugin_version'] );
		$this->assertSame( '6.5', $captured['body']['wp_version'] );
		$this->assertSame( PHP_VERSION, $captured['body']['php_version'] );
		$this->assertSame( StateMachine::CONNECTED, $captured['body']['connection_state'] );
		$this->assertSame( 3, $captured['body']['config_version'] );
		$this->assertGreaterThanOrEqual( 120, $captured['body']['cache_age_seconds'] );
	}

	/**
	 * Never cached is not the same as cached a moment ago.
	 *
	 * A zero would tell the cloud this store is perfectly fresh, which is the
	 * opposite of the truth.
	 */
	public function test_cache_age_is_null_when_nothing_was_ever_cached(): void {
		$this->connect();
		$repository = new Repository( new Logger( new Settings() ) );

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array() );
			}
		);

		$this->heartbeat( $client, $repository )->send();

		$this->assertNull( $captured['cache_age_seconds'] );
		$this->assertSame( 0, $captured['config_version'] );
	}

	/**
	 * A disconnected store holds no credential, so it sends nothing.
	 */
	public function test_disconnected_store_does_not_send(): void {
		$repository = new Repository( new Logger( new Settings() ) );

		$client = $this->createMock( PostsToCloud::class );
		$client->expects( $this->never() )->method( 'post' );

		$this->assertSame( StateMachine::DISCONNECTED, StateMachine::current() );
		$this->assertFalse( $this->heartbeat( $client, $repository )->send() );
	}

	/**
	 * A revoked store keeps pinging.
	 *
	 * Deliberate: it is how a plugin notices a merchant reconnecting from the
	 * dashboard. Deleting this expectation should break a test, because the
	 * alternative -- going quiet -- is a store that never recovers on its own.
	 */
	public function test_revoked_store_still_sends(): void {
		$this->connect();
		StateMachine::on_unauthorized();

		$repository = new Repository( new Logger( new Settings() ) );

		$client = $this->createMock( PostsToCloud::class );
		$client->expects( $this->once() )
			->method( 'post' )
			->willReturn( Response::success( 200, array() ) );

		$this->assertSame( StateMachine::REVOKED, StateMachine::current() );
		$this->heartbeat( $client, $repository )->send();
	}

	/**
	 * The cloud's reply is recorded, not discarded.
	 *
	 * Without this the heartbeat would be write-only and `config_version` a
	 * field nobody reads.
	 */
	public function test_response_config_version_is_recorded(): void {
		$this->connect();
		$repository = $this->repository_cached_seconds_ago( 10 );

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturn(
			Response::success( 200, array( 'config_version' => 9 ) )
		);

		$heartbeat = $this->heartbeat( $client, $repository );

		$this->assertTrue( $heartbeat->send() );

		$last = Heartbeat::last();

		$this->assertIsArray( $last );
		$this->assertTrue( $last['ok'] );
		$this->assertSame( 9, $last['cloud_config_version'] );
	}

	/**
	 * A newer version at the cloud means this store is behind.
	 */
	public function test_is_behind_when_cloud_reports_newer_config(): void {
		$this->connect();
		$repository = $this->repository_cached_seconds_ago( 10 );

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturn(
			Response::success( 200, array( 'config_version' => 9 ) )
		);

		$heartbeat = $this->heartbeat( $client, $repository );
		$heartbeat->send();

		$this->assertTrue( $heartbeat->is_behind(), 'Cloud has 9, cache has 3.' );
	}

	/**
	 * Matching versions mean there is nothing to fetch.
	 */
	public function test_is_not_behind_when_versions_match(): void {
		$this->connect();
		$repository = $this->repository_cached_seconds_ago( 10 );

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturn(
			Response::success( 200, array( 'config_version' => 3 ) )
		);

		$heartbeat = $this->heartbeat( $client, $repository );
		$heartbeat->send();

		$this->assertFalse( $heartbeat->is_behind() );
	}

	/**
	 * A failed ping is recorded as a failure, not silence.
	 *
	 * System Status has to tell "never ran" apart from "ran and failed"; only
	 * the second means the credential or the network is the problem.
	 */
	public function test_failed_heartbeat_is_recorded(): void {
		$this->connect();
		$repository = new Repository( new Logger( new Settings() ) );

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturn(
			Response::failure( 401, 'unauthorized', 'Credential refused.' )
		);

		$this->assertFalse( $this->heartbeat( $client, $repository )->send() );

		$last = Heartbeat::last();

		$this->assertIsArray( $last );
		$this->assertFalse( $last['ok'] );
		$this->assertArrayNotHasKey( 'cloud_config_version', $last );
	}

	/**
	 * Nothing recorded before the first run.
	 */
	public function test_last_is_null_before_any_heartbeat(): void {
		$this->assertNull( Heartbeat::last() );
	}

	/**
	 * Version strings are trimmed to something the API accepts.
	 *
	 * The endpoint caps them at 20 characters and rejects the whole body on a
	 * violation, so a Debian or Ubuntu PHP build -- by far the most common way
	 * to run WooCommerce -- would otherwise never report at all.
	 *
	 * @dataProvider version_provider
	 *
	 * @param string $raw      Raw version.
	 * @param string $expected Expected value on the wire.
	 */
	public function test_version_strings_are_wire_safe( string $raw, string $expected ): void {
		$this->connect();

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array() );
			}
		);

		$GLOBALS['optionia_test_wp_version'] = $raw;

		$this->heartbeat( $client, new Repository( new Logger( new Settings() ) ) )->send();

		unset( $GLOBALS['optionia_test_wp_version'] );

		$this->assertSame( $expected, $captured['wp_version'] );
		$this->assertLessThanOrEqual( 20, strlen( $captured['wp_version'] ) );
	}

	/**
	 * Real version strings seen in the wild.
	 *
	 * @return array<string, array{string, string}>
	 */
	public function version_provider(): array {
		return array(
			'plain'             => array( '6.5', '6.5' ),
			'patch'             => array( '6.5.2', '6.5.2' ),
			'wp beta'           => array( '6.5-beta3-57424-src', '6.5' ),
			'ubuntu php'        => array( '8.1.2-1ubuntu2.14+deb.sury.org+1', '8.1.2' ),
			'release candidate' => array( '9.4.0-rc.1', '9.4.0' ),
		);
	}

	/**
	 * Every field on the wire fits what the API accepts.
	 */
	public function test_php_version_is_within_the_api_limit(): void {
		$this->connect();

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array() );
			}
		);

		$this->heartbeat( $client, new Repository( new Logger( new Settings() ) ) )->send();

		foreach ( array( 'plugin_version', 'wp_version', 'wc_version', 'php_version' ) as $field ) {
			$this->assertLessThanOrEqual(
				20,
				strlen( (string) $captured[ $field ] ),
				$field . ' must fit the API limit or the whole heartbeat is rejected.'
			);
		}
	}

	/**
	 * Firing the scheduled event actually sends a heartbeat.
	 *
	 * The registration test below asserts a listener exists; this asserts the
	 * listener *does something*. Deleting the callback body while leaving
	 * `add_action` in place would satisfy the former and fail this one, which
	 * is the difference between a wired hook and a working one.
	 */
	public function test_firing_the_cron_event_sends_a_heartbeat(): void {
		$this->connect();

		$client = $this->createMock( PostsToCloud::class );
		$client->expects( $this->once() )
			->method( 'post' )
			->willReturn( Response::success( 200, array() ) );

		$this->heartbeat( $client, new Repository( new Logger( new Settings() ) ) )->register();

		// The literal name, deliberately: this is the hook WordPress will fire
		// from the scheduled event, so asserting against the constant would
		// pass even if the constant's value changed out from under the
		// schedule. It is also the form PHPCS can verify is prefixed.
		$this->assertSame( 'optionia_cron_heartbeat', Keys::CRON_HEARTBEAT );

		do_action( 'optionia_cron_heartbeat' );
	}

	/**
	 * A refused credential during a heartbeat marks the store revoked.
	 *
	 * End to end through the real `Api\Client`, because that is where the
	 * announcement lives: the heartbeat itself never mentions revocation, and a
	 * test using a client double would prove only that the double returned 401.
	 */
	public function test_unauthorized_heartbeat_revokes_the_store(): void {
		StateMachine::listen();
		$this->connect();

		update_option( Keys::OPTION_STORE_TOKEN, 'a-credential', false );

		$GLOBALS['optionia_test_http'] = array(
			'status'  => 401,
			'body'    => '{"error":{"code":"unauthorized","message":"Credential refused."}}',
			'headers' => array(),
		);

		$settings = new Settings();
		$logger   = new Logger( $settings );

		$heartbeat = new Heartbeat(
			new Client( $settings, $logger, new CircuitBreaker( $logger, $settings ), new ResponseValidator( $logger ) ),
			new Repository( $logger ),
			$logger
		);

		$this->assertFalse( $heartbeat->send() );
		$this->assertSame( StateMachine::REVOKED, StateMachine::current() );

		$last = Heartbeat::last();
		$this->assertIsArray( $last );
		$this->assertFalse( $last['ok'] );
	}

	/**
	 * A 401 mid-handshake does not derail the connection.
	 *
	 * A `connecting` store has no credential yet -- the callback writes it --
	 * so its heartbeat earns a 401 by construction. Treating that as revocation
	 * would break every connection attempt that straddles the daily run.
	 */
	public function test_unauthorized_heartbeat_does_not_revoke_mid_handshake(): void {
		StateMachine::listen();
		StateMachine::transition( StateMachine::CONNECTING );

		$GLOBALS['optionia_test_http'] = array(
			'status'  => 401,
			'body'    => '{"error":{"code":"unauthorized","message":"No credential."}}',
			'headers' => array(),
		);

		$settings = new Settings();
		$logger   = new Logger( $settings );

		$heartbeat = new Heartbeat(
			new Client( $settings, $logger, new CircuitBreaker( $logger, $settings ), new ResponseValidator( $logger ) ),
			new Repository( $logger ),
			$logger
		);

		$heartbeat->send();

		$this->assertSame(
			StateMachine::CONNECTING,
			StateMachine::current(),
			'A store mid-handshake must not be revoked by its own unauthenticated ping.'
		);
	}

	/**
	 * The scheduled hook has a listener.
	 *
	 * An event with no listener is logged by WP-Cron as orphaned and does
	 * nothing at all.
	 */
	public function test_register_listens_on_the_cron_hook(): void {
		$client     = $this->createMock( PostsToCloud::class );
		$repository = new Repository( new Logger( new Settings() ) );

		$this->heartbeat( $client, $repository )->register();

		$this->assertArrayHasKey( Keys::CRON_HEARTBEAT, $GLOBALS['optionia_test_actions'] );
	}

	/* --- storage (M15.6) --------------------------------------------------- */

	/**
	 * The body one heartbeat sent, with the upload table answering `$bytes`.
	 *
	 * @param int $bytes What the store is holding.
	 * @return array<string, mixed>
	 */
	private function payloadHolding( int $bytes ): array {
		$this->connect();

		$GLOBALS['wpdb']      = new \Optionia_Test_Wpdb();
		$GLOBALS['wpdb']->var = $bytes;

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array( 'config_version' => 1 ) );
			}
		);

		$this->heartbeat( $client, $this->repository_cached_seconds_ago( 10 ) )->send();

		return (array) $captured;
	}

	/**
	 * 🔴 **The heartbeat carries what this store is holding.**
	 *
	 * Carried here rather than posted to an endpoint of its own because usage is
	 * a *level*, not an event: a missed order is lost and needs a queue, while a
	 * missed storage figure is simply superseded by tomorrow's heartbeat.
	 */
	public function test_the_payload_reports_stored_bytes(): void {
		$this->assertSame( 5242880, $this->payloadHolding( 5242880 )['storage_bytes'] );
	}

	/**
	 * ⚠️ **Bytes, not megabytes.** Rounding at the edge would make every store
	 * under half a megabyte report zero, and the conversion belongs where the
	 * limit is compared rather than in a number every store sends daily.
	 */
	public function test_a_small_store_still_reports_its_bytes(): void {
		$this->assertSame( 1, $this->payloadHolding( 1 )['storage_bytes'] );
	}

	/** A store holding nothing reports nothing. */
	public function test_an_empty_store_reports_zero(): void {
		$this->assertSame( 0, $this->payloadHolding( 0 )['storage_bytes'] );
	}

	/**
	 * 🔴 **Claimed and unclaimed files alike.**
	 *
	 * A file promoted to an order occupies the merchant's disk exactly as much as
	 * one still waiting in a cart, so a total counting only pending uploads would
	 * under-report what the plan limit is meant to bound — and under-reporting is
	 * the direction that lets a tenant exceed a limit it was sold.
	 *
	 * ⚠️ Asserted on the *query*, because the stub answers any question with the
	 * same number: mutation showed a total narrowed to unclaimed rows passing
	 * every assertion that only read the figure.
	 */
	public function test_the_total_counts_every_stored_file(): void {
		$this->payloadHolding( 1024 );

		$totals = array_filter(
			$GLOBALS['wpdb']->queries,
			static fn ( string $sql ): bool => false !== strpos( $sql, 'SUM(size_bytes)' )
		);

		$this->assertNotSame( array(), $totals, 'The store must be asked for its total.' );
		$this->assertStringNotContainsString(
			'order_id',
			implode( ' ', $totals ),
			'Promoted files occupy the disk too, so the total may not exclude them.'
		);
	}
}
