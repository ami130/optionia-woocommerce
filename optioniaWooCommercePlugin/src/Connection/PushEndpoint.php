<?php
/**
 * Where the cloud says "new configuration is available" (M9.4).
 *
 * The push carries a version and nothing else. The plugin then **pulls** through
 * `Config\Synchroniser`, over its own authenticated conditional request — which
 * is what lets this endpoint be public without trusting anything it receives.
 *
 * ## Why this exists at all
 *
 * `Config\Synchroniser` already runs every fifteen minutes, so a storefront is
 * never more than that behind. This closes the gap to seconds: a merchant who
 * publishes and immediately reloads their shop should see the change, not
 * wonder whether it worked. M9.4's acceptance is "under 30 seconds on a healthy
 * store, and within 15 minutes even if push delivery fails entirely" — the
 * second half is already met by the cron, which is what makes this a latency
 * improvement rather than a dependency.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Connection;

use Optionia\Config\Synchroniser;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use WP_REST_Request;
use WP_REST_Response;

defined( 'ABSPATH' ) || exit;

/**
 * Registers and handles the inbound push route.
 */
final class PushEndpoint {

	/**
	 * The synchroniser a push wakes.
	 *
	 * @var Synchroniser
	 */
	private Synchroniser $synchroniser;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Synchroniser $synchroniser Configuration synchroniser.
	 * @param Logger       $logger       Logger.
	 */
	public function __construct( Synchroniser $synchroniser, Logger $logger ) {
		$this->synchroniser = $synchroniser;
		$this->logger       = $logger;
	}

	/**
	 * Register the route.
	 */
	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_route' ) );
	}

	/**
	 * Declare the route with WordPress.
	 */
	public function register_route(): void {
		register_rest_route(
			Keys::REST_NAMESPACE,
			Keys::REST_ROUTE_PUSH,
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'handle' ),

				/**
				 * `__return_true`, and the signature is the real check.
				 *
				 * A permission callback here can only ask about the *WordPress*
				 * caller, and the caller is a server with no WordPress identity.
				 * Requiring a capability would refuse every genuine push and
				 * accept none. `Connection\PushSignature` authenticates instead,
				 * against a credential only this store and the cloud hold.
				 *
				 * Returning true is therefore deliberate rather than lazy — and
				 * it is why the handler verifies before doing anything at all.
				 */
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * Handle a push.
	 *
	 * Always answers `200`, whatever happened. The cloud's delivery record is
	 * about whether the *message* arrived, not whether the pull it triggered
	 * succeeded — and a store whose own sync failed would otherwise have the
	 * push retried at it, which fixes nothing and doubles the traffic.
	 *
	 * A refused signature is the exception: that earns `401`, because it is the
	 * one case where the sender should stop.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function handle( WP_REST_Request $request ): WP_REST_Response {
		$signature = (string) $request->get_header( PushSignature::HEADER_SIGNATURE );
		$timestamp = (string) $request->get_header( PushSignature::HEADER_TIMESTAMP );

		if ( ! PushSignature::is_valid( $signature, $timestamp, (string) $request->get_body() ) ) {
			$this->record( false, 'invalid_signature' );

			$this->logger->warning( 'Refused a push with an invalid signature.' );

			return new WP_REST_Response( array( 'accepted' => false ), 401 );
		}

		/**
		 * The version in the payload is advisory and deliberately unused.
		 *
		 * The pull that follows is conditional: it sends the ETag this store
		 * actually holds and takes whatever the cloud answers. Trusting the
		 * pushed number instead would mean acting on a value the channel does
		 * not authenticate the *content* of — and would go wrong the moment two
		 * pushes arrived out of order.
		 */
		$synced = $this->synchroniser->sync();

		$this->record( true, $synced ? 'synced' : 'sync_failed' );

		return new WP_REST_Response( array( 'accepted' => true ), 200 );
	}

	/**
	 * Record the outcome for System Status.
	 *
	 * "Did the cloud reach this shop, and when" is a different question from
	 * "did the sync work", and support needs both: a push that never arrives
	 * points at the store's firewall, while one that arrives and fails to sync
	 * points at the credential.
	 *
	 * @param bool   $accepted Whether the signature verified.
	 * @param string $outcome  What happened next.
	 */
	private function record( bool $accepted, string $outcome ): void {
		update_option(
			Keys::OPTION_LAST_PUSH,
			array(
				'at'       => time(),
				'accepted' => $accepted,
				'outcome'  => $outcome,
			),
			false
		);
	}

	/**
	 * The last recorded push, or null when none has arrived.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function last(): ?array {
		$entry = get_option( Keys::OPTION_LAST_PUSH, null );

		return is_array( $entry ) ? $entry : null;
	}

	/**
	 * The URL the cloud should push to.
	 *
	 * Sent during the handshake so the cloud can store it against the store.
	 * Distinct from `Connection\Handshake::callback_url()`, which is a *browser*
	 * redirect to an admin screen — a server posting there reaches a login page,
	 * not the plugin.
	 */
	public static function url(): string {
		return rest_url( Keys::REST_NAMESPACE . Keys::REST_ROUTE_PUSH );
	}
}
