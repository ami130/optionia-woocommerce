<?php
/**
 * Minimal PSR-4 autoloader.
 *
 * Used only when Composer's autoloader is unavailable — see optionia.php. Kept
 * deliberately small: it maps the single `Optionia\` prefix to `src/` and does
 * nothing else.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia;

defined( 'ABSPATH' ) || exit;

/**
 * PSR-4 autoloader for the Optionia\ namespace.
 */
final class Autoloader {

	/**
	 * Namespace prefix this loader is responsible for.
	 */
	private const PREFIX = 'Optionia\\';

	/**
	 * Register the autoloader with the SPL stack.
	 */
	public static function register(): void {
		spl_autoload_register( array( self::class, 'load' ) );
	}

	/**
	 * Resolve a class name to a file inside src/ and require it.
	 *
	 * @param string $class_name Fully qualified class name.
	 */
	public static function load( string $class_name ): void {
		if ( 0 !== strpos( $class_name, self::PREFIX ) ) {
			return;
		}

		$relative = substr( $class_name, strlen( self::PREFIX ) );
		$path     = __DIR__ . '/' . str_replace( '\\', '/', $relative ) . '.php';

		// realpath() + prefix check prevents a crafted class name from escaping src/.
		$real = realpath( $path );

		if ( false === $real || 0 !== strpos( $real, realpath( __DIR__ ) ) ) {
			return;
		}

		require_once $real;
	}
}
