<?php
/**
 * The storefront's preview proxy (M26e.1, stage B).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Design\PreviewEndpoint;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;
use WP_REST_Request;

/**
 * `Design\PreviewEndpoint` asks the cloud once and reuses the answer.
 *
 * 🔴 **A proxy exists so the store credential never reaches a browser.** The
 * cloud's preview route is authenticated by the store token, which lives in an
 * option; a customer's page asks WordPress and WordPress asks the cloud.
 *
 * @covers \Optionia\Design\PreviewEndpoint
 */
final class PreviewEndpointTest extends TestCase {

	private const SVG = '<svg viewBox="0 0 800 800"><image href="x.png"/></svg>';

	protected function setUp(): void {
		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_transients'] = array();
		$GLOBALS['optionia_test_http_calls'] = array();
		$GLOBALS['optionia_test_doing_cron'] = true;
		$GLOBALS['optionia_test_http']       = array(
			'status' => 200,
			'body'   => self::SVG,
		);

		update_option( Keys::OPTION_CONNECTION_STATE, 'connected', false );
		update_option( Keys::OPTION_STORE_TOKEN, 'tok_live_abc', false );
	}

	private function endpoint(): PreviewEndpoint {
		$settings = new Settings();
		$logger   = new Logger( $settings );

		return new PreviewEndpoint(
			new Client( $settings, $logger, new CircuitBreaker( $logger ), new ResponseValidator() ),
			$logger
		);
	}

	/**
	 * A request carrying a composed scene.
	 *
	 * @param array<string, mixed> $overrides Parameters to replace.
	 */
	private function request( array $overrides = array() ): WP_REST_Request {
		$request = new WP_REST_Request();

		$request->params = array_merge(
			array(
				'scene'  => array(
					'width'  => 800,
					'height' => 800,
					'groups' => array(
						array(
							'key'     => 'o:v',
							'visible' => true,
							'layers'  => array( array( 'name' => 'l' ) ),
						),
					),
				),
				'width'  => 800,
				'height' => 800,
			),
			$overrides
		);

		return $request;
	}

	/** How many times the cloud was asked. */
	private function cloudCalls(): int {
		return count( $GLOBALS['optionia_test_http_calls'] ?? array() );
	}

	public function test_it_answers_the_rendered_svg(): void {
		$response = $this->endpoint()->handle( $this->request() );

		$this->assertSame( 200, $response->status );
		$this->assertSame( self::SVG, $response->data );

		/*
		 * 📌 **A browser given `application/json` refuses to inject the
		 * document**, so the content type is part of the answer rather than a
		 * detail.
		 */
		$this->assertSame( 'image/svg+xml', $response->headers['content-type'] ?? '' );
	}

	/**
	 * 🔴 **The cloud allows 1200 previews an hour per store**, and two
	 * customers choosing the same swatch compose byte-identical scenes. An
	 * uncached proxy would spend a merchant's whole allowance on one popular
	 * choice.
	 */
	public function test_an_identical_scene_is_served_from_cache(): void {
		$endpoint = $this->endpoint();

		$endpoint->handle( $this->request() );
		$first = $this->cloudCalls();

		$endpoint->handle( $this->request() );

		$this->assertSame( $first, $this->cloudCalls(), 'the cloud was asked twice for one scene' );
	}

	/**
	 * ⚠️ **The same artwork at two sizes is two documents.** A key ignoring
	 * the canvas would serve one of them for both.
	 */
	public function test_a_different_canvas_is_not_served_from_cache(): void {
		$endpoint = $this->endpoint();

		$endpoint->handle( $this->request() );
		$first = $this->cloudCalls();

		$endpoint->handle(
			$this->request(
				array(
					'width'  => 400,
					'height' => 400,
				)
			)
		);

		$this->assertGreaterThan( $first, $this->cloudCalls() );
	}

	/** A different scene is a different picture and must be rendered. */
	public function test_a_different_scene_is_not_served_from_cache(): void {
		$endpoint = $this->endpoint();

		$endpoint->handle( $this->request() );
		$first = $this->cloudCalls();

		$endpoint->handle(
			$this->request(
				array(
					'scene' => array(
						'width'  => 800,
						'height' => 800,
						'groups' => array(
							array(
								'key'     => 'o:other',
								'visible' => true,
								'layers'  => array( array( 'name' => 'z' ) ),
							),
						),
					),
				)
			)
		);

		$this->assertGreaterThan( $first, $this->cloudCalls() );
	}

	/**
	 * 🔴 **Artwork never blocks a sale** (M26e.6). A customer whose preview
	 * does not arrive must still be able to buy, so a failure is a 204 rather
	 * than an error the runtime would treat as something to retry.
	 */
	public function test_a_cloud_failure_answers_no_content(): void {
		$GLOBALS['optionia_test_http'] = array(
			'status' => 500,
			'body'   => '{"error":{"code":"OOPS"}}',
		);

		$response = $this->endpoint()->handle( $this->request() );

		$this->assertSame( 204, $response->status );
	}

	/** A disconnected store never asks: every request would be a 401. */
	public function test_a_disconnected_store_asks_nothing(): void {
		update_option( Keys::OPTION_CONNECTION_STATE, 'disconnected', false );
		delete_option( Keys::OPTION_STORE_TOKEN );

		$response = $this->endpoint()->handle( $this->request() );

		$this->assertSame( 204, $response->status );
		$this->assertSame( 0, $this->cloudCalls() );
	}

	/**
	 * ⚠️ **A browser is not a trusted caller.** The nonce proves the caller
	 * loaded a page and nothing more, so a scene far larger than this plugin
	 * emits is refused rather than forwarded.
	 */
	public function test_an_oversized_scene_is_refused(): void {
		$huge = array(
			'width'  => 800,
			'height' => 800,
			'groups' => array(),
		);

		for ( $i = 0; $i < 4000; $i++ ) {
			$huge['groups'][] = array(
				'key'     => 'k' . $i,
				'visible' => false,
				'layers'  => array( array( 'name' => str_repeat( 'x', 80 ) ) ),
			);
		}

		$response = $this->endpoint()->handle( $this->request( array( 'scene' => $huge ) ) );

		$this->assertSame( 204, $response->status );
		$this->assertSame( 0, $this->cloudCalls() );
	}

	/**
	 * A request that cannot name a picture asks the cloud nothing.
	 *
	 * @dataProvider unusable_requests
	 *
	 * @param array<string, mixed> $overrides Parameters to replace.
	 */
	public function test_an_unusable_request_asks_nothing( array $overrides ): void {
		$response = $this->endpoint()->handle( $this->request( $overrides ) );

		$this->assertSame( 204, $response->status );
		$this->assertSame( 0, $this->cloudCalls() );
	}

	/**
	 * Requests with nothing to draw.
	 *
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function unusable_requests(): array {
		return array(
			'no scene'    => array( array( 'scene' => null ) ),
			'empty scene' => array( array( 'scene' => array() ) ),
			'zero width'  => array( array( 'width' => 0 ) ),
			'zero height' => array( array( 'height' => 0 ) ),
		);
	}

	/** The nonce is what distinguishes a page visitor from anyone else. */
	public function test_a_request_without_a_nonce_is_refused(): void {
		$this->assertFalse( $this->endpoint()->permitted( new WP_REST_Request() ) );
	}
}
