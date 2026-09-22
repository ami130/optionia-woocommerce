<?php
/**
 * The connection panel a merchant actually sees (M8.3).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Catalogue\CatalogueCursor;
use Optionia\Config\Repository;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Api\FetchesFromCloud;
use Optionia\Config\Synchroniser;
use Optionia\Api\AllowsDeliberateRetry;
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

		return new ConnectionSection(
			new Handshake( $client ),
			new Callback( $client ),
			$this->createMock( AllowsDeliberateRetry::class ),
			new Synchroniser(
				$this->createMock( FetchesFromCloud::class ),
				new Repository( new Logger( new Settings() ) ),
				new Logger( new Settings() )
			),
			$this->createMock( PostsToCloud::class )
		);
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
	 *
	 * The wording asserted here is deliberately about *what the merchant should
	 * do*, not a fixed phrase. An earlier message told them to check their
	 * internet connection, which was actively misleading: the most common cause
	 * of this notice is a local circuit breaker opened by earlier failures, and
	 * the site's connectivity is usually fine.
	 */
	public function test_a_failed_attempt_explains_itself(): void {
		$_GET['optionia_connection'] = Callback::RESULT_FAILED;

		$output = $this->render();

		$this->assertStringContainsString( 'could not reach', $output );
		$this->assertStringContainsString( 'try again', $output );
		$this->assertStringContainsString( 'notice-error', $output );
	}

	/**
	 * The failure notice does not blame the merchant's network.
	 *
	 * Retrying is what actually works, so that is what it must say first.
	 */
	public function test_failure_notice_leads_with_retrying(): void {
		$_GET['optionia_connection'] = Callback::RESULT_FAILED;

		$output = $this->render();

		$this->assertStringContainsString( 'temporary', $output );
		$this->assertStringNotContainsString( 'Check the site can reach the internet', $output );
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

	/**
	 * 🔴 **Disconnecting must tell the cloud, before it forgets how.**
	 *
	 * A merchant pressing Disconnect in WordPress used to leave a **live
	 * credential** behind: the plugin cleared its token, nothing told the
	 * backend, the store stayed `connected` there, and the dashboard went on
	 * offering a Disconnect for a store already gone.
	 *
	 * It cannot be reconciled afterwards. Both this call and the heartbeat
	 * authenticate with the very token the handler deletes, so once the method
	 * finishes there is nothing left to say anything with — the message has to
	 * go first.
	 */
	public function test_disconnect_tells_the_cloud_before_forgetting_the_token(): void {
		update_option( Keys::OPTION_STORE_TOKEN, 'osk_live_example' );

		/*
		 * ⚠️ **The ordering is the assertion, not merely that the call happens.**
		 * A mutant that moved the call *below* `delete_option()` passed a test
		 * checking only that `post()` ran once — and that mutant is the original
		 * bug: by then the credential is gone, so the request cannot authenticate
		 * and the cloud never hears it.
		 *
		 * Capturing the token as the call is made is what pins the order.
		 */
		$token_at_call = null;

		$api = $this->createMock( PostsToCloud::class );
		$api->expects( $this->once() )
			->method( 'post' )
			->with( $this->identicalTo( '/store/disconnect' ) )
			->willReturnCallback(
				static function () use ( &$token_at_call ) {
					$token_at_call = get_option( Keys::OPTION_STORE_TOKEN, false );
				}
			);

		$this->run_disconnect( $api );

		$this->assertSame(
			'osk_live_example',
			$token_at_call,
			'The cloud must be told while the credential still exists.'
		);

		$this->assertFalse(
			get_option( Keys::OPTION_STORE_TOKEN, false ),
			'The local token must still be cleared.'
		);
	}

	/**
	 * 🔴 **And it must disconnect anyway when the cloud cannot be reached.**
	 *
	 * The local clear is the merchant's only escape hatch. A plugin that refused
	 * to let go because the network was down would strand them with no remedy but
	 * database access — which is the failure the local-first design exists to
	 * prevent. Best-effort means the throw is swallowed, not that it is unlikely.
	 */
	public function test_disconnect_completes_even_when_the_cloud_is_unreachable(): void {
		update_option( Keys::OPTION_STORE_TOKEN, 'osk_live_example' );

		$api = $this->createMock( PostsToCloud::class );
		$api->method( 'post' )->willThrowException( new \RuntimeException( 'network down' ) );

		$this->run_disconnect( $api );

		$this->assertFalse(
			get_option( Keys::OPTION_STORE_TOKEN, false ),
			'An unreachable cloud must not trap a merchant in a connected state.'
		);
	}

	// --- Sync catalogue (M19.1) ----------------------------------------------

	/**
	 * 🔴 **The interim answer to a gap M19.2 closes.** `CatalogueCursor` records
	 * the catalogue total once, and the walk stops on reaching it — so products
	 * added afterwards are never pushed. Until WordPress hooks carry ongoing
	 * changes, this button is the merchant's only way to send them.
	 */
	public function test_the_screen_offers_a_catalogue_sync(): void {
		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTED, false );

		$output = $this->render();

		$this->assertStringContainsString( 'optionia_sync_catalogue_submit', $output );
		$this->assertStringContainsString( 'Sync catalogue', $output );
	}

	/**
	 * ⚠️ **Two buttons, not one.** "Sync now" *fetches* option sets from the
	 * cloud; this *sends* products to it. One control doing both would hide
	 * which half failed.
	 */
	public function test_the_two_sync_controls_are_distinct(): void {
		update_option( Keys::OPTION_CONNECTION_STATE, StateMachine::CONNECTED, false );

		$output = $this->render();

		$this->assertStringContainsString( 'optionia_sync_submit', $output );
		$this->assertStringContainsString( 'optionia_sync_catalogue_submit', $output );
	}

	/**
	 * 🔴 **Forgetting the cursor is the whole mechanism.** The next cron run
	 * then finds no walk in progress and starts one against the *current*
	 * catalogue, reading the total afresh.
	 */
	public function test_syncing_the_catalogue_forgets_the_cursor(): void {
		$cursor = new CatalogueCursor();
		$run_id = $cursor->start( 3000 );
		$cursor->advance( $run_id, 3000 );

		$this->assertTrue( $cursor->is_complete( $cursor->read() ) );

		$_POST = array(
			'optionia_sync_catalogue_submit' => '1',
			'optionia_sync_catalogue_nonce'  => wp_create_nonce( Keys::NONCE_SYNC_CATALOGUE ),
		);

		try {
			$this->section()->maybe_sync_catalogue();
			$this->fail( 'The handler should have redirected.' );
		} catch ( \Optionia_Test_Halt $halt ) {
			unset( $halt );
		} finally {
			$_POST = array();
		}

		$this->assertFalse(
			$cursor->has_run( $cursor->read() ),
			'a fresh walk starts on the next cron run'
		);
	}

	/** A request without the submit field must do nothing at all. */
	public function test_an_unrelated_request_does_not_touch_the_cursor(): void {
		$cursor = new CatalogueCursor();
		$cursor->start( 3000 );

		$_POST = array();

		$this->section()->maybe_sync_catalogue();

		$this->assertTrue( $cursor->has_run( $cursor->read() ) );
	}

	/**
	 * Drive the real handler with a genuine nonce-bearing request.
	 *
	 * @param PostsToCloud $api The cloud client to hand the section.
	 */
	private function run_disconnect( PostsToCloud $api ): void {
		$_POST = array(
			'optionia_disconnect_submit' => '1',
			'optionia_disconnect_nonce'  => wp_create_nonce( Keys::NONCE_DISCONNECT ),
		);

		$client = $this->createMock( PostsToCloud::class );

		$section = new ConnectionSection(
			new Handshake( $client ),
			new Callback( $client ),
			$this->createMock( AllowsDeliberateRetry::class ),
			new Synchroniser(
				$this->createMock( FetchesFromCloud::class ),
				new Repository( new Logger( new Settings() ) ),
				new Logger( new Settings() )
			),
			$api
		);

		try {
			// The handler ends in wp_redirect() + exit; the stub halts there.
			$section->maybe_disconnect();
			$this->fail( 'Disconnect should have redirected.' );
		} catch ( \Optionia_Test_Halt $halt ) {
			unset( $halt );
		} finally {
			$_POST = array();
		}
	}
}
