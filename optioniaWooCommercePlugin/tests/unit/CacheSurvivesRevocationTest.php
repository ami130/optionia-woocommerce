<?php
/**
 * The storefront keeps serving after the cloud says no (M8.6, AC3).
 *
 * This file exists because the guarantee is currently held by *omission*:
 * nothing deletes the cached configuration on revocation because nobody wrote
 * code to. That is luck, not a design. `Config\Repository::clear()` exists and
 * is one call away from any future "tidy up on disconnect" change.
 *
 * These tests are the thing standing between AC3 and that change.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\FetchesFromCloud;
use Optionia\Config\Synchroniser;
use Optionia\Admin\ConnectionSection;
use Optionia\Api\AllowsDeliberateRetry;
use Optionia\Api\PostsToCloud;
use Optionia\Config\Repository;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Losing the credential must not lose the shop.
 *
 * @covers \Optionia\Connection\StateMachine
 * @covers \Optionia\Config\Repository
 */
final class CacheSurvivesRevocationTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
	}

	/**
	 * A repository holding a real cached document.
	 */
	private function cached_repository(): Repository {
		$repository = new Repository( new Logger( new Settings() ) );

		// The document's real shape: `option_sets`, as `GET /store/config`
		// sends it. An earlier fixture said `groups`, which no wire response
		// carries — so the tests passed against a document the plugin would
		// never receive.
		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array( array( 'id' => 'g1' ) ),
			),
			'etag-1'
		);

		return $repository;
	}

	/**
	 * Drive the state machine to connected through a legal path.
	 */
	private function connect(): void {
		StateMachine::transition( StateMachine::CONNECTING );
		StateMachine::transition( StateMachine::CONNECTED );
	}

	/**
	 * A revoked credential leaves the cached configuration readable.
	 *
	 * The storefront renders from this cache. If revocation emptied it, every
	 * product page carrying Optionia options would lose them the moment a
	 * merchant rotated a credential.
	 */
	public function test_revocation_leaves_cached_config_readable(): void {
		$repository = $this->cached_repository();
		$this->connect();

		StateMachine::on_unauthorized();

		$next_request = new Repository( new Logger( new Settings() ) );

		$this->assertSame( StateMachine::REVOKED, StateMachine::current() );
		$this->assertTrue( $next_request->has_config(), 'Revocation must not empty the cache.' );
		$this->assertNotNull( $next_request->get(), 'Cached configuration must stay readable.' );

		unset( $repository );
	}

	/**
	 * The cached document is intact, not merely present.
	 *
	 * `has_config()` returning true would still pass if the document had been
	 * replaced by an empty shell, so the content is asserted directly.
	 */
	public function test_revocation_leaves_cached_config_intact(): void {
		$repository = $this->cached_repository();
		$this->connect();

		StateMachine::on_unauthorized();

		$next_request = new Repository( new Logger( new Settings() ) );
		$config       = $next_request->get();

		$this->assertIsArray( $config );
		$this->assertSame( array( array( 'id' => 'g1' ) ), $config['option_sets'] );
		$this->assertSame( 7, $next_request->config_version() );
		$this->assertSame( 'etag-1', $next_request->etag() );

		unset( $repository );
	}

	/**
	 * A merchant disconnect is not a data-loss event either.
	 *
	 * The contract's wording: a merchant who disconnects by accident loses the
	 * ability to publish, not their shop. `Admin\ConnectionSection` deletes the
	 * credential and connection metadata; this asserts the list stops there.
	 */
	public function test_disconnect_leaves_cached_config_readable(): void {
		$repository = $this->cached_repository();
		$this->connect();

		$this->run_real_disconnect();

		// A fresh instance, deliberately: Repository memoises, so reusing the
		// one that loaded the document before the deletion would answer from
		// memory and pass even if the option had been removed.
		$next_request = new Repository( new Logger( new Settings() ) );

		$this->assertSame( StateMachine::DISCONNECTED, StateMachine::current() );
		$this->assertFalse( (bool) get_option( Keys::OPTION_STORE_TOKEN, '' ), 'The credential must go.' );
		$this->assertTrue( $next_request->has_config(), 'Disconnect must not empty the cache.' );
		$this->assertNotNull( $next_request->get() );

		unset( $repository );
	}

	/**
	 * Drive the real disconnect handler.
	 *
	 * Deleting the same options by hand would only re-test the stubs: a
	 * mutation adding `delete_option( OPTION_CONFIG )` to the handler survived
	 * exactly that shape of test. This posts a genuine nonce-bearing request
	 * and lets `Admin\ConnectionSection` do the work.
	 */
	private function run_real_disconnect(): void {
		$_POST = array(
			'optionia_disconnect_submit' => '1',
			'optionia_disconnect_nonce'  => wp_create_nonce( Keys::NONCE_DISCONNECT ),
		);

		/*
		 * Real collaborators. The *handshake* client must never be called here —
		 * disconnecting starts no new handshake — but the API client passed last
		 * now **is** called: ✏️ corrected 2026-09-03, when the disconnect stopped
		 * being local-only.
		 *
		 * It used to be, and this comment used to say so. A merchant pressing
		 * Disconnect in WordPress left a **live credential** in the cloud, because
		 * nothing told it. The plugin now says so before deleting the token it
		 * would need to say anything at all.
		 */
		$client = $this->createMock( PostsToCloud::class );
		$client->expects( $this->never() )->method( 'post' );

		$section = new ConnectionSection(
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

	/**
	 * A body with no `option_sets` replaces nothing.
	 *
	 * The second defence behind `Config\Synchroniser`. A `304 Not Modified`
	 * carries no body and `Api\Response::is_ok()` is true for one, so a caller
	 * checking `is_ok()` first hands this an empty array on the most ordinary
	 * path there is. Measured before the guard existed: a cached document at
	 * version 7 became no configuration at all.
	 *
	 * Guarded here as well as in the caller because AC3 is a promise about the
	 * storefront, and a promise that depends on every future caller getting one
	 * conditional right is not a promise.
	 */
	public function test_a_body_without_option_sets_is_refused(): void {
		$repository = $this->cached_repository();

		$this->assertFalse( $repository->store( array() ) );

		$next_request = new Repository( new Logger( new Settings() ) );

		$this->assertTrue( $next_request->has_config(), 'The cached copy must survive.' );
		$this->assertSame( 7, $next_request->config_version() );

		unset( $repository );
	}

	/**
	 * A merchant who has published nothing still has a document.
	 *
	 * `option_sets: []` is a legitimate configuration — the guard above tests
	 * for the key's presence, not for content, and confusing the two would stop
	 * a store ever caching its first empty catalogue.
	 */
	public function test_an_empty_catalogue_is_still_a_document(): void {
		$repository = new Repository( new Logger( new Settings() ) );

		$this->assertTrue(
			$repository->store(
				array(
					'schema_version' => 1,
					'config_version' => 3,
					'option_sets'    => array(),
				),
				'etag-3'
			)
		);

		$this->assertSame( 3, ( new Repository( new Logger( new Settings() ) ) )->config_version() );
	}

	/**
	 * Clearing is still possible when something genuinely means it.
	 *
	 * Without this, the tests above would also pass against a `clear()` that had
	 * been quietly broken -- and would then be guarding nothing.
	 */
	public function test_clear_still_empties_the_cache(): void {
		$repository = $this->cached_repository();

		$repository->clear();

		$this->assertFalse( $repository->has_config() );
		$this->assertNull( $repository->get() );
	}
}
