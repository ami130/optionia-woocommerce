<?php
/**
 * Environment and dependency checks.
 *
 * Principle 2: activation (M3.2) and the runtime dependency guard (M3.3) ask
 * the same questions, so the answers live here once. Two copies of a version
 * check drift, and then the plugin activates on an environment it cannot run on.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * Answers "can this plugin run here?".
 */
final class Environment {

	/**
	 * Whether every requirement is satisfied.
	 */
	public function is_satisfied(): bool {
		return array() === $this->unmet_requirements();
	}

	/**
	 * Unmet requirements, as codes plus the values a message needs.
	 *
	 * Deliberately returns data, not translated strings. This runs on
	 * `plugins_loaded`, and WordPress 6.7 warns when translations are requested
	 * before `init`. Messages are rendered later by describe(), at which point
	 * the text domain is loaded.
	 *
	 * Returned as a list rather than a single problem so a notice can report
	 * everything at once — telling a merchant to upgrade PHP, and only then that
	 * they also need a newer WooCommerce, wastes their time.
	 *
	 * @return array<int, array{code: string, context: array<string, string>}>
	 */
	public function unmet_requirements(): array {
		$problems = array();

		if ( version_compare( PHP_VERSION, OPTIONIA_MIN_PHP, '<' ) ) {
			$problems[] = array(
				'code'    => 'php_version',
				'context' => array(
					'required' => OPTIONIA_MIN_PHP,
					'current'  => PHP_VERSION,
				),
			);
		}

		if ( version_compare( get_bloginfo( 'version' ), OPTIONIA_MIN_WP, '<' ) ) {
			$problems[] = array(
				'code'    => 'wp_version',
				'context' => array(
					'required' => OPTIONIA_MIN_WP,
					'current'  => get_bloginfo( 'version' ),
				),
			);
		}

		if ( ! $this->is_woocommerce_active() ) {
			$problems[] = array(
				'code'    => 'woocommerce_missing',
				'context' => array(),
			);

			// Without WooCommerce there is no version to compare, so stop here.
			return $problems;
		}

		$wc_version = $this->woocommerce_version();

		if ( null !== $wc_version && version_compare( $wc_version, OPTIONIA_MIN_WC, '<' ) ) {
			$problems[] = array(
				'code'    => 'wc_version',
				'context' => array(
					'required' => OPTIONIA_MIN_WC,
					'current'  => $wc_version,
				),
			);
		}

		return $problems;
	}

	/**
	 * Render a requirement problem as a merchant-facing sentence.
	 *
	 * Called at display time, after `init`, so translations are available.
	 *
	 * @param array{code: string, context: array<string, string>} $problem Problem to describe.
	 */
	public function describe( array $problem ): string {
		$required = $problem['context']['required'] ?? '';
		$current  = $problem['context']['current'] ?? '';

		switch ( $problem['code'] ) {
			case 'php_version':
				return sprintf(
					/* translators: 1: required PHP version, 2: current PHP version */
					__( 'Optionia requires PHP %1$s or newer. This site is running PHP %2$s.', 'optionia' ),
					$required,
					$current
				);

			case 'wp_version':
				return sprintf(
					/* translators: 1: required WordPress version, 2: current WordPress version */
					__( 'Optionia requires WordPress %1$s or newer. This site is running WordPress %2$s.', 'optionia' ),
					$required,
					$current
				);

			case 'wc_version':
				return sprintf(
					/* translators: 1: required WooCommerce version, 2: current WooCommerce version */
					__( 'Optionia requires WooCommerce %1$s or newer. This site is running WooCommerce %2$s.', 'optionia' ),
					$required,
					$current
				);

			case 'woocommerce_missing':
				return __( 'Optionia requires WooCommerce to be installed and active.', 'optionia' );

			default:
				return __( 'Optionia cannot run in this environment.', 'optionia' );
		}
	}

	/**
	 * Whether WooCommerce is active.
	 *
	 * Checks for the class rather than the plugin file, because WooCommerce may
	 * be loaded as a must-use plugin, from a non-standard directory, or network
	 * activated — all cases a plugin-file check misses.
	 */
	public function is_woocommerce_active(): bool {
		return class_exists( 'WooCommerce', false ) || class_exists( 'WooCommerce' );
	}

	/**
	 * WooCommerce version, or null when it cannot be determined.
	 */
	public function woocommerce_version(): ?string {
		if ( defined( 'WC_VERSION' ) ) {
			return (string) WC_VERSION;
		}

		return null;
	}

	/**
	 * Whether High-Performance Order Storage is enabled.
	 *
	 * Order meta must be written through the CRUD API to work under both
	 * storage backends; this is reported in System Status so support can see
	 * which backend a merchant is on without asking.
	 */
	public function is_hpos_enabled(): bool {
		if ( ! class_exists( \Automattic\WooCommerce\Utilities\OrderUtil::class ) ) {
			return false;
		}

		return \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
	}

	/**
	 * Whether the cart or checkout page uses the block implementation.
	 *
	 * Verified in M2.8: block cart and checkout are the default on a fresh
	 * WooCommerce install even under a classic theme, so this is the common
	 * case rather than an edge case.
	 *
	 * @param string $page Either 'cart' or 'checkout'.
	 */
	public function uses_block_page( string $page ): bool {
		$option = 'cart' === $page ? 'woocommerce_cart_page_id' : 'woocommerce_checkout_page_id';
		$id     = (int) get_option( $option, 0 );

		if ( $id <= 0 ) {
			return false;
		}

		$post = get_post( $id );

		if ( ! $post instanceof \WP_Post ) {
			return false;
		}

		return has_block( 'woocommerce/' . $page, $post );
	}

	/**
	 * Environment summary for System Status (M3.6).
	 *
	 * @return array<string, string>
	 */
	public function summary(): array {
		return array(
			'plugin_version' => OPTIONIA_VERSION,
			'php'            => PHP_VERSION,
			'wordpress'      => get_bloginfo( 'version' ),
			'woocommerce'    => $this->woocommerce_version() ?? 'not active',
			'hpos'           => $this->is_hpos_enabled() ? 'enabled' : 'disabled',
			'cart_block'     => $this->uses_block_page( 'cart' ) ? 'yes' : 'no',
			'checkout_block' => $this->uses_block_page( 'checkout' ) ? 'yes' : 'no',
		);
	}
}
