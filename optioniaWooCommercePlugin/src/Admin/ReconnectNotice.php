<?php
/**
 * Tells a merchant their connection was revoked (M8.6).
 *
 * `Admin\Notices` cannot carry this: it takes a list of requirement problems in
 * its constructor and is registered only on the path where the plugin refuses to
 * boot. This is the opposite situation — the plugin is running fine, the
 * storefront is serving, and one capability has stopped.
 *
 * ## What it deliberately does not say
 *
 * Not "Optionia is broken". A revoked store still renders every option a
 * customer sees, from the copy it already holds (AC3). What has stopped is
 * *publishing*, and saying more than that turns a recoverable state into a
 * support ticket about an outage that is not happening.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * An admin notice shown while a connection needs re-authorising.
 */
final class ReconnectNotice {

	/**
	 * Hook into the admin.
	 */
	public function register(): void {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Show the notice when — and only when — the connection was revoked.
	 */
	public function render(): void {
		if ( ! Request::user_can_manage() ) {
			return;
		}

		if ( StateMachine::REVOKED !== StateMachine::current() ) {
			return;
		}

		printf(
			'<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__(
				'Optionia can no longer publish to this shop — the connection was revoked. Your product pages keep working from the options already saved.',
				'optionia'
			),
			esc_url( admin_url( 'admin.php?page=' . Keys::MENU_SLUG_SETTINGS ) ),
			esc_html__( 'Reconnect', 'optionia' )
		);
	}
}
