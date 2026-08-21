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

use Optionia\Config\Repository;
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
	 * @param Environment $environment Environment probe.
	 * @param Repository  $config      Configuration cache.
	 * @param Settings    $settings    Settings.
	 */
	public function __construct( Environment $environment, Repository $config, Settings $settings ) {
		$this->environment = $environment;
		$this->config      = $config;
		$this->settings    = $settings;
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
			__( 'Plugin version', 'optionia' )  => $summary['plugin_version'],
			__( 'PHP', 'optionia' )             => $summary['php'],
			__( 'WordPress', 'optionia' )       => $summary['wordpress'],
			__( 'WooCommerce', 'optionia' )     => $summary['woocommerce'],
			__( 'HPOS', 'optionia' )            => $summary['hpos'],
			__( 'Cart block', 'optionia' )      => $summary['cart_block'],
			__( 'Checkout block', 'optionia' )  => $summary['checkout_block'],
			__( 'Multisite', 'optionia' )       => is_multisite() ? 'yes' : 'no',
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
			__( 'State', 'optionia' )       => is_string( $state ) ? $state : 'unknown',
			__( 'Credential', 'optionia' )  => ( is_string( $token ) && '' !== $token )
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
			__( 'Cached', 'optionia' )         => $this->config->has_config()
				? __( 'yes', 'optionia' )
				: __( 'no', 'optionia' ),
			__( 'Config version', 'optionia' ) => (string) $this->config->config_version(),
			__( 'Schema version', 'optionia' ) => sprintf(
				/* translators: 1: document schema version, 2: highest supported version */
				__( '%1$s (supported: %2$s)', 'optionia' ),
				(string) ( $this->config->meta()['schema_version'] ?? 0 ),
				(string) Repository::SUPPORTED_SCHEMA_VERSION
			),
			__( 'Last fetch', 'optionia' )     => null === $fetched_at
				? __( 'never', 'optionia' )
				: sprintf(
					/* translators: %s: human-readable time difference */
					__( '%s ago', 'optionia' ),
					human_time_diff( $fetched_at )
				),
			__( 'Cache size', 'optionia' )     => size_format( $this->config->size_bytes() ),
		);
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
