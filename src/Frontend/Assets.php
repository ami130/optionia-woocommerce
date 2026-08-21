<?php
/**
 * Conditional asset registration.
 *
 * M3.5 acceptance: a product page with no options must load zero Optionia
 * bytes. Assets are therefore *registered* on the enqueue hook but only
 * *enqueued* once something has declared it needs them — so the decision
 * belongs to the renderer, which is the only code that knows whether a product
 * actually has options.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Frontend;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Registers and conditionally enqueues frontend and admin assets.
 */
final class Assets {

	/**
	 * Whether frontend assets have been requested this request.
	 *
	 * @var bool
	 */
	private bool $frontend_needed = false;

	/**
	 * Register hooks.
	 */
	public function register(): void {
		add_action( 'wp_enqueue_scripts', array( $this, 'register_frontend' ), 5 );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin' ) );
	}

	/**
	 * Register — not enqueue — frontend assets.
	 *
	 * Registering early means the renderer can enqueue mid-page and WordPress
	 * will still print the tag in the footer.
	 */
	public function register_frontend(): void {
		wp_register_style(
			Keys::ASSET_FRONTEND_CSS,
			$this->url( 'css/frontend.css' ),
			array(),
			$this->version()
		);

		wp_register_script(
			Keys::ASSET_FRONTEND_JS,
			$this->url( 'js/frontend.js' ),
			array(), // No jQuery: the runtime is vanilla ES6.
			$this->version(),
			true
		);
	}

	/**
	 * Enqueue frontend assets. Idempotent, callable from the renderer.
	 */
	public function enqueue_frontend(): void {
		if ( $this->frontend_needed ) {
			return;
		}

		$this->frontend_needed = true;

		wp_enqueue_style( Keys::ASSET_FRONTEND_CSS );
		wp_enqueue_script( Keys::ASSET_FRONTEND_JS );
	}

	/**
	 * Whether frontend assets were enqueued this request.
	 */
	public function frontend_enqueued(): bool {
		return $this->frontend_needed;
	}

	/**
	 * Enqueue admin assets, only on Optionia screens.
	 *
	 * @param string $hook_suffix Current admin page hook.
	 */
	public function enqueue_admin( $hook_suffix ): void {
		if ( ! is_string( $hook_suffix ) || ! $this->is_optionia_screen( $hook_suffix ) ) {
			return;
		}

		wp_enqueue_style(
			Keys::ASSET_ADMIN_CSS,
			$this->url( 'css/admin.css' ),
			array(),
			$this->version()
		);

		wp_enqueue_script(
			Keys::ASSET_ADMIN_JS,
			$this->url( 'js/admin.js' ),
			array(),
			$this->version(),
			true
		);
	}

	/**
	 * Whether the current admin screen belongs to Optionia.
	 *
	 * @param string $hook_suffix Current admin page hook.
	 */
	private function is_optionia_screen( string $hook_suffix ): bool {
		return false !== strpos( $hook_suffix, Keys::MENU_SLUG );
	}

	/**
	 * Absolute URL for a file inside assets/.
	 *
	 * @param string $relative Path relative to assets/.
	 */
	private function url( string $relative ): string {
		return plugins_url( 'assets/' . $relative, OPTIONIA_PLUGIN_FILE );
	}

	/**
	 * Asset version for cache busting.
	 *
	 * In development the file mtime is used so an edit is picked up without a
	 * version bump; in production the plugin version keeps URLs stable and
	 * CDN-cacheable.
	 */
	private function version(): string {
		return defined( 'WP_DEBUG' ) && WP_DEBUG
			? (string) time()
			: OPTIONIA_VERSION;
	}
}
