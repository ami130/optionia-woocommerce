<?php
/**
 * Canonical names for every string that crosses a boundary.
 *
 * Principle 5 (shared vocabulary, not stringly-typed code): option names, meta
 * keys, transients, cron hooks and nonce actions are declared here and nowhere
 * else. A rename is then a single edit rather than a grep-and-hope.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * String constants shared across the plugin.
 *
 * Naming conventions:
 * - `optionia_*`  persistent, merchant-visible or merchant-relevant state.
 * - `_optionia_*` hidden meta (leading underscore hides it from WooCommerce's
 *                 default meta display).
 */
final class Keys {

	/**
	 * Text domain. Must match the plugin header and the .pot file.
	 */
	public const TEXT_DOMAIN = 'optionia';

	// wp_options.

	/** Schema version of the plugin's own custom tables. */
	public const OPTION_DB_VERSION = 'optionia_db_version';

	/** Plugin version last seen booting; drives upgrade routines. */
	public const OPTION_VERSION = 'optionia_version';

	/**
	 * When the upload directory was last reconciled against the table (M15.3).
	 *
	 * ⚠️ Autoloaded `false` like every other key here: it is read on cron, not
	 * on a page load, and autoloading it would put a value nothing needs into
	 * every request on the site.
	 */
	public const OPTION_LAST_SWEEP = 'optionia_last_sweep';

	/** Merchant settings array. */
	public const OPTION_SETTINGS = 'optionia_settings';

	/** Cached configuration document pulled from the cloud. Autoload OFF. */
	public const OPTION_CONFIG = 'optionia_config';

	/** Metadata about the cached config: version, fetched_at, schema_version. */
	public const OPTION_CONFIG_META = 'optionia_config_meta';

	/** Index of product_id to option set ids, built at config write time. */
	/**
	 * `product_id → applicable option sets`, built at write time (M9.2).
	 *
	 * Written by `Config\ProductIndex`, inside `Config\Repository::store()` and
	 * after the document, so a failure between the two writes leaves a stale
	 * index rather than one naming configuration that is not there.
	 *
	 * It took two stages to get here. Stage 1 made the document carry real
	 * assignments, read live from the cloud rather than baked into a published
	 * snapshot — before that it hardcoded `assignments: []`, and this note
	 * claimed that was Phase 13's to fix. It was not: Phase 13 owns the *picker*
	 * that creates assignments, and the read path was Phase 10's own. Stage 2
	 * then built the index itself.
	 *
	 * Covers `all` and `manual` only. A write-time index cannot express
	 * `conditional` — its condition tree is evaluated against product state — nor
	 * the `category`, `tag`, `attribute` and `price_range` targets, which resolve
	 * against WordPress data the document does not carry. Those are M19.4's, and
	 * what was skipped is counted so the deferral shows in System Status rather
	 * than looking like a set that simply does not work.
	 *
	 * Kept rather than removed so uninstall keeps covering it — the gate
	 * already asserts every `OPTION_*` constant is deleted, and dropping this
	 * would only mean re-adding it in Phase 10 without that protection.
	 */
	public const OPTION_PRODUCT_INDEX = 'optionia_product_index';

	/** Store credential returned by the connection handshake. Autoload OFF. */
	public const OPTION_STORE_TOKEN = 'optionia_store_token';

	/** Connection state machine value. See Connection\StateMachine. */
	public const OPTION_CONNECTION_STATE = 'optionia_connection_state';

	/**
	 * The in-flight handshake: `state`, PKCE `verifier`, and when it expires.
	 *
	 * Autoloaded **off** and deleted the moment the handshake ends. It holds the
	 * PKCE verifier, which is the secret that stops an intercepted code being
	 * redeemed by whoever intercepted it — so it must never reach the browser
	 * and must not outlive the exchange it exists for.
	 */
	public const OPTION_HANDSHAKE = 'optionia_handshake';

	/** The connected store's id, for the settings screen and support. */
	public const OPTION_CONNECTION_STORE = 'optionia_connection_store';

	/** The workspace this shop is connected to, shown to the merchant. */
	public const OPTION_CONNECTION_TENANT = 'optionia_connection_tenant';

	/** Circuit breaker state for the API client. */
	public const OPTION_CIRCUIT_STATE = 'optionia_circuit_state';

	// Settings keys (inside OPTION_SETTINGS).

	public const SETTING_DEBUG_LOGGING       = 'debug_logging';
	public const SETTING_DELETE_ON_UNINSTALL = 'delete_on_uninstall';
	public const SETTING_API_BASE_URL        = 'api_base_url';

	// Order / cart item meta.
	//
	// Visible keys are human-readable because WooCommerce renders them into
	// emails, packing slips and PDF invoices (see M12.6b). Hidden keys carry
	// machine data and are underscore-prefixed.

	/** Hidden: the full selection payload for a line item. */
	public const META_SELECTIONS = '_optionia_selections';

	/** Hidden: config version used when the line was priced. */
	public const META_CONFIG_VERSION = '_optionia_config_version';

	/** Hidden: option set id the line was priced against. */
	public const META_OPTION_SET_ID = '_optionia_option_set_id';

	/** Hidden: total option price delta, in minor units. */
	public const META_PRICE_DELTA = '_optionia_price_delta';

	/**
	 * Order-line meta: the SKU suffixes the line's options contribute.
	 *
	 * **This is where a suffix is applied at all.** M16.8 wanted it on the
	 * product's SKU; `WC_Product::set_sku()` throws on a duplicate and two lines
	 * of one product with the same option collide, so the cart is the wrong
	 * place. Fulfilment reads the order, and the order is where it lands.
	 *
	 * JSON-encoded and keyed by option id rather than pre-joined, so an
	 * integration can compose its own convention — a separator is a merchant's
	 * decision, not this plugin's.
	 */
	public const META_SKU_SUFFIX = '_optionia_sku_suffix';

	/** Cart item data key under which all Optionia state is nested. */
	public const CART_ITEM_KEY = 'optionia';

	/**
	 * Sub-key holding the validated selections inside `CART_ITEM_KEY`.
	 *
	 * Nested rather than flat because `WC_Cart::generate_cart_id()` hashes the
	 * whole `cart_item_data` array to decide whether two lines merge. Keeping
	 * Optionia's state under one key means the hash sees one entry whose value
	 * changes with the selection, instead of a spread of top-level keys that
	 * could collide with another plugin's.
	 *
	 * Read by `Integration\AddToCartRequest` on the reorder path, where
	 * `WC_Cart_Session::populate_cart_from_order()` supplies `cart_item_data`
	 * as the sixth filter argument and `$_POST` does not exist.
	 */
	public const CART_ITEM_SELECTIONS = 'selections';

	/**
	 * Sub-key holding the `config_version` a line was priced against.
	 *
	 * Captured at add-to-cart so a publish cannot change what a customer was
	 * quoted (M12.4). One of the **audit** sub-keys: it must not participate in
	 * the cart item key, or the same selection added either side of a publish
	 * becomes two lines. See `CartItemPayload::prune()`.
	 */
	public const CART_ITEM_CONFIG_VERSION = 'config_version';

	/**
	 * Sub-key holding the per-option deltas a line was priced with.
	 *
	 * Stored rather than recomputed because it cannot be recomputed: the
	 * configuration is overwritten on publish, so the price a customer was quoted
	 * exists nowhere else. Signed for the same reason — see
	 * `CART_ITEM_SIGNATURE`. An audit sub-key.
	 */
	public const CART_ITEM_DELTAS = 'deltas';

	/**
	 * Sub-key holding the signature over the frozen payload.
	 *
	 * `cart_item_data` is not browser-writable — `WC_AJAX::add_to_cart()` never
	 * reads it, the form handler never populates it from `$_POST`, and the Store
	 * API hardcodes `'cart_item_data' => []`. But **another plugin** can write it
	 * through `woocommerce_add_cart_item_data`, and Stage 7b's conclusion stands:
	 * a price another plugin can set is not server-authoritative.
	 *
	 * A stored delta cannot be verified by recomputation, because the
	 * configuration that produced it is gone. Signing is what makes it checkable
	 * without that configuration. An audit sub-key.
	 */
	public const CART_ITEM_SIGNATURE = 'signature';

	/**
	 * Sub-key holding the option and value names as the customer saw them.
	 *
	 * Snapshotted because the configuration is overwritten on publish: once a
	 * merchant deletes or renames an option, the text the customer chose exists
	 * nowhere else. [M12.4](#m124--checkout-integrity) has to block checkout with
	 * "a clear, actionable message" and M12.8 with "a message naming the option",
	 * and neither is possible from an option id -- a merchant-chosen slug, not
	 * customer-facing text.
	 *
	 * **An audit sub-key**, so it is pruned from the cart item key. A merchant
	 * renaming an option changes the label without changing the selection; if
	 * labels participated in the key, that rename would split one cart line into
	 * two, which is [GAP 1](#m121--cart-item-data-model) reopened by a different
	 * route.
	 *
	 * **Deliberately not signed.** Signing would make a rename invalidate the
	 * price freeze, and a rename is not a price change -- the customer would lose
	 * a quote for a reason unrelated to money. Left unsigned, the worst another
	 * plugin can do by tampering is show a wrong *name*; the price is signed
	 * separately and stays authoritative.
	 */
	public const CART_ITEM_LABELS = 'labels';

	/**
	 * Sub-key holding the ids of the option sets a line's choices came from.
	 *
	 * Persisted to the order by [M12.5](#m125--order-persistence) so a line can be
	 * traced back to the set that produced it after the configuration has moved
	 * on -- a support conversation about an order placed three publishes ago has
	 * nothing else to go on.
	 *
	 * **An audit sub-key**, for the same reason as the others: a merchant moving
	 * an option between sets changes this without changing what the customer
	 * chose, and if it participated in the cart key that move would split one
	 * line into two.
	 *
	 * **Not signed.** It records provenance, not money. Signing it would make a
	 * set reorganisation invalidate the price freeze, which is the same wrong
	 * outcome as signing labels.
	 */
	public const CART_ITEM_SET_IDS = 'set_ids';

	/**
	 * Sub-key holding the SKU suffixes a line's choices contribute.
	 *
	 * Snapshotted for the same reason labels are: the configuration is
	 * overwritten on publish, so once a merchant edits a suffix the one this
	 * customer's line was built from exists nowhere else — and a warehouse
	 * picking last week's order needs the code that was on it, not today's.
	 *
	 * 🔴 **Never applied to the product's own SKU.** `WC_Product::set_sku()`
	 * throws `WC_Data_Exception` on a duplicate, and two lines of one product
	 * with the same option produce identical SKUs — so the duplicate is the
	 * normal case. See `Engine\SelectionResolver::sku_suffix_for()`.
	 *
	 * **An audit sub-key**, so it is pruned from the cart item key: a merchant
	 * editing a suffix must not split one cart line into two.
	 *
	 * **Not signed.** It records identity, not money. Signing it would make a
	 * suffix edit invalidate the price freeze, which is the same wrong outcome as
	 * signing labels.
	 */
	public const CART_ITEM_SKU_SUFFIXES = 'sku_suffixes';


	// Cron.

	/** Recurring configuration sync. */
	public const CRON_SYNC_CONFIG = 'optionia_cron_sync_config';

	/** Custom schedule name for the sync interval. */
	public const CRON_SCHEDULE_QUARTER_HOUR = 'optionia_quarter_hour';

	/** Daily authenticated ping: the support and analytics backbone (M8.5). */
	public const CRON_HEARTBEAT = 'optionia_cron_heartbeat';

	/** Outcome of the last heartbeat, surfaced in System Status. */
	public const OPTION_LAST_HEARTBEAT = 'optionia_last_heartbeat';

	/** Outcome of the last configuration sync (M9.3), surfaced in System Status. */
	public const OPTION_LAST_SYNC = 'optionia_last_sync';

	/** Outcome of the last push received from the cloud (M9.4). */
	public const OPTION_LAST_PUSH = 'optionia_last_push';

	/** Drains the queue of unreported orders (M12.7). */
	public const CRON_REPORT_ORDERS = 'optionia_cron_report_orders';

	/**
	 * Orders awaiting report to the cloud (M12.7).
	 *
	 * An option rather than a custom table: the queue holds a handful of rows
	 * for minutes, and a table would need its own install, upgrade and uninstall
	 * path for data that is disposable by definition. Autoload is off — the
	 * storefront never reads it.
	 */
	public const OPTION_ORDER_QUEUE = 'optionia_order_queue';

	/** Outcome of the last order-report run, surfaced in System Status. */
	public const OPTION_LAST_ORDER_REPORT = 'optionia_last_order_report';

	/**
	 * Marks an order as reported, so a re-fired hook does not re-queue it.
	 *
	 * Order meta rather than an option: it belongs to the order, and it must
	 * survive the queue being drained, cleared or lost.
	 */
	public const META_REPORTED_AT = '_optionia_reported_at';

	/**
	 * The document shape this build refused, if it has refused one (M9.5).
	 *
	 * Remembered rather than only logged: the refusal is silent by design — the
	 * previous configuration keeps serving — so without a record nothing can
	 * tell the merchant to update, and the heartbeat has nothing to report.
	 */
	public const OPTION_SCHEMA_REFUSED = 'optionia_schema_refused';

	/**
	 * Price types in the stored document that this version cannot price.
	 *
	 * The cloud's schema publishes five (`fixed`, `percentage`, `per_unit`,
	 * `per_char`, `tiered`); this build implements those named by
	 * `Engine\SelectionResolver::PRICED_TYPES` and Phase 16 adds the rest.
	 * An option of an unimplemented type contributes **nothing** to the line
	 * total, which is the right arithmetic -- guessing is worse -- but is
	 * indistinguishable from a free option, so the merchant undercharges without
	 * knowing. Recorded at store time so the settings screen can say so.
	 *
	 * Same shape and lifecycle as `OPTION_SCHEMA_REFUSED`: written when the
	 * condition holds, deleted when it stops holding, describing the present
	 * rather than a history.
	 */
	public const OPTION_UNPRICED_TYPES = 'optionia_unpriced_types';

	// REST.

	/**
	 * Namespace for the plugin's own REST routes.
	 *
	 * Versioned from the first release: a shipped plugin cannot be redeployed
	 * (M7.7), so a route whose shape changes needs a second namespace rather
	 * than a breaking edit to the first.
	 */
	public const REST_NAMESPACE = 'optionia/v1';

	/** Where the cloud pings to say new configuration is available (M9.4). */
	public const REST_ROUTE_PUSH = '/push';

	/**
	 * Where a customer's browser uploads a file (M15.2).
	 *
	 * ⚠️ **A storefront route, not an admin one.** Every other endpoint here is
	 * reached by the cloud or by a signed-in merchant; this one is reached by an
	 * anonymous shopper, which is why `Upload\UploadEndpoint` bounds it by
	 * session quota rather than by capability.
	 */
	public const REST_ROUTE_UPLOAD = '/upload';

	// Nonce actions.

	public const NONCE_SETTINGS   = 'optionia_settings';
	public const NONCE_CONNECT    = 'optionia_connect';
	public const NONCE_DISCONNECT = 'optionia_disconnect';
	public const NONCE_SYNC_NOW   = 'optionia_sync_now';

	/**
	 * The storefront upload nonce.
	 *
	 * ⚠️ **A filter, not a credential — and the distinction is measured.** For a
	 * logged-out visitor `wp_create_nonce()` reduces to *action + tick*: `uid` is
	 * 0 and the session token is empty, so **every guest on the site receives the
	 * identical value**, valid for 24 hours. Verified on the running site: two
	 * separate calls returned the same string.
	 *
	 * So it proves only *"this request came from a page this site generated
	 * recently"*. It stops drive-by scripts that never loaded a product page; it
	 * does **not** identify a visitor, and it is not what bounds abuse — the
	 * per-session quota in `Upload\UploadQuota` is.
	 *
	 * Recorded because a `permission_callback` that looks like a security control
	 * and is not is worse than none: it stops the next reader asking the right
	 * question.
	 */
	public const NONCE_UPLOAD = 'optionia_upload';

	/**
	 * Nonce action for a merchant downloading a customer's file (M15.5).
	 *
	 * ⚠️ **Here the nonce is a real control, unlike `NONCE_UPLOAD`.** The
	 * weakness recorded above is specific to *logged-out* visitors, for whom
	 * `wp_create_nonce()` reduces to action + tick. A download is an
	 * authenticated admin request, so the nonce is tied to the merchant's user id
	 * and session token — which is exactly the CSRF defence a state-changing or
	 * data-revealing admin GET needs.
	 */
	public const NONCE_DOWNLOAD = 'optionia_download';

	/**
	 * Query argument naming the file a download request wants.
	 */
	public const ARG_DOWNLOAD_TOKEN = 'optionia_file';

	/**
	 * Query argument naming the order whose files are wanted as one archive.
	 *
	 * Shares `NONCE_DOWNLOAD` with the single-file argument: both are the same
	 * merchant asking for the same order's artwork, and a second nonce action
	 * would be two things to keep in step for no gain.
	 */
	public const ARG_DOWNLOAD_ORDER = 'optionia_order_files';

	/**
	 * Query argument carrying an email link's signature.
	 *
	 * 🔴 **A nonce cannot do this job.** `NONCE_DOWNLOAD` is tied to the
	 * merchant's user id and session token, which is exactly right for a link
	 * rendered on a screen they are already logged into — and useless in an
	 * email, which is opened later and often in a different browser. Worse, the
	 * weakness recorded above applies in full to a logged-out reader: a nonce
	 * would reduce to action + tick, identical for everyone.
	 *
	 * So an email link carries its own `wp_hash()` signature and its own
	 * expiry instead.
	 */
	public const ARG_DOWNLOAD_SIGNATURE = 'optionia_sig';

	/**
	 * Query argument asking for a preview rather than the file itself.
	 *
	 * ⚠️ **Never reachable by an emailed signature.** A signature is minted over
	 * an order and speaks only for that order's archive; a preview names one
	 * file, so it requires the nonce a logged-in merchant's screen provides.
	 */
	public const ARG_DOWNLOAD_PREVIEW = 'optionia_preview';

	/**
	 * Query argument carrying an email link's expiry, as a Unix timestamp.
	 */
	public const ARG_DOWNLOAD_EXPIRES = 'optionia_expires';

	// Capabilities.
	//
	// `manage_woocommerce` is the correct gate — it is held by shop managers
	// and administrators. `manage_options` would exclude shop managers.

	public const CAP_MANAGE = 'manage_woocommerce';

	// Admin.

	public const MENU_SLUG          = 'optionia';
	public const MENU_SLUG_SETTINGS = 'optionia-settings';

	// Asset handles.

	public const ASSET_FRONTEND_JS = 'optionia-frontend';

	/**
	 * Form field prefix for a customer's option selections.
	 *
	 * Submitted as `optionia[<option_id>]`, so one array reaches `$_POST` rather
	 * than a field per option — the shape a validator can iterate without
	 * knowing which options exist.
	 *
	 * **This is a cross-phase contract, decided deliberately rather than
	 * inherited.** The Phase 4 probe used a bare `name="..."`, which is how an
	 * accident becomes an interface. [Phase 11] prices a line from these fields
	 * and [Phase 12] builds a cart item from them, so three things constrain it:
	 *
	 * - **No collision.** WooCommerce's own add-to-cart form already carries
	 *   `add-to-cart`, `product_id`, `variation_id` and `quantity`. A prefix
	 *   nobody else uses keeps them separable without a denylist.
	 * - **Option identity, not label.** The key is the option's `id`, which is
	 *   stable across renames; a label is display text and changes.
	 * - **Round-trippable.** Reorder restores a selection from **order item meta,
	 *   not `$_POST`**, so whatever is read here must be re-renderable from
	 *   storage. A `$_POST`-only reader blocks reorder entirely — measured in
	 *   Phase 4, and the reason M12.1 records this from the other end.
	 */
	public const FIELD_PREFIX       = 'optionia';
	public const ASSET_FRONTEND_CSS = 'optionia-frontend';
	public const ASSET_ADMIN_JS     = 'optionia-admin';
	public const ASSET_ADMIN_CSS    = 'optionia-admin';

	// Custom tables (unprefixed — see Activation\Activator::table_name())..

	public const TABLE_SYNC_LOG = 'optionia_sync_log';

	/** Customer file uploads: token, path, size, type, owner, expiry (M15.2). */
	public const TABLE_UPLOADS = 'optionia_uploads';

	/**
	 * Not instantiable.
	 *
	 * @codeCoverageIgnore
	 */
	private function __construct() {}
}
