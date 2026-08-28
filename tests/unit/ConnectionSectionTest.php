<?php
/**
 * The connection panel a merchant actually sees (M8.3).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\ConnectionSection;
use Optionia\Api\PostsToCloud;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * What the connection screen renders.
 *
 * M8.3's deliverable is a screen, and its guarantee is that **every state a
 * merchant can be in produces a message they can act on**. A missing case shows
 * a blank panel or a fallback that says nothing, and neither is visible from a
 * test that only checks the classes underneath.
 *
 * This class was reachable-but-untested after `[8k]`'s wiring fix: the coverage
 * floor counts imports, the reachability check counts references, and the one
 * class that *is* the milestone satisfied both while nothing exercised it.
 *
 * @covers \Optionia\Admin\ConnectionSection
 */
final class ConnectionSectionTest extends TestCase {

	/**
	 * Reset options between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_can']     = true;
		$_GET                             = array();
	}

	/**
	 * A section wired to a client that must never be called.
	 *
	 * Rendering makes no HTTP request, and a mock that fails on use says so
	 * rather than leaving it to inspection.
	 */
	private function section(): ConnectionSection {
		$client = $this->createMock( PostsToCloud::class );

		$client->expects( $this->never() )->method( 'post' );

		return new ConnectionSection( new Handshake( $client ), new Callback( $client ) );
	}

	/**
	 * Capture what the panel prints.
	 */
	private function render(): string {
		ob_start();
		$this->section()->render();

		return (string) ob_get_clean();
	}

	/**
	 * Every state says something. The guarantee, asserted directly.
	 */
	public function test_every_state_produces_a_message(): void {
		foreach ( StateMachine::states() as $state ) {
			$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = $state;

			$output = $this->render();

			$this->assertNotSame( '', trim( $output ), $state . ' rendered nothing' );
			$this->assertStringContainsString( 'Connection', $output );
		}
	}

	/** An unconnected shop is offered the one action that matters. */
	public function test_a_disconnected_shop_is_offered_a_connect_button(): void {
		$output = $this->render();

		$this->assertStringContainsString( 'optionia_connect_submit', $output );
		$this->assertStringContainsString( 'not connected', $output );
	}

	/** A connected shop is shown what it is connected to, and a way out. */
	public function test_a_connected_shop_shows_its_workspace_and_a_disconnect(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ]  = StateMachine::CONNECTED;
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_TENANT ] = 'Sam’s Store';
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STORE ]  = 'store-123';

		$output = $this->render();

		$this->assertStringContainsString( 'Sam’s Store', $output );
		$this->assertStringContainsString( 'store-123', $output );
		$this->assertStringContainsString( 'optionia_disconnect_submit', $output );
		$this->assertStringNotContainsString( 'optionia_connect_submit', $output );
	}

	/**
	 * An erroring shop is told its pages still work.
	 *
	 * AC3: `ERROR` never stops the storefront, and a merchant reading this
	 * screen during an outage needs that stated rather than implied.
	 */
	public function test_an_erroring_shop_is_told_its_pages_keep_working(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::ERROR;

		$output = $this->render();

		$this->assertStringContainsString( 'keep working', $output );
		// Still connected, so still offered a way out.
		$this->assertStringContainsString( 'optionia_disconnect_submit', $output );
	}

	/** A revoked shop is told to reconnect, not left guessing. */
	public function test_a_revoked_shop_is_told_to_reconnect(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::REVOKED;

		$output = $this->render();

		$this->assertStringContainsString( 'revoked', $output );
		$this->assertStringContainsString( 'optionia_connect_submit', $output );
	}

	/** A handshake in flight says so, rather than looking disconnected. */
	public function test_a_pending_handshake_says_it_is_waiting(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::CONNECTING;

		$this->assertStringContainsString( 'Waiting for authorization', $this->render() );
	}

	/**
	 * The outcome of the last attempt is reported in words, not codes.
	 */
	public function test_a_failed_attempt_explains_itself(): void {
		$_GET['optionia_connection'] = Callback::RESULT_FAILED;

		$output = $this->render();

		$this->assertStringContainsString( 'could not complete', $output );
		$this->assertStringContainsString( 'notice-error', $output );
	}

	/** A refused link tells the merchant what to do next. */
	public function test_a_refused_link_explains_itself(): void {
		$_GET['optionia_connection'] = Callback::RESULT_REFUSED;

		$this->assertStringContainsString( 'did not match this shop', $this->render() );
	}

	/** An unknown flag prints nothing rather than an empty notice box. */
	public function test_an_unknown_result_flag_is_ignored(): void {
		$_GET['optionia_connection'] = 'not-a-real-result';

		$this->assertStringNotContainsString( 'notice-', $this->render() );
	}

	/** Both destructive forms carry a nonce field. */
	public function test_both_forms_are_nonce_protected(): void {
		$disconnected = $this->render();

		$this->assertStringContainsString( 'optionia_connect_nonce', $disconnected );

		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::CONNECTED;

		$this->assertStringContainsString( 'optionia_disconnect_nonce', $this->render() );
	}
}
