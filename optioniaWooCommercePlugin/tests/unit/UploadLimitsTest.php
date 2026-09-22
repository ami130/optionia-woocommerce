<?php
/**
 * The host's upload ceiling, and what a merchant may configure against it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Upload\UploadLimits;
use PHPUnit\Framework\TestCase;

/**
 * The host ceiling, and what a merchant may configure against it.
 *
 * @covers \Optionia\Upload\UploadLimits
 */
final class UploadLimitsTest extends TestCase {

	/**
	 * Restore the default ceiling between tests.
	 */
	protected function tearDown(): void {
		unset( $GLOBALS['optionia_test_max_upload'] );
	}

	/**
	 * The stub's ceiling, asserted so the fixture stays visible.
	 *
	 * ✏️ **This comment claimed 2 MB was "measured on the development site". It
	 * was not** — that figure came from `ini_get()` through the **CLI binary**.
	 * Measured over HTTP, the only context a customer's upload runs in, the same
	 * site reports `upload_max_filesize=2G` and `wp_max_upload_size()` of 2 GB.
	 *
	 * 2 MB is kept as the **test** ceiling deliberately: it is a plausible shared
	 * host, and a fixture generous enough to accept everything would let a
	 * missing check pass. The number is a fixture, not a measurement.
	 */
	public function test_it_reads_the_host_ceiling(): void {
		$this->assertSame( 2097152, UploadLimits::host_max_bytes() );
		$this->assertSame( 2, UploadLimits::host_max_mb() );
	}

	/**
	 * A host too small to carry a photograph is reported as unusable.
	 */
	public function test_a_tiny_host_does_not_support_uploads(): void {
		$GLOBALS['optionia_test_max_upload'] = 512000;

		$this->assertFalse( UploadLimits::host_supports_uploads() );
	}

	public function test_a_normal_host_supports_uploads(): void {
		$this->assertTrue( UploadLimits::host_supports_uploads() );
	}

	/**
	 * 🔴 **The merchant's limit never exceeds the host's.**
	 *
	 * A document written against a generous host and synced to a modest one must
	 * not authorise an upload the server truncates — the same rule the resolver
	 * applies to `max_length`, where the lower of the two wins.
	 */
	public function test_the_host_caps_a_larger_configured_limit(): void {
		$this->assertSame( 2097152, UploadLimits::effective_max_bytes( 20971520 ) );
	}

	public function test_a_smaller_configured_limit_wins(): void {
		$this->assertSame( 1048576, UploadLimits::effective_max_bytes( 1048576 ) );
	}

	/**
	 * No configured limit means the host's own ceiling, not "unlimited".
	 */
	public function test_no_configured_limit_falls_back_to_the_host(): void {
		$this->assertSame( 2097152, UploadLimits::effective_max_bytes( 0 ) );
	}

	/**
	 * ⚠️ An unknown ceiling authorises nothing.
	 *
	 * A wrong non-zero number would let an upload through that the server then
	 * truncates, which fails as a corrupt file rather than a clear refusal.
	 */
	public function test_an_unknown_host_ceiling_accepts_nothing(): void {
		$GLOBALS['optionia_test_max_upload'] = 0;

		$this->assertSame( 0, UploadLimits::effective_max_bytes( 5000000 ) );
		$this->assertFalse( UploadLimits::accepts( 100, 5000000 ) );
	}

	public function test_it_accepts_a_file_within_both_limits(): void {
		$this->assertTrue( UploadLimits::accepts( 500000, 1048576 ) );
	}

	public function test_it_refuses_a_file_over_the_configured_limit(): void {
		$this->assertFalse( UploadLimits::accepts( 2000000, 1048576 ) );
	}

	public function test_it_refuses_a_file_over_the_host_limit(): void {
		$this->assertFalse( UploadLimits::accepts( 3000000, 20971520 ) );
	}

	public function test_it_accepts_a_file_at_exactly_the_limit(): void {
		$this->assertTrue( UploadLimits::accepts( 2097152, 0 ) );
	}

	public function test_it_refuses_an_empty_file(): void {
		$this->assertFalse( UploadLimits::accepts( 0, 1048576 ) );
	}

	/**
	 * Rounded **down** for display: telling a merchant "2 MB" on a host allowing
	 * 2,097,151 bytes is actionable; rounding up invites a limit that fails.
	 */
	public function test_display_megabytes_round_down(): void {
		$GLOBALS['optionia_test_max_upload'] = 2097151;

		$this->assertSame( 1, UploadLimits::host_max_mb() );
	}
}
