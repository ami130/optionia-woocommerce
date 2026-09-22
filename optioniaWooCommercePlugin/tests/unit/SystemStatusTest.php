<?php
/**
 * The support report.
 *
 * The class had no tests before this file, for a mundane reason: every row
 * calling `human_time_diff()` fatalled in the harness, so the report could not
 * be built at all. A gap in the *stubs* left a production class entirely
 * unverified while six gates stayed green.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\SystemStatus;
use Optionia\Api\CircuitBreaker;
use Optionia\Api\FetchesFromCloud;
use Optionia\Catalogue\CatalogueCursor;
use Optionia\Catalogue\ProductQueue;
use Optionia\Config\Repository;
use Optionia\Config\Synchroniser;
use Optionia\Support\Cron;
use Optionia\Support\Environment;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * The report answers the questions support actually asks.
 *
 * @covers \Optionia\Admin\SystemStatus
 */
final class SystemStatusTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_cron']    = array();
	}

	/**
	 * Build a report over real collaborators.
	 */
	private function status(): SystemStatus {
		$settings = new Settings();
		$logger   = new Logger( $settings );

		$repository = new Repository( $logger );

		return new SystemStatus(
			new Environment(),
			$repository,
			$settings,
			new Cron(
				$logger,
				// A real synchroniser over a client that is never called: this
				// renders a report, and reaching the network to do it would be
				// the bug rather than the fixture.
				new Synchroniser( $this->createMock( FetchesFromCloud::class ), $repository, $logger )
			),
			new CircuitBreaker( $logger ),
			new CatalogueCursor(),
			new ProductQueue( $logger )
		);
	}

	/**
	 * Find a row by label across every section.
	 *
	 * @param array<string, array<string, string>> $report Report.
	 * @param string                               $label  Row label.
	 */
	private function row( array $report, string $label ): ?string {
		foreach ( $report as $rows ) {
			if ( isset( $rows[ $label ] ) ) {
				return $rows[ $label ];
			}
		}

		return null;
	}

	/**
	 * The report builds at all.
	 *
	 * Worth stating plainly: until the harness gained `human_time_diff()` this
	 * threw a fatal, and nothing noticed.
	 */
	public function test_report_builds_without_fatal(): void {
		$report = $this->status()->report();

		$this->assertNotEmpty( $report );
		$this->assertNotNull( $this->row( $report, 'Last heartbeat' ) );
	}

	/**
	 * A store that has never pinged says so.
	 */
	public function test_heartbeat_row_reads_never_before_any_ping(): void {
		$this->assertSame( 'never', $this->row( $this->status()->report(), 'Last heartbeat' ) );
	}

	/**
	 * A successful ping is reported as an age.
	 */
	public function test_heartbeat_row_reports_age_after_success(): void {
		update_option(
			Keys::OPTION_LAST_HEARTBEAT,
			array(
				'at' => time() - ( 2 * HOUR_IN_SECONDS ),
				'ok' => true,
			),
			false
		);

		$this->assertSame( '2 hours ago', $this->row( $this->status()->report(), 'Last heartbeat' ) );
	}

	/**
	 * A failed ping is distinguishable from a successful one.
	 *
	 * "Ran and failed" and "ran fine" are different support answers, and a row
	 * that showed only an age would collapse them into one.
	 */
	public function test_heartbeat_row_marks_failure(): void {
		update_option(
			Keys::OPTION_LAST_HEARTBEAT,
			array(
				'at' => time() - ( 30 * MINUTE_IN_SECONDS ),
				'ok' => false,
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Last heartbeat' );

		$this->assertStringContainsString( 'failed', $value );
		$this->assertStringContainsString( '30 min', $value );
	}

	/**
	 * A malformed record does not take the whole report down.
	 *
	 * The option is data on disk: a partial write, or an older plugin's shape,
	 * must not fatal the one screen a merchant opens when things are broken.
	 */
	public function test_malformed_heartbeat_record_is_survivable(): void {
		update_option( Keys::OPTION_LAST_HEARTBEAT, array( 'ok' => true ), false );

		$this->assertSame( 'never', $this->row( $this->status()->report(), 'Last heartbeat' ) );
	}

	/**
	 * A non-array record is ignored rather than unpacked.
	 */
	public function test_scalar_heartbeat_record_is_ignored(): void {
		update_option( Keys::OPTION_LAST_HEARTBEAT, 'corrupted', false );

		$this->assertSame( 'never', $this->row( $this->status()->report(), 'Last heartbeat' ) );
	}

	/**
	 * A shop that has never synced says so.
	 */
	public function test_sync_row_reads_never_before_any_sync(): void {
		$this->assertSame( 'never', $this->row( $this->status()->report(), 'Last sync' ) );
	}

	/**
	 * "Next sync" answers when WP-Cron intends to run; this answers whether it
	 * ever did. On a low-traffic shop a schedule can look healthy while nothing
	 * has fired for days.
	 */
	public function test_sync_row_reports_a_fetched_document(): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time() - HOUR_IN_SECONDS,
				'ok'      => true,
				'outcome' => 'updated',
			),
			false
		);

		$this->assertSame( 'updated 1 hour ago', $this->row( $this->status()->report(), 'Last sync' ) );
	}

	/**
	 * A successful check that changed nothing is not the same as an update.
	 *
	 * Reporting both as "synced" would leave a merchant unable to tell a working
	 * conditional request from one that keeps refetching the same document.
	 */
	public function test_sync_row_distinguishes_unchanged_from_updated(): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time() - ( 30 * MINUTE_IN_SECONDS ),
				'ok'      => true,
				'outcome' => 'unchanged',
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Last sync' );

		$this->assertStringContainsString( 'already current', $value );
		$this->assertStringNotContainsString( 'updated', $value );
	}

	/**
	 * A failure carries its reason.
	 *
	 * `refused` means the plugin is too old for the document the cloud is
	 * sending; an HTTP error means the network. Those point at different fixes,
	 * and a merchant told only "failed" cannot tell them apart.
	 */
	public function test_sync_row_carries_the_failure_reason(): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time() - ( 10 * MINUTE_IN_SECONDS ),
				'ok'      => false,
				'outcome' => 'refused',
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Last sync' );

		$this->assertStringContainsString( 'failed', $value );
		$this->assertStringContainsString( 'refused', $value );
	}

	/**
	 * A malformed record does not take the support screen down.
	 *
	 * The option is data on disk: a partial write, or an older plugin's shape,
	 * must not fatal the one page a merchant opens when things are broken.
	 */
	public function test_malformed_sync_record_is_survivable(): void {
		update_option( Keys::OPTION_LAST_SYNC, 'corrupted', false );

		$this->assertSame( 'never', $this->row( $this->status()->report(), 'Last sync' ) );
	}


	/**
	 * Every row M9.7 names is present.
	 *
	 * The milestone is a list of six, and a list compared by eye is one that
	 * drifts. Asserted here so removing a row fails rather than going unnoticed
	 * — the same reason the degradation matrix became named tests.
	 *
	 * The index count was deliberately absent until Phase 10 Stage 2: it moved
	 * to M10.1 with the rest of M9.2's second half, because a count of an index
	 * that does not exist reads identically whether it is empty or absent. Stage
	 * 2 built the index, so "Indexed products" joins the list here — alongside
	 * "Deferred assignments", the count of what M19.4 has yet to resolve.
	 */
	public function test_every_row_m97_names_is_present(): void {
		$report = $this->status()->report();

		foreach ( array( 'Config version', 'Last fetch', 'Last error', 'Cache size', 'Next sync', 'Indexed products', 'Deferred assignments' ) as $label ) {
			$this->assertNotNull(
				$this->row( $report, $label ),
				$label . ' is named by M9.7 and must appear in System Status.'
			);
		}
	}

	/**
	 * Nothing wrong reads as nothing wrong.
	 */
	public function test_last_error_reads_none_when_nothing_failed(): void {
		$this->assertSame( 'none', $this->row( $this->status()->report(), 'Last error' ) );
	}

	/**
	 * The most recent failure wins, whatever kind it was.
	 *
	 * This is the row's whole purpose: answering "what most recently went
	 * wrong?" without a merchant reading four rows and comparing timestamps.
	 */
	public function test_last_error_reports_the_most_recent_failure(): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time() - HOUR_IN_SECONDS,
				'ok'      => false,
				'outcome' => 'http_500',
			),
			false
		);

		update_option(
			Keys::OPTION_LAST_PUSH,
			array(
				'at'       => time() - ( 10 * MINUTE_IN_SECONDS ),
				'accepted' => false,
				'outcome'  => 'invalid_signature',
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Last error' );

		$this->assertStringContainsString( 'inbound push', $value, 'The newer failure wins.' );
		$this->assertStringNotContainsString( 'config sync', $value );
	}

	/**
	 * The source is named, not just the failure.
	 *
	 * "config sync failed (refused)" sends someone to the plugin version;
	 * "heartbeat failed" sends them to the network. A bare "failed" sends them
	 * nowhere.
	 */
	public function test_last_error_names_what_failed(): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time() - MINUTE_IN_SECONDS,
				'ok'      => false,
				'outcome' => 'refused',
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Last error' );

		$this->assertStringContainsString( 'config sync', $value );
		$this->assertStringContainsString( 'refused', $value );
	}

	/** A success is not a failure, however recent. */
	public function test_last_error_ignores_successful_runs(): void {
		update_option(
			Keys::OPTION_LAST_SYNC,
			array(
				'at'      => time(),
				'ok'      => true,
				'outcome' => 'unchanged',
			),
			false
		);

		$this->assertSame( 'none', $this->row( $this->status()->report(), 'Last error' ) );
	}

	/**
	 * A push that never arrived is itself a diagnosis.
	 *
	 * Nothing else in the plugin records that a request did not happen, and it
	 * points somewhere specific: a firewall, a security plugin blocking REST, a
	 * host refusing unauthenticated POSTs.
	 */
	public function test_push_row_says_when_the_cloud_has_never_reached_the_shop(): void {
		$value = (string) $this->row( $this->status()->report(), 'Last push' );

		$this->assertStringContainsString( 'never', $value );
	}

	/**
	 * Arrived-and-refused is a different problem from never-arrived.
	 */
	public function test_push_row_distinguishes_a_refused_push(): void {
		update_option(
			Keys::OPTION_LAST_PUSH,
			array(
				'at'       => time() - MINUTE_IN_SECONDS,
				'accepted' => false,
				'outcome'  => 'invalid_signature',
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Last push' );

		$this->assertStringContainsString( 'refused', $value );
		$this->assertStringContainsString( 'signature', $value );
	}

	/**
	 * The support screen agrees with the admin notice.
	 *
	 * A merchant who sees "update your plugin" and opens System Status to find
	 * out why must not read nothing about it.
	 */
	public function test_schema_row_surfaces_a_refusal(): void {
		update_option(
			Keys::OPTION_SCHEMA_REFUSED,
			array(
				'at'              => time() - MINUTE_IN_SECONDS,
				'document_schema' => 99,
				'supported'       => 1,
			),
			false
		);

		$value = (string) $this->row( $this->status()->report(), 'Schema version' );

		$this->assertStringContainsString( '99', $value );
		$this->assertStringContainsString( 'update the plugin', $value );
	}

	/** A healthy store's schema row stays quiet. */
	public function test_schema_row_is_quiet_without_a_refusal(): void {
		$value = (string) $this->row( $this->status()->report(), 'Schema version' );

		$this->assertStringNotContainsString( 'update the plugin', $value );
	}

	/**
	 * The text rendering includes the heartbeat.
	 *
	 * `as_text()` is what a merchant pastes into a support ticket; a row present
	 * in the array but missing from the text would help nobody.
	 */
	public function test_text_report_includes_the_heartbeat_row(): void {
		update_option(
			Keys::OPTION_LAST_HEARTBEAT,
			array(
				'at' => time() - HOUR_IN_SECONDS,
				'ok' => true,
			),
			false
		);

		$this->assertStringContainsString( 'Last heartbeat', $this->status()->as_text() );
	}

	// --- Catalogue sync (M19.1) ----------------------------------------------

	/**
	 * 🔴 **Three states, not two.** "Never started" and "finished" both show no
	 * work outstanding, and a merchant reading one as the other draws the
	 * opposite conclusion about whether something is wrong.
	 */
	public function test_catalogue_row_says_not_started_before_any_walk(): void {
		$this->assertSame( 'not started', $this->row( $this->status()->report(), 'Catalogue sync' ) );
	}

	/**
	 * A walk takes **4.2 days** for a 100k catalogue, and `/products` shows a
	 * partial list throughout. Progress is how a merchant tells a sync that is
	 * working from one that stalled.
	 */
	public function test_catalogue_row_reports_progress_during_a_walk(): void {
		$cursor = new CatalogueCursor();
		$run_id = $cursor->start( 3000 );
		$cursor->advance( $run_id, 750 );

		$this->assertSame(
			'in progress (750 of 3000)',
			$this->row( $this->status()->report(), 'Catalogue sync' )
		);
	}

	public function test_catalogue_row_reports_completion(): void {
		$cursor = new CatalogueCursor();
		$run_id = $cursor->start( 250 );
		$cursor->advance( $run_id, 250 );

		$this->assertSame(
			'complete (250 products)',
			$this->row( $this->status()->report(), 'Catalogue sync' )
		);
	}

	/**
	 * 🔴 **A stalled walk must not read as a fresh one.** `in progress (0 of
	 * 3000)` is what a merchant sees whether the push started a minute ago or
	 * has been failing for three days — and a failed batch only writes a log
	 * line nobody reads.
	 */
	public function test_catalogue_row_flags_a_stalled_walk(): void {
		$cursor = new CatalogueCursor();
		$run_id = $cursor->start( 3000 );
		$cursor->advance( $run_id, 250 );

		$stored               = $GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ];
		$stored['updated_at'] = time() - ( 6 * HOUR_IN_SECONDS );

		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = $stored;

		$row = $this->row( $this->status()->report(), 'Catalogue sync' );

		$this->assertStringContainsString( 'in progress (250 of 3000)', (string) $row );
		$this->assertStringContainsString( 'stalled', (string) $row );
	}

	/**
	 * ⚠️ **And a walk that advanced recently must not be flagged.** The schedule
	 * is 900 seconds, so a threshold of one interval would cry wolf on every
	 * transient blip; an hour is four consecutive failures.
	 */
	public function test_catalogue_row_does_not_flag_a_recent_walk(): void {
		$cursor = new CatalogueCursor();
		$run_id = $cursor->start( 3000 );
		$cursor->advance( $run_id, 250 );

		$stored               = $GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ];
		$stored['updated_at'] = time() - ( 20 * MINUTE_IN_SECONDS );

		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = $stored;

		$this->assertSame(
			'in progress (250 of 3000)',
			$this->row( $this->status()->report(), 'Catalogue sync' )
		);
	}

	/** A finished walk is never "stalled", however long ago it finished. */
	public function test_a_completed_walk_is_never_flagged_as_stalled(): void {
		$cursor = new CatalogueCursor();
		$run_id = $cursor->start( 250 );
		$cursor->advance( $run_id, 250 );

		$stored               = $GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ];
		$stored['updated_at'] = time() - ( 30 * DAY_IN_SECONDS );

		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = $stored;

		$this->assertSame(
			'complete (250 products)',
			$this->row( $this->status()->report(), 'Catalogue sync' )
		);
	}

	/**
	 * ⚠️ **A number that should be near zero and briefly is not.** The queue
	 * drains every fifteen minutes, so a small count after an edit is normal.
	 * One that *stays* high is the visible symptom of a store the cloud is
	 * refusing — and the connection row beside it says whether that is so.
	 */
	public function test_pending_product_changes_are_reported(): void {
		$queue = new ProductQueue( new Logger( new Settings() ) );
		$queue->push( 10, ProductQueue::ACTION_UPSERT );
		$queue->push( 20, ProductQueue::ACTION_REMOVE );

		$this->assertSame( '2', $this->row( $this->status()->report(), 'Pending product changes' ) );
	}

	public function test_pending_product_changes_is_zero_when_nothing_waits(): void {
		$this->assertSame( '0', $this->row( $this->status()->report(), 'Pending product changes' ) );
	}

	/**
	 * ⚠️ **"never" is a real answer, not a missing one.** The sweep refuses
	 * until the initial walk finishes, so a store still importing shows this
	 * correctly — and one that shows it *after* the walk completed has a daily
	 * job that is not running, which is the question this row answers.
	 */
	public function test_last_reconciled_says_never_before_any_sweep(): void {
		$this->assertSame( 'never', $this->row( $this->status()->report(), 'Last reconciled' ) );
	}

	public function test_last_reconciled_reports_how_long_ago(): void {
		update_option( Keys::OPTION_LAST_RECONCILE, time() - ( 3 * HOUR_IN_SECONDS ), false );

		$this->assertStringContainsString(
			'ago',
			(string) $this->row( $this->status()->report(), 'Last reconciled' )
		);
	}

	/** The row reaches the copy-for-support text, which is what merchants paste. */
	public function test_catalogue_row_appears_in_the_text_report(): void {
		$this->assertStringContainsString( 'Catalogue sync', $this->status()->as_text() );
	}
}
