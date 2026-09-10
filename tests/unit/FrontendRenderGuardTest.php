<?php
/**
 * The storefront must never block on Optionia (AC3, M9.2).
 *
 * `Api\Client::assert_not_frontend_render()` decides whether a request is a
 * customer-facing render. Until this file it had **no test at all** — and the
 * harness made writing one impossible, because `is_admin()`, `wp_doing_cron()`
 * and `wp_doing_ajax()` were hardcoded `false`, placing every test permanently
 * in the forbidden context.
 *
 * ## What this can and cannot assert
 *
 * `Support\Assert` throws only while `WP_DEBUG` is on; in production it logs and
 * the caller continues. `WP_DEBUG` is a constant, so a test cannot toggle it
 * per case without process isolation, and this suite has no precedent for that.
 *
 * So these assert the **decision**: which contexts the guard classifies as a
 * frontend render. That is the part that would silently break — a fourth
 * legitimate context (a WP-Cron alternative, a new REST flag) added to the
 * plugin without being added here would have its requests reported as storefront
 * blocking, and the reverse omission would let a real one through unnoticed.
 *
 * The production behaviour — log rather than throw — is deliberate and recorded
 * in `Support\Assert`: never fatal a storefront to report a problem with it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Api\ResponseValidator;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Which requests count as a customer-facing render.
 *
 * @covers \Optionia\Api\Client
 */
final class FrontendRenderGuardTest extends TestCase {

	/**
	 * Reset request context between tests.
	 *
	 * This file is the one that deliberately runs as a **frontend render**, so
	 * it clears the cron flag the harness otherwise defaults to on.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options']    = array();
		$GLOBALS['optionia_test_is_admin']   = false;
		$GLOBALS['optionia_test_doing_cron'] = false;
		$GLOBALS['optionia_test_doing_ajax'] = false;
	}

	/**
	 * Put the request context back for whatever runs next.
	 *
	 * **State left behind here reached other files.** The globals are reset once
	 * when the harness loads, not per test, so clearing the cron flag above and
	 * never restoring it left every test file that ran afterwards believing it
	 * was a customer page load. That was invisible while the AC3 guard only
	 * logged; Phase 10 Stage 3 made it refuse, and six unrelated tests started
	 * failing — in the full suite only, passing in isolation, which is the
	 * signature of leaked state rather than a defect.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_is_admin']   = false;
		$GLOBALS['optionia_test_doing_cron'] = true;
		$GLOBALS['optionia_test_doing_ajax'] = false;
	}

	/**
	 * Whether the guard classifies the current context as a frontend render.
	 *
	 * Read from the guard itself rather than reimplemented here: a copy of the
	 * condition would agree with a broken original.
	 */
	private function is_frontend_render(): bool {
		/**
		 * Read from the guard itself.
		 *
		 * An earlier version of this test re-derived the condition here and
		 * passed against a guard hardcoded never to fire — a copy agrees with a
		 * broken original by construction. `Client::is_frontend_render()` is
		 * the code the transport actually consults.
		 */
		return Client::is_frontend_render();
	}

	/**
	 * An admin request is not a customer render.
	 */
	public function test_admin_requests_are_allowed(): void {
		$GLOBALS['optionia_test_is_admin'] = true;

		$this->assertFalse( $this->is_frontend_render() );
	}

	/**
	 * WP-Cron is where scheduled sync runs.
	 */
	public function test_cron_requests_are_allowed(): void {
		$GLOBALS['optionia_test_doing_cron'] = true;

		$this->assertFalse( $this->is_frontend_render() );
	}

	/**
	 * Admin-ajax is an admin surface, not a storefront one.
	 */
	public function test_ajax_requests_are_allowed(): void {
		$GLOBALS['optionia_test_doing_ajax'] = true;

		$this->assertFalse( $this->is_frontend_render() );
	}

	/**
	 * A plain front-end page load is the one context that must be refused.
	 *
	 * This is AC3 stated as a test: rendering a product page adds **zero**
	 * external HTTP calls, because configuration comes from cache.
	 */
	public function test_a_plain_page_load_is_a_frontend_render(): void {
		$this->assertTrue(
			$this->is_frontend_render(),
			'A storefront request must be recognised as one, or the guard protects nothing.'
		);
	}
	/**
	 * A client under test, with the HTTP layer counted.
	 */
	private function client(): Client {
		$logger = new Logger( new Settings() );

		return new Client( new Settings(), $logger, new CircuitBreaker( $logger ), new ResponseValidator() );
	}

	/**
	 * How many HTTP requests the harness has been asked to make.
	 */
	private function requests_made(): int {
		return count( $GLOBALS['optionia_test_http_calls'] ?? array() );
	}

	/**
	 * **The guard refuses, it does not merely record.**
	 *
	 * Everything above asserts classification — whether a context *is* a
	 * frontend render. Nothing asserted what happens when one is detected, and
	 * the answer used to be "nothing": `assert_not_frontend_render()` returned
	 * `void`, discarding `Assert::that()`'s reply, and `Assert` throws only
	 * under `WP_DEBUG`. In production the violation was logged and the request
	 * went out regardless.
	 *
	 * The cost was not hypothetical. `Client::TIMEOUT` is eight seconds and
	 * `CircuitBreaker::THRESHOLD` is five, so an unreachable cloud would block
	 * five customer page renders for eight seconds each before the breaker
	 * opened — the precise failure
	 * [AC3](../../../developePlan.md) exists to prevent.
	 *
	 * This runs with `WP_DEBUG` off, deliberately: development already throws,
	 * and production is the environment the guarantee was missing from.
	 */
	public function test_a_frontend_render_is_refused_before_any_request(): void {
		$GLOBALS['optionia_test_http_calls'] = array();

		update_option( 'optionia_store_token', 'store-credential', false );

		$response = $this->client()->get( '/store/config' );

		$this->assertFalse( $response->is_ok(), 'A frontend render must not produce a successful response.' );
		$this->assertSame( 'frontend_render', $response->error_code() );
		$this->assertSame(
			0,
			$this->requests_made(),
			'AC3: no HTTP request may leave the process during a customer page render.'
		);
	}

	/**
	 * The refusal is specific to the render context, not a blanket failure.
	 *
	 * A guard that refused everything would pass the test above while breaking
	 * every legitimate call, so the same client must succeed the moment the
	 * context is one the plugin actually runs in.
	 */
	public function test_the_same_call_proceeds_outside_a_render(): void {
		$GLOBALS['optionia_test_http_calls'] = array();
		$GLOBALS['optionia_test_doing_cron'] = true;

		update_option( 'optionia_store_token', 'store-credential', false );

		$response = $this->client()->get( '/store/config' );

		$this->assertNotSame(
			'frontend_render',
			$response->error_code(),
			'Cron is not a customer page render and must not be refused.'
		);
		$this->assertSame( 1, $this->requests_made(), 'The request must actually be attempted.' );
	}
}
