<?php
/**
 * Tells a merchant their file storage is full (M15.6).
 *
 * The cloud sells `file_storage_mb` and **cannot enforce it**: a customer's file
 * is written to this server and never reaches the cloud. So the cloud sends its
 * verdict on the heartbeat, `Upload\UploadEndpoint` refuses on it, and this is
 * how the merchant finds out.
 *
 * ## Why the merchant is told and the customer is not
 *
 * 🔴 **`UploadEndpoint::refused()` returns one shape for every reason**, on the
 * reasoning that *"a caller that learns which ceiling it hit can map them"* —
 * size, type and quota are deliberately indistinguishable from outside. That is
 * a security property and this notice does not weaken it.
 *
 * ⚠️ **But a refusal nobody can explain is worse than the limit.** A shopper
 * sees "upload failed" and leaves; the merchant sees nothing at all and cannot
 * connect a lost sale to an allowance. The person who can act on this is the
 * merchant, so the merchant is the one told — plainly, and where they work.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Connection\Heartbeat;

defined( 'ABSPATH' ) || exit;

/**
 * An admin notice for a store whose plan storage is used up.
 */
final class StorageNotice {

	/**
	 * Register the notice.
	 */
	public function register(): void {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Show the notice when — and only when — uploads are being refused.
	 */
	public function render(): void {
		if ( ! Request::user_can_manage() ) {
			return;
		}

		/*
		 * 📌 **Only an explicit refusal shows this.** No heartbeat yet, or one
		 * from a cloud older than M15.6, answers *allowed* — and a notice on
		 * that would tell a merchant their uploads are paused when they are not.
		 */
		if ( Heartbeat::uploads_allowed() ) {
			return;
		}

		/**
		 * Warning, not error, and it says what is still working.
		 *
		 * ⚠️ **The rest of the shop is unaffected**, and a merchant who reads
		 * only "storage full" assumes it is not. Every option that is not a file
		 * upload keeps selling exactly as before, which is the first thing to
		 * say — the same reasoning `SubscriptionNotice` records.
		 */
		printf(
			'<div class="notice notice-warning"><p>%s</p></div>',
			esc_html__(
				'Your Optionia file storage is full, so new customer uploads are being declined. Everything else on your shop keeps working normally, and nothing has been deleted. Upgrade your plan or remove old uploads to start accepting files again.',
				'optionia'
			)
		);
	}

	/**
	 * Whether a merchant is currently being told their uploads are paused.
	 *
	 * Read by System Status, so the support screen and the notice cannot
	 * disagree — the same arrangement `SchemaNotice::is_showing()` uses.
	 */
	public function is_showing(): bool {
		return ! Heartbeat::uploads_allowed();
	}
}
