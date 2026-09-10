<?php
/**
 * Releases an order's files when the order itself is deleted (M15.4, Stage 4e).
 *
 * ## The leak this closes
 *
 * 🔴 **A promoted file was unreachable by every cleanup path.** Nothing ever
 * resets `order_id` once a claim lands, and the two mechanisms that delete files
 * both decline to touch such a row:
 *
 * ```text
 * UploadExpirer   WHERE order_id IS NULL ...   -> skips it, it has an order
 * UploadSweeper   SELECT stored_name FROM ...  -> protects it, the table knows the name
 * ```
 *
 * So deleting or trashing an order left its artwork on the merchant's disk
 * forever. That is a storage leak invisible until a disk fills, and it is also
 * why Phase 26b had no deletion path to build a GDPR mechanism on: *"Phase 15
 * makes deletion possible"* was not yet true.
 *
 * ## Why this hook, and not the obvious one
 *
 * ⚠️ **`woocommerce_before_delete_order`, never `woocommerce_delete_order`.**
 * The latter fires *after* `delete_items()` has run, so the line items — and with
 * them `_optionia_selections`, the only record of which tokens the order held —
 * are already gone. Measured in WooCommerce 11.0.1: `OrdersTableDataStore::delete()`
 * calls `delete_items()` at line 2637 and fires `woocommerce_delete_order` at
 * 2668. By then there is nothing left to read.
 *
 * `woocommerce_before_delete_order` fires at 2632 with the `$order` object still
 * whole, and **both** data stores fire it — `OrdersTableDataStore` under HPOS and
 * `abstract-wc-order-data-store-cpt.php` without it — so one registration covers
 * both worlds.
 *
 * ## Trashing is not deleting
 *
 * 🔴 **`woocommerce_trash_order` is deliberately not listened to.** A trashed
 * order keeps its items and can be restored; deleting its artwork would turn a
 * reversible action into an irreversible one, and a merchant who trashes an order
 * by accident would lose the customer's print file with it. Files go only when
 * the order goes for good.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Deletes the files an order owned, when that order is permanently deleted.
 */
final class UploadRetention {

	/**
	 * The hook both order data stores fire before deleting.
	 */
	public const HOOK = 'woocommerce_before_delete_order';

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Protected storage.
	 *
	 * @var UploadStore
	 */
	private UploadStore $store;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build over the table, storage and the logger.
	 *
	 * @param UploadRepository $uploads Upload table.
	 * @param UploadStore      $store   Protected storage.
	 * @param Logger           $logger  Logger.
	 */
	public function __construct( UploadRepository $uploads, UploadStore $store, Logger $logger ) {
		$this->uploads = $uploads;
		$this->store   = $store;
		$this->logger  = $logger;
	}

	/**
	 * Listen for permanent deletion.
	 *
	 * Registered outside `is_admin()`: an order can be deleted by WP-CLI, by a
	 * scheduled cleanup, or through the REST API, and an admin-only registration
	 * would leak on exactly the paths a merchant never watches.
	 */
	public function register(): void {
		add_action( self::HOOK, array( $this, 'release' ), 10, 2 );
	}

	/**
	 * Delete every file the order being deleted owned.
	 *
	 * @param mixed $order_id The order's id, as the hook supplies it.
	 * @param mixed $order    The order about to be deleted.
	 */
	public function release( $order_id = null, $order = null ): void {
		$id = $this->id_of( $order, $order_id );

		if ( 0 === $id ) {
			/*
			 * Without an id there is no way to prove a row belongs to *this*
			 * order, and the check below is the whole protection against
			 * deleting another order's artwork.
			 */
			return;
		}

		$tokens = $this->tokens_of( $order );

		if ( array() === $tokens ) {
			return;
		}

		$directory = $this->store->directory();
		$released  = 0;

		foreach ( $tokens as $token ) {
			$row = $this->uploads->find( $token );

			if ( null === $row ) {
				continue;
			}

			if ( ! $this->belongs_to( $row, $id ) ) {
				/*
				 * 🔴 **Another order owns this file.** Reachable on data written
				 * before Stage 4d, when `OrderAgain` replayed a token into a new
				 * order and nothing refused it — two orders could carry the same
				 * token in their meta. Deleting the *reorder* would then destroy
				 * the *original* order's artwork, which is the opposite of what
				 * this class is for.
				 *
				 * Newer data cannot reach this: `claim()` only takes a row with
				 * `order_id IS NULL` and `UploadTokenCheck` refuses an
				 * already-claimed token at add-to-cart. The guard exists for the
				 * stores that were already running before those did.
				 */
				$this->logger->warning(
					'Kept an uploaded file that another order owns.',
					array( 'order_id' => $id )
				);

				continue;
			}

			$name = isset( $row['stored_name'] ) ? (string) $row['stored_name'] : '';

			/*
			 * The file goes before the row, the same order `UploadExpirer` uses
			 * and for the same reason: a deleted row with a surviving file is an
			 * orphan nothing can find, because every cleanup path reads the
			 * table.
			 */
			if ( '' !== $name && '' !== $directory ) {
				wp_delete_file( $directory . '/' . $name );
			}

			if ( $this->uploads->delete( $token ) ) {
				++$released;
			}
		}

		if ( $released > 0 ) {
			$this->logger->info(
				'Released uploaded files belonging to a deleted order.',
				array( 'released' => $released )
			);
		}
	}

	/**
	 * The id of the order being deleted.
	 *
	 * ⚠️ **The object first, the argument second.** Both data stores pass an id
	 * alongside the order, but `UploadPromoter` had to learn the hard way that a
	 * hook's id argument is not always the one that matters — there, the item's
	 * own `get_order_id()` answered 0. Preferring the object and falling back to
	 * the argument keeps this correct whichever the caller supplies.
	 *
	 * @param mixed $order    The order about to be deleted.
	 * @param mixed $order_id The id the hook supplied.
	 */
	private function id_of( $order, $order_id ): int {
		if ( is_object( $order ) && method_exists( $order, 'get_id' ) ) {
			$id = $order->get_id();

			if ( is_numeric( $id ) && (int) $id > 0 ) {
				return (int) $id;
			}
		}

		return is_numeric( $order_id ) ? max( 0, (int) $order_id ) : 0;
	}

	/**
	 * Whether an upload row may be released by this order.
	 *
	 * ⚠️ **An unclaimed row still counts as this order's.** A file whose
	 * promotion failed — `UploadRepository::CLAIM_ERROR` at checkout — keeps
	 * `order_id` null while the order plainly refers to it in its own meta.
	 * Requiring a match outright would leave exactly those files behind, which
	 * is the leak this class was written to close.
	 *
	 * @param array<string, mixed> $row The upload row.
	 * @param int                  $id  The order being deleted.
	 */
	private function belongs_to( array $row, int $id ): bool {
		$owner = $row['order_id'] ?? null;

		if ( null === $owner || '' === $owner ) {
			return true;
		}

		return is_numeric( $owner ) && (int) $owner === $id;
	}

	/**
	 * The upload tokens an order's lines refer to.
	 *
	 * ⚠️ **Read from the order's own items**, which is why this must run before
	 * `delete_items()`. Reading the upload table by `order_id` instead would look
	 * simpler and would miss any file whose promotion failed — the row would
	 * still say `order_id IS NULL` while the order plainly refers to it.
	 *
	 * @param mixed $order The order about to be deleted.
	 * @return array<int, string>
	 */
	private function tokens_of( $order ): array {
		return UploadTokens::in_order( $order );
	}
}
