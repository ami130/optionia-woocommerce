<?php
/**
 * The callback's refusals, which are its security surface.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\PostsToCloud;
use Optionia\Connection\Callback;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * The connection callback.
 *
 * Only the paths that refuse **before** any HTTP call are exercised here: the
 * ones that exchange need a live client and belong to an integration suite. That
 * is not a gap — refusing early is the whole security contribution of this
 * class, and every refusal below happens without touching the network.
 *
 * @covers \Optionia\Connection\Callback
 */
final class CallbackTest extends TestCase {

	/**
	 * A client that fails the test if it is ever called.
	 *
	 * @return PostsToCloud
	 */
	private function unreachable_client(): PostsToCloud {
		$client = $this->createMock( PostsToCloud::class );

		$client->expects( $this->never() )->method( 'post' );

		return $client;
	}

	/**
	 * Reset options and the capability stub between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_can']     = true;
	}

	/** A request that carries no code is not a callback at all. */
	public function test_a_request_without_a_code_is_not_a_callback(): void {
		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame( Callback::RESULT_NONE, $callback->handle( array() ) );
		$this->assertSame(
			Callback::RESULT_NONE,
			$callback->handle( array( 'state' => 'only-a-state' ) )
		);
	}

	/**
	 * An array-valued parameter is not a callback, and emits no warning.
	 *
	 * `?code[]=a` is trivially craftable. Casting it with `(string)` emitted
	 * "Array to string conversion" — printed into the admin screen wherever
	 * `WP_DEBUG_DISPLAY` is on — before yielding the literal `'Array'`, which
	 * then failed the state comparison. Refused, but noisily, and by accident
	 * rather than by design.
	 *
	 * `failOnWarning` is on in `phpunit.xml.dist`, so this test fails on the
	 * warning alone even if the outcome were still correct.
	 */
	public function test_an_array_parameter_is_not_a_callback(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_HANDSHAKE ] = array(
			'state'    => 'the-state',
			'verifier' => 'the-verifier',
			'expires'  => time() + 60,
		);

		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame(
			Callback::RESULT_NONE,
			$callback->handle(
				array(
					'code'  => array( 'a' ),
					'state' => array( 'b' ),
				)
			)
		);
	}

	/** A non-string of any shape is refused the same way. */
	public function test_a_non_string_parameter_is_not_a_callback(): void {
		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame(
			Callback::RESULT_NONE,
			$callback->handle(
				array(
					'code'  => 12345,
					'state' => true,
				)
			)
		);
	}

	/**
	 * The capability is checked **before** the handshake is read.
	 *
	 * A subscriber following a crafted link must not bind this shop to a
	 * workspace, and must not learn whether a handshake is pending by observing
	 * a different outcome.
	 */
	public function test_a_user_without_the_capability_is_refused(): void {
		$GLOBALS['optionia_test_can'] = false;

		$GLOBALS['optionia_test_options'][ Keys::OPTION_HANDSHAKE ] = array(
			'state'    => 'the-state',
			'verifier' => 'the-verifier',
			'expires'  => time() + 60,
		);

		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame(
			Callback::RESULT_REFUSED,
			$callback->handle(
				array(
					'code'  => 'c',
					'state' => 'the-state',
				)
			)
		);
	}

	/** A callback with nothing pending is not this shop's callback. */
	public function test_a_callback_with_no_pending_handshake_is_refused(): void {
		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame(
			Callback::RESULT_REFUSED,
			$callback->handle(
				array(
					'code'  => 'c',
					'state' => 's',
				)
			)
		);
	}

	/**
	 * **The CSRF defence.** `state` is the only thing standing between this
	 * endpoint and a forged callback, because the cloud cannot produce a
	 * WordPress nonce for a site it has never authenticated to.
	 */
	public function test_a_mismatched_state_is_refused_without_exchanging(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_HANDSHAKE ] = array(
			'state'    => 'the-real-state',
			'verifier' => 'the-verifier',
			'expires'  => time() + 60,
		);

		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame(
			Callback::RESULT_REFUSED,
			$callback->handle(
				array(
					'code'  => 'c',
					'state' => 'a-forged-state',
				)
			)
		);
	}

	/**
	 * A refused callback leaves the pending handshake alone.
	 *
	 * The real one may still arrive, and discarding the verifier on a forged
	 * callback would let anyone cancel a merchant's connection by guessing a
	 * URL.
	 */
	public function test_a_forged_callback_does_not_discard_the_real_handshake(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_HANDSHAKE ] = array(
			'state'    => 'the-real-state',
			'verifier' => 'the-verifier',
			'expires'  => time() + 60,
		);

		$callback = new Callback( $this->unreachable_client() );
		$callback->handle(
			array(
				'code'  => 'c',
				'state' => 'a-forged-state',
			)
		);

		$this->assertArrayHasKey(
			Keys::OPTION_HANDSHAKE,
			$GLOBALS['optionia_test_options']
		);
	}

	/** An expired handshake cannot be completed, however valid the state looks. */
	public function test_an_expired_handshake_is_refused(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_HANDSHAKE ] = array(
			'state'    => 'the-state',
			'verifier' => 'the-verifier',
			'expires'  => time() - 1,
		);

		$callback = new Callback( $this->unreachable_client() );

		$this->assertSame(
			Callback::RESULT_REFUSED,
			$callback->handle(
				array(
					'code'  => 'c',
					'state' => 'the-state',
				)
			)
		);
	}

	/** No refusal path may leave a credential behind. */
	public function test_no_refusal_stores_a_token(): void {
		$callback = new Callback( $this->unreachable_client() );

		$callback->handle(
			array(
				'code'  => 'c',
				'state' => 's',
			)
		);

		$this->assertArrayNotHasKey(
			Keys::OPTION_STORE_TOKEN,
			$GLOBALS['optionia_test_options']
		);
		$this->assertSame( StateMachine::DISCONNECTED, StateMachine::current() );
	}
}
