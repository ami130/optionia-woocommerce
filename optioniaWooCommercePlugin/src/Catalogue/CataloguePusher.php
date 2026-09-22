<?php
/**
 * Pushes the catalogue to the cloud, one batch per cron run (M19.1).
 *
 * ## The store pushes; the cloud never pulls
 *
 * ADR-067. The cloud holds no WooCommerce credentials and AC8 forbids it
 * holding any, so the catalogue is read in-process and posted to a
 * store-authenticated endpoint -- the same shape as `POST /store/orders`.
 *
 * ## A walk, not a queue
 *
 * `Reporting\OrderReporter` drains events as they happen. This walks rows
 * WooCommerce already holds, resumably, across days: a 100k catalogue is 400
 * batches at 250 each, four an hour, **4.2 days**. `Catalogue\CatalogueCursor`
 * is where that position lives.
 *
 * ⚠️ **It stops when it finishes, and does not loop.** Ongoing changes are
 * M19.2's (WordPress hooks) and drift is M19.3's (reconciliation). A walk that
 * restarted itself would make both redundant and spend a store's rate limit
 * re-pushing 100k products for ever.
 *
 * ## 🔴 The window that leaves open, until M19.2
 *
 * `CatalogueCursor::start()` captures the catalogue `total` **once**. Products
 * added while the walk runs sort to higher ids -- *past* that total -- and the
 * walk stops when it reaches it. So a store that finishes its first sync
 * **does not pick up anything added afterwards**, and M19.2, which is what
 * carries ongoing changes, is not built yet.
 *
 * ⚠️ **The id-ascending ordering does not mitigate this.** That ordering stops
 * a mid-walk insert *shifting* rows the walk has already passed; it does not
 * extend the walk to reach rows beyond the captured total. Two different
 * problems, and only the first is solved here.
 *
 * 📌 **The interim remedy is the merchant's own.** `Admin\ConnectionSection`
 * offers **Sync catalogue**, which forgets the cursor and starts a fresh walk
 * -- the same thing a reconnect does. It is a manual answer to a gap M19.2
 * closes automatically, and it exists because a merchant who adds a product
 * should not have to wait for a milestone.
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
 * One batch of the catalogue push per run.
 */
final class CataloguePusher {

	/**
	 * The ingest endpoint.
	 */
	private const PATH = '/store/products';

	/**
	 * The most products in one request.
	 *
	 * Matches the API's `MAX_PRODUCTS_PER_PUSH`, and `bin/check-catalogue-limits.sh`
	 * holds the two together. The *byte* budget below is the other bound, and
	 * whichever binds first decides the batch.
	 */
	private const BATCH_SIZE = 250;

	/**
	 * The most bytes one request body may carry.
	 *
	 * 🔴 **Below the API's 1 MB limit, deliberately** (ADR-072, ADR-073). The
	 * difference pays for headers, the envelope and any field added later; a
	 * push that sat exactly at the boundary would turn a one-byte change into an
	 * outage.
	 *
	 * ⚠️ **Measured, not estimated.** `Api\Client` sends `wp_json_encode( $body )`
	 * verbatim, so encoding with the same function here gives the byte count the
	 * server will see.
	 */
	private const BYTE_BUDGET = 768 * 1024;

	/**
	 * The smallest batch worth splitting to.
	 *
	 * A single product over the budget cannot be split further, and halving
	 * towards zero would spin. At one product the push sends it and lets the
	 * API's `413` be the answer -- which advances the cursor rather than
	 * retrying for ever.
	 */
	private const MIN_BATCH = 1;

	/**
	 * Cloud transport.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * Where the walk has reached.
	 *
	 * @var CatalogueCursor
	 */
	private CatalogueCursor $cursor;

	/**
	 * Reads the catalogue into the wire shape.
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
	 * @param CatalogueCursor  $cursor  Walk position.
	 * @param CataloguePayload $payload Catalogue reader.
	 * @param Logger           $logger  Logger.
	 */
	public function __construct(
		PostsToCloud $client,
		CatalogueCursor $cursor,
		CataloguePayload $payload,
		Logger $logger
	) {
		$this->client  = $client;
		$this->cursor  = $cursor;
		$this->payload = $payload;
		$this->logger  = $logger;
	}

	/**
	 * Registers the cron handler.
	 */
	public function register(): void {
		add_action( Keys::CRON_PUSH_CATALOGUE, array( $this, 'run' ) );
	}

	/**
	 * Push one batch, if there is one to push.
	 *
	 * @return int How many products were accepted this run.
	 */
	public function run(): int {
		$state = StateMachine::current();

		/**
		 * 🔴 **Two states where a push cannot succeed, and `REVOKED` is the one
		 * that matters.**
		 *
		 * `DISCONNECTED` holds no credential. `REVOKED` holds one the cloud has
		 * already refused and will go on refusing until the merchant
		 * reauthorises.
		 *
		 * ⚠️ **`OrderReporter` skips only `DISCONNECTED`, and copying it here
		 * would be wrong.** `Config\Synchroniser` measured why: on this same
		 * 900-second schedule *"a revoked store opens the circuit on the fifth
		 * run, and the breaker it opens is the one a merchant needs closed when
		 * they come to reconnect."* The breaker's cooldown is 300 seconds
		 * against a 900-second interval, so it would close and **re-open every
		 * five runs, indefinitely**. A drain that only runs when orders exist can
		 * afford that guard; a walk that runs every interval for days cannot.
		 */
		if ( StateMachine::DISCONNECTED === $state || StateMachine::REVOKED === $state ) {
			return 0;
		}

		if ( ! $this->cursor->claim() ) {
			// Another run holds the walk; see CatalogueCursor::claim().
			$this->logger->debug( 'Catalogue push skipped: another run is in progress.' );

			return 0;
		}

		try {
			return $this->push();
		} finally {
			/*
			 * Released however the push ended, including on a throw. A claim
			 * left behind by an exception would stall the walk until it expired,
			 * turning one bad batch into five idle minutes.
			 */
			$this->cursor->release();
		}
	}

	/**
	 * The walk itself, inside a claim.
	 *
	 * @return int How many products were accepted.
	 */
	private function push(): int {
		$cursor = $this->cursor->read();

		if ( $this->cursor->has_run( $cursor ) && $this->cursor->is_complete( $cursor ) ) {
			/*
			 * Finished. M19.2 carries changes from here.
			 *
			 * ✏️ **This said "M19.3 repairs drift", and that is only half
			 * true.** Reconciliation is **delete-only**: its manifest carries
			 * `external_ids` and nothing else, so it can remove a mirror row the
			 * store no longer claims and can **not** insert a product the walk
			 * skipped. A product missed here stays missed — the walk does not
			 * restart, and M19.2 only sees changes made *after* it.
			 *
			 * The repair for a skip is the merchant's **Sync catalogue**
			 * button, which calls `CatalogueCursor::forget()` and walks again
			 * from the beginning.
			 */
			return 0;
		}

		if ( ! $this->cursor->has_run( $cursor ) ) {
			$first = $this->payload->page( 0, self::BATCH_SIZE );

			if ( 0 === $first['total'] ) {
				// An empty catalogue is not a failure, and not a walk either.
				return 0;
			}

			$this->cursor->start( $first['total'] );
			$cursor = $this->cursor->read();

			$this->logger->info(
				'Catalogue push started.',
				array(
					'total'  => $first['total'],
					'run_id' => $cursor['run_id'],
				)
			);
		}

		$page = $this->payload->page( $cursor['offset'], self::BATCH_SIZE );

		if ( array() === $page['products'] ) {
			/*
			 * The catalogue ran out before the total said it would -- products
			 * deleted mid-walk. Finished rather than stuck: advancing to the
			 * total stops the walk.
			 *
			 * 🔴 **The products the shift skipped are NOT repaired by M19.3,
			 * and an earlier version of this comment said they were.**
			 * Reconciliation compares **ids** and deletes what the store no
			 * longer claims; its manifest carries no product data, so there is
			 * nothing for it to insert. A deletion during the walk moves later
			 * rows down past the cursor, and those products are simply never
			 * pushed.
			 *
			 * ⚠️ **Bounded and recoverable, which is why this still advances.**
			 * At most one product is skipped per deletion, so a store deleting
			 * ten a day loses roughly forty over a 100k walk -- and the
			 * merchant's **Sync catalogue** button forgets the cursor and walks
			 * again, which is exactly what its description offers: *"use this
			 * ... if the assignment picker is missing something"*. Stalling here
			 * instead would leave the whole catalogue unsynced to avoid losing
			 * a handful of it.
			 */
			$this->cursor->advance( $cursor['run_id'], max( 0, $cursor['total'] - $cursor['offset'] ) );

			return 0;
		}

		return $this->send( $cursor['run_id'], $page['products'] );
	}

	/**
	 * Send products, splitting until the body fits.
	 *
	 * 🔴 **Shrinks before sending rather than reacting to a `413`** (ADR-073).
	 * `Api\Client` treats a non-retryable 4xx as `CircuitBreaker::record_failure()`,
	 * so halving *after* a rejection would spend real failures on routine size
	 * management -- and five of them open a breaker that stops config sync and
	 * order reporting too.
	 *
	 * @param string                           $run_id   The walk this belongs to.
	 * @param array<int, array<string, mixed>> $products Products to send.
	 * @return int How many were accepted.
	 */
	private function send( string $run_id, array $products ): int {
		$batch = $this->fitting_slice( $products );

		if ( array() === $batch ) {
			return 0;
		}

		$response = $this->client->post( self::PATH, array( 'products' => $batch ) );

		if ( $response->is_ok() ) {
			$this->cursor->advance( $run_id, count( $batch ) );

			return count( $batch );
		}

		/**
		 * ⚠️ **A `413` here means the server's limit is lower than this build
		 * assumed**, since the body was already measured against `BYTE_BUDGET`.
		 * Halve **once** and let the next run carry on: retrying in a loop would
		 * spend the run, and every attempt is a `record_failure()` against the
		 * shared breaker.
		 */
		if ( 413 === $response->status() && count( $batch ) > self::MIN_BATCH ) {
			$half = array_slice( $batch, 0, max( self::MIN_BATCH, intdiv( count( $batch ), 2 ) ) );

			$this->logger->warning(
				'Catalogue batch refused as too large; halving.',
				array(
					'sent'   => count( $batch ),
					'halved' => count( $half ),
				)
			);

			$retry = $this->client->post( self::PATH, array( 'products' => $half ) );

			if ( $retry->is_ok() ) {
				$this->cursor->advance( $run_id, count( $half ) );

				return count( $half );
			}
		}

		/*
		 * 🔴 **The cursor does not advance on failure**, so the next run retries
		 * the same span. The one exception is a single product the API will not
		 * take at any size: advancing past it costs one product and keeps the
		 * walk moving, where stalling costs every product behind it -- the same
		 * reasoning ADR-072 applied to the order queue.
		 */
		if ( 413 === $response->status() && self::MIN_BATCH === count( $batch ) ) {
			$this->logger->error(
				'A single product exceeds the cloud body limit; skipping it.',
				array( 'external_id' => $batch[0]['external_id'] ?? '' )
			);

			$this->cursor->advance( $run_id, 1 );

			return 0;
		}

		$this->logger->warning(
			'Catalogue batch failed; will retry.',
			array(
				'status' => $response->status(),
				'sent'   => count( $batch ),
			)
		);

		return 0;
	}

	/**
	 * The longest prefix of `$products` whose encoded body fits the budget.
	 *
	 * Halves rather than dropping one at a time: a 250-product batch too large
	 * by one product would otherwise encode 250 times to find out.
	 *
	 * @param array<int, array<string, mixed>> $products Candidate products.
	 * @return array<int, array<string, mixed>>
	 */
	private function fitting_slice( array $products ): array {
		$size = count( $products );

		while ( $size > self::MIN_BATCH ) {
			if ( $this->fits( array_slice( $products, 0, $size ) ) ) {
				return array_slice( $products, 0, $size );
			}

			$size = intdiv( $size, 2 );
		}

		/*
		 * One product, whether or not it fits. A product too large on its own is
		 * the API's to refuse -- and the `413` path above advances past it
		 * rather than letting it block the walk.
		 */
		return array_slice( $products, 0, self::MIN_BATCH );
	}

	/**
	 * Whether a batch encodes within the byte budget.
	 *
	 * @param array<int, array<string, mixed>> $batch Products.
	 */
	private function fits( array $batch ): bool {
		$encoded = wp_json_encode( array( 'products' => $batch ) );

		if ( false === $encoded ) {
			// Unencodable: treat as over budget so the split continues.
			return false;
		}

		return strlen( $encoded ) <= self::BYTE_BUDGET;
	}
}
