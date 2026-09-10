<?php
/**
 * Signs and verifies the download link that goes in an order email (M15.5, 5d).
 *
 * ## Why a signature and not a nonce
 *
 * 🔴 **A WordPress nonce cannot secure an emailed link.** It is bound to the
 * reader's user id and session token, which is right for a link on a screen they
 * are already logged into and useless in an inbox opened tomorrow, in another
 * browser. And `Support\Keys` records the measured weakness that decides it: for
 * a **logged-out** reader `wp_create_nonce()` reduces to *action + tick*,
 * identical for every visitor and valid 24 hours. An email recipient is logged
 * out until they follow the link.
 *
 * So the link carries its own proof: a `wp_hash()` signature over the order, the
 * expiry, and the purpose.
 *
 * ## What the signature covers, and why each part is in it
 *
 * ```text
 * optionia-order-files|<order id>|<expires at>
 * ```
 *
 * - **The order**, so a link for order 64 cannot be replayed as order 65 by
 *   editing the URL. Without it one valid link would open every order.
 * - **The expiry**, so the deadline cannot be pushed out by editing the
 *   timestamp — the signature is checked *before* the clock, and a changed
 *   timestamp simply fails to verify.
 * - **A purpose string**, so a signature minted here can never be presented to
 *   some future feature that signs the same numbers for a different reason.
 *
 * ⚠️ **`wp_hash()`, not the store token.** The reasoning `Integration\CartItemPayload`
 * records applies unchanged: the cloud credential is deleted on disconnect, so
 * every link in every merchant's inbox would break at once on a store that can
 * still be selling. `wp_hash()` is WordPress's own keyed hash over `wp_salt()` —
 * always present, unrelated to the connection, and rotated only when a site owner
 * rotates their salts.
 *
 * ## Seven days
 *
 * Long enough to survive a weekend and a fulfilment backlog; short enough that a
 * forwarded or archived email stops working within a week. Past about three days
 * the file may be gone regardless — `UploadRepository::ORPHAN_TTL` releases an
 * unpromoted upload after 72 hours — so a longer window mostly extends the life
 * of a link to something that no longer exists.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Mints and checks time-bounded links to an order's files.
 */
final class UploadLink {

	/**
	 * How long a link stays valid, in seconds.
	 */
	public const LIFETIME = 604800; // 7 days.

	/**
	 * What the signature is *for*.
	 *
	 * Part of the signed material so a signature minted for this can never be
	 * accepted by a different feature that happens to sign the same numbers.
	 */
	private const PURPOSE = 'optionia-order-files';

	/**
	 * A signed, expiring URL for one order's files.
	 *
	 * @param int $order_id The order whose files the link opens.
	 * @return string An absolute URL, or '' when the order id is unusable.
	 */
	public function url( int $order_id ): string {
		if ( $order_id <= 0 ) {
			return '';
		}

		$expires = time() + self::LIFETIME;

		return add_query_arg(
			array(
				Keys::ARG_DOWNLOAD_ORDER     => $order_id,
				Keys::ARG_DOWNLOAD_EXPIRES   => $expires,
				Keys::ARG_DOWNLOAD_SIGNATURE => $this->sign( $order_id, $expires ),
			),
			admin_url( 'admin.php' )
		);
	}

	/**
	 * Whether a request carries a signature this class minted, still in date.
	 *
	 * ⚠️ **Signature first, clock second.** The expiry is part of the signed
	 * material, so checking the clock on an unverified timestamp would be
	 * checking a number the caller chose.
	 *
	 * @param int    $order_id  The order being asked for.
	 * @param int    $expires   The expiry the link claims.
	 * @param string $signature The signature the link carries.
	 */
	public function verify( int $order_id, int $expires, string $signature ): bool {
		if ( $order_id <= 0 || '' === $signature ) {
			return false;
		}

		/*
		 * `hash_equals()`, never `===`: a byte-by-byte comparison leaks where two
		 * strings first differ, and that is enough to reconstruct a signature one
		 * character at a time.
		 */
		if ( ! hash_equals( $this->sign( $order_id, $expires ), $signature ) ) {
			return false;
		}

		return $expires > time();
	}

	/**
	 * The signature for one order and expiry.
	 *
	 * @param int $order_id The order.
	 * @param int $expires  When the link stops working.
	 */
	private function sign( int $order_id, int $expires ): string {
		return wp_hash( self::PURPOSE . '|' . $order_id . '|' . $expires );
	}
}
