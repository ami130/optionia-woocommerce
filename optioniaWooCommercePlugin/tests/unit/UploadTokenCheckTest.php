<?php
/**
 * Verifying a file token once, at add-to-cart.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Upload\UploadQuota;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadTokenCheck;
use PHPUnit\Framework\TestCase;

/**
 * `UploadTokenCheck` deciding whether a cart line's files are usable.
 *
 * 🔴 **Nothing verified a token before this class existed.** The resolver checks
 * the token's *shape* — `Engine/` is pure and cannot reach the database — so a
 * crafted string, or a token whose file has since been released, satisfied it.
 * ADR-040 requires the purged case to fail loudly rather than reach a merchant
 * as an order with artwork that does not exist.
 *
 * @covers \Optionia\Upload\UploadTokenCheck
 */
final class UploadTokenCheckTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['wpdb'] = new \Optionia_Test_Wpdb();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['wpdb'] );
	}

	/** A well-formed upload token. */
	private function token( string $seed = 'a' ): string {
		return str_repeat( $seed, 64 );
	}

	private function check(): UploadTokenCheck {
		$uploads = new UploadRepository();

		return new UploadTokenCheck( $uploads, new UploadQuota( $uploads ) );
	}

	/**
	 * The row `find_for_session()` will answer with.
	 *
	 * @param array<string, mixed>|null $row The row, or null for none.
	 */
	private function rowIs( ?array $row ): void {
		$GLOBALS['wpdb']->rows = $row;
	}

	/* --- selections with no files ---------------------------------------- */

	/**
	 * ⚠️ **A selection map carries every option's value.** A colour swatch's
	 * `red` is not a token and must never be looked up as one.
	 */
	public function test_a_selection_with_no_tokens_passes_without_a_lookup(): void {
		$this->assertTrue( $this->check()->passes( array( 'opt-c' => 'red' ), 'sess-1' ) );
		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'Nothing may reach the database.' );
	}

	/** An empty selection set has nothing to refuse. */
	public function test_an_empty_selection_passes(): void {
		$this->assertTrue( $this->check()->passes( array(), 'sess-1' ) );
	}

	/** A non-scalar value cannot be a token and must not crash the check. */
	public function test_a_non_scalar_value_is_ignored(): void {
		$this->assertTrue( $this->check()->passes( array( 'opt-x' => array( 'a' ) ), 'sess-1' ) );
	}

	/**
	 * 🔴 **A cart with no files never touches the WooCommerce session.**
	 *
	 * `UploadQuota::session_key()` is not a pure read — it calls
	 * `set_customer_session_cookie()` when no session exists. Passing it as an
	 * argument evaluated it eagerly, so every cart and checkout view on a store
	 * with no file options at all paid for it.
	 *
	 * The session stub counts reads, so this can tell "asked and ignored" from
	 * "never asked" — without the counter the test would pass either way.
	 */
	public function test_a_selection_with_no_tokens_never_resolves_the_session(): void {
		$session        = WC()->session;
		$session->reads = 0;

		$this->assertTrue( $this->check()->passes( array( 'opt-c' => 'red' ) ) );
		$this->assertSame( 0, $session->reads, 'A cart with no files must not touch the session.' );
	}

	/** A cart that does carry a file resolves the session, once. */
	public function test_a_selection_with_a_token_does_resolve_the_session(): void {
		$session        = WC()->session;
		$session->reads = 0;

		$this->rowIs( null );
		$this->check()->passes( array( 'opt-f' => $this->token() ) );

		$this->assertSame( 1, $session->reads );
	}

	/* --- the tokens themselves ------------------------------------------- */

	/**
	 * 🔴 **The reorder case ADR-040 names.** `OrderAgain` replays a past order's
	 * token, and `UploadExpirer` releases abandoned files after 72 hours — so a
	 * customer reordering old artwork replays a token whose file is gone. It must
	 * fail loudly: a reprint that arrives blank is worse than a reorder that says
	 * "please upload your artwork again".
	 */
	public function test_a_token_with_no_row_is_refused(): void {
		$this->rowIs( null );

		$this->assertFalse( $this->check()->passes( array( 'opt-f' => $this->token() ), 'sess-1' ) );
	}

	/** A live, unclaimed file belonging to this visitor is usable. */
	public function test_a_live_token_passes(): void {
		$this->rowIs(
			array(
				'token'    => $this->token(),
				'order_id' => null,
			)
		);

		$this->assertTrue( $this->check()->passes( array( 'opt-f' => $this->token() ), 'sess-1' ) );
	}

	/**
	 * 🔴 **A file already on an order is not this cart's to take.**
	 *
	 * `claim()` refuses to move a row between orders, so accepting the line here
	 * would create an order whose artwork silently belongs to a different one.
	 */
	public function test_a_token_already_claimed_by_an_order_is_refused(): void {
		$this->rowIs(
			array(
				'token'    => $this->token(),
				'order_id' => 64,
			)
		);

		$this->assertFalse( $this->check()->passes( array( 'opt-f' => $this->token() ), 'sess-1' ) );
	}

	/**
	 * ⚠️ **No session means no way to prove the file is this visitor's.**
	 *
	 * Refusing is the safe direction: the alternative attaches a file nobody can
	 * be shown to own.
	 */
	public function test_a_token_without_a_session_is_refused(): void {
		$this->rowIs(
			array(
				'token'    => $this->token(),
				'order_id' => null,
			)
		);

		$this->assertFalse( $this->check()->passes( array( 'opt-f' => $this->token() ), '' ) );

		/*
		 * ⚠️ **Asserted on the lookup avoided, not on the refusal.**
		 * `find_for_session()` refuses an empty session itself, so the refusal
		 * alone passes with or without this class's own guard — proven by
		 * mutation, where disabling the guard left every assertion green. What
		 * the guard actually buys is not issuing a query per token for a request
		 * that cannot match, and that is observable.
		 */
		$this->assertSame( array(), $GLOBALS['wpdb']->queries, 'No lookup may be issued without a session.' );
	}

	/** Every token on the line is checked, not just the first. */
	public function test_one_bad_token_among_several_refuses_the_line(): void {
		$this->rowIs( null );

		$this->assertFalse(
			$this->check()->passes(
				array(
					'opt-a' => $this->token( 'a' ),
					'opt-b' => $this->token( 'b' ),
				),
				'sess-1'
			)
		);
	}
}
