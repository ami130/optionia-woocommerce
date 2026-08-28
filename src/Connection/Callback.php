<?php
/**
 * Completes a connection: verify `state`, redeem the code, store the credential.
 *
 * ## Why this is not a nonce-protected POST
 *
 * Every other write in this plugin goes through `Admin\Request`, which checks a
 * capability and a WordPress nonce. This one cannot: the request is a **GET
 * redirect the cloud sends the merchant's browser**, and the cloud has no way to
 * produce a WordPress nonce for a site it has never authenticated to.
 *
 * So the CSRF defence is `state` — generated here, sent to the cloud, echoed
 * back through the browser, and compared against what was stored. That is the
 * entire purpose of the value, and it is why a mismatch aborts before anything
 * is redeemed.
 *
 * The capability is still required. A logged-in subscriber following a crafted
 * link must not be able to bind this shop to someone else's workspace.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Connection;

use Optionia\Admin\Request;
use Optionia\Api\PostsToCloud;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Handles the redirect back from the dashboard.
 */
final class Callback {

	/** Nothing to do: this request is not a callback. */
	public const RESULT_NONE = 'none';

	/** Connected. */
	public const RESULT_CONNECTED = 'connected';

	/** The caller may not do this, or the handshake did not match. */
	public const RESULT_REFUSED = 'refused';

	/** The cloud refused the exchange, or could not be reached. */
	public const RESULT_FAILED = 'failed';

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
	 * Handle a possible callback, returning what happened.
	 *
	 * @param array<string, mixed> $query Query parameters, usually `$_GET`.
	 */
	public function handle( array $query ): string {
		$code  = isset( $query['code'] ) ? (string) $query['code'] : '';
		$state = isset( $query['state'] ) ? (string) $query['state'] : '';

		if ( '' === $code || '' === $state ) {
			return self::RESULT_NONE;
		}

		/**
		 * Capability first, before the handshake is even read.
		 *
		 * A subscriber following a crafted link must not be able to bind this
		 * shop to a workspace, and must not learn whether a handshake is pending
		 * by observing a different outcome.
		 */
		if ( ! Request::user_can_manage() ) {
			return self::RESULT_REFUSED;
		}

		$pending = Handshake::pending();

		if ( null === $pending ) {
			return self::RESULT_REFUSED;
		}

		/**
		 * The CSRF check, and the reason `state` exists.
		 *
		 * Compared in constant time: the values are equal-length random tokens,
		 * and `hash_equals` costs nothing here while removing the question.
		 */
		if ( ! hash_equals( $pending['state'], $state ) ) {
			// A mismatched callback is not this handshake. Leave the pending one
			// alone — the real callback may still arrive.
			return self::RESULT_REFUSED;
		}

		$response = $this->client->post(
			'/connect/exchange',
			array(
				'code'     => $code,
				'verifier' => $pending['verifier'],
				'site_url' => home_url( '/' ),
			)
		);

		/**
		 * The handshake is over either way.
		 *
		 * A code is single-use, so a failed exchange cannot be retried with the
		 * same one — keeping the verifier would leave a secret on disk that can
		 * no longer be used for anything.
		 */
		Handshake::forget();

		if ( ! $response->is_ok() ) {
			StateMachine::transition( StateMachine::DISCONNECTED );

			return self::RESULT_FAILED;
		}

		$data = $response->data();

		if ( empty( $data['token'] ) || ! is_string( $data['token'] ) ) {
			StateMachine::transition( StateMachine::DISCONNECTED );

			return self::RESULT_FAILED;
		}

		/**
		 * Autoload **off**, per M8.4.
		 *
		 * The credential is read on API calls, not on every page load, and an
		 * autoloaded option is served into every request WordPress handles.
		 */
		update_option( Keys::OPTION_STORE_TOKEN, $data['token'], false );

		if ( isset( $data['store_id'] ) && is_string( $data['store_id'] ) ) {
			update_option( Keys::OPTION_CONNECTION_STORE, $data['store_id'], false );
		}

		if ( isset( $data['tenant_name'] ) && is_string( $data['tenant_name'] ) ) {
			update_option( Keys::OPTION_CONNECTION_TENANT, $data['tenant_name'], false );
		}

		StateMachine::transition( StateMachine::CONNECTED );

		return self::RESULT_CONNECTED;
	}
}
