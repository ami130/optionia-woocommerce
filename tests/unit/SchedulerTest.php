<?php
/**
 * Recurring event scheduling.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Activation\Scheduler;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * Both recurring events are scheduled, and both are cleared.
 *
 * @covers \Optionia\Activation\Scheduler
 */
final class SchedulerTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_cron']    = array();
		$GLOBALS['optionia_test_filters'] = array();
	}

	/**
	 * Activation schedules the config sync.
	 */
	public function test_schedules_the_config_sync(): void {
		Scheduler::schedule();

		$this->assertArrayHasKey( Keys::CRON_SYNC_CONFIG, $GLOBALS['optionia_test_cron'] );
		$this->assertSame(
			Keys::CRON_SCHEDULE_QUARTER_HOUR,
			$GLOBALS['optionia_test_cron'][ Keys::CRON_SYNC_CONFIG ]['recurrence'],
			'The custom interval must be accepted, not silently refused into the hourly fallback.'
		);
	}

	/**
	 * Activation schedules the daily heartbeat (M8.5).
	 */
	public function test_schedules_the_daily_heartbeat(): void {
		Scheduler::schedule();

		$this->assertArrayHasKey( Keys::CRON_HEARTBEAT, $GLOBALS['optionia_test_cron'] );
		$this->assertSame( 'daily', $GLOBALS['optionia_test_cron'][ Keys::CRON_HEARTBEAT ]['recurrence'] );
	}

	/**
	 * An upgrade from a version predating the heartbeat still schedules it.
	 *
	 * This is the case a single early return would have missed: the sync event
	 * already exists, so a method that bailed on finding it would leave the
	 * heartbeat unscheduled forever -- on every existing install, and through
	 * self-heal too, which is the one path meant to catch exactly this.
	 */
	public function test_schedules_heartbeat_when_sync_already_exists(): void {
		// Simulate the old version's state: sync scheduled, no heartbeat.
		$GLOBALS['optionia_test_cron'][ Keys::CRON_SYNC_CONFIG ] = array(
			'timestamp'  => time() + 900,
			'recurrence' => Keys::CRON_SCHEDULE_QUARTER_HOUR,
		);

		Scheduler::schedule();

		$this->assertArrayHasKey(
			Keys::CRON_HEARTBEAT,
			$GLOBALS['optionia_test_cron'],
			'An upgrade must gain the heartbeat.'
		);
	}

	/**
	 * Scheduling twice does not duplicate events.
	 */
	public function test_scheduling_is_idempotent(): void {
		Scheduler::schedule();
		$first = $GLOBALS['optionia_test_cron'][ Keys::CRON_HEARTBEAT ]['timestamp'];

		Scheduler::schedule();

		$this->assertSame( $first, $GLOBALS['optionia_test_cron'][ Keys::CRON_HEARTBEAT ]['timestamp'] );
	}

	/**
	 * Deactivation clears both events.
	 *
	 * A hook left scheduled fires forever against a deactivated plugin, and the
	 * heartbeat is the one most likely to be noticed -- it talks to the network.
	 */
	public function test_clear_removes_both_events(): void {
		Scheduler::schedule();

		Scheduler::clear();

		$this->assertArrayNotHasKey( Keys::CRON_SYNC_CONFIG, $GLOBALS['optionia_test_cron'] );
		$this->assertArrayNotHasKey( Keys::CRON_HEARTBEAT, $GLOBALS['optionia_test_cron'] );
	}

	/**
	 * The temporary `cron_schedules` filter is not left attached.
	 *
	 * Scheduler attaches it only for the duration of the call; leaving it would
	 * register the interval on every request through a class meant to be inert
	 * outside activation.
	 */
	public function test_does_not_leave_its_filter_attached(): void {
		Scheduler::schedule();

		$this->assertSame(
			array(),
			$GLOBALS['optionia_test_filters']['cron_schedules'] ?? array()
		);
	}
}
