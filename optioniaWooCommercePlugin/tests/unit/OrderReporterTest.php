<?php
/**
 * Order reporting to the cloud (M12.7).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Connection\StateMachine;
use Optionia\Reporting\OrderPayload;
use Optionia\Reporting\OrderQueue;
use Optionia\Reporting\OrderReporter;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Orders are queued at checkout and reported on cron — never the other way.
 *
 * @covers \Optionia\Reporting\OrderReporter
 */
final class OrderReporterTest extends TestCase {

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_orders']  = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_filters'] = array();

		$this->connect();
	}

	/** Drive the state machine to connected through a legal path. */
	private function connect(): void {
		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );
	}

	/**
	 * An order carrying one option.
	 *
	 * @param int $id Order id.
	 */
	private function order_with_options( int $id ): object {
		$order = optionia_test_order( $id );
		$item  = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, '{"finish":"lux"}', true );
		$item->add_meta_data( Keys::META_PRICE_DELTA, '99.00', true );
		$item->add_meta_data( 'Finish', 'lux', true );
		$order->items[] = $item;

		return $order;
	}

	/**
	 * A reporter whose transport answers as instructed.
	 *
	 * @param Response|null $response What the cloud returns; null for 200.
	 * @param array|null    $calls    Captured calls, by reference.
	 */
	private function reporter( ?Response $response = null, ?array &$calls = null ): OrderReporter {
		$calls  = array();
		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$calls, $response ): Response {
				$calls[] = array(
					'path' => $path,
					'body' => $body,
				);

				return $response ?? Response::success(
					200,
					array(
						'id'        => 'x',
						'duplicate' => false,
					)
				);
			}
		);

		$logger = new Logger( new Settings() );

		return new OrderReporter( $client, new OrderQueue( $logger ), new OrderPayload(), $logger );
	}

	/** The queue, for asserting what is waiting. */
	private function queue(): OrderQueue {
		return new OrderQueue( new Logger( new Settings() ) );
	}

	// --- The one hard rule ---------------------------------------------------

	/**
	 * 🔴 **Checkout does no network work at all.**
	 *
	 * M12.7's requirement is that a failure here be invisible to the customer,
	 * and this is the structural guarantee rather than a caught exception: a
	 * cloud that accepts connections and answers slowly still costs the customer
	 * that time. A timeout bounds the damage; it does not remove it.
	 *
	 * Asserted against a transport that fails the test if it is touched, so it
	 * cannot pass because the request happened to succeed.
	 */
	public function test_queueing_an_order_never_touches_the_network(): void {
		$this->order_with_options( 41 );

		$client = $this->createMock( PostsToCloud::class );
		$client->expects( $this->never() )->method( 'post' );

		$logger = new Logger( new Settings() );

		( new OrderReporter( $client, new OrderQueue( $logger ), new OrderPayload(), $logger ) )
			->queue( 41 );

		$this->assertSame( array( 41 ), $this->queue()->all() );
	}

	/**
	 * The status hooks are registered on the front end, not just admin.
	 *
	 * The transition fires inside the checkout request and the drain runs on
	 * cron; an admin-only registration would queue nothing and drain nothing.
	 */
	public function test_registers_for_both_reportable_statuses_and_cron(): void {
		$this->reporter()->register();

		$this->assertArrayHasKey( 'woocommerce_order_status_processing', $GLOBALS['optionia_test_actions'] );
		$this->assertArrayHasKey( 'woocommerce_order_status_completed', $GLOBALS['optionia_test_actions'] );
		$this->assertArrayHasKey( Keys::CRON_REPORT_ORDERS, $GLOBALS['optionia_test_actions'] );
	}

	// --- Reporting -----------------------------------------------------------

	/** A queued order is reported to the documented path. */
	public function test_reports_a_queued_order(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter( null, $calls );
		$reporter->queue( 41 );

		$this->assertSame( 1, $reporter->drain() );
		$this->assertSame( '/store/orders', $calls[0]['path'] );
		$this->assertSame( '41', $calls[0]['body']['external_order_id'] );
	}

	/** A reported order leaves the queue. */
	public function test_a_reported_order_leaves_the_queue(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter();
		$reporter->queue( 41 );
		$reporter->drain();

		$this->assertSame( array(), $this->queue()->all() );
	}

	/**
	 * **A reported order is marked on the order itself.**
	 *
	 * The queue is disposable; the order is the record. A status transition
	 * firing twice — a manual change, a gateway confirming again — must not
	 * re-queue an order the cloud already has.
	 */
	public function test_a_reported_order_is_not_queued_again(): void {
		$order = $this->order_with_options( 41 );

		$reporter = $this->reporter();
		$reporter->queue( 41 );
		$reporter->drain();

		$this->assertNotSame( '', $order->get_meta( Keys::META_REPORTED_AT ) );

		$reporter->queue( 41 );

		$this->assertSame( array(), $this->queue()->all() );
	}

	/** Several orders report in one run. */
	public function test_reports_several_orders_in_one_run(): void {
		foreach ( array( 41, 42, 43 ) as $id ) {
			$this->order_with_options( $id );
		}

		$reporter = $this->reporter();

		foreach ( array( 41, 42, 43 ) as $id ) {
			$reporter->queue( $id );
		}

		$this->assertSame( 3, $reporter->drain() );
		$this->assertSame( array(), $this->queue()->all() );
	}

	/**
	 * A run is bounded, so a backlog cannot time out the cron request.
	 *
	 * The rest stay queued and clear over subsequent runs.
	 */
	public function test_a_run_is_bounded(): void {
		$reporter = $this->reporter();

		for ( $id = 1; $id <= OrderReporter::BATCH_SIZE + 5; $id++ ) {
			$this->order_with_options( $id );
			$reporter->queue( $id );
		}

		$this->assertSame( OrderReporter::BATCH_SIZE, $reporter->drain() );
		$this->assertCount( 5, $this->queue()->all() );
	}

	// --- Failure ------------------------------------------------------------

	/**
	 * **A transient failure keeps the order queued.**
	 *
	 * The whole point of the queue: an outage delays a report rather than
	 * dropping it.
	 */
	public function test_a_transient_failure_keeps_the_order_queued(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter( Response::failure( 503, 'UNAVAILABLE', 'down' ) );
		$reporter->queue( 41 );

		$this->assertSame( 0, $reporter->drain() );
		$this->assertSame( array( 41 ), $this->queue()->all() );
	}

	/** A rate limit is transient too — the report is delayed, not lost. */
	public function test_a_rate_limit_keeps_the_order_queued(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter( Response::failure( 429, 'RATE_LIMITED', 'slow down' ) );
		$reporter->queue( 41 );
		$reporter->drain();

		$this->assertSame( array( 41 ), $this->queue()->all() );
	}

	/** A revoked credential is transient: reconnecting reports the backlog. */
	public function test_an_unauthorized_response_keeps_the_order_queued(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter( Response::failure( 401, 'UNAUTHENTICATED', 'no' ) );
		$reporter->queue( 41 );
		$reporter->drain();

		$this->assertSame( array( 41 ), $this->queue()->all() );
	}

	/**
	 * **A rejected order is dropped rather than retried forever.**
	 *
	 * A 400 means the plugin and the API disagree about the payload. That fails
	 * identically on every retry, so keeping it would hold the whole queue
	 * behind one bad row — every later order stuck behind it.
	 */
	public function test_a_rejected_order_is_dropped(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter( Response::failure( 400, 'VALIDATION_FAILED', 'bad' ) );
		$reporter->queue( 41 );

		$this->assertSame( 0, $reporter->drain() );
		$this->assertSame( array(), $this->queue()->all() );
	}

	/**
	 * A failure stops the run rather than working through the batch.
	 *
	 * The cause is almost always the same for every order, so continuing would
	 * spend the run proving it repeatedly and hand the circuit breaker nine
	 * more failures.
	 */
	public function test_a_transient_failure_stops_the_run(): void {
		foreach ( array( 41, 42, 43 ) as $id ) {
			$this->order_with_options( $id );
		}

		$reporter = $this->reporter( Response::failure( 503, 'UNAVAILABLE', 'down' ), $calls );

		foreach ( array( 41, 42, 43 ) as $id ) {
			$reporter->queue( $id );
		}

		$reporter->drain();

		$this->assertCount( 1, $calls, 'The run should stop at the first transient failure.' );
		$this->assertCount( 3, $this->queue()->all() );
	}

	/** A disconnected store does not try, and keeps its backlog. */
	public function test_a_disconnected_store_does_not_report(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter( null, $calls );
		$reporter->queue( 41 );

		StateMachine::transition( StateMachine::DISCONNECTED );

		$this->assertSame( 0, $reporter->drain() );
		$this->assertSame( array(), $calls );
		$this->assertSame( array( 41 ), $this->queue()->all() );
	}

	/** An order deleted after queueing is dropped, not retried. */
	public function test_an_order_deleted_after_queueing_is_dropped(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter();
		$reporter->queue( 41 );

		unset( $GLOBALS['optionia_test_orders'][41] );

		$this->assertSame( 0, $reporter->drain() );
		$this->assertSame( array(), $this->queue()->all() );
	}

	// --- Boundaries ----------------------------------------------------------

	/** An invalid id is ignored. */
	public function test_an_invalid_order_id_is_ignored(): void {
		$reporter = $this->reporter();
		$reporter->queue( 0 );
		$reporter->queue( 'nonsense' );

		$this->assertSame( array(), $this->queue()->all() );
	}

	/** An empty queue costs no request. */
	public function test_an_empty_queue_makes_no_request(): void {
		$reporter = $this->reporter( null, $calls );

		$this->assertSame( 0, $reporter->drain() );
		$this->assertSame( array(), $calls );
	}

	/** The run's outcome is recorded for System Status. */
	public function test_records_the_run_for_system_status(): void {
		$this->order_with_options( 41 );

		$reporter = $this->reporter();
		$reporter->queue( 41 );
		$reporter->drain();

		$last = OrderReporter::last();

		$this->assertSame( 1, $last['reported'] );
		$this->assertSame( 0, $last['failed'] );
		$this->assertSame( 0, $last['remaining'] );
	}
}
