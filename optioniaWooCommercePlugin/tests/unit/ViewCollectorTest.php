<?php
/**
 * Accumulating option view counts (M25.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Analytics\ViewCollector;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * What the storefront beacon accumulates, and what bounds it.
 *
 * 🔴 **A view is every product page load.** The whole reason this class counts
 * rather than queues is that an append per event would write a thousand rows per
 * thousand views into `wp_options` -- in the request a customer is waiting on,
 * against Phase 25's exit criterion.
 *
 * @covers \Optionia\Analytics\ViewCollector
 */
final class ViewCollectorTest extends TestCase {

	/**
	 * Start from an empty store.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
	}

	/** A collector reading the stubbed option store. */
	private function collector(): ViewCollector {
		return new ViewCollector();
	}

	/** 🔴 The whole point: seeing an option counts it. */
	public function test_it_counts_an_option_that_was_seen(): void {
		$counted = $this->collector()->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$this->assertSame( 1, $counted );

		$pending = $this->collector()->pending();

		$this->assertCount( 1, $pending );
		$this->assertSame( 'engraving', $pending[0]['option_key'] );
		$this->assertSame( 1, $pending[0]['views'] );
	}

	/**
	 * 🔴 **A second view ADDS.** The cloud adds what arrives, so the plugin must
	 * accumulate rather than overwrite -- otherwise a day's traffic would report
	 * as one view.
	 */
	public function test_it_accumulates_repeat_views(): void {
		$collector = $this->collector();

		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );
		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );
		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$pending = $collector->pending();

		$this->assertSame( 3, $pending[0]['views'] );
	}

	/** ⚠️ A different day is a different count, or change over time is unanswerable. */
	public function test_it_keeps_days_apart(): void {
		$collector = $this->collector();

		$collector->add( 'set-1', array( 'engraving' ), '2026-09-28' );
		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$this->assertCount( 2, $collector->pending() );
	}

	/** ⚠️ And a different SET, so one set's views are never another's. */
	public function test_it_keeps_sets_apart(): void {
		$collector = $this->collector();

		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );
		$collector->add( 'set-2', array( 'engraving' ), '2026-09-29' );

		$this->assertCount( 2, $collector->pending() );
	}

	/** 📌 A page shows several options; one beacon counts them all. */
	public function test_it_counts_every_option_on_the_page(): void {
		$counted = $this->collector()->add( 'set-1', array( 'engraving', 'finish', 'wrap' ), '2026-09-29' );

		$this->assertSame( 3, $counted );
		$this->assertCount( 3, $this->collector()->pending() );
	}

	/**
	 * 🔴 **Cleared only by what was SENT, never wholesale.** A beacon arriving
	 * during the drain has already incremented a count, and wiping the option
	 * would discard a view the customer really made.
	 */
	public function test_it_clears_only_what_was_reported(): void {
		$collector = $this->collector();

		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );
		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$sent = $collector->pending();

		// A third view lands while the drain is in flight.
		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$collector->clear( $sent );

		$remaining = $collector->pending();

		$this->assertCount( 1, $remaining );
		$this->assertSame( 1, $remaining[0]['views'] );
	}

	/** 📌 Clearing everything that was sent leaves nothing behind. */
	public function test_it_empties_when_everything_was_reported(): void {
		$collector = $this->collector();

		$collector->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$collector->clear( $collector->pending() );

		$this->assertSame( array(), $collector->pending() );
	}

	/**
	 * ⚠️ **The stored option is NOT autoloaded.** This is written by customer
	 * traffic, so an autoloaded copy would be read on every request to the
	 * site -- including every request that has nothing to do with Optionia.
	 */
	public function test_it_stores_the_counts_under_the_expected_option(): void {
		$this->collector()->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$this->assertArrayHasKey( Keys::OPTION_VIEW_COUNTS, $GLOBALS['optionia_test_options'] );
	}

	/** ⚠️ Nothing to count is not an error, and writes nothing. */
	public function test_it_ignores_an_empty_beacon(): void {
		$collector = $this->collector();

		$this->assertSame( 0, $collector->add( 'set-1', array(), '2026-09-29' ) );
		$this->assertSame( 0, $collector->add( '', array( 'engraving' ), '2026-09-29' ) );
		$this->assertSame( 0, $collector->add( 'set-1', array( 'engraving' ), '' ) );
		$this->assertSame( array(), $collector->pending() );
	}

	/** ⚠️ A non-string option key is skipped rather than coerced. */
	public function test_it_skips_a_key_that_is_not_a_string(): void {
		$counted = $this->collector()->add( 'set-1', array( 'engraving', 42, '' ), '2026-09-29' );

		$this->assertSame( 1, $counted );
	}

	/**
	 * 🔴 **The abuse bound.** The nonce is a filter rather than a credential --
	 * every guest holds the same one for 24 hours -- so what actually stops a
	 * forged beacon inflating a count is this ceiling.
	 */
	public function test_it_stops_counting_an_option_at_the_ceiling(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_VIEW_COUNTS ] = array(
			'set-1|engraving|2026-09-29' => 1000000,
		);

		$counted = $this->collector()->add( 'set-1', array( 'engraving' ), '2026-09-29' );

		$this->assertSame( 0, $counted );

		$pending = $this->collector()->pending();

		$this->assertSame( 1000000, $pending[0]['views'] );
	}

	/**
	 * ⚠️ **A store offline for weeks must not grow this without bound.** The
	 * option is read and rewritten whole on every beacon, so an unbounded array
	 * would make each one slower than the last -- the failure this class exists
	 * to avoid, arriving by another route.
	 */
	public function test_it_stops_adding_new_pairs_at_the_cap(): void {
		$full = array();

		for ( $i = 0; $i < 500; $i++ ) {
			$full[ 'set-1|opt-' . $i . '|2026-09-29' ] = 1;
		}

		$GLOBALS['optionia_test_options'][ Keys::OPTION_VIEW_COUNTS ] = $full;

		$counted = $this->collector()->add( 'set-1', array( 'brand-new' ), '2026-09-29' );

		$this->assertSame( 0, $counted );
		$this->assertCount( 500, $this->collector()->pending() );
	}

	/**
	 * 📌 **An existing pair still counts when the table is full.** Refusing it
	 * would freeze a busy shop's most-viewed options at whatever they held when
	 * the cap was reached.
	 */
	public function test_an_existing_pair_still_counts_when_full(): void {
		$full = array();

		for ( $i = 0; $i < 500; $i++ ) {
			$full[ 'set-1|opt-' . $i . '|2026-09-29' ] = 1;
		}

		$GLOBALS['optionia_test_options'][ Keys::OPTION_VIEW_COUNTS ] = $full;

		$counted = $this->collector()->add( 'set-1', array( 'opt-3' ), '2026-09-29' );

		$this->assertSame( 1, $counted );
	}

	/** ⚠️ A corrupt stored value is treated as empty, never as a fatal. */
	public function test_it_survives_a_corrupt_stored_value(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_VIEW_COUNTS ] = 'not-an-array';

		$this->assertSame( array(), $this->collector()->pending() );
		$this->assertSame( 1, $this->collector()->add( 'set-1', array( 'engraving' ), '2026-09-29' ) );
	}
}
