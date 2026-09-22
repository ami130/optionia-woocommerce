<?php
/**
 * Noticing product changes (M19.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Catalogue\ProductQueue;
use Optionia\Catalogue\ProductWatcher;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Turning product events into queue entries.
 *
 * @covers \Optionia\Catalogue\ProductWatcher
 */
final class ProductWatcherTest extends TestCase {

	/**
	 * Products awaiting sync.
	 *
	 * @var ProductQueue
	 */
	private ProductQueue $queue;

	/**
	 * Subject.
	 *
	 * @var ProductWatcher
	 */
	private ProductWatcher $watcher;

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_autoload']   = array();
		$GLOBALS['optionia_test_post_types'] = array();

		$this->queue   = new ProductQueue( new Logger( new Settings() ) );
		$this->watcher = new ProductWatcher( $this->queue );
	}

	// --- Saving --------------------------------------------------------------

	public function test_a_new_product_is_queued_for_upsert(): void {
		$this->watcher->on_saved( 42 );

		$this->assertSame( array( 42 => ProductQueue::ACTION_UPSERT ), $this->queue->all() );
	}

	/**
	 * 📌 **A restore needs no hook of its own.** Measured against a running
	 * site: untrashing a product fires `woocommerce_update_product`, so it
	 * arrives as an ordinary upsert — which is what makes removal safe rather
	 * than lossy (ADR-074).
	 */
	public function test_a_restore_arrives_as_an_upsert_and_replaces_a_removal(): void {
		$this->watcher->on_removed( 42 );
		$GLOBALS['optionia_test_post_types'][42] = 'product';

		$this->watcher->on_saved( 42 );

		$this->assertSame( array( 42 => ProductQueue::ACTION_UPSERT ), $this->queue->all() );
	}

	public function test_a_non_numeric_id_is_ignored(): void {
		$this->watcher->on_saved( 'nonsense' );

		$this->assertSame( array(), $this->queue->all() );
	}

	// --- Removal -------------------------------------------------------------

	public function test_a_trashed_product_is_queued_for_removal(): void {
		$GLOBALS['optionia_test_post_types'][42] = 'product';

		$this->watcher->on_removed( 42 );

		$this->assertSame( array( 42 => ProductQueue::ACTION_REMOVE ), $this->queue->all() );
	}

	/**
	 * 🔴 **The filter that stops unrelated deletions queueing a sync.**
	 * `trashed_post` and `before_delete_post` are **WordPress's** hooks and fire
	 * for every post type — a page, a menu item, an order. They are used rather
	 * than WooCommerce's because `woocommerce_trash_product` fires only through
	 * `WC_Product::delete()`, and the admin's *Move to Trash* does not use it;
	 * measured, that path fires `trashed_post` alone.
	 */
	public function test_deleting_a_page_does_not_queue_a_product(): void {
		$GLOBALS['optionia_test_post_types'][42] = 'page';

		$this->watcher->on_removed( 42 );

		$this->assertSame( array(), $this->queue->all() );
	}

	public function test_deleting_an_order_does_not_queue_a_product(): void {
		$GLOBALS['optionia_test_post_types'][42] = 'shop_order';

		$this->watcher->on_removed( 42 );

		$this->assertSame( array(), $this->queue->all() );
	}

	/** A variation is not a product the mirror holds; its parent is. */
	public function test_deleting_a_variation_does_not_queue_a_product(): void {
		$GLOBALS['optionia_test_post_types'][42] = 'product_variation';

		$this->watcher->on_removed( 42 );

		$this->assertSame( array(), $this->queue->all() );
	}

	// --- Ordering ------------------------------------------------------------

	/**
	 * Edit-then-delete must end as a delete. The queue keys by id, so the last
	 * write wins without the watcher reasoning about order.
	 */
	public function test_editing_then_deleting_ends_as_a_removal(): void {
		$GLOBALS['optionia_test_post_types'][42] = 'product';

		$this->watcher->on_saved( 42 );
		$this->watcher->on_removed( 42 );

		$this->assertSame( array( 42 => ProductQueue::ACTION_REMOVE ), $this->queue->all() );
	}

	/** Several products each get their own entry. */
	public function test_several_products_are_queued_independently(): void {
		$GLOBALS['optionia_test_post_types'][20] = 'product';

		$this->watcher->on_saved( 10 );
		$this->watcher->on_removed( 20 );
		$this->watcher->on_saved( 30 );

		$this->assertSame(
			array(
				10 => ProductQueue::ACTION_UPSERT,
				20 => ProductQueue::ACTION_REMOVE,
				30 => ProductQueue::ACTION_UPSERT,
			),
			$this->queue->all()
		);
	}

	// --- Registration --------------------------------------------------------

	/**
	 * ⚠️ **The four hooks are the feature.** A watcher that registers none is a
	 * class that exists and does nothing — the shape `check-architecture`'s
	 * hook gate was written for after three features shipped unwired.
	 */
	public function test_it_registers_the_lifecycle_hooks(): void {
		$GLOBALS['optionia_test_actions'] = array();

		$this->watcher->register();

		$registered = array_keys( $GLOBALS['optionia_test_actions'] ?? array() );

		$this->assertContains( 'woocommerce_new_product', $registered );
		$this->assertContains( 'woocommerce_update_product', $registered );
		$this->assertContains( 'trashed_post', $registered );
		$this->assertContains( 'before_delete_post', $registered );
	}
}
