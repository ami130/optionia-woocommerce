<?php
/**
 * Deactivation routine.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Activation;

defined( 'ABSPATH' ) || exit;

/**
 * Runs once, on deactivation.
 */
final class Deactivator {

	/**
	 * Deactivate.
	 *
	 * Clears scheduled work and transient state only. Merchant configuration,
	 * the store connection and the cached config are all preserved: deactivation
	 * is frequently a troubleshooting step, and losing configuration because a
	 * merchant toggled a plugin would be indefensible. Data removal happens only
	 * in uninstall.php, and only when the merchant has opted in.
	 */
	public static function deactivate(): void {
		Scheduler::clear();

		flush_rewrite_rules();
	}
}
