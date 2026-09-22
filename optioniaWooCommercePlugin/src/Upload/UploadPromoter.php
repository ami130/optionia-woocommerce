<?php
/**
 * Makes a customer's uploads permanent when their order is created (M15.4).
 *
 * ## The gap this closes
 *
 * 🔴 **`UploadRepository::claim()` existed with no callers.** Every upload's life
 * was: stored → row with `expires_at` at +72 hours → **nothing**. It was never
 * promoted at checkout, never expired, and skipped by `UploadSweeper` because it
 * *has* a row. Every file uploaded was stranded, and a merchant's print-ready
 * artwork would have been deleted three days after the order it belongs to.
 *
 * Promotion is the single transition that whole lifecycle turns on: clearing
 * `expires_at` is what "permanent" *is*, because cleanup reads that column.
 *
 * ## Why this hook, and why the fourth argument
 *
 * `woocommerce_checkout_create_order_line_item` fires once per line and covers
 * **both** checkout worlds — the Store API delegates to
 * `wc()->checkout->create_order_line_items()`, the same method the classic
 * checkout uses, so one listener serves both. `Integration\OrderLineItem`
 * already relies on that and it holds here.
 *
 * 🔴 **The order id comes from the hook's fourth argument, never from the item.**
 * Measured on the running site: at this hook `$item->get_order_id()` is **0**
 * while the `$order` argument carries the real id. Claiming against zero would
 * write `order_id = 0` — a row that looks promoted, is attached to nothing, and
 * whose file is now immortal because `expires_at` was cleared.
 *
 * ⚠️ **A failed claim never fails the order.** WooCommerce owns the transaction
 * (AC6): a customer who has paid must not see checkout break because a file row
 * could not be updated. The failure is logged at **error** level, and the worst
 * case is a file that expires — recoverable by asking the customer, unlike a
 * lost sale.
 *
 * ## Re-ordering, and why a refused claim is the safe answer
 *
 * 🔴 **A second order could steal the first order's file.** `claim()` matched on
 * the token alone, so ordering twice with one token left `order_id` at the
 * second order — measured. `OrderAgain` replays a line's selections verbatim,
 * token included, so an ordinary re-order silently stripped the artwork from an
 * order already in production.
 *
 * `UploadRepository::claim()` now refuses a row another order owns, and returns
 * three outcomes rather than a boolean so a replayed hook (same order, already
 * claimed) is not mistaken for that theft. The re-ordering customer's line has
 * no artwork, which is the honest answer, and it is logged as an error instead
 * of passing unnoticed.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Claims a line's uploaded files for the order being created.
 */
final class UploadPromoter {

	/**
	 * The hook both checkout worlds fire, once per line.
	 */
	public const HOOK = 'woocommerce_checkout_create_order_line_item';

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build the promoter over the repository and the logger.
	 *
	 * @param UploadRepository $uploads Upload table.
	 * @param Logger           $logger  Logger.
	 */
	public function __construct( UploadRepository $uploads, Logger $logger ) {
		$this->uploads = $uploads;
		$this->logger  = $logger;
	}

	/**
	 * Register the checkout listener.
	 *
	 * Priority 20, after `Integration\OrderLineItem` at 10: that writes the
	 * selections onto the item, and this reads the same selections. Ordering
	 * them makes the dependency explicit rather than incidental.
	 */
	public function register(): void {
		add_action( self::HOOK, array( $this, 'promote' ), 20, 4 );
	}

	/**
	 * Claim every upload this line refers to.
	 *
	 * @param mixed $item          The order line item; unused.
	 * @param mixed $cart_item_key The cart item key; unused.
	 * @param mixed $values        The cart item, carrying Optionia's payload.
	 * @param mixed $order         The order being created.
	 */
	public function promote( $item = null, $cart_item_key = null, $values = null, $order = null ): void {
		unset( $item, $cart_item_key );

		$order_id = $this->order_id( $order );

		if ( 0 === $order_id ) {
			/*
			 * No order to attach to. Claiming against zero would clear
			 * `expires_at` on a row belonging to nothing — a file nothing can
			 * find and nothing will ever delete.
			 */
			return;
		}

		foreach ( $this->tokens_in( $values ) as $token ) {
			$outcome = $this->uploads->claim( $token, $order_id );

			if ( UploadRepository::CLAIM_CLAIMED === $outcome ) {
				continue;
			}

			if ( UploadRepository::CLAIM_ALREADY_OURS === $outcome ) {
				/*
				 * This order already owns the row. WooCommerce can fire the
				 * line-item hook more than once for one order, and a re-run must
				 * not look like a failure.
				 */
				continue;
			}

			if ( UploadRepository::CLAIM_ERROR === $outcome ) {
				/*
				 * 🔴 **The database refused, so nothing is known yet.** The row
				 * still exists with its `expires_at` intact, which means cleanup
				 * would delete a paid order's artwork three days later unless
				 * something stops it.
				 *
				 * That guard lives in `UploadSweeper`, not here: `OrderLineItem`
				 * writes the token into `_optionia_selections` at priority 10,
				 * inside WooCommerce's own transaction, so the order records
				 * which files are its own even when this claim at priority 20
				 * fails. Expiry consults that record before deleting anything.
				 *
				 * Distinguished from a conflict because the causes are opposite:
				 * this one is transient and the operator can fix it, and a
				 * merchant who cannot tell the two apart will treat both as
				 * noise.
				 */
				$this->logger->error(
					'The database refused to claim an uploaded file; the order keeps its own record of it.',
					array( 'order_id' => $order_id )
				);

				continue;
			}

			/*
			 * 🔴 **Errored, not warned.** The row is gone or another order owns
			 * it, so this line's artwork is missing *and* nothing downstream will
			 * notice: the order saves, the customer pays, and the merchant finds
			 * out at print time.
			 *
			 * The commonest cause is a re-order — `OrderAgain` replays the
			 * original line's token, which still points at the first order's
			 * file. Refusing that claim is what stops the first order losing its
			 * artwork; saying so here is what stops the second order failing
			 * silently. ADR-040: it must fail loudly.
			 */
			$this->logger->error(
				'An uploaded file could not be claimed; this order line has no artwork.',
				array(
					'order_id' => $order_id,
					'reason'   => $outcome,
				)
			);
		}
	}

	/**
	 * The order's id, or zero.
	 *
	 * ⚠️ **From the `$order` argument only.** The item's own `get_order_id()`
	 * answers 0 at this hook — measured — because the item has not been added to
	 * the order yet.
	 *
	 * @param mixed $order The hook's fourth argument.
	 */
	private function order_id( $order ): int {
		if ( ! is_object( $order ) || ! method_exists( $order, 'get_id' ) ) {
			return 0;
		}

		$id = $order->get_id();

		return is_numeric( $id ) ? (int) $id : 0;
	}

	/**
	 * Upload tokens carried by one cart line.
	 *
	 * ⚠️ **Shape-checked, not type-checked.** The resolver stores a file's token
	 * as an ordinary scalar selection, so nothing in the payload marks it as a
	 * file. A token is 64 hex characters from `random_bytes(32)`; matching that
	 * shape is what distinguishes one from a colour swatch's `red`.
	 *
	 * A value that merely *looks* like a token but is not in the table simply
	 * fails to claim, which is logged — so the cost of a false positive is a log
	 * line, and the cost of a false negative would be a deleted file.
	 *
	 * @param mixed $values The cart item.
	 * @return array<int, string>
	 */
	private function tokens_in( $values ): array {
		$optionia = is_array( $values ) ? ( $values[ Keys::CART_ITEM_KEY ] ?? null ) : null;

		if ( ! is_array( $optionia ) ) {
			return array();
		}

		return array_values( UploadTokens::in_selections( $optionia[ Keys::CART_ITEM_SELECTIONS ] ?? null ) );
	}
}
