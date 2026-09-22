<?php
/**
 * Products awaiting incremental sync (M19.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Catalogue\ProductQueue;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * The set of products the cloud has not been told about.
 *
 * @covers \Optionia\Catalogue\ProductQueue
 */
final class ProductQueueTest extends TestCase {

	/**
	 * Subject.
	 *
	 * @var ProductQueue
	 */
	private ProductQueue $queue;

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options']  = array();
		$GLOBALS['optionia_test_autoload'] = array();

		$this->queue = new ProductQueue( new Logger( new Settings() ) );
	}

	public function test_an_empty_queue_reads_as_empty(): void {
		$this->assertSame( array(), $this->queue->all() );
		$this->assertSame( 0, $this->queue->count() );
	}

	public function test_a_product_is_queued_with_its_action(): void {
		$this->queue->push( 42, ProductQueue::ACTION_UPSERT );

		$this->assertSame( array( 42 => ProductQueue::ACTION_UPSERT ), $this->queue->all() );
	}

	/**
	 * 🔴 **Never autoloaded.** Cron reads this and one admin row reports it; the
	 * storefront never does. Autoloading would put it on every page load.
	 */
	public function test_the_queue_is_not_autoloaded(): void {
		$this->queue->push( 42, ProductQueue::ACTION_UPSERT );

		$this->assertFalse( $GLOBALS['optionia_test_autoload'][ Keys::OPTION_PRODUCT_QUEUE ] );
	}

	// --- Keyed by id, not appended -------------------------------------------

	/**
	 * A product edited five times before the next drain is **one** entry. An
	 * append-only list would send it five times and make the queue's length
	 * track a merchant's typing speed rather than the work outstanding.
	 */
	public function test_editing_a_product_repeatedly_queues_it_once(): void {
		foreach ( range( 1, 5 ) as $ignored ) {
			$this->queue->push( 42, ProductQueue::ACTION_UPSERT );
		}

		$this->assertSame( 1, $this->queue->count() );
	}

	/**
	 * 🔴 **Edit-then-delete must end as a delete.** Keying by id makes the last
	 * write the answer, where a list would have to reason about which of two
	 * entries for one product came later.
	 */
	public function test_a_later_removal_replaces_an_earlier_upsert(): void {
		$this->queue->push( 42, ProductQueue::ACTION_UPSERT );
		$this->queue->push( 42, ProductQueue::ACTION_REMOVE );

		$this->assertSame( array( 42 => ProductQueue::ACTION_REMOVE ), $this->queue->all() );
	}

	/** And the reverse: a restore after a delete ends as an upsert. */
	public function test_a_later_upsert_replaces_an_earlier_removal(): void {
		$this->queue->push( 42, ProductQueue::ACTION_REMOVE );
		$this->queue->push( 42, ProductQueue::ACTION_UPSERT );

		$this->assertSame( array( 42 => ProductQueue::ACTION_UPSERT ), $this->queue->all() );
	}

	// --- Validation ----------------------------------------------------------

	public function test_an_unknown_action_is_refused(): void {
		$this->assertFalse( $this->queue->push( 42, 'explode' ) );
		$this->assertSame( 0, $this->queue->count() );
	}

	public function test_a_non_positive_id_is_refused(): void {
		$this->assertFalse( $this->queue->push( 0, ProductQueue::ACTION_UPSERT ) );
		$this->assertFalse( $this->queue->push( -1, ProductQueue::ACTION_UPSERT ) );
		$this->assertSame( 0, $this->queue->count() );
	}

	/**
	 * ⚠️ An option is writable through the database and survives downgrades, so
	 * a malformed entry is a real state — and one corrupt row must not stop
	 * every other product syncing.
	 */
	public function test_corrupt_entries_are_skipped_not_fatal(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_PRODUCT_QUEUE ] = array(
			10       => ProductQueue::ACTION_UPSERT,
			'not-id' => ProductQueue::ACTION_UPSERT,
			20       => 'nonsense',
			30       => ProductQueue::ACTION_REMOVE,
		);

		$this->assertSame(
			array(
				10 => ProductQueue::ACTION_UPSERT,
				30 => ProductQueue::ACTION_REMOVE,
			),
			$this->queue->all()
		);
	}

	public function test_a_corrupt_option_reads_as_empty(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_PRODUCT_QUEUE ] = 'not an array';

		$this->assertSame( array(), $this->queue->all() );
	}

	// --- Draining ------------------------------------------------------------

	public function test_forgetting_removes_one_product(): void {
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );
		$this->queue->push( 20, ProductQueue::ACTION_UPSERT );

		$this->assertTrue( $this->queue->forget( 10 ) );
		$this->assertSame( array( 20 => ProductQueue::ACTION_UPSERT ), $this->queue->all() );
	}

	public function test_forgetting_something_absent_is_not_an_error(): void {
		$this->assertFalse( $this->queue->forget( 999 ) );
	}

	/**
	 * Disconnect empties it: entries name a cloud this site no longer talks to,
	 * and a reconnect to a different store would push one store's edits into
	 * another's mirror.
	 */
	public function test_clearing_empties_the_queue(): void {
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );
		$this->queue->clear();

		$this->assertSame( array(), $this->queue->all() );
	}

	// --- The cap -------------------------------------------------------------

	/**
	 * ⚠️ **A dropped product is a deferral, not a loss** — M19.3's
	 * reconciliation rebuilds the mirror from the catalogue itself. That is why
	 * this cap is lower than `OrderQueue`'s 500, where a dropped order is
	 * revenue data with no other source.
	 */
	public function test_the_queue_is_capped(): void {
		foreach ( range( 1, ProductQueue::MAX_ENTRIES + 50 ) as $id ) {
			$this->queue->push( $id, ProductQueue::ACTION_UPSERT );
		}

		$this->assertSame( ProductQueue::MAX_ENTRIES, $this->queue->count() );
	}

	/**
	 * 🔴 **The oldest go, not the newest.** The newest entry is the edit a
	 * merchant just made and is watching for; the oldest are the ones most
	 * likely already superseded.
	 */
	public function test_the_oldest_entries_are_dropped_first(): void {
		foreach ( range( 1, ProductQueue::MAX_ENTRIES + 1 ) as $id ) {
			$this->queue->push( $id, ProductQueue::ACTION_UPSERT );
		}

		$queue = $this->queue->all();

		$this->assertArrayNotHasKey( 1, $queue, 'the oldest was dropped' );
		$this->assertArrayHasKey( ProductQueue::MAX_ENTRIES + 1, $queue, 'the newest was kept' );
	}
}
