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

	/** Merchant settings array. */
	public const OPTION_SETTINGS = 'optionia_settings';

	/** Cached configuration document pulled from the cloud. Autoload OFF. */
	public const OPTION_CONFIG = 'optionia_config';

	/** Metadata about the cached config: version, fetched_at, schema_version. */
	public const OPTION_CONFIG_META = 'optionia_config_meta';

	/** Index of product_id to option set ids, built at config write time. */
	public const OPTION_PRODUCT_INDEX = 'optionia_product_index';

	/** Store credential returned by the connection handshake. Autoload OFF. */
	public const OPTION_STORE_TOKEN = 'optionia_store_token';

	/** Connection state machine value. See Connection\StateMachine. */
	public const OPTION_CONNECTION_STATE = 'optionia_connection_state';

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

	/** Cart item data key under which all Optionia state is nested. */
	public const CART_ITEM_KEY = 'optionia';

	// Cron.

	/** Recurring configuration sync. */
	public const CRON_SYNC_CONFIG = 'optionia_cron_sync_config';

	/** Custom schedule name for the sync interval. */
	public const CRON_SCHEDULE_QUARTER_HOUR = 'optionia_quarter_hour';

	// Nonce actions.

	public const NONCE_SETTINGS   = 'optionia_settings';
	public const NONCE_CONNECT    = 'optionia_connect';
	public const NONCE_DISCONNECT = 'optionia_disconnect';
	public const NONCE_SYNC_NOW   = 'optionia_sync_now';

	// Capabilities.
	//
	// `manage_woocommerce` is the correct gate — it is held by shop managers
	// and administrators. `manage_options` would exclude shop managers.

	public const CAP_MANAGE = 'manage_woocommerce';

	// Admin.

	public const MENU_SLUG          = 'optionia';
	public const MENU_SLUG_SETTINGS = 'optionia-settings';

	// Asset handles.

	public const ASSET_FRONTEND_JS  = 'optionia-frontend';
	public const ASSET_FRONTEND_CSS = 'optionia-frontend';
	public const ASSET_ADMIN_JS     = 'optionia-admin';
	public const ASSET_ADMIN_CSS    = 'optionia-admin';

	// Custom tables (unprefixed — see Activation\Activator::table_name())..

	public const TABLE_SYNC_LOG = 'optionia_sync_log';

	/**
	 * Not instantiable.
	 *
	 * @codeCoverageIgnore
	 */
	private function __construct() {}
}
