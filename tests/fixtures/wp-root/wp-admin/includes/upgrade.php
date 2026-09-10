<?php
/**
 * Stands in for WordPress's own upgrade.php.
 *
 * `Activation\Activator` does `require_once ABSPATH . 'wp-admin/includes/upgrade.php'`
 * before calling `dbDelta()`, exactly as WordPress requires. Without a file at
 * that path the require is fatal, which is why `Activator` and `Migrator` --
 * 228 lines that run on every install and every update -- had no tests at all.
 *
 * `dbDelta()` itself is stubbed in the bootstrap; this file only has to exist
 * so the require succeeds.
 *
 * It lives under `tests/fixtures/` rather than the plugin root so nothing that
 * looks like a WordPress core file is ever shipped.
 *
 * @package Optionia
 */

declare( strict_types=1 );
