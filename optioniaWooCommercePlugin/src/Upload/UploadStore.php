<?php
/**
 * Where a customer's file is written, and why it is not reachable over the web.
 *
 * ## The hole this class exists to close
 *
 * 🔴 **Measured, not assumed.** A probe file written to `wp-content/uploads/`
 * on the development site and fetched over HTTPS answered **200**. There is no
 * `.htaccess` and no `index.php` in that directory on a default install — every
 * byte WordPress puts there is served to anyone who knows the path.
 *
 * A customer's engraved photograph, signed contract or print artwork is not
 * public. M15.3 already requires *"no filename-derived paths"*, and that is
 * necessary but **not sufficient**: an unguessable filename inside a listable,
 * fetchable directory is one directory index away from public.
 *
 * ## Three layers, because each fails differently
 *
 * 1. **An unguessable directory segment**, derived from `wp_salt()` — so the
 *    path cannot be predicted from the store's URL or a customer's order.
 * 2. **`.htaccess` and a `web.config`**, which stop Apache and IIS serving the
 *    directory at all. Nginx honours neither, which is why there is a third.
 * 3. **`index.php`**, so a server with directory indexing enabled and no
 *    `.htaccess` support answers a blank page rather than a file list.
 *
 * ⚠️ **Measured after building this, and the result matters: the guards did
 * nothing on the development server.** A probe file inside the guarded directory
 * answered **200**, identical to an unguarded one. Studio serves the site with
 * PHP's built-in server, which reads neither `.htaccess` nor `web.config`. The
 * files were on disk and simply unread.
 *
 * `index.php` did work — the directory listing came back empty — so a server
 * with indexing on and no rewrite support still cannot enumerate the folder. But
 * a direct hit on a known path succeeded.
 *
 * 🔴 **So the real defence is unguessability, and the web-server guards are a
 * bonus where the host happens to honour them.** That is why the path carries
 * *two independent* secrets:
 *
 * - the **directory**, from `wp_salt()` — 16 hex characters, 64 bits, and the
 *   salt is never public;
 * - the **filename**, random per file — so learning the directory once does not
 *   expose every file stored in it, now or later.
 *
 * A single shared secret would mean one leaked path compromises the whole store
 * permanently. Two means a leak exposes one customer's file.
 *
 * Retrieval for the merchant goes through PHP (M15.5), never a direct link, for
 * exactly this reason.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * The protected upload directory, created and guarded on demand.
 */
final class UploadStore {

	/**
	 * Extensions a web server may execute, and which are therefore never stored.
	 *
	 * 🔴 **Proven necessary by measurement**, not by caution: a `.php` file in the
	 * guarded directory executed over HTTPS on this machine.
	 *
	 * Covers the four families that matter — PHP in all its numbered variants,
	 * server-side templating (`.phtml`), CGI/scripting handlers a host may have
	 * mapped, and `.htaccess` itself, which would let an attacker re-enable
	 * execution for everything else in the folder.
	 *
	 * ⚠️ **Double extensions are already handled**, because only the *last*
	 * segment survives: `pathinfo('shell.php.jpg', PATHINFO_EXTENSION)` is `jpg`,
	 * and Apache's `AddHandler` misconfiguration — where `shell.php.jpg` executes
	 * — cannot arise, since the stored name is regenerated rather than reused.
	 */
	private const EXECUTABLE_EXTENSIONS = array(
		'php',
		'php3',
		'php4',
		'php5',
		'php7',
		'php8',
		'phps',
		'phtml',
		'phar',
		'shtml',
		'cgi',
		'pl',
		'py',
		'rb',
		'sh',
		'bash',
		'jsp',
		'asp',
		'aspx',
		'htaccess',
		'htpasswd',
		'ini',
	);

	/**
	 * The directory name inside `wp-content/uploads/`.
	 *
	 * Prefixed so a merchant browsing their own filesystem can see whose it is,
	 * and suffixed with a site-specific hash so the full path cannot be guessed
	 * from the store's address alone.
	 */
	private const DIR_PREFIX = 'optionia-uploads-';

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build a store over the logger.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * The absolute path to the upload directory, creating and guarding it.
	 *
	 * Returns an empty string when the directory cannot be created or guarded —
	 * **never a usable-looking path that is unprotected**. A caller that cannot
	 * get a directory must refuse the upload, because writing a customer's file
	 * somewhere public is worse than refusing it.
	 */
	public function directory(): string {
		$uploads = wp_upload_dir();

		if ( ! is_array( $uploads ) || ! empty( $uploads['error'] ) || empty( $uploads['basedir'] ) ) {
			$this->logger->warning(
				'Upload directory unavailable; refusing to store files.',
				array( 'error' => is_array( $uploads ) ? ( $uploads['error'] ?? '' ) : 'no array' )
			);

			return '';
		}

		$path = rtrim( (string) $uploads['basedir'], '/\\' ) . '/' . $this->directory_name();

		if ( ! wp_mkdir_p( $path ) ) {
			$this->logger->warning( 'Could not create the upload directory.', array( 'path' => $path ) );

			return '';
		}

		if ( ! $this->guard( $path ) ) {
			return '';
		}

		return $path;
	}

	/**
	 * The directory's name, unguessable but stable for this site.
	 *
	 * `wp_salt()` is site-specific and secret, so the hash cannot be derived from
	 * anything public. Stable rather than random because existing files must stay
	 * findable across requests — the unguessability protects the path, and a
	 * rotating name would orphan every file already stored.
	 */
	private function directory_name(): string {
		$seed = function_exists( 'wp_salt' ) ? wp_salt( 'nonce' ) : '';

		// 16 hex characters: 64 bits, far past guessing, short enough to read.
		return self::DIR_PREFIX . substr( hash( 'sha256', 'optionia-uploads|' . $seed ), 0, 16 );
	}

	/**
	 * A random, unguessable filename that keeps the original extension.
	 *
	 * 🔴 **The second independent secret.** The directory is unguessable but
	 * *shared* — one leaked path would otherwise expose every file in it forever.
	 * A per-file random name means a leak exposes one customer's file.
	 *
	 * ⚠️ **Never derived from the customer's filename**, which M15.3 requires:
	 * `wp_unique_filename()` would keep `invoice.pdf` and merely deduplicate it,
	 * so a guessed directory plus an obvious name is a readable document. The
	 * original name is stored in the database for the merchant to see, not on
	 * disk.
	 *
	 * `random_bytes()` throws rather than returning weak output when no source of
	 * entropy exists — the caller must let that refuse the upload, never fall
	 * back to something predictable.
	 *
	 * 🔴 **An executable extension is stripped, and this is not optional.**
	 *
	 * Measured on the development site: a `.php` file written into the guarded
	 * directory and fetched over HTTPS answered **200** with `EXECUTED-8.4.24` in
	 * the body. That is remote code execution, and the `.htaccess` guard did not
	 * stop it — PHP's built-in server ignores the file, and so do nginx and any
	 * Apache without `AllowOverride`.
	 *
	 * ⚠️ **This is storage safety, not content validation.** M15.3 owns magic
	 * bytes, SVG rejection and malware scanning; none of that helps if the *name*
	 * makes the server run the bytes. A file whose extension is dangerous is
	 * stored with **no** extension at all rather than being renamed to something
	 * plausible: the original name is kept in the database for the merchant, and
	 * nothing needs the on-disk name to be meaningful.
	 *
	 * The list is a denylist rather than an allowlist **on purpose**. An
	 * allowlist here would silently drop the extension of every legitimate print
	 * format nobody thought to list — `.ai`, `.eps`, `.indd`, `.cdr` — and M15.3
	 * is where the accepted-types allowlist belongs, decided per option by the
	 * merchant. This list answers a narrower question: what must a web server
	 * never be handed?
	 *
	 * @param string $extension Extension from the uploaded name, without a dot.
	 * @throws \Exception When the platform has no secure randomness.
	 */
	public function unique_filename( string $extension ): string {
		$name = bin2hex( random_bytes( 16 ) );
		$safe = strtolower( preg_replace( '/[^a-z0-9]/i', '', $extension ) ?? '' );

		if ( '' === $safe || in_array( $safe, self::EXECUTABLE_EXTENSIONS, true ) ) {
			return $name;
		}

		return $name . '.' . $safe;
	}

	/**
	 * Write the guard files, reporting whether the directory is safe to use.
	 *
	 * Each is written only when absent: rewriting them on every upload would be
	 * needless disk work, and a merchant who deliberately customised one would
	 * have it silently reverted.
	 *
	 * @param string $path Absolute directory path.
	 */
	private function guard( string $path ): bool {
		$guards = array(

			/*
			 * Apache 2.2 and 2.4 use different syntax, and a directive the running
			 * version does not understand is a 500 rather than a refusal — so both
			 * are written inside version guards.
			 */
			'.htaccess'  => "# Optionia: customer uploads are not public.\n"
				. "<IfModule mod_authz_core.c>\n\tRequire all denied\n</IfModule>\n"
				. "<IfModule !mod_authz_core.c>\n\tOrder allow,deny\n\tDeny from all\n</IfModule>\n",

			// IIS reads this; it ignores .htaccess entirely.
			'web.config' => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<configuration>\n"
				. "\t<system.webServer>\n\t\t<authorization>\n"
				. "\t\t\t<deny users=\"*\" />\n"
				. "\t\t</authorization>\n\t</system.webServer>\n</configuration>\n",

			// The last line of defence where neither of the above is read.
			'index.php'  => "<?php\n// Silence is golden.\n",
		);

		foreach ( $guards as $name => $contents ) {
			$file = $path . '/' . $name;

			if ( file_exists( $file ) ) {
				continue;
			}

			/*
			 * Suppressed deliberately, and the return value is the check.
			 *
			 * A read-only directory makes `file_put_contents` emit a warning,
			 * and a storefront must not print PHP warnings to a customer
			 * mid-purchase. `false` is what this acts on — and it refuses the
			 * whole directory rather than storing a file it could not guard.
			 *
			 * `WP_Filesystem` is not used here: it can require FTP credentials,
			 * and a customer's upload must not depend on a merchant having
			 * entered them.
			 */
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- see above.
			if ( false === @file_put_contents( $file, $contents ) ) {
				$this->logger->warning(
					'Could not write an upload directory guard; refusing to store files.',
					array( 'file' => $file )
				);

				return false;
			}
		}

		return true;
	}
}
