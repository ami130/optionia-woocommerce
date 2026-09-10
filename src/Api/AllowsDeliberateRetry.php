<?php
/**
 * The one thing the connect screen needs from the circuit breaker.
 *
 * `Api\CircuitBreaker` is `final` -- deliberately, so nobody subclasses
 * failure accounting -- which also means it cannot be doubled. The connect
 * screen depends on this instead, for the same reason `Connection\Handshake`
 * depends on `PostsToCloud`: a seam narrow enough to describe what the caller
 * actually needs, and wide enough to stand in for.
 *
 * The narrowness is the point. A merchant clicking "Connect" may clear the
 * breaker; it must not be able to open one, inspect one, or record a failure.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

defined( 'ABSPATH' ) || exit;

/**
 * Clears a circuit breaker on a request a person asked for.
 */
interface AllowsDeliberateRetry {

	/**
	 * Close the circuit because a merchant initiated this request.
	 */
	public function allow_deliberate_retry(): void;
}
