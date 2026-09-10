<?php
/**
 * Making a customer's uploads permanent when their order is created.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Upload\UploadPromoter;
use Optionia\Upload\UploadRepository;
use PHPUnit\Framework\TestCase;

/**
 * 🔴 **`UploadRepository::claim()` had no callers at all.**
 *
 * Every upload's life was: stored → row with `expires_at` at +72 hours →
 * **nothing**. Never promoted at checkout, never expired, and skipped by the
 * sweeper because it *has* a row. A merchant's print-ready artwork would have
 * been deleted three days after the order it belongs to.
 *
 * @covers \Optionia\Upload\UploadPromoter
 */
final class UploadPromoterTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['wpdb']              = new \Optionia_Test_Wpdb();
		$GLOBALS['optionia_test_log'] = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['wpdb'], $GLOBALS['optionia_test_log'] );
	}

	/**
	 * Messages logged at one level.
	 *
	 * @param string $level The level to filter to.
	 * @return array<int, string>
	 */
	private function logged( string $level ): array {
		$entries = $GLOBALS['optionia_test_log'] ?? array();

		return array_values(
			array_map(
				static fn ( array $entry ): string => (string) $entry['message'],
				array_filter(
					$entries,
					static fn ( array $entry ): bool => $level === $entry['level']
				)
			)
		);
	}

	private function promoter(): UploadPromoter {
		return new UploadPromoter( new UploadRepository(), new Logger( new Settings() ) );
	}

	/** An order double carrying an id, as the hook's fourth argument does. */
	private function order( int $id ): object {
		return new class( $id ) {
			/**
			 * The order's id.
			 *
			 * @var int
			 */
			private int $id;

			/**
			 * Record the id this order reports.
			 *
			 * @param int $id Order id.
			 */
			public function __construct( int $id ) {
				$this->id = $id;
			}

			/**
			 * The order's id.
			 */
			public function get_id(): int {
				return $this->id;
			}
		};
	}

	/** A cart line carrying the given selections. */
	private function line( array $selections ): array {
		return array(
			Keys::CART_ITEM_KEY => array(
				Keys::CART_ITEM_SELECTIONS => $selections,
			),
		);
	}

	/** A well-formed upload token. */
	private function token( string $seed = 'a' ): string {
		return str_repeat( $seed, 64 );
	}

	/* --- the promotion itself -------------------------------------------- */

	/**
	 * Every UPDATE the fake was asked to run.
	 *
	 * `claim()` runs through `query()` rather than `$wpdb->update()`, because the
	 * `order_id IS NULL` guard is not expressible in an equality map.
	 *
	 * @return array<int, string>
	 */
	private function claims(): array {
		return array_values(
			array_filter(
				$GLOBALS['wpdb']->queries,
				static fn ( string $sql ): bool => false !== stripos( $sql, 'UPDATE' )
			)
		);
	}

	public function test_it_claims_a_file_token_for_the_order(): void {
		$token = $this->token( 'a' );

		$this->promoter()->promote( null, null, $this->line( array( 'opt-f' => $token ) ), $this->order( 4242 ) );

		$claims = $this->claims();

		$this->assertCount( 1, $claims );
		$this->assertStringContainsString( $token, $claims[0] );
		$this->assertStringContainsString( '4242', $claims[0] );
	}

	/**
	 * 🔴 **A claim must not take a row another order owns.**
	 *
	 * Measured before this guard: ordering twice with one token left `order_id`
	 * at the second order, silently moving the artwork off the first. Re-ordering
	 * replays the token, so this was reachable without any malice at all.
	 */
	public function test_it_only_claims_a_row_no_order_owns(): void {
		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), $this->order( 7 ) );

		$this->assertStringContainsString( 'order_id IS NULL', $this->claims()[0] );
	}

	/**
	 * 🔴 **Clearing `expires_at` is what "permanent" means.**
	 *
	 * Cleanup reads that column, so a claim that left it set would promote a row
	 * whose file the next sweep deletes anyway.
	 */
	public function test_claiming_clears_the_expiry(): void {
		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), $this->order( 7 ) );

		$this->assertStringContainsString( 'expires_at = NULL', $this->claims()[0] );
	}

	/** Several files on one line are all claimed. */
	public function test_it_claims_every_token_on_the_line(): void {
		$line = $this->line(
			array(
				'opt-a' => $this->token( 'a' ),
				'opt-b' => $this->token( 'b' ),
			)
		);

		$this->promoter()->promote( null, null, $line, $this->order( 9 ) );

		$this->assertCount( 2, $this->claims() );
	}

	/* --- the order id ---------------------------------------------------- */

	/**
	 * 🔴 **The id comes from the `$order` argument, never from the item.**
	 *
	 * Measured on the running site: at this hook `$item->get_order_id()` is **0**
	 * while the `$order` argument carries the real id — the item has not been
	 * added to the order yet. Claiming against zero would write `order_id = 0`: a
	 * row that looks promoted, belongs to nothing, and whose file is now
	 * immortal because `expires_at` was cleared.
	 */
	public function test_it_claims_nothing_without_an_order(): void {
		$line = $this->line( array( 'o' => $this->token() ) );

		$this->promoter()->promote( null, null, $line, null );

		$this->assertSame( array(), $GLOBALS['wpdb']->updates );
	}

	public function test_it_claims_nothing_for_an_unsaved_order(): void {
		$line = $this->line( array( 'o' => $this->token() ) );

		$this->promoter()->promote( null, null, $line, $this->order( 0 ) );

		$this->assertSame( array(), $GLOBALS['wpdb']->updates );
	}

	/** An object that is not an order at all is ignored rather than fatal. */
	public function test_it_survives_an_unexpected_order_argument(): void {
		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), 'not-an-order' );

		$this->assertSame( array(), $GLOBALS['wpdb']->updates );
	}

	/* --- which selections are tokens ------------------------------------- */

	/**
	 * ⚠️ **Nothing in the payload marks a selection as a file.**
	 *
	 * The resolver stores a token as an ordinary scalar, so shape is the only
	 * signal: 64 hex characters from `random_bytes(32)`.
	 *
	 * @dataProvider nonTokens
	 * @param mixed $value A selection that is not an upload token.
	 */
	public function test_it_ignores_a_selection_that_is_not_a_token( $value ): void {
		$this->promoter()->promote( null, null, $this->line( array( 'o' => $value ) ), $this->order( 5 ) );

		$this->assertSame( array(), $GLOBALS['wpdb']->updates );
	}

	/**
	 * Selections that must never be mistaken for a token.
	 *
	 * @return array<string, array{0: mixed}>
	 */
	public function nonTokens(): array {
		return array(
			'a colour swatch value' => array( 'red' ),
			'a date'                => array( '2026-01-15' ),
			'free text'             => array( 'Happy Birthday Mum' ),
			'a number'              => array( '42' ),
			'too short'             => array( str_repeat( 'a', 63 ) ),
			'too long'              => array( str_repeat( 'a', 65 ) ),
			'not hex'               => array( str_repeat( 'z', 64 ) ),
			'uppercase hex'         => array( str_repeat( 'A', 64 ) ),
			'an array'              => array( array( 'a', 'b' ) ),
		);
	}

	/* --- malformed payloads ---------------------------------------------- */

	/**
	 * A payload with nothing to promote is ignored, never fatal.
	 *
	 * @dataProvider malformedLines
	 * @param mixed $values A cart line that carries no usable selections.
	 */
	public function test_it_survives_a_malformed_line( $values ): void {
		$this->promoter()->promote( null, null, $values, $this->order( 5 ) );

		$this->assertSame( array(), $GLOBALS['wpdb']->updates );
	}

	/**
	 * Cart lines with nothing to promote.
	 *
	 * @return array<string, array{0: mixed}>
	 */
	public function malformedLines(): array {
		return array(
			'no values at all'     => array( null ),
			'not an array'         => array( 'nonsense' ),
			'no optionia payload'  => array( array( 'other_plugin' => array() ) ),
			'payload not array'    => array( array( Keys::CART_ITEM_KEY => 'x' ) ),
			'selections not array' => array( array( Keys::CART_ITEM_KEY => array( Keys::CART_ITEM_SELECTIONS => 'x' ) ) ),
			'empty selections'     => array( array( Keys::CART_ITEM_KEY => array( Keys::CART_ITEM_SELECTIONS => array() ) ) ),
		);
	}

	/**
	 * 🔴 **A failed claim must never fail the order.**
	 *
	 * WooCommerce owns the transaction (AC6). A customer who has paid must not
	 * see checkout break because a row could not be updated — the worst case is a
	 * file that expires, which is recoverable by asking them, unlike a lost sale.
	 */
	public function test_a_failed_claim_does_not_throw(): void {
		$GLOBALS['wpdb']->affected = 0;

		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), $this->order( 5 ) );

		$this->assertCount( 1, $this->claims(), 'The claim was still attempted.' );
	}

	/**
	 * 🔴 **A re-order must not silently take the first order's artwork.**
	 *
	 * `OrderAgain` replays the original line's token. With the row already owned
	 * by order 5, the claim touches nothing, and the promoter must say so at
	 * error level: this second order genuinely has no artwork, and ADR-040
	 * requires that to be loud rather than discovered at print time.
	 */
	public function test_a_claim_on_another_orders_file_is_logged_as_an_error(): void {
		$GLOBALS['wpdb']->affected = 0;
		$GLOBALS['wpdb']->var      = 5;

		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), $this->order( 6 ) );

		$this->assertNotSame(
			array(),
			$this->logged( 'error' ),
			'A line that lost its artwork must be logged as an error.'
		);
	}

	/**
	 * ⚠️ **A replayed hook is not a conflict.**
	 *
	 * WooCommerce can fire the line-item hook more than once for one order. The
	 * row is already ours, nothing is wrong, and logging an error there would
	 * train a merchant to ignore the one message that matters.
	 */
	public function test_reclaiming_for_the_same_order_is_not_an_error(): void {
		$GLOBALS['wpdb']->affected = 0;
		$GLOBALS['wpdb']->var      = 6;

		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), $this->order( 6 ) );

		$this->assertSame( array(), $this->logged( 'error' ) );
	}


	/**
	 * 🔴 **A database failure is reported as itself, not as a conflict.**
	 *
	 * The two need opposite responses: a conflict means this line will never
	 * have artwork, while an error means nobody knows yet and the row is still
	 * claimable. A merchant who cannot tell them apart treats both as noise —
	 * and the row keeps its `expires_at`, so cleanup is what would eventually
	 * delete a paid order's file.
	 */
	public function test_a_database_error_is_logged_as_itself(): void {
		$GLOBALS['wpdb']->affected = false;

		$this->promoter()->promote( null, null, $this->line( array( 'o' => $this->token() ) ), $this->order( 6 ) );

		$logged = $this->logged( 'error' );

		$this->assertCount( 1, $logged );
		$this->assertStringContainsString(
			'database refused',
			$logged[0],
			'A database failure must not be reported as a missing-artwork conflict.'
		);
	}

	/** The hook is the one both checkout worlds fire. */
	public function test_it_listens_on_the_shared_checkout_hook(): void {
		$this->assertSame( 'woocommerce_checkout_create_order_line_item', UploadPromoter::HOOK );
	}
}
