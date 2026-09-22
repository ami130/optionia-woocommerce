<?php
/**
 * Repairing drift between the store and the mirror (M19.3).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Catalogue\CatalogueCursor;
use Optionia\Catalogue\CatalogueReconciler;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Sweeping the store's ids against the cloud's mirror.
 *
 * @covers \Optionia\Catalogue\CatalogueReconciler
 */
final class CatalogueReconcilerTest extends TestCase {

	/**
	 * Captured POSTs.
	 *
	 * @var array<int, array<string, mixed>>
	 */
	private array $calls = array();

	/**
	 * Responses to answer with; the last repeats.
	 *
	 * @var array<int, Response>
	 */
	private array $responses = array();

	/**
	 * Walk position.
	 *
	 * @var CatalogueCursor
	 */
	private CatalogueCursor $cursor;

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options']  = array();
		$GLOBALS['optionia_test_autoload'] = array();
		$GLOBALS['optionia_test_products'] = array();

		$this->calls     = array();
		$this->responses = array();
		$this->cursor    = new CatalogueCursor();

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTED, false );
	}

	/** A reconciler whose transport records every call. */
	private function reconciler(): CatalogueReconciler {
		$client = $this->createMock( PostsToCloud::class );

		$client->method( 'post' )->willReturnCallback(
			function ( string $path, array $body ): Response {
				$this->calls[] = array(
					'path' => $path,
					'body' => $body,
				);

				return array_shift( $this->responses )
					?? Response::success(
						200,
						array(
							'checked' => 0,
							'stale'   => 0,
							'removed' => 0,
						)
					);
			}
		);

		return new CatalogueReconciler( $client, $this->cursor, new Logger( new Settings() ) );
	}

	/** Register products and mark the initial walk finished. */
	private function catalogue( array $ids ): void {
		foreach ( $ids as $id ) {
			optionia_test_product( (int) $id, 'simple', '9.99' );
		}

		$run_id = $this->cursor->start( count( $ids ) );
		$this->cursor->advance( $run_id, count( $ids ) );
	}

	// --- The happy path ------------------------------------------------------

	public function test_it_sends_the_store_ids_as_a_final_manifest(): void {
		$this->catalogue( array( 10, 20, 30 ) );

		$this->reconciler()->reconcile();

		$this->assertCount( 1, $this->calls );
		$this->assertSame( '/store/products/reconcile', $this->calls[0]['path'] );
		$this->assertTrue( $this->calls[0]['body']['is_final'] );
		$this->assertCount( 3, $this->calls[0]['body']['external_ids'] );
	}

	/**
	 * 🔴 **String order, not numeric.** `externalId` is `varchar` and MySQL
	 * compares it as a string: numerically `2 < 9 < 10 < 100`, but as strings
	 * `"10" < "100" < "2" < "9"`. Paging numerically — which is what
	 * `wc_get_products()` does with `orderby => ID` — would send a floor of
	 * `"2"`, and the mirror's `10` and `100` sort **below** it, falling outside
	 * every range and never being examined.
	 */
	public function test_ids_are_ordered_as_strings_not_numbers(): void {
		$this->catalogue( array( 2, 9, 10, 100 ) );

		$this->reconciler()->reconcile();

		$this->assertSame(
			array( '10', '100', '2', '9' ),
			$this->calls[0]['body']['external_ids']
		);
		$this->assertSame( '10', $this->calls[0]['body']['range_start'] );
	}

	public function test_ids_are_sent_as_strings(): void {
		$this->catalogue( array( 10 ) );

		$this->reconciler()->reconcile();

		$this->assertSame( array( '10' ), $this->calls[0]['body']['external_ids'] ?? null );
	}

	public function test_the_removed_count_is_returned(): void {
		$this->catalogue( array( 10 ) );
		$this->responses = array( Response::success( 200, array( 'removed' => 4 ) ) );

		$this->assertSame( 4, $this->reconciler()->reconcile() );
	}

	public function test_a_successful_sweep_records_when_it_ran(): void {
		$this->catalogue( array( 10 ) );

		$this->reconciler()->reconcile();

		$this->assertGreaterThan( 0, (int) get_option( Keys::OPTION_LAST_RECONCILE, 0 ) );
	}

	// --- The safety refusals -------------------------------------------------

	/**
	 * 🔴 **Never while the initial walk is unfinished.** During a walk the
	 * mirror is *deliberately* incomplete — at offset 40,000 of 100,000 it holds
	 * 40k products — but the manifest would list all 100k, making the comparison
	 * meaningless in one direction and dangerous in the other.
	 */
	public function test_it_refuses_while_the_walk_is_incomplete(): void {
		foreach ( array( 10, 20 ) as $id ) {
			optionia_test_product( $id, 'simple', '9.99' );
		}

		$this->cursor->start( 100 );

		$this->assertSame( 0, $this->reconciler()->reconcile() );
		$this->assertSame( array(), $this->calls );
	}

	public function test_it_refuses_before_any_walk_has_run(): void {
		optionia_test_product( 10, 'simple', '9.99' );

		$this->assertSame( 0, $this->reconciler()->reconcile() );
		$this->assertSame( array(), $this->calls );
	}

	/**
	 * ⚠️ **An empty store is not reconciled.** A manifest of nothing would ask
	 * the cloud to delete the whole mirror — and "no products" is far more often
	 * a broken WooCommerce query than a merchant who deleted their catalogue.
	 * The cost of being wrong is asymmetric, so this refuses rather than guesses.
	 */
	public function test_an_empty_store_is_not_reconciled(): void {
		$run_id = $this->cursor->start( 0 );
		$this->cursor->advance( $run_id, 0 );

		$this->assertSame( 0, $this->reconciler()->reconcile() );
		$this->assertSame( array(), $this->calls );
	}

	public function test_a_revoked_store_reconciles_nothing(): void {
		$this->catalogue( array( 10 ) );
		$this->calls = array();

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::REVOKED, false );

		$this->assertSame( 0, $this->reconciler()->reconcile() );
		$this->assertSame( array(), $this->calls );
	}

	public function test_a_disconnected_store_reconciles_nothing(): void {
		$this->catalogue( array( 10 ) );
		$this->calls = array();

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::DISCONNECTED, false );

		$this->assertSame( 0, $this->reconciler()->reconcile() );
		$this->assertSame( array(), $this->calls );
	}

	// --- Failure -------------------------------------------------------------

	/**
	 * 🔴 **A failed page abandons the whole sweep.** A manifest is only
	 * meaningful complete: sending pages one to three and then a *final* page
	 * four would tell the cloud the store holds only page four's ids, and
	 * everything above the floor it did not claim would be deleted.
	 */
	public function test_a_failed_page_abandons_the_sweep(): void {
		$this->catalogue( array( 10 ) );
		$this->responses = array( Response::failure( 503, 'SERVICE_UNAVAILABLE', 'down' ) );

		$this->assertSame( 0, $this->reconciler()->reconcile() );
	}

	public function test_a_failed_sweep_does_not_record_a_run(): void {
		$this->catalogue( array( 10 ) );
		$this->responses = array( Response::failure( 500, 'INTERNAL_ERROR', 'boom' ) );

		$this->reconciler()->reconcile();

		$this->assertSame( 0, (int) get_option( Keys::OPTION_LAST_RECONCILE, 0 ) );
	}

	// --- Registration --------------------------------------------------------

	public function test_it_registers_the_daily_cron(): void {
		$GLOBALS['optionia_test_actions'] = array();

		$this->reconciler()->register();

		$this->assertArrayHasKey(
			Keys::CRON_RECONCILE_CATALOGUE,
			$GLOBALS['optionia_test_actions']
		);
	}
}
