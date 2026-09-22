<?php
/**
 * Plugin Name:       Optionia
 * Plugin URI:        https://optionia.com/
 * Description:       Advanced product options for WooCommerce, managed from your Optionia dashboard.
 * Version:           0.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            ParseLab
 * Author URI:        https://optionia.com/
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       optionia
 * Domain Path:       /languages
 * WC requires at least: 8.0
 * WC tested up to:   11.0
 *
 * @package Optionia
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

/*
 * This file intentionally contains bootstrap only — no business logic, no hooks
 * beyond registration. See src/Plugin.php for wiring and docs/ARCHITECTURE.md
 * for the layering rules.
 */

/**
 * Absolute path to the plugin's main file. Used for activation hooks and
 * plugin_basename() lookups.
 */
define( 'OPTIONIA_PLUGIN_FILE', __FILE__ );

/**
 * Plugin version. Single source of truth — the header above is parsed by
 * WordPress, this constant is used by the code. A release check asserts they match.
 */
/**
 * The plugin version, and the storefront asset cache key.
 *
 * 🔴 **This must be bumped whenever `assets/css/frontend.css` or
 * `assets/js/frontend.js` changes.** `Frontend\Assets::version()` passes it to
 * `wp_enqueue_style`/`wp_enqueue_script` as the `ver` query argument outside
 * `WP_DEBUG`, so a browser or CDN holding the previous file keeps serving it
 * until this changes.
 *
 * That is not hypothetical: the stylesheet went from an empty placeholder to the
 * full layout rules in one change, and without a bump every returning customer
 * would have kept the empty one — options rendering unstyled on a store the
 * merchant had just seen working.
 *
 * `Activation\Migrator::maybe_upgrade()` compares this against the stored
 * option on each admin request and re-runs `dbDelta` plus cron setup when they
 * differ, so a bump is safe to make and cheap on the happy path.
 */
define( 'OPTIONIA_VERSION', '0.2.0' );

/**
 * Minimum supported environment. Checked on activation (hard failure) and on
 * every load (graceful degradation).
 */
define( 'OPTIONIA_MIN_PHP', '7.4' );
define( 'OPTIONIA_MIN_WP', '6.0' );
define( 'OPTIONIA_MIN_WC', '8.0' );

/**
 * Autoloader.
 *
 * Prefers Composer's autoloader when vendor/ is present (development and any
 * build that runs `composer install`). Falls back to a minimal PSR-4 loader so
 * the plugin remains functional in a distributed zip that ships without
 * Composer's generated files.
 */
if ( is_readable( __DIR__ . '/vendor/autoload.php' ) ) {
	require_once __DIR__ . '/vendor/autoload.php';
} else {
	require_once __DIR__ . '/src/Autoloader.php';
	\Optionia\Autoloader::register();
}

/**
 * Activation and deactivation hooks.
 *
 * Registered against static methods rather than the container so they remain
 * callable even when the plugin has not booted (for example when WooCommerce is
 * absent and boot() short-circuits).
 */
register_activation_hook( __FILE__, array( \Optionia\Activation\Activator::class, 'activate' ) );
register_deactivation_hook( __FILE__, array( \Optionia\Activation\Deactivator::class, 'deactivate' ) );

/**
 * Cron interval registration.
 *
 * Deliberately registered here, at file-load time, rather than during boot.
 * WP-Cron re-schedules recurring events on shutdown and validates the interval
 * name against the registered schedules at that moment. If the filter is only
 * attached after a successful boot, a request that short-circuits — WP-CLI, or
 * WooCommerce being inactive — drops the schedule with
 * "Event schedule does not exist" and sync silently stops forever.
 */
add_filter( 'cron_schedules', array( \Optionia\Activation\Scheduler::class, 'ensure_schedule_registered' ) ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected

/**
 * Boot the plugin.
 *
 * Deferred to `plugins_loaded` so WooCommerce's own classes are available for
 * the dependency check. Nothing before this point touches WooCommerce.
 */
add_action( 'plugins_loaded', array( \Optionia\Plugin::class, 'boot' ), 20 );
