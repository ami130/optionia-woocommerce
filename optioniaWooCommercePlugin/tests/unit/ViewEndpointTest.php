<?php
/**
 * Where the storefront beacon lands (M25.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Analytics\ViewCollector;
use Optionia\Analytics\ViewEndpoint;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;
use WP_REST_Request;

/**
 * The REST route a customer's browser posts to.
 *
 * 🔴 **The browser talks to the site, never to the cloud.** The store credential
 * authenticates plugin to cloud and must never reach a page a customer can read;
 * this route is the hop that keeps it server-side.
 *
 * @covers \Optionia\Analytics\ViewEndpoint
 */
final class ViewEndpointTest extends TestCase {

	/**
	 * Reset the option store and the capability stub.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
	}

	/** The endpoint, and the collector it feeds. */
	private function endpoint(): ViewEndpoint {
		return new ViewEndpoint( new ViewCollector() );
	}

	/**
	 * A beacon request.
	 *
	 * @param array<string, mixed> $params What the beacon sent.
	 */
	private function request( array $params ): WP_REST_Request {
		$request = new WP_REST_Request();

		foreach ( $params as $name => $value ) {
			$request->set_param( $name, $value );
		}

		return $request;
	}

	/** 🔴 The whole point: a beacon is counted. */
	public function test_it_counts_what_the_beacon_reported(): void {
		$response = $this->endpoint()->handle(
			$this->request(
				array(
					'set'     => 'set-1',
					'options' => array( 'engraving', 'finish' ),
					'day'     => '2026-09-29',
				)
			)
		);

		$this->assertSame( 204, $response->get_status() );
		$this->assertCount( 2, ( new ViewCollector() )->pending() );
	}

	/**
	 * 🔴 **204 and no body, always.** `sendBeacon` cannot read a response and the
	 * customer is leaving the page — anything returned would be discarded, and a
	 * body costs bytes on a request that happens on every product view.
	 */
	public function test_it_answers_204_with_no_body(): void {
		$response = $this->endpoint()->handle(
			$this->request(
				array(
					'set'     => 'set-1',
					'options' => array( 'engraving' ),
					'day'     => '2026-09-29',
				)
			)
		);

		$this->assertSame( 204, $response->get_status() );
		$this->assertNull( $response->get_data() );
	}

	/**
	 * 🔴 **A malformed beacon is dropped silently, never answered with an
	 * error.** `sendBeacon` cannot retry and nobody reads the status, so a 4xx
	 * would be a cost paid on every product page for information no one receives.
	 */
	public function test_it_drops_a_malformed_beacon_without_failing(): void {
		$response = $this->endpoint()->handle( $this->request( array( 'set' => 'set-1' ) ) );

		$this->assertSame( 204, $response->get_status() );
		$this->assertSame( array(), ( new ViewCollector() )->pending() );
	}

	/**
	 * 🔴 **An impossible date is refused HERE, not at the cloud.** The cloud
	 * answers 400 for a date that is not real, and `ViewReporter` treats a 400 as
	 * permanently malformed and drops the whole batch — so one bad beacon would
	 * cost a merchant every count waiting behind it.
	 */
	public function test_it_refuses_a_date_that_does_not_exist(): void {
		foreach ( array( '2026-13-45', '2026-02-31', 'yesterday', '' ) as $day ) {
			$this->endpoint()->handle(
				$this->request(
					array(
						'set'     => 'set-1',
						'options' => array( 'engraving' ),
						'day'     => $day,
					)
				)
			);
		}

		$this->assertSame( array(), ( new ViewCollector() )->pending() );
	}

	/** 📌 And a real date is accepted, including a genuine leap day. */
	public function test_it_accepts_a_real_date(): void {
		$this->endpoint()->handle(
			$this->request(
				array(
					'set'     => 'set-1',
					'options' => array( 'engraving' ),
					'day'     => '2028-02-29',
				)
			)
		);

		$this->assertCount( 1, ( new ViewCollector() )->pending() );
	}

	/**
	 * ⚠️ **One beacon cannot make the handler do unbounded work.** A page with
	 * more than a hundred options is not a page, and the bound is what stops a
	 * forged beacon carrying ten thousand keys.
	 */
	public function test_it_bounds_how_many_options_one_beacon_may_carry(): void {
		$many = array();

		for ( $i = 0; $i < 300; $i++ ) {
			$many[] = 'opt-' . $i;
		}

		$this->endpoint()->handle(
			$this->request(
				array(
					'set'     => 'set-1',
					'options' => $many,
					'day'     => '2026-09-29',
				)
			)
		);

		$this->assertCount( 100, ( new ViewCollector() )->pending() );
	}

	/** ⚠️ A non-array `options` is dropped rather than coerced. */
	public function test_it_drops_options_that_are_not_a_list(): void {
		$response = $this->endpoint()->handle(
			$this->request(
				array(
					'set'     => 'set-1',
					'options' => 'engraving',
					'day'     => '2026-09-29',
				)
			)
		);

		$this->assertSame( 204, $response->get_status() );
		$this->assertSame( array(), ( new ViewCollector() )->pending() );
	}

	/**
	 * 🔴 **A request with no nonce is refused before the handler runs.** The
	 * nonce is a filter rather than a credential — every guest holds the same one
	 * for 24 hours — but it still refuses a caller that never loaded a page.
	 */
	public function test_it_refuses_a_request_with_no_nonce(): void {
		$this->assertFalse( $this->endpoint()->permitted( $this->request( array() ) ) );
	}

	/** 📌 And accepts one carrying a valid nonce. */
	public function test_it_permits_a_request_with_a_valid_nonce(): void {
		$request = $this->request( array( '_wpnonce' => wp_create_nonce( Keys::NONCE_VIEWS ) ) );

		$this->assertTrue( $this->endpoint()->permitted( $request ) );
	}
}
