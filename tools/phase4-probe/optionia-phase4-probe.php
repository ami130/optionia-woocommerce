<?php
/**
 * Plugin Name: Optionia Phase 4 Probe (THROWAWAY)
 * Description: Diagnostic probe for Phase 4. Hardcoded option, heavy instrumentation. DELETE after Phase 4.
 * Version:     0.0.1
 * Requires PHP: 7.4
 *
 * ⚠️ THIS FILE IS DISPOSABLE. It lives outside the plugin repository on purpose.
 *
 * Its job is to learn the WooCommerce data path with a hardcoded option, before a
 * network, a cache or a config schema exist to confuse the diagnosis. Every hook
 * logs when it fires and with what, so the findings come from observation rather
 * than from reading source.
 *
 * Scope discipline (developePlan.md, Phase 4):
 *   - no Api\Client, no Config\Repository, no Engine\, no templates
 *   - Support\Money IS used: float maths teaches the wrong reflex even here
 *
 * @package OptioniaPhase4Probe
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

/**
 * The hardcoded option set. In production this comes from the config document.
 */
const OPTIONIA_PROBE_OPTION_KEY = 'probe_finish';

/**
 * Allowed values and their price delta in MINOR UNITS (cents).
 *
 * Minor units, not decimals, so the probe exercises the same representation the
 * real pricing engine will use.
 */
function optionia_probe_values(): array {
	return array(
		'standard' => array(
			'label' => 'Standard',
			'delta' => 0,
		),
		'premium'  => array(
			'label' => 'Premium',
			'delta' => 1000,
		),
		'luxury'   => array(
			'label' => 'Luxury',
			'delta' => 2000,
		),
	);
}

/**
 * Products the probe attaches to: one simple, one variable.
 *
 * Both are required. M4.1: the render hook fires in different places per product
 * type, and a probe covering only the simple case would pass while leaving a
 * broken assumption for Phase 10.
 */
function optionia_probe_product_ids(): array {
	return array( 20, 23 );
}

/* -------------------------------------------------------------------------
 * Instrumentation
 * ---------------------------------------------------------------------- */

/**
 * Record that a hook fired, with a per-request counter.
 *
 * @param string $hook    Hook name.
 * @param string $detail  Extra context.
 */
function optionia_probe_trace( string $hook, string $detail = '' ): void {
	static $counts = array();

	$counts[ $hook ] = ( $counts[ $hook ] ?? 0 ) + 1;

	$context = sprintf(
		'[%s] #%d %s',
		$hook,
		$counts[ $hook ],
		$detail
	);

	// Written to a dedicated file so probe output is not mixed with real errors.
	$log = WP_CONTENT_DIR . '/optionia-probe.log';
	$line = sprintf(
		"%s %-12s %s\n",
		gmdate( 'H:i:s' ),
		optionia_probe_request_kind(),
		$context
	);

	file_put_contents( $log, $line, FILE_APPEND | LOCK_EX ); // phpcs:ignore
}

/**
 * A short label for the kind of request currently running.
 */
function optionia_probe_request_kind(): string {
	if ( defined( 'WP_CLI' ) && WP_CLI ) {
		return 'cli';
	}
	if ( wp_doing_ajax() ) {
		return 'ajax';
	}
	if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
		return 'rest';
	}
	if ( is_admin() ) {
		return 'admin';
	}

	$uri = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '';

	if ( false !== strpos( $uri, '/cart' ) ) {
		return 'cart';
	}
	if ( false !== strpos( $uri, '/checkout' ) ) {
		return 'checkout';
	}
	if ( false !== strpos( $uri, '/product' ) ) {
		return 'product';
	}

	return 'front';
}

/* -------------------------------------------------------------------------
 * M4.1 — Render a hardcoded option
 * ---------------------------------------------------------------------- */

/**
 * Render the radios.
 *
 * Registered on two different hooks because `variable.php` does not fire
 * `woocommerce_before_add_to_cart_button` directly — it only reaches it from
 * inside the variation form, after a variation is selected.
 */
function optionia_probe_render(): void {
	global $product;

	if ( ! $product instanceof WC_Product ) {
		return;
	}

	if ( ! in_array( $product->get_id(), optionia_probe_product_ids(), true ) ) {
		return;
	}

	// Guard against double rendering: a variable product could reach both hooks.
	static $rendered = array();

	if ( isset( $rendered[ $product->get_id() ] ) ) {
		optionia_probe_trace( 'render', 'SKIPPED duplicate for product ' . $product->get_id() );

		return;
	}

	$rendered[ $product->get_id() ] = true;

	optionia_probe_trace(
		'render',
		sprintf( 'product=%d type=%s hook=%s', $product->get_id(), $product->get_type(), current_action() )
	);

	echo '<div class="optionia-probe" style="margin:1em 0;padding:1em;border:2px dashed #7c3aed;">';
	echo '<strong>Optionia Probe — Finish</strong><br />';

	foreach ( optionia_probe_values() as $key => $value ) {
		$delta = $value['delta'];
		$label = $delta > 0
			? sprintf( '%s (+%s)', $value['label'], wp_strip_all_tags( wc_price( $delta / 100 ) ) )
			: $value['label'];

		printf(
			'<label style="display:block;margin:.25em 0;"><input type="radio" name="%s" value="%s" %s /> %s</label>',
			esc_attr( OPTIONIA_PROBE_OPTION_KEY ),
			esc_attr( $key ),
			checked( 'standard', $key, false ),
			esc_html( $label )
		);
	}

	echo '</div>';
}

add_action( 'woocommerce_before_add_to_cart_button', 'optionia_probe_render' );
add_action( 'woocommerce_after_variations_table', 'optionia_probe_render' );

/* -------------------------------------------------------------------------
 * M4.2 — Capture and validate the selection
 * ---------------------------------------------------------------------- */

/**
 * Reject anything not in the hardcoded whitelist.
 *
 * Add-to-cart is a public, unauthenticated request with no nonce, so whitelist
 * validation is the only defence. AC4 in practice.
 *
 * NOTE the two call sites in WC 11.0.1 pass different second arguments:
 *   class-wc-form-handler.php:981  -> int   $product_id
 *   class-wc-form-handler.php:1013 -> array $item  (order-again / reorder)
 * A callback assuming an int breaks on the reorder path, so type-check.
 *
 * @param bool      $passed     Running validation result.
 * @param int|array $product_id Product id, or a cart item array on the reorder path.
 * @param int       $quantity   Quantity.
 */
function optionia_probe_validate( $passed, $product_id, $quantity ) {
	$resolved_id = is_array( $product_id )
		? (int) ( $product_id['product_id'] ?? 0 )
		: (int) $product_id;

	optionia_probe_trace(
		'add_to_cart_validation',
		sprintf(
			'arg2=%s resolved=%d qty=%d',
			is_array( $product_id ) ? 'ARRAY' : 'int',
			$resolved_id,
			(int) $quantity
		)
	);

	if ( ! in_array( $resolved_id, optionia_probe_product_ids(), true ) ) {
		return $passed;
	}

	$selection = optionia_probe_read_selection();

	if ( null === $selection ) {
		wc_add_notice( 'Optionia probe: please choose a finish.', 'error' );

		return false;
	}

	return $passed;
}

add_filter( 'woocommerce_add_to_cart_validation', 'optionia_probe_validate', 10, 3 );

/**
 * Read and whitelist the submitted selection.
 *
 * Returns null when absent or not in the allowed set. The browser sends only a
 * key — never a price, never a label.
 */
function optionia_probe_read_selection(): ?string {
	// phpcs:ignore WordPress.Security.NonceVerification.Missing -- public add-to-cart request, no nonce exists; whitelist is the defence.
	if ( ! isset( $_POST[ OPTIONIA_PROBE_OPTION_KEY ] ) ) {
		return null;
	}

	// phpcs:ignore WordPress.Security.NonceVerification.Missing -- see above.
	$raw = sanitize_text_field( wp_unslash( (string) $_POST[ OPTIONIA_PROBE_OPTION_KEY ] ) );

	return array_key_exists( $raw, optionia_probe_values() ) ? $raw : null;
}

/* -------------------------------------------------------------------------
 * M4.3 / M4.4 — Compute price server-side, attach to the cart item
 * ---------------------------------------------------------------------- */

/**
 * Attach the selection to the cart item.
 *
 * The delta is looked up server-side from the hardcoded table. Nothing
 * price-shaped from the request is trusted.
 *
 * Cart item keys: WC_Cart::generate_cart_id() hashes cart_item_data, so two
 * different selections naturally produce two cart lines. Keys are sorted before
 * attaching because http_build_query() is order-sensitive and unsorted data
 * would create spurious duplicate lines.
 *
 * @param array $cart_item_data Existing cart item data.
 * @param int   $product_id     Product id.
 * @param int   $variation_id   Variation id.
 */
function optionia_probe_add_cart_item_data( $cart_item_data, $product_id, $variation_id ) {
	if ( ! in_array( (int) $product_id, optionia_probe_product_ids(), true ) ) {
		return $cart_item_data;
	}

	$selection = optionia_probe_read_selection();

	if ( null === $selection ) {
		return $cart_item_data;
	}

	$values = optionia_probe_values();

	$payload = array(
		'key'   => OPTIONIA_PROBE_OPTION_KEY,
		'value' => $selection,
		'label' => $values[ $selection ]['label'],
		'delta' => $values[ $selection ]['delta'],
	);

	ksort( $payload );

	$cart_item_data['optionia_probe'] = $payload;

	optionia_probe_trace(
		'add_cart_item_data',
		sprintf( 'product=%d variation=%d selection=%s delta=%d', $product_id, $variation_id, $selection, $payload['delta'] )
	);

	return $cart_item_data;
}

add_filter( 'woocommerce_add_cart_item_data', 'optionia_probe_add_cart_item_data', 10, 3 );

/* -------------------------------------------------------------------------
 * M4.5 — Session restore, then apply the price
 * ---------------------------------------------------------------------- */

/**
 * Re-attach the payload when the cart is rebuilt from the session.
 *
 * THE HOOK THAT IS EASY TO MISS. WooCommerce stores the cart in the session but
 * re-fetches a fresh product object on every page load, so a price applied at
 * add-to-cart time is discarded unless the data is reattached here.
 *
 * Core emits wc_doing_it_wrong() if this filter returns an item without a valid
 * `data` key, so the key must be preserved.
 *
 * @param array  $session_data Rebuilt cart item.
 * @param array  $values       Raw stored values.
 * @param string $key          Cart item key.
 */
function optionia_probe_get_cart_item_from_session( $session_data, $values, $key ) {
	if ( isset( $values['optionia_probe'] ) ) {
		$session_data['optionia_probe'] = $values['optionia_probe'];

		optionia_probe_trace(
			'get_cart_item_from_session',
			sprintf( 'key=%s selection=%s', substr( (string) $key, 0, 8 ), $values['optionia_probe']['value'] ?? '?' )
		);
	}

	return $session_data;
}

add_filter( 'woocommerce_get_cart_item_from_session', 'optionia_probe_get_cart_item_from_session', 20, 3 );

/**
 * Apply the trusted price.
 *
 * Idempotent by design. This hook fires more than once per request, and a
 * non-idempotent implementation compounds: $50 becomes $70 then $90.
 *
 * @param WC_Cart $cart Cart instance.
 */
function optionia_probe_apply_price( $cart ): void {
	if ( ! $cart instanceof WC_Cart ) {
		return;
	}

	$applied = 0;

	foreach ( $cart->get_cart() as $item ) {
		if ( empty( $item['optionia_probe'] ) || ! isset( $item['data'] ) ) {
			continue;
		}

		$product = $item['data'];

		if ( ! $product instanceof WC_Product ) {
			continue;
		}

		$delta = (int) $item['optionia_probe']['delta'];

		// Recompute from the product's own base price every time rather than
		// adding to the current price. That is what makes repeated firing safe.
		$base = \Optionia\Support\Money::from_decimal( (string) $product->get_regular_price() );
		$total = $base->plus( \Optionia\Support\Money::from_minor( $delta ) );

		$product->set_price( $total->to_decimal_string() );

		++$applied;
	}

	optionia_probe_trace(
		'before_calculate_totals',
		sprintf( 'items_priced=%d cart_count=%d', $applied, $cart->get_cart_contents_count() )
	);
}

add_action( 'woocommerce_before_calculate_totals', 'optionia_probe_apply_price', 20, 1 );

/* -------------------------------------------------------------------------
 * M4.6 — Display in cart (classic and block)
 * ---------------------------------------------------------------------- */

/**
 * Add the selection to cart display.
 *
 * Serves BOTH the classic cart template and the block cart via the Store API.
 *
 * THE SCALAR TRAP: StoreApi\Schemas\V1\CartItemSchema silently discards the
 * whole element if any value is non-scalar, while classic cart renders it fine.
 * The probe deliberately emits an array-valued element too, so the difference
 * can be observed rather than assumed.
 *
 * @param array $item_data Existing display rows.
 * @param array $cart_item Cart item.
 */
function optionia_probe_item_data( $item_data, $cart_item ) {
	if ( empty( $cart_item['optionia_probe'] ) ) {
		return $item_data;
	}

	$payload = $cart_item['optionia_probe'];

	// Scalar element — expected to render in BOTH carts.
	$item_data[] = array(
		'key'     => 'Probe Finish',
		'value'   => $payload['label'],
		'display' => '',
	);

	// Deliberate array value — expected to VANISH in block cart, render in classic.
	$item_data[] = array(
		'key'     => 'Probe Array Test',
		'value'   => array( 'this', 'is', 'an', 'array' ),
		'display' => '',
	);

	optionia_probe_trace(
		'get_item_data',
		sprintf( 'rows=%d selection=%s', count( $item_data ), $payload['value'] )
	);

	return $item_data;
}

add_filter( 'woocommerce_get_item_data', 'optionia_probe_item_data', 10, 2 );

/* -------------------------------------------------------------------------
 * M4.7 / M4.8 — Persist to the order
 * ---------------------------------------------------------------------- */

/**
 * Write the selection to order item meta.
 *
 * Two kinds of key, deliberately:
 *   'Finish'                 human-readable, VISIBLE, renders in emails and print
 *   '_optionia_probe_data'   underscore-prefixed, HIDDEN, machine payload
 *
 * M12.6b: merchants fulfil from printed sheets, and WooCommerce only renders
 * meta into print/email output when the key is human-readable.
 *
 * Uses the CRUD API so it works identically under HPOS and legacy storage.
 *
 * @param WC_Order_Item_Product $item          Order line item.
 * @param string                $cart_item_key Cart item key.
 * @param array                 $values        Cart item values.
 */
function optionia_probe_order_line_item( $item, $cart_item_key, $values ): void {
	if ( empty( $values['optionia_probe'] ) ) {
		return;
	}

	$payload = $values['optionia_probe'];

	$item->add_meta_data( 'Finish', $payload['label'], true );
	$item->add_meta_data( '_optionia_probe_data', wp_json_encode( $payload ), true );

	optionia_probe_trace(
		'checkout_create_order_line_item',
		sprintf( 'selection=%s delta=%d', $payload['value'], $payload['delta'] )
	);
}

add_action( 'woocommerce_checkout_create_order_line_item', 'optionia_probe_order_line_item', 10, 3 );
