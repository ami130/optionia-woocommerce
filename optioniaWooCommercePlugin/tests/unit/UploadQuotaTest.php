<?php
/**
 * What actually bounds abuse of the upload endpoint.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Upload\UploadQuota;
use Optionia\Upload\ReportsSessionUsage;
use PHPUnit\Framework\TestCase;

/**
 * Per-session upload limits — the real bound on abuse.
 *
 * @covers \Optionia\Upload\UploadQuota
 */
final class UploadQuotaTest extends TestCase {

	/**
	 * A repository reporting fixed usage, so the quota's arithmetic is what is
	 * under test rather than the database.
	 *
	 * @param int $count Files already held.
	 * @param int $bytes Bytes already held.
	 */
	private function quota( int $count, int $bytes ): UploadQuota {
		$uploads = new class( $count, $bytes ) implements ReportsSessionUsage {
			/**
			 * Files already held.
			 *
			 * @var int
			 */
			private int $count;

			/**
			 * Bytes already held.
			 *
			 * @var int
			 */
			private int $bytes;

			/**
			 * Record the fixed usage this double reports.
			 *
			 * @param int $count Files already held.
			 * @param int $bytes Bytes already held.
			 */
			public function __construct( int $count, int $bytes ) {
				$this->count = $count;
				$this->bytes = $bytes;
			}

			/**
			 * What this session is pretending to hold.
			 *
			 * @param string $session_key Session.
			 * @return array{count: int, bytes: int}
			 */
			public function session_usage( string $session_key ): array {
				return array(
					'count' => $this->count,
					'bytes' => $this->bytes,
				);
			}
		};

		return new UploadQuota( $uploads );
	}

	public function test_it_allows_a_first_upload(): void {
		$this->assertTrue( $this->quota( 0, 0 )->allows( 'session-a', 500000 ) );
	}

	/**
	 * 🔴 **The count limit is checked including the incoming file.**
	 *
	 * Checking what is already held and allowing one more would let a session
	 * end one file past the ceiling every time.
	 */
	public function test_it_refuses_one_past_the_file_limit(): void {
		$at_limit = $this->quota( UploadQuota::MAX_FILES, 0 );

		$this->assertFalse( $at_limit->allows( 'session-a', 1000 ) );
	}

	public function test_it_allows_the_last_file_that_fits(): void {
		$one_short = $this->quota( UploadQuota::MAX_FILES - 1, 0 );

		$this->assertTrue( $one_short->allows( 'session-a', 1000 ) );
	}

	/**
	 * ⚠️ **A separate byte limit, because the two fail differently.**
	 *
	 * Twenty large files and twenty small ones are the same *count* and very
	 * different amounts of a merchant's disk.
	 */
	public function test_it_refuses_when_bytes_would_exceed_the_cap(): void {
		$nearly_full = $this->quota( 1, UploadQuota::MAX_BYTES - 100 );

		$this->assertFalse( $nearly_full->allows( 'session-a', 500 ) );
	}

	public function test_it_allows_bytes_up_to_exactly_the_cap(): void {
		$nearly_full = $this->quota( 1, UploadQuota::MAX_BYTES - 500 );

		$this->assertTrue( $nearly_full->allows( 'session-a', 500 ) );
	}

	/**
	 * 🔴 **An unidentifiable visitor is refused, not shared.**
	 *
	 * Letting sessionless requests share one bucket would make the quota a
	 * single global limit: one abuser would lock out every genuine customer on
	 * the store.
	 */
	public function test_it_refuses_a_request_with_no_session(): void {
		$this->assertFalse( $this->quota( 0, 0 )->allows( '', 1000 ) );
	}

	public function test_it_refuses_a_zero_byte_file(): void {
		$this->assertFalse( $this->quota( 0, 0 )->allows( 'session-a', 0 ) );
	}

	/**
	 * The limits are deliberate values, not incidental ones — asserted so a
	 * change is a decision rather than a drift.
	 */
	public function test_the_limits_are_what_they_claim(): void {
		$this->assertSame( 20, UploadQuota::MAX_FILES );
		$this->assertSame( 104857600, UploadQuota::MAX_BYTES );
	}
}
