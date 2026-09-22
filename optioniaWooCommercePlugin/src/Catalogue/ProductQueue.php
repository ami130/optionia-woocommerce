<?php
/**
 * Products awaiting incremental sync (M19.2).
 *
 * ## Why a queue, and not a push from the hook
 *
 * `Reporting\OrderQueue`'s rule applies here unchanged: *"a cloud that accepts
 * connections and answers slowly still costs the customer that time"*. The
 * cost here lands on a **merchant pressing Update**, and on every bulk edit --
 * a hundred products saved at once would be a hundred HTTP calls inside one
 * admin request.
 *
 * So the hook does one bounded thing: record an id and an intent. The network
 * happens on cron, where nothing is waiting on it.
 *
 * ## Keyed by product id, not appended
 *
 * A product edited five times before the next drain is **one** entry. An
 * append-only list would send it five times and leave the queue's length
 * tracking a merchant's typing speed rather than the work outstanding.
 *
 * 🔴 **And the newest intent wins without ordering logic.** Edit-then-delete
 * must end as a delete; delete-then-restore must end as an upsert. Keying by id
 * makes the last write the answer, where a list would need to reason about
 * which of two entries for one product came later.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Catalogue;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * The set of products whose state the cloud has not yet been told about.
 */
final class ProductQueue {

	/**
	 * The product should be pushed as it now stands.
	 */
	public const ACTION_UPSERT = 'upsert';

	/**
	 * The product should be removed from the mirror (ADR-074).
	 */
	public const ACTION_REMOVE = 'remove';

	/**
	 * The most products held before the oldest are dropped.
	 *
	 * ⚠️ **Not `OrderQueue`'s 500, and the difference is the point.** A dropped
	 * order is lost revenue data with no other source -- so that queue is sized
	 * to hold everything a busy shop can produce between drains. A dropped
	 * *product* is recoverable: M19.3's reconciliation rebuilds the mirror from
	 * the catalogue itself, so an overflow here is a **deferral**, not a loss.
	 *
	 * 200 covers an ordinary bulk edit -- a category retagged, a price rule
	 * applied -- while bounding one `wp_option` row. A merchant who edits more
	 * than that at once is doing something a full re-walk serves better anyway.
	 */
	public const MAX_ENTRIES = 200;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Record what should happen to a product.
	 *
	 * @param int    $product_id WooCommerce product id.
	 * @param string $action     One of the ACTION_* constants.
	 */
	public function push( int $product_id, string $action ): bool {
		if ( $product_id <= 0 ) {
			return false;
		}

		if ( self::ACTION_UPSERT !== $action && self::ACTION_REMOVE !== $action ) {
			return false;
		}

		$queue = $this->all();

		/*
		 * Overwrites rather than appends. Edit-then-delete ends as a delete, and
		 * delete-then-restore ends as an upsert, because the last write wins.
		 */
		$queue[ $product_id ] = $action;

		if ( count( $queue ) > self::MAX_ENTRIES ) {
			$dropped = count( $queue ) - self::MAX_ENTRIES;
			$queue   = array_slice( $queue, $dropped, null, true );

			/*
			 * ⚠️ Dropped from the **front**: the oldest entries are the ones most
			 * likely to have been superseded. Silently dropping the newest would
			 * discard the edit a merchant just made and is watching for.
			 *
			 * ✏️ **This said a reconciliation would find whatever is lost, and
			 * the 19-8 audit disproved it.** Reconciliation compares **ids** and
			 * **deletes**; its manifest carries no product data, so it can drop
			 * a mirror row the store no longer claims and cannot re-send an
			 * *upsert* this queue lost. A dropped `remove` does heal -- the id
			 * is simply absent from the next manifest -- but a dropped create or
			 * update leaves the mirror stale until a full walk.
			 *
			 * The repair is the merchant's **Sync catalogue** button, which is
			 * what `MAX_ENTRIES` already points at: *"a merchant who edits more
			 * than that at once is doing something a full re-walk serves better
			 * anyway."*
			 */
			$this->logger->warning(
				'Product sync queue is full; oldest entries dropped. Removals self-heal on the next reconciliation; edits need a catalogue re-sync.',
				array(
					'dropped' => $dropped,
					'kept'    => self::MAX_ENTRIES,
				)
			);
		}

		return $this->write( $queue );
	}

	/**
	 * Forget a product, once its state has reached the cloud.
	 *
	 * @param int $product_id WooCommerce product id.
	 */
	public function forget( int $product_id ): bool {
		$queue = $this->all();

		if ( ! isset( $queue[ $product_id ] ) ) {
			return false;
		}

		unset( $queue[ $product_id ] );

		return $this->write( $queue );
	}

	/**
	 * Everything outstanding, as `product id => action`.
	 *
	 * @return array<int, string>
	 */
	public function all(): array {
		$stored = get_option( Keys::OPTION_PRODUCT_QUEUE, array() );

		if ( ! is_array( $stored ) ) {
			return array();
		}

		$queue = array();

		foreach ( $stored as $product_id => $action ) {
			/*
			 * Read defensively: an option is writable through the database and
			 * survives downgrades, so a malformed entry is a real state. A bad
			 * one is skipped rather than throwing -- one corrupt row must not
			 * stop every other product syncing.
			 */
			$id = is_numeric( $product_id ) ? (int) $product_id : 0;

			if ( $id <= 0 || ! is_string( $action ) ) {
				continue;
			}

			if ( self::ACTION_UPSERT !== $action && self::ACTION_REMOVE !== $action ) {
				continue;
			}

			$queue[ $id ] = $action;
		}

		return $queue;
	}

	/**
	 * How many products are outstanding.
	 */
	public function count(): int {
		return count( $this->all() );
	}

	/**
	 * Empty the queue entirely.
	 *
	 * Used on disconnect: entries name a cloud this site is no longer talking
	 * to, and a reconnect to a different store would push one store's edits
	 * into another's mirror.
	 */
	public function clear(): bool {
		return delete_option( Keys::OPTION_PRODUCT_QUEUE );
	}

	/**
	 * Persist the queue.
	 *
	 * `false` for autoload: cron reads this and one admin row reports it, and
	 * the storefront never does. Autoloading would put it on every page load of
	 * the site for no reader.
	 *
	 * @param array<int, string> $queue The queue.
	 */
	private function write( array $queue ): bool {
		return update_option( Keys::OPTION_PRODUCT_QUEUE, $queue, false );
	}
}
