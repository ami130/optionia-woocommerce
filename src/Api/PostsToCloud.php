<?php
/**
 * The one call the connection flow makes against the cloud.
 *
 * `Api\Client` is `final` — deliberately, so nobody subclasses transport
 * behaviour — which also means it cannot be doubled. The connection classes
 * depend on this instead: a seam narrow enough to describe what they actually
 * need, and wide enough to stand in for.
 *
 * That is not a concession to testing. `Connection\Callback` refuses most
 * requests **without any HTTP at all**, and a test proving that refusal must be
 * able to assert the network was never touched. Against a concrete client it
 * could only assert the outcome, which the class produces on other paths too.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

defined( 'ABSPATH' ) || exit;

/**
 * Sends a POST to the cloud.
 */
interface PostsToCloud {

	/**
	 * POST a JSON body.
	 *
	 * @param string                $path      API path, without the base URL.
	 * @param array<string, mixed>  $body_data Request body.
	 * @param array<string, string> $headers  Extra headers.
	 */
	public function post( string $path, array $body_data = array(), array $headers = array() ): Response;

	/**
	 * DELETE a resource.
	 *
	 * 🔴 **Added for M19.2, and the interface is the reason it is here.**
	 * `Catalogue\QueueDrainer` removes products the merchant has trashed, and
	 * that is a `DELETE` — but the seam existed only for `post()`, so a drainer
	 * written against it could not be doubled and its removal path could not be
	 * tested without HTTP.
	 *
	 * No body: the resource is named by the path, and the ingest's removal route
	 * takes an external id there.
	 *
	 * @param string                $path    API path, without the base URL.
	 * @param array<string, string> $headers Extra headers.
	 */
	public function delete( string $path, array $headers = array() ): Response;
}
