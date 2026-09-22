<?php
/**
 * A plugin too old to read what the cloud is sending (M9.5).
 *
 * The refusal itself was built in Phase 8 and is the easy half. The hard half is
 * that it is **silent**: keeping the previous copy means the storefront works,
 * the heartbeat arrives, the credential is fine, and the merchant is quietly
 * serving configuration older than the cloud holds. Nothing would ever say so.
 *
 * These cover the three things that break that silence — a remembered flag, an
 * admin notice, and a heartbeat field the cloud can act on — and the fourth
 * that matters just as much: all of it clearing when the merchant updates.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\SchemaNotice;
use Optionia\Api\PostsToCloud;
use Optionia\Api\Response;
use Optionia\Config\Repository;
use Optionia\Connection\Heartbeat;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Refusing a document is reported, not merely done.
 *
 * @covers \Optionia\Config\Repository
 * @covers \Optionia\Admin\SchemaNotice
 */
final class SchemaNegotiationTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_can']     = true;
	}

	/**
	 * A logger over real settings.
	 */
	private function logger(): Logger {
		return new Logger( new Settings() );
	}

	/**
	 * A repository holding a good document at version 7.
	 */
	private function cached(): Repository {
		$repository = new Repository( $this->logger() );

		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array( array( 'id' => 'set-a' ) ),
			),
			'W/"store-7"'
		);

		return $repository;
	}

	/**
	 * A document declaring a shape this build does not know.
	 *
	 * @param int $version Config version.
	 * @return array<string, mixed>
	 */
	private function too_new( int $version = 8 ): array {
		return array(
			'schema_version' => Repository::SUPPORTED_SCHEMA_VERSION + 1,
			'config_version' => $version,
			'option_sets'    => array(),
		);
	}

	/**
	 * Render the notice and return its markup.
	 */
	private function notice(): string {
		ob_start();
		( new SchemaNotice() )->render();

		return (string) ob_get_clean();
	}

	/**
	 * The known-good copy survives, which is the whole point.
	 */
	public function test_a_too_new_document_is_refused_and_the_cache_kept(): void {
		$repository = $this->cached();

		$this->assertFalse( $repository->store( $this->too_new() ) );

		$next_request = new Repository( $this->logger() );

		$this->assertSame( 7, $next_request->config_version(), 'The shop keeps selling.' );
	}

	/**
	 * The refusal is remembered, not only logged.
	 *
	 * A log line is not something the settings screen or the heartbeat can read.
	 */
	public function test_the_refusal_is_recorded(): void {
		$this->cached()->store( $this->too_new() );

		$refused = Repository::refused_schema();

		$this->assertIsArray( $refused );
		$this->assertSame( Repository::SUPPORTED_SCHEMA_VERSION + 1, $refused['document_schema'] );
		$this->assertSame( Repository::SUPPORTED_SCHEMA_VERSION, $refused['supported'] );
	}

	/** Nothing recorded when nothing was refused. */
	public function test_nothing_is_recorded_without_a_refusal(): void {
		$this->cached();

		$this->assertNull( Repository::refused_schema() );
	}

	/**
	 * The merchant is told, in words naming the action.
	 */
	public function test_a_notice_tells_the_merchant_to_update(): void {
		$this->cached()->store( $this->too_new() );

		$notice = $this->notice();

		$this->assertStringContainsString( 'cannot read', $notice );
		$this->assertStringContainsString( 'update the plugin', $notice );
	}

	/**
	 * A warning, not an error.
	 *
	 * Nothing is broken — the shop is selling from its saved options — and an
	 * error notice would send a merchant hunting an outage that is not
	 * happening.
	 */
	public function test_the_notice_does_not_claim_an_outage(): void {
		$this->cached()->store( $this->too_new() );

		$notice = $this->notice();

		$this->assertStringContainsString( 'notice-warning', $notice );
		$this->assertStringContainsString( 'keep working', $notice );
	}

	/** No refusal, no notice. */
	public function test_no_notice_without_a_refusal(): void {
		$this->cached();

		$this->assertSame( '', $this->notice() );
	}

	/**
	 * Only someone who can act on it is told.
	 */
	public function test_the_notice_is_hidden_from_users_who_cannot_update(): void {
		$this->cached()->store( $this->too_new() );

		$GLOBALS['optionia_test_can'] = false;

		$this->assertSame( '', $this->notice() );
	}

	/**
	 * Updating the plugin clears it.
	 *
	 * The flag describes the present, not a history — a merchant who has acted
	 * must stop being told to. The log keeps the history.
	 */
	public function test_an_accepted_document_clears_the_refusal(): void {
		$this->cached()->store( $this->too_new() );

		$this->assertNotNull( Repository::refused_schema() );

		( new Repository( $this->logger() ) )->store(
			array(
				'schema_version' => Repository::SUPPORTED_SCHEMA_VERSION,
				'config_version' => 9,
				'option_sets'    => array(),
			),
			'W/"store-9"'
		);

		$this->assertNull( Repository::refused_schema() );
		$this->assertSame( '', $this->notice() );
	}

	/**
	 * The heartbeat tells the cloud, so support learns without asking.
	 */
	public function test_the_heartbeat_reports_the_refusal(): void {
		$this->cached()->store( $this->too_new() );

		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array() );
			}
		);

		$logger = $this->logger();

		( new Heartbeat( $client, new Repository( $logger ), $logger ) )->send();

		$this->assertSame(
			Repository::SUPPORTED_SCHEMA_VERSION,
			$captured['supported_schema_version']
		);
		$this->assertTrue( $captured['schema_refused'] );
	}

	/**
	 * A healthy store reports the capability without the alarm.
	 *
	 * The two fields answer different questions: what this build *can* read, and
	 * whether that limit has actually bitten. Conflating them would make every
	 * store look stale.
	 */
	public function test_a_healthy_store_reports_no_refusal(): void {
		$this->cached();

		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );

		$captured = null;

		$client = $this->createMock( PostsToCloud::class );
		$client->method( 'post' )->willReturnCallback(
			static function ( string $path, array $body ) use ( &$captured ): Response {
				unset( $path );
				$captured = $body;

				return Response::success( 200, array() );
			}
		);

		$logger = $this->logger();

		( new Heartbeat( $client, new Repository( $logger ), $logger ) )->send();

		$this->assertFalse( $captured['schema_refused'] );
		$this->assertSame(
			Repository::SUPPORTED_SCHEMA_VERSION,
			$captured['supported_schema_version']
		);
	}

	/** The flag is never autoloaded. */
	public function test_the_flag_is_not_autoloaded(): void {
		$this->cached()->store( $this->too_new() );

		$this->assertFalse( $GLOBALS['optionia_test_autoload'][ Keys::OPTION_SCHEMA_REFUSED ] );
	}
}
