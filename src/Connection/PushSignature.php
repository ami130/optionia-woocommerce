<?php
/**
 * Verifies that a push really came from the cloud (M9.4).
 *
 * The push endpoint cannot require a WordPress login — the cloud is a server,
 * not a signed-in user — so the URL is public and the *signature* is the
 * authentication. The key is the store credential, which the plugin already
 * holds and the cloud can reproduce, so nothing new has to be shared.
 *
 * ## What a forged push can achieve
 *
 * Almost nothing, by design. The push carries **no configuration**: it says a
 * version is available and the plugin then pulls it over its own authenticated,
 * conditional request. A perfectly forged push therefore causes at most one
 * `GET /store/config` that returns `304`.
 *
 * That is the reason the channel needs no payload trust, and it is worth
 * keeping: a future push that carried configuration would turn this public
 * endpoint into an injection surface, and this verification would be the only
 * thing standing in front of it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Connection;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * HMAC verification for inbound pushes.
 */
final class PushSignature {

	/**
	 * How far a timestamp may be from now, in seconds.
	 *
	 * Bounds replay: a captured push cannot be resent days later to trigger
	 * pulls. Five minutes is generous enough for clock drift between two
	 * machines nobody synchronised, and short enough that a captured request is
	 * not a durable capability.
	 *
	 * Replay is not dangerous here — the pull it triggers is conditional and
	 * idempotent — but the window costs nothing and removes the question.
	 *
	 * ## What the window does not do
	 *
	 * Inside it, a captured push can be replayed: measured at twenty replays
	 * producing twenty conditional `GET`s. That is 1:1 amplification, not 1:N,
	 * and each one returns `304` with no document transferred.
	 *
	 * Three things already bound it, which is why there is no nonce cache here.
	 * Capturing a request means intercepting TLS in the first place; the
	 * capability expires with the window; and the cloud caps `/store/config` at
	 * 120 requests an hour, so the ceiling is the cloud's, not this store's.
	 * A nonce cache would add per-request state to defend against an attacker
	 * who, by then, already holds the connection.
	 */
	private const TOLERANCE_SECONDS = 300;

	/**
	 * Header carrying the signature, as WordPress presents it.
	 */
	public const HEADER_SIGNATURE = 'x_optionia_signature';

	/** Header carrying the unix timestamp the signature covers. */
	public const HEADER_TIMESTAMP = 'x_optionia_timestamp';

	/**
	 * Whether a request is a genuine push from the cloud.
	 *
	 * @param string $signature Presented signature, `sha256=<hex>`.
	 * @param string $timestamp Presented unix timestamp, as a string.
	 * @param string $body      Raw request body, exactly as received.
	 */
	public static function is_valid( string $signature, string $timestamp, string $body ): bool {
		$credential = (string) get_option( Keys::OPTION_STORE_TOKEN, '' );

		if ( '' === $credential ) {
			// Nothing to verify against. A store that holds no credential has
			// no relationship with the cloud, so no request can be from it.
			return false;
		}

		if ( ! self::is_fresh( $timestamp ) ) {
			return false;
		}

		/**
		 * The timestamp is inside the signed material, not merely alongside it.
		 *
		 * Signing the body alone would let an attacker replay a captured push
		 * with any timestamp they liked, which is the freshness check answering
		 * a question the signature never asked.
		 */
		$expected = 'sha256=' . hash_hmac( 'sha256', $timestamp . '.' . $body, $credential );

		/**
		 * `hash_equals`, never `===`.
		 *
		 * String comparison returns early on the first differing byte, so its
		 * timing leaks how much of a guess was right. The same reasoning as the
		 * handshake's `state` check in `Connection\Callback`.
		 */
		return hash_equals( $expected, $signature );
	}

	/**
	 * Whether a timestamp is close enough to now.
	 *
	 * Rejects non-numeric input rather than coercing it: `(int) 'abc'` is `0`,
	 * which is 1970 and would fail the window anyway — but only by accident,
	 * and an accident is not a check.
	 *
	 * @param string $timestamp Presented unix timestamp.
	 */
	private static function is_fresh( string $timestamp ): bool {
		if ( '' === $timestamp || ! ctype_digit( $timestamp ) ) {
			return false;
		}

		return abs( time() - (int) $timestamp ) <= self::TOLERANCE_SECONDS;
	}
}
