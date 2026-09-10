<?php
/**
 * The queue of unreported orders (M12.7).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Reporting\OrderQueue;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * A bounded, persistent list of order ids.
 *
 * @covers \Optionia\Reporting\OrderQueue
 */
final class OrderQueueTest extends TestCase {

	/**
	 * Reset stored options.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options'] = array();
	}

	/**
	 * A queue under test.
	 */
	private function queue(): OrderQueue {
		return new OrderQueue( new Logger( new Settings() ) );
	}

	// --- Basic behaviour -----------------------------------------------------

	/** An order joins the queue. */
	public function test_an_order_can_be_queued(): void {
		$queue = $this->queue();
		$queue->push( 41 );

		$this->assertSame( array( 41 ), $queue->all() );
	}

	/** The queue survives the request that wrote it. */
	public function test_the_queue_persists(): void {
		$this->queue()->push( 41 );

		$this->assertSame( array( 41 ), $this->queue()->all() );
	}

	/**
	 * The same order is not queued twice.
	 *
	 * WooCommerce can fire a status transition more than once, and a queue
	 * holding an order twice would report it twice.
	 */
	public function test_the_same_order_is_not_queued_twice(): void {
		$queue = $this->queue();
		$queue->push( 41 );
		$queue->push( 41 );

		$this->assertSame( array( 41 ), $queue->all() );
	}

	/** Order is preserved, oldest first. */
	public function test_orders_keep_their_order(): void {
		$queue = $this->queue();
		$queue->push( 41 );
		$queue->push( 42 );
		$queue->push( 43 );

		$this->assertSame( array( 41, 42, 43 ), $queue->all() );
	}

	/** A reported order leaves. */
	public function test_an_order_can_be_forgotten(): void {
		$queue = $this->queue();
		$queue->push( 41 );
		$queue->push( 42 );
		$queue->forget( 41 );

		$this->assertSame( array( 42 ), $queue->all() );
	}

	/** Forgetting an absent order changes nothing. */
	public function test_forgetting_an_absent_order_is_harmless(): void {
		$queue = $this->queue();
		$queue->push( 41 );

		$this->assertFalse( $queue->forget( 99 ) );
		$this->assertSame( array( 41 ), $queue->all() );
	}

	/** The queue can be emptied. */
	public function test_the_queue_can_be_cleared(): void {
		$queue = $this->queue();
		$queue->push( 41 );
		$queue->clear();

		$this->assertSame( array(), $queue->all() );
		$this->assertSame( 0, $queue->count() );
	}

	// --- The cap -------------------------------------------------------------

	/**
	 * **The queue is bounded, and drops the oldest.**
	 *
	 * A store whose credential was revoked keeps completing orders while every
	 * report fails. Unbounded, the option grows until it exceeds
	 * `max_allowed_packet` and then *every* `update_option()` fails — taking
	 * unrelated plugin settings down with it. The newest orders are kept,
	 * because those are the ones a merchant is looking at.
	 */
	public function test_the_queue_is_bounded(): void {
		$queue = $this->queue();

		for ( $id = 1; $id <= OrderQueue::MAX_ENTRIES + 5; $id++ ) {
			$queue->push( $id );
		}

		$all = $queue->all();

		$this->assertCount( OrderQueue::MAX_ENTRIES, $all );
		$this->assertSame( 6, $all[0], 'The oldest entries should be dropped.' );
		$this->assertSame( OrderQueue::MAX_ENTRIES + 5, end( $all ) );
	}

	// --- Robustness ----------------------------------------------------------

	/**
	 * A corrupted option does not produce order id 0.
	 *
	 * Casting rather than dropping would turn an unexpected value into a
	 * request for order 0, which the cloud would refuse forever.
	 *
	 * @dataProvider provide_corrupt_queues
	 *
	 * @param mixed              $stored   What the option holds.
	 * @param array<int, int>    $expected What should survive.
	 */
	public function test_corrupt_entries_are_dropped( $stored, array $expected ): void {
		update_option( Keys::OPTION_ORDER_QUEUE, $stored, false );

		$this->assertSame( $expected, $this->queue()->all() );
	}

	/**
	 * Shapes the option might hold.
	 *
	 * @return array<string, array{mixed, array<int, int>}>
	 */
	public static function provide_corrupt_queues(): array {
		return array(
			'not an array'       => array( 'nonsense', array() ),
			'nested arrays'      => array( array( array( 41 ) ), array() ),
			'nulls'              => array( array( null, 41 ), array( 41 ) ),
			'negative'           => array( array( -1, 41 ), array( 41 ) ),
			'zero'               => array( array( 0, 41 ), array( 41 ) ),
			'floats'             => array( array( 1.5, 41 ), array( 41 ) ),
			'numeric strings'    => array( array( '41', '42' ), array( 41, 42 ) ),
			'non-numeric string' => array( array( 'abc', 41 ), array( 41 ) ),
			'duplicates'         => array( array( 41, 41 ), array( 41 ) ),
		);
	}

	/** An invalid id is never queued. */
	public function test_an_invalid_id_is_not_queued(): void {
		$queue = $this->queue();

		$this->assertFalse( $queue->push( 0 ) );
		$this->assertFalse( $queue->push( -1 ) );
		$this->assertSame( array(), $queue->all() );
	}

	/**
	 * The option is not autoloaded.
	 *
	 * A growing option on every page load of the site is a storefront cost for
	 * data the storefront never reads.
	 */
	public function test_the_queue_is_not_autoloaded(): void {
		$this->queue()->push( 41 );

		$this->assertFalse(
			$GLOBALS['optionia_test_autoload'][ Keys::OPTION_ORDER_QUEUE ] ?? null,
			'An autoloaded queue is read on every page load of the entire site.'
		);
	}
}
