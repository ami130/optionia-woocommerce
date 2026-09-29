<?php
/**
 * Sends accumulated option view counts to the cloud (M25.1).
 *
 * ## Why this is a drain and not a send
 *
 * 🔴 **Nothing here happens while a customer waits.** `ViewCollector::add()`
 * increments an integer and returns; this does the HTTP, on cron, where the only
 * thing waiting is WordPress's own scheduler. That is the same separation
 * `OrderReporter` makes and the reason Phase 25's exit criterion --
 * *"ingestion never affects storefront performance"* -- still holds with views
 * arriving on every product page load.
 *
 * ## The idempotency story, and the half this class owns
 *
 * 🔴 **The cloud ADDS what arrives.** So the counts must be cleared only after a
 * confirmed 2xx: clearing before would lose them on a failure, and clearing on a
 * failure would lose them silently. A failed drain simply resends, and the
 * cloud's unique key absorbs nothing -- there is no deduplication on the other
 * side, by design, because a second batch for the same day is legitimate.
 *
 * ⚠️ **That makes the clear the load-bearing step**, which is why it subtracts
 * exactly what was sent rather than wiping the option: a beacon arriving during
 * the request has already incremented a count, and discarding it would lose a
 * view the customer really made.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Analytics;

use Optionia\Api\PostsToCloud;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Drains the view counter to the cloud on cron.
 */
final class ViewReporter {

	/** Where the cloud accepts view counts. */
	private const PATH = '/store/views';

	/**
	 * The most rows sent in one request.
	 *
	 * ⚠️ **Matches the API's own cap.** Sending more would earn a 400 for the
	 * whole batch, and this class treats a 400 as permanent -- so an oversized
	 * request would discard every count in it rather than the excess.
	 */
	private const MAX_ROWS = 500;

	/**
	 * What accumulates the counts.
	 *
	 * @var ViewCollector
	 */
	private ViewCollector $collector;

	/**
	 * How this reaches the cloud.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * Where failures are recorded.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Hold what the drain needs.
	 *
	 * @param ViewCollector $collector Accumulated counts.
	 * @param PostsToCloud  $client    The cloud transport.
	 * @param Logger        $logger    Where failures are recorded.
	 */
	public function __construct( ViewCollector $collector, PostsToCloud $client, Logger $logger ) {
		$this->collector = $collector;
		$this->client    = $client;
		$this->logger    = $logger;
	}

	/**
	 * Register the cron handler.
	 *
	 * 📌 **No storefront hook at all.** The beacon reaches `ViewEndpoint` over
	 * REST, so nothing in this class is reachable from a page render -- which is
	 * what keeps AC3 (*the read path never touches the network*) true by
	 * construction rather than by care.
	 */
	public function register(): void {
		add_action( Keys::CRON_REPORT_VIEWS, array( $this, 'drain' ) );
	}

	/**
	 * Send what has accumulated.
	 */
	public function drain(): void {
		$pending = $this->collector->pending();

		if ( array() === $pending ) {
			return;
		}

		$batch = array_slice( $pending, 0, self::MAX_ROWS );

		$response = $this->client->post( self::PATH, array( 'views' => $batch ) );

		if ( $response->is_ok() ) {
			$this->collector->clear( $batch );
			$this->record( count( $batch ), 0 );

			return;
		}

		$status = $response->status();

		/*
		 * 🔴 **A 4xx other than 429 and 401 is the batch being wrong, not the
		 * cloud being unavailable** -- the same rule `OrderReporter` follows. A
		 * malformed row fails identically for ever, and retrying it would hold
		 * every later count behind it permanently.
		 *
		 * ⚠️ **Dropped LOUDLY.** A 400 here means the plugin and the API
		 * disagree about the payload, which is a bug rather than an outage, and
		 * a silent drop would make a merchant's conversion rate quietly wrong
		 * instead of visibly broken.
		 */
		if ( $status >= 400 && $status < 500 && 429 !== $status && 401 !== $status ) {
			$this->logger->error(
				'View report rejected; dropping the batch.',
				array(
					'status' => $status,
					'rows'   => count( $batch ),
				)
			);

			$this->collector->clear( $batch );
			$this->record( 0, count( $batch ) );

			return;
		}

		$this->logger->warning(
			'View report failed; will retry.',
			array(
				'status' => $status,
				'rows'   => count( $batch ),
			)
		);

		$this->record( 0, count( $batch ) );
	}

	/**
	 * Note the outcome, for System Status.
	 *
	 * 📌 **`autoload = false`**, like every option this plugin writes outside
	 * settings: a support field read once on one screen must not be loaded on
	 * every request to the site.
	 *
	 * @param int $reported How many rows the cloud accepted.
	 * @param int $failed   How many were dropped or deferred.
	 */
	private function record( int $reported, int $failed ): void {
		update_option(
			Keys::OPTION_LAST_VIEW_REPORT,
			array(
				'at'        => time(),
				'reported'  => $reported,
				'failed'    => $failed,
				'remaining' => count( $this->collector->pending() ),
			),
			false
		);
	}
}
