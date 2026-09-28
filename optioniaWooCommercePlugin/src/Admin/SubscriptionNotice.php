<?php
/**
 * Tells a merchant their Optionia subscription needs attention (M24.5).
 *
 * The cloud ships `plan.read_only` and `plan.grace_ends_at` in every config
 * document, so the plugin can say something accurate without asking. Until this
 * existed **nothing read them**: the backend published the state and no merchant
 * ever saw it — the same defect as F132, where the dashboard ignored `usage[]`.
 *
 * ## What this notice must never do
 *
 * 🔴 **It decides nothing.** M24.5's second clause is that *"enforcement
 * decisions remain server-side"*, and this document is served to a WordPress
 * install the merchant controls — so anything here is theirs to edit. A plugin
 * that hid options, refused a render or changed a price on this would be a
 * second source of truth on a machine we do not own.
 *
 * ⚠️ **And it never says the shop is broken.** ADR-116 is explicit that the
 * storefront keeps serving through a lapse; a notice implying an outage would
 * send a merchant hunting for one that is not happening, which is exactly the
 * reasoning `SchemaNotice` records for using a warning rather than an error.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Config\Repository;

defined( 'ABSPATH' ) || exit;

/**
 * An admin notice for a lapsed subscription.
 */
final class SubscriptionNotice {

	/**
	 * The repository holding the last document the cloud sent.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * @param Repository $config Cached configuration.
	 */
	public function __construct( Repository $config ) {
		$this->config = $config;
	}

	/**
	 * Register the notice.
	 */
	public function register(): void {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Show the notice when — and only when — authoring has paused.
	 */
	public function render(): void {
		if ( ! Request::user_can_manage() ) {
			return;
		}

		$plan = $this->plan();

		if ( null === $plan || true !== ( $plan['read_only'] ?? false ) ) {
			return;
		}

		/**
		 * Warning, not error, and the first sentence is the reassurance.
		 *
		 * A merchant who reads "your subscription lapsed" on a red banner
		 * assumes their shop is down. It is not — and saying so first is the
		 * difference between a support ticket and a card update.
		 */
		printf(
			'<div class="notice notice-warning"><p>%s</p></div>',
			esc_html__(
				'Your product pages keep working normally. Optionia editing is paused until your subscription payment is settled — nothing has been deleted, and your saved options continue to show to customers.',
				'optionia'
			)
		);
	}

	/**
	 * The plan block of the cached document, when there is one.
	 *
	 * ⚠️ **A document written before `plan` existed has no such key**, and a
	 * shop that has not synced since upgrading is exactly that case. Absent is
	 * treated as "nothing to say" rather than as a lapse, because guessing the
	 * pessimistic answer would show every such merchant a warning they have not
	 * earned.
	 *
	 * @return array<string, mixed>|null
	 */
	private function plan(): ?array {
		$document = $this->config->get();

		if ( null === $document || ! isset( $document['plan'] ) || ! is_array( $document['plan'] ) ) {
			return null;
		}

		return $document['plan'];
	}

	/**
	 * Whether a merchant is currently being told their editing has paused.
	 *
	 * Read by System Status, so the support screen and the notice cannot
	 * disagree — the same arrangement `SchemaNotice::is_showing()` uses.
	 */
	public function is_showing(): bool {
		$plan = $this->plan();

		return null !== $plan && true === ( $plan['read_only'] ?? false );
	}
}
