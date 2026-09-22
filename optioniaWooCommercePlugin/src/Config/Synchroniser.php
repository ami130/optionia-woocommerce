<?php
/**
 * Pulls the configuration document from the cloud (M9.3).
 *
 * The storefront renders from `Config\Repository`; this is what keeps that copy
 * current. It runs on a schedule and on a merchant pressing "Sync now", and its
 * first responsibility is doing no harm: a failed sync must leave the previous
 * document exactly where it was, because AC3 promises a shop keeps selling when
 * the cloud is unreachable.
 *
 * ## The 304 that would have emptied the cache
 *
 * `Api\Response::is_ok()` is **true for a `304 Not Modified`**, and a 304
 * carries no body. So the obvious implementation —
 *
 *     if ( $response->is_ok() ) { $repository->store( $response->data() ); }
 *
 * — hands the repository an empty array every time nothing has changed, which
 * is most of the time. Measured before `Repository::store()` learned to refuse
 * it: a cached document at version 7 became no configuration at all.
 *
 * `is_not_modified()` is therefore checked **first**, and the repository
 * refuses a bodiless document independently. Two defences for one mistake,
 * because the mistake is the ordinary path rather than an edge case.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Config;

use Optionia\Api\FetchesFromCloud;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Fetches configuration and hands it to the cache.
 */
final class Synchroniser {

	/**
	 * API path. The `v1` prefix lives in the base URL, as with every other call.
	 */
	private const PATH = '/store/config';

	/**
	 * Cloud transport.
	 *
	 * @var FetchesFromCloud
	 */
	private FetchesFromCloud $client;

	/**
	 * The cache this keeps current.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param FetchesFromCloud $client Cloud transport.
	 * @param Repository       $config Configuration cache.
	 * @param Logger           $logger Logger.
	 */
	public function __construct( FetchesFromCloud $client, Repository $config, Logger $logger ) {
		$this->client = $client;
		$this->config = $config;
		$this->logger = $logger;
	}

	/**
	 * Fetch the document, conditionally, and update the cache if it changed.
	 *
	 * @return bool Whether the store is now known to hold current configuration.
	 *               A `304` counts: nothing changed, and nothing needed to.
	 */
	public function sync(): bool {
		$state = StateMachine::current();

		/**
		 * Two states where fetching cannot succeed, for different reasons.
		 *
		 * `DISCONNECTED` holds no credential at all. `REVOKED` holds one the
		 * cloud has already refused, and will go on refusing until the merchant
		 * reauthorises — no amount of retrying changes that.
		 *
		 * Skipping matters more here than it does for the heartbeat, which
		 * makes the same choice about `DISCONNECTED` but keeps pinging when
		 * revoked. The heartbeat runs **once a day**; this runs every fifteen
		 * minutes, ninety-six times as often, against a shared circuit breaker.
		 * Measured: a revoked store opens the circuit on the fifth run, and the
		 * breaker it opens is the one a merchant needs closed when they come to
		 * reconnect.
		 *
		 * The heartbeat still pings while revoked, deliberately — it is how a
		 * store notices a merchant reconnecting from the dashboard. That signal
		 * is kept; only the traffic that cannot possibly succeed is dropped.
		 */
		if ( StateMachine::DISCONNECTED === $state || StateMachine::REVOKED === $state ) {
			$this->logger->debug(
				'Sync skipped: no usable credential.',
				array( 'state' => $state )
			);

			return false;
		}

		$response = $this->client->get( self::PATH, array(), $this->conditional_headers() );

		/**
		 * Checked before `is_ok()`, which is also true here.
		 *
		 * A 304 is a success with nothing to store, and it is the common case:
		 * a store syncing every fifteen minutes changes configuration far less
		 * often than that.
		 */
		if ( $response->is_not_modified() ) {
			/**
			 * "Nothing changed" is only meaningful relative to something held.
			 *
			 * With an empty cache a `304` is a contradiction: the storefront has
			 * no configuration, yet this would report success, mark the store
			 * healthy and never retry. Measured before this check existed —
			 * `has_config = false`, state `connected`, outcome `unchanged`.
			 *
			 * Our own API cannot produce it: `matchesEtag` returns false for a
			 * missing `If-None-Match`, and the response forbids intermediary
			 * caching. But this trusts a status code from the network, and the
			 * cost of being wrong is a shop that silently renders nothing while
			 * every signal says it is fine.
			 */
			if ( ! $this->config->has_config() ) {
				$this->record( false, 'not_modified_without_cache' );

				$this->logger->warning(
					'Received 304 with nothing cached; treating as a failed sync so the next run retries.'
				);

				$this->degrade();

				return false;
			}

			$this->record( true, 'unchanged' );
			$this->recover();

			return true;
		}

		if ( ! $response->is_ok() ) {
			/**
			 * The cache is deliberately untouched.
			 *
			 * A merchant whose cloud is unreachable keeps selling from the copy
			 * they already have — that is AC3, and it is the reason this method
			 * has no `clear()` anywhere in it.
			 *
			 * A 401 is not handled here either: `Api\Client` announces it and
			 * `Connection\StateMachine` moves the store to `REVOKED`, which is
			 * a stronger statement than "a sync failed".
			 */
			$this->record( false, $response->error_code() ?? 'http_error' );

			$this->logger->warning(
				'Configuration sync failed; keeping the cached document.',
				array(
					'status' => $response->status(),
					'error'  => $response->error_message(),
				)
			);

			$this->degrade();

			return false;
		}

		$stored = $this->config->store( $response->data(), $response->header( 'etag' ) );

		if ( ! $stored ) {
			/**
			 * The document arrived and the cache refused it — an unsupported
			 * schema version, or a body that is not a document.
			 *
			 * That is a failed sync from the merchant's point of view: the
			 * storefront is serving something older than the cloud holds, and
			 * the settings screen should say so. `Repository` has already
			 * logged the reason.
			 */
			$this->record( false, 'refused' );
			$this->degrade();

			return false;
		}

		$this->record( true, 'updated' );
		$this->recover();

		return true;
	}

	/**
	 * `If-None-Match`, when there is something to match against.
	 *
	 * Omitted on a first sync: an empty validator would be sent as a header the
	 * cloud cannot match, costing a full document either way while looking like
	 * a conditional request.
	 *
	 * @return array<string, string>
	 */
	private function conditional_headers(): array {
		$etag = $this->config->etag();

		return null === $etag || '' === $etag ? array() : array( 'If-None-Match' => $etag );
	}

	/**
	 * A sync succeeded, so a store that was erroring is no longer.
	 *
	 * `ERROR → CONNECTED` is the recovery edge M8.1b describes, and this is its
	 * only producer. The transition table refuses anything else, so a
	 * `REVOKED` store is not quietly reconnected by a sync that happened to
	 * work.
	 */
	private function recover(): void {
		if ( StateMachine::ERROR === StateMachine::current() ) {
			StateMachine::transition( StateMachine::CONNECTED );
		}
	}

	/**
	 * A sync failed, so a connected store is now erroring.
	 *
	 * `CONNECTED → ERROR` belongs to config sync — the cloud's own audit
	 * coverage says so, and until now nothing produced it: the settings screen
	 * carried a message for a state no code could reach.
	 *
	 * Only from `CONNECTED`. A `REVOKED` store is already in a more specific
	 * state, and describing it as "sync failed" would send a merchant to fix
	 * their network when the answer is to reconnect.
	 */
	private function degrade(): void {
		if ( StateMachine::CONNECTED === StateMachine::current() ) {
			StateMachine::transition( StateMachine::ERROR );
		}
	}

	/**
	 * Record the outcome for System Status (M9.7).
	 *
	 * Written as sync happens rather than reconstructed later: "when did this
	 * shop last hear from the cloud, and what went wrong" is the first question
	 * support asks, and an answer inferred from other state is a guess.
	 *
	 * @param bool   $ok      Whether the sync succeeded.
	 * @param string $outcome `unchanged`, `updated`, `refused`, or an error code.
	 */
	private function record( bool $ok, string $outcome ): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time(),
				'ok'      => $ok,
				'outcome' => $outcome,
			),
			false
		);
	}

	/**
	 * The last recorded sync, or null when none has run.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function last(): ?array {
		$entry = get_option( Keys::OPTION_LAST_SYNC, null );

		return is_array( $entry ) ? $entry : null;
	}
}
