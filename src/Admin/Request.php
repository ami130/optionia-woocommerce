<?php
/**
 * Admin request guard.
 *
 * Principle 2: capability and nonce verification happens here, once. Repeating
 * the pair inline at every handler is how one of them eventually gets forgotten
 * — and a missing nonce check is a CSRF vulnerability on a merchant's store.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Verifies and reads admin form submissions.
 */
final class Request {

	/**
	 * Whether the current user may manage Optionia.
	 */
	public static function user_can_manage(): bool {
		return current_user_can( Keys::CAP_MANAGE );
	}

	/**
	 * Verify a POST submission: capability, then nonce.
	 *
	 * Capability first so an unauthorised user gets "not permitted" rather than
	 * a nonce error, which would leak that the action exists.
	 *
	 * @param string $action Nonce action from Keys.
	 * @param string $field  Nonce field name.
	 */
	public static function verify_post( string $action, string $field = '_wpnonce' ): bool {
		if ( ! self::user_can_manage() ) {
			return false;
		}

		$nonce = isset( $_POST[ $field ] )
			? sanitize_text_field( wp_unslash( (string) $_POST[ $field ] ) )
			: '';

		return '' !== $nonce && false !== wp_verify_nonce( $nonce, $action );
	}

	/**
	 * Stop the request when verification fails.
	 *
	 * @param string $action Nonce action from Keys.
	 * @param string $field  Nonce field name.
	 */
	public static function require_post( string $action, string $field = '_wpnonce' ): void {
		if ( self::verify_post( $action, $field ) ) {
			return;
		}

		wp_die(
			esc_html__( 'You are not allowed to perform this action.', 'optionia' ),
			esc_html__( 'Permission denied', 'optionia' ),
			array( 'response' => 403 )
		);
	}

	/**
	 * A sanitised text field from the POST body.
	 *
	 * Callers must have verified the request first; this only sanitises.
	 *
	 * @param string $key     Field name.
	 * @param string $default Returned when absent.
	 */
	public static function post_text( string $key, string $default = '' ): string {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified by require_post().
		if ( ! isset( $_POST[ $key ] ) ) {
			return $default;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified by require_post().
		return sanitize_text_field( wp_unslash( (string) $_POST[ $key ] ) );
	}

	/**
	 * A checkbox from the POST body.
	 *
	 * @param string $key Field name.
	 */
	public static function post_bool( string $key ): bool {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified by require_post().
		return isset( $_POST[ $key ] ) && '' !== $_POST[ $key ];
	}

	/**
	 * A URL from the POST body, validated.
	 *
	 * Returns an empty string when the value is not a usable http(s) URL, so a
	 * caller cannot store `javascript:` in a setting that is later rendered.
	 *
	 * @param string $key Field name.
	 */
	public static function post_url( string $key ): string {
		$raw = self::post_text( $key );

		if ( '' === $raw ) {
			return '';
		}

		$clean  = esc_url_raw( $raw );
		$scheme = wp_parse_url( $clean, PHP_URL_SCHEME );

		return in_array( $scheme, array( 'http', 'https' ), true ) ? $clean : '';
	}
}
