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
		// Each event guards itself. A single early return would mean that an
		// upgrade from a version predating the heartbeat -- where the sync event
		// already exists -- never schedules it, self-heal included.
		self::schedule_heartbeat();
		self::schedule_order_reports();
		self::schedule_catalogue_push();
		self::schedule_catalogue_reconcile();

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
	 * Schedule the daily heartbeat (M8.5).
	 *
	 * `daily` is a core schedule, so unlike the sync interval it needs no
	 * filter and cannot be refused for being unregistered.
	 *
	 * Offset by an hour rather than a minute: activation already fires a sync,
	 * and a store that reports its environment sixty seconds after install
	 * reports an install, not a running shop.
	 */
	private static function schedule_heartbeat(): void {
		if ( wp_next_scheduled( Keys::CRON_HEARTBEAT ) ) {
			return;
		}

		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', Keys::CRON_HEARTBEAT );
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
	 * Drain the order-report queue every fifteen minutes (M12.7).
	 *
	 * Shares the sync interval rather than inventing a second one: both are
	 * "talk to the cloud soon, but not now", and a store already pays for a
	 * quarter-hourly wake-up. A separate schedule would double the cron traffic
	 * to say the same thing.
	 */
	private static function schedule_order_reports(): void {
		if ( wp_next_scheduled( Keys::CRON_REPORT_ORDERS ) ) {
			return;
		}

		add_filter( 'cron_schedules', array( self::class, 'ensure_schedule_registered' ) ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- 15-minute interval is intentional and documented.

		$scheduled = wp_schedule_event(
			time() + self::INTERVAL,
			Keys::CRON_SCHEDULE_QUARTER_HOUR,
			Keys::CRON_REPORT_ORDERS
		);

		remove_filter( 'cron_schedules', array( self::class, 'ensure_schedule_registered' ) );

		if ( is_wp_error( $scheduled ) ) {
			// Same fallback as the config sync: hourly is worse than quarter-
			// hourly and far better than never.
			wp_schedule_event( time() + MINUTE_IN_SECONDS, 'hourly', Keys::CRON_REPORT_ORDERS );
		}
	}

	/**
	 * Push one batch of the catalogue every fifteen minutes (M19.1).
	 *
	 * Shares the interval the sync and the order drain already use, for the
	 * reason recorded above: a store pays for one quarter-hourly wake-up, and a
	 * third schedule would triple the cron traffic to say the same thing.
	 *
	 * 📌 **Quarter-hourly is what makes the walk finish in days rather than
	 * weeks.** A 100k catalogue is 400 batches at 250 products each: four an
	 * hour is **4.2 days**, where the hourly fallback below would take 16.
	 */
	private static function schedule_catalogue_push(): void {
		if ( wp_next_scheduled( Keys::CRON_PUSH_CATALOGUE ) ) {
			return;
		}

		add_filter( 'cron_schedules', array( self::class, 'ensure_schedule_registered' ) ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- 15-minute interval is intentional and documented.

		$scheduled = wp_schedule_event(
			time() + self::INTERVAL,
			Keys::CRON_SCHEDULE_QUARTER_HOUR,
			Keys::CRON_PUSH_CATALOGUE
		);

		remove_filter( 'cron_schedules', array( self::class, 'ensure_schedule_registered' ) );

		if ( is_wp_error( $scheduled ) ) {
			// Same fallback as the others: slower is worse than quarter-hourly
			// and far better than a catalogue that never reaches the cloud.
			wp_schedule_event( time() + MINUTE_IN_SECONDS, 'hourly', Keys::CRON_PUSH_CATALOGUE );
		}
	}

	/**
	 * Reconcile the mirror against the store, daily (M19.3).
	 *
	 * 📌 **Daily, not quarter-hourly.** Hooks are the fast path; this is the
	 * backstop for what they miss -- a deletion while the site was offline, a
	 * queue entry dropped by the cap. A 100k catalogue costs about **ten**
	 * requests a day as an id manifest, so the cadence is bounded by usefulness
	 * rather than cost.
	 */
	private static function schedule_catalogue_reconcile(): void {
		if ( wp_next_scheduled( Keys::CRON_RECONCILE_CATALOGUE ) ) {
			return;
		}

		/*
		 * An hour out, like the heartbeat: a site that has just activated has a
		 * walk to finish first, and the reconciler refuses until it has.
		 */
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', Keys::CRON_RECONCILE_CATALOGUE );
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
		wp_clear_scheduled_hook( Keys::CRON_HEARTBEAT );
		wp_clear_scheduled_hook( Keys::CRON_REPORT_ORDERS );
		wp_clear_scheduled_hook( Keys::CRON_PUSH_CATALOGUE );
		wp_clear_scheduled_hook( Keys::CRON_RECONCILE_CATALOGUE );
	}
}
