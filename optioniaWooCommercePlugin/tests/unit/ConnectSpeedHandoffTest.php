<?php
/**
 * Phase 8's last exit criterion, and the guard that keeps it from evaporating.
 *
 * "A merchant can connect a store in under 60 seconds" spans two screens: the
 * plugin's connect button and the dashboard's approval prompt. The second is
 * `M13.3`, five phases out, so Phase 8 could not discharge it and handed it on.
 *
 * A handoff written only in prose is how a criterion quietly stops being
 * anyone's. This file is the other half: it asserts the plugin's contribution
 * is genuinely negligible -- so the minute really does belong to the screen it
 * was handed to -- and it **fails once the dashboard exists**, which is the
 * moment the handoff must be honoured rather than inherited again.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Logger;
use Optionia\Support\Settings;
use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * The plugin's share of the 60-second budget is effectively zero.
 *
 * @covers \Optionia\Connection\Handshake
 * @covers \Optionia\Connection\Callback
 */
final class ConnectSpeedHandoffTest extends TestCase {

	/**
	 * The plugin's share of the budget, in milliseconds.
	 *
	 * Deliberately loose. The measured figure is ~0.2 ms; this is not a
	 * performance benchmark and must not fail on a slow CI runner. It exists to
	 * catch a change of *kind* -- a synchronous extra round trip, a blocking
	 * filesystem read -- not a change of degree.
	 */
	private const BUDGET_MS = 250.0;

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
	}

	/**
	 * A cloud that answers instantly, so only plugin work is measured.
	 *
	 * @param array<string, mixed> $payload Response body.
	 */
	private function instant_cloud( array $payload ): PostsToCloud {
		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturn( Response::success( 200, $payload ) );

		return $client;
	}

	/**
	 * Starting a handshake is not where the minute goes.
	 */
	public function test_begin_is_a_negligible_share_of_the_budget(): void {
		$handshake = new Handshake(
			$this->instant_cloud( array( 'authorize_url' => 'https://app.optionia.test/connect?request=r1' ) )
		);

		$started = microtime( true );
		$url     = $handshake->begin();
		$elapsed = ( microtime( true ) - $started ) * 1000;

		$this->assertNotNull( $url, 'A handshake that fails measures nothing.' );
		$this->assertLessThan(
			self::BUDGET_MS,
			$elapsed,
			'Starting a handshake should cost almost nothing — the budget belongs to M13.3.'
		);
	}

	/**
	 * Nor is completing one.
	 */
	public function test_callback_is_a_negligible_share_of_the_budget(): void {
		$handshake = new Handshake(
			$this->instant_cloud( array( 'authorize_url' => 'https://app.optionia.test/connect?request=r1' ) )
		);
		$handshake->begin();

		$stored = get_option( Keys::OPTION_HANDSHAKE, array() );

		$callback = new Callback(
			$this->instant_cloud(
				array(
					'token'       => 'store-credential',
					'store_id'    => 'store-1',
					'tenant_name' => 'Acme Ltd',
				)
			)
		);

		$query = array(
			'optionia_connect' => '1',
			'code'             => 'authorization-code',
			'state'            => $stored['state'],
		);

		$started = microtime( true );
		$result  = $callback->handle( $query );
		$elapsed = ( microtime( true ) - $started ) * 1000;

		$this->assertSame( Callback::RESULT_CONNECTED, $result, 'A refused callback measures nothing.' );
		$this->assertLessThan( self::BUDGET_MS, $elapsed );
	}

	/**
	 * The merchant presses one button.
	 *
	 * The plugin's half of "under 60 seconds" is a single click, and a second
	 * required step here would spend the budget M13.3 needs. Asserted on the
	 * rendered panel rather than on prose, so adding a step breaks this.
	 */
	public function test_connecting_takes_exactly_one_merchant_action(): void {
		$client = $this->createMock( PostsToCloud::class );

		$section = new \Optionia\Admin\ConnectionSection(
			new Handshake( $client ),
			new Callback( $client ),
			$this->createMock( \Optionia\Api\AllowsDeliberateRetry::class ),
			new \Optionia\Config\Synchroniser(
				$this->createMock( \Optionia\Api\FetchesFromCloud::class ),
				new \Optionia\Config\Repository( new Logger( new Settings() ) ),
				new Logger( new Settings() )
			),
			$client
		);

		// The default state is disconnected: what a merchant sees before
		// connecting, which is where the click count matters.
		ob_start();
		$section->render();
		$panel = (string) ob_get_clean();

		$this->assertSame(
			1,
			substr_count( $panel, 'type="submit"' ),
			'Connecting must stay a single click on the plugin side.'
		);
	}

	/*
	 * ✅ **The M13.3 tripwire lived here, and was removed on 2026-09-08 — by
	 * recording the runs, which is the only way it was ever meant to go.**
	 *
	 * `test_handoff_expires_once_the_dashboard_exists()` asserted that the
	 * dashboard directory did *not* exist, so it began failing the moment that
	 * project was created and stayed red for five days. That was the design: the
	 * criterion times a **person** reading screens, an agent timing it would
	 * measure the machine (0.17 ms) and prove nothing, and a red test is a
	 * question someone still has to answer while a skipped one is a question
	 * everyone forgets.
	 *
	 * It is gone because the measurement exists: **12.50s and 11.16s**, stopwatch,
	 * clean connection each time, against a 60-second budget — recorded in
	 * `developePlan.md` beside the ~15s estimate that preceded them.
	 *
	 * ⚠️ **Do not reintroduce a directory-existence tripwire here.** The three
	 * tests above measure the machine half and the click count, which stay true
	 * regardless; the human half is now discharged and re-timing it belongs to
	 * whoever changes the connect flow, not to this suite.
	 */
}
