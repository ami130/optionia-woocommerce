<?php
/**
 * Asking the cloud for print files, once per line and never on a page render.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Repository;
use Optionia\Design\LineScene;
use Optionia\Design\RenderRequester;
use Optionia\Reporting\OrderQueue;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * `Design\RenderRequester` drains the queue and records what the cloud answered.
 *
 * @covers \Optionia\Design\RenderRequester
 * @covers \Optionia\Design\LineScene
 */
final class RenderRequesterTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_orders']     = array();
		$GLOBALS['optionia_test_doing_cron'] = true;
		$GLOBALS['optionia_test_http']       = array(
			'status' => 200,
			'body'   => '{"data":{"id":"render-1","duplicate":false,"status":"preparing","fileUrl":null}}',
		);

		// A connected store, so the drain does not short-circuit.
		update_option( Keys::OPTION_CONNECTION_STATE, 'connected', false );
		update_option( Keys::OPTION_STORE_TOKEN, 'tok_live_abc', false );

		$this->storeConfig();
	}

	/** A published document with one designed value on product 7. */
	private function storeConfig(): void {
		$repository = new Repository( new Logger( new Settings() ) );

		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 2,
				'option_sets'    => array(
					array(
						'id'          => 'set1',

						/*
						 * ⚠️ **Assignments live INSIDE the set**, not at the
						 * document's top level — `ProductIndex` reads
						 * `$set['assignments']`. A first version of this
						 * fixture put them alongside `option_sets`, so
						 * `sets_for_product()` matched nothing and every test
						 * here failed with the requester behaving correctly.
						 */
						'assignments' => array(
							array(
								'mode'     => 'all',
								'priority' => 0,
							),
						),
						'groups'      => array(
							array(
								'options' => array(
									array(
										'id'     => 'opt1',
										'values' => array(
											array(
												'value_key' => 'crest',
												'design' => array(
													'layers' => array( array( 'id' => 'l1' ) ),
												),
											),
										),
									),
								),
							),
						),
					),
				),
			),
			'etag-1'
		);
	}

	private function requester(): RenderRequester {
		$settings = new Settings();
		$logger   = new Logger( $settings );

		return new RenderRequester(
			new Client( $settings, $logger, new CircuitBreaker( $logger ), new ResponseValidator() ),
			new LineScene( new Repository( $logger ) ),
			new OrderQueue( $logger, Keys::OPTION_RENDER_QUEUE ),
			$logger
		);
	}

	/**
	 * An order with one designed line.
	 *
	 * @param int $id Order id.
	 */
	private function designedOrder( int $id ): object {
		$item             = optionia_test_order_item();
		$item->product_id = 7;
		$item->meta       = array(
			Keys::META_SELECTIONS => (string) wp_json_encode( array( 'opt1' => 'crest' ) ),
		);

		$order        = optionia_test_order( $id );
		$order->items = array( 11 => $item );

		$GLOBALS['optionia_test_orders'][ $id ] = $order;

		return $order;
	}

	public function test_it_requests_a_render_for_a_designed_line(): void {
		$order = $this->designedOrder( 50 );

		$requester = $this->requester();
		$requester->queue( 50 );

		$this->assertSame( 1, $requester->drain() );
		$this->assertStringContainsString( 'render-1', (string) $order->get_meta( Keys::META_RENDER_IDS ) );
	}

	/**
	 * 🔴 **A retry must not produce a second file** (M26e.4). The cloud keys on
	 * `line_ref`, but that only helps once a response arrives — and the common
	 * failure is a response sent but never received. The recorded id is what
	 * stops the second ask.
	 */
	public function test_a_line_that_already_has_a_render_is_not_asked_again(): void {
		$order = $this->designedOrder( 51 );
		$order->update_meta_data( Keys::META_RENDER_IDS, (string) wp_json_encode( array( 11 => 'render-existing' ) ) );

		$requester = $this->requester();
		$requester->queue( 51 );

		$this->assertSame( 0, $requester->drain() );
	}

	/**
	 * ⚠️ **A line with no artwork produces no request.** Otherwise the cloud
	 * accepts it, the worker rasterises a blank canvas, and a merchant is
	 * handed an empty print file for an ordinary product.
	 */
	public function test_a_line_with_no_design_is_not_requested(): void {
		$item             = optionia_test_order_item();
		$item->product_id = 7;
		$item->meta       = array(
			Keys::META_SELECTIONS => (string) wp_json_encode( array( 'opt1' => 'plain' ) ),
		);

		$order        = optionia_test_order( 52 );
		$order->items = array( 11 => $item );

		$GLOBALS['optionia_test_orders'][52] = $order;

		$requester = $this->requester();
		$requester->queue( 52 );

		$this->assertSame( 0, $requester->drain() );
	}

	/**
	 * 🔴 **A disconnected store asks for nothing and keeps its backlog.** Every
	 * request would be a guaranteed 401, and dropping the queue would lose the
	 * print files a reconnecting store still owes its merchant.
	 */
	public function test_a_disconnected_store_requests_nothing(): void {
		$this->designedOrder( 53 );

		update_option( Keys::OPTION_CONNECTION_STATE, 'disconnected', false );
		delete_option( Keys::OPTION_STORE_TOKEN );

		$requester = $this->requester();
		$requester->queue( 53 );

		$this->assertSame( 0, $requester->drain() );
		$this->assertSame( array( 53 ), ( new OrderQueue( new Logger( new Settings() ), Keys::OPTION_RENDER_QUEUE ) )->all() );
	}

	/**
	 * ⚠️ **A retryable failure keeps the order queued.** The cloud being down
	 * must not cost a merchant their print file.
	 */
	public function test_a_server_error_leaves_the_order_queued(): void {
		$this->designedOrder( 54 );

		$GLOBALS['optionia_test_http'] = array(
			'status' => 503,
			'body'   => '{"error":{"code":"UNAVAILABLE"}}',
		);

		$requester = $this->requester();
		$requester->queue( 54 );

		$this->assertSame( 0, $requester->drain() );
		$this->assertSame( array( 54 ), ( new OrderQueue( new Logger( new Settings() ), Keys::OPTION_RENDER_QUEUE ) )->all() );
	}

	/**
	 * 📌 **A 4xx is a real answer, so the order leaves the queue.** The scene
	 * was refused and asking again would be refused identically.
	 */
	public function test_a_refused_scene_does_not_block_the_queue_for_ever(): void {
		$this->designedOrder( 55 );

		$GLOBALS['optionia_test_http'] = array(
			'status' => 400,
			'body'   => '{"error":{"code":"VALIDATION_FAILED"}}',
		);

		$requester = $this->requester();
		$requester->queue( 55 );

		$this->assertSame( 0, $requester->drain() );
		$this->assertSame( array(), ( new OrderQueue( new Logger( new Settings() ), Keys::OPTION_RENDER_QUEUE ) )->all() );
	}

	/** An order deleted between checkout and the run is forgotten, not retried. */
	public function test_a_missing_order_leaves_the_queue(): void {
		$requester = $this->requester();
		$requester->queue( 999 );

		$this->assertSame( 0, $requester->drain() );
		$this->assertSame( array(), ( new OrderQueue( new Logger( new Settings() ), Keys::OPTION_RENDER_QUEUE ) )->all() );
	}

	/** A successful request removes the order from the queue. */
	public function test_a_requested_order_leaves_the_queue(): void {
		$this->designedOrder( 56 );

		$requester = $this->requester();
		$requester->queue( 56 );
		$requester->drain();

		$this->assertSame( array(), ( new OrderQueue( new Logger( new Settings() ), Keys::OPTION_RENDER_QUEUE ) )->all() );
	}
}
