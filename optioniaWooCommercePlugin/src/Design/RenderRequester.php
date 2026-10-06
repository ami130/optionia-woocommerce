<?php
/**
 * Asking the cloud for the print file a designed order line needs (M26e.4).
 *
 * ## Why a queue and a cron, not a call at checkout
 *
 * 🔴 **M26e.6's first rule: never block a sale on artwork generation.** The
 * checkout hook does one bounded thing — note the order — and this does the
 * asking later. A cloud outage then costs a late print file rather than a lost
 * purchase, and AC3's ban on network calls during a customer-facing render is
 * honoured because nothing here runs on a page render.
 *
 * ## Why the request is idempotent
 *
 * ⚠️ **A retry must not produce a second file**, which M26e.4 states as a
 * requirement. Two guards hold it: the cloud keys on `line_ref` and answers the
 * existing job, and this records the id it was given so a line already carrying
 * one is never asked about again. The second matters because the first only
 * helps once a response arrives — and the common failure is a response sent but
 * never received.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Design;

use Optionia\Api\Client;
use Optionia\Connection\StateMachine;
use Optionia\Reporting\OrderQueue;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Drains the render queue, asking the cloud for each designed line.
 */
final class RenderRequester {

	/**
	 * Orders per run.
	 *
	 * 📌 **Ten, matching the order reporter.** A run holds a PHP request open,
	 * and a merchant's cron is shared with everything else on the site.
	 */
	private const BATCH_SIZE = 10;

	/**
	 * The canvas a print file is rendered at.
	 *
	 * ⚠️ **Fixed for now, and that is a recorded limitation rather than a
	 * decision.** M26e.4 asks for merchant-configurable resolution and format;
	 * until that exists, a square 2000px canvas is a defensible default — well
	 * inside the 36-megapixel ceiling, and large enough for the print sizes
	 * this feature is sold for.
	 */
	private const CANVAS = 2000;

	/**
	 * API client.
	 *
	 * @var Client
	 */
	private Client $client;

	/**
	 * Builds the scene for a line.
	 *
	 * @var LineScene
	 */
	private LineScene $scenes;

	/**
	 * Render queue.
	 *
	 * @var OrderQueue
	 */
	private OrderQueue $queue;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Client     $client API client.
	 * @param LineScene  $scenes Scene builder.
	 * @param OrderQueue $queue  Render queue.
	 * @param Logger     $logger Logger.
	 */
	public function __construct( Client $client, LineScene $scenes, OrderQueue $queue, Logger $logger ) {
		$this->client = $client;
		$this->scenes = $scenes;
		$this->queue  = $queue;
		$this->logger = $logger;
	}

	/**
	 * Register the checkout and cron listeners.
	 */
	public function register(): void {
		add_action( 'woocommerce_checkout_order_processed', array( $this, 'queue' ) );
		add_action( Keys::CRON_RENDER_FILES, array( $this, 'drain' ) );
	}

	/**
	 * Note an order for later rendering.
	 *
	 * Runs inside the checkout request, so it does exactly one bounded thing.
	 *
	 * @param mixed $order_id WooCommerce order id.
	 */
	public function queue( $order_id ): void {
		$order_id = is_numeric( $order_id ) ? (int) $order_id : 0;

		if ( $order_id > 0 ) {
			$this->queue->push( $order_id );
		}
	}

	/**
	 * Ask the cloud for every queued order's print files.
	 *
	 * @return int How many renders were requested.
	 */
	public function drain(): int {
		if ( StateMachine::DISCONNECTED === StateMachine::current() ) {
			/*
			 * No credential, so every request would be a guaranteed 401. The
			 * queue is left intact: a store that reconnects asks for its
			 * backlog.
			 */
			return 0;
		}

		$queued = array_slice( $this->queue->all(), 0, self::BATCH_SIZE );

		if ( array() === $queued ) {
			return 0;
		}

		$requested = 0;

		foreach ( $queued as $order_id ) {
			$outcome = $this->request_for( $order_id );

			if ( null === $outcome ) {
				/*
				 * ⚠️ **Stop on the first retryable failure rather than working
				 * through the batch.** The cause is almost always the same for
				 * every order — the cloud is down, or the credential is bad —
				 * so continuing would spend the run proving it repeatedly and
				 * hand the circuit breaker nine more failures.
				 */
				break;
			}

			$requested += $outcome;

			$this->queue->forget( $order_id );
		}

		return $requested;
	}

	/**
	 * Request every designed line on one order.
	 *
	 * @param int $order_id WooCommerce order id.
	 *
	 * @return int|null Renders requested, or null on a retryable failure.
	 */
	private function request_for( int $order_id ): ?int {
		$order = $this->order( $order_id );

		if ( null === $order ) {
			/*
			 * 📌 **A missing order is not retryable.** It was deleted between
			 * checkout and this run; returning 0 lets the queue forget it
			 * rather than asking for ever.
			 */
			return 0;
		}

		$existing  = $this->render_ids( $order );
		$requested = 0;

		foreach ( $order->get_items() as $raw_id => $item ) {
			$item_id = (int) $raw_id;

			if ( isset( $existing[ $item_id ] ) ) {
				// Already has a render: a retry must not produce a second file.
				continue;
			}

			$scene = $this->scenes->for_item( $item, self::CANVAS );

			if ( null === $scene ) {
				continue;
			}

			$response = $this->client->post(
				'/store/renders',
				array(
					'line_ref' => $order_id . ':' . $item_id,
					'scene'    => $scene,
					'width'    => self::CANVAS,
					'height'   => self::CANVAS,
				)
			);

			if ( ! $response->is_ok() ) {
				if ( $this->is_retryable( $response->status() ) ) {
					return null;
				}

				/*
				 * ⚠️ **A 4xx is a real answer.** The scene was refused — too
				 * large, or undrawable — and asking again will be refused
				 * identically. Logged and skipped so one bad line does not
				 * block every other line on the order.
				 */
				$this->logger->warning(
					'The cloud refused a render request.',
					array(
						'order'  => $order_id,
						'line'   => $item_id,
						'status' => $response->status(),
						'code'   => $response->error_code(),
					)
				);

				continue;
			}

			$data = $response->data();
			$id   = isset( $data['id'] ) && is_scalar( $data['id'] ) ? (string) $data['id'] : '';

			if ( '' === $id ) {
				continue;
			}

			$existing[ $item_id ] = $id;
			++$requested;
		}

		if ( $requested > 0 ) {
			$this->store_render_ids( $order, $existing );
		}

		return $requested;
	}

	/**
	 * Render ids already recorded on an order, keyed by line item id.
	 *
	 * @param object $order WooCommerce order.
	 *
	 * @return array<int, string>
	 */
	private function render_ids( object $order ): array {
		if ( ! method_exists( $order, 'get_meta' ) ) {
			return array();
		}

		$stored = json_decode( (string) $order->get_meta( Keys::META_RENDER_IDS, true ), true );

		if ( ! is_array( $stored ) ) {
			return array();
		}

		$out = array();

		foreach ( $stored as $item_id => $render_id ) {
			if ( is_numeric( $item_id ) && is_scalar( $render_id ) && '' !== (string) $render_id ) {
				$out[ (int) $item_id ] = (string) $render_id;
			}
		}

		return $out;
	}

	/**
	 * Record the cloud's render ids on the order.
	 *
	 * @param object             $order WooCommerce order.
	 * @param array<int, string> $ids   Line item id to render id.
	 */
	private function store_render_ids( object $order, array $ids ): void {
		if ( ! method_exists( $order, 'update_meta_data' ) || ! method_exists( $order, 'save' ) ) {
			return;
		}

		$order->update_meta_data( Keys::META_RENDER_IDS, (string) wp_json_encode( $ids ) );
		$order->save();
	}

	/**
	 * Whether a failed response is worth retrying.
	 *
	 * @param int $status HTTP status, or 0 for a transport failure.
	 */
	private function is_retryable( int $status ): bool {
		return 0 === $status || 429 === $status || $status >= 500;
	}

	/**
	 * Load an order.
	 *
	 * @param int $order_id WooCommerce order id.
	 */
	private function order( int $order_id ): ?object {
		if ( ! function_exists( 'wc_get_order' ) ) {
			return null;
		}

		$order = wc_get_order( $order_id );

		return is_object( $order ) ? $order : null;
	}
}
