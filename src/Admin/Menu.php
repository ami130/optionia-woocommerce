<?php
/**
 * Admin menu registration (M3.4).
 *
 * Optionia
 * ├── Dashboard   connection status, sync status, diagnostics
 * └── Settings    connection, cache controls, debug log toggle
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Registers the Optionia admin menu and renders the dashboard.
 */
final class Menu {

	/**
	 * Diagnostics report.
	 *
	 * @var SystemStatus
	 */
	private SystemStatus $status;

	/**
	 * Settings screen.
	 *
	 * @var SettingsPage
	 */
	private SettingsPage $settings_page;

	/**
	 * @param SystemStatus $status        Diagnostics report.
	 * @param SettingsPage $settings_page Settings screen.
	 */
	public function __construct( SystemStatus $status, SettingsPage $settings_page ) {
		$this->status        = $status;
		$this->settings_page = $settings_page;
	}

	/**
	 * Register hooks.
	 */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( OPTIONIA_PLUGIN_FILE ), array( $this, 'action_links' ) );
	}

	/**
	 * Add the menu.
	 *
	 * Gated on `manage_woocommerce` so shop managers can reach it — the people
	 * who actually configure products. `manage_options` would restrict it to
	 * administrators and lock out the intended user.
	 */
	public function add_menu(): void {
		add_menu_page(
			__( 'Optionia', 'optionia' ),
			__( 'Optionia', 'optionia' ),
			Keys::CAP_MANAGE,
			Keys::MENU_SLUG,
			array( $this, 'render_dashboard' ),
			'dashicons-list-view',
			56
		);

		add_submenu_page(
			Keys::MENU_SLUG,
			__( 'Dashboard', 'optionia' ),
			__( 'Dashboard', 'optionia' ),
			Keys::CAP_MANAGE,
			Keys::MENU_SLUG,
			array( $this, 'render_dashboard' )
		);

		add_submenu_page(
			Keys::MENU_SLUG,
			__( 'Settings', 'optionia' ),
			__( 'Settings', 'optionia' ),
			Keys::CAP_MANAGE,
			Keys::MENU_SLUG_SETTINGS,
			array( $this->settings_page, 'render' )
		);
	}

	/**
	 * Add a Settings link on the Plugins screen.
	 *
	 * @param string[] $links Existing action links.
	 * @return string[]
	 */
	public function action_links( $links ): array {
		if ( ! is_array( $links ) ) {
			$links = array();
		}

		$settings = sprintf(
			'<a href="%s">%s</a>',
			esc_url( admin_url( 'admin.php?page=' . Keys::MENU_SLUG_SETTINGS ) ),
			esc_html__( 'Settings', 'optionia' )
		);

		array_unshift( $links, $settings );

		return $links;
	}

	/**
	 * Render the dashboard.
	 *
	 * Capability is re-checked here even though add_menu_page() already gated
	 * it: a callback is reachable by anyone who guesses the page slug if the
	 * check is omitted.
	 */
	public function render_dashboard(): void {
		if ( ! Request::user_can_manage() ) {
			wp_die( esc_html__( 'You are not allowed to access this page.', 'optionia' ) );
		}

		$report = $this->status->report();

		echo '<div class="wrap optionia-wrap">';
		printf( '<h1>%s</h1>', esc_html__( 'Optionia', 'optionia' ) );

		printf(
			'<p class="description">%s</p>',
			esc_html__( 'Connection and synchronisation status for this store.', 'optionia' )
		);

		foreach ( $report as $section => $rows ) {
			printf( '<h2>%s</h2>', esc_html( $section ) );
			echo '<table class="widefat striped" style="max-width:760px;margin-bottom:1.5em;"><tbody>';

			foreach ( $rows as $label => $value ) {
				printf(
					'<tr><th scope="row" style="width:220px;">%s</th><td><code>%s</code></td></tr>',
					esc_html( $label ),
					esc_html( $value )
				);
			}

			echo '</tbody></table>';
		}

		printf( '<h2>%s</h2>', esc_html__( 'Copy for support', 'optionia' ) );
		printf(
			'<p class="description">%s</p>',
			esc_html__( 'Paste this into a support request. It contains no credentials.', 'optionia' )
		);
		printf(
			'<textarea readonly rows="16" style="width:100%%;max-width:760px;font-family:monospace;">%s</textarea>',
			esc_textarea( $this->status->as_text() )
		);

		echo '</div>';
	}
}
