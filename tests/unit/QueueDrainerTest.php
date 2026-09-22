<?php
/**
 * Sending queued product changes to the cloud (M19.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Catalogue\CataloguePayload;
use Optionia\Catalogue\ProductQueue;
use Optionia\Catalogue\QueueDrainer;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Draining the product queue.
 *
 * @covers \Optionia\Catalogue\QueueDrainer
 */
final class QueueDrainerTest extends TestCase {

	/**
	 * Captured POSTs.
	 *
	 * @var array<int, array<string, mixed>>
	 */
	private array $posts = array();

	/**
	 * Captured DELETE paths.
	 *
	 * @var array<int, string>
	 */
	private array $deletes = array();

	/**
	 * Products awaiting sync.
	 *
	 * @var ProductQueue
	 */
	private ProductQueue $queue;

	/**
	 * Responses to answer with; the last repeats.
	 *
	 * @var array<int, Response>
	 */
	private array $responses = array();

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_autoload']   = array();
		$GLOBALS['optionia_test_products']   = array();
		$GLOBALS['optionia_test_terms']      = array();
		$GLOBALS['optionia_test_decimals']   = 2;
		$GLOBALS['optionia_test_post_types'] = array();

		$this->posts     = array();
		$this->deletes   = array();
		$this->responses = array();
		$this->queue     = new ProductQueue( new Logger( new Settings() ) );

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTED, false );
	}

	/** A drainer whose transport records every call. */
	private function drainer(): QueueDrainer {
		$client = $this->createMock( PostsToCloud::class );

		$client->method( 'post' )->willReturnCallback(
			function ( string $path, array $body ): Response {
				$this->posts[] = array(
					'path' => $path,
					'body' => $body,
				);

				return array_shift( $this->responses ) ?? Response::success( 200, array() );
			}
		);

		$client->method( 'delete' )->willReturnCallback(
			function ( string $path ): Response {
				$this->deletes[] = $path;

				return array_shift( $this->responses ) ?? Response::success( 200, array( 'removed' => true ) );
			}
		);

		return new QueueDrainer(
			$client,
			$this->queue,
			new CataloguePayload(),
			new Logger( new Settings() )
		);
	}

	/** Register a product the payload builder can find. */
	private function product( int $id ): void {
		$p         = optionia_test_product( $id, 'simple', '9.99' );
		$p->name   = "Product {$id}";
		$p->status = 'publish';
	}

	// --- Upserts -------------------------------------------------------------

	/**
	 * 🔴 **One request, not one per product.** The ingest takes up to 250 in a
	 * batch; sending them singly would waste an endpoint built for it.
	 */
	public function test_queued_upserts_go_in_one_batch(): void {
		foreach ( array( 10, 20, 30 ) as $id ) {
			$this->product( $id );
			$this->queue->push( $id, ProductQueue::ACTION_UPSERT );
		}

		$this->assertSame( 3, $this->drainer()->drain() );
		$this->assertCount( 1, $this->posts, 'three products, one request' );
		$this->assertCount( 3, $this->posts[0]['body']['products'] );
	}

	public function test_a_synced_product_leaves_the_queue(): void {
		$this->product( 10 );
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );

		$this->drainer()->drain();

		$this->assertSame( 0, $this->queue->count() );
	}

	/**
	 * 🔴 **Forgotten only after the cloud confirms.** The queue is the only
	 * record that a change happened — WooCommerce keeps no list of what has
	 * synced — so clearing it before the answer would lose the edit.
	 */
	public function test_a_failed_batch_stays_queued(): void {
		$this->product( 10 );
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );
		$this->responses = array( Response::failure( 503, 'SERVICE_UNAVAILABLE', 'down' ) );

		$this->assertSame( 0, $this->drainer()->drain() );
		$this->assertSame( 1, $this->queue->count(), 'the next run retries it' );
	}

	/**
	 * A product queued for upsert and then deleted outright: the upsert has
	 * nothing to send, and leaving it queued would retry for ever.
	 */
	public function test_an_upsert_for_a_vanished_product_is_dropped(): void {
		$this->queue->push( 999, ProductQueue::ACTION_UPSERT );

		$this->assertSame( 0, $this->drainer()->drain() );
		$this->assertSame( array(), $this->posts, 'nothing to send' );
		$this->assertSame( 0, $this->queue->count(), 'and nothing left to retry' );
	}

	// --- Removals ------------------------------------------------------------

	/**
	 * ⚠️ **One request each, because the id is in the path.** Removals cannot
	 * batch, which is why their per-run cap is lower than the upserts'.
	 */
	public function test_queued_removals_are_sent_individually(): void {
		foreach ( array( 10, 20 ) as $id ) {
			$this->queue->push( $id, ProductQueue::ACTION_REMOVE );
		}

		$this->assertSame( 2, $this->drainer()->drain() );
		$this->assertCount( 2, $this->deletes );
		$this->assertStringContainsString( '/store/products/10', $this->deletes[0] );
	}

	public function test_a_removed_product_leaves_the_queue(): void {
		$this->queue->push( 10, ProductQueue::ACTION_REMOVE );

		$this->drainer()->drain();

		$this->assertSame( 0, $this->queue->count() );
	}

	/**
	 * ⚠️ **Stop on the first failure.** The cause is almost always the same for
	 * every removal — the cloud is down, or the credential is bad — so
	 * continuing would hand the shared circuit breaker nineteen more failures.
	 */
	public function test_removals_stop_at_the_first_failure(): void {
		foreach ( array( 10, 20, 30 ) as $id ) {
			$this->queue->push( $id, ProductQueue::ACTION_REMOVE );
		}

		$this->responses = array( Response::failure( 500, 'INTERNAL_ERROR', 'boom' ) );

		$this->drainer()->drain();

		$this->assertCount( 1, $this->deletes, 'it did not work through the rest' );
		$this->assertSame( 3, $this->queue->count(), 'all three remain for the next run' );
	}

	/**
	 * 🔴 **The removal cap, which a surviving mutant found untested.** Each
	 * removal is its own request, and `Api\Client` allows 8 seconds per
	 * attempt — so an uncapped run could spend minutes inside a cron request.
	 * Raising the cap to the upsert batch's 250 changed nothing while no test
	 * queued more than a handful.
	 *
	 * A full queue of removals clears across several runs instead, and M19.3's
	 * reconciliation is the backstop if it does not.
	 */
	public function test_removals_are_capped_per_run(): void {
		foreach ( range( 1, 60 ) as $id ) {
			$this->queue->push( $id, ProductQueue::ACTION_REMOVE );
		}

		$synced = $this->drainer()->drain();

		$this->assertSame( 20, $synced, 'one run sends at most the cap' );
		$this->assertCount( 20, $this->deletes );
		$this->assertSame( 40, $this->queue->count(), 'the rest wait for the next run' );
	}

	/** And the queue drains fully across runs rather than stalling. */
	public function test_a_large_removal_queue_clears_across_runs(): void {
		foreach ( range( 1, 45 ) as $id ) {
			$this->queue->push( $id, ProductQueue::ACTION_REMOVE );
		}

		$drainer = $this->drainer();

		$drainer->drain();
		$drainer->drain();
		$drainer->drain();

		$this->assertSame( 0, $this->queue->count() );
	}

	// --- Mixed ---------------------------------------------------------------

	public function test_upserts_and_removals_are_both_handled_in_one_run(): void {
		$this->product( 10 );
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );
		$this->queue->push( 20, ProductQueue::ACTION_REMOVE );

		$this->assertSame( 2, $this->drainer()->drain() );
		$this->assertCount( 1, $this->posts );
		$this->assertCount( 1, $this->deletes );
	}

	public function test_an_empty_queue_sends_nothing(): void {
		$this->assertSame( 0, $this->drainer()->drain() );
		$this->assertSame( array(), $this->posts );
		$this->assertSame( array(), $this->deletes );
	}

	// --- Connection state ----------------------------------------------------

	/**
	 * 🔴 The same guard `CataloguePusher` carries: a revoked credential retried
	 * every fifteen minutes opens the breaker that config sync and order
	 * reporting share.
	 */
	public function test_a_revoked_store_sends_nothing(): void {
		$this->product( 10 );
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::REVOKED, false );

		$this->assertSame( 0, $this->drainer()->drain() );
		$this->assertSame( array(), $this->posts );
		$this->assertSame( 1, $this->queue->count(), 'the queue survives for a reconnect' );
	}

	public function test_a_disconnected_store_sends_nothing(): void {
		$this->product( 10 );
		$this->queue->push( 10, ProductQueue::ACTION_UPSERT );

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::DISCONNECTED, false );

		$this->assertSame( 0, $this->drainer()->drain() );
		$this->assertSame( array(), $this->posts );
	}
}
