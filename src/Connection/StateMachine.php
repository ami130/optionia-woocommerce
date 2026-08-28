<?php
/**
 * The plugin's half of the connection state machine (M8.1b).
 *
 * M8.1b requires connection state to be "an explicit, persisted state machine on
 * **both sides** — not inferred from whether a token happens to be present".
 * The cloud's half exists and is enforced by a gate; this is the other half.
 *
 * Inferring state from the token is precisely the failure the milestone names:
 * a token can be present and revoked, absent mid-handshake, or present on a
 * cloned site that must not consider itself connected. The plugin therefore
 * records what it believes and reports that belief on every heartbeat, so a
 * disagreement is visible rather than silently resolved in someone's favour.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Connection;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Reads and writes the plugin's connection state.
 */
final class StateMachine {

	/** No connection. The starting state and the one a disconnect returns to. */
	public const DISCONNECTED = 'disconnected';

	/** A handshake is in flight: the merchant is away authorising it. */
	public const CONNECTING = 'connecting';

	/** A credential is held and the cloud accepted it. */
	public const CONNECTED = 'connected';

	/** A sync or auth failure. The storefront keeps serving its cache (AC3). */
	public const ERROR = 'error';

	/** The cloud revoked the credential. Reconnect to publish again. */
	public const REVOKED = 'revoked';

	/**
	 * Which states may precede each state.
	 *
	 * Mirrors the cloud's table deliberately, including its one asymmetry:
	 * `CONNECTED` is **not** self-reachable, because arriving there twice would
	 * mean a second handshake completed against a connection already live.
	 * Every other state may be re-entered, so a repeated disconnect or a
	 * repeated failure is a no-op rather than an error.
	 *
	 * @return array<string, string[]>
	 */
	private static function allowed_from(): array {
		return array(
			self::CONNECTING   => array(
				self::DISCONNECTED,
				self::CONNECTING,
				self::CONNECTED,
				self::ERROR,
				self::REVOKED,
			),
			self::CONNECTED    => array( self::CONNECTING, self::ERROR ),
			self::ERROR        => array( self::CONNECTED, self::ERROR ),
			self::DISCONNECTED => array(
				self::CONNECTING,
				self::CONNECTED,
				self::ERROR,
				self::REVOKED,
				self::DISCONNECTED,
			),
			self::REVOKED      => array(
				self::CONNECTING,
				self::CONNECTED,
				self::ERROR,
				self::REVOKED,
			),
		);
	}

	/**
	 * Every state this machine knows.
	 *
	 * @return string[]
	 */
	public static function states(): array {
		return array_keys( self::allowed_from() );
	}

	/**
	 * The plugin's current belief about its connection.
	 *
	 * Defaults to `DISCONNECTED` rather than inferring from the token: a stored
	 * token proves a handshake once completed, not that it is still honoured.
	 */
	public static function current(): string {
		$state = get_option( Keys::OPTION_CONNECTION_STATE, self::DISCONNECTED );

		return in_array( $state, self::states(), true ) ? (string) $state : self::DISCONNECTED;
	}

	/**
	 * Listen for a credential the cloud no longer accepts (M8.6).
	 *
	 * `Api\Client` announces a `401` and knows nothing more; this decides what
	 * it means. A revoked store keeps serving its cached configuration — AC3 —
	 * so the transition records that publishing has stopped, not that the shop
	 * has.
	 */
	public static function listen(): void {
		add_action( 'optionia_unauthorized', array( self::class, 'on_unauthorized' ) );
	}

	/**
	 * A request was refused as unauthenticated.
	 *
	 * Only a store that believes itself connected can *become* revoked. A `401`
	 * during a handshake, or on a store already disconnected, says nothing new —
	 * and the machine refuses those transitions anyway, so this guard is about
	 * intent rather than safety.
	 */
	public static function on_unauthorized(): void {
		$current = self::current();

		if ( self::CONNECTED !== $current && self::ERROR !== $current ) {
			return;
		}

		self::transition( self::REVOKED );
	}

	/**
	 * Whether the machine permits `from` → `to`.
	 *
	 * @param string $from Current state.
	 * @param string $to   Desired state.
	 */
	public static function can( string $from, string $to ): bool {
		$table = self::allowed_from();

		return isset( $table[ $to ] ) && in_array( $from, $table[ $to ], true );
	}

	/**
	 * Move to `to`, and report whether the move was allowed.
	 *
	 * Returns `false` instead of throwing, because callers differ on what an
	 * illegal transition means: a stale callback arriving after a disconnect is
	 * something to ignore, while the same refusal during a fresh handshake is
	 * worth surfacing to the merchant.
	 *
	 * @param string $to Desired state.
	 */
	public static function transition( string $to ): bool {
		if ( ! self::can( self::current(), $to ) ) {
			return false;
		}

		update_option( Keys::OPTION_CONNECTION_STATE, $to, false );

		return true;
	}
}
