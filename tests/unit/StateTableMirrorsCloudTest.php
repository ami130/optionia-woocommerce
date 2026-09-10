<?php
/**
 * The plugin's transition table matches the cloud's, edge for edge.
 *
 * M8.1b: "both sides agree on state after any transition." That is only true
 * if both accept the same transitions, and nothing enforced it -- the two
 * tables live in different repositories, and CI checks out one at a time, so a
 * cross-repo gate would pass locally and be meaningless in CI.
 *
 * This is the plugin's side of that guarantee: the cloud's table is transcribed
 * here as data, and any edit to `Connection\StateMachine` that moves away from
 * it fails. When the cloud's own table changes, this file is the thing that
 * must be updated in the same breath -- which is the point.
 *
 * The orientations differ and that trips people up. The cloud declares
 * `ALLOWED_FROM` (which states may *precede* each state); the plugin declares
 * successors. Compared in the same direction they look completely different,
 * which was raised once as a divergence bug and was not one.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Connection\StateMachine;
use PHPUnit\Framework\TestCase;

/**
 * Both halves of M8.1b accept exactly the same transitions.
 *
 * @covers \Optionia\Connection\StateMachine
 */
final class StateTableMirrorsCloudTest extends TestCase {

	/**
	 * The cloud's `ALLOWED_FROM`, transcribed from `store-state.ts`.
	 *
	 * Keyed by destination: to arrive here, the store must currently be one of
	 * these.
	 *
	 * @return array<string, string[]>
	 */
	private function cloud_allowed_from(): array {
		return array(
			StateMachine::CONNECTING   => array(
				StateMachine::DISCONNECTED,
				StateMachine::CONNECTING,
				StateMachine::CONNECTED,
				StateMachine::ERROR,
				StateMachine::REVOKED,
			),
			StateMachine::CONNECTED    => array( StateMachine::CONNECTING, StateMachine::ERROR ),
			StateMachine::ERROR        => array( StateMachine::CONNECTED, StateMachine::ERROR ),
			StateMachine::DISCONNECTED => array(
				StateMachine::CONNECTING,
				StateMachine::CONNECTED,
				StateMachine::ERROR,
				StateMachine::REVOKED,
				StateMachine::DISCONNECTED,
			),
			StateMachine::REVOKED      => array(
				StateMachine::CONNECTING,
				StateMachine::CONNECTED,
				StateMachine::ERROR,
				StateMachine::REVOKED,
			),
		);
	}

	/**
	 * Every edge the cloud allows, the plugin allows.
	 */
	public function test_plugin_accepts_every_transition_the_cloud_does(): void {
		foreach ( $this->cloud_allowed_from() as $to => $froms ) {
			foreach ( $froms as $from ) {
				$this->assertTrue(
					StateMachine::can( $from, $to ),
					sprintf( 'The cloud allows %s -> %s; the plugin refuses it.', $from, $to )
				);
			}
		}
	}

	/**
	 * And no edge the cloud forbids.
	 *
	 * The direction that actually catches drift: a plugin accepting a
	 * transition the cloud rejects reaches a state the cloud will never agree
	 * with, and the heartbeat reports a disagreement forever.
	 */
	public function test_plugin_refuses_every_transition_the_cloud_does(): void {
		$allowed = $this->cloud_allowed_from();

		foreach ( StateMachine::states() as $from ) {
			foreach ( StateMachine::states() as $to ) {
				$cloud_allows = in_array( $from, $allowed[ $to ], true );

				$this->assertSame(
					$cloud_allows,
					StateMachine::can( $from, $to ),
					sprintf(
						'%s -> %s: cloud %s it, plugin %s it.',
						$from,
						$to,
						$cloud_allows ? 'allows' : 'refuses',
						StateMachine::can( $from, $to ) ? 'allows' : 'refuses'
					)
				);
			}
		}
	}

	/**
	 * Both sides know the same five states.
	 *
	 * A sixth on either side would make the comparison above vacuous for it.
	 */
	public function test_both_sides_declare_the_same_states(): void {
		$this->assertEqualsCanonicalizing(
			array_keys( $this->cloud_allowed_from() ),
			StateMachine::states(),
			'A state exists on one side only — the tables can no longer be compared.'
		);
	}
}
