<?php
/**
 * The one call configuration sync makes against the cloud.
 *
 * `Api\Client` is `final` — deliberately, so nobody subclasses transport
 * behaviour — which also means it cannot be doubled. `Config\Synchroniser`
 * depends on this instead, for the same reason `Connection\Handshake` depends
 * on `PostsToCloud`: a seam narrow enough to describe what the caller needs,
 * and wide enough to stand in for.
 *
 * The narrowness matters here. Sync reads; it must not be able to POST, and a
 * test proving it left the cached configuration alone on a `304` has to be able
 * to hand it one.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

defined( 'ABSPATH' ) || exit;

/**
 * Sends a conditional GET to the cloud.
 */
interface FetchesFromCloud {

	/**
	 * GET a path, optionally with request headers.
	 *
	 * @param string                $path    API path, without the base URL.
	 * @param array<string, mixed>  $query   Query arguments.
	 * @param array<string, string> $headers Extra headers, such as `If-None-Match`.
	 */
	public function get( string $path, array $query = array(), array $headers = array() ): Response;
}
