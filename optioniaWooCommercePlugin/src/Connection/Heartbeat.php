<?php
/**
 * The daily authenticated ping (M8.5).
 *
 * Two jobs, and the second is easy to overlook. Outbound, it reports the
 * environment — plugin, WordPress, WooCommerce and PHP versions, connection
 * state, and how stale the cached configuration is. That is the support
 * backbone: when a merchant writes in, the answer to "what are you running"
 * is already on file.
 *
 * Inbound, the cloud's reply is how a plugin learns it is behind. A heartbeat
 * that sent and discarded would make `config_version` a field nobody reads —
 * so the response is recorded here. Acting on it is Phase 9's synchroniser;
 * recording it is what makes that possible, and what lets the settings screen
 * say "new options are available".
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Connection;

use Optionia\Api\PostsToCloud;
use Optionia\Config\Repository;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Upload\UploadRepository;

defined( 'ABSPATH' ) || exit;

/**
 * Builds, sends and records the daily heartbeat.
 */
final class Heartbeat {

	/**
	 * API path. The `v1` prefix lives in the base URL, as with every other call.
	 */
	private const PATH = '/store/heartbeat';

	/**
	 * Cloud transport.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * Configuration cache, read for version and staleness.
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
	 * The upload table, or null where uploads are not in play.
	 *
	 * @var UploadRepository|null
	 */
	private ?UploadRepository $uploads;

	/**
	 * Constructor.
	 *
	 * @param PostsToCloud          $client  Cloud transport.
	 * @param Repository            $config  Configuration cache.
	 * @param Logger                $logger  Logger.
	 * @param UploadRepository|null $uploads Upload table, for the storage figure.
	 */
	public function __construct(
		PostsToCloud $client,
		Repository $config,
		Logger $logger,
		?UploadRepository $uploads = null
	) {
		$this->client  = $client;
		$this->config  = $config;
		$this->logger  = $logger;
		$this->uploads = $uploads;
	}

	/**
	 * Register the scheduled listener.
	 */
	public function register(): void {
		add_action( Keys::CRON_HEARTBEAT, array( $this, 'send' ) );
	}

	/**
	 * Send the heartbeat, unless there is nothing to report from.
	 *
	 * A disconnected store holds no credential: the request would be a
	 * guaranteed 401, and answering it would tell us only what we already know.
	 * Every other state still pings — including `revoked`, deliberately. A
	 * revoked store that a merchant reconnects from the dashboard has no other
	 * way to notice, and the 401 it earns meanwhile is already handled by
	 * `Api\Client`, which announces it to the state machine.
	 *
	 * @return bool Whether a heartbeat was sent and accepted.
	 */
	public function send(): bool {
		if ( StateMachine::DISCONNECTED === StateMachine::current() ) {
			$this->logger->debug( 'Heartbeat skipped: store is not connected.' );

			return false;
		}

		$response = $this->client->post( self::PATH, $this->payload() );

		if ( ! $response->is_ok() ) {
			// Not escalated here. A 401 is announced by Api\Client to the state
			// machine, which owns that transition; anything else is a transient
			// the next run retries. Recording the attempt is what System Status
			// needs to distinguish "never ran" from "ran and failed".
			$this->record( false, null );

			$this->logger->warning(
				'Heartbeat failed.',
				array( 'status' => $response->status() )
			);

			return false;
		}

		$data = $response->data();

		$this->record(
			true,
			isset( $data['config_version'] ) ? (int) $data['config_version'] : null
		);

		return true;
	}

	/**
	 * The environment this store is running.
	 *
	 * @return array<string, mixed>
	 */
	private function payload(): array {
		return array(
			'plugin_version'           => OPTIONIA_VERSION,
			'wp_version'               => self::short_version( (string) get_bloginfo( 'version' ) ),
			'wc_version'               => defined( 'WC_VERSION' ) ? self::short_version( (string) WC_VERSION ) : 'unknown',
			'php_version'              => self::short_version( PHP_VERSION ),
			'connection_state'         => StateMachine::current(),
			'config_version'           => $this->config->config_version(),
			'cache_age_seconds'        => $this->cache_age(),

			/**
			 * What this build can read, and whether that limit has bitten (M9.5).
			 *
			 * `Config\Repository` refuses a document whose shape exceeds this
			 * build and keeps the previous copy — correct, and silent. Without
			 * these two fields the cloud sees a healthy store: heartbeat on
			 * time, state connected, credential working, quietly serving
			 * configuration older than the cloud holds.
			 *
			 * Two fields rather than one because they answer different
			 * questions. The version is a *capability* — true of every store
			 * running this build. The flag is an *operations signal* — this shop
			 * is stale right now, and someone should tell the merchant.
			 */
			'supported_schema_version' => Repository::SUPPORTED_SCHEMA_VERSION,
			'schema_refused'           => null !== Repository::refused_schema(),

			/**
			 * What this store is holding in customer uploads (M15.6).
			 *
			 * 🔴 **Carried here rather than posted to an endpoint of its own,
			 * because usage is a level rather than an event.**
			 * `Reporting\OrderReporter` has a queue and retry semantics because a
			 * missed order is lost; a missed storage figure is simply superseded
			 * by tomorrow's heartbeat.
			 *
			 * ⚠️ **Bytes, not megabytes.** The plan limit is written
			 * `file_storage_mb`, but rounding here would make every store under
			 * half a megabyte report zero — and the conversion belongs where the
			 * limit is compared, not in a number every store sends daily.
			 */
			'storage_bytes'            => null === $this->uploads ? 0 : $this->uploads->total_bytes(),
		);
	}

	/**
	 * A version string the cloud will accept.
	 *
	 * The API caps these at 20 characters, and distribution builds blow through
	 * that: Debian and Ubuntu ship PHP as `8.1.2-1ubuntu2.14+deb.sury.org+1`,
	 * 32 characters. Because the endpoint rejects unknown and oversized fields
	 * outright, one long string would fail the *whole* heartbeat -- so the most
	 * common hosting stack in WooCommerce would be the one that never reports.
	 *
	 * The build suffix is dropped rather than truncated. `8.1.2` is true and
	 * useful; `8.1.2-1ubuntu2.14+deb` is a string nobody can compare.
	 *
	 * @param string $version Raw version string.
	 */
	private static function short_version( string $version ): string {
		if ( preg_match( '/^\d+(?:\.\d+){0,2}/', $version, $matches ) ) {
			return $matches[0];
		}

		return substr( $version, 0, 20 );
	}

	/**
	 * How stale the cached configuration is, in seconds.
	 *
	 * Null when nothing has ever been cached — which is not the same as a cache
	 * age of zero, and the cloud reads the difference.
	 */
	private function cache_age(): ?int {
		$fetched = $this->config->fetched_at();

		if ( null === $fetched ) {
			return null;
		}

		return max( 0, time() - $fetched );
	}

	/**
	 * Record the outcome for System Status.
	 *
	 * @param bool     $ok             Whether the cloud accepted the ping.
	 * @param int|null $config_version Version the cloud reports holding.
	 */
	private function record( bool $ok, ?int $config_version ): void {
		$entry = array(
			'at' => time(),
			'ok' => $ok,
		);

		if ( null !== $config_version ) {
			$entry['cloud_config_version'] = $config_version;
		}

		update_option( Keys::OPTION_LAST_HEARTBEAT, $entry, false );
	}

	/**
	 * The last recorded heartbeat, or null when none has run.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function last(): ?array {
		$entry = get_option( Keys::OPTION_LAST_HEARTBEAT, null );

		return is_array( $entry ) ? $entry : null;
	}

	/**
	 * Whether the cloud reported configuration newer than the cache.
	 *
	 * The signal Phase 9's synchroniser acts on, and what lets the settings
	 * screen tell a merchant an update is waiting.
	 */
	public function is_behind(): bool {
		$last = self::last();

		if ( null === $last || ! isset( $last['cloud_config_version'] ) ) {
			return false;
		}

		return (int) $last['cloud_config_version'] > $this->config->config_version();
	}
}
