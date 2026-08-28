<?php
/**
 * The revoked-connection notice (M8.6).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\ReconnectNotice;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * What a merchant is told when a credential is revoked.
 *
 * @covers \Optionia\Admin\ReconnectNotice
 */
final class ReconnectNoticeTest extends TestCase {

	/**
	 * Reset state between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_can']     = true;
	}

	/**
	 * Capture what the notice prints.
	 */
	private function render(): string {
		ob_start();
		( new ReconnectNotice() )->render();

		return (string) ob_get_clean();
	}

	/** A revoked connection is announced, with a way to fix it. */
	public function test_a_revoked_connection_is_announced(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::REVOKED;

		$output = $this->render();

		$this->assertStringContainsString( 'revoked', $output );
		$this->assertStringContainsString( Keys::MENU_SLUG_SETTINGS, $output );
	}

	/**
	 * **AC3 in a sentence.** A revoked store still renders every option a
	 * customer sees. Saying otherwise turns a recoverable state into a support
	 * ticket about an outage that is not happening.
	 */
	public function test_it_says_the_storefront_still_works(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::REVOKED;

		$this->assertStringContainsString( 'keep working', $this->render() );
	}

	/** Every other state is silent. A notice on a healthy shop is noise. */
	public function test_no_other_state_shows_the_notice(): void {
		foreach ( StateMachine::states() as $state ) {
			if ( StateMachine::REVOKED === $state ) {
				continue;
			}

			$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = $state;

			$this->assertSame( '', $this->render(), $state . ' should be silent' );
		}
	}

	/** A user who cannot act on it is not shown it. */
	public function test_a_user_without_the_capability_sees_nothing(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = StateMachine::REVOKED;
		$GLOBALS['optionia_test_can']                                      = false;

		$this->assertSame( '', $this->render() );
	}
}
