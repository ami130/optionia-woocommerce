<?php
/**
 * Admin notices for unmet requirements.
 *
 * The only thing that registers when the plugin cannot boot (M3.3). The site
 * and WP Admin must remain fully functional; the merchant simply gets told what
 * is missing.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Support\Environment;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Renders requirement failures as a dismissible admin notice.
 */
final class Notices {

	/**
	 * Unmet requirements, as returned by Support\Environment.
	 *
	 * @var array<int, array{code: string, context: array<string, string>}>
	 */
	private array $problems;

	/**
	 * Environment probe, used to render messages at display time.
	 *
	 * @var Environment
	 */
	private Environment $environment;

	/**
	 * Constructor.
	 *
	 * @param array<int, array{code: string, context: array<string, string>}> $problems    Unmet requirements.
	 * @param Environment                                                     $environment Environment probe.
	 */
	public function __construct( array $problems, Environment $environment ) {
		$this->problems    = $problems;
		$this->environment = $environment;
	}

	/**
	 * Register the notice.
	 */
	public function register(): void {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Render the notice.
	 *
	 * Shown only to users who could act on it. Telling a subscriber that
	 * WooCommerce is missing is noise they cannot resolve.
	 */
	public function render(): void {
		if ( ! current_user_can( Keys::CAP_MANAGE ) && ! current_user_can( 'activate_plugins' ) ) {
			return;
		}

		if ( array() === $this->problems ) {
			return;
		}

		echo '<div class="notice notice-error"><p><strong>';
		echo esc_html__( 'Optionia is not running.', 'optionia' );
		echo '</strong></p><ul style="margin-left:1.5em;list-style:disc;">';

		foreach ( $this->problems as $problem ) {
			// Translated here rather than at boot: this runs on `admin_notices`,
			// long after `init`, so the text domain is loaded.
			printf( '<li>%s</li>', esc_html( $this->environment->describe( $problem ) ) );
		}

		echo '</ul></div>';
	}
}
