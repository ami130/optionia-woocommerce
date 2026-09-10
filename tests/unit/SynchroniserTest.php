<?php
/**
 * Pull-based configuration refresh (M9.3).
 *
 * The assertion that matters most here is not "does a sync fetch". It is that
 * **no outcome empties the cache** — AC3 promises a shop keeps selling from its
 * saved copy when the cloud is unreachable, and sync is the only code that
 * routinely touches that copy.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\FetchesFromCloud;
use Optionia\Api\Response;
use Optionia\Config\Repository;
use Optionia\Config\Synchroniser;
use Optionia\Connection\StateMachine;
use Optionia\Support\Cron;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * A sync updates the cache, or leaves it exactly as it was.
 *
 * @covers \Optionia\Config\Synchroniser
 */
final class SynchroniserTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
	}

	/**
	 * A document in the shape `GET /store/config` sends.
	 *
	 * @param int $version Config version.
	 * @return array<string, mixed>
	 */
	private function document( int $version = 7 ): array {
		return array(
			'schema_version' => 1,
			'config_version' => $version,
			'store_id'       => 'store-1',
			'option_sets'    => array( array( 'id' => 'set-a' ) ),
		);
	}

	/**
	 * A repository already holding a cached document.
	 */
	private function cached(): Repository {
		$repository = new Repository( $this->logger() );
		$repository->store( $this->document(), 'W/"store-1-7"' );

		return $repository;
	}

	/**
	 * A logger over real settings.
	 */
	private function logger(): Logger {
		return new Logger( new Settings() );
	}

	/**
	 * A client returning one prepared response.
	 *
	 * @param Response $response What the cloud answers.
	 * @param array    $captured Receives the request arguments, by reference.
	 */
	private function client( Response $response, ?array &$captured = null ): FetchesFromCloud {
		$client = $this->createMock( FetchesFromCloud::class );
		$client->method( 'get' )->willReturnCallback(
			static function ( string $path, array $query, array $headers ) use ( $response, &$captured ): Response {
				$captured = array(
					'path'    => $path,
					'query'   => $query,
					'headers' => $headers,
				);

				return $response;
			}
		);

		return $client;
	}

	/**
	 * Put the store in a connected state through a legal path.
	 */
	private function connect(): void {
		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );
	}

	/**
	 * Read the cache as the next request would — through a fresh instance.
	 *
	 * `Repository` memoises, so reusing the instance under test would answer
	 * from memory and pass even if the option had been emptied.
	 */
	private function next_request(): Repository {
		return new Repository( $this->logger() );
	}

	/**
	 * A changed document is stored, with its validator.
	 */
	public function test_a_new_document_is_cached(): void {
		$this->connect();

		$response = Response::success( 200, $this->document( 9 ), array( 'etag' => 'W/"store-1-9"' ) );

		$synchroniser = new Synchroniser(
			$this->client( $response ),
			new Repository( $this->logger() ),
			$this->logger()
		);

		$this->assertTrue( $synchroniser->sync() );

		$cached = $this->next_request();

		$this->assertSame( 9, $cached->config_version() );
		$this->assertSame( 'W/"store-1-9"', $cached->etag() );
	}

	/**
	 * **A 304 must not empty the cache.**
	 *
	 * `Response::is_ok()` is true for a 304 and its body is empty, so a
	 * synchroniser checking `is_ok()` first would store nothing over
	 * everything — on the most ordinary path there is, every fifteen minutes.
	 * Measured before the guards existed: version 7 became no configuration.
	 */
	public function test_not_modified_leaves_the_cache_intact(): void {
		$this->connect();
		$this->cached();

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 304, array(), array( 'etag' => 'W/"store-1-7"' ) ) ),
			$this->next_request(),
			$this->logger()
		);

		$this->assertTrue( $synchroniser->sync(), 'Nothing changed is a success.' );

		$cached = $this->next_request();

		$this->assertTrue( $cached->has_config() );
		$this->assertSame( 7, $cached->config_version() );
	}

	/**
	 * A 304 against an empty cache is a contradiction, not a success.
	 *
	 * "Nothing changed" is only meaningful relative to something held. With no
	 * cached document this would otherwise report success, mark the store
	 * healthy and never retry — a shop rendering nothing while every signal
	 * says it is fine. Measured before the check existed: `has_config = false`,
	 * state `connected`, outcome `unchanged`.
	 *
	 * Our own API cannot produce it — `matchesEtag` refuses a missing
	 * `If-None-Match` — but this trusts a status code from the network, and the
	 * cost of being wrong is silent.
	 */
	public function test_not_modified_without_a_cache_is_a_failure(): void {
		$this->connect();

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 304, array() ) ),
			new Repository( $this->logger() ),
			$this->logger()
		);

		$this->assertFalse( $synchroniser->sync(), 'Nothing cached means nothing was confirmed.' );
		$this->assertSame( StateMachine::ERROR, StateMachine::current() );

		$last = Synchroniser::last();

		$this->assertFalse( $last['ok'] );
		$this->assertSame( 'not_modified_without_cache', $last['outcome'] );
	}

	/**
	 * The validator is sent, so the cloud can answer 304 at all.
	 */
	public function test_the_cached_etag_is_sent_as_if_none_match(): void {
		$this->connect();
		$this->cached();

		$captured = null;

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 304, array() ), $captured ),
			$this->next_request(),
			$this->logger()
		);

		$synchroniser->sync();

		$this->assertSame( '/store/config', $captured['path'] );
		$this->assertSame( 'W/"store-1-7"', $captured['headers']['If-None-Match'] );
	}

	/**
	 * A first sync sends no validator.
	 *
	 * An empty `If-None-Match` costs a full document either way while looking
	 * like a conditional request.
	 */
	public function test_no_validator_is_sent_before_anything_is_cached(): void {
		$this->connect();

		$captured = null;

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 200, $this->document() ), $captured ),
			new Repository( $this->logger() ),
			$this->logger()
		);

		$synchroniser->sync();

		$this->assertArrayNotHasKey( 'If-None-Match', $captured['headers'] );
	}

	/**
	 * A failed sync keeps the storefront selling.
	 */
	public function test_a_failed_sync_leaves_the_cache_intact(): void {
		$this->connect();
		$this->cached();

		$synchroniser = new Synchroniser(
			$this->client( Response::failure( 500, 'server_error', 'Cloud is down.' ) ),
			$this->next_request(),
			$this->logger()
		);

		$this->assertFalse( $synchroniser->sync() );

		$cached = $this->next_request();

		$this->assertTrue( $cached->has_config(), 'AC3: the shop keeps its saved copy.' );
		$this->assertSame( 7, $cached->config_version() );
	}

	/**
	 * A failed sync moves a connected store to `ERROR`.
	 *
	 * The edge the cloud's audit coverage assigns to config sync, and which
	 * nothing produced until now — the settings screen carried a message for a
	 * state no code could reach.
	 */
	public function test_a_failed_sync_marks_the_store_erroring(): void {
		$this->connect();

		$synchroniser = new Synchroniser(
			$this->client( Response::failure( 500, 'server_error', 'Cloud is down.' ) ),
			new Repository( $this->logger() ),
			$this->logger()
		);

		$synchroniser->sync();

		$this->assertSame( StateMachine::ERROR, StateMachine::current() );
	}

	/**
	 * A later success recovers it.
	 */
	public function test_a_successful_sync_recovers_from_error(): void {
		$this->connect();
		// Something cached: a 304 against an empty cache is a contradiction and
		// is treated as a failure, so recovery has to be tested from a store
		// that actually holds a document.
		$this->cached();
		StateMachine::transition( StateMachine::ERROR );

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 304, array() ) ),
			$this->next_request(),
			$this->logger()
		);

		$synchroniser->sync();

		$this->assertSame( StateMachine::CONNECTED, StateMachine::current() );
	}

	/**
	 * A revoked store is not quietly reconnected by a sync.
	 *
	 * `REVOKED` is a more specific statement than "a sync failed", and telling
	 * a merchant to check their network would send them to fix the wrong thing.
	 */
	public function test_a_revoked_store_does_not_fetch_at_all(): void {
		$this->connect();
		StateMachine::on_unauthorized();

		// Never called: the credential has already been refused and will go on
		// being refused until the merchant reauthorises.
		$client = $this->createMock( FetchesFromCloud::class );
		$client->expects( $this->never() )->method( 'get' );

		$synchroniser = new Synchroniser( $client, new Repository( $this->logger() ), $this->logger() );

		$this->assertFalse( $synchroniser->sync() );
		$this->assertSame( StateMachine::REVOKED, StateMachine::current() );
	}

	/**
	 * Skipping is about wasted traffic, not about hiding the state.
	 *
	 * A revoked store runs this every fifteen minutes — ninety-six times a day
	 * against a circuit breaker shared with everything else. Measured before
	 * the skip existed: the circuit opened on the fifth run, and the breaker it
	 * opened is the one a merchant needs closed when they come to reconnect.
	 *
	 * `Connection\Heartbeat` still pings while revoked, deliberately: it runs
	 * once a day and is how a store notices a reconnection made from the
	 * dashboard. That signal is kept; only the hopeless traffic is dropped.
	 */
	public function test_a_revoked_store_does_not_open_the_circuit(): void {
		$this->connect();
		StateMachine::on_unauthorized();

		$client = $this->createMock( FetchesFromCloud::class );
		$client->method( 'get' )->willReturn( Response::failure( 401, 'http_401', 'Refused.' ) );

		$synchroniser = new Synchroniser( $client, new Repository( $this->logger() ), $this->logger() );

		for ( $run = 0; $run < 6; $run++ ) {
			$synchroniser->sync();
		}

		$this->assertArrayNotHasKey(
			Keys::OPTION_CIRCUIT_STATE,
			$GLOBALS['optionia_test_options'],
			'A store that cannot succeed should not spend the breaker budget trying.'
		);
	}

	/**
	 * A disconnected store holds no credential, so it does not ask.
	 */
	public function test_a_disconnected_store_does_not_sync(): void {
		$client = $this->createMock( FetchesFromCloud::class );
		$client->expects( $this->never() )->method( 'get' );

		$synchroniser = new Synchroniser( $client, new Repository( $this->logger() ), $this->logger() );

		$this->assertFalse( $synchroniser->sync() );
	}

	/**
	 * A document the cache refuses is a failed sync, not a silent one.
	 *
	 * An unsupported `schema_version` means the storefront is serving something
	 * older than the cloud holds, and the settings screen should say so.
	 */
	public function test_a_refused_document_is_recorded_as_a_failure(): void {
		$this->connect();
		$this->cached();

		$too_new = array(
			'schema_version' => 99,
			'config_version' => 9,
			'option_sets'    => array(),
		);

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 200, $too_new ) ),
			$this->next_request(),
			$this->logger()
		);

		$this->assertFalse( $synchroniser->sync() );
		$this->assertSame( 7, $this->next_request()->config_version(), 'The known-good copy stays.' );
		$this->assertSame( StateMachine::ERROR, StateMachine::current() );
	}

	/**
	 * The outcome is recorded for System Status.
	 */
	public function test_the_outcome_is_recorded(): void {
		$this->connect();
		$this->cached();

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 304, array() ) ),
			$this->next_request(),
			$this->logger()
		);

		$synchroniser->sync();

		$last = Synchroniser::last();

		$this->assertIsArray( $last );
		$this->assertTrue( $last['ok'] );
		$this->assertSame( 'unchanged', $last['outcome'] );
	}

	/**
	 * The scheduled event actually syncs.
	 *
	 * `Support\Cron` registers the listener; this asserts the listener does
	 * something. A `Cron::on_sync_due()` that had lost its delegation would
	 * leave the hook registered, the schedule intact and no configuration ever
	 * fetched — the placeholder state, invisible except as options that never
	 * update.
	 */
	public function test_the_scheduled_event_triggers_a_sync(): void {
		$this->connect();

		$client = $this->createMock( FetchesFromCloud::class );
		$client->expects( $this->once() )
			->method( 'get' )
			->willReturn( Response::success( 304, array() ) );

		$cron = new Cron(
			$this->logger(),
			new Synchroniser( $client, new Repository( $this->logger() ), $this->logger() )
		);

		$cron->on_sync_due();
	}

	/** Nothing is recorded before the first run. */
	public function test_last_is_null_before_any_sync(): void {
		$this->assertNull( Synchroniser::last() );
	}

	/** The recorded option is never autoloaded. */
	public function test_the_outcome_is_not_autoloaded(): void {
		$this->connect();

		$synchroniser = new Synchroniser(
			$this->client( Response::success( 304, array() ) ),
			new Repository( $this->logger() ),
			$this->logger()
		);

		$synchroniser->sync();

		$this->assertFalse( $GLOBALS['optionia_test_autoload'][ Keys::OPTION_LAST_SYNC ] );
	}
}
