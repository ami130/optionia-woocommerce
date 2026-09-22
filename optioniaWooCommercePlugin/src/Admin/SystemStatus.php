<?php
/**
 * Support diagnostics (M3.6).
 *
 * Acceptance: support can diagnose a merchant install from this panel alone.
 * That is the design goal — every question support would otherwise have to ask
 * ("what versions?", "is it connected?", "when did it last sync?") is answered
 * here, in copy-pasteable form.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Api\CircuitBreaker;
use Optionia\Catalogue\CatalogueCursor;
use Optionia\Catalogue\ProductQueue;
use Optionia\Config\Repository;
use Optionia\Config\Synchroniser;
use Optionia\Connection\Heartbeat;
use Optionia\Connection\PushEndpoint;
use Optionia\Support\Cron;
use Optionia\Support\Environment;
use Optionia\Support\Keys;
use Optionia\Support\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Builds the diagnostic report.
 */
final class SystemStatus {

	/**
	 * Environment probe.
	 *
	 * @var Environment
	 */
	private Environment $environment;

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Settings.
	 *
	 * @var Settings
	 */
	private Settings $settings;

	/**
	 * Scheduling diagnostics.
	 *
	 * @var Cron
	 */
	private Cron $cron;

	/**
	 * API circuit breaker.
	 *
	 * @var CircuitBreaker
	 */
	private CircuitBreaker $breaker;

	/**
	 * Where the catalogue push has reached.
	 *
	 * @var CatalogueCursor
	 */
	private CatalogueCursor $cursor;

	/**
	 * Product changes awaiting sync.
	 *
	 * @var ProductQueue
	 */
	private ProductQueue $queue;

	/**
	 * Constructor.
	 *
	 * @param Environment     $environment Environment probe.
	 * @param Repository      $config      Configuration cache.
	 * @param Settings        $settings    Settings.
	 * @param Cron            $cron        Scheduling diagnostics.
	 * @param CircuitBreaker  $breaker     API circuit breaker.
	 * @param CatalogueCursor $cursor      Catalogue push position.
	 * @param ProductQueue    $queue       Product changes awaiting sync.
	 */
	public function __construct(
		Environment $environment,
		Repository $config,
		Settings $settings,
		Cron $cron,
		CircuitBreaker $breaker,
		CatalogueCursor $cursor,
		ProductQueue $queue
	) {
		$this->environment = $environment;
		$this->config      = $config;
		$this->settings    = $settings;
		$this->cron        = $cron;
		$this->breaker     = $breaker;
		$this->cursor      = $cursor;
		$this->queue       = $queue;
	}

	/**
	 * The report, grouped into sections for display.
	 *
	 * @return array<string, array<string, string>>
	 */
	public function report(): array {
		return array(
			__( 'Environment', 'optionia' )   => $this->environment_section(),
			__( 'Connection', 'optionia' )    => $this->connection_section(),
			__( 'Configuration', 'optionia' ) => $this->configuration_section(),
			__( 'Scheduling', 'optionia' )    => $this->scheduling_section(),
			__( 'Settings', 'optionia' )      => $this->settings_section(),
		);
	}

	/**
	 * The report as plain text, for pasting into a support ticket.
	 */
	public function as_text(): string {
		$lines = array( '### Optionia System Status' );

		foreach ( $this->report() as $section => $rows ) {
			$lines[] = '';
			$lines[] = '[' . $section . ']';

			foreach ( $rows as $label => $value ) {
				$lines[] = sprintf( '%-22s %s', $label . ':', $value );
			}
		}

		return implode( "\n", $lines );
	}

	/**
	 * Versions and WooCommerce feature flags.
	 *
	 * @return array<string, string>
	 */
	private function environment_section(): array {
		$summary = $this->environment->summary();

		return array(
			__( 'Plugin version', 'optionia' ) => $summary['plugin_version'],
			__( 'PHP', 'optionia' )            => $summary['php'],
			__( 'WordPress', 'optionia' )      => $summary['wordpress'],
			__( 'WooCommerce', 'optionia' )    => $summary['woocommerce'],
			__( 'HPOS', 'optionia' )           => $summary['hpos'],
			__( 'Cart block', 'optionia' )     => $summary['cart_block'],
			__( 'Checkout block', 'optionia' ) => $summary['checkout_block'],
			__( 'Multisite', 'optionia' )      => is_multisite() ? 'yes' : 'no',
		);
	}

	/**
	 * Store connection state.
	 *
	 * The token itself is never shown — only whether one exists. A merchant
	 * pasting this report into a support ticket must not be leaking a credential.
	 *
	 * @return array<string, string>
	 */
	private function connection_section(): array {
		$token = get_option( Keys::OPTION_STORE_TOKEN, '' );
		$state = get_option( Keys::OPTION_CONNECTION_STATE, 'disconnected' );

		return array(
			__( 'State', 'optionia' )        => is_string( $state ) ? $state : 'unknown',
			__( 'Credential', 'optionia' )   => ( is_string( $token ) && '' !== $token )
				? __( 'present', 'optionia' )
				: __( 'absent', 'optionia' ),
			__( 'API base URL', 'optionia' ) => $this->settings->api_base_url(),
			__( 'Site URL', 'optionia' )     => home_url( '/' ),
		);
	}

	/**
	 * Configuration cache health.
	 *
	 * @return array<string, string>
	 */
	private function configuration_section(): array {
		$fetched_at = $this->config->fetched_at();

		return array(
			__( 'Cached', 'optionia' )                  => $this->config->has_config()
				? __( 'yes', 'optionia' )
				: __( 'no', 'optionia' ),
			__( 'Config version', 'optionia' )          => (string) $this->config->config_version(),
			__( 'Schema version', 'optionia' )          => self::describe_schema( $this->config ),
			__( 'Last fetch', 'optionia' )              => null === $fetched_at
				? __( 'never', 'optionia' )
				: sprintf(
					/* translators: %s: human-readable time difference */
					__( '%s ago', 'optionia' ),
					human_time_diff( $fetched_at )
				),
			__( 'Cache size', 'optionia' )              => size_format( $this->config->size_bytes() ),

			/*
			 * M9.7 named this row and M10.1 owns it: a count of an index that
			 * does not exist reads identically whether it is empty or absent,
			 * so it shipped with the index rather than before it.
			 */
			__( 'Indexed products', 'optionia' )        => (string) $this->config->index_entry_count(),

			/*
			 * The deferral, made visible.
			 *
			 * ✏️ **Taxonomy left this row at M19.6.** `category` and `tag`
			 * targets resolve now (ADR-076), so they no longer count here. What
			 * remains is `conditional`, which needs a condition tree that does
			 * not exist, and `attribute` and `price_range`, whose reference
			 * format was never defined -- counted, not guessed.
			 *
			 * Without this row a merchant whose set does not appear has no way
			 * to tell "deferred" from "broken".
			 */
			__( 'Deferred assignments', 'optionia' )    => (string) $this->config->index_skipped_count(),

			/*
			 * The catalogue push, in progress or finished (M19.1).
			 *
			 * 🔴 **A walk takes days, so "is it working?" is a real question.**
			 * A 100k catalogue is 400 batches at four an hour -- **4.2 days** --
			 * and for all of that time `/products` in the dashboard shows a
			 * partial list. Without this row a merchant cannot tell a sync that
			 * is progressing from one that stalled, and support cannot either.
			 */
			__( 'Catalogue sync', 'optionia' )          => $this->catalogue_progress(),

			/*
			 * Product changes waiting to reach the cloud (M19.2).
			 *
			 * ⚠️ **A number that should be near zero and briefly is not.** The
			 * queue drains every fifteen minutes, so a merchant who has just
			 * edited a product sees a small count that clears. A count that
			 * *stays* high is the visible symptom of a store the cloud is
			 * refusing — and the row beside it says whether that is so.
			 */
			__( 'Pending product changes', 'optionia' ) => (string) $this->queue->count(),

			/*
			 * When drift was last repaired (M19.3).
			 *
			 * ⚠️ **"never" is a real answer, not a missing one.** The sweep
			 * refuses until the initial walk has finished, so a store still
			 * importing shows "never" correctly — and one that shows it *after*
			 * the walk completed has a daily job that is not running, which is
			 * the question this row answers.
			 */
			__( 'Last reconciled', 'optionia' )         => $this->last_reconciled(),
		);
	}

	/**
	 * How far the catalogue push has reached, in words.
	 *
	 * ⚠️ **Three states, not two.** "Never run" and "finished" both show no work
	 * outstanding, and a merchant reading one as the other draws the opposite
	 * conclusion about whether anything is wrong. `CatalogueCursor` keeps them
	 * distinct for exactly this row.
	 */
	private function catalogue_progress(): string {
		$cursor = $this->cursor->read();

		if ( ! $this->cursor->has_run( $cursor ) ) {
			return __( 'not started', 'optionia' );
		}

		if ( $this->cursor->is_complete( $cursor ) ) {
			return sprintf(
				/* translators: %d: number of products synced. */
				__( 'complete (%d products)', 'optionia' ),
				$cursor['total']
			);
		}

		$progress = sprintf(
			/* translators: 1: products synced so far, 2: total products. */
			__( 'in progress (%1$d of %2$d)', 'optionia' ),
			$cursor['offset'],
			$cursor['total']
		);

		/**
		 * 🔴 **A stalled walk reads identically to a fresh one without this.**
		 * `in progress (0 of 3000)` is what a merchant sees whether the push
		 * started a minute ago or has been failing for three days — and a failed
		 * batch only writes a log line nobody reads. The cursor already records
		 * when it last advanced; this is the row that spends it.
		 *
		 * ⚠️ **The threshold allows for several missed runs, not one.** The
		 * schedule is 900 seconds and a transient outage costs a run or two, so
		 * flagging at the first missed interval would cry wolf on every blip.
		 * An hour is four consecutive failures: no longer a blip.
		 */
		$since = time() - $cursor['updated_at'];

		if ( $cursor['updated_at'] > 0 && $since >= HOUR_IN_SECONDS ) {
			return sprintf(
				/* translators: 1: progress description, 2: human-readable duration. */
				__( '%1$s — stalled, no progress for %2$s', 'optionia' ),
				$progress,
				human_time_diff( $cursor['updated_at'] )
			);
		}

		return $progress;
	}

	/**
	 * When the catalogue was last reconciled, in words.
	 */
	private function last_reconciled(): string {
		$at = (int) get_option( Keys::OPTION_LAST_RECONCILE, 0 );

		if ( $at <= 0 ) {
			return __( 'never', 'optionia' );
		}

		return sprintf(
			/* translators: %s: human-readable duration, e.g. "3 hours". */
			__( '%s ago', 'optionia' ),
			human_time_diff( $at )
		);
	}

	/**
	 * Scheduling and API health.
	 *
	 * The single most useful section for the most common support question:
	 * "why aren't my changes appearing on the storefront?". WP-Cron being
	 * disabled, a schedule that never registered, or an open circuit each
	 * produce exactly that symptom.
	 *
	 * @return array<string, string>
	 */
	private function scheduling_section(): array {
		$next = $this->cron->next_sync();

		return array(
			__( 'Next sync', 'optionia' )      => null === $next
				? __( 'not scheduled', 'optionia' )
				: sprintf(
					/* translators: %s: human-readable time difference */
					__( 'in %s', 'optionia' ),
					human_time_diff( time(), $next )
				),
			__( 'WP-Cron', 'optionia' )        => $this->cron->is_wp_cron_disabled()
				? __( 'disabled (DISABLE_WP_CRON) — a real cron must be configured', 'optionia' )
				: __( 'enabled', 'optionia' ),
			__( 'API circuit', 'optionia' )    => $this->breaker->describe(),
			__( 'Last heartbeat', 'optionia' ) => self::describe_heartbeat(),
			__( 'Last sync', 'optionia' )      => self::describe_sync(),
			__( 'Last push', 'optionia' )      => self::describe_push(),
			__( 'Last error', 'optionia' )     => self::describe_last_error(),
		);
	}

	/**
	 * The most recent thing that went wrong, whatever it was (M9.7).
	 *
	 * Every failure here is already recorded somewhere — a failed sync, a failed
	 * heartbeat, a refused push, a document this build could not read. Each has
	 * its own row, and answering "what most recently went wrong?" means reading
	 * four of them and comparing timestamps.
	 *
	 * That is the reconstruction this row exists to remove. It is the first
	 * question support asks, and a screen that makes a merchant assemble the
	 * answer is one they paste incompletely.
	 *
	 * The source is named, not just the failure. "config sync failed (refused)"
	 * sends someone to the plugin version; "heartbeat failed" sends them to the
	 * network. A bare "failed" sends them nowhere.
	 */
	private static function describe_last_error(): string {
		$candidates = array();

		$sync = Synchroniser::last();

		if ( is_array( $sync ) && isset( $sync['at'] ) && empty( $sync['ok'] ) ) {
			$candidates[] = array(
				'at'     => (int) $sync['at'],
				'what'   => __( 'config sync', 'optionia' ),
				'detail' => (string) ( $sync['outcome'] ?? '' ),
			);
		}

		$heartbeat = Heartbeat::last();

		if ( is_array( $heartbeat ) && isset( $heartbeat['at'] ) && empty( $heartbeat['ok'] ) ) {
			$candidates[] = array(
				'at'     => (int) $heartbeat['at'],
				'what'   => __( 'heartbeat', 'optionia' ),
				'detail' => '',
			);
		}

		$push = PushEndpoint::last();

		if ( is_array( $push ) && isset( $push['at'] ) && empty( $push['accepted'] ) ) {
			$candidates[] = array(
				'at'     => (int) $push['at'],
				'what'   => __( 'inbound push', 'optionia' ),
				'detail' => (string) ( $push['outcome'] ?? '' ),
			);
		}

		$refused = Repository::refused_schema();

		if ( is_array( $refused ) && isset( $refused['at'] ) ) {
			$candidates[] = array(
				'at'     => (int) $refused['at'],
				'what'   => __( 'configuration', 'optionia' ),
				'detail' => __( 'refused: plugin too old for this document', 'optionia' ),
			);
		}

		if ( array() === $candidates ) {
			return __( 'none', 'optionia' );
		}

		// The most recent, which is the one being asked about.
		usort(
			$candidates,
			static function ( array $a, array $b ): int {
				return $b['at'] <=> $a['at'];
			}
		);

		$latest = $candidates[0];

		$ago = sprintf(
			/* translators: %s: human-readable time difference */
			__( '%s ago', 'optionia' ),
			human_time_diff( $latest['at'], time() )
		);

		return '' === $latest['detail']
			? sprintf(
				/* translators: 1: what failed, 2: human-readable time difference */
				__( '%1$s failed %2$s', 'optionia' ),
				$latest['what'],
				$ago
			)
			: sprintf(
				/* translators: 1: what failed, 2: time difference, 3: reason */
				__( '%1$s failed %2$s (%3$s)', 'optionia' ),
				$latest['what'],
				$ago,
				$latest['detail']
			);
	}

	/**
	 * When the cloud last reached this shop directly (M9.4).
	 *
	 * Distinguishes the two failures that look identical from the merchant's
	 * side. A push that **never arrives** points at the site — a firewall, a
	 * security plugin blocking REST, a host that refuses unauthenticated POSTs.
	 * One that arrives and is **refused** points at the credential. One that
	 * arrives and syncs badly points at the cloud.
	 *
	 * Without this row all three read as "my options are slow to update", and
	 * the first is invisible: nothing else in the plugin records that a request
	 * did not happen.
	 */
	private static function describe_push(): string {
		$last = PushEndpoint::last();

		if ( null === $last || ! isset( $last['at'] ) ) {
			return __( 'never — the cloud has not reached this shop directly', 'optionia' );
		}

		$ago = sprintf(
			/* translators: %s: human-readable time difference */
			__( '%s ago', 'optionia' ),
			human_time_diff( (int) $last['at'], time() )
		);

		if ( empty( $last['accepted'] ) ) {
			return sprintf(
				/* translators: %s: human-readable time difference */
				__( 'refused %s — signature did not verify', 'optionia' ),
				$ago
			);
		}

		return 'synced' === ( $last['outcome'] ?? '' )
			? $ago
			: sprintf(
				/* translators: %s: human-readable time difference */
				__( 'received %s, but the sync that followed failed', 'optionia' ),
				$ago
			);
	}

	/**
	 * The document shape in use, and whether one was turned away (M9.5).
	 *
	 * The refusal is the part worth surfacing. `Config\Repository` keeps the
	 * previous copy when a document declares a shape this build cannot read —
	 * correct, and silent, which is exactly why the support screen has to say
	 * so. Without it a merchant sees the admin notice telling them to update,
	 * opens System Status to find out why, and reads nothing about it.
	 *
	 * @param Repository $config Configuration cache.
	 */
	private static function describe_schema( Repository $config ): string {
		$in_use = sprintf(
			/* translators: 1: document schema version, 2: highest supported version */
			__( '%1$s (supported: %2$s)', 'optionia' ),
			(string) ( $config->meta()['schema_version'] ?? 0 ),
			(string) Repository::SUPPORTED_SCHEMA_VERSION
		);

		$refused = Repository::refused_schema();

		if ( null === $refused ) {
			return $in_use;
		}

		return sprintf(
			/* translators: 1: the schema description, 2: refused schema version */
			__( '%1$s — refused a document declaring %2$s; update the plugin', 'optionia' ),
			$in_use,
			(string) ( $refused['document_schema'] ?? 0 )
		);
	}

	/**
	 * When configuration was last fetched, and what happened (M9.3).
	 *
	 * "Next sync" above answers when WP-Cron intends to run; this answers
	 * whether it ever did. On a low-traffic shop those are very different
	 * questions — a schedule can sit there looking healthy while nothing has
	 * fired for days.
	 *
	 * The outcome is carried rather than a bare pass/fail because the reasons
	 * point at different fixes: `refused` means the plugin is too old for the
	 * document the cloud is sending, while an HTTP error means the network. A
	 * merchant told only "failed" cannot tell those apart, and neither can
	 * support.
	 */
	private static function describe_sync(): string {
		$last = Synchroniser::last();

		if ( null === $last || ! isset( $last['at'] ) ) {
			return __( 'never', 'optionia' );
		}

		$ago = sprintf(
			/* translators: %s: human-readable time difference */
			__( '%s ago', 'optionia' ),
			human_time_diff( (int) $last['at'], time() )
		);

		$outcome = isset( $last['outcome'] ) ? (string) $last['outcome'] : '';

		if ( ! empty( $last['ok'] ) ) {
			return 'updated' === $outcome
				? sprintf(
					/* translators: %s: human-readable time difference */
					__( 'updated %s', 'optionia' ),
					$ago
				)
				: sprintf(
					/* translators: %s: human-readable time difference */
					__( 'checked %s, already current', 'optionia' ),
					$ago
				);
		}

		return sprintf(
			/* translators: 1: human-readable time difference, 2: failure reason */
			__( 'failed %1$s (%2$s)', 'optionia' ),
			$ago,
			'' === $outcome ? __( 'unknown', 'optionia' ) : $outcome
		);
	}

	/**
	 * When the daily ping last reached the cloud (M8.5).
	 *
	 * On a site with DISABLE_WP_CRON and no real cron, the heartbeat never
	 * runs and support sees a store that looks abandoned. Showing the last
	 * attempt is what lets a merchant connect those two facts themselves.
	 */
	private static function describe_heartbeat(): string {
		$last = Heartbeat::last();

		if ( null === $last || ! isset( $last['at'] ) ) {
			return __( 'never', 'optionia' );
		}

		$ago = sprintf(
			/* translators: %s: human-readable time difference */
			__( '%s ago', 'optionia' ),
			human_time_diff( (int) $last['at'], time() )
		);

		return empty( $last['ok'] )
			? sprintf(
				/* translators: %s: human-readable time difference */
				__( 'failed (%s)', 'optionia' ),
				$ago
			)
			: $ago;
	}

	/**
	 * Merchant settings relevant to diagnosis.
	 *
	 * @return array<string, string>
	 */
	private function settings_section(): array {
		return array(
			__( 'Debug logging', 'optionia' )       => $this->settings->is_debug_logging_enabled()
				? __( 'enabled', 'optionia' )
				: __( 'disabled', 'optionia' ),
			__( 'Delete on uninstall', 'optionia' ) => $this->settings->should_delete_on_uninstall()
				? __( 'enabled', 'optionia' )
				: __( 'disabled', 'optionia' ),
			__( 'WP_DEBUG', 'optionia' )            => ( defined( 'WP_DEBUG' ) && WP_DEBUG ) ? 'on' : 'off',
		);
	}
}
