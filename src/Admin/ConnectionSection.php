<?php
/**
 * Settings → Connection (M8.3).
 *
 * The merchant-facing half of the handshake: a connect button, what the shop is
 * connected to, and a way out. `Connection\Handshake` and `Connection\Callback`
 * do the work; this is where a person reaches them.
 *
 * ## The callback is dispatched from here
 *
 * The cloud redirects the merchant's browser back to this screen with `code` and
 * `state` in the query. `admin_init` runs before the page renders, so the
 * exchange completes and the screen draws the result rather than the request
 * that produced it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Renders and drives the connection screen.
 */
final class ConnectionSection {

	/** Query flag carrying the outcome of a connection attempt. */
	private const RESULT_FLAG = 'optionia_connection';

	/**
	 * Handshake starter.
	 *
	 * @var Handshake
	 */
	private Handshake $handshake;

	/**
	 * Callback handler.
	 *
	 * @var Callback
	 */
	private Callback $callback;

	/**
	 * Construct.
	 *
	 * @param Handshake $handshake Handshake starter.
	 * @param Callback  $callback  Callback handler.
	 */
	public function __construct( Handshake $handshake, Callback $callback ) {
		$this->handshake = $handshake;
		$this->callback  = $callback;
	}

	/**
	 * Hook into the admin lifecycle.
	 */
	public function register(): void {
		add_action( 'admin_init', array( $this, 'maybe_handle_callback' ) );
		add_action( 'admin_init', array( $this, 'maybe_connect' ) );
		add_action( 'admin_init', array( $this, 'maybe_disconnect' ) );
	}

	/**
	 * Complete a handshake when the cloud has redirected the merchant back.
	 *
	 * No nonce: this is a GET the **cloud** caused, and the cloud cannot produce
	 * a WordPress nonce for a site it has never authenticated to. `state` is the
	 * CSRF defence, verified inside `Callback` against what was stored, and the
	 * capability is checked there before the handshake is even read.
	 */
	public function maybe_handle_callback(): void {
		if ( ! $this->on_settings_screen() ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- see the docblock: `state` is the defence.
		$query = wp_unslash( $_GET );

		if ( ! is_array( $query ) ) {
			return;
		}

		$result = $this->callback->handle( $query );

		if ( Callback::RESULT_NONE === $result ) {
			return;
		}

		// Post/redirect/get, so a refresh does not replay a spent code.
		$this->redirect_with( $result );
	}

	/**
	 * Begin a handshake and send the merchant to the dashboard.
	 */
	public function maybe_connect(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- presence check only; verified below.
		if ( ! isset( $_POST['optionia_connect_submit'] ) ) {
			return;
		}

		Request::require_post( Keys::NONCE_CONNECT, 'optionia_connect_nonce' );

		$url = $this->handshake->begin();

		if ( null === $url ) {
			$this->redirect_with( Callback::RESULT_FAILED );
		}

		/**
		 * `wp_redirect`, not `wp_safe_redirect`.
		 *
		 * The destination is the cloud dashboard, which is off-site by design —
		 * `wp_safe_redirect` would refuse it and strand the merchant. The URL is
		 * not merchant input: it came from the API base this plugin is
		 * configured with, in a response the client validated.
		 */
		// phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect -- off-site by design; see above.
		wp_redirect( $url );

		exit;
	}

	/**
	 * Forget the credential locally.
	 *
	 * The cloud is told separately — a merchant disconnecting from the dashboard
	 * revokes there — but a plugin that cannot clear its own token is a plugin a
	 * merchant cannot recover without database access.
	 */
	public function maybe_disconnect(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- presence check only; verified below.
		if ( ! isset( $_POST['optionia_disconnect_submit'] ) ) {
			return;
		}

		Request::require_post( Keys::NONCE_DISCONNECT, 'optionia_disconnect_nonce' );

		delete_option( Keys::OPTION_STORE_TOKEN );
		delete_option( Keys::OPTION_CONNECTION_STORE );
		delete_option( Keys::OPTION_CONNECTION_TENANT );
		Handshake::forget();

		StateMachine::transition( StateMachine::DISCONNECTED );

		$this->redirect_with( 'disconnected' );
	}

	/**
	 * Render the connection panel.
	 */
	public function render(): void {
		$state = StateMachine::current();

		echo '<h2>' . esc_html__( 'Connection', 'optionia' ) . '</h2>';

		$this->render_notice();

		if ( StateMachine::CONNECTED === $state || StateMachine::ERROR === $state ) {
			$this->render_connected( $state );

			return;
		}

		$this->render_disconnected( $state );
	}

	/**
	 * The connected panel: what this shop is attached to, and a way out.
	 *
	 * @param string $state Current connection state.
	 */
	private function render_connected( string $state ): void {
		$tenant = (string) get_option( Keys::OPTION_CONNECTION_TENANT, '' );
		$store  = (string) get_option( Keys::OPTION_CONNECTION_STORE, '' );

		echo '<table class="form-table"><tbody>';
		$this->row( __( 'Status', 'optionia' ), $this->state_label( $state ) );

		if ( '' !== $tenant ) {
			$this->row( __( 'Workspace', 'optionia' ), $tenant );
		}

		if ( '' !== $store ) {
			$this->row( __( 'Store ID', 'optionia' ), $store );
		}

		echo '</tbody></table>';

		echo '<form method="post">';
		wp_nonce_field( Keys::NONCE_DISCONNECT, 'optionia_disconnect_nonce' );
		echo '<p><button type="submit" name="optionia_disconnect_submit" class="button">'
			. esc_html__( 'Disconnect', 'optionia' )
			. '</button></p>';
		echo '<p class="description">'
			. esc_html__(
				'Disconnecting stops this shop receiving new option sets. Options already saved keep working on your product pages.',
				'optionia'
			)
			. '</p>';
		echo '</form>';
	}

	/**
	 * The disconnected panel: one button, and what it will do.
	 *
	 * @param string $state Current connection state.
	 */
	private function render_disconnected( string $state ): void {
		echo '<p>' . esc_html( $this->state_label( $state ) ) . '</p>';

		echo '<form method="post">';
		wp_nonce_field( Keys::NONCE_CONNECT, 'optionia_connect_nonce' );
		echo '<p><button type="submit" name="optionia_connect_submit" class="button button-primary">'
			. esc_html__( 'Connect this store', 'optionia' )
			. '</button></p>';
		echo '<p class="description">'
			. esc_html__(
				'You will be taken to Optionia to choose which workspace this shop belongs to, then returned here.',
				'optionia'
			)
			. '</p>';
		echo '</form>';
	}

	/**
	 * Plain-language state, per M8.3. No status codes, no jargon.
	 *
	 * @param string $state Current connection state.
	 */
	private function state_label( string $state ): string {
		switch ( $state ) {
			case StateMachine::CONNECTED:
				return __( 'Connected.', 'optionia' );
			case StateMachine::CONNECTING:
				return __( 'Waiting for authorization. Finish connecting in Optionia, or start again below.', 'optionia' );
			case StateMachine::ERROR:
				return __( 'Connected, but the last sync failed. Your product pages keep working from the saved copy.', 'optionia' );
			case StateMachine::REVOKED:
				return __( 'This connection was revoked. Reconnect to publish changes again.', 'optionia' );
			default:
				return __( 'This shop is not connected to Optionia yet.', 'optionia' );
		}
	}

	/**
	 * The outcome of the last attempt, in words a merchant can act on.
	 */
	private function render_notice(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- a display flag, not an action.
		$result = isset( $_GET[ self::RESULT_FLAG ] ) ? sanitize_key( wp_unslash( $_GET[ self::RESULT_FLAG ] ) ) : '';

		if ( '' === $result ) {
			return;
		}

		$messages = array(
			Callback::RESULT_CONNECTED => array( 'success', __( 'Connected to Optionia.', 'optionia' ) ),
			'disconnected'             => array( 'success', __( 'Disconnected. Saved options keep working.', 'optionia' ) ),
			Callback::RESULT_REFUSED   => array(
				'error',
				__( 'That connection link did not match this shop. Start again from the button below.', 'optionia' ),
			),
			Callback::RESULT_FAILED    => array(
				'error',
				__( 'Optionia could not complete the connection. Check the site can reach the internet, then try again.', 'optionia' ),
			),
		);

		if ( ! isset( $messages[ $result ] ) ) {
			return;
		}

		printf(
			'<div class="notice notice-%s"><p>%s</p></div>',
			esc_attr( $messages[ $result ][0] ),
			esc_html( $messages[ $result ][1] )
		);
	}

	/**
	 * One row of the status table.
	 *
	 * @param string $label Row label.
	 * @param string $value Row value.
	 */
	private function row( string $label, string $value ): void {
		printf(
			'<tr><th scope="row">%s</th><td>%s</td></tr>',
			esc_html( $label ),
			esc_html( $value )
		);
	}

	/** Whether this request is for the settings screen. */
	private function on_settings_screen(): bool {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- routing only.
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : '';

		return Keys::MENU_SLUG_SETTINGS === $page;
	}

	/**
	 * Redirect back to the screen carrying an outcome, and stop.
	 *
	 * @param string $result Outcome flag.
	 */
	private function redirect_with( string $result ): void {
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'            => Keys::MENU_SLUG_SETTINGS,
					self::RESULT_FLAG => $result,
				),
				admin_url( 'admin.php' )
			)
		);

		exit;
	}
}
