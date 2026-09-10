<?php
/**
 * Releases the files of carts that were abandoned (M15.4, Stage 4c).
 *
 * ## The gap this closes
 *
 * 🔴 **`UploadRepository::expired()` existed with no callers.** An *ordered* file
 * is promoted by `UploadPromoter` and made permanent, but an abandoned one was
 * never released: stored → row with `expires_at` at +72 hours → **nothing**.
 * `UploadSweeper` skips it, because the sweeper deletes files that have *no* row
 * and this one has a row. Every file from an abandoned cart stayed on the
 * merchant's disk forever.
 *
 * That is this class's whole job, and it is the mirror image of the sweeper:
 * the sweeper removes files whose row is missing, this removes rows whose
 * deadline has passed.
 *
 * ## The order of deletion is the design
 *
 * 🔴 **File first, then the row** — the order `expired()`'s docblock requires.
 * A deleted row with a surviving file is an orphan nothing can find: cleanup
 * reads the table, so the file becomes invisible to every mechanism that might
 * have removed it. The reverse failure is harmless by comparison — a row whose
 * file is already gone is found again on the next pass and removed then.
 *
 * ## Why an order is consulted before anything is deleted
 *
 * ⚠️ **`expires_at` is not trusted on its own.** Promotion clears it, so in
 * theory a row that still carries one belongs to no order. In practice a claim
 * can fail — the database can refuse the statement at exactly the wrong moment
 * (`UploadRepository::CLAIM_ERROR`) — and the row is then left looking abandoned
 * while the customer has paid for it.
 *
 * `Integration\OrderLineItem` writes the line's selections, tokens included, into
 * `_optionia_selections` at priority 10, inside WooCommerce's own transaction,
 * before `UploadPromoter` attempts any claim at priority 20. So the order carries
 * an independent record of which files are its own, and this asks that record
 * before deleting anything. A file a real order refers to is never deleted,
 * whatever the upload row says.
 *
 * ⚠️ **And it is repaired, not merely spared.** Such a row is claimed to the
 * order that refers to it — the promotion that should have happened at checkout.
 * Skipping it instead would leave `expires_at` in the past forever, and
 * `expired()` orders by that column ascending, so the row would return at the
 * front of every hourly batch: re-scanned, re-reported, and eventually filling
 * the batch entirely so that genuinely abandoned files were never reached.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Deletes the files of expired, unclaimed uploads.
 */
final class UploadExpirer {

	/**
	 * Most rows to release in one pass.
	 *
	 * Matches `UploadSweeper::BATCH`: both run on a customer's request through
	 * cron, and neither may turn a page load into a bulk delete.
	 */
	public const BATCH = 200;

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
	 * Build the expirer over the table, storage and the logger.
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
	 * Release every upload whose deadline has passed.
	 *
	 * @return int How many rows were released.
	 */
	public function expire(): int {
		$rows = $this->uploads->expired( self::BATCH );

		if ( array() === $rows ) {
			return 0;
		}

		$directory = $this->store->directory();
		$released  = 0;
		$spared    = 0;
		$repaired  = 0;

		foreach ( $rows as $row ) {
			$token = isset( $row['token'] ) ? (string) $row['token'] : '';
			$name  = isset( $row['stored_name'] ) ? (string) $row['stored_name'] : '';

			if ( '' === $token || '' === $name ) {
				// A row this malformed cannot be acted on safely.
				continue;
			}

			$owner = $this->order_referring_to( $token );

			if ( $owner > 0 ) {
				/*
				 * 🔴 **A paid order's artwork, whose claim did not land.** The
				 * row looks abandoned and is not.
				 *
				 * ⚠️ **Repaired, not merely spared.** Skipping it would leave
				 * `expires_at` in the past forever, and `expired()` orders by
				 * that column ascending — so the row would return at the *front*
				 * of every hourly batch, re-scanned and re-reported for the life
				 * of the store. Enough of them would fill `BATCH` permanently
				 * and the genuinely abandoned files behind them would never be
				 * reached, silently disabling the cleanup this class exists to
				 * perform.
				 *
				 * Claiming the row is the repair the situation actually calls
				 * for: it is what the failed promotion should have done, it
				 * clears `expires_at`, and the row leaves this query for good.
				 */
				if ( UploadRepository::CLAIM_CLAIMED === $this->uploads->claim( $token, $owner ) ) {
					++$repaired;

					continue;
				}

				/*
				 * The repair itself failed — the database is refusing writes, or
				 * the row changed underneath. Leave the file alone: it belongs
				 * to an order either way, and deleting it is the one outcome
				 * that cannot be undone.
				 */
				++$spared;

				continue;
			}

			/*
			 * The file goes first. `wp_delete_file()` is silent about a file
			 * that is already gone, which is the case worth tolerating: the row
			 * should still be removed, or this pass would return the same row
			 * forever.
			 */
			if ( '' !== $directory ) {
				wp_delete_file( $directory . '/' . $name );
			}

			if ( $this->uploads->delete( $token ) ) {
				++$released;
			}
		}

		if ( $released > 0 ) {
			$this->logger->info(
				'Released expired uploads from abandoned carts.',
				array( 'released' => $released )
			);
		}

		if ( $repaired > 0 ) {
			/*
			 * Error, not info: the file is safe now, but it reached this point
			 * only because promotion failed at checkout, and that is worth a
			 * merchant's attention even though cleanup recovered from it.
			 */
			$this->logger->error(
				'Expired uploads were still referenced by an order; promotion had failed and they were claimed here.',
				array( 'repaired' => $repaired )
			);
		}

		if ( $spared > 0 ) {
			$this->logger->error(
				'Expired uploads are referenced by an order but could not be claimed; they were kept, not deleted.',
				array( 'kept' => $spared )
			);
		}

		return $released;
	}

	/**
	 * The order whose line refers to this token, or zero.
	 *
	 * ⚠️ **Read from order item meta, not the upload row.** The upload row is
	 * the thing under suspicion here — the whole point is to catch a row that
	 * *says* it is unclaimed when an order says otherwise.
	 *
	 * ⚠️ **`woocommerce_order_itemmeta` is correct under HPOS too.** HPOS moves
	 * orders out of the posts tables and leaves line-item meta where it is, as
	 * `Integration\OrderLineItem` records.
	 *
	 * @param string $token The token to look for.
	 */
	private function order_referring_to( string $token ): int {
		global $wpdb;

		if ( ! UploadTokens::is_token( $token ) ) {
			/*
			 * Not a token shape. Refuse rather than build a LIKE from it: the
			 * value would still be bound, but a pattern that matches broadly
			 * could match rows it should not, and claiming a file to the wrong
			 * order is worse than leaking one.
			 */
			return 0;
		}

		$meta  = $wpdb->prefix . 'woocommerce_order_itemmeta';
		$items = $wpdb->prefix . 'woocommerce_order_items';

		/*
		 * A substring match on the JSON, because the token is one *value* in a
		 * map of option id to selection and its key is a uuid this class does
		 * not know. The token is 64 hex characters from `random_bytes(32)`, so
		 * a substring match on it is exact in practice.
		 *
		 * ⚠️ **A leading wildcard cannot use an index**, so this reads the
		 * meta table. Three things keep the cost bounded, and they are the
		 * reason this is acceptable on a cron pass that runs on a customer's
		 * request:
		 *
		 * 1. `meta_key` narrows to Optionia's own rows before the `LIKE` is
		 *    evaluated — on a store with one file option that is a small
		 *    fraction of `order_itemmeta`.
		 * 2. It runs **only for rows that actually expired**, which on a healthy
		 *    store is nearly none.
		 * 3. A row it finds is *claimed*, so it is asked about **once**. Before
		 *    that repair existed, the same rows were re-scanned every hour for
		 *    the life of the store.
		 *
		 * `esc_like()` before binding: the token is hex and carries no wildcard
		 * today, but building a LIKE without it is the habit that breaks the
		 * day the format changes.
		 */
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- a lifecycle job, and a cached answer would delete a live file.
		$order_id = $wpdb->get_var(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- identifiers, not values; see UploadRepository.
			$wpdb->prepare(
				"SELECT i.order_id
				   FROM `{$meta}` m
				   INNER JOIN `{$items}` i ON i.order_item_id = m.order_item_id
				  WHERE m.meta_key = %s
				    AND m.meta_value LIKE %s
				    AND i.order_item_type = %s
				  LIMIT 1",
				Keys::META_SELECTIONS,
				'%' . $wpdb->esc_like( $token ) . '%',
				'line_item'
			)
			// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		return is_numeric( $order_id ) ? (int) $order_id : 0;
	}
}
