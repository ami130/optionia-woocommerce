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

use Optionia\Api\AllowsDeliberateRetry;
use Optionia\Api\PostsToCloud;
use Optionia\Catalogue\CatalogueCursor;
use Optionia\Catalogue\ProductQueue;
use Optionia\Config\Synchroniser;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Renders and drives the connection screen.
 */
final class ConnectionSection {

	/** Query flag carrying the outcome of a connection attempt. */
	private const RESULT_FLAG = 'optionia_connection';

	/** A merchant-initiated sync succeeded. */
	private const RESULT_SYNCED = 'synced';

	/** A merchant-initiated sync failed; the shop keeps its saved copy. */
	private const RESULT_SYNC_FAILED = 'sync_failed';

	/** Outcome flag: a fresh catalogue walk was started (M19.1). */
	private const RESULT_CATALOGUE_QUEUED = 'catalogue_queued';

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
	 * Circuit breaker, cleared when a merchant asks for a connection.
	 *
	 * @var AllowsDeliberateRetry
	 */
	private AllowsDeliberateRetry $breaker;

	/**
	 * Pulls configuration when a merchant asks for it.
	 *
	 * @var Synchroniser
	 */
	private Synchroniser $synchroniser;

	/**
	 * The cloud, for telling it we are leaving.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $api;

	/**
	 * Construct.
	 *
	 * @param Handshake             $handshake Handshake starter.
	 * @param Callback              $callback  Callback handler.
	 * @param AllowsDeliberateRetry $breaker      Circuit breaker.
	 * @param Synchroniser          $synchroniser Configuration synchroniser.
	 * @param PostsToCloud          $api          Cloud client, for announcing a disconnect.
	 */
	public function __construct(
		Handshake $handshake,
		Callback $callback,
		AllowsDeliberateRetry $breaker,
		Synchroniser $synchroniser,
		PostsToCloud $api
	) {
		$this->handshake    = $handshake;
		$this->callback     = $callback;
		$this->breaker      = $breaker;
		$this->synchroniser = $synchroniser;
		$this->api          = $api;
	}

	/**
	 * Hook into the admin lifecycle.
	 */
	public function register(): void {
		add_action( 'admin_init', array( $this, 'maybe_handle_callback' ) );
		add_action( 'admin_init', array( $this, 'maybe_connect' ) );
		add_action( 'admin_init', array( $this, 'maybe_disconnect' ) );
		add_action( 'admin_init', array( $this, 'maybe_sync' ) );
		add_action( 'admin_init', array( $this, 'maybe_sync_catalogue' ) );
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

		/**
		 * Clear the circuit before asking.
		 *
		 * A store whose credential was revoked keeps heartbeating daily, and
		 * every one of those pings earns a 401 -- five of them open the circuit,
		 * with no success in between to reset it. The merchant then clicks this
		 * button and the request never leaves the site.
		 *
		 * The breaker is there to stop automatic traffic hammering a failing
		 * cloud. This is not automatic traffic: someone is sitting here waiting
		 * for an answer. Reconnection must not be blocked by the very failures
		 * that made it necessary.
		 */
		$this->breaker->allow_deliberate_retry();

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
	 * Fetch configuration now, because a merchant asked.
	 *
	 * WP-Cron is request-triggered, so on a low-traffic shop a fifteen minute
	 * schedule can mean hours. This is the deterministic escape hatch M9.3
	 * requires: a merchant who has just published and cannot see the change
	 * gets to ask rather than wait.
	 */
	public function maybe_sync(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- presence check only; verified below.
		if ( ! isset( $_POST['optionia_sync_submit'] ) ) {
			return;
		}

		Request::require_post( Keys::NONCE_SYNC_NOW, 'optionia_sync_nonce' );

		/**
		 * Clear the circuit before asking, exactly as connecting does.
		 *
		 * A shop whose cloud has been unreachable accumulates breaker failures
		 * from its own scheduled syncs — and the merchant pressing this button
		 * is precisely the person who has noticed. Refusing them locally, with
		 * no request leaving the site, would make the escape hatch useless in
		 * the one situation it exists for.
		 */
		$this->breaker->allow_deliberate_retry();

		$this->redirect_with(
			$this->synchroniser->sync() ? self::RESULT_SYNCED : self::RESULT_SYNC_FAILED
		);
	}

	/**
	 * Start a fresh catalogue walk (M19.1).
	 *
	 * 🔴 **The interim answer to a gap M19.2 closes.** `CatalogueCursor` records
	 * the catalogue total **once**, when a walk starts, and the walk stops on
	 * reaching it — so products added afterwards sit past the cursor and are
	 * never pushed. M19.2's WordPress hooks are what carry ongoing changes, and
	 * until they exist a merchant who adds a product has no way to send it.
	 *
	 * ⚠️ **Forgetting the cursor is the whole mechanism**, and it is deliberate
	 * rather than a shortcut: the next cron run finds no walk in progress and
	 * starts one against the current catalogue, reading the total afresh. The
	 * push is idempotent — `uq_store_products_external` upserts — so re-sending
	 * products the cloud already has costs requests, not correctness.
	 *
	 * 📌 **It queues rather than pushing here.** A walk is hundreds of batches
	 * over days; doing any of it inside an admin request would block the page
	 * for one batch and finish none of the rest. The button starts the walk, and
	 * the schedule that already exists does the work.
	 */
	public function maybe_sync_catalogue(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- presence check only; verified below.
		if ( ! isset( $_POST['optionia_sync_catalogue_submit'] ) ) {
			return;
		}

		Request::require_post( Keys::NONCE_SYNC_CATALOGUE, 'optionia_sync_catalogue_nonce' );

		/*
		 * The same reasoning as "Sync now" above: a merchant pressing this is
		 * the person who has noticed something is wrong, and refusing them
		 * locally would make the escape hatch useless exactly when it is needed.
		 */
		$this->breaker->allow_deliberate_retry();

		( new CatalogueCursor() )->forget();

		$this->redirect_with( self::RESULT_CATALOGUE_QUEUED );
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

		/*
		 * Tell the cloud first, while the credential still exists.
		 *
		 * 🔴 Without this a merchant disconnecting here left a **live credential**
		 * behind: the store stayed `connected` in the cloud and the dashboard went
		 * on offering a Disconnect for a store already gone. Found by a merchant
		 * within minutes of using it, because every automated test disconnects
		 * through the dashboard -- the path that already worked.
		 *
		 * It cannot be done afterwards, and it cannot be left to the heartbeat:
		 * both authenticate with the very token the lines below delete, so once
		 * this method finishes there is no way left to say anything.
		 *
		 * **Best-effort on purpose.** The local clear below runs whatever happens
		 * -- an unreachable cloud, an expired credential, a 500. A plugin that
		 * refused to disconnect because the network was down would strand a
		 * merchant with no way out but database access, which is the failure this
		 * whole method exists to prevent.
		 */
		try {
			$this->api->post( '/store/disconnect' );
		} catch ( \Throwable $e ) {
			// Deliberately swallowed: see above. The cloud keeps a live credential
			// the merchant can still revoke from the dashboard, which is strictly
			// better than a plugin that cannot let go.
			unset( $e );
		}

		delete_option( Keys::OPTION_STORE_TOKEN );
		delete_option( Keys::OPTION_CONNECTION_STORE );
		delete_option( Keys::OPTION_CONNECTION_TENANT );

		/*
		 * 🔴 **The catalogue walk is forgotten too, or a reconnect resumes into
		 * the wrong store.** The cursor holds an offset against *a* cloud
		 * catalogue. Disconnect, reconnect to a **different** store, and the
		 * walk carries on at offset 40,000 against an empty mirror — products
		 * 0-39,999 never pushed, and nothing reporting it. Reconnecting to the
		 * *same* store costs one re-walk, which M19.1 is idempotent about.
		 */
		( new CatalogueCursor() )->forget();

		/*
		 * ⚠️ **And the pending changes with it.** Queue entries name products
		 * whose state *this* cloud has not been told about; a reconnect to a
		 * different store would push one store's edits into another's mirror.
		 */
		( new ProductQueue( new Logger( new Settings() ) ) )->clear();

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

		/**
		 * "Sync now" (M9.3).
		 *
		 * WP-Cron is request-triggered, so on a low-traffic shop a fifteen
		 * minute schedule can mean hours. A merchant who has just published and
		 * cannot see the change needs a way to ask, rather than being told to
		 * wait and hope.
		 */
		echo '<form method="post">';
		wp_nonce_field( Keys::NONCE_SYNC_NOW, 'optionia_sync_nonce' );
		echo '<p><button type="submit" name="optionia_sync_submit" class="button">'
			. esc_html__( 'Sync now', 'optionia' )
			. '</button></p>';
		echo '<p class="description">'
			. esc_html__(
				'Fetches the latest option sets from Optionia. Your product pages keep working while it runs.',
				'optionia'
			)
			. '</p>';
		echo '</form>';

		/**
		 * "Sync catalogue" (M19.1).
		 *
		 * Separate from "Sync now" above because the two move data in opposite
		 * directions: that one **fetches** option sets from the cloud, this one
		 * **sends** products to it. A single button doing both would hide which
		 * half failed.
		 */
		echo '<form method="post">';
		wp_nonce_field( Keys::NONCE_SYNC_CATALOGUE, 'optionia_sync_catalogue_nonce' );
		echo '<p><button type="submit" name="optionia_sync_catalogue_submit" class="button">'
			. esc_html__( 'Sync catalogue', 'optionia' )
			. '</button></p>';
		echo '<p class="description">'
			. esc_html__(
				'Sends your products to Optionia again, from the beginning. Use this after adding products, or if the assignment picker is missing something.',
				'optionia'
			)
			. '</p>';
		echo '</form>';

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
			Callback::RESULT_CONNECTED    => array( 'success', __( 'Connected to Optionia.', 'optionia' ) ),
			'disconnected'                => array( 'success', __( 'Disconnected. Saved options keep working.', 'optionia' ) ),
			Callback::RESULT_REFUSED      => array(
				'error',
				__( 'That connection link did not match this shop. Start again from the button below.', 'optionia' ),
			),
			self::RESULT_SYNCED           => array(
				'success',
				__( 'Options are up to date.', 'optionia' ),
			),
			self::RESULT_SYNC_FAILED      => array(
				'error',
				__( 'Optionia could not fetch the latest options. Your product pages keep working from the saved copy — try again in a moment.', 'optionia' ),
			),
			self::RESULT_CATALOGUE_QUEUED => array(
				'success',
				__( 'Your catalogue will be sent again shortly. A large catalogue arrives in batches — check the Catalogue sync row on the Optionia dashboard for progress.', 'optionia' ),
			),
			Callback::RESULT_FAILED       => array(
				'error',
				__( 'Optionia could not reach the connection service. This is usually temporary — wait a moment and try again. If it keeps happening, check that this site can make outbound HTTPS requests.', 'optionia' ),
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
