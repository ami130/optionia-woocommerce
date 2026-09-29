<?php
/**
 * Where the storefront beacon lands (M25.1).
 *
 * 🔴 **The browser talks to the site it is already on, never to the cloud.** The
 * store credential authenticates plugin to cloud and must never reach a page a
 * customer can read -- a beacon posted straight to the cloud would need it in
 * page source, or no authentication at all, which is a free tool for inflating
 * or poisoning any merchant's analytics. This route is the hop that keeps the
 * secret server-side.
 *
 * ⚠️ **It answers 204 and does nothing else.** `sendBeacon` cannot read a
 * response and the customer is leaving the page; anything this returned would be
 * discarded. A body would only cost bytes on a request that happens on every
 * product view.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Analytics;

use Optionia\Support\Keys;
use WP_REST_Request;
use WP_REST_Response;

defined( 'ABSPATH' ) || exit;

/**
 * A REST route the storefront beacon posts to.
 */
final class ViewEndpoint {

	/**
	 * The most option keys one beacon may carry.
	 *
	 * ⚠️ **A page with more than this many options is not a page.** The bound
	 * exists so one request cannot make the handler do unbounded work, and
	 * `ViewCollector` bounds the stored total separately.
	 */
	private const MAX_OPTIONS = 100;

	/**
	 * Where the counts go.
	 *
	 * @var ViewCollector
	 */
	private ViewCollector $collector;

	/**
	 * Hold the collector this endpoint feeds.
	 *
	 * @param ViewCollector $collector Accumulates the counts.
	 */
	public function __construct( ViewCollector $collector ) {
		$this->collector = $collector;
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
			Keys::REST_ROUTE_VIEWS,
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'handle' ),
				'permission_callback' => array( $this, 'permitted' ),
			)
		);
	}

	/**
	 * Whether the request may proceed.
	 *
	 * ⚠️ **A filter, not a credential**, and the same honest limit
	 * `UploadEndpoint` records: every guest on the site holds the same nonce for
	 * 24 hours, so this refuses a request that never loaded a page and nothing
	 * more. What bounds abuse is the per-option ceiling in `ViewCollector` --
	 * a forged beacon can add only what a reload could have added anyway.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function permitted( WP_REST_Request $request ): bool {
		$nonce = (string) $request->get_header( 'X-WP-Nonce' );

		if ( '' === $nonce ) {
			$nonce = (string) $request->get_param( '_wpnonce' );
		}

		return '' !== $nonce && false !== wp_verify_nonce( $nonce, Keys::NONCE_VIEWS );
	}

	/**
	 * Record what the customer saw.
	 *
	 * 🔴 **It never fails visibly.** A malformed beacon is dropped and answered
	 * 204 like any other: `sendBeacon` cannot retry, nobody is reading the
	 * status, and an error response would be a cost paid on every product page
	 * for information no one receives.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function handle( WP_REST_Request $request ): WP_REST_Response {
		$set_id  = (string) $request->get_param( 'set' );
		$options = $request->get_param( 'options' );
		$day     = (string) $request->get_param( 'day' );

		if ( ! is_array( $options ) ) {
			return new WP_REST_Response( null, 204 );
		}

		/*
		 * ⚠️ **The day is validated here, not trusted.** It reaches the cloud,
		 * which refuses anything that is not a real calendar date with a 400 --
		 * and a 400 makes the plugin drop the whole batch as permanently
		 * malformed. One bad beacon must not cost a merchant every count
		 * waiting behind it.
		 */
		if ( 1 !== preg_match( '/^\d{4}-\d{2}-\d{2}$/', $day ) || ! $this->is_real_date( $day ) ) {
			return new WP_REST_Response( null, 204 );
		}

		$this->collector->add(
			$set_id,
			array_slice( array_values( array_filter( $options, 'is_string' ) ), 0, self::MAX_OPTIONS ),
			$day
		);

		return new WP_REST_Response( null, 204 );
	}

	/**
	 * Whether a `Y-m-d` string is a date that exists.
	 *
	 * ⚠️ **The format check is not enough.** `2026-13-45` matches the pattern
	 * and is not a date; `2026-02-31` is a date the calendar rolls over to
	 * 3 March. Both would reach the cloud and be refused there, costing the
	 * whole batch -- so they are dropped here instead.
	 *
	 * @param string $day A `Y-m-d` candidate.
	 */
	private function is_real_date( string $day ): bool {
		$parts = explode( '-', $day );

		if ( 3 !== count( $parts ) ) {
			return false;
		}

		return checkdate( (int) $parts[1], (int) $parts[2], (int) $parts[0] );
	}
}
