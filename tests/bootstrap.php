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
