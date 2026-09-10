<?php
/**
 * Begins a connection: PKCE, `state`, and the redirect to the dashboard (M8.3).
 *
 * The merchant leaves WordPress between this step and the callback, so the two
 * secrets this generates have to outlive the request that made them — and no
 * longer.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Connection;

use Optionia\Api\PostsToCloud;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Starts the connection handshake.
 */
final class Handshake {

	/**
	 * How long a pending handshake is honoured.
	 *
	 * Thirty minutes, matching the cloud's request lifetime. Shorter here would
	 * strand a merchant whose handshake the cloud still considers live; longer
	 * would keep a usable verifier on disk after the cloud has stopped caring.
	 */
	private const TTL_SECONDS = 1800;

	/**
	 * API client.
	 *
	 * @var PostsToCloud
	 */
	private PostsToCloud $client;

	/**
	 * Construct.
	 *
	 * @param PostsToCloud $client API client.
	 */
	public function __construct( PostsToCloud $client ) {
		$this->client = $client;
	}

	/**
	 * Ask the cloud to begin a handshake, and return where to send the merchant.
	 *
	 * Returns `null` when the cloud refused, leaving the caller to show the
	 * error rather than redirecting into a flow that cannot complete.
	 *
	 * @return string|null The dashboard URL, or null on failure.
	 */
	public function begin(): ?string {
		$verifier = self::random_token();
		$state    = self::random_token();

		$response = $this->client->post(
			'/connect/initiate',
			array(
				'site_url'       => home_url( '/' ),
				'callback'       => $this->callback_url(),

				/**
				 * Where the cloud pushes "new configuration is available" (M9.4).
				 *
				 * A different URL from `callback`: that one is a browser redirect
				 * to an admin screen, and a server posting there reaches a login
				 * page rather than the plugin.
				 *
				 * Sent on every handshake, including reconnects, so a store that
				 * connected before this route existed gains one the moment its
				 * merchant upgrades and reconnects.
				 */
				'push_url'       => PushEndpoint::url(),
				'state'          => $state,
				'challenge'      => self::pkce_challenge( $verifier ),
				'plugin_version' => OPTIONIA_VERSION,
			)
		);

		if ( ! $response->is_ok() ) {
			return null;
		}

		$data = $response->data();

		if ( empty( $data['authorize_url'] ) || ! is_string( $data['authorize_url'] ) ) {
			return null;
		}

		/**
		 * Stored **after** the cloud accepted, not before.
		 *
		 * A refused `initiate` that had already overwritten the stored handshake
		 * would discard a live one — a merchant retrying after a network blip
		 * would lose the attempt that was still valid.
		 */
		self::remember( $state, $verifier );

		StateMachine::transition( StateMachine::CONNECTING );

		return $data['authorize_url'];
	}

	/**
	 * The pending handshake, or null when there is none or it has expired.
	 *
	 * @return array{state: string, verifier: string}|null
	 */
	public static function pending(): ?array {
		$stored = get_option( Keys::OPTION_HANDSHAKE, array() );

		if ( ! is_array( $stored ) || empty( $stored['state'] ) || empty( $stored['verifier'] ) ) {
			return null;
		}

		$expires = isset( $stored['expires'] ) ? (int) $stored['expires'] : 0;

		if ( $expires <= time() ) {
			// Expired verifiers are deleted on sight rather than left to linger.
			self::forget();

			return null;
		}

		return array(
			'state'    => (string) $stored['state'],
			'verifier' => (string) $stored['verifier'],
		);
	}

	/** Discard the pending handshake. Called on success, failure and expiry. */
	public static function forget(): void {
		delete_option( Keys::OPTION_HANDSHAKE );
	}

	/**
	 * Where the cloud sends the merchant back to.
	 *
	 * An admin URL, so the callback arrives at a screen only a signed-in user
	 * with the capability can reach.
	 */
	public function callback_url(): string {
		return admin_url( 'admin.php?page=' . Keys::MENU_SLUG_SETTINGS );
	}

	/**
	 * 32 random bytes, base64url — 43 characters.
	 *
	 * `random_bytes` is the CSPRNG. The length is what the cloud's contract
	 * requires of both `state` (43–128) and a PKCE verifier, and it is 256 bits
	 * of entropy either way.
	 */
	private static function random_token(): string {
		return self::base64url( random_bytes( 32 ) );
	}

	/**
	 * `base64url(SHA-256(verifier))` — PKCE S256.
	 *
	 * Verified to be byte-identical to the cloud's `digest('base64url')`: the
	 * whole handshake turns on these two implementations agreeing, and a
	 * mismatch would surface as an indistinguishable `TOKEN_INVALID` with no
	 * diagnostic on either side.
	 *
	 * @param string $verifier The PKCE verifier.
	 */
	public static function pkce_challenge( string $verifier ): string {
		return self::base64url( hash( 'sha256', $verifier, true ) );
	}

	/**
	 * Base64url: base64 with `+/` swapped for `-_` and padding removed.
	 *
	 * @param string $raw Raw bytes.
	 */
	private static function base64url( string $raw ): string {
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		return rtrim( strtr( base64_encode( $raw ), '+/', '-_' ), '=' );
	}

	/**
	 * Persist the handshake, autoload off.
	 *
	 * @param string $state    CSRF value echoed through the browser.
	 * @param string $verifier PKCE verifier, which must never leave the server.
	 */
	private static function remember( string $state, string $verifier ): void {
		update_option(
			Keys::OPTION_HANDSHAKE,
			array(
				'state'    => $state,
				'verifier' => $verifier,
				'expires'  => time() + self::TTL_SECONDS,
			),
			false
		);
	}
}
