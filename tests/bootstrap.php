<?php
/**
 * PHPUnit bootstrap.
 *
 * Unit tests must run without a WordPress installation — that is what
 * Principle 1's layering buys us. ABSPATH is defined so the direct-access
 * guards in src/ pass, and the handful of WordPress functions that pure classes
 * touch are stubbed.
 *
 * @package Optionia
 */

declare( strict_types=1 );

define( 'ABSPATH', __DIR__ . '/../' );
define( 'OPTIONIA_PLUGIN_FILE', __DIR__ . '/../optionia.php' );
define( 'OPTIONIA_VERSION', '0.1.0' );
define( 'OPTIONIA_MIN_PHP', '7.4' );
define( 'OPTIONIA_MIN_WP', '6.0' );
define( 'OPTIONIA_MIN_WC', '8.0' );

require_once __DIR__ . '/../vendor/autoload.php';

/*
 * Minimal WordPress stubs.
 *
 * Deliberately tiny: if this list grows, it is a signal that a class has crept
 * out of the pure layer and should be refactored rather than accommodated here.
 */

if ( ! function_exists( 'wc_get_price_decimals' ) ) {
	/**
	 * Currency decimal places.
	 */
	/**
	 * The options API, in memory.
	 *
	 * `Connection\StateMachine` and `Connection\Handshake` are the plugin's
	 * half of M8.1b's state machine, and both are pure logic that happens to
	 * persist through WordPress. Stubbing three functions keeps them in the unit
	 * suite — where they run in milliseconds — rather than pushing the state
	 * machine into an integration suite for the sake of a key-value store.
	 */
	$GLOBALS['optionia_test_options'] = array();

	/**
	 * Capability, in memory.
	 *
	 * `Connection\Callback` refuses before reading the handshake when the
	 * caller lacks the capability, and that ordering is the point: a subscriber
	 * must not learn whether a handshake is pending.
	 */
	$GLOBALS['optionia_test_can'] = true;

	function current_user_can( string $capability ): bool {
		unset( $capability );

		return (bool) ( $GLOBALS['optionia_test_can'] ?? true );
	}

	function get_option( string $option, $fallback = false ) {
		return $GLOBALS['optionia_test_options'][ $option ] ?? $fallback;
	}

	// phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- signature parity with WordPress.
	function update_option( string $option, $value, $autoload = null ): bool {
		$GLOBALS['optionia_test_options'][ $option ] = $value;

		return true;
	}

	function delete_option( string $option ): bool {
		unset( $GLOBALS['optionia_test_options'][ $option ] );

		return true;
	}

	function wc_get_price_decimals(): int {
		return 2;
	}
}

if ( ! function_exists( 'wc_format_decimal' ) ) {
	/**
	 * Normalise a decimal string.
	 *
	 * @param mixed $value    Raw value.
	 * @param int   $decimals Decimal places.
	 */
	function wc_format_decimal( $value, int $decimals = 2 ): string {
		return number_format( (float) $value, $decimals, '.', '' );
	}
}
