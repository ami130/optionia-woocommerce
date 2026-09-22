<?php
/**
 * Validates response bodies before the rest of the plugin trusts them.
 *
 * The plugin talks to a remote service over a network it does not control. A
 * truncated body, an HTML error page from an intercepting proxy, or a security
 * plugin's block page must not reach the config cache — an invalid document
 * cached is worse than no document, because it persists.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

use Optionia\Engine\Result;

defined( 'ABSPATH' ) || exit;

/**
 * Decodes and shape-checks API payloads.
 */
final class ResponseValidator {

	/**
	 * Maximum nesting depth accepted when decoding.
	 *
	 * Bounded so a deliberately deeply nested document cannot exhaust the stack.
	 */
	private const MAX_DEPTH = 32;

	/**
	 * Decode a JSON body into an array.
	 *
	 * @param string $body Raw response body.
	 */
	public function decode( string $body ): Result {
		if ( '' === trim( $body ) ) {
			return Result::error( 'empty_body' );
		}

		$decoded = json_decode( $body, true, self::MAX_DEPTH );

		if ( JSON_ERROR_NONE !== json_last_error() ) {
			return Result::error( 'invalid_json', null, array( 'json_error' => json_last_error_msg() ) );
		}

		if ( ! is_array( $decoded ) ) {
			return Result::error( 'unexpected_root_type' );
		}

		return Result::ok( $decoded );
	}

	/**
	 * Check that a decoded payload has the required top-level keys.
	 *
	 * Deliberately shallow: this guards against a wrong or truncated document,
	 * not against every possible malformation. Per-type validation happens in
	 * the engine, against the versioned schema.
	 *
	 * @param array<string, mixed> $data     Decoded payload.
	 * @param string[]             $required Required top-level keys.
	 */
	public function require_keys( array $data, array $required ): Result {
		$missing = array();

		foreach ( $required as $key ) {
			if ( ! array_key_exists( $key, $data ) ) {
				$missing[] = $key;
			}
		}

		if ( array() !== $missing ) {
			return Result::error( 'missing_keys', null, array( 'missing' => $missing ) );
		}

		return Result::ok( $data );
	}
}
