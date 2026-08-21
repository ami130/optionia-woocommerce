<?php
/**
 * Reads and writes the cached configuration document.
 *
 * Principle 2: the only place that touches Keys::OPTION_CONFIG. Call sites ask
 * this class for configuration rather than reaching for get_option(), so the
 * storage strategy can change without touching the callers.
 *
 * AC3 lives here: the storefront reads from this cache and never from the
 * network, so it keeps working when the API is unreachable.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Config;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Local configuration cache.
 */
final class Repository {

	/**
	 * Highest config schema version this plugin build understands.
	 *
	 * A document declaring a higher version is refused rather than partially
	 * rendered — see M9.5. Rendering a document we only half understand risks
	 * charging a customer the wrong amount.
	 */
	public const SUPPORTED_SCHEMA_VERSION = 1;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * In-request cache of the decoded document.
	 *
	 * @var array<string, mixed>|null
	 */
	private ?array $cache = null;

	/**
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * The cached configuration document, or null when nothing is cached.
	 *
	 * @return array<string, mixed>|null
	 */
	public function get(): ?array {
		if ( null !== $this->cache ) {
			return $this->cache;
		}

		$stored = get_option( Keys::OPTION_CONFIG, null );

		if ( ! is_array( $stored ) || array() === $stored ) {
			return null;
		}

		$this->cache = $stored;

		return $this->cache;
	}

	/**
	 * Whether a usable configuration is cached.
	 */
	public function has_config(): bool {
		return null !== $this->get();
	}

	/**
	 * Store a configuration document.
	 *
	 * Refuses documents declaring an unsupported schema version, keeping the
	 * previous good copy instead. A merchant on an old plugin build continues
	 * selling with their last known-good configuration rather than losing
	 * options entirely.
	 *
	 * @param array<string, mixed> $document Configuration document.
	 * @param string|null          $etag     ETag for conditional requests.
	 */
	public function store( array $document, ?string $etag = null ): bool {
		$schema_version = isset( $document['schema_version'] ) ? (int) $document['schema_version'] : 0;

		if ( $schema_version > self::SUPPORTED_SCHEMA_VERSION ) {
			$this->logger->warning(
				'Refused a configuration document with an unsupported schema version; keeping the previous copy.',
				array(
					'document_schema' => $schema_version,
					'supported'       => self::SUPPORTED_SCHEMA_VERSION,
				)
			);

			return false;
		}

		// Autoload off: the document can be large and is not needed on most
		// requests, so loading it into every page's option cache is waste.
		update_option( Keys::OPTION_CONFIG, $document, false );

		update_option(
			Keys::OPTION_CONFIG_META,
			array(
				'config_version' => isset( $document['config_version'] ) ? (int) $document['config_version'] : 0,
				'schema_version' => $schema_version,
				'fetched_at'     => time(),
				'etag'           => $etag,
			),
			false
		);

		$this->cache = $document;

		$this->logger->info(
			'Stored configuration document.',
			array( 'config_version' => isset( $document['config_version'] ) ? (int) $document['config_version'] : 0 )
		);

		return true;
	}

	/**
	 * Cache metadata: config_version, schema_version, fetched_at, etag.
	 *
	 * @return array<string, mixed>
	 */
	public function meta(): array {
		$stored = get_option( Keys::OPTION_CONFIG_META, array() );

		return is_array( $stored ) ? $stored : array();
	}

	/**
	 * Version of the cached configuration, or 0 when nothing is cached.
	 */
	public function config_version(): int {
		$meta = $this->meta();

		return isset( $meta['config_version'] ) ? (int) $meta['config_version'] : 0;
	}

	/**
	 * ETag of the cached configuration, for conditional requests.
	 */
	public function etag(): ?string {
		$meta = $this->meta();

		return isset( $meta['etag'] ) && is_string( $meta['etag'] ) ? $meta['etag'] : null;
	}

	/**
	 * Unix timestamp of the last successful fetch, or null.
	 */
	public function fetched_at(): ?int {
		$meta = $this->meta();

		return isset( $meta['fetched_at'] ) ? (int) $meta['fetched_at'] : null;
	}

	/**
	 * Approximate size of the cached document in bytes, for System Status.
	 */
	public function size_bytes(): int {
		$encoded = wp_json_encode( $this->get() ?? array() );

		return false === $encoded ? 0 : strlen( $encoded );
	}

	/**
	 * Delete the cached configuration.
	 *
	 * Used by disconnect and uninstall. Note that this stops options rendering,
	 * so it is never called as part of ordinary error handling.
	 */
	public function clear(): void {
		delete_option( Keys::OPTION_CONFIG );
		delete_option( Keys::OPTION_CONFIG_META );
		delete_option( Keys::OPTION_PRODUCT_INDEX );

		$this->cache = null;
	}
}
