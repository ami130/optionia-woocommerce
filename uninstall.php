<?php
/**
 * Uninstall routine.
 *
 * Runs only when the merchant deletes the plugin, and only removes data when
 * they have explicitly opted in via Settings. Default is to keep everything:
 * deleting a merchant's option configuration because they removed a plugin to
 * test a theme conflict would be unrecoverable for them.
 *
 * Cannot rely on the autoloader or any plugin class being available here — this
 * file is loaded in isolation by WordPress, so it is deliberately self-contained.
 *
 * @package Optionia
 */

declare( strict_types=1 );

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Remove every trace of the plugin from a single site.
 *
 * @param string $prefix Database prefix for the site being cleaned.
 */
function optionia_uninstall_site( string $prefix ): void {
	global $wpdb;

	$options = array(
		'optionia_db_version',
		'optionia_version',
		'optionia_settings',
		'optionia_config',
		'optionia_config_meta',
		'optionia_product_index',
		'optionia_store_token',
		'optionia_connection_state',
		'optionia_circuit_state',
	);

	foreach ( $options as $option ) {
		delete_option( $option );
	}

	wp_clear_scheduled_hook( 'optionia_cron_sync_config' );

	// Custom tables. Table names are built from a hardcoded suffix and the
	// trusted $wpdb prefix, so there is no user input in this statement.
	$table = $prefix . 'optionia_sync_log';
	$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.DirectDatabaseQuery.NoCaching
}

/**
 * Whether this site opted in to data deletion.
 */
function optionia_should_delete(): bool {
	$settings = get_option( 'optionia_settings', array() );

	return is_array( $settings )
		&& isset( $settings['delete_on_uninstall'] )
		&& (bool) $settings['delete_on_uninstall'];
}

global $wpdb;

if ( is_multisite() ) {
	// Each site holds its own settings, so each site's opt-in is respected
	// independently. A network admin deleting the plugin must not wipe a
	// subsite that never agreed to it.
	$site_ids = get_sites(
		array(
			'fields'   => 'ids',
			'number'   => 0,
			'public'   => null,
			'archived' => null,
			'deleted'  => null,
		)
	);

	foreach ( $site_ids as $site_id ) {
		switch_to_blog( (int) $site_id );

		if ( optionia_should_delete() ) {
			optionia_uninstall_site( $wpdb->prefix );
		}

		restore_current_blog();
	}
} elseif ( optionia_should_delete() ) {
	optionia_uninstall_site( $wpdb->prefix );
}
