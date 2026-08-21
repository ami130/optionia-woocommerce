<?php
/**
 * Cron scheduling, shared by activation and deactivation.
 *
 * Principle 2: the schedule is defined once. Activation and deactivation both
 * need to know the hook name and interval, and a mismatch leaves an orphaned
 * scheduled event that fires forever against a deactivated plugin.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Activation;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Schedules and clears the plugin's recurring events.
 */
final class Scheduler {

	/**
	 * Sync interval in seconds.
	 *
	 * Declared here rather than only in Support\Cron because activation needs
	 * the interval registered before wp_schedule_event() will accept it, and at
	 * activation time the plugin's `cron_schedules` filter is not yet attached.
	 */
	public const INTERVAL = 900;

	/**
	 * Schedule recurring events, idempotently.
	 *
	 * Note: wp_schedule_event() validates the recurrence name against the registered
	 * schedules and silently refuses an unknown one. During activation our
	 * `cron_schedules` filter has not run, so the filter is attached here for
	 * the duration of the call.
	 */
	public static function schedule(): void {
		if ( wp_next_scheduled( Keys::CRON_SYNC_CONFIG ) ) {
			return;
		}

		add_filter( 'cron_schedules', array( self::class, 'ensure_schedule_registered' ) ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- 15-minute interval is intentional and documented.

		$scheduled = wp_schedule_event(
			time() + MINUTE_IN_SECONDS,
			Keys::CRON_SCHEDULE_QUARTER_HOUR,
			Keys::CRON_SYNC_CONFIG,
			array(),
			true
		);

		remove_filter( 'cron_schedules', array( self::class, 'ensure_schedule_registered' ) );

		if ( is_wp_error( $scheduled ) ) {
			// Falls back to a core interval so sync still happens. Slower than
			// intended, but a merchant whose config never updates is worse than
			// one whose config updates hourly.
			wp_schedule_event( time() + MINUTE_IN_SECONDS, 'hourly', Keys::CRON_SYNC_CONFIG );
		}
	}

	/**
	 * Register the custom interval.
	 *
	 * Attached temporarily during activation, and permanently by Support\Cron
	 * during normal requests.
	 *
	 * @param array<string, array{interval: int, display: string}>|mixed $schedules Existing schedules.
	 * @return array<string, array{interval: int, display: string}>
	 */
	public static function ensure_schedule_registered( $schedules ): array {
		if ( ! is_array( $schedules ) ) {
			$schedules = array();
		}

		$schedules[ Keys::CRON_SCHEDULE_QUARTER_HOUR ] = array(
			'interval' => self::INTERVAL,
			'display'  => __( 'Every 15 minutes (Optionia)', 'optionia' ),
		);

		return $schedules;
	}

	/**
	 * Clear all scheduled events.
	 *
	 * Uses wp_clear_scheduled_hook() rather than unscheduling a single
	 * timestamp, so duplicates left behind by an interrupted activation are
	 * cleaned up too.
	 */
	public static function clear(): void {
		wp_clear_scheduled_hook( Keys::CRON_SYNC_CONFIG );
	}
}
