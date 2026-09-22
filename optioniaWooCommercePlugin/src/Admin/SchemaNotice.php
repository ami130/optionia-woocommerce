<?php
/**
 * Tells a merchant their plugin is too old to read what the cloud is sending
 * (M9.5).
 *
 * `Config\Repository` refuses a document whose `schema_version` exceeds this
 * build and keeps the previous copy. That is the right behaviour — a shop keeps
 * selling rather than losing its options — and it is precisely what makes the
 * situation invisible: the storefront works, the connection is healthy, the
 * credential is fine, and the merchant is quietly running configuration older
 * than the cloud holds.
 *
 * Nothing else in the plugin would ever say so. The settings screen reports a
 * cached document; it cannot report the one that was turned away.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Config\Repository;

defined( 'ABSPATH' ) || exit;

/**
 * An admin notice for an outdated plugin build.
 */
final class SchemaNotice {

	/**
	 * Register the notice.
	 */
	public function register(): void {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Show the notice when — and only when — a document was refused.
	 */
	public function render(): void {
		if ( ! Request::user_can_manage() ) {
			return;
		}

		$refused = Repository::refused_schema();

		if ( null === $refused ) {
			return;
		}

		/**
		 * Warning rather than error, deliberately.
		 *
		 * Nothing is broken: the shop is selling from its saved options. An
		 * error notice would send a merchant looking for an outage that is not
		 * happening, and the action they need — update the plugin — is routine.
		 */
		printf(
			'<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__(
				'Optionia has newer options waiting that this version of the plugin cannot read. Your product pages keep working from the options already saved — update the plugin to receive the newest ones.',
				'optionia'
			),
			esc_url( admin_url( 'plugins.php' ) ),
			esc_html__( 'Update plugins', 'optionia' )
		);
	}

	/**
	 * Whether a merchant is currently being told to update.
	 *
	 * Read by System Status, so the support screen and the notice cannot
	 * disagree about whether this shop is stale.
	 */
	public static function is_showing(): bool {
		return null !== Repository::refused_schema();
	}
}
