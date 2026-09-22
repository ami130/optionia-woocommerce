<?php
/**
 * Pushing the catalogue to the cloud (M19.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Catalogue\CatalogueCursor;
use Optionia\Catalogue\CataloguePayload;
use Optionia\Catalogue\CataloguePusher;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Pushing the catalogue to the cloud.
 *
 * @covers \Optionia\Catalogue\CataloguePusher
 */
final class CataloguePusherTest extends TestCase {

	/**
	 * Captured POSTs.
	 *
	 * @var array<int, array<string, mixed>>
	 */
	private array $calls = array();

	/**
	 * Queued responses; the last repeats once exhausted.
	 *
	 * @var array<int, Response>
	 */
	private array $responses = array();

	/**
	 * Walk position, shared with the pusher under test.
	 *
	 * @var CatalogueCursor
	 */
	private CatalogueCursor $cursor;

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_options']     = array();
		$GLOBALS['optionia_test_autoload']    = array();
		$GLOBALS['optionia_test_products']    = array();
		$GLOBALS['optionia_test_terms']       = array();
		$GLOBALS['optionia_test_attachments'] = array();
		$GLOBALS['optionia_test_decimals']    = 2;

		$this->calls     = array();
		$this->responses = array();
		$this->cursor    = new CatalogueCursor();

		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTED, false );
	}

	/** A pusher whose transport records every call. */
	private function pusher(): CataloguePusher {
		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			function ( string $path, array $body ): Response {
				$this->calls[] = array(
					'path' => $path,
					'body' => $body,
				);

				$queued = array_shift( $this->responses );

				return $queued ?? Response::success( 200, array( 'accepted' => count( $body['products'] ?? array() ) ) );
			}
		);

		return new CataloguePusher(
			$client,
			$this->cursor,
			new CataloguePayload(),
			new Logger( new Settings() )
		);
	}

	/** A pusher whose transport throws instead of answering. */
	private function throwing_pusher(): CataloguePusher {
		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willThrowException( new \RuntimeException( 'transport exploded' ) );

		return new CataloguePusher(
			$client,
			$this->cursor,
			new CataloguePayload(),
			new Logger( new Settings() )
		);
	}

	/** Register `$count` products the walk can find. */
	private function catalogue( int $count ): void {
		for ( $i = 1; $i <= $count; $i++ ) {
			$product         = optionia_test_product( $i, 'simple', '19.99' );
			$product->name   = "Product {$i}";
			$product->status = 'publish';
		}
	}

	/** How many products the last POST carried. */
	private function sent( int $call = 0 ): int {
		return count( $this->calls[ $call ]['body']['products'] ?? array() );
	}

	// --- The happy path ------------------------------------------------------

	public function test_a_first_run_starts_a_walk_and_pushes_a_batch(): void {
		$this->catalogue( 10 );

		$accepted = $this->pusher()->run();

		$this->assertSame( 10, $accepted );
		$this->assertSame( '/store/products', $this->calls[0]['path'] );
		$this->assertSame( 10, $this->sent() );
		$this->assertSame( 10, $this->cursor->read()['total'] );
		$this->assertSame( 10, $this->cursor->read()['offset'] );
	}

	public function test_an_empty_catalogue_pushes_nothing_and_starts_no_walk(): void {
		$pusher = $this->pusher();

		$this->assertSame( 0, $pusher->run() );
		$this->assertSame( array(), $this->calls );
		$this->assertFalse( $this->cursor->has_run( $this->cursor->read() ) );
	}

	/**
	 * ⚠️ **It stops when it finishes, and does not loop.** Ongoing changes are
	 * M19.2's and drift is M19.3's; a walk that restarted itself would make both
	 * redundant and re-push 100k products for ever.
	 */
	public function test_a_completed_walk_does_not_start_again(): void {
		$this->catalogue( 5 );
		$pusher = $this->pusher();

		$pusher->run();
		$this->assertTrue( $this->cursor->is_complete( $this->cursor->read() ) );

		$this->calls                              = array();
		$GLOBALS['optionia_test_product_queries'] = 0;

		$this->assertSame( 0, $pusher->run() );
		$this->assertSame( array(), $this->calls, 'a finished walk sends nothing' );

		/*
		 * 🔴 **The catalogue is not even read, and a surviving mutant proved
		 * this assertion was needed.** Removing the completion check left the
		 * run falling through to a page that happens to be empty — so "sends
		 * nothing" stayed true while the guard was gone. What actually differs
		 * is whether a finished walk queries WooCommerce at all: over the days
		 * after a 100k sync completes, that is four wasted catalogue queries an
		 * hour, for ever.
		 */
		$this->assertSame(
			0,
			$GLOBALS['optionia_test_product_queries'],
			'a finished walk must not re-read the catalogue'
		);
	}

	// --- Connection state ----------------------------------------------------

	/**
	 * 🔴 **`REVOKED` is the one that matters, and `OrderReporter` gets it
	 * wrong.** `Config\Synchroniser` measured why on this same 900-second
	 * schedule: a revoked store opens the circuit on the fifth run, and the
	 * breaker's 300-second cooldown against a 900-second interval means it
	 * re-opens every five runs for ever — taking config sync and order
	 * reporting down with it.
	 */
	public function test_a_revoked_store_pushes_nothing(): void {
		$this->catalogue( 10 );
		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::REVOKED, false );

		$this->assertSame( 0, $this->pusher()->run() );
		$this->assertSame( array(), $this->calls );
	}

	public function test_a_disconnected_store_pushes_nothing(): void {
		$this->catalogue( 10 );
		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::DISCONNECTED, false );

		$this->assertSame( 0, $this->pusher()->run() );
		$this->assertSame( array(), $this->calls );
	}

	/** A store mid-handshake still has a credential worth trying. */
	public function test_a_connecting_store_still_pushes(): void {
		$this->catalogue( 5 );
		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTING, false );

		$this->assertSame( 5, $this->pusher()->run() );
	}

	// --- Overlap -------------------------------------------------------------

	/**
	 * 🔴 Two runs overlapping would both read the same offset and **both
	 * advance**, skipping a batch. Modelled in `CatalogueCursor::claim()`.
	 */
	public function test_a_run_is_refused_while_another_holds_the_claim(): void {
		$this->catalogue( 10 );
		$this->cursor->start( 10 );
		$this->cursor->claim();

		$this->assertSame( 0, $this->pusher()->run() );
		$this->assertSame( array(), $this->calls );
	}

	/** A finished run releases, so the next one proceeds. */
	public function test_the_claim_is_released_after_a_run(): void {
		$this->catalogue( 300 );
		$pusher = $this->pusher();

		$pusher->run();

		$this->assertSame( 0, $this->cursor->read()['claimed_at'] );
		$this->assertGreaterThan( 0, $pusher->run(), 'the next run proceeds' );
	}

	// --- Resumption ----------------------------------------------------------

	public function test_a_second_run_continues_where_the_first_stopped(): void {
		$this->catalogue( 300 );
		$pusher = $this->pusher();

		$this->assertSame( 250, $pusher->run() );
		$this->assertSame( 250, $this->cursor->read()['offset'] );

		$this->assertSame( 50, $pusher->run() );
		$this->assertSame( 300, $this->cursor->read()['offset'] );
		$this->assertTrue( $this->cursor->is_complete( $this->cursor->read() ) );
	}

	/** The batch cap bounds one request regardless of catalogue size. */
	public function test_a_batch_never_exceeds_the_cap(): void {
		$this->catalogue( 400 );

		$this->pusher()->run();

		$this->assertSame( 250, $this->sent() );
	}

	// --- Failure -------------------------------------------------------------

	/**
	 * 🔴 **The cursor must not advance on failure**, or the next run resumes
	 * past products that were never stored.
	 */
	public function test_a_failed_batch_does_not_advance_the_cursor(): void {
		$this->catalogue( 10 );
		$this->responses = array( Response::failure( 500, 'INTERNAL_ERROR', 'boom' ) );

		$this->assertSame( 0, $this->pusher()->run() );
		$this->assertSame( 0, $this->cursor->read()['offset'] );
	}

	public function test_a_failed_batch_is_retried_by_the_next_run(): void {
		$this->catalogue( 10 );
		$this->responses = array( Response::failure( 503, 'SERVICE_UNAVAILABLE', 'down' ) );
		$pusher          = $this->pusher();

		$pusher->run();
		$this->assertSame( 10, $pusher->run(), 'the same span is sent again' );
	}

	/**
	 * 🔴 **The claim is released however the run ends, including on a throw.**
	 * An audit found this documented and untested: the mock always answered, so
	 * the `finally` had never executed on an exception path. A claim left behind
	 * stalls the walk until it expires — five minutes of a merchant's sync doing
	 * nothing, for a failure that already cost them one batch.
	 */
	public function test_a_throwing_transport_still_releases_the_claim(): void {
		$this->catalogue( 10 );

		try {
			$this->throwing_pusher()->run();
			$this->fail( 'the exception should propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'transport exploded', $e->getMessage() );
		}

		$this->assertSame( 0, $this->cursor->read()['claimed_at'], 'the claim was released' );
	}

	/** And the next run can proceed, which is what releasing is for. */
	public function test_a_run_after_a_throw_is_not_blocked(): void {
		$this->catalogue( 10 );

		try {
			$this->throwing_pusher()->run();
		} catch ( \RuntimeException $e ) {
			unset( $e );
		}

		$this->assertSame( 10, $this->pusher()->run() );
	}

	// --- A catalogue that shrinks --------------------------------------------

	/**
	 * 🔴 **A walk whose products vanish must terminate, not loop.** Deletions
	 * shift later rows *down*, and over the 4.2 days a 100k walk takes that is
	 * ordinary. Without this branch every run would read an empty page, advance
	 * nothing and retry — four wasted catalogue queries an hour, for ever.
	 *
	 * ⚠️ An audit found this path untested: it is the one that makes the
	 * difference between "finished early" and "stuck".
	 */
	public function test_a_catalogue_that_shrinks_mid_walk_finishes_rather_than_looping(): void {
		$this->catalogue( 300 );
		$pusher = $this->pusher();

		$this->assertSame( 250, $pusher->run() );

		/* Every remaining product is deleted before the next run. */
		$GLOBALS['optionia_test_products'] = array();
		$this->calls                       = array();

		$this->assertSame( 0, $pusher->run() );
		$this->assertSame( array(), $this->calls, 'nothing is sent for products that are gone' );
		$this->assertTrue(
			$this->cursor->is_complete( $this->cursor->read() ),
			'the walk terminates rather than retrying an empty page for ever'
		);
	}

	/** And having terminated, it stays terminated. */
	public function test_a_shrunk_walk_does_not_restart(): void {
		$this->catalogue( 300 );
		$pusher = $this->pusher();

		$pusher->run();
		$GLOBALS['optionia_test_products'] = array();
		$pusher->run();

		$GLOBALS['optionia_test_product_queries'] = 0;

		$this->assertSame( 0, $pusher->run() );
		$this->assertSame( 0, $GLOBALS['optionia_test_product_queries'] );
	}

	// --- The 413 fallback ----------------------------------------------------

	/**
	 * ⚠️ A `413` means the server's limit is lower than this build assumed —
	 * the body was already measured against the byte budget. Halve **once**:
	 * every attempt is a `record_failure()` against the shared breaker.
	 */
	public function test_a_413_halves_the_batch_once_and_advances_by_what_landed(): void {
		$this->catalogue( 300 );
		$this->responses = array(
			Response::failure( 413, 'PAYLOAD_TOO_LARGE', 'too big' ),
			Response::success( 200, array( 'accepted' => 125 ) ),
		);

		$accepted = $this->pusher()->run();

		$this->assertCount( 2, $this->calls, 'one rejection, one halved retry' );
		$this->assertSame( 250, $this->sent( 0 ) );
		$this->assertSame( 125, $this->sent( 1 ) );
		$this->assertSame( 125, $accepted );
		$this->assertSame( 125, $this->cursor->read()['offset'] );
	}

	/** Two rejections in one run stop it: the breaker is not a retry budget. */
	public function test_a_413_does_not_loop_within_one_run(): void {
		$this->catalogue( 300 );
		$this->responses = array(
			Response::failure( 413, 'PAYLOAD_TOO_LARGE', 'too big' ),
			Response::failure( 413, 'PAYLOAD_TOO_LARGE', 'still too big' ),
			Response::success( 200, array() ),
		);

		$this->pusher()->run();

		$this->assertCount( 2, $this->calls, 'halved once, then left for the next run' );
		$this->assertSame( 0, $this->cursor->read()['offset'] );
	}

	/**
	 * 🔴 **One product the API will not take at any size must not block the
	 * walk.** Advancing past it costs one product; stalling costs every product
	 * behind it — the reasoning ADR-072 applied to the order queue.
	 */
	public function test_a_single_oversized_product_is_skipped_rather_than_blocking(): void {
		$this->catalogue( 3 );
		$this->cursor->start( 3 );
		$this->cursor->advance( $this->cursor->read()['run_id'], 2 );

		$this->responses = array( Response::failure( 413, 'PAYLOAD_TOO_LARGE', 'one product too big' ) );

		$this->pusher()->run();

		$this->assertSame( 3, $this->cursor->read()['offset'], 'the walk moved past it' );
	}
}
