<?php
/**
 * The claim contract: four outcomes, and why a boolean cannot carry them.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Upload\UploadQuota;
use Optionia\Upload\UploadRepository;
use PHPUnit\Framework\TestCase;

/**
 * `UploadRepository::claim()` promoting a file to an order.
 *
 * 🔴 **The three-outcome contract had no direct test.** Every assertion reached
 * it through `UploadPromoter`, which only distinguishes "an error was logged"
 * from "none was" — so the constants themselves were never named in a test, and
 * a refactor giving one a different meaning would have been caught by inference
 * or not at all.
 *
 * @covers \Optionia\Upload\UploadRepository
 */
final class UploadRepositoryClaimTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['wpdb'] = new \Optionia_Test_Wpdb();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['wpdb'] );
	}

	/** An unclaimed row is promoted. */
	public function test_an_unclaimed_row_is_claimed(): void {
		$GLOBALS['wpdb']->affected = 1;

		$this->assertSame(
			UploadRepository::CLAIM_CLAIMED,
			( new UploadRepository() )->claim( str_repeat( 'a', 64 ), 64 )
		);
	}

	/**
	 * ⚠️ **A replayed hook is not a conflict.**
	 *
	 * WooCommerce fires the line-item hook more than once for a single order.
	 * The guarded UPDATE matches nothing the second time, and only the owner
	 * lookup can tell that this order already holds the row.
	 */
	public function test_the_same_order_claiming_twice_is_already_ours(): void {
		$GLOBALS['wpdb']->affected = 0;
		$GLOBALS['wpdb']->var      = 64;

		$this->assertSame(
			UploadRepository::CLAIM_ALREADY_OURS,
			( new UploadRepository() )->claim( str_repeat( 'a', 64 ), 64 )
		);
	}

	/**
	 * 🔴 **Another order's file is never taken.**
	 *
	 * Measured before the guard existed: ordering twice with one token left the
	 * row on the *second* order, silently stripping the artwork from the first.
	 */
	public function test_a_row_another_order_owns_is_taken(): void {
		$GLOBALS['wpdb']->affected = 0;
		$GLOBALS['wpdb']->var      = 64;

		$this->assertSame(
			UploadRepository::CLAIM_TAKEN,
			( new UploadRepository() )->claim( str_repeat( 'a', 64 ), 65 )
		);
	}

	/** A token with no row at all cannot be claimed. */
	public function test_a_missing_row_is_taken(): void {
		$GLOBALS['wpdb']->affected = 0;
		$GLOBALS['wpdb']->var      = null;

		$this->assertSame(
			UploadRepository::CLAIM_TAKEN,
			( new UploadRepository() )->claim( str_repeat( 'a', 64 ), 65 )
		);
	}

	/**
	 * 🔴 **A database error is not a conflict, and the difference is the bug.**
	 *
	 * `wpdb::query()` answers `false` only when the statement errored and the
	 * affected-row count otherwise, so `0` means "no row matched" and `false`
	 * means "the database never answered". Folding them together left the row
	 * with its `expires_at` intact while the failure was logged as permanent —
	 * so cleanup would delete a paid order's artwork three days later.
	 */
	public function test_a_database_error_is_not_reported_as_a_conflict(): void {
		$GLOBALS['wpdb']->affected = false;

		$this->assertSame(
			UploadRepository::CLAIM_ERROR,
			( new UploadRepository() )->claim( str_repeat( 'a', 64 ), 64 )
		);
	}

	/**
	 * Input that cannot name a single row never reaches the database.
	 *
	 * @dataProvider unusable
	 *
	 * @param string $token    The token offered.
	 * @param int    $order_id The order offered.
	 */
	public function test_input_that_cannot_identify_a_row_is_refused( string $token, int $order_id ): void {
		$this->assertSame(
			UploadRepository::CLAIM_TAKEN,
			( new UploadRepository() )->claim( $token, $order_id )
		);

		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'Nothing may reach the database.' );
	}

	/**
	 * ⚠️ Claiming against order 0 would clear `expires_at` on a row belonging to
	 * nothing: a file nothing can find and nothing will ever delete.
	 *
	 * @return array<string, array{0: string, 1: int}>
	 */
	public static function unusable(): array {
		return array(
			'no token'       => array( '', 64 ),
			'no order'       => array( str_repeat( 'a', 64 ), 0 ),
			'negative order' => array( str_repeat( 'a', 64 ), -1 ),
		);
	}

	/* --- the quota is part of the write ---------------------------------- */

	/**
	 * 🔴 **The session's ceilings are evaluated as the row lands.**
	 *
	 * `UploadQuota::allows()` runs *before* the endpoint verifies content, decodes
	 * an image and moves the bytes — a window wide enough for two concurrent
	 * uploads from one session to both be told yes. The same check-then-act shape
	 * as the `claim()` race above, and unlike that one no unique index can express
	 * it: the limit is a `SUM`, not a key. So the ceiling lives in the statement.
	 */
	public function test_the_insert_carries_the_sessions_ceilings(): void {
		$GLOBALS['wpdb']->affected = 1;

		( new UploadRepository() )->create(
			array(
				'session_key' => 'sess-1',
				'option_id'   => 'opt-f',
				'stored_name' => 'x.pdf',
				'size_bytes'  => 1024,
			)
		);

		$insert = implode( ' ', $GLOBALS['wpdb']->queries );

		$this->assertStringContainsString( 'INSERT INTO', $insert );
		$this->assertStringContainsString( 'COUNT(*)', $insert, 'The file ceiling must be in the write.' );
		$this->assertStringContainsString( 'SUM(size_bytes)', $insert, 'The byte ceiling must be in the write.' );
		$this->assertStringContainsString( (string) UploadQuota::MAX_FILES, $insert );
		$this->assertStringContainsString( (string) UploadQuota::MAX_BYTES, $insert );
	}

	/**
	 * ⚠️ **A guard that refuses is not an error, and both answer the same way.**
	 *
	 * `false` means the database failed; `0` means the ceiling refused. Either
	 * way no row landed, so the caller gets an empty token and `UploadEndpoint`
	 * removes the stored file rather than leaving an orphan.
	 */
	public function test_a_refused_insert_yields_no_token(): void {
		$GLOBALS['wpdb']->affected = 0;

		$this->assertSame(
			'',
			( new UploadRepository() )->create(
				array(
					'session_key' => 'sess-1',
					'stored_name' => 'x.pdf',
					'size_bytes'  => 1024,
				)
			)
		);
	}
}
