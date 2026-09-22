<?php
/**
 * PHPUnit bootstrap.
 *
 * Unit tests must run without a WordPress installation — that is what
 * Principle 1's layering buys us. ABSPATH is defined so the direct-access
 * guards in src/ pass, and the handful of WordPress functions that pure classes
 * touch are stubbed.
 *
 * @package Optionia
 */

declare( strict_types=1 );

// A fixture WordPress root, not the plugin directory.
//
// `Activator` requires ABSPATH . 'wp-admin/includes/upgrade.php' before calling
// dbDelta(), as WordPress requires. Pointing ABSPATH at the plugin root made
// that require fatal, so the whole activation and migration path -- everything
// that runs on install and update -- was untestable and untested.
//
// The fixture root holds only that one file. Placing it here rather than in the
// plugin root keeps anything resembling a WordPress core file out of the
// shipped package.
define( 'ABSPATH', __DIR__ . '/fixtures/wp-root/' );
define( 'OPTIONIA_PLUGIN_FILE', __DIR__ . '/../optionia.php' );
define( 'OPTIONIA_VERSION', '0.2.0' );
define( 'OPTIONIA_MIN_PHP', '7.4' );
define( 'OPTIONIA_MIN_WP', '6.0' );
define( 'OPTIONIA_MIN_WC', '8.0' );

// Core time constants. Scheduler offsets its events with these, so without
// them the class cannot be exercised at all.
if ( ! class_exists( 'WP_Error' ) ) {
	/**
	 * Minimal WP_Error.
	 *
	 * `is_wp_error()` already tested for this class; without a definition the
	 * check could never be true, so every WP_Error branch was dead under test.
	 */
	class WP_Error {

		/**
		 * Error code.
		 *
		 * @var string
		 */
		public string $code;

		/**
		 * Error message.
		 *
		 * @var string
		 */
		public string $message;

		/**
		 * Constructor.
		 *
		 * @param string $code    Error code.
		 * @param string $message Error message.
		 */
		public function __construct( string $code = '', string $message = '' ) {
			$this->code    = $code;
			$this->message = $message;
		}

		/**
		 * Error code accessor.
		 */
		public function get_error_code(): string {
			return $this->code;
		}

		/**
		 * Error message accessor.
		 */
		public function get_error_message(): string {
			return $this->message;
		}
	}
}

define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );

require_once __DIR__ . '/../vendor/autoload.php';

/*
 * Minimal WordPress stubs.
 *
 * Deliberately tiny: if this list grows, it is a signal that a class has crept
 * out of the pure layer and should be refactored rather than accommodated here.
 */

if ( ! function_exists( 'wc_get_price_decimals' ) ) {
	/**
	 * Currency decimal places.
	 */
	/**
	 * The options API, in memory.
	 *
	 * `Connection\StateMachine` and `Connection\Handshake` are the plugin's
	 * half of M8.1b's state machine, and both are pure logic that happens to
	 * persist through WordPress. Stubbing three functions keeps them in the unit
	 * suite — where they run in milliseconds — rather than pushing the state
	 * machine into an integration suite for the sake of a key-value store.
	 */
	$GLOBALS['optionia_test_options'] = array();

	/**
	 * The store's decimal count, as a currency switcher would change it.
	 *
	 * 🔴 **`wc_get_price_decimals()` was hardcoded to 2**, so JPY (0 decimals)
	 * and KWD (3) were untestable -- while `PRICING-SPEC.md` §6 discusses both
	 * explicitly. The same stub gap that hid `wc_get_weight()` in M16.8 and
	 * `wc_get_product()` in M16.1, both of which concealed real defects.
	 *
	 * Two is the default because it is what an unconfigured WooCommerce uses;
	 * a test that cares sets it and restores it in `tearDown()`.
	 */
	$GLOBALS['optionia_test_decimals'] = 2;

	/**
	 * Capability, in memory.
	 *
	 * `Connection\Callback` refuses before reading the handshake when the
	 * caller lacks the capability, and that ordering is the point: a subscriber
	 * must not learn whether a handshake is pending.
	 */
	$GLOBALS['optionia_test_can'] = true;

	/**
	 * Output and escaping, as identity functions.
	 *
	 * `Admin\ConnectionSection::render()` is the merchant-facing half of M8.3,
	 * and what it prints is the thing worth asserting: every state a merchant
	 * can be in must produce a message they can act on. Escaping is WordPress's
	 * job and is tested by WordPress; here it only has to not swallow the text.
	 */
	function __( string $text, string $domain = '' ): string {
		unset( $domain );

		return $text;
	}

	/*
	 * The escaping stubs escape, rather than pass text through.
	 *
	 * They used to `return $text` unchanged, which made one whole class of bug
	 * untestable: removing every `esc_html()` and `esc_attr()` call from the
	 * templates left all 306 tests green, because escaped and raw output were
	 * byte-identical in the harness. Measured during the Stage 4 audit.
	 *
	 * PHPCS does catch an unescaped `echo`, and that is the right layer for a
	 * rule about how output is *written*. But it leaves the storefront's XSS
	 * surface single-guarded, and a test asserting rendered markup could not
	 * tell a safe page from a hostile one. `htmlspecialchars` with `ENT_QUOTES`
	 * is what WordPress does underneath, so a template that escapes correctly
	 * behaves the same here as in production.
	 */
	function esc_html( string $text ): string {
		return htmlspecialchars( $text, ENT_QUOTES, 'UTF-8' );
	}

	function esc_attr( string $text ): string {
		return htmlspecialchars( $text, ENT_QUOTES, 'UTF-8' );
	}

	/**
	 * WordPress's `esc_textarea`, which is `esc_attr` without the quote
	 * escaping — a `<textarea>`'s content is text, not an attribute value, so
	 * escaping quotes would show `&quot;` where a customer typed one.
	 *
	 * Stubbed because a template calling an undefined function is a fatal, and
	 * `textarea.php` was the first template to need it.
	 */
	function esc_textarea( string $text ): string {
		return htmlspecialchars( $text, ENT_QUOTES, 'UTF-8' );
	}

	function esc_url( string $url ): string {
		/*
		 * 🔴 **Scheme allow-list, because `FILTER_SANITIZE_URL` is not one.**
		 *
		 * This stub used that filter alone, which passes `javascript:alert(1)`
		 * through **unchanged** — while the real `esc_url()` refuses any scheme
		 * outside `wp_allowed_protocols()` and returns an empty string.
		 *
		 * Measured 2026-09-03 while adding the image swatch: a test asserting
		 * that a `javascript:` URL never reaches `src` **failed against correct
		 * template code**, because the harness was weaker than the function it
		 * replaces. A stub that under-protects turns a real safety property into
		 * an untestable one, and would have let a template ship trusting an
		 * escape that had never been exercised.
		 *
		 * Only the schemes a swatch or link legitimately uses are allowed; a
		 * relative URL has no scheme and passes.
		 */
		$scheme = wp_parse_url( $url, PHP_URL_SCHEME );

		if ( is_string( $scheme ) && ! in_array( strtolower( $scheme ), array( 'http', 'https', 'mailto' ), true ) ) {
			return '';
		}

		$filtered = filter_var( $url, FILTER_SANITIZE_URL );

		return false === $filtered ? '' : $filtered;
	}

	function esc_html__( string $text, string $domain = '' ): string {
		unset( $domain );

		return $text;
	}

	/**
	 * Prints, as WordPress does.
	 *
	 * Returning an empty string instead would make a test asserting the field is
	 * present pass against the stub rather than the code — the field would be
	 * absent from the output and the assertion would be measuring nothing.
	 */
	function wp_nonce_field( string $action = '', string $name = '', bool $referer = true, bool $display = true ): void {
		unset( $action, $referer, $display );

		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a test stub standing in for WordPress's own output.
		echo '<input type="hidden" name="' . $name . '" value="nonce" />';
	}

	/**
	 * WordPress adds slashes to superglobals; this undoes that.
	 *
	 * An identity function here, because the test data is never slashed — the
	 * point is that the production code calls it, not that the stub reverses
	 * anything.
	 *
	 * @param mixed $value Value to unslash.
	 *
	 * @return mixed
	 */
	/**
	 * The hooks API, in memory.
	 *
	 * `[8l]` routes a 401 from `Api\Client` to `Connection\StateMachine`
	 * through an action, so the transport layer never learns what a connection
	 * means. Testing that the wire is connected needs the wire.
	 */
	$GLOBALS['optionia_test_products']           = array();
	$GLOBALS['optionia_test_actions']            = array();
	$GLOBALS['optionia_test_filters']            = array();
	$GLOBALS['optionia_test_autoload']           = array();
	$GLOBALS['optionia_test_option_reads']       = array();
	$GLOBALS['optionia_test_meta']               = array();
	$GLOBALS['optionia_test_meta_reads']         = array();
	$GLOBALS['optionia_test_meta_writes']        = array();
	$GLOBALS['optionia_test_terms']              = array();
	$GLOBALS['optionia_test_product_queries']    = 0;
	$GLOBALS['optionia_test_attachments']        = array();
	$GLOBALS['optionia_test_post_types']         = array();
	$GLOBALS['optionia_test_term_reads']         = array();
	$GLOBALS['optionia_test_http_calls']         = array();
	$GLOBALS['optionia_test_enqueued']           = array();
	$GLOBALS['optionia_test_localized']          = array();
	$GLOBALS['optionia_test_is_admin']           = false;
	$GLOBALS['optionia_test_doing_cron']         = true;
	$GLOBALS['optionia_test_doing_ajax']         = false;
	$GLOBALS['optionia_test_notices']            = array();
	$GLOBALS['optionia_test_prices_include_tax'] = false;
	$GLOBALS['optionia_test_salt']               = 'test-salt';
	$GLOBALS['optionia_test_rest_routes']        = array();
	$GLOBALS['optionia_test_cron']               = array();

	function add_action( string $hook, $callback, int $priority = 10, int $args = 1 ): bool {
		unset( $priority, $args );

		$GLOBALS['optionia_test_actions'][ $hook ][] = $callback;

		return true;
	}

	function do_action( string $hook, ...$args ): void {
		foreach ( $GLOBALS['optionia_test_actions'][ $hook ] ?? array() as $callback ) {
			call_user_func_array( $callback, $args );
		}
	}

	/**
	 * The HTTP layer, scripted.
	 *
	 * `Api\Client` announces a `401` so `Connection\StateMachine` can react
	 * (M8.6). Testing that it *fires* — rather than that the listener works once
	 * something fires it — needs a response with a status, and nothing more.
	 * Set `$GLOBALS['optionia_test_http']` to the response the next request
	 * should receive.
	 */
	$GLOBALS['optionia_test_http'] = array(
		'status' => 200,
		'body'   => '{"data":{}}',
	);

	/**
	 * Request-context stubs, overridable.
	 *
	 * `Api\Client::refuse_on_frontend_render()` decides from these whether a
	 * request is a customer-facing render — AC3's "the storefront must never
	 * block on Optionia".
	 *
	 * **`wp_doing_cron()` defaults to `true` here, unlike WordPress.** All three
	 * were hardcoded `false`, which placed the harness permanently in the
	 * *forbidden* context: every test ran as though a shopper were loading a
	 * product page. That was invisible while the guard only logged. Phase 10
	 * Stage 3 made it refuse, and fourteen tests of cron-driven behaviour —
	 * heartbeats, the degradation matrix, reconnection — began failing in a
	 * context they never meant to be in.
	 *
	 * Cron is the honest default: it is what `Config\Synchroniser` and
	 * `Connection\Heartbeat` actually run under, so a test that says nothing
	 * about its context gets the one its subject really has. A test that means to
	 * be a page render says so — `FrontendRenderGuardTest` does, and restores the
	 * flag in `tearDown()`, because the reset below runs once at load rather than
	 * per test and state left behind here reaches other files.
	 */
	function wp_doing_cron(): bool {
		return (bool) ( $GLOBALS['optionia_test_doing_cron'] ?? true );
	}

	function wp_doing_ajax(): bool {
		return (bool) ( $GLOBALS['optionia_test_doing_ajax'] ?? false );
	}

	/**
	 * Record a customer-facing notice.
	 *
	 * Recorded rather than discarded because a refusal that shows the customer
	 * nothing is a broken checkout, not a secure one: the add-to-cart silently
	 * does nothing and they try again. The tests assert a message was raised,
	 * not merely that `false` was returned.
	 *
	 * @param string $message Notice text.
	 * @param string $type    Notice type.
	 */
	/**
	 * A keyed hash over the site's salt.
	 *
	 * Real WordPress derives the salt from `AUTH_KEY` and friends. The stub uses
	 * a fixed secret so signatures are reproducible within a test run, and a
	 * global so a test can *rotate* it -- which is the case that matters, because
	 * a salt rotation must degrade a frozen price to the live one rather than
	 * emptying the customer's cart.
	 *
	 * @param string $data   Data to hash.
	 * @param string $scheme Salt scheme; ignored here.
	 * @return string Hex digest.
	 */
	function wp_hash( string $data, string $scheme = 'auth' ): string {
		unset( $scheme );

		return hash_hmac( 'sha256', $data, (string) ( $GLOBALS['optionia_test_salt'] ?? 'test-salt' ) );
	}

	function wc_add_notice( string $message, string $type = 'success' ): void {
		$GLOBALS['optionia_test_notices'][] = array(
			'message' => $message,
			'type'    => $type,
		);
	}

	// phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- signature parity with WordPress.
	function wp_rand( int $min = 0, int $max = 0 ): int {
		unset( $max );

		return $min;
	}

	function wp_cache_delete( string $key, string $group = '' ): bool {
		unset( $key, $group );

		return true;
	}

	function get_bloginfo( string $show = '' ): string {
		unset( $show );

		return (string) ( $GLOBALS['optionia_test_wp_version'] ?? '6.5' );
	}

	function untrailingslashit( string $value ): string {
		return rtrim( $value, '/\\' );
	}

	function trailingslashit( string $value ): string {
		return rtrim( $value, '/\\' ) . '/';
	}

	/**
	 * Append query arguments to a URL.
	 *
	 * ⚠️ **Both call shapes, because WordPress accepts both.** This stub handled
	 * only `add_query_arg( array, $url )` and silently returned the *second*
	 * argument for the three-argument form — so a caller using
	 * `add_query_arg( $key, $value, $url )` got a URL that was really its own
	 * value, and the link rendered with an empty `href`.
	 *
	 * @param array<string, mixed>|string $args  Argument map, or a single key.
	 * @param mixed                       $value Value when a key was given, else the URL.
	 * @param string                      $url   URL when a key and value were given.
	 */
	function add_query_arg( $args, $value = '', string $url = '' ): string {
		if ( ! is_array( $args ) ) {
			$args = array( (string) $args => $value );
		} else {
			$url = is_string( $value ) ? $value : '';
		}

		return $url . ( false === strpos( $url, '?' ) ? '?' : '&' ) . http_build_query( $args );
	}

	function wp_remote_retrieve_header( $response, string $name ): string {
		return (string) ( $response['headers'][ $name ] ?? '' );
	}

	function is_admin(): bool {
		return (bool) ( $GLOBALS['optionia_test_is_admin'] ?? false );
	}

	function home_url( string $path = '' ): string {
		return 'https://shop.example.test' . $path;
	}

	/**
	 * Register a filter.
	 *
	 * Real registration, not a no-op. `Activation\Scheduler` attaches its
	 * `cron_schedules` filter for the duration of one call precisely because
	 * an unregistered interval is refused -- a pass-through stub would make
	 * that mechanism untestable and silently always-failing.
	 *
	 * @param string   $hook     Hook name.
	 * @param callable $callback Callback.
	 * @return bool
	 */
	function add_filter( string $hook, $callback, int $priority = 10, int $accepted_args = 1 ): bool {
		unset( $priority );

		$GLOBALS['optionia_test_filters'][ $hook ][] = array(
			'callback'      => $callback,
			'accepted_args' => $accepted_args,
		);

		return true;
	}

	/**
	 * Remove a filter.
	 *
	 * @param string   $hook     Hook name.
	 * @param callable $callback Callback.
	 * @return bool
	 */
	function remove_filter( string $hook, $callback ): bool {
		$existing = $GLOBALS['optionia_test_filters'][ $hook ] ?? array();

		$GLOBALS['optionia_test_filters'][ $hook ] = array_values(
			array_filter(
				$existing,
				static function ( $registered ) use ( $callback ) {
					return $registered['callback'] !== $callback;
				}
			)
		);

		return true;
	}

	/**
	 * Apply registered filters to a value.
	 *
	 * @param string $hook  Hook name.
	 * @param mixed  $value Value to filter.
	 * @param mixed  ...$args Extra arguments.
	 * @return mixed
	 */
	function apply_filters( string $hook, $value, ...$args ) {
		foreach ( $GLOBALS['optionia_test_filters'][ $hook ] ?? array() as $registered ) {
			/*
			 * Sliced to `accepted_args`, exactly as `WP_Hook::apply_filters()`
			 * does -- and the slice is the point, not a detail.
			 *
			 * This stub used to ignore `accepted_args` and pass every argument
			 * to every callback. `woocommerce_add_to_cart_validation` has five
			 * call sites supplying three, three, five, six and three arguments,
			 * and the whole risk in M11.5 is a callback registered at the wrong
			 * arity. A stub that always passes everything makes the correct and
			 * the broken registration behave identically here while diverging in
			 * production -- a test that cannot fail for the reason it exists.
			 *
			 * `$value` is the filtered subject and is always passed, so the
			 * slice takes `accepted_args - 1` of the extras.
			 */
			$extras = array_slice( $args, 0, max( 0, $registered['accepted_args'] - 1 ) );

			$value = call_user_func( $registered['callback'], $value, ...$extras );
		}

		return $value;
	}

	function wp_json_encode( $data, int $flags = 0, int $depth = 512 ) {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode -- this stub *is* the alternative.
		return json_encode( $data, $flags, $depth );
	}

	/**
	 * The product currently being displayed.
	 *
	 * `Frontend\Renderer` reads `global $product` because that is what
	 * WooCommerce's own templates hold at the hooks it registers on, and those
	 * hooks pass no arguments. A double here needs only the two methods the
	 * renderer calls.
	 */

	/*
	 * Theme lookup for `Frontend\Templates`.
	 *
	 * The loader resolves child theme -> parent theme -> plugin, and a test needs
	 * the first two to miss so the plugin's own `templates/` is what renders.
	 * Pointed at a directory that does not exist rather than left undefined: the
	 * *hierarchy* is the thing under test, and a fatal error would prove only
	 * that the stub was absent.
	 */
	function get_stylesheet_directory(): string {
		return $GLOBALS['optionia_test_child_theme'] ?? __DIR__ . '/fixtures/no-such-theme';
	}

	function get_template_directory(): string {
		return $GLOBALS['optionia_test_parent_theme'] ?? __DIR__ . '/fixtures/no-such-theme';
	}

	function plugin_dir_path( string $file ): string {
		return rtrim( dirname( $file ), '/' ) . '/';
	}

	/**
	 * Record data passed from PHP to a script.
	 *
	 * Stored rather than discarded: what reaches the runtime is a contract, and
	 * a stub that swallowed it would leave "the storefront has currency
	 * settings" unassertable.
	 */
	function wp_localize_script( string $handle, string $object_name, array $data ): bool {
		$GLOBALS['optionia_test_localized'][ $handle ][ $object_name ] = $data;

		return true;
	}

	/**
	 * Record an enqueued stylesheet handle.
	 */
	function wp_enqueue_style( string $handle ): void {
		$GLOBALS['optionia_test_enqueued'][] = $handle;
	}

	/**
	 * Record an enqueued script handle.
	 */
	function wp_enqueue_script( string $handle ): void {
		$GLOBALS['optionia_test_enqueued'][] = $handle;
	}

	/**
	 * A product double.
	 *
	 * `$price` is a decimal **string**, matching `WC_Product::get_price()`. It is
	 * not an int and not a float: Stage 5's audit found that shape truncating
	 * silently under an `int` type hint, and a stub that returned a clean int
	 * would have hidden it.
	 *
	 * @param int    $id    Product id.
	 * @param string $type  Product type.
	 * @param string $price Price as WooCommerce stores it.
	 */
	function optionia_test_product( int $id, string $type, string $price = '0' ): object {
		$product = optionia_test_build_product( $id, $type, $price );

		/*
		 * Registered so `wc_get_product()` can find it.
		 *
		 * `Support\BasePrice` looks a product up by id rather than being handed
		 * one, because `CartItemData` and `CartDisplay` have an id and no object.
		 * Without this registry that lookup returns null in every test, so
		 * `BasePrice::minor()` answers 0 -- and a percentage priced off it would
		 * be silently untested while appearing covered. That is the same stub gap
		 * that hid `wc_get_weight()` in M16.8.
		 */
		$GLOBALS['optionia_test_products'][ $id ] = $product;

		return $product;
	}

	/**
	 * Look a registered product up, the way WooCommerce does.
	 *
	 * Returns `false` for an unknown id, which is what `wc_get_product()` itself
	 * returns -- not null, and not a product with no price. Code guarding with
	 * `is_object()` must see the real shape of a miss.
	 *
	 * @param mixed $id Product id.
	 * @return object|false The product, or false when nothing is registered.
	 */
	function wc_get_product( $id = 0 ) {
		$key = is_numeric( $id ) ? (int) $id : 0;

		return $GLOBALS['optionia_test_products'][ $key ] ?? false;
	}

	/**
	 * An attachment's URL, as WordPress returns it.
	 *
	 * ⚠️ **`false` for an unknown attachment**, which is what WordPress itself
	 * returns — not an empty string. `CataloguePayload` guards with `is_string`,
	 * and a stub answering `''` would leave that guard unexercised.
	 *
	 * @param int    $attachment_id Attachment id.
	 * @param string $size          Image size.
	 * @return string|false
	 */
	function wp_get_attachment_image_url( int $attachment_id, string $size = 'thumbnail' ) {
		unset( $size );

		return $GLOBALS['optionia_test_attachments'][ $attachment_id ] ?? false;
	}

	/**
	 * A page of the catalogue, as `wc_get_products()` returns it.
	 *
	 * 🔴 **Honours `orderby`, `order`, `offset` and `limit` for real**, because
	 * the catalogue walk's correctness *is* its ordering. `CataloguePayload`
	 * orders by **ID ascending** so a product created mid-walk lands past the
	 * cursor instead of shifting every later page — the defect
	 * `ProductsRepository` records for `OFFSET` in the backend. A stub that
	 * ignored ordering would let that guarantee be deleted with every test
	 * still green.
	 *
	 * With `paginate`, returns the `{ products, total, max_num_pages }` object
	 * WooCommerce returns; without it, a bare array.
	 *
	 * @param array<string, mixed> $args Query arguments.
	 * @return object|array<int, object>
	 */
	function wc_get_products( array $args = array() ) {
		$products = array_values( $GLOBALS['optionia_test_products'] ?? array() );

		usort(
			$products,
			static function ( $a, $b ): int {
				return $a->get_id() <=> $b->get_id();
			}
		);

		if ( isset( $args['order'] ) && 'DESC' === strtoupper( (string) $args['order'] ) ) {
			$products = array_reverse( $products );
		}

		/*
		 * 🔴 **`status` is honoured, because a stub that ignored it made the
		 * filter untestable.** `CataloguePayload` asks for every status --
		 * `publish`, `draft`, `pending`, `private` -- so a merchant can assign
		 * options to a product *before* publishing it, and the picker can say
		 * "draft -- not visible on your storefront". With the argument ignored,
		 * deleting it entirely left every test green while the real plugin
		 * mirrored only published products.
		 */
		if ( isset( $args['status'] ) ) {
			$wanted   = (array) $args['status'];
			$products = array_values(
				array_filter(
					$products,
					static function ( $product ) use ( $wanted ): bool {
						return ! method_exists( $product, 'get_status' )
							|| in_array( $product->get_status(), $wanted, true );
					}
				)
			);
		}

		$total  = count( $products );
		$offset = isset( $args['offset'] ) ? max( 0, (int) $args['offset'] ) : 0;
		$limit  = isset( $args['limit'] ) ? (int) $args['limit'] : -1;
		$page   = $limit < 0 ? array_slice( $products, $offset ) : array_slice( $products, $offset, $limit );

		++$GLOBALS['optionia_test_product_queries'];

		/*
		 * 🔴 **`return => 'ids'` is honoured, because WooCommerce honours it.**
		 * `class-wc-product-data-store-cpt.php:2470` returns `$query->posts`
		 * rather than hydrated products for this argument, and
		 * `Catalogue\CatalogueReconciler` depends on it: a manifest needs ids,
		 * and hydrating 100k products to read their ids would be the cost the
		 * manifest exists to avoid. A stub that always returned objects made
		 * that path fatal -- found by the first test that ran it.
		 */
		if ( isset( $args['return'] ) && 'ids' === $args['return'] ) {
			$page = array_map(
				static function ( $product ): int {
					return $product->get_id();
				},
				$page
			);
		}

		if ( ! empty( $args['paginate'] ) ) {
			return (object) array(
				'products'      => $page,
				'total'         => $total,
				'max_num_pages' => $limit > 0 ? (int) ceil( $total / $limit ) : 1,
			);
		}

		return $page;
	}

	/**
	 * The product double itself.
	 *
	 * @param int    $id    Product id.
	 * @param string $type  Product type.
	 * @param string $price Price as WooCommerce stores it.
	 */
	function optionia_test_build_product( int $id, string $type, string $price = '0' ): object {
		return new class( $id, $type, $price ) {
			/**
			 * Product id.
			 *
			 * @var int
			 */
			private int $id;

			/**
			 * Product type.
			 *
			 * @var string
			 */
			private string $type;

			/**
			 * Price, as a decimal string.
			 *
			 * @var string
			 */
			private string $price;

			public function __construct( int $id, string $type, string $price ) {
				$this->id    = $id;
				$this->type  = $type;
				$this->price = $price;
			}

			public function get_id(): int {
				return $this->id;
			}

			public function get_type(): string {
				return $this->type;
			}

			/**
			 * The price WooCommerce would return: a decimal string.
			 */
			public function get_price() {
				return $this->price;
			}

			/**
			 * The line's weight, in the store's configured unit.
			 *
			 * ⚠️ **A string, as `WC_Product::get_weight()` returns**, and empty
			 * when unset — a product with no weight answers `''`, not `0`. A stub
			 * returning a number would hide the cast every caller must do.
			 *
			 * @var string
			 */
			public string $weight = '';

			/** The weight, exactly as WooCommerce hands it back. */
			public function get_weight() {
				return $this->weight;
			}

			/**
			 * The product's name (M19.1).
			 *
			 * Public properties rather than constructor arguments, matching
			 * `$weight` above: every existing caller builds a product for its
			 * price or type, and adding required arguments would rewrite each of
			 * them to say nothing.
			 *
			 * ⚠️ **Defaults are what WooCommerce actually returns for an unset
			 * field, not what is convenient.** `get_sku()` answers `''` rather
			 * than null, and a stub returning null would hide the difference
			 * between "no SKU" and "not a product" at every caller.
			 *
			 * @var string
			 */
			public string $name = 'Test Product';

			/**
			 * The SKU; `''` when unset, as WooCommerce returns.
			 *
			 * @var string
			 */
			public string $sku = '';

			/**
			 * Post status: `publish`, `draft`, `pending` or `private`.
			 *
			 * @var string
			 */
			public string $status = 'publish';

			/**
			 * The product's permalink.
			 *
			 * @var string
			 */
			public string $permalink = '';

			public function get_name(): string {
				return $this->name;
			}

			public function get_sku() {
				return $this->sku;
			}

			public function get_status(): string {
				return $this->status;
			}

			public function get_permalink() {
				return $this->permalink;
			}

			/**
			 * Attachment id of the product's main image; 0 when there is none.
			 *
			 * @var int
			 */
			public int $image_id = 0;

			public function get_image_id() {
				return $this->image_id;
			}

			/**
			 * When the product last changed.
			 *
			 * `null` when unset, which is what `WC_Product::get_date_modified()`
			 * returns for a product that has never been edited — not a zero date.
			 *
			 * @var object|null
			 */
			public $date_modified = null;

			public function get_date_modified() {
				return $this->date_modified;
			}

			/**
			 * Set the weight, as `WC_Cart` consumers do.
			 *
			 * Stores whatever it is given, like `set_price()` above: a stub that
			 * rounded or clamped would hide the unit-conversion bug this exists
			 * to catch.
			 *
			 * @param mixed $weight The new weight.
			 */
			public function set_weight( $weight ): void {
				$this->weight = (string) $weight;
			}

			/**
			 * Set the price, as `WC_Cart` consumers do.
			 *
			 * Accepts whatever is given and stores it as a string, exactly like
			 * `WC_Product::set_price()`. It does **not** validate or round: a
			 * stub that cleaned up its input would hide the bug where a plugin
			 * hands WooCommerce a float or a line total.
			 *
			 * @param mixed $price New price.
			 */
			public function set_price( $price ): void {
				$this->price = (string) $price;
			}
		};
	}

	/**
	 * A cart double, faithful to the parts of `WC_Cart` that M11.6 depends on.
	 *
	 * ## Why this multiplies by quantity, and why that matters
	 *
	 * `WC_Cart_Totals` computes a line as **per-unit price × quantity**
	 * (WC 11.0.1, `includes/class-wc-cart-totals.php:233`):
	 *
	 * ```php
	 * $item->price = wc_add_number_precision_deep( (float) $cart_item['data']->get_price() * (float) $cart_item['quantity'] );
	 * ```
	 *
	 * So this stub multiplies too. A stub that ignored quantity would make a
	 * correct per-unit implementation and a broken line-total one produce the
	 * same number here while differing in production — the exact failure Stage 6
	 * hit when `apply_filters()` ignored `accepted_args`, which made a correctly
	 * registered and a badly registered validator indistinguishable in tests.
	 *
	 * `price_includes_tax` is recorded rather than acted on, because it is
	 * WooCommerce's business: the plugin hands over a figure in the store's own
	 * convention and tax follows. A stub that adjusted for tax would be modelling
	 * a branch the plugin must not have.
	 */
	/**
	 * An order line item double.
	 *
	 * Models `WC_Order_Item::add_meta_data()`, which is the CRUD API rather than
	 * the legacy `wc_add_order_item_meta()`. That choice is the reason order item
	 * meta behaves identically under HPOS and legacy storage -- the data store
	 * handles persistence, and this method only records intent -- so the double
	 * models the same call the production code makes.
	 *
	 * `$unique` is honoured because production passes `true`: a line must not
	 * accumulate a second `Finish` row if the hook were ever to fire twice.
	 */
	function optionia_test_order_item(): object {
		return new class() {
			/**
			 * Meta rows, keyed by meta key.
			 *
			 * @var array<string, mixed>
			 */
			public array $meta = array();

			/**
			 * The order in which keys were added, so display order is testable.
			 *
			 * @var array<int, string>
			 */
			public array $order = array();

			/**
			 * Add one meta row.
			 *
			 * @param string $key    Meta key.
			 * @param mixed  $value  Meta value.
			 * @param bool   $unique Replace an existing row rather than appending.
			 */
			public function add_meta_data( string $key, $value, bool $unique = false ): void {
				if ( $unique || ! isset( $this->meta[ $key ] ) ) {
					if ( ! isset( $this->meta[ $key ] ) ) {
						$this->order[] = $key;
					}

					$this->meta[ $key ] = $value;

					return;
				}

				$this->meta[ $key ] = $value;
			}

			/**
			 * Meta as the admin and `wc_display_item_meta()` see it.
			 *
			 * Returns objects with `key`, `value` and `display_key`, matching
			 * `WC_Order_Item::get_all_formatted_meta_data()`. Underscore-prefixed
			 * keys are omitted, as WooCommerce omits them -- which is what makes
			 * the visible pairs distinguishable from the machine payload.
			 *
			 * Added for M12.7: `Reporting\OrderPayload` reads these to find an
			 * option's display label, and without the method every label
			 * silently fell back to the option id.
			 *
			 * @param string $hideprefix Prefix marking a key as hidden.
			 * @return array<int, object>
			 */
			public function get_formatted_meta_data( string $hideprefix = '_' ) {
				$out = array();

				foreach ( $this->order as $key ) {
					if ( '' !== $hideprefix && 0 === strpos( $key, $hideprefix ) ) {
						continue;
					}

					$out[] = (object) array(
						'key'         => $key,
						'value'       => $this->meta[ $key ],
						'display_key' => $key,
					);
				}

				return $out;
			}

			/**
			 * Change an existing meta row.
			 *
			 * Present because `wc_save_order_items()` calls it when a merchant
			 * edits an order line's meta on the admin screen -- the path M12.8
			 * requires option data to survive. Without it a test that models the
			 * admin edit would error rather than assert, which is how the first
			 * version of `test_machine_keys_cannot_be_edited_from_the_order_screen`
			 * passed while exercising nothing.
			 *
			 * @param string $key   Meta key.
			 * @param mixed  $value Meta value.
			 */
			public function update_meta_data( string $key, $value ): void {
				if ( ! isset( $this->meta[ $key ] ) ) {
					$this->order[] = $key;
				}

				$this->meta[ $key ] = $value;
			}

			/**
			 * Remove a meta row.
			 *
			 * `wc_save_order_items()` deletes a row when a merchant blanks both
			 * its key and value, so a merchant can attempt deletion as well as
			 * edits.
			 *
			 * @param string $key Meta key.
			 */
			public function delete_meta_data( string $key ): void {
				unset( $this->meta[ $key ] );

				$this->order = array_values( array_diff( $this->order, array( $key ) ) );
			}

			/**
			 * One meta value.
			 *
			 * @param string $key Meta key.
			 * @return mixed
			 */
			public function get_meta( string $key ) {
				return $this->meta[ $key ] ?? null;
			}
		};
	}

	/**
	 * A `WC_Order` double (M12.7).
	 *
	 * Models only what `Reporting\OrderPayload` and `Reporting\OrderReporter`
	 * actually call: totals, currency, creation date, line items, and the CRUD
	 * meta API they use for the reported marker. `get_total()` returns a
	 * **decimal string**, as WooCommerce does -- the difference that made Phase
	 * 11's pricing bug possible, and the reason the payload rounds rather than
	 * casts.
	 *
	 * Registered in `$GLOBALS['optionia_test_orders']` so `wc_get_order()` can
	 * find it by id, which is how the reporter loads orders.
	 *
	 * @param int    $id       Order id.
	 * @param string $total    Order total, as a decimal string.
	 * @param string $currency Three-letter currency code.
	 */
	function optionia_test_order( int $id, string $total = '179.00', string $currency = 'GBP' ): object {
		$order = new class( $id, $total, $currency ) {
			/**
			 * Order id.
			 *
			 * @var int
			 */
			private int $id;

			/**
			 * Total, as WooCommerce returns it.
			 *
			 * @var string
			 */
			private string $total;

			/**
			 * Currency code.
			 *
			 * @var string
			 */
			private string $currency;

			/**
			 * Line items.
			 *
			 * @var array<int, object>
			 */
			public array $items = array();

			/**
			 * Order meta.
			 *
			 * @var array<string, mixed>
			 */
			public array $meta = array();

			/**
			 * How many times the order was saved.
			 *
			 * @var int
			 */
			public int $saves = 0;

			/**
			 * When the order was created.
			 *
			 * @var string
			 */
			public string $created = '2026-08-30T10:00:00+00:00';

			/**
			 * Constructor.
			 *
			 * @param int    $id       Order id.
			 * @param string $total    Order total.
			 * @param string $currency Currency code.
			 */
			public function __construct( int $id, string $total, string $currency ) {
				$this->id       = $id;
				$this->total    = $total;
				$this->currency = $currency;
			}

			/** Order id. */
			public function get_id(): int {
				return $this->id;
			}

			/** Order total, as a decimal string. */
			public function get_total(): string {
				return $this->total;
			}

			/** Currency code. */
			public function get_currency(): string {
				return $this->currency;
			}

			/**
			 * Line items.
			 *
			 * @return array<int, object>
			 */
			public function get_items(): array {
				return $this->items;
			}

			/** Creation date, as a `WC_DateTime`-alike. */
			public function get_date_created(): object {
				$created = $this->created;

				return new class( $created ) {
					/**
					 * The ISO-8601 date.
					 *
					 * @var string
					 */
					private string $iso;

					/**
					 * Constructor.
					 *
					 * @param string $iso ISO-8601 date.
					 */
					public function __construct( string $iso ) {
						$this->iso = $iso;
					}

					/**
					 * Format the date.
					 *
					 * @param string $format Date format.
					 */
					public function date( string $format ): string {
						unset( $format );

						return $this->iso;
					}
				};
			}

			/**
			 * One meta value.
			 *
			 * @param string $key Meta key.
			 * @return mixed
			 */
			public function get_meta( string $key ) {
				return $this->meta[ $key ] ?? '';
			}

			/**
			 * Write one meta value.
			 *
			 * @param string $key   Meta key.
			 * @param mixed  $value Meta value.
			 */
			public function update_meta_data( string $key, $value ): void {
				$this->meta[ $key ] = $value;
			}

			/** Persist. */
			public function save(): void {
				++$this->saves;
			}
		};

		$GLOBALS['optionia_test_orders'][ $id ] = $order;

		return $order;
	}

	/**
	 * Look up an order by id, as WooCommerce does.
	 *
	 * Returns `false` for an unknown id -- the behaviour the reporter relies on
	 * to drop an order deleted after it was queued.
	 *
	 * @param mixed $order_id Order id.
	 * @return object|false
	 */
	function wc_get_order( $order_id ) {
		$orders = $GLOBALS['optionia_test_orders'] ?? array();
		$id     = is_numeric( $order_id ) ? (int) $order_id : 0;

		return $orders[ $id ] ?? false;
	}

	function optionia_test_cart(): object {
		return new class() {
			/**
			 * Cart lines, keyed by cart item key.
			 *
			 * **Public, because `WC_Cart::$cart_contents` is public** (WC 11.0.1,
			 * `includes/class-wc-cart.php:46`). Code that writes back to a cart
			 * line -- as `Integration\CartTotals` does to remember a base price
			 * across the hook's several firings -- reaches it this way, so a
			 * private double would make that mechanism untestable and silently
			 * always-skipped.
			 *
			 * @var array<string, array<string, mixed>>
			 */
			public array $cart_contents = array();

			/**
			 * Add a line.
			 *
			 * @param string $key      Cart item key.
			 * @param object $product  Product double.
			 * @param int    $quantity Quantity.
			 * @param array  $data     Extra cart item data, e.g. Optionia selections.
			 */
			public function add_line( string $key, object $product, int $quantity, array $data = array() ): void {
				$this->cart_contents[ $key ] = array_merge(
					$data,
					array(
						'key'      => $key,
						'data'     => $product,
						'quantity' => $quantity,
					)
				);
			}

			/**
			 * The cart lines, as `WC_Cart::get_cart()` returns them.
			 *
			 * @return array<string, array<string, mixed>>
			 */
			public function get_cart(): array {
				return $this->cart_contents;
			}

			/**
			 * One line's computed total, the way `WC_Cart_Totals` computes it.
			 *
			 * @param string $key Cart item key.
			 * @return float Per-unit price times quantity.
			 */
			public function line_total( string $key ): float {
				$item = $this->cart_contents[ $key ];

				return (float) $item['data']->get_price() * (float) $item['quantity'];
			}

			/**
			 * The cart as WooCommerce writes it to the session.
			 *
			 * Mirrors `WC_Cart_Session::get_cart_for_session()` (WC 11.0.1,
			 * `includes/class-wc-cart-session.php`), which copies every line and
			 * unsets exactly one key:
			 *
			 * ```php
			 * $cart_session[ $key ] = $values;
			 * unset( $cart_session[ $key ]['data'] ); // Unset product object.
			 * ```
			 *
			 * The product object is dropped because it is rebuilt on the next
			 * request; **everything else survives**, which is why Optionia's
			 * `cart_item_data` round-trips with no work. Serialised here because
			 * that is what the session table and the persistent-cart user meta
			 * actually store, and because a payload that survives in memory but
			 * not through `serialize()` would be a defect nothing else would
			 * catch.
			 *
			 * @return string The serialised session payload.
			 */
			public function to_session(): string {
				$session = array();

				foreach ( $this->cart_contents as $key => $values ) {
					$session[ $key ] = $values;
					unset( $session[ $key ]['data'] );
				}

				return serialize( $session );
			}

			/**
			 * Rebuild this cart from a session payload, as a new request would.
			 *
			 * The product object is **recreated**, not restored, exactly as
			 * `get_cart_from_session()` does with `wc_get_product()`. That is what
			 * makes a page reload a real test: the price on the product is the
			 * catalogue price again, so anything Optionia set last request is
			 * gone and must be reapplied.
			 *
			 * @param string $payload  A payload from `to_session()`.
			 * @param string $price    The product's current catalogue price.
			 */
			public function from_session( string $payload, string $price = '80.00', ?string $saved = null ): void {
				$this->cart_contents = array();

				$lines = $this->decode( $payload );

				/*
				 * The guest-to-account merge, as `get_cart_from_session()` performs
				 * it (WC 11.0.1, `includes/class-wc-cart-session.php`):
				 *
				 *   $cart = array_merge( $saved_cart, $cart );
				 *
				 * The keys are strings, so colliding lines do **not** sum -- the
				 * later array wins outright, quantity included. `$saved` is the
				 * account's stored cart and `$payload` the guest's, in that order,
				 * because that is the order WooCommerce uses.
				 */
				if ( null !== $saved ) {
					$lines = array_merge( $this->decode( $saved ), $lines );
				}

				foreach ( $lines as $key => $values ) {
					/*
					 * Rebuilt from the variation when there is one, exactly as
					 * `wc_get_product( $values['variation_id'] ? ... : ... )` does.
					 * A variable product's base price lives on the variation, so a
					 * double that always rebuilt the parent could not represent the
					 * one product type where base-price selection is not trivial.
					 */
					$variation_id = isset( $values['variation_id'] ) ? (int) $values['variation_id'] : 0;
					$product_id   = isset( $values['product_id'] ) ? (int) $values['product_id'] : 0;
					$rebuild_id   = $variation_id > 0 ? $variation_id : $product_id;
					$type         = $variation_id > 0 ? 'variation' : 'simple';

					$values['data']              = optionia_test_product( $rebuild_id, $type, $price );
					$this->cart_contents[ $key ] = $values;
				}
			}

			/**
			 * Decode a session payload into cart lines.
			 *
			 * A corrupt payload yields no lines rather than PHP warnings. Not a
			 * production concern -- WooCommerce calls `maybe_unserialize()` itself,
			 * so a corrupt session fails before Optionia sees anything -- but a
			 * double that emits warnings can send a future test author looking for
			 * a production signal that does not exist.
			 *
			 * @param string $payload A serialised session payload.
			 * @return array<string, array<string, mixed>>
			 */
			private function decode( string $payload ): array {
				if ( '' === $payload ) {
					return array();
				}

				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a corrupt payload is a test input, not an error to surface.
				$lines = @unserialize( $payload );

				return is_array( $lines ) ? $lines : array();
			}

			/**
			 * Fire `woocommerce_before_calculate_totals`, as `calculate_totals()` does.
			 *
			 * Callable repeatedly on purpose: `calculate_totals()` has nine call
			 * sites in WC 11.0.1 core, so the hook genuinely fires several times
			 * per request and anything it does must be idempotent.
			 */
			public function calculate_totals(): void {
				do_action( 'woocommerce_before_calculate_totals', $this );
			}
		};
	}

	/**
	 * Whether the store's prices include tax.
	 *
	 * Read by `WC_Cart_Totals` to set `price_includes_tax`. Toggled by tests to
	 * prove the plugin hands over the same figure either way — a plugin that
	 * branched on this would tax twice.
	 */
	function wc_prices_include_tax(): bool {
		return (bool) ( $GLOBALS['optionia_test_prices_include_tax'] ?? false );
	}

	function checked( $checked, $current = true, bool $display = true ): string {
		$result = (string) $checked === (string) $current ? " checked='checked'" : '';

		if ( $display ) {
			echo $result; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- test stub.
		}

		return $result;
	}

	/**
	 * WordPress's `selected()`, the `<option>` counterpart of `checked()`.
	 *
	 * 🔴 **Absent until 2026-09-03, which is why the dropdown template was
	 * unexercised.** Phase 14's first template called it, no test rendered that
	 * template, and the missing stub stayed invisible — the template's very first
	 * test run died on `Call to undefined function selected()`.
	 *
	 * Mirrors `checked()` exactly, including the loose comparison: WordPress
	 * compares with `==`, so `'0'` and `0` match, and a stub that used `===`
	 * would pass tests the real function fails.
	 */
	function selected( $selected, $current = true, bool $display = true ): string {
		$result = (string) $selected === (string) $current ? " selected='selected'" : '';

		if ( $display ) {
			echo $result; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- test stub.
		}

		return $result;
	}

	function esc_html_e( string $text, string $domain = 'default' ): void {
		unset( $domain );

		echo esc_html( $text ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- test stub.
	}

	function wp_remote_request( string $url, array $args = array() ) {
		/*
		 * Counted, so "no request left the process" can be asserted rather than
		 * assumed.
		 *
		 * AC3 says nothing on a customer-facing render may block on the API, and
		 * Phase 10 Stage 3 made `Api\Client` refuse instead of merely logging.
		 * A test for that has to distinguish "the guard refused" from "the guard
		 * returned early for some other reason", and only a count of actual
		 * requests can do that.
		 */
		$GLOBALS['optionia_test_http_calls'][] = array(
			'url'    => $url,
			'method' => $args['method'] ?? 'GET',
		);

		return $GLOBALS['optionia_test_http'];
	}

	function is_wp_error( $thing ): bool {
		return $thing instanceof \WP_Error;
	}

	function wp_remote_retrieve_response_code( $response ): int {
		return (int) ( $response['status'] ?? 0 );
	}

	function wp_remote_retrieve_body( $response ): string {
		return (string) ( $response['body'] ?? '' );
	}

	function wp_remote_retrieve_headers( $response ) {
		return $response['headers'] ?? array();
	}

	function esc_url_raw( string $url ): string {
		return $url;
	}

	function wp_parse_url( string $url, int $component = -1 ) {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.parse_url_parse_url -- this stub *is* the alternative.
		return parse_url( $url, $component );
	}

	function sanitize_text_field( string $text ): string {
		return trim( $text );
	}

	function wp_unslash( $value ) {
		return $value;
	}

	function sanitize_key( string $key ): string {
		return strtolower( preg_replace( '/[^a-zA-Z0-9_\-]/', '', $key ) );
	}

	function admin_url( string $path = '' ): string {
		return 'https://example.test/wp-admin/' . $path;
	}

	function current_user_can( string $capability ): bool {
		unset( $capability );

		return (bool) ( $GLOBALS['optionia_test_can'] ?? true );
	}

	function get_option( string $option, $fallback = false ) {
		// Counted, so M9.2's "≤1 extra DB read per product page" can be measured
		// rather than argued. A stub that only returned the value would leave
		// that acceptance criterion permanently unverifiable.
		$GLOBALS['optionia_test_option_reads'][ $option ] =
			( $GLOBALS['optionia_test_option_reads'][ $option ] ?? 0 ) + 1;

		return $GLOBALS['optionia_test_options'][ $option ] ?? $fallback;
	}

	// phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- signature parity with WordPress.
	function update_option( string $option, $value, $autoload = null ): bool {
		$GLOBALS['optionia_test_options'][ $option ] = $value;

		// Recorded, not discarded. M8.4 requires the credential -- and by
		// extension every option this plugin writes -- to be autoload-off: an
		// autoloaded option is read on every page load of the entire site, so a
		// slip here is a sitewide performance regression that ships silently.
		// A stub that ignored this argument made that unverifiable.
		$GLOBALS['optionia_test_autoload'][ $option ] = $autoload;

		return true;
	}

	function delete_option( string $option ): bool {
		unset( $GLOBALS['optionia_test_options'][ $option ] );

		return true;
	}

	/*
	 * A v4-shaped UUID, distinct on every call.
	 *
	 * 🔴 **Not built on `wp_rand`, and that is the whole point.** This harness's
	 * `wp_rand()` returns `$min` so that tests are deterministic -- so a UUID
	 * composed from it is the *same string every time*, and any guard that
	 * distinguishes one identity from another becomes untestable. Measured:
	 * `CatalogueCursor`'s run-id guard, which stops a late response from a
	 * previous walk advancing the current one, passed trivially until this
	 * counter replaced it.
	 *
	 * A counter rather than real randomness: distinctness is the property under
	 * test, and a reproducible sequence is worth more in a harness than entropy.
	 */
	/**
	 * A post's type, as WordPress reports it.
	 *
	 * 🔴 **Defaults to `post`, not `product`.** `Catalogue\ProductWatcher`
	 * listens to WordPress's `trashed_post` and `before_delete_post`, which fire
	 * for **every** post type — a page, a menu item, an order — and the filter
	 * to products is what stops an unrelated deletion queueing a product sync.
	 * A stub answering `product` for everything would leave that filter
	 * unexercised, which is the whole reason it exists.
	 *
	 * @param int $post_id Post id.
	 * @return string|false
	 */
	function get_post_type( int $post_id = 0 ) {
		return $GLOBALS['optionia_test_post_types'][ $post_id ] ?? 'post';
	}

	function wp_generate_uuid4(): string {
		static $counter = 0;

		++$counter;

		return sprintf(
			'00000000-0000-4000-8000-%012x',
			$counter
		);
	}

	/*
	 * Post meta, counted the same way options are.
	 *
	 * Phase 10 Stage 2 decides where the product index lives, and M9.2's
	 * acceptance -- "<=1 extra DB read per product page" -- has to be measurable
	 * against whichever store is chosen. Until these existed the harness could
	 * only see `get_option`, so an index in post meta would have satisfied
	 * `ConfigReadBudgetTest` while a shop page performed twenty-five meta reads:
	 * a green check measuring a quantity the code no longer used.
	 *
	 * They are defined even though the index landed in an option, because the
	 * budget test is only honest if it counts what it does *not* expect to see
	 * as well as what it does.
	 */
	function get_post_meta( int $post_id, string $key = '', bool $single = false ) {
		$GLOBALS['optionia_test_meta_reads'][ $key ] =
			( $GLOBALS['optionia_test_meta_reads'][ $key ] ?? 0 ) + 1;

		$value = $GLOBALS['optionia_test_meta'][ $post_id ][ $key ] ?? null;

		if ( null === $value ) {
			// WordPress returns '' for a single miss and array() otherwise.
			return $single ? '' : array();
		}

		return $single ? $value : array( $value );
	}

	function update_post_meta( int $post_id, string $key, $value ): bool {
		$GLOBALS['optionia_test_meta'][ $post_id ][ $key ] = $value;
		$GLOBALS['optionia_test_meta_writes'][ $key ]      =
			( $GLOBALS['optionia_test_meta_writes'][ $key ] ?? 0 ) + 1;

		return true;
	}

	function delete_post_meta( int $post_id, string $key ): bool {
		unset( $GLOBALS['optionia_test_meta'][ $post_id ][ $key ] );

		return true;
	}

	/**
	 * Taxonomy reads, counted the way post meta is.
	 *
	 * 🔴 **`ConfigReadBudgetTest` could not see a taxonomy read at all.** It
	 * counts `get_option` and `get_post_meta`, and no term function was stubbed
	 * or counted — so once ADR-068 puts taxonomy resolution in the plugin, a
	 * `has_term()` call would **pass the budget test while performing
	 * queries**.
	 *
	 * ⚠️ **That is the same blind spot the budget test exists to close**, one
	 * dimension over. Its own note records the first instance: `get_post_meta`
	 * was undefined, so an index stored there *"would have satisfied the budget
	 * while a shop page performed twenty-five meta reads — a check inspecting
	 * nothing, inside the test written to prevent exactly that."*
	 *
	 * Defined before any taxonomy code exists, deliberately. A counter added
	 * alongside the feature it measures is a counter written by someone who
	 * already knows the answer.
	 *
	 * @param int    $post_id  The product.
	 * @param string $taxonomy Taxonomy name.
	 * @return array<int, object>|false Terms, or false when there are none.
	 */
	function get_the_terms( int $post_id, string $taxonomy ) {
		$GLOBALS['optionia_test_term_reads'][ $taxonomy ] =
			( $GLOBALS['optionia_test_term_reads'][ $taxonomy ] ?? 0 ) + 1;

		$terms = $GLOBALS['optionia_test_terms'][ $post_id ][ $taxonomy ] ?? array();

		if ( array() === $terms ) {
			// WordPress returns false, not an empty array, when a post has none.
			return false;
		}

		return array_map(
			static function ( $slug ): object {
				return (object) array(
					'slug' => (string) $slug,
					'name' => (string) $slug,
				);
			},
			$terms
		);
	}

	/**
	 * Whether a product carries a term.
	 *
	 * ⚠️ **Counted through `get_the_terms`, not separately.** WordPress's own
	 * `has_term()` resolves through the term cache the same way, so counting it
	 * twice would report two reads where a product page performs one — and a
	 * budget test that overstates is as useless as one that understates.
	 *
	 * @param string|array<int, string> $term     Slug or slugs to look for.
	 * @param string                    $taxonomy Taxonomy name.
	 * @param int                       $post_id  The product.
	 */
	function has_term( $term, string $taxonomy, int $post_id ): bool {
		$terms = get_the_terms( $post_id, $taxonomy );

		if ( false === $terms ) {
			return false;
		}

		$slugs  = array_map( static fn( object $found ): string => $found->slug, $terms );
		$wanted = is_array( $term ) ? $term : array( $term );

		foreach ( $wanted as $one ) {
			if ( in_array( (string) $one, $slugs, true ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Attach terms to a product, for a test that needs some.
	 *
	 * Not a WordPress function — the harness's own seeder, named to read like
	 * one. Writes are not counted: the budget is about what a *page render*
	 * costs, and no render writes a term.
	 *
	 * @param int                  $post_id  The product.
	 * @param string               $taxonomy Taxonomy name.
	 * @param array<int, string>   $slugs    Term slugs.
	 */
	function optionia_test_set_terms( int $post_id, string $taxonomy, array $slugs ): void {
		$GLOBALS['optionia_test_terms'][ $post_id ][ $taxonomy ] = $slugs;
	}

	function wc_get_price_decimals(): int {
		return isset( $GLOBALS['optionia_test_decimals'] )
			? (int) $GLOBALS['optionia_test_decimals']
			: 2;
	}

	/*
	 * 🔴 **Currency formatting, stubbed so the difference is observable.**
	 *
	 * `OptionView::money()` reads these; without them it falls back to no symbol
	 * and `.`/`,`, which is **exactly what the wire format produces** — so a test
	 * asserting the cart formats "the storefront way" passed whichever formatter
	 * it used. Measured: reverting `CartDisplay` to the wire format killed no
	 * test until these existed.
	 */
	function get_woocommerce_currency_symbol( string $currency = '' ): string {
		/*
		 * `$currency` is unused and must stay: WooCommerce's own signature takes
		 * it, and a stub that dropped it would accept calls the real function
		 * refuses — which is the harness-fidelity defect `CartHarnessFidelityTest`
		 * exists for.
		 */
		unset( $currency );

		return (string) ( $GLOBALS['optionia_test_currency_symbol'] ?? '£' );
	}

	function wc_get_price_decimal_separator(): string {
		return (string) ( $GLOBALS['optionia_test_decimal_separator'] ?? '.' );
	}

	function wc_get_price_thousand_separator(): string {
		return (string) ( $GLOBALS['optionia_test_thousand_separator'] ?? ',' );
	}
}

if ( ! function_exists( 'wc_format_decimal' ) ) {
	/**
	 * Normalise a decimal string.
	 *
	 * @param mixed $value    Raw value.
	 * @param int   $decimals Decimal places.
	 */
	function wc_format_decimal( $value, int $decimals = 2 ): string {
		return number_format( (float) $value, $decimals, '.', '' );
	}
}

if ( ! function_exists( 'wp_next_scheduled' ) ) {
	/**
	 * Scheduled-event stubs.
	 *
	 * These record real state rather than returning a fixed value: a stub that
	 * always answered "not scheduled" would let a test assert an event was
	 * created while the code created nothing, and one that always answered
	 * "scheduled" would hide a missing schedule entirely.
	 *
	 * @param string $hook Hook name.
	 * @return int|false Timestamp, or false when unscheduled.
	 */
	function wp_next_scheduled( string $hook ) {
		return $GLOBALS['optionia_test_cron'][ $hook ]['timestamp'] ?? false;
	}

	/**
	 * Schedule a recurring event.
	 *
	 * @param int    $timestamp  First run.
	 * @param string $recurrence Schedule name.
	 * @param string $hook       Hook name.
	 * @param array  $args       Arguments.
	 * @param bool   $wp_error   Whether to return WP_Error on failure.
	 * @return bool|\WP_Error
	 */
	function wp_schedule_event( int $timestamp, string $recurrence, string $hook, array $args = array(), bool $wp_error = false ) {
		unset( $args );

		// Core refuses an unregistered recurrence. The registered set is the
		// core schedules plus whatever the `cron_schedules` filter has added,
		// which is precisely what Scheduler attaches itself for.
		$schedules = apply_filters( 'cron_schedules', array() );

		$known = array_merge(
			array( 'hourly', 'twicedaily', 'daily', 'weekly' ),
			array_keys( is_array( $schedules ) ? $schedules : array() )
		);

		if ( ! in_array( $recurrence, $known, true ) ) {
			return $wp_error ? new \WP_Error( 'invalid_schedule', 'Unregistered recurrence.' ) : false;
		}

		$GLOBALS['optionia_test_cron'][ $hook ] = array(
			'timestamp'  => $timestamp,
			'recurrence' => $recurrence,
		);

		return true;
	}

	/**
	 * Clear a scheduled hook.
	 *
	 * @param string $hook Hook name.
	 */
	function wp_clear_scheduled_hook( string $hook ): void {
		unset( $GLOBALS['optionia_test_cron'][ $hook ] );
	}
}

if ( ! class_exists( 'Optionia_Test_Halt' ) ) {
	/**
	 * Thrown by the `wp_die()` and `wp_redirect()`+`exit` stubs.
	 *
	 * Both terminate the request in WordPress. A stub that merely returned
	 * would let execution continue past a guard that had in fact stopped it --
	 * so a test could "pass" through code the real handler never reaches.
	 */
	class Optionia_Test_Halt extends \RuntimeException {}
}

if ( ! function_exists( 'wp_verify_nonce' ) ) {
	/**
	 * Verify a nonce.
	 *
	 * The stub accepts only the value `wp_create_nonce()` would have produced
	 * for that action, so a test that forgets the nonce fails like the real
	 * request would.
	 *
	 * @param string $nonce  Presented value.
	 * @param string $action Action name.
	 * @return int|false
	 */
	function wp_verify_nonce( string $nonce, string $action = '' ) {
		return hash_equals( 'nonce:' . $action, $nonce ) ? 1 : false;
	}

	/**
	 * Create a nonce.
	 *
	 * @param string $action Action name.
	 */
	function wp_create_nonce( string $action = '' ): string {
		return 'nonce:' . $action;
	}

	/**
	 * Terminate the request.
	 *
	 * @param string $message Message.
	 * @param string $title   Title.
	 * @param array  $args    Arguments.
	 * @throws \Optionia_Test_Halt Always.
	 */
	function wp_die( string $message = '', string $title = '', array $args = array() ): void {
		unset( $title, $args );

		throw new \Optionia_Test_Halt( 'wp_die: ' . $message );
	}

	/**
	 * Redirect.
	 *
	 * Records the target, then halts: callers follow this with `exit`, and a
	 * returning stub would run code the real request never reaches.
	 *
	 * @param string $location Target URL.
	 * @throws \Optionia_Test_Halt Always.
	 */
	function wp_redirect( string $location ): void {
		$GLOBALS['optionia_test_redirect'] = $location;

		throw new \Optionia_Test_Halt( 'redirect: ' . $location );
	}

	/**
	 * Safe redirect.
	 *
	 * @param string $location Target URL.
	 */
	function wp_safe_redirect( string $location ): void {
		wp_redirect( $location );
	}
}

if ( ! function_exists( 'human_time_diff' ) ) {
	/**
	 * Human-readable difference between two timestamps.
	 *
	 * Absent from the harness until now, which made `Admin\SystemStatus`
	 * impossible to test at all: every row calling it fatalled, so the class
	 * had no tests and a bug in it would have shipped past every green gate.
	 *
	 * Mirrors core's granularity closely enough to assert on -- and, like core,
	 * takes the absolute difference so argument order cannot silently invert a
	 * result.
	 *
	 * @param int      $from Earlier timestamp.
	 * @param int|null $to   Later timestamp; defaults to now.
	 */
	function human_time_diff( int $from, ?int $to = null ): string {
		$to   = null === $to ? time() : $to;
		$diff = abs( $to - $from );

		if ( $diff < HOUR_IN_SECONDS ) {
			$mins = max( 1, (int) round( $diff / MINUTE_IN_SECONDS ) );

			return $mins . ' min';
		}

		if ( $diff < DAY_IN_SECONDS ) {
			$hours = max( 1, (int) round( $diff / HOUR_IN_SECONDS ) );

			return $hours . ' hour' . ( 1 === $hours ? '' : 's' );
		}

		$days = max( 1, (int) round( $diff / DAY_IN_SECONDS ) );

		return $days . ' day' . ( 1 === $days ? '' : 's' );
	}

	/**
	 * Format a byte count.
	 *
	 * @param int $bytes    Byte count.
	 * @param int $decimals Decimal places.
	 */
	function size_format( int $bytes, int $decimals = 0 ): string {
		if ( $bytes < 1024 ) {
			return $bytes . ' B';
		}

		if ( $bytes < 1024 * 1024 ) {
			return number_format( $bytes / 1024, $decimals ) . ' KB';
		}

		return number_format( $bytes / ( 1024 * 1024 ), $decimals ) . ' MB';
	}
}

if ( ! function_exists( 'is_multisite' ) ) {
	/**
	 * Whether this is a network install.
	 */
	function is_multisite(): bool {
		return (bool) ( $GLOBALS['optionia_test_multisite'] ?? false );
	}

	/**
	 * Fetch a post.
	 *
	 * @param int $id Post ID.
	 * @return object|null
	 */
	function get_post( int $id = 0 ) {
		return $GLOBALS['optionia_test_posts'][ $id ] ?? null;
	}

	/**
	 * Whether a block is present in a post.
	 *
	 * @param string      $block Block name.
	 * @param object|null $post  Post object.
	 */
	function has_block( string $block, $post = null ): bool {
		if ( null === $post || ! isset( $post->post_content ) ) {
			return false;
		}

		return false !== strpos( (string) $post->post_content, '<!-- wp:' . $block );
	}
}

if ( ! function_exists( 'dbDelta' ) ) {
	/**
	 * Record the schema statements instead of executing them.
	 *
	 * Real dbDelta diffs a live schema; there is no database here. Recording
	 * the SQL is enough to assert what the migration *would* do -- which table,
	 * and that an upgrade re-runs it -- without pretending to be MySQL.
	 *
	 * phpcs:disable WordPress.NamingConventions.ValidFunctionName.FunctionNameInvalid
	 *
	 * @param string $sql Schema statement.
	 * @return array<string, string>
	 */
	function dbDelta( string $sql ): array {
		$GLOBALS['optionia_test_schema'][] = $sql;

		return array();
	}
	// phpcs:enable WordPress.NamingConventions.ValidFunctionName.FunctionNameInvalid

	/**
	 * Add an option only when absent.
	 *
	 * @param string $option   Option name.
	 * @param mixed  $value    Value.
	 * @param string $obsolete Unused, kept for signature parity.
	 * @param bool   $autoload Autoload flag.
	 */
	function add_option( string $option, $value = '', string $obsolete = '', $autoload = null ): bool {
		unset( $obsolete );

		if ( isset( $GLOBALS['optionia_test_options'][ $option ] ) ) {
			return false;
		}

		$GLOBALS['optionia_test_options'][ $option ]  = $value;
		$GLOBALS['optionia_test_autoload'][ $option ] = $autoload;

		return true;
	}

	/**
	 * Record a deactivation rather than performing one.
	 *
	 * @param string|string[] $plugins Plugin file(s).
	 */
	function deactivate_plugins( $plugins ): void {
		$GLOBALS['optionia_test_deactivated'][] = $plugins;
	}

	/**
	 * Basename of a plugin file.
	 *
	 * @param string $file Absolute path.
	 */
	function plugin_basename( string $file ): string {
		return basename( dirname( $file ) ) . '/' . basename( $file );
	}

	/**
	 * Rewrite rules are not used yet; record the flush.
	 */
	function flush_rewrite_rules(): void {
		$GLOBALS['optionia_test_flushed'] = true;
	}
}

/*
 * `$wpdb`'s output-format constants.
 *
 * Defined here because `Upload\UploadRepository` asks for `ARRAY_A`, and a
 * missing constant is a fatal rather than a failing assertion — which is how it
 * would first be seen by whoever writes the next repository test.
 */
if ( ! defined( 'ARRAY_A' ) ) {
	define( 'ARRAY_A', 'ARRAY_A' );
}

if ( ! defined( 'ARRAY_N' ) ) {
	define( 'ARRAY_N', 'ARRAY_N' );
}

if ( ! defined( 'OBJECT' ) ) {
	define( 'OBJECT', 'OBJECT' );
}

if ( ! class_exists( 'Optionia_Test_Wpdb' ) ) {
	/**
	 * The narrow slice of `$wpdb` the activation path touches.
	 *
	 * Queries are recorded, never executed. `Activator` only builds a table
	 * name and hands SQL to dbDelta, so nothing here needs a real connection.
	 */
	class Optionia_Test_Wpdb {

		/**
		 * Table prefix.
		 *
		 * @var string
		 */
		public string $prefix = 'wptests_';

		/**
		 * Statements passed to query().
		 *
		 * @var string[]
		 */
		public array $queries = array();

		/**
		 * Interpolate a query the way `$wpdb->prepare()` does.
		 *
		 * ⚠️ **Deliberately naive.** The stub records queries; it does not need
		 * real escaping, and pretending to provide it would invite a test to
		 * assert on the escaping rather than on behaviour.
		 *
		 * @param string $query Query with placeholders.
		 * @param mixed  ...$args Values.
		 */
		public function prepare( string $query, ...$args ): string {
			foreach ( $args as $arg ) {
				$query = preg_replace( '/%[sdf]/', (string) $arg, $query, 1 ) ?? $query;
			}

			return $query;
		}

		/**
		 * The row the next `get_row()` should return.
		 *
		 * ⚠️ **Defaults to an empty session**, so a test that does not care about
		 * the quota gets one that permits. A default that refused would make
		 * every success-path test fail for a reason it was not testing.
		 *
		 * ⚠️ **`array|null`, matching the real return type.** `wpdb::get_row()`
		 * answers `null` when nothing matched, and `UploadRepository` turns that
		 * into "no such upload". Typed `array`, the stub could not express a
		 * missing row at all — so a token naming no file looked exactly like a
		 * token naming one.
		 *
		 * @var array<string, mixed>|null
		 */
		public $rows = array(
			'n' => 0,
			'b' => 0,
		);

		/**
		 * One row of a result set.
		 *
		 * @param string $query  Ignored; the stub returns what a test set.
		 * @param string $output Ignored.
		 * @return array<string, mixed>
		 */
		public function get_row( string $query = '', string $output = 'OBJECT' ) {
			// The signature mirrors `$wpdb`; the stub returns what a test set.
			unset( $output );

			$this->queries[] = $query;

			/*
			 * ⚠️ **A test may answer differently per row.** `$rows` alone cannot
			 * describe an order holding *two* files, because every lookup would
			 * return the same one — and "two files with the same name collide in
			 * a zip" is exactly the case that needs two. `prepare()` interpolates
			 * bound values, so the token being asked for is in the query text.
			 */
			foreach ( $this->rows_by_token as $token => $row ) {
				if ( false !== strpos( $query, (string) $token ) ) {
					return $row;
				}
			}

			return array() === $this->rows_by_token ? $this->rows : null;
		}

		/**
		 * Rows to answer with, keyed by the token each belongs to.
		 *
		 * @var array<string, array<string, mixed>>
		 */
		public array $rows_by_token = array();

		/**
		 * Rows the next `update()` should report as affected.
		 *
		 * ⚠️ Defaults to 1 — a successful claim — so a test that does not care
		 * about failure gets the ordinary case.
		 *
		 * @var int
		 */
		public int $updated = 1;

		/**
		 * Every update requested, as (table, data, where).
		 *
		 * @var array<int, array<string, mixed>>
		 */
		public array $updates = array();

		/**
		 * Record an update and report how many rows it touched.
		 *
		 * @param string               $table  Table name.
		 * @param array<string, mixed> $data   New values.
		 * @param array<string, mixed> $where  Which rows.
		 * @param array<int, string>   $format Value formats.
		 * @param array<int, string>   $wformat Where formats.
		 */
		public function update( string $table, array $data, array $where, array $format = array(), array $wformat = array() ) {
			// The signature mirrors `$wpdb`; formats are not exercised here.
			unset( $format, $wformat );

			$this->updates[] = array(
				'table' => $table,
				'data'  => $data,
				'where' => $where,
			);

			return $this->updated;
		}
		/**
		 * Whether the next `insert()` succeeds.
		 *
		 * ⚠️ **This knob is why `not_recorded` was untestable.** `insert()`
		 * returned a hardcoded 1, so `UploadRepository::create()` could never
		 * answer `''` and the endpoint's "the row failed after the bytes landed"
		 * branch had no way to run. Removing that branch left the whole suite
		 * green while the endpoint answered 201 with an empty token and left an
		 * orphan on disk.
		 *
		 * @var bool
		 */
		public bool $inserts = true;

		/**
		 * Every insert requested, as (table, data).
		 *
		 * @var array<int, array<string, mixed>>
		 */
		public array $inserted = array();

		/**
		 * Record an insert and report success.
		 *
		 * @param string               $table  Table name.
		 * @param array<string, mixed> $data   Row values.
		 * @param array<int, string>   $format Value formats.
		 */
		public function insert( string $table, array $data, array $format = array() ) {
			// The signature mirrors `$wpdb`; formats are not exercised here.
			unset( $format );

			/*
			 * ⚠️ **The row is kept, not discarded.** This stub recorded only the
			 * table name, so no test could see what was actually written — and
			 * `size_bytes` disagreeing with the file on disk was invisible for
			 * exactly that reason.
			 */
			$this->inserted[] = array(
				'table' => $table,
				'data'  => $data,
			);

			$this->queries[] = 'INSERT ' . $table;

			return $this->inserts ? 1 : false;
		}

		/**
		 * The value the next `get_var()` should return.
		 *
		 * Used for `UploadRepository::owner_of()`: which order, if any, already
		 * owns a token. Null means no row.
		 *
		 * @var mixed
		 */
		public $var = null;

		/**
		 * One value from a result set.
		 *
		 * @param string $query Ignored; the stub returns what a test set.
		 * @return mixed
		 */
		public function get_var( string $query = '' ) {
			$this->queries[] = $query;

			return $this->var;
		}

		/**
		 * Rows the next `get_results()` should return.
		 *
		 * ⚠️ **`UploadRepository::expired()` was uncallable in a test** until
		 * this existed: the stub had no `get_results()` at all, so the method
		 * with no production callers also had no way to be exercised.
		 *
		 * @var array<int, array<string, mixed>>
		 */
		public array $results = array();

		/**
		 * A result set.
		 *
		 * @param string $query  Ignored; the stub returns what a test set.
		 * @param string $output Ignored.
		 * @return array<int, array<string, mixed>>
		 */
		public function get_results( string $query = '', string $output = 'OBJECT' ): array {
			unset( $output );

			$this->queries[] = $query;

			return $this->results;
		}

		/**
		 * Every delete requested, as (table, where).
		 *
		 * @var array<int, array<string, mixed>>
		 */
		public array $deletes = array();

		/**
		 * Whether the next `delete()` reports success.
		 *
		 * @var bool
		 */
		public bool $deleted = true;

		/**
		 * Record a delete.
		 *
		 * @param string               $table   Table name.
		 * @param array<string, mixed> $where   Which rows.
		 * @param array<int, string>   $wformat Where formats.
		 * @return int|false
		 */
		public function delete( string $table, array $where, array $wformat = array() ) {
			unset( $wformat );

			$this->deletes[] = array(
				'table' => $table,
				'where' => $where,
			);

			return $this->deleted ? 1 : false;
		}

		/**
		 * Escape a value for use inside a LIKE pattern.
		 *
		 * @param string $text Raw value.
		 */
		public function esc_like( string $text ): string {
			return addcslashes( $text, '_%\\' );
		}

		/**
		 * Column values the next `get_col()` should return.
		 *
		 * ⚠️ **Set by a test to say what the upload table knows.** The sweeper's
		 * whole job is deciding which files on disk have no row, so the list of
		 * known names *is* the input under test.
		 *
		 * @var string[]
		 */
		public array $columns = array();

		/**
		 * One column of a result set.
		 *
		 * @param string $query Ignored; the stub returns what a test set.
		 * @return string[]
		 */
		public function get_col( string $query = '' ): array {
			$this->queries[] = $query;

			return $this->columns;
		}

		/**
		 * Charset and collation clause.
		 */
		public function get_charset_collate(): string {
			return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
		}

		/**
		 * Rows the next `query()` should report as affected.
		 *
		 * ⚠️ **Defaults to 1**, because `UploadRepository::claim()` runs its
		 * conditional UPDATE through `query()` — `$wpdb->update()`'s `$where` is
		 * an equality map and cannot express `order_id IS NULL`. A default of 0
		 * would make every promotion look like a refused claim.
		 *
		 * ⚠️ **`int|false`, matching the real return type.** `wpdb::query()`
		 * answers `false` only when the statement errored, so a test that could
		 * not set `false` could not reach the branch telling a database failure
		 * apart from an ordinary "no row matched".
		 *
		 * @var int|false
		 */
		public $affected = 1;

		/**
		 * Record a query and report how many rows it touched.
		 *
		 * @param string $sql Statement.
		 * @return int|false
		 */
		public function query( string $sql ) {
			$this->queries[] = $sql;

			/*
			 * ⚠️ **A guarded insert is still an insert.** `UploadRepository::create()`
			 * writes through `query()` rather than `insert()`, because its quota
			 * ceilings live in the statement's `WHERE` — so a stub that recorded
			 * only `insert()` calls stopped seeing the row that was written, and
			 * every assertion about a stored row went blind at once.
			 *
			 * The bound values are interpolated by `prepare()` above, so the
			 * statement text is what a test can read.
			 */
			if ( false !== stripos( $sql, 'INSERT INTO' ) ) {
				$this->inserted[] = array(
					'table' => 'query',
					'data'  => array( 'sql' => $sql ),
				);

				return $this->inserts ? $this->affected : false;
			}

			return $this->affected;
		}
	}
}

if ( ! function_exists( 'register_rest_route' ) ) {
	/**
	 * Record a REST route rather than registering one.
	 *
	 * `Connection\PushEndpoint` declares the route the cloud pushes to, and a
	 * stub that discarded the arguments would leave "is it registered, on which
	 * method, with which callback" unassertable — the parts that decide whether
	 * a push can arrive at all.
	 *
	 * @param string $route_namespace Route namespace.
	 * @param string $route     Route path.
	 * @param array  $args      Route arguments.
	 */
	function register_rest_route( string $route_namespace, string $route, array $args = array() ): bool {
		$GLOBALS['optionia_test_rest_routes'][ $route_namespace . $route ] = $args;

		return true;
	}

	/**
	 * The URL a REST route lives at.
	 *
	 * @param string $path Route path, including namespace.
	 */
	function rest_url( string $path = '' ): string {
		return 'https://shop.example.test/wp-json/' . ltrim( $path, '/' );
	}
}

if ( ! class_exists( 'WP_REST_Request' ) ) {
	/**
	 * The slice of WordPress's request object the push endpoint reads.
	 *
	 * Header names arrive normalised — WordPress lowercases and underscores
	 * them — so the stub does the same, or a test would pass against a lookup
	 * that never matches in production.
	 */
	class WP_REST_Request {

		/**
		 * Headers, keyed as WordPress keys them.
		 *
		 * @var array<string, string>
		 */
		private array $headers;

		/**
		 * Raw body.
		 *
		 * @var string
		 */
		private string $body;

		/**
		 * Constructor.
		 *
		 * @param array<string, string> $headers Request headers.
		 * @param string                $body    Raw body.
		 */
		/**
		 * Parameters, as the router would supply them.
		 *
		 * @var array<string, mixed>
		 */
		public array $params = array();

		/**
		 * Uploaded files, in `$_FILES` shape.
		 *
		 * @var array<string, mixed>
		 */
		public array $files = array();

		public function __construct( array $headers = array(), string $body = '' ) {
			$this->headers = array();

			foreach ( $headers as $name => $value ) {
				$this->headers[ strtolower( str_replace( '-', '_', $name ) ) ] = $value;
			}

			$this->body = $body;
		}

		/**
		 * One header, or null when absent.
		 *
		 * @param string $name Header name.
		 */
		public function get_header( string $name ): ?string {
			return $this->headers[ strtolower( str_replace( '-', '_', $name ) ) ] ?? null;
		}

		/**
		 * The raw body.
		 */
		/**
		 * A query or body parameter.
		 *
		 * ⚠️ **Added for M15.2's upload route**, which is the first endpoint here
		 * to read parameters rather than a raw body. `Connection\PushEndpoint`
		 * verifies a signature over `get_body()` and needs nothing else, so the
		 * stub never had these — and an endpoint that calls them would have
		 * fataled in a test rather than failing an assertion.
		 *
		 * @param string $name Parameter name.
		 * @return mixed
		 */
		public function get_param( string $name ) {
			return $this->params[ $name ] ?? null;
		}

		/**
		 * Set a parameter, as the router would.
		 *
		 * @param string $name  Parameter name.
		 * @param mixed  $value Value.
		 */
		public function set_param( string $name, $value ): void {
			$this->params[ $name ] = $value;
		}

		/**
		 * Uploaded files, in `$_FILES` shape.
		 *
		 * @return array<string, mixed>
		 */
		public function get_file_params(): array {
			return $this->files;
		}

		/**
		 * Set the uploaded files.
		 *
		 * @param array<string, mixed> $files `$_FILES`-shaped array.
		 */
		public function set_file_params( array $files ): void {
			$this->files = $files;
		}

		public function get_body(): string {
			return $this->body;
		}
	}

	/**
	 * The slice of WordPress's response object the push endpoint writes.
	 */
	class WP_REST_Response {

		/**
		 * Response payload.
		 *
		 * @var mixed
		 */
		public $data;

		/**
		 * HTTP status.
		 *
		 * @var int
		 */
		public int $status;

		/**
		 * Constructor.
		 *
		 * @param mixed $data   Payload.
		 * @param int   $status HTTP status.
		 */
		public function __construct( $data = null, int $status = 200 ) {
			$this->data   = $data;
			$this->status = $status;
		}

		/**
		 * The status this response carries.
		 */
		public function get_status(): int {
			return $this->status;
		}

		/**
		 * The payload this response carries.
		 *
		 * @return mixed
		 */
		public function get_data() {
			return $this->data;
		}
	}
}

if ( ! function_exists( 'wp_max_upload_size' ) ) {
	/**
	 * The host's upload ceiling.
	 *
	 * Defaults to 2 MB as a plausible shared host, **not** as a measurement.
	 *
	 * ✏️ This said "that is what the development site actually reports", which
	 * was read from `ini_get()` through the CLI binary. Over HTTP the same site
	 * reports 2 GB. The stub keeps 2 MB because a generous fixture would let a
	 * missing size check pass — a low ceiling is what makes the tests bite.
	 *
	 * @return int
	 */
	function wp_max_upload_size(): int {
		return $GLOBALS['optionia_test_max_upload'] ?? 2097152;
	}
}

if ( ! function_exists( 'wp_upload_dir' ) ) {
	/**
	 * The uploads directory.
	 *
	 * @return array<string, mixed>
	 */
	function wp_upload_dir(): array {
		if ( isset( $GLOBALS['optionia_test_upload_dir'] ) ) {
			return $GLOBALS['optionia_test_upload_dir'];
		}

		$base = sys_get_temp_dir() . '/optionia-test-uploads';

		return array(
			'basedir' => $base,
			'baseurl' => 'https://example.test/wp-content/uploads',
			'error'   => false,
		);
	}
}

if ( ! function_exists( 'wp_mkdir_p' ) ) {
	/**
	 * Recursively create a directory.
	 *
	 * @param string $dir Target.
	 */
	function wp_mkdir_p( string $dir ): bool {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_mkdir -- this stub *is* the WP function under test conditions.
		return is_dir( $dir ) || mkdir( $dir, 0777, true );
	}
}

if ( ! function_exists( 'wp_salt' ) ) {
	/**
	 * A site-specific secret.
	 *
	 * Fixed in tests so the derived directory name is deterministic; the real
	 * function returns a value unique per site, which is what makes the path
	 * unguessable in production.
	 *
	 * @param string $scheme Salt scheme.
	 */
	function wp_salt( string $scheme = 'auth' ): string {
		return 'optionia-test-salt-' . $scheme;
	}
}

if ( ! function_exists( 'WC' ) ) {
	/**
	 * WooCommerce's global accessor, with just enough session for uploads.
	 *
	 * 🔴 **Its absence hid the endpoint's success path.** `UploadQuota` needs a
	 * session key to bound abuse per visitor, and without `WC()` it correctly
	 * answers `''` — so every attempt to store a file in a test refused with
	 * `no_session`, and no test could reach the code that actually stores one.
	 *
	 * The refusal was right; the coverage was not. A guard that refuses
	 * everything passes the same tests as a guard that works.
	 *
	 * @return object
	 */
	// phpcs:ignore WordPress.NamingConventions.ValidFunctionName.FunctionNameInvalid -- WooCommerce's own global accessor; renaming it would stub the wrong function.
	function WC(): object {
		if ( ! isset( $GLOBALS['optionia_test_wc'] ) ) {
			$GLOBALS['optionia_test_wc'] = new class() {
				/**
				 * The session, or null to simulate a request without one.
				 *
				 * @var object|null
				 */
				public $session;

				/**
				 * Start with a session, as a storefront request has.
				 */
				public function __construct() {
					$this->session = new class() {
						/**
						 * The customer id this session reports.
						 *
						 * @var string
						 */
						public string $id = 't_testsession';

						/**
						 * Whether a session cookie was set.
						 */
						public function has_session(): bool {
							return true;
						}

						/**
						 * Set the customer session cookie.
						 *
						 * @param bool $set Whether to set it.
						 */
						public function set_customer_session_cookie( bool $set ): void {
							unset( $set );
						}

						/**
						 * How many times the session key was asked for.
						 *
						 * ⚠️ **Counted so laziness is provable.**
						 * `UploadQuota::session_key()` is not a pure read — it
						 * sets a session cookie when none exists — and a caller
						 * that resolves it before knowing whether it needs one
						 * does that work on every cart view. Without a counter a
						 * test cannot tell "asked and ignored" from "never
						 * asked".
						 *
						 * @var int
						 */
						public int $reads = 0;

						/**
						 * The session key `UploadQuota` bounds against.
						 */
						public function get_customer_id(): string {
							++$this->reads;

							return $this->id;
						}
					};
				}
			};
		}

		return $GLOBALS['optionia_test_wc'];
	}
}

if ( ! function_exists( 'absint' ) ) {
	/**
	 * A non-negative integer.
	 *
	 * @param mixed $maybeint Value to convert.
	 */
	function absint( $maybeint ): int {
		return abs( (int) $maybeint );
	}
}

if ( ! function_exists( 'wp_generate_password' ) ) {
	/**
	 * Random characters, as WordPress produces for temporary names.
	 *
	 * @param int  $length        How many characters.
	 * @param bool $special_chars Ignored; callers here ask for none.
	 */
	function wp_generate_password( int $length = 12, bool $special_chars = true ): string {
		unset( $special_chars );

		return substr( bin2hex( random_bytes( (int) ceil( $length / 2 ) ) ), 0, $length );
	}
}

if ( ! function_exists( 'wp_tempnam' ) ) {
	/**
	 * A writable temporary path, in the directory the caller names.
	 *
	 * ⚠️ **Honours `$dir`, as WordPress does.** `UploadArchive` builds inside the
	 * *guarded* upload directory rather than the system temp directory, so a stub
	 * that ignored the argument would put an archive of every file on the order
	 * somewhere world-readable and the test would not notice.
	 *
	 * @param string $filename Suggested name.
	 * @param string $dir      Directory to create it in.
	 */
	function wp_tempnam( string $filename = '', string $dir = '' ): string {
		$dir  = '' === $dir ? sys_get_temp_dir() : rtrim( $dir, '/\\' );
		$stem = preg_replace( '/\.[^.]*$/', '', basename( $filename ) );
		$stem = is_string( $stem ) && '' !== $stem ? $stem : 'tmp';
		$path = $dir . '/' . $stem . '-' . wp_generate_password( 6, false ) . '.tmp';

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- test stub.
		file_put_contents( $path, '' );

		return $path;
	}
}

if ( ! function_exists( 'wc_get_weight' ) ) {
	/**
	 * Convert a weight between the units WooCommerce supports.
	 *
	 * ⚠️ **Mirrors the real function's negative clamp**, verified against
	 * WooCommerce 11.0.1: `wc_get_weight( -2000, 'kg', 'g' )` returns **0**, not
	 * `-2`. That is why `Integration\CartTotals` converts the *line's* total
	 * rather than the delta — converting a reducing option on its own would
	 * silently discard it, and a stub without the clamp would hide that.
	 *
	 * @param mixed  $weight    The weight to convert.
	 * @param string $to_unit   Unit to convert to.
	 * @param string $from_unit Unit to convert from; the store's unit when empty.
	 */
	function wc_get_weight( $weight, string $to_unit, string $from_unit = '' ): float {
		$weight  = (float) $weight;
		$to_unit = strtolower( $to_unit );

		if ( '' === $from_unit ) {
			$from_unit = strtolower( (string) get_option( 'woocommerce_weight_unit', 'kg' ) );
		}

		if ( $from_unit !== $to_unit ) {
			$to_kg = array(
				'g'   => 0.001,
				'lbs' => 0.453592,
				'oz'  => 0.0283495,
				'kg'  => 1.0,
			);

			$from_kg = array(
				'g'   => 1000.0,
				'lbs' => 2.20462,
				'oz'  => 35.274,
				'kg'  => 1.0,
			);

			$weight = $weight * ( $to_kg[ $from_unit ] ?? 1.0 ) * ( $from_kg[ $to_unit ] ?? 1.0 );
		}

		return $weight < 0 ? 0.0 : $weight;
	}
}

if ( ! function_exists( 'wp_nonce_url' ) ) {
	/**
	 * Append a nonce to a URL, as WordPress does.
	 *
	 * ⚠️ **Uses the same value `wp_verify_nonce()` accepts here**, so a test can
	 * follow a rendered link straight into the handler it points at rather than
	 * asserting the two agree by inspection.
	 *
	 * @param string $actionurl URL to add the nonce to.
	 * @param string $action    Nonce action.
	 * @param string $name      Query argument name.
	 */
	function wp_nonce_url( string $actionurl, string $action = '-1', string $name = '_wpnonce' ): string {
		return add_query_arg( $name, wp_create_nonce( $action ), $actionurl );
	}
}

if ( ! function_exists( 'nocache_headers' ) ) {
	/**
	 * Record that caching was suppressed, rather than sending headers.
	 */
	function nocache_headers(): void {
		$GLOBALS['optionia_test_nocache'] = true;
	}
}

if ( ! function_exists( 'sanitize_file_name' ) ) {
	/**
	 * Reduce a filename to something safe to put in a header or an archive.
	 *
	 * ⚠️ **Mirrors the transformations callers actually depend on**, verified
	 * against the real function on the running site rather than read from its
	 * source. This stub used to keep spaces, so a test could assert an entry
	 * named `my artwork.pdf` while WordPress would have produced
	 * `my-artwork.pdf` — passing here and differing in production.
	 *
	 * The four that matter:
	 *
	 * 1. **Separators and control characters go**, which is what stops a value
	 *    forging a second header or escaping a `filename` parameter.
	 * 2. **Runs of `..` collapse to one `.`**, so `../../evil.sh` becomes
	 *    `evil.sh` — measured — which is what makes a zip entry name unable to
	 *    escape on extraction.
	 * 3. **Whitespace and dashes collapse to a single dash.**
	 * 4. **A name left with nothing usable becomes `unnamed-file`.**
	 *
	 * @param string $filename Raw filename.
	 */
	function sanitize_file_name( string $filename ): string {
		$special = array( '?', '[', ']', '/', '\\', '=', '<', '>', ':', ';', ',', "'", '"', '&', '$', '#', '*', '(', ')', '|', '~', '`', '!', '{', '}', '%', '+', chr( 0 ) );

		// Control characters other than the whitespace collapsed below.
		$clean = preg_replace( '~[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+~', '', $filename );
		$clean = str_replace( $special, '', is_string( $clean ) ? $clean : '' );
		$clean = str_replace( array( '%20', '+' ), '-', $clean );
		$clean = (string) preg_replace( '/\.{2,}/', '.', $clean );
		$clean = (string) preg_replace( '/[\r\n\t -]+/', '-', $clean );
		$clean = trim( $clean, '.-_' );

		/*
		 * A name that is only an extension keeps it and gains a stem, exactly as
		 * WordPress does: `...pdf` becomes `unnamed-file.pdf`, not `pdf`.
		 */
		if ( '' === $clean ) {
			return 'unnamed-file';
		}

		if ( false === strpos( $clean, '.' ) && '' !== (string) pathinfo( $filename, PATHINFO_EXTENSION ) ) {
			return 'unnamed-file.' . $clean;
		}

		return $clean;
	}
}

if ( ! function_exists( 'get_allowed_mime_types' ) ) {
	/**
	 * WordPress's upload allowlist, trimmed to what these tests exercise.
	 *
	 * ⚠️ **`application/postscript` is deliberately absent**, because WordPress
	 * does not allow it either — that absence is the whole reason `.eps` cannot
	 * be accepted through a scoped map (ADR-041). A stub that included it would
	 * make the `.eps` test pass against a platform that refuses the file.
	 *
	 * @return array<string, string>
	 */
	function get_allowed_mime_types(): array {
		$types = array(
			'jpg|jpeg|jpe' => 'image/jpeg',
			'png'          => 'image/png',
			'gif'          => 'image/gif',
			'tiff|tif'     => 'image/tiff',
			'pdf'          => 'application/pdf',
			'zip'          => 'application/zip',
		);

		/*
		 * A test may widen the list, as a merchant's SVG-support plugin does.
		 *
		 * 🔴 **This is the exposure Stage 3f closes**, and it cannot be tested
		 * without it: WordPress blocking SVG is a *default*, and one
		 * `add_filter( 'upload_mimes', … )` removes it. Measured on the running
		 * site — with the filter active, a scripted SVG was accepted.
		 */
		return array_merge( $types, $GLOBALS['optionia_test_extra_mimes'] ?? array() );
	}
}

if ( ! function_exists( 'wp_check_filetype_and_ext' ) ) {
	/**
	 * Content-checked type detection.
	 *
	 * 🔴 **A faithful stub of the three behaviours the plugin depends on**, each
	 * measured against real WordPress over HTTP before being written here:
	 *
	 * 1. **Images are cross-checked.** A PNG named `.jpg` comes back as `png`
	 *    with `proper_filename` set — WordPress would rename it.
	 * 2. **Text-like content is refused.** A PHP script or HTML page named
	 *    `.pdf` returns `false` for everything.
	 * 3. **The detected type must be in the *global* allowlist**, read directly
	 *    rather than from `$mimes` — `wp-includes/functions.php:3324`. This is
	 *    what makes a scoped map unable to introduce a new MIME type, and it is
	 *    the behaviour `.eps` runs into.
	 *
	 * ⚠️ Everything `finfo` cannot place is left to the extension, which is how
	 * a ZIP named `.pdf` passes — the gap `Upload\UploadContent` closes with its
	 * own magic-byte check.
	 *
	 * @param string                $file     Absolute path.
	 * @param string                $filename Claimed name.
	 * @param array<string, string> $mimes    Extension → MIME map for this call.
	 * @return array{ext: string|false, type: string|false, proper_filename: string|false}
	 */
	function wp_check_filetype_and_ext( string $file, string $filename, array $mimes = array() ): array {
		$none = array(
			'ext'             => false,
			'type'            => false,
			'proper_filename' => false,
		);

		$map = array() === $mimes ? get_allowed_mime_types() : $mimes;
		$ext = strtolower( (string) pathinfo( $filename, PATHINFO_EXTENSION ) );

		if ( '' === $ext || ! is_readable( $file ) ) {
			return $none;
		}

		// Which declared extension group covers this one?
		$claimed_type = false;

		foreach ( $map as $pattern => $type ) {
			if ( in_array( $ext, explode( '|', $pattern ), true ) ) {
				$claimed_type = $type;
				break;
			}
		}

		if ( false === $claimed_type ) {
			return $none;
		}

		$head = (string) file_get_contents( $file, false, null, 0, 512 ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test stub.

		// (2) text-like content is refused outright.
		if ( '' !== $head && ( 0 === strpos( $head, '<?php' ) || 0 === stripos( $head, '<html' ) ) ) {
			return $none;
		}

		/*
		 * Markup formats, detected the way `finfo` does — by their root element.
		 *
		 * ⚠️ Only reached when the *global* allowlist carries the type, which is
		 * what a merchant's SVG plugin adds. Without that this returns `$none`
		 * below, matching WordPress's own default refusal.
		 */
		$markup = array(
			'<svg'  => array( 'svg', 'image/svg+xml' ),
			'<?xml' => array( 'xml', 'text/xml' ),
		);

		foreach ( $markup as $prefix => $kind ) {
			if ( 0 !== stripos( ltrim( $head ), $prefix ) ) {
				continue;
			}

			list( $markup_ext, $markup_type ) = $kind;

			/*
			 * Compared case-insensitively, and the *declared* spelling is
			 * returned.
			 *
			 * ✏️ The first version compared lowercase against the raw list, so a
			 * merchant filter declaring `IMAGE/SVG+XML` never matched and the
			 * file was refused here — making the plugin's own denylist test pass
			 * for the wrong reason. A MIME type is case-insensitive (RFC 2045),
			 * and `upload_mimes` is merchant code that need not lowercase.
			 */
			$declared = false;

			foreach ( get_allowed_mime_types() as $allowed_type ) {
				if ( 0 === strcasecmp( $allowed_type, $markup_type ) ) {
					$declared = $allowed_type;
					break;
				}
			}

			if ( false === $declared ) {
				return $none;
			}

			return array(
				'ext'             => $markup_ext,
				'type'            => $declared,
				'proper_filename' => false,
			);
		}

		// (1) images are cross-checked against their real signature.
		$signatures = array(
			"\x89PNG\r\n\x1a\n" => array( 'png', 'image/png' ),
			"\xFF\xD8\xFF"      => array( 'jpg', 'image/jpeg' ),
			'GIF8'              => array( 'gif', 'image/gif' ),
			"II\x2a\x00"        => array( 'tiff', 'image/tiff' ),
		);

		foreach ( $signatures as $magic => $real ) {
			if ( 0 !== strpos( $head, $magic ) ) {
				continue;
			}

			list( $real_ext, $real_type ) = $real;

			// (3) the detected type must be in the GLOBAL allowlist.
			if ( ! in_array( $real_type, get_allowed_mime_types(), true ) ) {
				return $none;
			}

			if ( $real_type === $claimed_type ) {
				return array(
					'ext'             => $ext,
					'type'            => $real_type,
					'proper_filename' => false,
				);
			}

			return array(
				'ext'             => $real_ext,
				'type'            => $real_type,
				'proper_filename' => (string) pathinfo( $filename, PATHINFO_FILENAME ) . '.' . $real_ext,
			);
		}

		// (3) again, for a claim finfo could not place.
		if ( ! in_array( $claimed_type, get_allowed_mime_types(), true ) ) {
			return $none;
		}

		return array(
			'ext'             => $ext,
			'type'            => $claimed_type,
			'proper_filename' => false,
		);
	}
}

if ( ! function_exists( 'wp_delete_file' ) ) {
	/**
	 * Delete a file.
	 *
	 * WordPress's own wrapper around `unlink()`, which also fires the
	 * `wp_delete_file` filter so a host with object storage can remove the real
	 * object. The stub deletes, which is what the callers here are asserting.
	 *
	 * @param string $file Absolute path.
	 */
	function wp_delete_file( string $file ): void {
		if ( is_file( $file ) || is_link( $file ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- this stub *is* the WP function.
			unlink( $file );
		}
	}
}

if ( ! function_exists( 'wc_get_logger' ) ) {
	/**
	 * A logger that records entries instead of writing them.
	 *
	 * 🔴 **`Support\Logger` was entirely unobservable in tests.** It routes every
	 * entry through `wc_get_logger()`, which no stub defined, so `log()` returned
	 * early at the `function_exists` guard and *nothing a test did could tell a
	 * logged error from silence*. `Logger` is `final`, so a subclass double is
	 * not available either — this stub is the seam the production code already
	 * uses, which is why it belongs here rather than in one test file.
	 *
	 * Entries land in `$GLOBALS['optionia_test_log']` as (level, message).
	 */
	function wc_get_logger() {
		return new class() {
			/**
			 * Record one entry.
			 *
			 * @param string               $level   Log level.
			 * @param string               $message Message, context already appended.
			 * @param array<string, mixed> $context Source.
			 */
			public function log( string $level, string $message, array $context = array() ): void {
				unset( $context );

				$GLOBALS['optionia_test_log'][] = array(
					'level'   => $level,
					'message' => $message,
				);

				/*
				 * ⚠️ **Bounded, because most suites never reset this.** Warnings
				 * and errors bypass the debug setting, so every suite building a
				 * real `Logger` now appends here whether or not it asserts on
				 * logs. Keeping the tail rather than growing without limit costs
				 * nothing a test can observe — assertions read the entries their
				 * own case just produced — and stops one long run from carrying
				 * the whole suite's history.
				 */
				if ( count( $GLOBALS['optionia_test_log'] ) > 200 ) {
					$GLOBALS['optionia_test_log'] = array_slice( $GLOBALS['optionia_test_log'], -100 );
				}
			}
		};
	}
}
