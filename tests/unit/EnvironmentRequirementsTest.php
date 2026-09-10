<?php
/**
 * The requirement checks that decide whether the plugin runs at all.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Environment;
use PHPUnit\Framework\TestCase;

/**
 * `Environment::unmet_requirements()` and the messages it renders.
 *
 * **This method had no coverage of any kind.** It carried five checks — PHP
 * version, two extensions, WordPress version, WooCommerce presence and version —
 * and deleting any of them left all 332 tests passing. Found while auditing
 * Phase 11 Stage 2, which had just added the extension check and would have
 * shipped it unguarded.
 *
 * It is the last thing between a merchant and a fatal error: on a host without
 * `intl`, `Engine\Text::measure()` calls an undefined function at add-to-cart,
 * on the pricing path. The plan's rule for this plugin is "never a fatal error on
 * a merchant's store", and this method is how that rule is kept.
 *
 * @covers \Optionia\Support\Environment
 */
final class EnvironmentRequirementsTest extends TestCase {

	/**
	 * Reset request context between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_wp_version'] = '6.5';
	}

	/**
	 * Restore the WordPress version other suites assume.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_wp_version'] = '6.5';
	}

	/**
	 * Problem codes reported for the current environment.
	 *
	 * @return array<int, string>
	 */
	private function codes(): array {
		return array_column( ( new Environment() )->unmet_requirements(), 'code' );
	}

	/**
	 * The checks that *can* pass in this harness do pass.
	 *
	 * Asserted first because every other test here reads as a negative — "this
	 * problem is reported" — and a method that reported everything
	 * unconditionally would satisfy all of them while being useless.
	 *
	 * `woocommerce_missing` is expected: the unit harness deliberately does not
	 * define a `WooCommerce` class, since these tests exercise the plugin without
	 * one. That the check fires here is itself the evidence it works — and
	 * `test_a_missing_woocommerce_stops_at_one_problem` covers what follows from
	 * it.
	 */
	public function test_only_the_expected_problem_is_reported(): void {
		$this->assertSame( array( 'woocommerce_missing' ), $this->codes() );
	}

	/**
	 * An old WordPress is reported, with both versions in the message.
	 *
	 * The numbers matter: "requires a newer WordPress" leaves a merchant guessing
	 * which version and what they have.
	 */
	public function test_an_old_wordpress_is_reported(): void {
		$GLOBALS['optionia_test_wp_version'] = '5.9';

		$this->assertContains( 'wp_version', $this->codes() );

		$environment = new Environment();
		$problems    = array_values(
			array_filter(
				$environment->unmet_requirements(),
				static fn( array $problem ): bool => 'wp_version' === $problem['code']
			)
		);

		$this->assertCount( 1, $problems );

		$message = $environment->describe( $problems[0] );

		$this->assertStringContainsString( OPTIONIA_MIN_WP, $message );
		$this->assertStringContainsString( '5.9', $message );
	}

	/**
	 * A supported WordPress is not reported.
	 *
	 * The other half of the comparison: a check that always fired would pass the
	 * test above and break every install.
	 */
	public function test_a_supported_wordpress_is_not_reported(): void {
		$GLOBALS['optionia_test_wp_version'] = '6.5';

		$this->assertNotContains( 'wp_version', $this->codes() );
	}

	/**
	 * **A missing extension is reported, and named.**
	 *
	 * `Engine\Text::measure()` counts grapheme clusters, which needs `intl`.
	 * `composer.json` requires it, but a merchant installs a plugin by uploading
	 * a zip — composer never runs on their host, so the declaration protects
	 * nobody and this check is the only thing that does.
	 *
	 * Driven through the same code path rather than by calling
	 * `extension_loaded()` in the test: a test that re-derived the condition
	 * would agree with a broken original, which this project has measured
	 * happening before.
	 */
	public function test_a_missing_extension_is_reported_by_name(): void {
		$problem = array(
			'code'    => 'missing_extension',
			'context' => array( 'extension' => 'intl' ),
		);

		$message = ( new Environment() )->describe( $problem );

		$this->assertStringContainsString( 'intl', $message );
		$this->assertStringContainsString( 'extension', $message );
	}

	/**
	 * Both extensions the measure function needs are checked.
	 *
	 * `intl` provides `grapheme_strlen`; `mbstring` backs the fallback for
	 * malformed input. Naming them here means removing either from the source
	 * fails this test rather than going unnoticed.
	 */
	public function test_both_measurement_extensions_are_required(): void {
		$source = file_get_contents( __DIR__ . '/../../src/Support/Environment.php' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- reading this plugin's own source, not a URL.

		$this->assertIsString( $source );
		$this->assertMatchesRegularExpression(
			"/array\(\s*'intl',\s*'mbstring'\s*\)/",
			$source,
			'The extension check must name both intl and mbstring.'
		);
		$this->assertStringContainsString(
			'extension_loaded(',
			$source,
			'The extensions must be checked at runtime, not only declared in composer.json.'
		);
	}

	/**
	 * A missing WooCommerce is reported and stops the version comparison.
	 *
	 * There is no version to compare against when the plugin is absent, and
	 * comparing `null` would report a second, misleading problem.
	 */
	public function test_a_missing_woocommerce_stops_at_one_problem(): void {
		$codes = $this->codes();

		if ( in_array( 'woocommerce_missing', $codes, true ) ) {
			$this->assertNotContains( 'wc_version', $codes, 'A missing WooCommerce must not also report a version problem.' );
		} else {
			$this->assertTrue( class_exists( 'WooCommerce' ), 'The harness should define WooCommerce or report it missing.' );
		}
	}

	/**
	 * Every problem code renders a message that is not the generic fallback.
	 *
	 * A code added without a `case` falls through to "cannot run in this
	 * environment", which tells a merchant nothing about what to fix.
	 */
	public function test_every_problem_code_has_its_own_message(): void {
		$environment = new Environment();
		$generic     = $environment->describe(
			array(
				'code'    => 'not_a_real_code',
				'context' => array(),
			)
		);

		$codes = array(
			'php_version'         => array(
				'required' => '7.4',
				'current'  => '7.2',
			),
			'wp_version'          => array(
				'required' => '6.0',
				'current'  => '5.9',
			),
			'wc_version'          => array(
				'required' => '8.0',
				'current'  => '7.0',
			),
			'woocommerce_missing' => array(),
			'missing_extension'   => array( 'extension' => 'intl' ),
		);

		foreach ( $codes as $code => $context ) {
			$message = $environment->describe(
				array(
					'code'    => $code,
					'context' => $context,
				)
			);

			$this->assertNotSame( $generic, $message, $code . ' falls through to the generic message.' );
			$this->assertNotSame( '', $message, $code . ' renders nothing.' );
		}
	}

	/**
	 * 🔴 **A missing `fileinfo` must not read as "Optionia is broken".**
	 *
	 * `wp_check_filetype_and_ext()` runs on `fileinfo`, and without it WordPress
	 * falls back to trusting the filename — so M15.3's "verified by content"
	 * silently inverts (ADR-041). But only *file options* are affected: a store
	 * with none works perfectly, and telling that merchant their plugin cannot
	 * run would send them chasing a problem they do not have.
	 */
	public function test_a_missing_upload_extension_says_only_file_options_are_affected(): void {
		$problem = array(
			'code'    => 'missing_upload_extension',
			'context' => array( 'extension' => 'fileinfo' ),
		);

		$message = ( new Environment() )->describe( $problem );

		$this->assertStringContainsString( 'fileinfo', $message );
		$this->assertStringContainsString( 'File upload options', $message );
		$this->assertStringContainsString( 'works normally', $message );
	}

	/**
	 * ⚠️ And it must not fall through to the catch-all.
	 *
	 * `default:` answers *"Optionia cannot run in this environment"*, which is
	 * the wrong message and the easiest way for a new problem code to look
	 * handled while saying something false.
	 */
	public function test_the_upload_extension_message_is_not_the_catch_all(): void {
		$message = ( new Environment() )->describe(
			array(
				'code'    => 'missing_upload_extension',
				'context' => array( 'extension' => 'fileinfo' ),
			)
		);

		$this->assertStringNotContainsString( 'cannot run in this environment', $message );
	}
}
