<?php
/**
 * Where the catalogue push has reached (M19.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Catalogue\CatalogueCursor;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * Where the catalogue push has reached.
 *
 * @covers \Optionia\Catalogue\CatalogueCursor
 */
final class CatalogueCursorTest extends TestCase {

	/**
	 * Subject.
	 *
	 * @var CatalogueCursor
	 */
	private CatalogueCursor $cursor;

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options']  = array();
		$GLOBALS['optionia_test_autoload'] = array();

		$this->cursor = new CatalogueCursor();
	}

	public function test_an_unrun_cursor_reads_empty(): void {
		$cursor = $this->cursor->read();

		$this->assertSame( '', $cursor['run_id'] );
		$this->assertSame( 0, $cursor['offset'] );
		$this->assertFalse( $this->cursor->has_run( $cursor ) );
	}

	/**
	 * 🔴 Never autoloaded: cron and one admin screen read this, and the
	 * storefront never does. Autoloading it would put it on every page load.
	 */
	public function test_the_cursor_is_not_autoloaded(): void {
		$this->cursor->start( 100 );

		$this->assertFalse( $GLOBALS['optionia_test_autoload'][ Keys::OPTION_CATALOGUE_CURSOR ] );
	}

	public function test_starting_a_walk_records_the_total(): void {
		$run_id = $this->cursor->start( 3000 );
		$cursor = $this->cursor->read();

		$this->assertNotSame( '', $run_id );
		$this->assertSame( $run_id, $cursor['run_id'] );
		$this->assertSame( 3000, $cursor['total'] );
		$this->assertSame( 0, $cursor['offset'] );
	}

	public function test_advancing_moves_the_offset(): void {
		$run_id = $this->cursor->start( 500 );

		$this->assertTrue( $this->cursor->advance( $run_id, 250 ) );
		$this->assertSame( 250, $this->cursor->read()['offset'] );

		$this->cursor->advance( $run_id, 250 );
		$this->assertSame( 500, $this->cursor->read()['offset'] );
	}

	/**
	 * 🔴 **The guard the run id exists for.** A batch whose response arrives
	 * after a new walk began would otherwise move the *new* walk's offset by the
	 * *old* walk's count, skipping products nothing would ever report.
	 */
	public function test_a_stale_run_cannot_advance_a_new_walk(): void {
		$old_run = $this->cursor->start( 500 );
		$new_run = $this->cursor->start( 500 );

		$this->assertNotSame( $old_run, $new_run );
		$this->assertFalse( $this->cursor->advance( $old_run, 250 ) );
		$this->assertSame( 0, $this->cursor->read()['offset'] );
	}

	public function test_an_empty_run_id_cannot_advance(): void {
		$this->cursor->start( 500 );

		$this->assertFalse( $this->cursor->advance( '', 250 ) );
		$this->assertSame( 0, $this->cursor->read()['offset'] );
	}

	public function test_a_walk_is_complete_when_the_offset_reaches_the_total(): void {
		$run_id = $this->cursor->start( 250 );

		$this->assertFalse( $this->cursor->is_complete( $this->cursor->read() ) );

		$this->cursor->advance( $run_id, 250 );

		$this->assertTrue( $this->cursor->is_complete( $this->cursor->read() ) );
	}

	/**
	 * A catalogue that shrank mid-walk leaves the offset past the total. That is
	 * finished, not broken — `>=` rather than `===`.
	 */
	public function test_an_overshot_offset_counts_as_complete(): void {
		$run_id = $this->cursor->start( 100 );

		$this->cursor->advance( $run_id, 250 );

		$this->assertTrue( $this->cursor->is_complete( $this->cursor->read() ) );
	}

	/** An unrun cursor is not "complete" — it is one that never started. */
	public function test_an_unrun_cursor_is_not_complete(): void {
		$this->assertFalse( $this->cursor->is_complete( $this->cursor->read() ) );
	}

	/**
	 * ⚠️ An option is writable through the database and survives downgrades, so
	 * a stored value of the wrong type is a real state — not a hypothetical.
	 */
	public function test_a_corrupt_option_reads_as_empty_rather_than_throwing(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = 'not an array';

		$cursor = $this->cursor->read();

		$this->assertSame( '', $cursor['run_id'] );
		$this->assertSame( 0, $cursor['offset'] );
	}

	public function test_wrongly_typed_fields_are_coerced_not_trusted(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = array(
			'run_id' => array( 'not', 'a', 'string' ),
			'offset' => '-50',
			'total'  => '3000',
		);

		$cursor = $this->cursor->read();

		$this->assertSame( '', $cursor['run_id'] );
		$this->assertSame( 0, $cursor['offset'], 'a negative offset is nonsense, not a position' );
		$this->assertSame( 3000, $cursor['total'] );
	}

	// --- Overlap ------------------------------------------------------------

	/**
	 * 🔴 **The defect the claim exists for.** Two cron runs overlapping both
	 * read the same offset, both send the same batch, and then **both advance**
	 * — leaving the cursor 250 past where it should be, with those products
	 * never sent. The run-id guard does not help: both runs carry the same id.
	 */
	public function test_a_second_run_cannot_claim_while_the_first_holds_it(): void {
		$this->cursor->start( 500 );

		$this->assertTrue( $this->cursor->claim(), 'the first run claims' );
		$this->assertFalse( $this->cursor->claim(), 'a concurrent run is refused' );
	}

	public function test_releasing_lets_the_next_run_claim(): void {
		$this->cursor->start( 500 );
		$this->cursor->claim();
		$this->cursor->release();

		$this->assertTrue( $this->cursor->claim() );
	}

	/**
	 * ⚠️ **A crashed run must not block the walk for ever.** It never releases,
	 * so the claim has to expire on its own — longer than a batch can take,
	 * shorter than the cron interval.
	 */
	public function test_a_stale_claim_expires(): void {
		$this->cursor->start( 500 );
		$this->cursor->claim();

		$stored               = $GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ];
		$stored['claimed_at'] = time() - 600;

		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = $stored;

		$this->assertTrue( $this->cursor->claim(), 'a claim older than the timeout is reclaimable' );
	}

	/** A claim held for less than the timeout is still live. */
	public function test_a_recent_claim_is_not_stolen(): void {
		$this->cursor->start( 500 );
		$this->cursor->claim();

		$stored               = $GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ];
		$stored['claimed_at'] = time() - 60;

		$GLOBALS['optionia_test_options'][ Keys::OPTION_CATALOGUE_CURSOR ] = $stored;

		$this->assertFalse( $this->cursor->claim() );
	}

	/**
	 * 🔴 **A claim survives `start()`, and a surviving mutant found that it did
	 * not.** `start()` wrote `claimed_at => 0`, discarding the lock of the very
	 * run calling it — so a **first** run released its own claim mid-flight and
	 * a concurrent run could enter, skipping a batch. The overlap `claim()`
	 * exists to prevent, reintroduced three lines away from it.
	 */
	public function test_starting_a_walk_keeps_a_claim_already_held(): void {
		$this->assertTrue( $this->cursor->claim() );

		$this->cursor->start( 1000 );

		$this->assertGreaterThan( 0, $this->cursor->read()['claimed_at'], 'the claim survived' );
		$this->assertFalse( ( new CatalogueCursor() )->claim(), 'a concurrent run is still refused' );
	}

	/** An unclaimed start leaves the cursor unclaimed — it does not invent one. */
	public function test_starting_without_a_claim_leaves_it_unclaimed(): void {
		$this->cursor->start( 1000 );

		$this->assertSame( 0, $this->cursor->read()['claimed_at'] );
	}

	/** Claiming must not disturb the position it protects. */
	public function test_claiming_does_not_move_the_offset(): void {
		$run_id = $this->cursor->start( 500 );
		$this->cursor->advance( $run_id, 250 );
		$this->cursor->claim();

		$this->assertSame( 250, $this->cursor->read()['offset'] );
		$this->assertSame( $run_id, $this->cursor->read()['run_id'] );
	}

	/**
	 * Disconnect forgets the position: a credential that no longer works cannot
	 * push, and resuming into a cloud that has forgotten the run is worse than
	 * starting again.
	 */
	public function test_forgetting_clears_the_cursor(): void {
		$this->cursor->start( 500 );
		$this->cursor->forget();

		$this->assertFalse( $this->cursor->has_run( $this->cursor->read() ) );
	}
}
