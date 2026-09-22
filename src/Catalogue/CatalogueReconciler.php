<?php
/**
 * Repairs drift between the store and the mirror (M19.3).
 *
 * ## Why this exists at all
 *
 * Hooks are the fast path and they are best-effort. A product deleted while the
 * site was offline, a removal dropped by the queue cap, a row the walk skipped
 * when a deletion shifted the offset -- each leaves the mirror holding a
 * product the store does not. Nothing else notices.
 *
 * ## 🔴 Ids, not products
 *
 * ADR-075. A full re-push of a 100k catalogue is **400 requests** at 250 a
 * batch; a manifest of ids is **ten** at 10,000 a page. The cloud does not need
 * the products to answer *"which of these have I got that you no longer
 * mention?"* -- it needs the names.
 *
 * ## ⚠️ String order, not numeric
 *
 * `externalId` is `varchar` on the cloud and MySQL compares it as a string. The
 * two orderings differ: numerically `2 < 9 < 10 < 100`, but as strings
 * `"10" < "100" < "2" < "9"`. Paging numerically -- which is what
 * `wc_get_products()` does with `orderby => ID` -- would send a floor of `"2"`,
 * and the mirror's `10` and `100` sort **below** it, falling outside every
 * range and never being examined.
 *
 * So the ids are re-sorted as strings before paging. A leak rather than a loss
 * if it were wrong, but the leak is exactly what this class exists to close.
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
 * Sweeps the store's product ids against the cloud's mirror.
 */
final class CatalogueReconciler {

	/**
	 * The reconcile endpoint.
	 */
	private const PATH = '/store/products/reconcile';

	/**
	 * The most ids in one page.
	 *
	 * Matches the API's `MAX_IDS_PER_PAGE`. Measured there against the 1 MB
	 * body limit at the column's full 64 characters: 664 kB worst case.
	 */
	private const PAGE_SIZE = 10000;

	/**
	 * Cloud transport.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * Where the catalogue walk has reached.
	 *
	 * @var CatalogueCursor
	 */
	private CatalogueCursor $cursor;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param PostsToCloud    $client Cloud transport.
	 * @param CatalogueCursor $cursor Walk position.
	 * @param Logger          $logger Logger.
	 */
	public function __construct( PostsToCloud $client, CatalogueCursor $cursor, Logger $logger ) {
		$this->client = $client;
		$this->cursor = $cursor;
		$this->logger = $logger;
	}

	/**
	 * Attach to the daily cron.
	 */
	public function register(): void {
		add_action( Keys::CRON_RECONCILE_CATALOGUE, array( $this, 'reconcile' ) );
	}

	/**
	 * Compare the store's ids against the mirror.
	 *
	 * @return int How many stale rows the cloud removed.
	 */
	public function reconcile(): int {
		$state = StateMachine::current();

		/*
		 * The same two states every other cloud call refuses: `REVOKED` holds a
		 * credential the cloud already rejects, and retrying it opens the
		 * breaker that config sync and order reporting share.
		 */
		if ( StateMachine::DISCONNECTED === $state || StateMachine::REVOKED === $state ) {
			return 0;
		}

		/**
		 * 🔴 **Never while the initial walk is unfinished.**
		 *
		 * A manifest says *"this is what the store has"*, and the cloud deletes
		 * what it holds that the manifest does not claim. During a walk the
		 * mirror is **deliberately** incomplete -- at offset 40,000 of 100,000
		 * it holds 40k of the store's products -- but the manifest would list
		 * all 100k, and the comparison would be meaningless in one direction and
		 * dangerous in the other.
		 *
		 * Waiting costs at most one day. Running early costs correctness.
		 */
		$cursor = $this->cursor->read();

		if ( ! $this->cursor->has_run( $cursor ) || ! $this->cursor->is_complete( $cursor ) ) {
			$this->logger->debug( 'Reconcile skipped: the catalogue walk has not finished.' );

			return 0;
		}

		$ids = $this->store_ids();

		if ( array() === $ids ) {
			/*
			 * ⚠️ **An empty store is not reconciled, deliberately.** A manifest
			 * of nothing would ask the cloud to delete the whole mirror -- and
			 * "no products" is far more often a broken WooCommerce query than a
			 * merchant who has deleted their catalogue. The cost of being wrong
			 * is asymmetric, so this refuses rather than guesses.
			 */
			$this->logger->warning( 'Reconcile skipped: the store reports no products.' );

			return 0;
		}

		return $this->send_pages( $ids );
	}

	/**
	 * Every product id the store holds, in string order.
	 *
	 * @return array<int, string>
	 */
	private function store_ids(): array {
		if ( ! function_exists( 'wc_get_products' ) ) {
			return array();
		}

		$ids = wc_get_products(
			array(
				'limit'  => -1,
				'return' => 'ids',
				'status' => array( 'publish', 'draft', 'pending', 'private' ),
			)
		);

		if ( ! is_array( $ids ) ) {
			return array();
		}

		$as_strings = array_map( 'strval', $ids );

		/*
		 * ⚠️ `sort()` with `SORT_STRING`, not the default. PHP's default
		 * comparison would order numeric strings *numerically* -- the exact
		 * mismatch this class exists to avoid.
		 */
		sort( $as_strings, SORT_STRING );

		return $as_strings;
	}

	/**
	 * Send the manifest, one page at a time.
	 *
	 * @param array<int, string> $ids Store ids, string-ordered.
	 * @return int How many stale rows were removed.
	 */
	private function send_pages( array $ids ): int {
		$pages       = array_chunk( $ids, self::PAGE_SIZE );
		$range_start = $ids[0];
		$last        = count( $pages ) - 1;
		$removed     = 0;

		foreach ( $pages as $index => $page ) {
			$response = $this->client->post(
				self::PATH,
				array(
					'external_ids' => $page,
					'range_start'  => $range_start,
					'is_final'     => $index === $last,
				)
			);

			if ( ! $response->is_ok() ) {
				/*
				 * 🔴 **Abandon the whole sweep, not just this page.** A manifest
				 * is only meaningful complete: sending pages one to three and
				 * then a *final* page four would tell the cloud the store
				 * contains only page four's ids, and everything above the floor
				 * that it did not claim would be deleted. Stopping here leaves
				 * the mirror untouched and the next day tries again.
				 */
				$this->logger->warning(
					'Reconcile abandoned; the manifest is incomplete.',
					array(
						'status' => $response->status(),
						'page'   => $index + 1,
						'pages'  => count( $pages ),
					)
				);

				return 0;
			}

			$data     = $response->data();
			$removed += isset( $data['removed'] ) ? (int) $data['removed'] : 0;
		}

		update_option( Keys::OPTION_LAST_RECONCILE, time(), false );

		$this->logger->info(
			'Catalogue reconciled.',
			array(
				'checked' => count( $ids ),
				'removed' => $removed,
			)
		);

		return $removed;
	}
}
