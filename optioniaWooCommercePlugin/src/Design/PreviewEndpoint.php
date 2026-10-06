<?php
/**
 * The storefront's proxy to the cloud's preview renderer (M26e.1, stage B).
 *
 * ## Why a proxy and not a direct call
 *
 * 🔴 **The store credential must never reach a browser.** `POST /store/preview`
 * is authenticated by the store token, which lives in an option on the
 * merchant's server. A customer's page asks WordPress; WordPress asks the
 * cloud. Putting that token in a script tag would hand every visitor the
 * ability to speak for the store.
 *
 * ## Why the cloud renders rather than the browser
 *
 * 🔴 **One renderer, which is M26d.6's wording — "never a second renderer".**
 * The preview, the storefront overlay and the print file all come out of
 * `buildScene` and `sceneToSvgString` in `shared/design/`. Porting that
 * geometry into JavaScript would make a customer approve one picture and a
 * merchant print another, which is exactly the divergence that shipped as a
 * blank print file once already.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Design;

use Optionia\Api\Client;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use WP_REST_Request;
use WP_REST_Response;

defined( 'ABSPATH' ) || exit;

/**
 * Serves one preview SVG to the storefront.
 */
final class PreviewEndpoint {

	/**
	 * How long one rendered scene is reused.
	 *
	 * 🔴 **The cloud allows 1200 previews an hour per store**, and a customer
	 * dragging through swatches can ask for a dozen in as many seconds. Two
	 * customers choosing the same swatch compose byte-identical scenes, so
	 * caching by scene is what keeps one popular choice from spending a
	 * merchant's whole allowance.
	 */
	private const CACHE_SECONDS = 3600;

	/**
	 * Largest scene this will forward, in bytes.
	 *
	 * ⚠️ **A browser is not a trusted caller.** The nonce proves the request
	 * came from someone who loaded a page, and nothing more — so the body is
	 * bounded here rather than relied upon to be the one this plugin emitted.
	 */
	private const MAX_SCENE_BYTES = 262144;

	/**
	 * API client.
	 *
	 * @var Client
	 */
	private Client $client;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Client $client API client.
	 * @param Logger $logger Logger.
	 */
	public function __construct( Client $client, Logger $logger ) {
		$this->client = $client;
		$this->logger = $logger;
	}

	/**
	 * Register the REST route.
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
			Keys::REST_ROUTE_PREVIEW,
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'handle' ),
				'permission_callback' => array( $this, 'permitted' ),
			)
		);
	}

	/**
	 * Whether the caller loaded a page on this site.
	 *
	 * ⚠️ **A filter, not a credential**, and the honest limit `ViewEndpoint`
	 * records: every guest holds the same nonce for 24 hours, so this refuses
	 * a request that never loaded a page and nothing more. What bounds abuse
	 * is the cache below — a forged request for a scene already rendered costs
	 * nothing, and a novel one costs exactly what a real customer's would.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function permitted( WP_REST_Request $request ): bool {
		$nonce = (string) $request->get_header( 'X-WP-Nonce' );

		if ( '' === $nonce ) {
			$nonce = (string) $request->get_param( '_wpnonce' );
		}

		return '' !== $nonce && false !== wp_verify_nonce( $nonce, Keys::NONCE_PREVIEW );
	}

	/**
	 * Answer with the SVG for one composed scene.
	 *
	 * 🔴 **A failure is a 204, never an error page.** M26e.6's first rule is
	 * that artwork never blocks a sale; a customer whose preview does not
	 * arrive must still be able to buy, and the runtime treats an empty body
	 * as "no preview" rather than something to retry.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function handle( WP_REST_Request $request ): WP_REST_Response {
		if ( StateMachine::DISCONNECTED === StateMachine::current() ) {
			return new WP_REST_Response( null, 204 );
		}

		$scene  = $request->get_param( 'scene' );
		$width  = (int) $request->get_param( 'width' );
		$height = (int) $request->get_param( 'height' );

		if ( ! is_array( $scene ) || array() === $scene || $width < 1 || $height < 1 ) {
			return new WP_REST_Response( null, 204 );
		}

		$encoded = wp_json_encode( $scene );

		if ( ! is_string( $encoded ) || strlen( $encoded ) > self::MAX_SCENE_BYTES ) {
			return new WP_REST_Response( null, 204 );
		}

		/*
		 * 📌 **Keyed by the scene AND its canvas.** The same artwork drawn at
		 * two sizes is two documents, and a key that ignored the dimensions
		 * would serve one of them for both.
		 */
		$key    = Keys::TRANSIENT_PREVIEW . md5( $encoded . '|' . $width . 'x' . $height );
		$cached = get_transient( $key );

		if ( is_string( $cached ) && '' !== $cached ) {
			return $this->svg( $cached );
		}

		$response = $this->client->post_binary(
			'/store/preview',
			array(
				'scene'  => $scene,
				'width'  => $width,
				'height' => $height,
			)
		);

		if ( ! $response->is_ok() ) {
			$this->logger->debug(
				'The cloud refused a preview.',
				array(
					'status' => $response->status(),
					'code'   => $response->error_code(),
				)
			);

			return new WP_REST_Response( null, 204 );
		}

		$svg = $response->bytes();

		if ( '' === $svg ) {
			return new WP_REST_Response( null, 204 );
		}

		set_transient( $key, $svg, self::CACHE_SECONDS );

		return $this->svg( $svg );
	}

	/**
	 * An SVG response the browser can inject.
	 *
	 * @param string $svg The rendered document.
	 */
	private function svg( string $svg ): WP_REST_Response {
		$response = new WP_REST_Response( $svg, 200 );

		$response->header( 'Content-Type', 'image/svg+xml' );

		return $response;
	}
}
