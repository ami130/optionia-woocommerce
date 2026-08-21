<?php
/**
 * Invariant checks — loud in development, safe in production.
 *
 * Principle 7. The plugin runs on merchant infrastructure we do not control, so
 * a broken invariant must never white-screen a storefront. It must also not
 * pass silently during development, or bugs ship.
 *
 * One switch, decided here rather than re-argued at every call site:
 * - WP_DEBUG on  → throw, so the developer sees it immediately.
 * - WP_DEBUG off → log and return false, so the caller degrades gracefully.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

use Optionia\Exceptions\InvariantViolation;

defined( 'ABSPATH' ) || exit;

/**
 * Development-time assertions that degrade to logging in production.
 */
final class Assert {

	/**
	 * Logger, injected once during bootstrap.
	 *
	 * Static because assertions are called from pure-ish code paths that should
	 * not have to carry a logger dependency purely to report a bug.
	 *
	 * @var Logger|null
	 */
	private static ?Logger $logger = null;

	/**
	 * Provide the logger. Called once from Plugin::boot().
	 *
	 * @param Logger $logger Logger instance.
	 */
	public static function set_logger( Logger $logger ): void {
		self::$logger = $logger;
	}

	/**
	 * Assert a condition holds.
	 *
	 * @param bool                 $condition Condition that must be true.
	 * @param string               $message   Developer-facing description.
	 * @param array<string, mixed> $context   Structured context for the log.
	 * @return bool True when the condition held.
	 * @throws InvariantViolation When the condition fails and WP_DEBUG is on.
	 */
	public static function that( bool $condition, string $message, array $context = array() ): bool {
		if ( $condition ) {
			return true;
		}

		if ( self::is_debug() ) {
			// Exception messages are developer-facing and never rendered to a page.
			throw new InvariantViolation( $message ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
		}

		if ( self::$logger instanceof Logger ) {
			self::$logger->error( 'Invariant violation: ' . $message, $context );
		}

		return false;
	}

	/**
	 * Assert a value is scalar.
	 *
	 * Exists because of a specific, verified WooCommerce behaviour: the block
	 * cart silently discards an entire item-data element when any of its values
	 * is non-scalar (StoreApi\Schemas\V1\CartItemSchema). The same data renders
	 * correctly in the classic cart, so the bug is invisible without this check.
	 *
	 * @param mixed  $value Value to check.
	 * @param string $label Field name for the message.
	 * @return bool True when the value is scalar.
	 * @throws InvariantViolation When non-scalar and WP_DEBUG is on.
	 */
	public static function scalar( $value, string $label ): bool {
		return self::that(
			is_scalar( $value ),
			sprintf( '%s must be scalar for block cart compatibility, %s given.', $label, gettype( $value ) ),
			array( 'label' => $label )
		);
	}

	/**
	 * Whether WordPress is in debug mode.
	 */
	private static function is_debug(): bool {
		return defined( 'WP_DEBUG' ) && WP_DEBUG;
	}
}
