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
 * file is loaded in isolation by WordPress, so it is deliberately
 * self-contained.
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
	global $wpdb; // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WordPress core global.

	// Mirrors every OPTION_* constant in Support\Keys. This file is loaded in
	// isolation by WordPress -- no autoloader, no plugin classes -- so the names
	// cannot be read from Keys and must be repeated literally.
	//
	// A hand-kept copy drifts, and this one did: four options added after the
	// list was written survived uninstall, including a tenant name. The
	// `check-uninstall` gate now diffs this array against Keys on every run, so
	// the next addition fails CI instead of leaking.
	$options = array(
		'optionia_db_version',
		'optionia_version',
		'optionia_last_sweep',
		'optionia_settings',
		'optionia_config',
		'optionia_config_meta',
		'optionia_product_index',
		'optionia_store_token',
		'optionia_connection_state',
		'optionia_connection_store',
		'optionia_connection_tenant',
		'optionia_handshake',
		'optionia_circuit_state',
		'optionia_last_heartbeat',
		'optionia_last_sync',
		'optionia_last_push',
		'optionia_schema_refused',
		'optionia_unpriced_types',
		'optionia_order_queue',
		'optionia_last_order_report',
		'optionia_catalogue_cursor',
		'optionia_product_queue',
		'optionia_last_reconcile',
	);

	foreach ( $options as $option ) {
		delete_option( $option );
	}

	// Every CRON_* hook in Keys. A scheduled event outlives the plugin files:
	// left behind, it fires forever against code that is no longer installed.
	$hooks = array(
		'optionia_cron_sync_config',
		'optionia_cron_report_orders',
		'optionia_cron_heartbeat',
		'optionia_cron_push_catalogue',
		'optionia_cron_reconcile_catalogue',
	);

	foreach ( $hooks as $hook ) {
		wp_clear_scheduled_hook( $hook );
	}

	// Every TABLE_* constant in Keys. A leftover table is worse than a leftover
	// option: invisible in the admin, surviving reinstalls, accumulating rows.
	$tables = array(
		'optionia_sync_log',
		'optionia_uploads',
	);

	foreach ( $tables as $suffix ) {
		$table = $prefix . $suffix;

		// Table identifiers cannot be bound as placeholders. The name is built
		// from a hardcoded suffix and the trusted $wpdb->prefix, so no user
		// input reaches this statement.
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" );
	}

	optionia_delete_upload_files();
}

/**
 * Remove the customer files this plugin stored (M15.2).
 *
 * 🔴 **Dropping the table alone would leave the bytes.** Every other thing this
 * file removes is a database row; uploads are the first that are also *files* on
 * the merchant's disk. A merchant who uninstalls and sees the tables gone would
 * still be carrying every customer's artwork, invisibly, forever — a disk
 * problem and a data-protection one at the same time.
 *
 * ⚠️ **Only this plugin's own directory is touched, and only its own files.**
 * The directory name is derived from `wp_salt()`, so it cannot collide with
 * anything else in `uploads/`, and the loop refuses anything that is not a plain
 * file inside it. Deleting broadly here would be deleting a merchant's media
 * library on a bad glob.
 *
 * Silent on failure by design: uninstall is not a place to raise errors a user
 * cannot act on, and a file that cannot be removed is a permissions problem for
 * their host, not something this hook can fix.
 */
function optionia_delete_upload_files(): void {
	$uploads = wp_upload_dir();

	if ( ! is_array( $uploads ) || empty( $uploads['basedir'] ) ) {
		return;
	}

	$seed = function_exists( 'wp_salt' ) ? wp_salt( 'nonce' ) : '';
	$name = 'optionia-uploads-' . substr( hash( 'sha256', 'optionia-uploads|' . $seed ), 0, 16 );
	$dir  = rtrim( (string) $uploads['basedir'], '/\\' ) . '/' . $name;

	if ( ! is_dir( $dir ) ) {
		return;
	}

	$entries = scandir( $dir );

	if ( false === $entries ) {
		return;
	}

	foreach ( $entries as $entry ) {
		if ( '.' === $entry || '..' === $entry ) {
			continue;
		}

		$path = $dir . '/' . $entry;

		// Never recurse: this directory is flat by construction, and a symlink
		// pointing elsewhere must not be followed into a merchant's own files.
		if ( is_file( $path ) && ! is_link( $path ) ) {
			// `wp_delete_file()` wraps unlink() and fires `wp_delete_file`, so a
			// host with an object-store filter removes the real object too.
			wp_delete_file( $path );
		}
	}

	/*
	 * Suppressed deliberately: a non-empty directory means a file could not be
	 * removed, and leaving it is the correct outcome. Uninstall must not fatal
	 * over a permissions problem only the host can fix.
	 */
	// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- see above.
	@rmdir( $dir );
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

/**
 * Entry point.
 *
 * Wrapped in a function so loop variables stay out of the global scope — code
 * executed at file level would otherwise define a global for each one.
 */
function optionia_run_uninstall(): void {
	global $wpdb; // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WordPress core global.

	if ( ! is_multisite() ) {
		if ( optionia_should_delete() ) {
			optionia_uninstall_site( $wpdb->prefix );
		}

		return;
	}

	// Each site holds its own settings, so each site's opt-in is respected
	// independently. A network admin deleting the plugin must not wipe a subsite
	// that never agreed to it.
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
}

optionia_run_uninstall();
