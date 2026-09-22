<?php
/**
 * Notices product changes and queues them for sync (M19.2).
 *
 * ## The hook queues; it never pushes
 *
 * `Reporting\OrderReporter`'s rule applies here unchanged: *"a cloud that
 * accepts connections and answers slowly still costs the customer that time"*.
 * The cost here lands on a **merchant pressing Update**, and on every bulk edit
 * -- a hundred products saved at once would be a hundred HTTP calls inside one
 * admin request, with the merchant watching a spinner.
 *
 * So each hook does one bounded thing: write an id and an intent to an option.
 * `CataloguePusher` does the network work on cron, where nothing is waiting.
 *
 * ## 🔴 Why WordPress's delete hooks, not WooCommerce's
 *
 * `woocommerce_trash_product` and `woocommerce_delete_product` look like the
 * obvious choice and are the wrong one: they fire **only** through
 * `WC_Product::delete()`, and the WordPress admin's own *Move to Trash* does
 * not use it. Measured against a running site:
 *
 * | Action | Hooks fired |
 * |---|---|
 * | `$product->delete( false )` | `woocommerce_trash_product` |
 * | `wp_trash_post()` -- **the admin's button** | `trashed_post` only |
 * | `wp_delete_post( $id, true )` | `before_delete_post` only |
 *
 * Listening to WooCommerce's alone would have missed the most common way a
 * merchant removes a product. `trashed_post` and `before_delete_post` fire on
 * **both** paths, because `WC_Product::delete()` calls them underneath.
 *
 * ⚠️ **They fire for every post type**, so each is filtered to `product`. A
 * page, a menu item or an order being deleted must not queue a product sync.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Catalogue;

defined( 'ABSPATH' ) || exit;

/**
 * Turns WooCommerce and WordPress product events into queue entries.
 */
final class ProductWatcher {

	/**
	 * The post type this watcher cares about.
	 */
	private const POST_TYPE = 'product';

	/**
	 * Products awaiting sync.
	 *
	 * @var ProductQueue
	 */
	private ProductQueue $queue;

	/**
	 * Constructor.
	 *
	 * @param ProductQueue $queue Products awaiting sync.
	 */
	public function __construct( ProductQueue $queue ) {
		$this->queue = $queue;
	}

	/**
	 * Attach to the product lifecycle.
	 */
	public function register(): void {
		/*
		 * Creation and update both mean "push it as it now stands". WooCommerce
		 * fires these with `( $id, $product )`; only the id is used, and the
		 * arity is declared so WordPress passes it.
		 */
		add_action( 'woocommerce_new_product', array( $this, 'on_saved' ), 10, 1 );
		add_action( 'woocommerce_update_product', array( $this, 'on_saved' ), 10, 1 );

		/*
		 * 📌 **A restore needs no hook of its own.** Measured: untrashing a
		 * product fires `woocommerce_update_product`, so it arrives above as an
		 * ordinary upsert. That is what makes removal safe rather than lossy
		 * (ADR-074).
		 */

		add_action( 'trashed_post', array( $this, 'on_removed' ), 10, 1 );
		add_action( 'before_delete_post', array( $this, 'on_removed' ), 10, 1 );
	}

	/**
	 * A product was created or changed.
	 *
	 * @param int $product_id WooCommerce product id.
	 */
	public function on_saved( $product_id ): void {
		$id = is_numeric( $product_id ) ? (int) $product_id : 0;

		if ( $id <= 0 ) {
			return;
		}

		$this->queue->push( $id, ProductQueue::ACTION_UPSERT );
	}

	/**
	 * A post was trashed or deleted.
	 *
	 * ⚠️ **Filtered by post type, because these hooks are WordPress's, not
	 * WooCommerce's.** They fire for every post type on the site, and an order
	 * or a page being deleted must not queue a product sync.
	 *
	 * 📌 **`before_delete_post` rather than `deleted_post`** for the permanent
	 * case: the post row still exists here, so `get_post_type()` can still
	 * answer. After deletion it cannot, and the filter would have nothing to
	 * read.
	 *
	 * @param int $post_id Post id.
	 */
	public function on_removed( $post_id ): void {
		$id = is_numeric( $post_id ) ? (int) $post_id : 0;

		if ( $id <= 0 ) {
			return;
		}

		if ( self::POST_TYPE !== get_post_type( $id ) ) {
			return;
		}

		$this->queue->push( $id, ProductQueue::ACTION_REMOVE );
	}
}
