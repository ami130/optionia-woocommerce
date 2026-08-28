<?php
/**
 * The plugin's half of M8.1b's state machine.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * The plugin's connection state machine.
 *
 * @covers \Optionia\Connection\StateMachine
 */
final class StateMachineTest extends TestCase {

	/**
	 * Reset the in-memory option store between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
	}

	/**
	 * State is recorded, never inferred from the token.
	 *
	 * M8.1b's central requirement: a token can be present and revoked, absent
	 * mid-handshake, or present on a clone that must not consider itself
	 * connected.
	 */
	public function test_defaults_to_disconnected_even_with_a_token_present(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_STORE_TOKEN ] = 'osk_live_whatever';

		$this->assertSame( StateMachine::DISCONNECTED, StateMachine::current() );
	}

	public function test_records_a_transition(): void {
		$this->assertTrue( StateMachine::transition( StateMachine::CONNECTING ) );
		$this->assertSame( StateMachine::CONNECTING, StateMachine::current() );
	}

	public function test_completes_a_handshake(): void {
		StateMachine::transition( StateMachine::CONNECTING );

		$this->assertTrue( StateMachine::transition( StateMachine::CONNECTED ) );
		$this->assertSame( StateMachine::CONNECTED, StateMachine::current() );
	}

	/**
	 * The asymmetry that matters, mirroring the cloud: arriving at `CONNECTED`
	 * twice would mean a second handshake completed against a live connection.
	 */
	public function test_refuses_connected_to_connected(): void {
		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );

		$this->assertFalse( StateMachine::can( StateMachine::CONNECTED, StateMachine::CONNECTED ) );
		$this->assertFalse( StateMachine::transition( StateMachine::CONNECTED ) );
		$this->assertSame( StateMachine::CONNECTED, StateMachine::current() );
	}

	/** A repeated disconnect or failure is a no-op, not an error. */
	public function test_every_other_state_may_be_re_entered(): void {
		foreach ( StateMachine::states() as $state ) {
			if ( StateMachine::CONNECTED === $state ) {
				continue;
			}

			$this->assertTrue(
				StateMachine::can( $state, $state ),
				$state . ' should be re-enterable'
			);
		}
	}

	/** Re-authorising is always legitimate, from any state. */
	public function test_a_handshake_may_begin_from_any_state(): void {
		foreach ( StateMachine::states() as $state ) {
			$this->assertTrue( StateMachine::can( $state, StateMachine::CONNECTING ) );
		}
	}

	/** A disconnected store cannot become connected without a handshake. */
	public function test_refuses_disconnected_straight_to_connected(): void {
		$this->assertFalse(
			StateMachine::can( StateMachine::DISCONNECTED, StateMachine::CONNECTED )
		);
		$this->assertFalse(
			StateMachine::can( StateMachine::REVOKED, StateMachine::CONNECTED )
		);
	}

	/** A stored value the machine does not know is not trusted. */
	public function test_an_unknown_stored_state_reads_as_disconnected(): void {
		$GLOBALS['optionia_test_options'][ Keys::OPTION_CONNECTION_STATE ] = 'exploded';

		$this->assertSame( StateMachine::DISCONNECTED, StateMachine::current() );
	}

	/** The five states M8.1b names, and no others. */
	public function test_declares_exactly_the_five_states(): void {
		$this->assertCount( 5, StateMachine::states() );
	}

	/**
	 * A floor on strictness: a table permitting everything would pass every
	 * test above while enforcing nothing.
	 */
	public function test_forbids_some_transitions(): void {
		$refused = 0;

		foreach ( StateMachine::states() as $from ) {
			foreach ( StateMachine::states() as $to ) {
				if ( ! StateMachine::can( $from, $to ) ) {
					++$refused;
				}
			}
		}

		$this->assertGreaterThanOrEqual( 3, $refused );
	}
}
