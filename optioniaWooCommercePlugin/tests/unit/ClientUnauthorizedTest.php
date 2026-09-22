<?php
/**
 * The 401 announcement that connects transport to connection state (M8.6).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * `Api\Client` announces a refused credential and nothing more.
 *
 * The class is transport: it knows HTTP and must not know what a connection
 * *means*. The announcement is the seam — and a test that only checks the
 * listener would pass with the announcement deleted, which is exactly what a
 * mutation found before this file existed.
 *
 * @covers \Optionia\Api\Client
 */
final class ClientUnauthorizedTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_http']    = array(
			'status' => 200,
			'body'   => '{"data":{}}',
		);
	}

	/**
	 * A client wired to real collaborators.
	 */
	private function client(): Client {
		$settings = new Settings();
		$logger   = new Logger( $settings );

		return new Client( $settings, $logger, new CircuitBreaker( $logger ), new ResponseValidator() );
	}

	/**
	 * Record every `optionia_unauthorized` the request fires.
	 *
	 * @return array<int, string>
	 */
	private function capture(): array {
		$fired = array();

		add_action(
			'optionia_unauthorized',
			static function ( $path ) use ( &$fired ): void {
				$fired[] = (string) $path;
			}
		);

		return $fired;
	}

	/** A refused credential is announced, carrying the path that saw it. */
	public function test_a_401_is_announced(): void {
		$fired = array();

		add_action(
			'optionia_unauthorized',
			static function ( $path ) use ( &$fired ): void {
				$fired[] = (string) $path;
			}
		);

		$GLOBALS['optionia_test_http'] = array(
			'status' => 401,
			'body'   => '{"error":{"code":"UNAUTHENTICATED"}}',
		);

		$this->client()->post( '/store/heartbeat', array() );

		$this->assertSame( array( '/store/heartbeat' ), $fired );
	}

	/**
	 * A `403` is **not** announced.
	 *
	 * `[8i]` answers `403` when a site presents a genuine credential from the
	 * wrong address. The credential is still good, and revoking on it would let
	 * a cloned site disconnect the original.
	 */
	public function test_a_403_is_not_announced(): void {
		$fired = array();

		add_action(
			'optionia_unauthorized',
			static function () use ( &$fired ): void {
				$fired[] = 'fired';
			}
		);

		$GLOBALS['optionia_test_http'] = array(
			'status' => 403,
			'body'   => '{"error":{"code":"FORBIDDEN"}}',
		);

		$this->client()->post( '/store/heartbeat', array() );

		$this->assertSame( array(), $fired );
	}

	/** Nor is a successful request. */
	public function test_a_success_is_not_announced(): void {
		$fired = array();

		add_action(
			'optionia_unauthorized',
			static function () use ( &$fired ): void {
				$fired[] = 'fired';
			}
		);

		$this->client()->post( '/store/heartbeat', array() );

		$this->assertSame( array(), $fired );
	}
}
