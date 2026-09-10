<?php
/**
 * Reports completed orders to the cloud (M12.7).
 *
 * ## The one hard rule: never block checkout
 *
 * A failure here must be invisible to the customer. That is achieved
 * structurally rather than by catching exceptions: **the checkout request does
 * no network work at all.** `queue()` appends an id to an option and returns;
 * `drain()` does the HTTP, on cron, where nothing is waiting on it.
 *
 * Wrapping a POST in a try/catch inside checkout would look equivalent and is
 * not — a cloud that accepts connections and answers slowly still costs the
 * customer that time, and an outage would slow every shop at once. Timeouts
 * bound the damage; they do not remove it.
 *
 * ## Why the order carries its own reported marker
 *
 * `Keys::META_REPORTED_AT` lives on the order, not in the queue. WooCommerce can
 * fire a status transition more than once -- a manual status change, a payment
 * gateway confirming twice, a merchant re-saving -- and an order already
 * reported must not be queued again. The queue is disposable; the order is the
 * record, so the record holds the fact.
 *
 * The cloud is idempotent on the order id regardless, so a double report is
 * harmless. This makes it rare rather than relying on the far end to absorb it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Reporting;

use Optionia\Api\PostsToCloud;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Queues orders at checkout and reports them on cron.
 */
final class OrderReporter {

	/**
	 * API path. The `v1` prefix lives in the base URL, as with every other call.
	 */
	private const PATH = '/store/orders';

	/**
	 * The status transitions that mean "this order is real".
	 *
	 * `processing` and `completed` only. `pending` and `on-hold` are orders that
	 * may never be paid, and reporting them would count revenue that never
	 * arrives; `cancelled`, `refunded` and `failed` are the same in reverse.
	 *
	 * Both are listed because a shop selling downloads goes straight to
	 * `completed` without passing through `processing`, and one that captures
	 * payment later does the opposite. An order reaching both reports once, on
	 * the first -- the marker on the order is what makes that true.
	 */
	private const REPORTABLE_STATUSES = array( 'processing', 'completed' );

	/**
	 * The most orders reported in one cron run.
	 *
	 * A drain runs inside a cron request, which has a wall clock like any other.
	 * Ten reports at a second each is well inside it, and a backlog simply takes
	 * several runs -- fifteen minutes apart, so a large backlog still clears in
	 * hours without ever risking a timeout mid-run.
	 */
	public const BATCH_SIZE = 10;

	/**
	 * Cloud transport.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * The queue of unreported orders.
	 *
	 * @var OrderQueue
	 */
	private OrderQueue $queue;

	/**
	 * Builds the report body.
	 *
	 * @var OrderPayload
	 */
	private OrderPayload $payload;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param PostsToCloud $client  Cloud transport.
	 * @param OrderQueue   $queue   Queue of unreported orders.
	 * @param OrderPayload $payload Report body builder.
	 * @param Logger       $logger  Logger.
	 */
	public function __construct(
		PostsToCloud $client,
		OrderQueue $queue,
		OrderPayload $payload,
		Logger $logger
	) {
		$this->client  = $client;
		$this->queue   = $queue;
		$this->payload = $payload;
		$this->logger  = $logger;
	}

	/**
	 * Register the checkout and cron listeners.
	 */
	public function register(): void {
		foreach ( self::REPORTABLE_STATUSES as $status ) {
			add_action( 'woocommerce_order_status_' . $status, array( $this, 'queue' ) );
		}

		add_action( Keys::CRON_REPORT_ORDERS, array( $this, 'drain' ) );
	}

	/**
	 * Note an order for later reporting.
	 *
	 * Runs inside the checkout request, so it does exactly one bounded thing.
	 *
	 * @param mixed $order_id WooCommerce order id.
	 */
	public function queue( $order_id ): void {
		$order_id = is_numeric( $order_id ) ? (int) $order_id : 0;

		if ( $order_id <= 0 ) {
			return;
		}

		$order = $this->order( $order_id );

		if ( null === $order ) {
			return;
		}

		if ( $this->already_reported( $order ) ) {
			return;
		}

		$this->queue->push( $order_id );
	}

	/**
	 * Report as many queued orders as one run allows.
	 *
	 * @return int How many were accepted.
	 */
	public function drain(): int {
		if ( StateMachine::DISCONNECTED === StateMachine::current() ) {
			/*
			 * No credential, so every POST would be a guaranteed 401. The queue
			 * is left intact: a store that reconnects reports its backlog.
			 */
			return 0;
		}

		$queued = array_slice( $this->queue->all(), 0, self::BATCH_SIZE );

		if ( array() === $queued ) {
			return 0;
		}

		$reported = 0;
		$failed   = 0;

		foreach ( $queued as $order_id ) {
			$outcome = $this->report( $order_id );

			if ( self::OUTCOME_RETRY === $outcome ) {
				++$failed;

				/*
				 * Stop on the first retryable failure rather than working
				 * through the batch. The cause is almost always the same for
				 * every order -- the cloud is down, or the credential is bad --
				 * so continuing would spend the whole run proving it repeatedly
				 * and hand the circuit breaker nine more failures.
				 */
				break;
			}

			if ( self::OUTCOME_ACCEPTED === $outcome ) {
				++$reported;
			}

			// Accepted or permanently rejected: either way it must leave.
			$this->queue->forget( $order_id );
		}

		$this->record( $reported, $failed );

		return $reported;
	}

	/**
	 * The order was recorded by the cloud.
	 */
	private const OUTCOME_ACCEPTED = 'accepted';

	/**
	 * The cloud refused it, and will refuse it again.
	 */
	private const OUTCOME_REJECTED = 'rejected';

	/**
	 * A transient failure; the next run should try again.
	 */
	private const OUTCOME_RETRY = 'retry';

	/**
	 * Report one order.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return string One of the OUTCOME_* constants.
	 */
	private function report( int $order_id ): string {
		$order = $this->order( $order_id );

		if ( null === $order ) {
			/*
			 * Deleted since it was queued. Nothing to report and nothing to
			 * retry -- dropping it is the only correct outcome.
			 */
			return self::OUTCOME_REJECTED;
		}

		if ( $this->already_reported( $order ) ) {
			return self::OUTCOME_REJECTED;
		}

		$body = $this->payload->build( $order );

		if ( null === $body ) {
			return self::OUTCOME_REJECTED;
		}

		$response = $this->client->post( self::PATH, $body );

		if ( $response->is_ok() ) {
			$this->mark_reported( $order );

			return self::OUTCOME_ACCEPTED;
		}

		$status = $response->status();

		/*
		 * A 4xx other than 429 is this order being wrong, not the cloud being
		 * unavailable: a malformed field fails identically forever, and retrying
		 * it would hold the queue permanently behind one bad row. It is dropped
		 * loudly rather than quietly, because a 400 here means the plugin and
		 * the API disagree about the payload -- which is a bug, not an outage.
		 */
		if ( $status >= 400 && $status < 500 && 429 !== $status && 401 !== $status ) {
			$this->logger->error(
				'Order report rejected; dropping it.',
				array(
					'order_id' => $order_id,
					'status'   => $status,
				)
			);

			return self::OUTCOME_REJECTED;
		}

		$this->logger->warning(
			'Order report failed; will retry.',
			array(
				'order_id' => $order_id,
				'status'   => $status,
			)
		);

		return self::OUTCOME_RETRY;
	}

	/**
	 * Whether this order has already been reported.
	 *
	 * @param object $order A `WC_Order`.
	 */
	private function already_reported( object $order ): bool {
		if ( ! method_exists( $order, 'get_meta' ) ) {
			return false;
		}

		$marker = $order->get_meta( Keys::META_REPORTED_AT );

		return is_scalar( $marker ) && '' !== (string) $marker;
	}

	/**
	 * Record that the cloud has this order.
	 *
	 * @param object $order A `WC_Order`.
	 */
	private function mark_reported( object $order ): void {
		if ( ! method_exists( $order, 'update_meta_data' ) || ! method_exists( $order, 'save' ) ) {
			return;
		}

		$order->update_meta_data( Keys::META_REPORTED_AT, gmdate( 'c' ) );
		$order->save();
	}

	/**
	 * Load an order.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return object|null
	 */
	private function order( int $order_id ): ?object {
		if ( ! function_exists( 'wc_get_order' ) ) {
			return null;
		}

		$order = wc_get_order( $order_id );

		return is_object( $order ) ? $order : null;
	}

	/**
	 * Record the run's outcome for System Status.
	 *
	 * @param int $reported How many the cloud accepted.
	 * @param int $failed   How many failed transiently.
	 */
	private function record( int $reported, int $failed ): void {
		update_option(
			Keys::OPTION_LAST_ORDER_REPORT,
			array(
				'at'        => time(),
				'reported'  => $reported,
				'failed'    => $failed,
				'remaining' => $this->queue->count(),
			),
			false
		);
	}

	/**
	 * The last recorded run, or null when none has happened.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function last(): ?array {
		$entry = get_option( Keys::OPTION_LAST_ORDER_REPORT, null );

		return is_array( $entry ) ? $entry : null;
	}
}
