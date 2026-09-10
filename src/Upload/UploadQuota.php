<?php
/**
 * What bounds abuse of the upload endpoint (M15.2).
 *
 * ## Why the nonce is not this
 *
 * 🔴 **Measured on the running site: a guest nonce is identical for every
 * visitor.** For a logged-out shopper `wp_create_nonce()` reduces to *action +
 * tick* — `uid` is `0` and the session token is empty — so two separate calls
 * returned the same string, and `wp_verify_nonce()` accepts it for **24 hours**.
 *
 * An attacker therefore loads one product page, keeps the value, and uploads for
 * a day. The nonce stops a drive-by script that never loaded a page; it does not
 * identify a visitor and it cannot bound anything.
 *
 * ⚠️ **CSRF was the wrong threat model.** Nobody is tricked into uploading a file
 * to a shop. The real risk is **resource abuse** — filling a merchant's disk —
 * and that needs a per-visitor bound, which is what this class is.
 *
 * Recorded because a `permission_callback` that looks like a security control
 * and is not is worse than none: it stops the next reader asking the question.
 *
 * ## Why WooCommerce's session
 *
 * Verified available for guests on this site. It is the only per-visitor handle
 * a storefront has without asking a shopper to log in, and asking would refuse
 * the ordinary case: most customers check out as guests.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

defined( 'ABSPATH' ) || exit;

/**
 * Per-session upload limits.
 */
final class UploadQuota {

	/**
	 * Most files one session may hold unclaimed.
	 *
	 * Generous for a real order — a print job with twelve artwork files is
	 * plausible — and far below what makes disk exhaustion interesting.
	 */
	public const MAX_FILES = 20;

	/**
	 * Most bytes one session may hold unclaimed.
	 *
	 * ⚠️ **A separate limit from the per-file cap, because they fail
	 * differently.** Twenty files of the host's maximum each is a very different
	 * amount of disk from twenty small ones, and a per-file limit alone bounds
	 * neither.
	 */
	public const MAX_BYTES = 104857600; // 100 MB.

	/**
	 * What the session already holds.
	 *
	 * @var ReportsSessionUsage
	 */
	private ReportsSessionUsage $uploads;

	/**
	 * Build a quota over a usage reporter.
	 *
	 * ⚠️ Typed to the **interface**, not to `UploadRepository`: that class is
	 * `final`, and a quota needs only to read usage — it must not be able to
	 * create, claim or delete an upload.
	 *
	 * @param ReportsSessionUsage $uploads Usage reporter.
	 */
	public function __construct( ReportsSessionUsage $uploads ) {
		$this->uploads = $uploads;
	}

	/**
	 * The current visitor's session key, or an empty string.
	 *
	 * ⚠️ **An empty key means "cannot identify this visitor", and callers must
	 * refuse rather than proceed.** Sharing one bucket between unidentifiable
	 * visitors would make the quota a single global limit: one abuser would lock
	 * out every genuine customer on the store.
	 *
	 * WooCommerce creates the session lazily, so it is asked to start one — the
	 * customer is about to attach a file to a cart line, which is exactly when a
	 * session should exist.
	 */
	public function session_key(): string {
		if ( ! function_exists( 'WC' ) ) {
			return '';
		}

		$wc = WC();

		if ( ! is_object( $wc ) || ! isset( $wc->session ) || ! is_object( $wc->session ) ) {
			return '';
		}

		if ( method_exists( $wc->session, 'has_session' ) && ! $wc->session->has_session()
			&& method_exists( $wc->session, 'set_customer_session_cookie' ) ) {
			$wc->session->set_customer_session_cookie( true );
		}

		if ( ! method_exists( $wc->session, 'get_customer_id' ) ) {
			return '';
		}

		$id = $wc->session->get_customer_id();

		return is_scalar( $id ) ? (string) $id : '';
	}

	/**
	 * Whether this session may store one more file of this size.
	 *
	 * Both limits are checked against what the session *already* holds plus the
	 * incoming file, so the caller cannot be told "yes" and then exceed the
	 * ceiling by the size of the file it just asked about.
	 *
	 * @param string $session_key The visitor's session.
	 * @param int    $size_bytes  The incoming file's size.
	 */
	public function allows( string $session_key, int $size_bytes ): bool {
		if ( '' === $session_key || $size_bytes <= 0 ) {
			return false;
		}

		$usage = $this->uploads->session_usage( $session_key );

		if ( $usage['count'] + 1 > self::MAX_FILES ) {
			return false;
		}

		return $usage['bytes'] + $size_bytes <= self::MAX_BYTES;
	}
}
