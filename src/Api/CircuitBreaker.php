<?php
/**
 * Circuit breaker for outbound API calls.
 *
 * Without this, an API outage means every merchant store retries on every cron
 * tick, and each store burns PHP workers on requests that cannot succeed. At
 * scale that turns a partial outage into a self-inflicted denial of service
 * against our own API, and makes merchant sites slow at the same time.
 *
 * After N consecutive failures the circuit opens and calls short-circuit for a
 * cooling-off period. Cached configuration continues to serve throughout
 * (AC3), so the storefront is unaffected.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Consecutive-failure circuit breaker backed by an option.
 */
final class CircuitBreaker {

	/**
	 * Consecutive failures before the circuit opens.
	 */
	private const THRESHOLD = 5;

	/**
	 * Seconds the circuit stays open before allowing a probe request.
	 */
	private const COOLDOWN = 300;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Whether a request may proceed.
	 *
	 * Once the cooldown has elapsed a single request is allowed through as a
	 * probe. If it succeeds the circuit closes; if it fails the cooldown
	 * restarts, so recovery is automatic and needs no intervention.
	 */
	public function allows_request(): bool {
		$state = $this->state();

		if ( $state['failures'] < self::THRESHOLD ) {
			return true;
		}

		return ( time() - $state['opened_at'] ) >= self::COOLDOWN;
	}

	/**
	 * Record a success, closing the circuit.
	 */
	public function record_success(): void {
		$state = $this->state();

		if ( 0 === $state['failures'] ) {
			return;
		}

		$this->save(
			array(
				'failures'  => 0,
				'opened_at' => 0,
			)
		);
	}

	/**
	 * Record a failure, opening the circuit at the threshold.
	 */
	public function record_failure(): void {
		$state    = $this->state();
		$failures = $state['failures'] + 1;

		$this->save(
			array(
				'failures'  => $failures,
				'opened_at' => self::THRESHOLD === $failures ? time() : $state['opened_at'],
			)
		);

		if ( self::THRESHOLD === $failures ) {
			$this->logger->warning(
				'Optionia API circuit opened after consecutive failures; serving cached configuration.',
				array(
					'failures' => $failures,
					'cooldown' => self::COOLDOWN,
				)
			);
		}
	}

	/**
	 * Human-readable state for System Status (M3.6).
	 */
	public function describe(): string {
		$state = $this->state();

		if ( $state['failures'] < self::THRESHOLD ) {
			return 0 === $state['failures']
				? __( 'Closed', 'optionia' )
				: sprintf(
					/* translators: %d: consecutive failure count */
					__( 'Closed (%d recent failures)', 'optionia' ),
					$state['failures']
				);
		}

		$remaining = max( 0, self::COOLDOWN - ( time() - $state['opened_at'] ) );

		return sprintf(
			/* translators: %d: seconds until the circuit retries */
			__( 'Open, retrying in %ds', 'optionia' ),
			$remaining
		);
	}

	/**
	 * Current state, with defaults.
	 *
	 * @return array{failures: int, opened_at: int}
	 */
	private function state(): array {
		$stored = get_option( Keys::OPTION_CIRCUIT_STATE, array() );

		return array(
			'failures'  => isset( $stored['failures'] ) ? (int) $stored['failures'] : 0,
			'opened_at' => isset( $stored['opened_at'] ) ? (int) $stored['opened_at'] : 0,
		);
	}

	/**
	 * Persist state.
	 *
	 * @param array{failures: int, opened_at: int} $state State to store.
	 */
	private function save( array $state ): void {
		update_option( Keys::OPTION_CIRCUIT_STATE, $state, false );
	}
}
