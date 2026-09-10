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
use Optionia\Upload\UploadLimits;

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
	/**
	 * Whether the frontend bundle has been enqueued this request.
	 *
	 * Named for what it records. It was `$frontend_needed`, which reads as a
	 * conditional-enqueue gate — "should these assets load?" — and the check is
	 * the opposite: an idempotence guard, so a second call after the first does
	 * nothing. The behaviour was right and the name said otherwise, which is the
	 * kind of thing a reader trusts and then builds on.
	 *
	 * @var bool
	 */
	private bool $frontend_enqueued = false;

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
		if ( $this->frontend_enqueued ) {
			return;
		}

		$this->frontend_enqueued = true;

		wp_enqueue_style( Keys::ASSET_FRONTEND_CSS );
		wp_enqueue_script( Keys::ASSET_FRONTEND_JS );

		/*
		 * Currency settings, passed because nothing else provides them.
		 *
		 * M10.6 asks for "currency formatting via WooCommerce's own settings",
		 * and WooCommerce does localise exactly this -- for its **cart and
		 * checkout** scripts. A product page gets none of it, so a runtime
		 * formatting a running total there has no symbol, no separators and no
		 * decimal count unless this hands them over.
		 *
		 * Formatting only. The estimate is arithmetic on integer minor units,
		 * and this decides how the result is *shown*, never what it is.
		 */
		wp_localize_script(
			Keys::ASSET_FRONTEND_JS,
			'optioniaSettings',
			array(
				'currency' => $this->currency_settings(),
				'upload'   => $this->upload_settings(),
			)
		);
	}

	/**
	 * What the upload runtime needs to reach the plugin's own route (M15.2).
	 *
	 * ⚠️ **The nonce here is a filter, not a credential, and the difference is
	 * measured.** For a logged-out shopper `wp_create_nonce()` reduces to
	 * *action + tick* — `uid` is 0 and the session token is empty — so **every
	 * guest on the site receives the identical value**, valid for 24 hours.
	 * Verified on the running site: two calls returned the same string.
	 *
	 * It refuses a script that never loaded a product page and nothing more.
	 * `Upload\UploadQuota` is what bounds abuse, per WooCommerce session.
	 *
	 * ✏️ **A cached page is therefore not a problem**, which is the opposite of
	 * the expected failure: the worry was a cached page serving a *stale* nonce
	 * that fails verification. A nonce valid for 24 hours across every guest
	 * survives any sane page cache. The real weakness is that it authenticates
	 * nobody — recorded so a later reader does not mistake it for protection.
	 *
	 * `maxBytes` mirrors the host's own ceiling so the runtime can refuse an
	 * oversized file **before** spending a customer's bandwidth on it. The server
	 * re-checks regardless: a client-side limit is a courtesy, never a boundary.
	 *
	 * @return array<string, string|int>
	 */
	private function upload_settings(): array {
		return array(
			'url'      => esc_url_raw( rest_url( Keys::REST_NAMESPACE . Keys::REST_ROUTE_UPLOAD ) ),
			'nonce'    => wp_create_nonce( Keys::NONCE_UPLOAD ),
			'maxBytes' => UploadLimits::host_max_bytes(),
		);
	}

	/**
	 * How this store writes money, for the runtime to match.
	 *
	 * Falls back to plain, unambiguous defaults when WooCommerce is not loaded:
	 * the frontend bundle is only enqueued from a product page, so that should
	 * not happen, and a total rendered with the wrong separators is better than
	 * a fatal error on a storefront.
	 *
	 * @return array<string, string|int>
	 */
	private function currency_settings(): array {
		return array(
			'symbol'   => function_exists( 'get_woocommerce_currency_symbol' ) ? (string) get_woocommerce_currency_symbol() : '',
			'decimals' => function_exists( 'wc_get_price_decimals' ) ? (int) wc_get_price_decimals() : 2,
			'decimal'  => function_exists( 'wc_get_price_decimal_separator' ) ? (string) wc_get_price_decimal_separator() : '.',
			'thousand' => function_exists( 'wc_get_price_thousand_separator' ) ? (string) wc_get_price_thousand_separator() : ',',

			/*
			 * `%1$s` is the symbol and `%2$s` the amount, matching
			 * `woocommerce_price_format`. Kept as a pattern rather than a
			 * boolean "symbol first": several locales place it after, and one
			 * with a space between is not expressible any other way.
			 */
			'format'   => function_exists( 'get_woocommerce_price_format' ) ? (string) get_woocommerce_price_format() : '%1$s%2$s',
		);
	}

	/**
	 * Whether frontend assets were enqueued this request.
	 */
	public function frontend_enqueued(): bool {
		return $this->frontend_enqueued;
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
