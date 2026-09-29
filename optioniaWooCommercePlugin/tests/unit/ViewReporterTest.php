<?php
/**
 * Draining option view counts to the cloud (M25.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Analytics\ViewCollector;
use Optionia\Analytics\ViewReporter;
use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * The cron drain, and what it does when the cloud refuses.
 *
 * 🔴 **The clear is the load-bearing step.** The cloud ADDS what arrives, so
 * clearing before a confirmed 2xx loses counts and clearing after a failure
 * loses them silently. A failed drain simply resends — which is the whole
 * idempotency story, and the half this class owns.
 *
 * @covers \Optionia\Analytics\ViewReporter
 */
final class ViewReporterTest extends TestCase {

	/**
	 * Calls the transport recorded.
	 *
	 * @var array<int, array<string, mixed>>
	 */
	private array $calls = array();

	/**
	 * Responses to hand back, in order.
	 *
	 * @var array<int, Response>
	 */
	private array $responses = array();

	/**
	 * Reset the option store and the recorded calls.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();

		$this->calls     = array();
		$this->responses = array();
	}

	/** A reporter whose transport records every call. */
	private function reporter(): ViewReporter {
		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			function ( string $path, array $body ): Response {
				$this->calls[] = array(
					'path' => $path,
					'body' => $body,
				);

				$queued = array_shift( $this->responses );

				return $queued ?? Response::success( 200, array( 'recorded' => count( $body['views'] ?? array() ) ) );
			}
		);

		return new ViewReporter(
			new ViewCollector(),
			$client,
			new Logger( new Settings() )
		);
	}

	/** Put some counts where the drain will find them. */
	private function accumulate( int $views = 1, string $option = 'engraving' ): void {
		$collector = new ViewCollector();

		for ( $i = 0; $i < $views; $i++ ) {
			$collector->add( 'set-1', array( $option ), '2026-09-29' );
		}
	}

	/** 🔴 The whole point: what accumulated reaches the cloud. */
	public function test_it_sends_what_accumulated(): void {
		$this->accumulate( 5 );

		$this->reporter()->drain();

		$this->assertCount( 1, $this->calls );
		$this->assertSame( '/store/views', $this->calls[0]['path'] );
		$this->assertSame( 5, $this->calls[0]['body']['views'][0]['views'] );
	}

	/** 🔴 And is forgotten once the cloud has it, so it is never double-counted. */
	public function test_it_clears_the_counts_the_cloud_accepted(): void {
		$this->accumulate( 3 );

		$this->reporter()->drain();

		$this->assertSame( array(), ( new ViewCollector() )->pending() );
	}

	/**
	 * 🔴 **A transient failure keeps the counts.** The cloud adds what arrives,
	 * so discarding them on a 500 would lose a day's traffic for a problem that
	 * resolves itself.
	 */
	public function test_it_keeps_the_counts_when_the_cloud_is_unavailable(): void {
		$this->accumulate( 4 );
		$this->responses[] = Response::failure( 503, 'SERVICE_UNAVAILABLE', 'Down.' );

		$this->reporter()->drain();

		$pending = ( new ViewCollector() )->pending();

		$this->assertCount( 1, $pending );
		$this->assertSame( 4, $pending[0]['views'] );
	}

	/** ⚠️ A 429 is transient too — the plugin backs off rather than dropping. */
	public function test_it_keeps_the_counts_when_throttled(): void {
		$this->accumulate( 2 );
		$this->responses[] = Response::failure( 429, 'TOO_MANY_REQUESTS', 'Slow down.' );

		$this->reporter()->drain();

		$this->assertCount( 1, ( new ViewCollector() )->pending() );
	}

	/** ⚠️ And a 401, because a credential can be rotated back into working order. */
	public function test_it_keeps_the_counts_when_unauthorised(): void {
		$this->accumulate( 2 );
		$this->responses[] = Response::failure( 401, 'UNAUTHENTICATED', 'No.' );

		$this->reporter()->drain();

		$this->assertCount( 1, ( new ViewCollector() )->pending() );
	}

	/**
	 * 🔴 **A 400 is PERMANENT and the batch is dropped.** A malformed row fails
	 * identically for ever, and retrying it would hold every later count behind
	 * it — the same rule `OrderReporter` follows, for the same reason.
	 */
	public function test_it_drops_a_batch_the_cloud_calls_malformed(): void {
		$this->accumulate( 2 );
		$this->responses[] = Response::failure( 400, 'VALIDATION_FAILED', 'Bad day.' );

		$this->reporter()->drain();

		$this->assertSame( array(), ( new ViewCollector() )->pending() );
	}

	/** 📌 Nothing accumulated means no request at all. */
	public function test_it_sends_nothing_when_there_is_nothing_to_send(): void {
		$this->reporter()->drain();

		$this->assertSame( array(), $this->calls );
	}

	/**
	 * ⚠️ **Only what was SENT is cleared.** A beacon arriving during the drain
	 * has already incremented a count, and clearing wholesale would discard a
	 * view the customer really made.
	 */
	public function test_it_leaves_a_count_that_arrived_during_the_drain(): void {
		$this->accumulate( 2 );

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			function (): Response {
				// A customer views the page while the request is in flight.
				( new ViewCollector() )->add( 'set-1', array( 'engraving' ), '2026-09-29' );

				return Response::success( 200, array( 'recorded' => 1 ) );
			}
		);

		( new ViewReporter( new ViewCollector(), $client, new Logger( new Settings() ) ) )->drain();

		$pending = ( new ViewCollector() )->pending();

		$this->assertCount( 1, $pending );
		$this->assertSame( 1, $pending[0]['views'] );
	}

	/** 📌 The outcome is recorded for System Status. */
	public function test_it_records_the_outcome(): void {
		$this->accumulate( 1 );

		$this->reporter()->drain();

		$this->assertArrayHasKey( Keys::OPTION_LAST_VIEW_REPORT, $GLOBALS['optionia_test_options'] );
		$this->assertSame( 1, $GLOBALS['optionia_test_options'][ Keys::OPTION_LAST_VIEW_REPORT ]['reported'] );
	}
}
