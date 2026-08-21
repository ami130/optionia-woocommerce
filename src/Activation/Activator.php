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
	 */
	public const DB_VERSION = '1';

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
