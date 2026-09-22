<?php
/**
 * Activation routine.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Activation;

use Optionia\Support\Environment;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Runs once, on activation.
 */
final class Activator {

	/**
	 * Current schema version of the plugin's own tables.
	 *
	 * Bumped whenever the table definitions below change; Migrator compares it
	 * against the stored value to decide whether to run dbDelta().
	 *
	 * 🔴 **Two guards must both move, and forgetting this one is silent.**
	 * `Migrator::maybe_upgrade()` returns early when `OPTION_VERSION` already
	 * matches, and `upgrade_schema()` returns early when `OPTION_DB_VERSION`
	 * already matches. Measured on the development site: `optionia_uploads` was
	 * added to `create_tables()`, the plugin version had already been bumped to
	 * `0.2.0` for an unrelated asset change, and the table **was never created**
	 * — the feature was wired, tested and completely broken on any site already
	 * running that version.
	 *
	 * A missing table is not a visible failure. It is a `wpdb` error in a log
	 * nobody reads and an upload that quietly refuses, which is why the bump
	 * belongs in the same edit as the `CREATE TABLE`.
	 *
	 * | Version | Change |
	 * |---------|--------|
	 * | 1       | `optionia_sync_log` |
	 * | 2       | `optionia_uploads` (M15.2) |
	 */
	public const DB_VERSION = '2';

	/**
	 * Activate.
	 *
	 * Requirements are checked here as a hard failure: activating on an
	 * unsupported environment and then degrading is worse than refusing, because
	 * the merchant has no idea anything is wrong.
	 */
	public static function activate(): void {
		$environment = new Environment();
		$problems    = $environment->unmet_requirements();

		// WooCommerce may legitimately be absent at activation time — a merchant
		// can activate plugins in any order, and WordPress's bulk activation is
		// alphabetical. Only hard-fail on the environment we cannot work around.
		$blocking = array_filter(
			$problems,
			static fn ( array $problem ): bool => in_array( $problem['code'], array( 'php_version', 'wp_version' ), true )
		);

		if ( array() !== $blocking ) {
			$messages = implode(
				' ',
				array_map(
					static fn ( array $problem ): string => $environment->describe( $problem ),
					$blocking
				)
			);

			deactivate_plugins( plugin_basename( OPTIONIA_PLUGIN_FILE ) );

			wp_die(
				esc_html( $messages ),
				esc_html__( 'Optionia cannot be activated', 'optionia' ),
				array( 'back_link' => true )
			);
		}

		self::create_tables();

		update_option( Keys::OPTION_DB_VERSION, self::DB_VERSION, false );
		update_option( Keys::OPTION_VERSION, OPTIONIA_VERSION, false );

		// Seed settings so the options row exists with known defaults rather
		// than materialising on first save.
		if ( false === get_option( Keys::OPTION_SETTINGS, false ) ) {
			add_option( Keys::OPTION_SETTINGS, array(), '', false );
		}

		Scheduler::schedule();

		// Rewrite rules are not used yet, but flushing here means adding an
		// endpoint later does not require a second activation.
		flush_rewrite_rules();
	}

	/**
	 * Create or update custom tables.
	 *
	 * Only data that does not belong in wp_options lives in a custom table. The
	 * sync log is append-only and can grow to thousands of rows, which would
	 * make a serialised option unusable.
	 */
	private static function create_tables(): void {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset = $wpdb->get_charset_collate();
		$table   = self::table_name( Keys::TABLE_SYNC_LOG );

		// dbDelta is whitespace- and format-sensitive: two spaces after PRIMARY
		// KEY, lowercase types, one field per line.
		$sql = "CREATE TABLE {$table} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			event varchar(64) NOT NULL,
			status varchar(20) NOT NULL,
			config_version bigint(20) unsigned DEFAULT NULL,
			message text DEFAULT NULL,
			created_at datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
			PRIMARY KEY  (id),
			KEY event_created (event(20), created_at),
			KEY created_at (created_at)
		) {$charset};";

		dbDelta( $sql );

		self::create_uploads_table( $charset );
	}

	/**
	 * Customer file uploads (M15.2).
	 *
	 * ## Why a table rather than post meta
	 *
	 * A file exists **before** anything to attach it to. A customer uploads while
	 * the product page is open; there is no order yet, and there may never be one
	 * — most carts are abandoned. Post meta needs a post, so an upload would have
	 * to invent a draft order to hang from, and abandoned drafts are worse than
	 * abandoned rows.
	 *
	 * ⚠️ **`expires_at` is not optional, and is the lesson from `sync_log`.**
	 * That table is append-only with nothing that prunes it — it grows forever on
	 * every merchant's database. Rows here point at real bytes on disk, so the
	 * same omission would fill a merchant's disk rather than merely their
	 * database. Every row therefore carries its own expiry from the moment it is
	 * written, and the cleanup job reads that column rather than guessing.
	 *
	 * `order_id` is nullable and set at checkout: an upload with an order is
	 * permanent, one without expires. That single transition is the whole
	 * lifecycle (M15.4).
	 *
	 * @param string $charset Charset/collation clause from `$wpdb`.
	 */
	private static function create_uploads_table( string $charset ): void {
		$table = self::table_name( Keys::TABLE_UPLOADS );

		/*
		 * `token` is the only thing a browser ever sees, so it is unique and
		 * indexed: every lookup is by token, never by path or id.
		 *
		 * `stored_name` is the random on-disk name; `original_name` is what the
		 * customer called the file and is shown to the merchant. Keeping them
		 * apart is what M15.3's "no filename-derived paths" requires.
		 */
		$sql = "CREATE TABLE {$table} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			token char(64) NOT NULL,
			session_key varchar(64) NOT NULL,
			option_id varchar(64) NOT NULL,
			stored_name varchar(255) NOT NULL,
			original_name varchar(255) NOT NULL,
			mime_type varchar(120) NOT NULL,
			size_bytes bigint(20) unsigned NOT NULL DEFAULT 0,
			order_id bigint(20) unsigned DEFAULT NULL,
			created_at datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
			expires_at datetime DEFAULT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY token (token),
			KEY session_key (session_key),
			KEY expires_at (expires_at),
			KEY order_id (order_id)
		) {$charset};";

		dbDelta( $sql );
	}

	/**
	 * Fully qualified table name.
	 *
	 * @param string $name Unprefixed table name from Keys.
	 */
	public static function table_name( string $name ): string {
		global $wpdb;

		return $wpdb->prefix . $name;
	}
}
