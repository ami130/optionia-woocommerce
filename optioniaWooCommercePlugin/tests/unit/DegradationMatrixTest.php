<?php
/**
 * The degradation matrix, stated rather than implied (M9.6).
 *
 * Every row below is covered somewhere in this suite already — by the tests for
 * the synchroniser, the cache and the state machine. That is not the same as
 * the matrix being *asserted*: a guarantee spread across six files is one nobody
 * can check, and the acceptance it adds up to has never been written down.
 *
 * The one that matters most is the last: **with the cloud entirely stopped, a
 * shop keeps selling.** That is the promise the whole architecture rests on, and
 * before this file nothing tested it end to end.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Repository;
use Optionia\Config\Synchroniser;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Six conditions, one promise: the storefront keeps its options.
 *
 * @covers \Optionia\Config\Synchroniser
 * @covers \Optionia\Config\Repository
 */
final class DegradationMatrixTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
	}

	/**
	 * A logger over real settings.
	 */
	private function logger(): Logger {
		return new Logger( new Settings() );
	}

	/**
	 * A connected store serving a cached document.
	 */
	private function selling_shop(): Repository {
		update_option( Keys::OPTION_STORE_TOKEN, 'live-credential', false );

		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );

		$repository = new Repository( $this->logger() );

		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array( array( 'id' => 'set-a' ) ),
			),
			'W/"store-7"'
		);

		return $repository;
	}

	/**
	 * Run one sync against a cloud that answers as described.
	 *
	 * @param array<string, mixed> $http What `wp_remote_request` returns.
	 */
	private function sync_against( array $http ): bool {
		$GLOBALS['optionia_test_http'] = $http;

		$settings = new Settings();
		$logger   = $this->logger();

		$client = new Client(
			$settings,
			$logger,
			new CircuitBreaker( $logger ),
			new ResponseValidator( $logger )
		);

		return ( new Synchroniser( $client, new Repository( $logger ), $logger ) )->sync();
	}

	/**
	 * What a storefront would render, read as the next request would.
	 *
	 * A fresh instance deliberately: `Repository` memoises, so reusing one from
	 * before the sync would answer from memory and pass regardless.
	 */
	private function storefront_sees(): ?array {
		return ( new Repository( $this->logger() ) )->get();
	}

	/**
	 * Row 1: API unreachable → serve cache; log; retry with backoff.
	 *
	 * A `500` deliberately, and it costs a few seconds: `is_retryable()` retries
	 * every `5xx`, so this sleeps through two real backoff delays. That is the
	 * row being tested — "retry with backoff" is half of what it promises — so
	 * the time is the assertion working rather than waste.
	 */
	public function test_api_unreachable_keeps_serving(): void {
		$this->selling_shop();

		$this->assertFalse(
			$this->sync_against(
				array(
					'status'  => 500,
					'body'    => '{"error":{"code":"x","message":"down"}}',
					'headers' => array(),
				)
			)
		);

		$this->assertNotNull( $this->storefront_sees() );
		$this->assertSame( StateMachine::ERROR, StateMachine::current(), 'And says so.' );
	}

	/** Row 2: token revoked → serve cache; notice to reconnect. */
	public function test_a_revoked_credential_keeps_serving(): void {
		$this->selling_shop();
		StateMachine::listen();

		$this->sync_against(
			array(
				'status'  => 401,
				'body'    => '{"error":{"code":"unauthorized","message":"revoked"}}',
				'headers' => array(),
			)
		);

		$this->assertNotNull( $this->storefront_sees() );
		$this->assertSame( StateMachine::REVOKED, StateMachine::current() );
	}

	/** Row 3: config malformed → keep the previous good version. */
	public function test_a_malformed_document_keeps_the_previous_version(): void {
		$this->selling_shop();

		$this->assertFalse(
			$this->sync_against(
				array(
					'status'  => 200,
					'body'    => '{"data":{"config_version":9},"meta":{}}',
					'headers' => array(),
				)
			)
		);

		$this->assertSame( 7, ( new Repository( $this->logger() ) )->config_version() );
	}

	/** Row 4: `schema_version` too new → keep last good; ask for an update. */
	public function test_a_too_new_schema_keeps_the_last_good_copy(): void {
		$this->selling_shop();

		$this->sync_against(
			array(
				'status'  => 200,
				'body'    => '{"data":{"schema_version":99,"config_version":9,"option_sets":[]},"meta":{}}',
				'headers' => array(),
			)
		);

		$this->assertSame( 7, ( new Repository( $this->logger() ) )->config_version() );
		$this->assertNotNull( Repository::refused_schema(), 'And the merchant is told.' );
	}

	/**
	 * Row 5: no cache at all → render nothing, and no error to the customer.
	 *
	 * A fresh install serves product pages before its first sync. `get()`
	 * returning null is the renderer's cue to render nothing — not an exception
	 * that would surface on a customer's page.
	 */
	public function test_a_fresh_install_renders_nothing_without_erroring(): void {
		$repository = new Repository( $this->logger() );

		$this->assertNull( $repository->get() );
		$this->assertFalse( $repository->has_config() );
	}

	/**
	 * **The acceptance: with the cloud entirely stopped, a shop keeps selling.**
	 *
	 * Not one failed request — the cloud gone, for as long as it takes a
	 * merchant to notice and a provider to fix. Every scheduled sync fails, the
	 * circuit breaker opens, and the only thing that matters is that the options
	 * a customer sees are still there.
	 *
	 * This is the promise in AC3 and in D5's answer to the merchant's central
	 * objection. Before this test it was true by construction and asserted
	 * nowhere.
	 */
	public function test_the_storefront_survives_the_cloud_being_stopped(): void {
		$this->selling_shop();

		$before = $this->storefront_sees();

		// A day of failed syncs, cooldown elapsing between each.
		for ( $attempt = 0; $attempt < 96; $attempt++ ) {
			$state = get_option( Keys::OPTION_CIRCUIT_STATE, null );

			if ( is_array( $state ) && $state['opened_at'] > 0 ) {
				$state['opened_at'] = time() - DAY_IN_SECONDS;
				update_option( Keys::OPTION_CIRCUIT_STATE, $state, false );
			}

			/**
			 * A non-retryable failure, deliberately.
			 *
			 * `is_retryable()` retries transport errors, `429` and every `5xx`,
			 * so a realistic outage status makes each iteration sleep through
			 * two real backoff delays — minutes of wall clock for a test whose
			 * subject is the cache, not the retry schedule. Retries are covered
			 * where they belong, in `Api\Client`.
			 */
			$this->sync_against(
				array(
					'status'  => 403,
					'body'    => '{"error":{"code":"down","message":"gone"}}',
					'headers' => array(),
				)
			);
		}

		$this->assertEquals(
			$before,
			$this->storefront_sees(),
			'Ninety-six failed syncs must leave the shop exactly as it was.'
		);
		$this->assertSame( 7, ( new Repository( $this->logger() ) )->config_version() );
	}

	/**
	 * And recovers by itself when the cloud returns.
	 *
	 * No merchant action, no support ticket: the next successful sync moves the
	 * store out of `ERROR` and takes the new configuration.
	 */
	public function test_the_shop_recovers_when_the_cloud_returns(): void {
		$this->selling_shop();

		$this->sync_against(
			array(
				'status'  => 500,
				'body'    => '{"error":{"code":"x","message":"y"}}',
				'headers' => array(),
			)
		);

		$this->assertSame( StateMachine::ERROR, StateMachine::current() );

		$this->assertTrue(
			$this->sync_against(
				array(
					'status'  => 200,
					'body'    => '{"data":{"schema_version":1,"config_version":9,"option_sets":[]},"meta":{}}',
					'headers' => array( 'etag' => 'W/"store-9"' ),
				)
			)
		);

		$this->assertSame( StateMachine::CONNECTED, StateMachine::current() );
		$this->assertSame( 9, ( new Repository( $this->logger() ) )->config_version() );
	}
}
