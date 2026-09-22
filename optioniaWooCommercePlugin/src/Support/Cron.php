<?php
/**
 * Cron schedule registration.
 *
 * WP-Cron is request-triggered, so on a low-traffic store a "15 minute"
 * schedule can mean hours. That is why the sync interval is paired with a manual
 * "Sync now" control in the admin, and why staleness is surfaced in System
 * Status rather than assumed away.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

use Optionia\Config\Synchroniser;

defined( 'ABSPATH' ) || exit;

/**
 * Registers custom cron intervals.
 */
final class Cron {

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * The synchroniser this schedules.
	 *
	 * @var Synchroniser
	 */
	private Synchroniser $synchroniser;

	/**
	 * Constructor.
	 *
	 * @param Logger       $logger       Logger.
	 * @param Synchroniser $synchroniser Configuration synchroniser.
	 */
	public function __construct( Logger $logger, Synchroniser $synchroniser ) {
		$this->logger       = $logger;
		$this->synchroniser = $synchroniser;
	}

	/**
	 * Register hooks.
	 *
	 * The `cron_schedules` filter is deliberately NOT registered here — it is
	 * attached in optionia.php at file-load time, because WP-Cron validates
	 * interval names on shutdown even on requests where the plugin never boots.
	 * See the comment there.
	 */
	public function register(): void {
		add_action( Keys::CRON_SYNC_CONFIG, array( $this, 'on_sync_due' ) );
	}

	/**
	 * Handle the recurring sync event.
	 *
	 * Delegates rather than fetching here: this class schedules, and knowing
	 * how to talk to the cloud would make it the second place that does.
	 * `Config\Synchroniser` owns the conditional request and what to do with
	 * each answer.
	 */
	public function on_sync_due(): void {
		$this->synchroniser->sync();
	}

	/**
	 * When the next configuration sync is due, or null when none is scheduled.
	 */
	public function next_sync(): ?int {
		$timestamp = wp_next_scheduled( Keys::CRON_SYNC_CONFIG );

		return false === $timestamp ? null : (int) $timestamp;
	}

	/**
	 * Whether WP-Cron has been disabled on this site.
	 *
	 * Reported in System Status: if a merchant has DISABLE_WP_CRON set without a
	 * real system cron, scheduled syncs never run and the only explanation for
	 * "my changes are not appearing" is this flag.
	 */
	public function is_wp_cron_disabled(): bool {
		return defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;
	}
}
