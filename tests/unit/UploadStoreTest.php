<?php
/**
 * Where customer files are written, and why the path is not guessable.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadStore;
use PHPUnit\Framework\TestCase;

/**
 * Protected storage: guards, unguessable paths, refusal on failure.
 *
 * @covers \Optionia\Upload\UploadStore
 */
final class UploadStoreTest extends TestCase {

	/**
	 * A temporary uploads root, distinct per test run.
	 *
	 * @var string
	 */
	private string $base = '';

	protected function setUp(): void {
		$this->base = sys_get_temp_dir() . '/optionia-store-' . bin2hex( random_bytes( 4 ) );

		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => $this->base,
			'baseurl' => 'https://example.test/uploads',
			'error'   => false,
		);
	}

	protected function tearDown(): void {
		unset( $GLOBALS['optionia_test_upload_dir'] );

		/*
		 * `scandir`, not `glob`: the guards this class writes are **dotfiles**,
		 * and `glob('*')` skips them — so the first version of this teardown left
		 * `.htaccess` behind and every `rmdir` failed with "Directory not empty".
		 */
		$this->remove_tree( $this->base );
	}

	/**
	 * Delete a directory and everything in it, dotfiles included.
	 *
	 * @param string $dir Absolute path.
	 */
	private function remove_tree( string $dir ): void {
		if ( ! is_dir( $dir ) ) {
			return;
		}

		$entries = scandir( $dir );

		foreach ( false === $entries ? array() : $entries as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}

			$path = $dir . '/' . $entry;

			if ( is_dir( $path ) ) {
				$this->remove_tree( $path );
			} else {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- test teardown; WP_Filesystem is not bootstrapped in unit tests.
				unlink( $path );
			}
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- test teardown; see above.
		rmdir( $dir );
	}

	/**
	 * A store over real collaborators.
	 */
	private function store(): UploadStore {
		return new UploadStore( new Logger( new Settings() ) );
	}

	/**
	 * 🔴 **The three guard files exist.**
	 *
	 * Measured on the development site: a probe written to `wp-content/uploads/`
	 * and fetched over HTTPS answered **200**, with no `.htaccess` and no
	 * `index.php` present. These are what close that on hosts that read them.
	 */
	public function test_it_writes_all_three_guards(): void {
		$dir = $this->store()->directory();

		$this->assertNotSame( '', $dir );
		$this->assertFileExists( $dir . '/.htaccess' );
		$this->assertFileExists( $dir . '/web.config' );
		$this->assertFileExists( $dir . '/index.php' );
	}

	/**
	 * The Apache guard covers both 2.2 and 2.4 syntax.
	 *
	 * A directive the running version does not understand is a **500**, not a
	 * refusal — so a merchant's whole uploads directory would break rather than
	 * being protected.
	 */
	public function test_the_htaccess_covers_both_apache_versions(): void {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a test reading a file it just wrote; WP_Filesystem is not bootstrapped here.
		$contents = (string) file_get_contents( $this->store()->directory() . '/.htaccess' );

		$this->assertStringContainsString( 'Require all denied', $contents );
		$this->assertStringContainsString( 'Deny from all', $contents );
		$this->assertStringContainsString( 'IfModule', $contents );
	}

	/**
	 * ⚠️ **The directory name cannot be derived from anything public.**
	 *
	 * It is a hash of `wp_salt()`, which lives in `wp-config.php`. A name built
	 * from the site URL or the plugin version would be guessable, and on a host
	 * that ignores `.htaccess` — PHP's built-in server does, verified — the path
	 * is the only defence left.
	 */
	public function test_the_directory_name_is_not_predictable(): void {
		$name = basename( $this->store()->directory() );

		$this->assertMatchesRegularExpression( '/^optionia-uploads-[0-9a-f]{16}$/', $name );
		$this->assertStringNotContainsString( 'example.test', $name );
	}

	/**
	 * Stable across calls: existing files must stay findable.
	 */
	public function test_the_directory_name_is_stable(): void {
		$this->assertSame( $this->store()->directory(), $this->store()->directory() );
	}

	/**
	 * 🔴 **A second, independent secret per file.**
	 *
	 * The directory is unguessable but *shared* — one leaked path would expose
	 * every file in it forever. A random filename means a leak exposes one.
	 */
	public function test_filenames_are_random_and_unique(): void {
		$store = $this->store();
		$a     = $store->unique_filename( 'pdf' );
		$b     = $store->unique_filename( 'pdf' );

		$this->assertNotSame( $a, $b );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}\.pdf$/', $a );
	}

	/**
	 * ⚠️ **Never derived from what the customer called the file** (M15.3).
	 *
	 * `invoice.pdf` inside a guessed directory is a readable document; a random
	 * name is not. The original is kept in the database for the merchant.
	 */
	public function test_a_filename_keeps_no_trace_of_the_original(): void {
		$name = $this->store()->unique_filename( 'pdf' );

		$this->assertStringNotContainsString( 'invoice', $name );
	}

	/**
	 * 🔴 A traversal attempt in the extension cannot escape the directory.
	 */
	public function test_it_strips_path_traversal_from_the_extension(): void {
		$name = $this->store()->unique_filename( '../../../etc/passwd' );

		$this->assertStringNotContainsString( '/', $name );
		$this->assertStringNotContainsString( '.', substr( $name, 0, 32 ) );
	}

	public function test_it_lowercases_the_extension(): void {
		$this->assertStringEndsWith( '.png', $this->store()->unique_filename( 'PNG' ) );
	}

	/**
	 * No extension is valid: a file with none still needs a name.
	 */
	public function test_an_empty_extension_yields_a_bare_name(): void {
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/', $this->store()->unique_filename( '' ) );
	}

	/**
	 * 🔴 **An unusable uploads directory refuses rather than returning a path.**
	 *
	 * Writing a customer's file somewhere unprotected is worse than refusing the
	 * upload, so the caller must get an empty string and stop.
	 */
	public function test_it_refuses_when_the_uploads_directory_errors(): void {
		$GLOBALS['optionia_test_upload_dir'] = array(
			'basedir' => '',
			'baseurl' => '',
			'error'   => 'Disk full',
		);

		$this->assertSame( '', $this->store()->directory() );
	}

	/**
	 * 🔴 **A `.php` upload must not keep its extension.**
	 *
	 * Measured on the development site before this existed: a `.php` file written
	 * into the guarded directory and fetched over HTTPS answered **200** with
	 * `EXECUTED-8.4.24` in the body. That is remote code execution, and the
	 * `.htaccess` guard did not stop it — PHP's built-in server ignores the file,
	 * as do nginx and any Apache without `AllowOverride`.
	 *
	 * ⚠️ Storage safety, not content validation: M15.3's magic-byte checks do not
	 * help if the *name* makes the server run the bytes.
	 *
	 * @dataProvider executable_extensions
	 * @param string $extension A dangerous extension.
	 */
	public function test_an_executable_extension_is_stripped( string $extension ): void {
		$name = $this->store()->unique_filename( $extension );

		$this->assertStringNotContainsString( '.', $name, "'.{$extension}' must not survive." );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/', $name );
	}

	/**
	 * Extensions a web server may execute.
	 *
	 * @return array<int, array{0: string}>
	 */
	public function executable_extensions(): array {
		return array(
			array( 'php' ),
			array( 'PHP' ),
			array( 'php5' ),
			array( 'php8' ),
			array( 'phtml' ),
			array( 'phar' ),
			array( 'shtml' ),
			array( 'cgi' ),
			array( 'pl' ),
			array( 'py' ),
			array( 'sh' ),
			array( 'jsp' ),
			array( 'asp' ),
			array( 'aspx' ),
			array( 'htaccess' ),
			array( 'htpasswd' ),
			array( 'ini' ),
		);
	}

	/**
	 * ⚠️ **The print formats this phase exists for must survive.**
	 *
	 * A denylist rather than an allowlist, deliberately: an allowlist would
	 * silently strip `.ai`, `.eps` or `.indd` because nobody listed them, and
	 * M15.3 is where the merchant's accepted-types allowlist belongs.
	 *
	 * @dataProvider print_extensions
	 * @param string $extension A legitimate extension.
	 */
	public function test_a_legitimate_extension_survives( string $extension ): void {
		$this->assertStringEndsWith( '.' . $extension, $this->store()->unique_filename( $extension ) );
	}

	/**
	 * Formats print-on-demand and signage actually use.
	 *
	 * @return array<int, array{0: string}>
	 */
	public function print_extensions(): array {
		return array(
			array( 'pdf' ),
			array( 'png' ),
			array( 'jpg' ),
			array( 'tiff' ),
			array( 'ai' ),
			array( 'eps' ),
			array( 'psd' ),
			array( 'indd' ),
		);
	}

	/**
	 * A double extension keeps only the last segment.
	 *
	 * `pathinfo('shell.php.jpg', PATHINFO_EXTENSION)` is `jpg`, so an Apache
	 * `AddHandler` misconfiguration — where `shell.php.jpg` executes — cannot
	 * arise: the stored name is regenerated rather than reused.
	 */
	public function test_a_double_extension_cannot_smuggle_php(): void {
		$name = $this->store()->unique_filename( pathinfo( 'shell.php.jpg', PATHINFO_EXTENSION ) );

		$this->assertStringEndsWith( '.jpg', $name );
		$this->assertStringNotContainsString( 'php', $name );
	}
}
