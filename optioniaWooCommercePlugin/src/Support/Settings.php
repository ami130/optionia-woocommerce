<?php
/**
 * Typed accessor for merchant settings.
 *
 * Principle 2: the single owner of reads and writes against
 * Keys::OPTION_SETTINGS. Call sites ask `is_debug_logging_enabled()` rather
 * than reaching for `get_option()` and indexing an array — so a renamed key or
 * a changed default is one edit here.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * Reads and writes the plugin settings array.
 */
final class Settings {

	/**
	 * Defaults, also the authoritative list of recognised keys. Anything not
	 * present here is discarded on save.
	 *
	 * @var array<string, mixed>
	 */
	private const DEFAULTS = array(
		Keys::SETTING_DEBUG_LOGGING       => false,
		Keys::SETTING_DELETE_ON_UNINSTALL => false,
		Keys::SETTING_API_BASE_URL        => '',

		/*
		 * How a customised cart line shows its price (M21b.1, ADR-110).
		 *
		 * `itemised` by default because it is the honest framing: a customer
		 * seeing `Finish: Luxury (+10.50)` can check the arithmetic, where a
		 * bare `Customisation: +10.50` asks them to trust it.
		 */
		Keys::SETTING_CART_BREAKDOWN      => 'itemised',
	);

	/**
	 * In-request cache. Settings are read on most requests; this avoids
	 * repeated option lookups within one page load.
	 *
	 * @var array<string, mixed>|null
	 */
	private ?array $cache = null;

	/**
	 * All settings, merged over defaults.
	 *
	 * @return array<string, mixed>
	 */
	public function all(): array {
		if ( null === $this->cache ) {
			$stored = get_option( Keys::OPTION_SETTINGS, array() );

			if ( ! is_array( $stored ) ) {
				$stored = array();
			}

			$this->cache = array_merge( self::DEFAULTS, $stored );
		}

		return $this->cache;
	}

	/**
	 * A single setting.
	 *
	 * @param string $key     Setting key.
	 * @param mixed  $fallback Returned when the key is unknown.
	 * @return mixed
	 */
	public function get( string $key, $fallback = null ) {
		$all = $this->all();

		return array_key_exists( $key, $all ) ? $all[ $key ] : $fallback;
	}

	/**
	 * Persist a subset of settings.
	 *
	 * Unknown keys are dropped rather than stored: settings arrive from admin
	 * form posts, and accepting arbitrary keys would let a crafted request
	 * write junk into the option.
	 *
	 * @param array<string, mixed> $values Values to merge and save.
	 */
	public function save( array $values ): void {
		$current = $this->all();

		foreach ( $values as $key => $value ) {
			if ( array_key_exists( $key, self::DEFAULTS ) ) {
				$current[ $key ] = $value;
			}
		}

		update_option( Keys::OPTION_SETTINGS, $current, false );

		$this->cache = $current;
	}

	/**
	 * Whether verbose logging is enabled.
	 */
	public function is_debug_logging_enabled(): bool {
		return (bool) $this->get( Keys::SETTING_DEBUG_LOGGING, false );
	}

	/**
	 * Whether uninstall should remove all plugin data.
	 *
	 * Defaults to false: deleting a merchant's configuration because they
	 * deactivated a plugin while troubleshooting would be indefensible.
	 */
	public function should_delete_on_uninstall(): bool {
		return (bool) $this->get( Keys::SETTING_DELETE_ON_UNINSTALL, false );
	}

	/**
	 * Base URL of the Optionia API.
	 *
	 * Resolution order: the OPTIONIA_API_URL constant (so a developer can point
	 * a local site at a local API without touching the database), then the
	 * stored setting, then the production default.
	 */
	public function api_base_url(): string {
		if ( defined( 'OPTIONIA_API_URL' ) && is_string( OPTIONIA_API_URL ) && '' !== OPTIONIA_API_URL ) {
			return untrailingslashit( OPTIONIA_API_URL );
		}

		$stored = (string) $this->get( Keys::SETTING_API_BASE_URL, '' );

		if ( '' !== $stored ) {
			return untrailingslashit( $stored );
		}

		return 'https://api.optionia.com/v1';
	}

	/**
	 * Discard the in-request cache. Used by tests and after external writes.
	 */
	public function flush(): void {
		$this->cache = null;
	}
}
