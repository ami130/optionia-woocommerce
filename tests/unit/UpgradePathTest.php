<?php
/**
 * What survives a plugin update.
 *
 * `Migrator` and `Activator` are 228 lines that run on every install and every
 * update, and they had no tests: `Activator::create_tables()` does
 * `require_once ABSPATH . 'wp-admin/includes/upgrade.php'`, which was fatal
 * under the old bootstrap, so the whole path was unreachable from here.
 *
 * The question that matters for Phase 8: a merchant updates the plugin on a
 * connected store. Does the credential survive? The connection state? The
 * cached configuration that AC3 promises keeps serving?
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Activation\Activator;
use Optionia\Activation\Migrator;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * An update re-keys nothing and forgets nothing.
 *
 * @covers \Optionia\Activation\Migrator
 * @covers \Optionia\Activation\Activator
 */
final class UpgradePathTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options']  = array();
		$GLOBALS['optionia_test_autoload'] = array();
		$GLOBALS['optionia_test_cron']     = array();
		$GLOBALS['optionia_test_filters']  = array();
		$GLOBALS['optionia_test_schema']   = array();
		$GLOBALS['wpdb']                   = new \Optionia_Test_Wpdb();
	}

	/**
	 * A migrator over real collaborators.
	 */
	private function migrator(): Migrator {
		return new Migrator( new Logger( new Settings() ) );
	}

	/**
	 * Put the site in the state a connected store on an older build is in.
	 */
	private function connected_on_old_version(): void {
		update_option( Keys::OPTION_VERSION, '0.0.9', false );
		update_option( Keys::OPTION_DB_VERSION, Activator::DB_VERSION, false );
		update_option( Keys::OPTION_STORE_TOKEN, 'live-credential', false );
		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTED, false );
		update_option( Keys::OPTION_CONNECTION_STORE, 'store-1', false );
		update_option( Keys::OPTION_CONNECTION_TENANT, 'Acme Ltd', false );
		update_option( Keys::OPTION_CONFIG, array( 'groups' => array( array( 'id' => 'g1' ) ) ), false );
	}

	/**
	 * Updating does not disconnect a store.
	 *
	 * The failure this guards is severe and silent: a merchant updates, the
	 * credential is gone, and every storefront request 401s. They would have no
	 * reason to connect the update to the outage.
	 */
	public function test_update_preserves_the_connection(): void {
		$this->connected_on_old_version();

		$this->migrator()->maybe_upgrade();

		$this->assertSame( 'live-credential', get_option( Keys::OPTION_STORE_TOKEN ) );
		$this->assertSame( StateMachine::CONNECTED, StateMachine::current() );
		$this->assertSame( 'store-1', get_option( Keys::OPTION_CONNECTION_STORE ) );
		$this->assertSame( 'Acme Ltd', get_option( Keys::OPTION_CONNECTION_TENANT ) );
	}

	/**
	 * And does not empty the cache the storefront serves from.
	 */
	public function test_update_preserves_the_cached_configuration(): void {
		$this->connected_on_old_version();

		$this->migrator()->maybe_upgrade();

		$this->assertSame(
			array( 'groups' => array( array( 'id' => 'g1' ) ) ),
			get_option( Keys::OPTION_CONFIG )
		);
	}

	/**
	 * The stored version advances, so the upgrade runs once.
	 */
	public function test_update_records_the_new_version(): void {
		$this->connected_on_old_version();

		$this->migrator()->maybe_upgrade();

		$this->assertSame( OPTIONIA_VERSION, get_option( Keys::OPTION_VERSION ) );
	}

	/**
	 * A same-version request rebuilds nothing when the schema is also current.
	 *
	 * ✏️ **This test asserted the bug.** It previously required that a matching
	 * plugin version do *no work at all*, which is what made `maybe_upgrade()`
	 * return before ever looking at the schema.
	 *
	 * 🔴 **Measured on the development site:** `optionia_uploads` was added to
	 * `Activator::create_tables()` while the plugin version had already been
	 * bumped to `0.2.0` for an unrelated asset change — so this early return
	 * fired and **the table was never created**. A feature fully wired, fully
	 * unit-tested, and broken on every site already running that version.
	 *
	 * The two counters are independent, and a release can move either. The
	 * schema is now checked on the happy path too; the guarantee this test keeps
	 * is the one that actually mattered — nothing is *rebuilt* when both are
	 * current.
	 */
	public function test_no_rebuild_when_both_versions_match(): void {
		update_option( Keys::OPTION_VERSION, OPTIONIA_VERSION, false );
		update_option( Keys::OPTION_DB_VERSION, Activator::DB_VERSION, false );

		$this->migrator()->maybe_upgrade();

		$this->assertSame( array(), $GLOBALS['optionia_test_schema'] );
	}

	/**
	 * 🔴 **A current plugin version with a stale schema still upgrades.**
	 *
	 * The regression test for the bug above: a site that has already seen this
	 * plugin version, but not the table a later edit added, must still get the
	 * table. Without the schema check on the happy path, this fails and an
	 * upload silently refuses forever.
	 */
	public function test_a_matching_version_still_upgrades_a_stale_schema(): void {
		update_option( Keys::OPTION_VERSION, OPTIONIA_VERSION, false );
		update_option( Keys::OPTION_DB_VERSION, '0', false );

		$this->migrator()->maybe_upgrade();

		$this->assertNotEmpty( $GLOBALS['optionia_test_schema'], 'dbDelta should have run.' );
		$this->assertSame( Activator::DB_VERSION, get_option( Keys::OPTION_DB_VERSION ) );
	}

	/**
	 * A fresh install records the version without re-running activation.
	 */
	public function test_fresh_install_records_the_version_only(): void {
		$this->migrator()->maybe_upgrade();

		$this->assertSame( OPTIONIA_VERSION, get_option( Keys::OPTION_VERSION ) );
		$this->assertSame( array(), $GLOBALS['optionia_test_schema'] );
	}

	/**
	 * An out-of-date schema is brought forward.
	 */
	public function test_stale_schema_is_upgraded(): void {
		$this->connected_on_old_version();
		update_option( Keys::OPTION_DB_VERSION, '0', false );

		$this->migrator()->maybe_upgrade();

		$this->assertNotEmpty( $GLOBALS['optionia_test_schema'], 'dbDelta should have run.' );
		$this->assertStringContainsString( 'optionia_sync_log', $GLOBALS['optionia_test_schema'][0] );
		$this->assertSame( Activator::DB_VERSION, get_option( Keys::OPTION_DB_VERSION ) );
	}

	/**
	 * A current schema is left alone.
	 */
	public function test_current_schema_is_not_rebuilt(): void {
		$this->connected_on_old_version();

		$this->migrator()->maybe_upgrade();

		$this->assertSame( array(), $GLOBALS['optionia_test_schema'] );
	}

	/**
	 * An update schedules the heartbeat a previous build never had.
	 *
	 * The upgrade path is the only route by which an existing install gains
	 * `[8m]`'s daily ping — activation does not re-run on update.
	 */
	public function test_update_schedules_missing_cron_events(): void {
		$this->connected_on_old_version();

		// The old build's world: sync scheduled, no heartbeat.
		$GLOBALS['optionia_test_cron'][ Keys::CRON_SYNC_CONFIG ] = array(
			'timestamp'  => time() + 900,
			'recurrence' => Keys::CRON_SCHEDULE_QUARTER_HOUR,
		);

		$this->migrator()->maybe_upgrade();

		$this->assertArrayHasKey( Keys::CRON_HEARTBEAT, $GLOBALS['optionia_test_cron'] );
	}

	/**
	 * Activation writes its options autoload-off.
	 *
	 * Asserted here as well as by the architecture gate, because this is the
	 * path that creates them on a fresh install.
	 */
	public function test_activation_writes_options_autoload_off(): void {
		Activator::activate();

		foreach ( array( Keys::OPTION_DB_VERSION, Keys::OPTION_VERSION, Keys::OPTION_SETTINGS ) as $option ) {
			$this->assertFalse(
				$GLOBALS['optionia_test_autoload'][ $option ],
				$option . ' must not be autoloaded.'
			);
		}
	}

	/**
	 * Activation creates the log table and schedules both events.
	 */
	public function test_activation_prepares_the_site(): void {
		Activator::activate();

		$this->assertStringContainsString( 'optionia_sync_log', $GLOBALS['optionia_test_schema'][0] );
		$this->assertArrayHasKey( Keys::CRON_SYNC_CONFIG, $GLOBALS['optionia_test_cron'] );
		$this->assertArrayHasKey( Keys::CRON_HEARTBEAT, $GLOBALS['optionia_test_cron'] );
	}
}
