<?php
/**
 * Sends queued product changes to the cloud (M19.2).
 *
 * ## The other half of the hook
 *
 * `ProductWatcher` records what changed; this does the network work, on cron,
 * where nothing is waiting on it. Splitting them is the whole reason a merchant
 * pressing **Update** does not wait on HTTP -- the rule
 * `Reporting\OrderReporter` states for checkout, applied to the admin.
 *
 * ## 🔴 Upserts batch; removals do not
 *
 * `POST /store/products` takes up to 250 products in **one** request.
 * `DELETE /store/products/:externalId` names one product in the path, so a
 * hundred removals are a hundred requests.
 *
 * Treating them alike would be wrong in both directions: batching removals is
 * impossible, and sending upserts one at a time would waste an endpoint built
 * to take 250. So a run sends **one upsert batch** and **a bounded number of
 * removals**, and the bound is what keeps a cron request short.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Catalogue;

use Optionia\Api\PostsToCloud;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Drains the product queue, one cron run at a time.
 */
final class QueueDrainer {

	/**
	 * The ingest endpoint.
	 */
	private const PATH = '/store/products';

	/**
	 * The most products upserted in one run.
	 *
	 * One request, so the bound is the API's own cap rather than a timing
	 * choice. `bin/check-catalogue-limits.sh` holds this against the DTO.
	 */
	private const MAX_UPSERTS = 250;

	/**
	 * The most removals in one run.
	 *
	 * ⚠️ **Lower than the upsert cap, because each is its own request.**
	 * `Api\Client` allows 8 seconds per attempt, so twenty sequential DELETEs
	 * is a bounded cron run; fifty could reach minutes on a slow link. A full
	 * 200-entry queue of removals clears in ten runs -- about two and a half
	 * hours -- and M19.3's reconciliation is the backstop if it does not.
	 */
	private const MAX_REMOVALS = 20;

	/**
	 * Cloud transport.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * Products awaiting sync.
	 *
	 * @var ProductQueue
	 */
	private ProductQueue $queue;

	/**
	 * Reads products into the wire shape.
	 *
	 * @var CataloguePayload
	 */
	private CataloguePayload $payload;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param PostsToCloud     $client  Cloud transport.
	 * @param ProductQueue     $queue   Products awaiting sync.
	 * @param CataloguePayload $payload Product reader.
	 * @param Logger           $logger  Logger.
	 */
	public function __construct(
		PostsToCloud $client,
		ProductQueue $queue,
		CataloguePayload $payload,
		Logger $logger
	) {
		$this->client  = $client;
		$this->queue   = $queue;
		$this->payload = $payload;
		$this->logger  = $logger;
	}

	/**
	 * Attach to the catalogue cron.
	 *
	 * 📌 **The same event the walk uses**, rather than a fourth schedule. A
	 * store already pays for a quarter-hourly wake-up, and the two do different
	 * work on the same tick: the walk sends the catalogue it has not reached,
	 * this sends the changes since.
	 */
	public function register(): void {
		add_action( Keys::CRON_PUSH_CATALOGUE, array( $this, 'drain' ) );
	}

	/**
	 * Send as much of the queue as one run allows.
	 *
	 * @return int How many products were synced.
	 */
	public function drain(): int {
		$state = StateMachine::current();

		/*
		 * The same two states `CataloguePusher` refuses, for the same reason:
		 * `REVOKED` holds a credential the cloud already rejects, and retrying
		 * it every fifteen minutes opens the breaker that config sync and order
		 * reporting share.
		 */
		if ( StateMachine::DISCONNECTED === $state || StateMachine::REVOKED === $state ) {
			return 0;
		}

		$queued = $this->queue->all();

		if ( array() === $queued ) {
			return 0;
		}

		$upsert_ids = array();
		$remove_ids = array();

		foreach ( $queued as $product_id => $action ) {
			if ( ProductQueue::ACTION_REMOVE === $action ) {
				$remove_ids[] = $product_id;
				continue;
			}

			$upsert_ids[] = $product_id;
		}

		$synced  = $this->send_upserts( array_slice( $upsert_ids, 0, self::MAX_UPSERTS ) );
		$synced += $this->send_removals( array_slice( $remove_ids, 0, self::MAX_REMOVALS ) );

		return $synced;
	}

	/**
	 * Push queued products as one batch.
	 *
	 * @param array<int, int> $product_ids Product ids.
	 * @return int How many were accepted.
	 */
	private function send_upserts( array $product_ids ): int {
		if ( array() === $product_ids ) {
			return 0;
		}

		$products = $this->payload->for_ids( $product_ids );

		if ( array() === $products ) {
			/*
			 * Every queued product has since disappeared. Forgetting them is the
			 * right end state: `ProductWatcher` queued a removal for each when it
			 * happened, and a stale upsert must not outlive the product.
			 */
			foreach ( $product_ids as $product_id ) {
				$this->queue->forget( $product_id );
			}

			return 0;
		}

		$response = $this->client->post( self::PATH, array( 'products' => $products ) );

		if ( ! $response->is_ok() ) {
			$this->logger->warning(
				'Product sync batch failed; will retry.',
				array(
					'status' => $response->status(),
					'sent'   => count( $products ),
				)
			);

			return 0;
		}

		/*
		 * 🔴 **Forgotten only after the cloud confirms.** Clearing the queue
		 * first would lose the change on any failure, and the queue is the only
		 * record that it happened -- WooCommerce does not keep a list of what
		 * has been synced.
		 */
		foreach ( $product_ids as $product_id ) {
			$this->queue->forget( $product_id );
		}

		return count( $products );
	}

	/**
	 * Remove queued products, one request each.
	 *
	 * @param array<int, int> $product_ids Product ids.
	 * @return int How many were removed.
	 */
	private function send_removals( array $product_ids ): int {
		$removed = 0;

		foreach ( $product_ids as $product_id ) {
			$response = $this->client->delete( self::PATH . '/' . rawurlencode( (string) $product_id ) );

			if ( ! $response->is_ok() ) {
				/*
				 * ⚠️ **Stop on the first failure rather than working through
				 * the rest.** The cause is almost always the same for every one
				 * -- the cloud is down, or the credential is bad -- so
				 * continuing would spend the run proving it repeatedly and hand
				 * the circuit breaker nineteen more failures.
				 */
				$this->logger->warning(
					'Product removal failed; will retry.',
					array(
						'status'     => $response->status(),
						'product_id' => $product_id,
					)
				);

				break;
			}

			$this->queue->forget( $product_id );
			++$removed;
		}

		return $removed;
	}
}
