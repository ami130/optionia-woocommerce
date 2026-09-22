<?php
/**
 * Thrown when a programming invariant is violated.
 *
 * Only ever raised while WP_DEBUG is on — see Support\Assert. In production the
 * same conditions are logged and degraded, never thrown, because a fatal error
 * on a merchant's storefront is worse than a missing option group.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Exceptions;

defined( 'ABSPATH' ) || exit;

/**
 * A bug in the plugin, not a runtime condition.
 */
final class InvariantViolation extends \LogicException {
}
