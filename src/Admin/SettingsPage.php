<?php
/**
 * Settings screen (M3.4).
 *
 * Hand-rolled rather than using the Settings API: the eventual screen has
 * connection state, cache controls and destructive toggles that do not map onto
 * register_setting()'s single-option-per-field model. Every write still goes
 * through Request's capability + nonce guard.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Support\Keys;
use Optionia\Support\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Renders and persists merchant settings.
 */
final class SettingsPage {

	/**
	 * Settings.
	 *
	 * @var Settings
	 */
	private Settings $settings;

	/**
	 * Query argument signalling a successful save after the redirect.
	 */
	private const SAVED_FLAG = 'optionia-saved';

	/**
	 * Constructor.
	 *
	 * @param Settings $settings Settings.
	 */
	public function __construct( Settings $settings ) {
		$this->settings = $settings;
	}

	/**
	 * Register hooks.
	 *
	 * Saving runs on `admin_init`, before any output, so the redirect below is
	 * still possible.
	 */
	public function register(): void {
		add_action( 'admin_init', array( $this, 'maybe_save' ) );
	}

	/**
	 * Persist the form when it has been submitted.
	 */
	public function maybe_save(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- presence check only; verified below.
		if ( ! isset( $_POST['optionia_settings_submit'] ) ) {
			return;
		}

		Request::require_post( Keys::NONCE_SETTINGS, 'optionia_settings_nonce' );

		$this->settings->save(
			array(
				Keys::SETTING_DEBUG_LOGGING       => Request::post_bool( Keys::SETTING_DEBUG_LOGGING ),
				Keys::SETTING_DELETE_ON_UNINSTALL => Request::post_bool( Keys::SETTING_DELETE_ON_UNINSTALL ),
				Keys::SETTING_API_BASE_URL        => Request::post_url( Keys::SETTING_API_BASE_URL ),
			)
		);

		// Post/redirect/get. Without the redirect the POST body survives in the
		// browser, so a refresh silently re-submits the form — and the browser
		// warns the merchant about resubmission on a screen where nothing was
		// wrong.
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'           => Keys::MENU_SLUG_SETTINGS,
					self::SAVED_FLAG => '1',
				),
				admin_url( 'admin.php' )
			)
		);

		exit;
	}

	/**
	 * Render the screen.
	 */
	public function render(): void {
		if ( ! Request::user_can_manage() ) {
			wp_die( esc_html__( 'You are not allowed to access this page.', 'optionia' ) );
		}

		$api_url_overridden = defined( 'OPTIONIA_API_URL' );

		echo '<div class="wrap optionia-wrap">';
		printf( '<h1>%s</h1>', esc_html__( 'Optionia Settings', 'optionia' ) );

		// A read-only flag on a capability-gated screen: worth no nonce, and
		// showing a stale success notice is harmless.
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( isset( $_GET[ self::SAVED_FLAG ] ) ) {
			printf(
				'<div class="notice notice-success is-dismissible"><p>%s</p></div>',
				esc_html__( 'Settings saved.', 'optionia' )
			);
		}

		echo '<form method="post" action="">';
		wp_nonce_field( Keys::NONCE_SETTINGS, 'optionia_settings_nonce' );

		echo '<table class="form-table" role="presentation"><tbody>';

		// --- Debug logging ---------------------------------------------------
		printf(
			'<tr><th scope="row"><label for="%1$s">%2$s</label></th><td>
				<input type="checkbox" id="%1$s" name="%1$s" value="1" %3$s />
				<p class="description">%4$s</p></td></tr>',
			esc_attr( Keys::SETTING_DEBUG_LOGGING ),
			esc_html__( 'Debug logging', 'optionia' ),
			checked( $this->settings->is_debug_logging_enabled(), true, false ),
			esc_html__( 'Write verbose logs to WooCommerce → Status → Logs. Enable only while troubleshooting.', 'optionia' )
		);

		// --- API base URL ----------------------------------------------------
		printf(
			'<tr><th scope="row"><label for="%1$s">%2$s</label></th><td>
				<input type="url" class="regular-text code" id="%1$s" name="%1$s" value="%3$s" %4$s />
				<p class="description">%5$s</p></td></tr>',
			esc_attr( Keys::SETTING_API_BASE_URL ),
			esc_html__( 'API base URL', 'optionia' ),
			esc_attr( $this->settings->api_base_url() ),
			$api_url_overridden ? 'disabled' : '',
			$api_url_overridden
				? esc_html__( 'Overridden by the OPTIONIA_API_URL constant in wp-config.php.', 'optionia' )
				: esc_html__( 'Leave blank to use the default Optionia API.', 'optionia' )
		);

		// --- Delete on uninstall ---------------------------------------------
		printf(
			'<tr><th scope="row"><label for="%1$s">%2$s</label></th><td>
				<input type="checkbox" id="%1$s" name="%1$s" value="1" %3$s />
				<p class="description">%4$s</p></td></tr>',
			esc_attr( Keys::SETTING_DELETE_ON_UNINSTALL ),
			esc_html__( 'Delete data on uninstall', 'optionia' ),
			checked( $this->settings->should_delete_on_uninstall(), true, false ),
			esc_html__( 'When enabled, deleting the plugin removes all Optionia data from this site. Off by default so troubleshooting cannot destroy your configuration.', 'optionia' )
		);

		echo '</tbody></table>';

		submit_button( __( 'Save settings', 'optionia' ), 'primary', 'optionia_settings_submit' );

		echo '</form></div>';
	}
}
