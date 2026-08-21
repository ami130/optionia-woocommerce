<?php
/**
 * The single logging entry point.
 *
 * Principle 2: one canonical owner per concern. `error_log()` and `var_dump()`
 * must not appear anywhere else in the plugin — a CI check enforces it.
 *
 * Wraps wc_get_logger() so entries land in WooCommerce → Status → Logs where
 * merchants and support can find them, and redacts credentials so a debug log
 * a merchant emails to support never contains their store token.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * Token-redacting logger, off unless the merchant enables debug logging.
 */
final class Logger {

	/**
	 * WooCommerce log source, used as the filename.
	 */
	private const SOURCE = 'optionia';

	/**
	 * Keys whose values are replaced before anything is written.
	 *
	 * @var string[]
	 */
	private const REDACT_KEYS = array(
		'token',
		'access_token',
		'refresh_token',
		'store_token',
		'authorization',
		'password',
		'secret',
		'api_key',
		'code',
		'verifier',
		'challenge',
	);

	/**
	 * Settings reader, injected so the logger stays testable.
	 *
	 * @var Settings
	 */
	private Settings $settings;

	/**
	 * Constructor.
	 *
	 * @param Settings $settings Merchant settings.
	 */
	public function __construct( Settings $settings ) {
		$this->settings = $settings;
	}

	/**
	 * Log a debug message. Suppressed unless debug logging is enabled.
	 *
	 * @param string               $message Message.
	 * @param array<string, mixed> $context Structured context.
	 */
	public function debug( string $message, array $context = array() ): void {
		$this->log( 'debug', $message, $context );
	}

	/**
	 * Log an informational message. Suppressed unless debug logging is enabled.
	 *
	 * @param string               $message Message.
	 * @param array<string, mixed> $context Structured context.
	 */
	public function info( string $message, array $context = array() ): void {
		$this->log( 'info', $message, $context );
	}

	/**
	 * Log a warning. Always recorded.
	 *
	 * @param string               $message Message.
	 * @param array<string, mixed> $context Structured context.
	 */
	public function warning( string $message, array $context = array() ): void {
		$this->log( 'warning', $message, $context, true );
	}

	/**
	 * Log an error. Always recorded.
	 *
	 * @param string               $message Message.
	 * @param array<string, mixed> $context Structured context.
	 */
	public function error( string $message, array $context = array() ): void {
		$this->log( 'error', $message, $context, true );
	}

	/**
	 * Write an entry.
	 *
	 * Warnings and errors are always recorded: a merchant who has not enabled
	 * debug logging still needs a trail when something breaks, and support
	 * cannot ask them to reproduce an intermittent failure with logging on.
	 *
	 * @param string               $level   WooCommerce log level.
	 * @param string               $message Message.
	 * @param array<string, mixed> $context Structured context.
	 * @param bool                 $always  Bypass the debug-logging setting.
	 */
	private function log( string $level, string $message, array $context, bool $always = false ): void {
		if ( ! $always && ! $this->settings->is_debug_logging_enabled() ) {
			return;
		}

		if ( ! function_exists( 'wc_get_logger' ) ) {
			return;
		}

		$logger = wc_get_logger();

		if ( ! $logger ) {
			return;
		}

		if ( array() !== $context ) {
			$encoded  = wp_json_encode( self::redact( $context ) );
			$message .= ' ' . ( false === $encoded ? '[context could not be encoded]' : $encoded );
		}

		$logger->log( $level, $message, array( 'source' => self::SOURCE ) );
	}

	/**
	 * Recursively replace sensitive values with a placeholder.
	 *
	 * Matching is substring-based on the key so `Authorization`,
	 * `store_token_hash` and `apiKey` are all caught.
	 *
	 * @param array<string, mixed> $context Context to redact.
	 * @return array<string, mixed>
	 */
	private static function redact( array $context ): array {
		$clean = array();

		foreach ( $context as $key => $value ) {
			$needle = strtolower( (string) $key );
			$hit    = false;

			foreach ( self::REDACT_KEYS as $sensitive ) {
				if ( false !== strpos( $needle, $sensitive ) ) {
					$hit = true;
					break;
				}
			}

			if ( $hit ) {
				$clean[ $key ] = '[redacted]';
				continue;
			}

			$clean[ $key ] = is_array( $value ) ? self::redact( $value ) : $value;
		}

		return $clean;
	}
}
