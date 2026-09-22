<?php
/**
 * The only outbound HTTP client in the plugin (M3.5b).
 *
 * Principle 2: `wp_remote_*` must not appear outside this directory, and a CI
 * check enforces it. Scattering HTTP calls means auth, timeouts and retry
 * behaviour drift per call site — and a single call missing a timeout can hang
 * a merchant's page render for the PHP socket default.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

use Optionia\Support\Assert;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * HTTP client for the Optionia API.
 */
final class Client implements PostsToCloud, FetchesFromCloud {

	/**
	 * Seconds to wait for a single HTTP attempt. Deliberately short: this must
	 * never be long enough to matter to a human waiting on a page.
	 */
	private const TIMEOUT = 8;

	/**
	 * Attempts for retryable failures, including the first.
	 */
	private const MAX_ATTEMPTS = 3;

	/**
	 * Hard ceiling, in seconds, on the total time one request() call may consume
	 * including every retry and every sleep.
	 *
	 * Per-attempt timeouts alone are not enough. Three 8-second attempts plus two
	 * server-dictated `Retry-After: 30` sleeps would block for 84 seconds, which
	 * exceeds PHP's default 30-second max_execution_time. The process would then
	 * be killed mid-flight — potentially between writing the config and writing
	 * its metadata, leaving the cache describing itself incorrectly.
	 *
	 * 20 seconds leaves headroom under a 30-second limit for the caller's own
	 * work, and is checked before every sleep and every retry.
	 */
	private const MAX_TOTAL_SECONDS = 20;

	/**
	 * Largest response we will read, in bytes. A hostile or malfunctioning
	 * endpoint must not be able to exhaust a merchant's PHP memory limit.
	 */
	private const MAX_RESPONSE_BYTES = 5242880;

	/**
	 * Settings.
	 *
	 * @var Settings
	 */
	private Settings $settings;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Circuit breaker.
	 *
	 * @var CircuitBreaker
	 */
	private CircuitBreaker $breaker;

	/**
	 * Response validator.
	 *
	 * @var ResponseValidator
	 */
	private ResponseValidator $validator;

	/**
	 * Constructor.
	 *
	 * @param Settings          $settings  Settings.
	 * @param Logger            $logger    Logger.
	 * @param CircuitBreaker    $breaker   Circuit breaker.
	 * @param ResponseValidator $validator Response validator.
	 */
	public function __construct(
		Settings $settings,
		Logger $logger,
		CircuitBreaker $breaker,
		ResponseValidator $validator
	) {
		$this->settings  = $settings;
		$this->logger    = $logger;
		$this->breaker   = $breaker;
		$this->validator = $validator;
	}

	/**
	 * GET request.
	 *
	 * @param string                $path    Path relative to the API base.
	 * @param array<string, string> $query   Query parameters.
	 * @param array<string, string> $headers Extra headers.
	 */
	public function get( string $path, array $query = array(), array $headers = array() ): Response {
		return $this->request( 'GET', $path, null, $query, $headers );
	}

	/**
	 * POST request.
	 *
	 * @param string                $path      Path relative to the API base.
	 * @param array<string, mixed>  $body_data Body, JSON-encoded before sending.
	 * @param array<string, string> $headers   Extra headers.
	 */
	public function post( string $path, array $body_data = array(), array $headers = array() ): Response {
		return $this->request( 'POST', $path, $body_data, array(), $headers );
	}

	/**
	 * DELETE request.
	 *
	 * Retry, timeout and circuit breaking are `request()`'s, exactly as for a
	 * POST -- which is the reason this is three lines rather than its own
	 * transport. `null` for the body: a DELETE names its resource in the path.
	 *
	 * @param string                $path    Path relative to the API base.
	 * @param array<string, string> $headers Extra headers.
	 */
	public function delete( string $path, array $headers = array() ): Response {
		return $this->request( 'DELETE', $path, null, array(), $headers );
	}

	/**
	 * Perform a request with retry and circuit breaking.
	 *
	 * @param string                    $method  HTTP method.
	 * @param string                    $path    Path relative to the API base.
	 * @param array<string, mixed>|null $body    Request body.
	 * @param array<string, string>     $query   Query parameters.
	 * @param array<string, string>     $headers Extra headers.
	 */
	private function request(
		string $method,
		string $path,
		?array $body,
		array $query,
		array $headers
	): Response {
		/*
		 * AC3: nothing on a customer-facing page render may block on the API.
		 *
		 * Refused before the circuit breaker is consulted.
		 *
		 * AC3 holds either way — measured: with the order swapped, a render
		 * still makes zero requests, because the breaker refuses too. What the
		 * order decides is *which* refusal a developer sees. Ordered this way, a
		 * render during an open circuit reports `frontend_render` rather than
		 * `circuit_open`, naming the mistake the plugin made instead of the
		 * symptom it happened to hit first.
		 */
		if ( ! $this->refuse_on_frontend_render() ) {
			return Response::failure( 0, 'frontend_render', 'Refused: the API must not be called during a page render (AC3).' );
		}

		if ( ! $this->breaker->allows_request() ) {
			$this->logger->debug( 'API request short-circuited by open circuit.', array( 'path' => $path ) );

			return Response::failure( 0, 'circuit_open', 'Circuit breaker is open.' );
		}

		$url = $this->build_url( $path, $query );

		$args = array(
			'method'      => $method,
			'timeout'     => self::TIMEOUT,
			'redirection' => 0,
			'sslverify'   => true,
			'headers'     => $this->build_headers( $headers ),
			'user-agent'  => $this->user_agent(),
		);

		if ( null !== $body && array() !== $body ) {
			$encoded = wp_json_encode( $body );

			if ( false === $encoded ) {
				return Response::failure( 0, 'encode_failed', 'Request body could not be encoded.' );
			}

			$args['body'] = $encoded;
		}

		$last     = Response::failure( 0, 'not_attempted', 'No attempt was made.' );
		$deadline = microtime( true ) + self::MAX_TOTAL_SECONDS;

		for ( $attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++ ) {
			$last = $this->attempt( $url, $args, $path );

			if ( $last->is_ok() || $last->is_not_modified() ) {
				$this->breaker->record_success();

				return $last;
			}

			if ( ! $this->is_retryable( $last ) ) {
				// A 4xx is a real answer, not a transient failure. Retrying an
				// invalid request just wastes time and confuses the breaker.
				$this->breaker->record_failure();

				return $last;
			}

			if ( $attempt >= self::MAX_ATTEMPTS ) {
				break;
			}

			// Only sleep and retry if both the sleep and a further attempt fit
			// inside the remaining budget. Otherwise stop now: exceeding the
			// budget risks the process being killed mid-write.
			$remaining = $deadline - microtime( true );
			$delay     = $this->retry_delay( $attempt, $last );

			if ( $remaining <= ( $delay + self::TIMEOUT ) ) {
				$this->logger->debug(
					'Abandoning retries to stay inside the request budget.',
					array(
						'path'      => $path,
						'attempt'   => $attempt,
						'remaining' => round( $remaining, 2 ),
					)
				);

				break;
			}

			usleep( (int) round( $delay * 1000000 ) );
		}

		$this->breaker->record_failure();

		$this->logger->warning(
			'API request failed after retries.',
			array(
				'path'     => $path,
				'attempts' => self::MAX_ATTEMPTS,
				'code'     => $last->error_code(),
				'status'   => $last->status(),
			)
		);

		return $last;
	}

	/**
	 * A single HTTP attempt.
	 *
	 * @param string               $url  Absolute URL.
	 * @param array<string, mixed> $args wp_remote_request arguments.
	 * @param string               $path Path, for logging.
	 */
	private function attempt( string $url, array $args, string $path ): Response {
		$raw = wp_remote_request( $url, $args );

		if ( is_wp_error( $raw ) ) {
			return Response::failure( 0, 'transport_error', $raw->get_error_message() );
		}

		$status  = (int) wp_remote_retrieve_response_code( $raw );
		$headers = $this->extract_headers( $raw );

		if ( 304 === $status ) {
			return Response::success( 304, array(), $headers );
		}

		$body = (string) wp_remote_retrieve_body( $raw );

		if ( strlen( $body ) > self::MAX_RESPONSE_BYTES ) {
			return Response::failure( $status, 'response_too_large', 'Response exceeded the size limit.', $headers );
		}

		if ( $status < 200 || $status >= 300 ) {
			/**
			 * The credential is no longer accepted (M8.6).
			 *
			 * Announced, not acted on. This class is transport: it knows about
			 * HTTP and must not know what a connection *means*, or the layering
			 * the architecture gate enforces stops being true — `src/Api/` owns
			 * requests, `src/Connection/` owns state.
			 *
			 * `Connection\StateMachine` listens and moves the store to
			 * `REVOKED`. Without this the cloud revokes, the next request fails,
			 * and the settings screen goes on saying "Connected" until a merchant
			 * wonders why publishing stopped — the ambiguity M8.1b calls the
			 * largest source of support tickets in this category of product.
			 *
			 * A `403` is deliberately not included: `[8i]` answers that when a
			 * *site* presents a genuine credential from the wrong address, and
			 * the credential itself is still good.
			 */
			if ( 401 === $status ) {
				do_action( 'optionia_unauthorized', $path );
			}

			return Response::failure(
				$status,
				'http_' . $status,
				$this->extract_error_message( $body, $status ),
				$headers
			);
		}

		$validated = $this->validator->decode( $body );

		if ( ! $validated->is_ok() ) {
			$this->logger->warning(
				'API response failed validation.',
				array(
					'path'   => $path,
					'status' => $status,
					'reason' => $validated->first_error_code(),
				)
			);

			return Response::failure( $status, 'invalid_response', 'Response body was not valid JSON.', $headers );
		}

		$data = self::unwrap( (array) $validated->value( array() ) );

		return Response::success( $status, $data, $headers );
	}

	/**
	 * Take the payload out of the API's response envelope (ADR-009).
	 *
	 * Every cloud response is `{"data": ..., "meta": {...}}`. Callers want the
	 * payload: `Connection\Handshake` reads `authorize_url`, `Callback` reads
	 * `token`, `Heartbeat` reads `config_version`. Unwrapping here means each of
	 * them reads what it asked for rather than reaching through a transport
	 * detail, and it is the one place that has to change if the envelope ever
	 * does.
	 *
	 * This was a live defect, not a refactor. Every one of those callers read
	 * the envelope's *outer* level, so against the real API `begin()` returned
	 * null, `handle()` returned `failed` with no token stored, and the heartbeat
	 * recorded no version — the whole connection flow, broken. Both test suites
	 * passed throughout: the backend's e2e asserts `body.data.authorize_url`
	 * while every plugin fixture was flat, so each side was self-consistent and
	 * disagreed with the other.
	 *
	 * A body **without** `data` is returned unchanged. `/health` is served
	 * unwrapped by design, and a bare payload is what most of the test suite
	 * still supplies; treating its absence as an error would refuse both.
	 *
	 * @param array<string, mixed> $body Decoded response body.
	 * @return array<string, mixed>
	 */
	private static function unwrap( array $body ): array {
		if ( ! array_key_exists( 'data', $body ) ) {
			return $body;
		}

		// `data` is null for a 204-style response: the key is always present, so
		// its emptiness is a valid payload rather than a missing envelope.
		return is_array( $body['data'] ) ? $body['data'] : array();
	}

	/**
	 * Whether a failure is worth retrying.
	 *
	 * Transport errors, 429 and 5xx are transient. Everything else is the API
	 * telling us something true about the request.
	 *
	 * @param Response $response Failed response.
	 */
	private function is_retryable( Response $response ): bool {
		if ( 'transport_error' === $response->error_code() ) {
			return true;
		}

		$status = $response->status();

		return 429 === $status || $status >= 500;
	}

	/**
	 * How long to wait before the next attempt, in seconds.
	 *
	 * Honours `Retry-After` when the server sends one, otherwise exponential
	 * backoff with jitter — so that a thousand stores recovering from an outage
	 * do not retry in lockstep and immediately re-overload the API.
	 *
	 * The cap is deliberately low. A server-supplied `Retry-After: 3600` is
	 * information, not an instruction we can obey inside one PHP request; the
	 * circuit breaker is the mechanism for honouring long backoffs across
	 * requests.
	 *
	 * @param int      $attempt  Attempt number just completed.
	 * @param Response $response Failed response.
	 */
	private function retry_delay( int $attempt, Response $response ): float {
		$retry_after = $response->header( 'retry-after' );

		if ( null !== $retry_after && ctype_digit( $retry_after ) ) {
			return (float) min( 5, max( 1, (int) $retry_after ) );
		}

		$base   = 2 ** ( $attempt - 1 );
		$jitter = wp_rand( 0, 1000 ) / 1000;

		return (float) min( 5, $base + $jitter );
	}

	/**
	 * Build the absolute request URL.
	 *
	 * @param string                $path  Path relative to the API base.
	 * @param array<string, string> $query Query parameters.
	 */
	private function build_url( string $path, array $query ): string {
		$url = $this->settings->api_base_url() . '/' . ltrim( $path, '/' );

		return array() === $query ? $url : add_query_arg( $query, $url );
	}

	/**
	 * Build request headers.
	 *
	 * Version headers travel on every request so the cloud can identify stale
	 * installs and support can answer "what are they running?" without asking.
	 *
	 * @param array<string, string> $extra Caller-supplied headers.
	 * @return array<string, string>
	 */
	private function build_headers( array $extra ): array {
		$headers = array(
			'Accept'             => 'application/json',
			'Content-Type'       => 'application/json',
			'X-Optionia-Version' => OPTIONIA_VERSION,
			'X-Optionia-Site'    => home_url( '/' ),
			'X-Optionia-WP'      => get_bloginfo( 'version' ),
			'X-Optionia-WC'      => defined( 'WC_VERSION' ) ? WC_VERSION : 'unknown',
			'X-Optionia-PHP'     => PHP_VERSION,
		);

		$token = get_option( Keys::OPTION_STORE_TOKEN, '' );

		if ( is_string( $token ) && '' !== $token ) {
			$headers['Authorization'] = 'Bearer ' . $token;
		}

		return array_merge( $headers, $extra );
	}

	/**
	 * User agent string.
	 */
	private function user_agent(): string {
		return sprintf( 'Optionia/%s (WordPress/%s)', OPTIONIA_VERSION, get_bloginfo( 'version' ) );
	}

	/**
	 * Extract the headers we care about.
	 *
	 * @param array<string, mixed>|\WP_Error $raw wp_remote_request result.
	 * @return array<string, string>
	 */
	private function extract_headers( $raw ): array {
		$wanted = array( 'etag', 'retry-after', 'x-request-id' );
		$out    = array();

		foreach ( $wanted as $name ) {
			$value = wp_remote_retrieve_header( $raw, $name );

			if ( is_string( $value ) && '' !== $value ) {
				$out[ $name ] = $value;
			}
		}

		return $out;
	}

	/**
	 * Pull an error message out of an error body, falling back to the status.
	 *
	 * @param string $body   Raw response body.
	 * @param int    $status HTTP status.
	 */
	private function extract_error_message( string $body, int $status ): string {
		$decoded = json_decode( $body, true );

		if ( ! is_array( $decoded ) ) {
			return sprintf( 'HTTP %d', $status );
		}

		/**
		 * The cloud's shape first: `{"error": {"code": ..., "message": ...}}`.
		 *
		 * The flat keys below are kept as a fallback for a proxy or gateway
		 * error that never reached the application — those bodies are not in
		 * this API's envelope and are exactly when a merchant most needs the
		 * message.
		 *
		 * Checked before the flat keys because `error` is an *array* here. The
		 * earlier loop looked for a string under that key, found an array,
		 * skipped it, and returned "HTTP 400" — discarding the one sentence
		 * explaining what went wrong.
		 */
		if ( isset( $decoded['error']['message'] ) && is_string( $decoded['error']['message'] ) ) {
			return $decoded['error']['message'];
		}

		foreach ( array( 'message', 'error', 'detail' ) as $key ) {
			if ( isset( $decoded[ $key ] ) && is_string( $decoded[ $key ] ) ) {
				return $decoded[ $key ];
			}
		}

		return sprintf( 'HTTP %d', $status );
	}

	/**
	 * Whether this request may proceed, given AC3.
	 *
	 * Returns `false` on a customer-facing render, and the caller refuses.
	 *
	 * **This used to report rather than block.** It returned `void`, discarding
	 * `Assert::that()`'s answer, and `Assert` throws only under `WP_DEBUG` — so
	 * in production a violation was logged and the request went out anyway.
	 * AC3 was enforced in development and merely observed in production, which is
	 * the wrong way round: development is where a mistake is cheap.
	 *
	 * The cost of letting it through is not theoretical. `TIMEOUT` is eight
	 * seconds and `CircuitBreaker::THRESHOLD` is five, so an unreachable cloud
	 * would block five customer page renders for eight seconds each before the
	 * breaker opened — precisely the failure this guard exists to prevent.
	 *
	 * Nothing could reach it when it was written: every `Config\Synchroniser`
	 * trigger is cron, REST or admin. Phase 10's renderer is the first code to
	 * run on a product page, which is why this was fixed before that renderer
	 * exists rather than after it went wrong.
	 *
	 * `Assert` is kept for developer visibility — it still throws under
	 * `WP_DEBUG`, so the mistake surfaces immediately while someone is looking —
	 * but the refusal no longer depends on it.
	 */
	private function refuse_on_frontend_render(): bool {
		return Assert::that(
			! self::is_frontend_render(),
			'Optionia API called during a frontend render. Configuration must be served from cache (AC3).'
		);
	}

	/**
	 * Whether this request is a customer-facing page render.
	 *
	 * Split from the assertion so the classification can be tested directly.
	 * `Support\Assert` throws only under `WP_DEBUG` and otherwise logs, so a
	 * test driving the guard through `Assert` observes nothing it can rely on —
	 * and a test that re-derived this condition would agree with a broken
	 * original by construction. It was measured: such a test passed against a
	 * guard hardcoded never to fire.
	 *
	 * Public so it can be asserted; static because it reads request state and
	 * holds none.
	 *
	 * **Two exclusions have a customer-facing case behind them.**
	 *
	 * `wp_doing_ajax()` excludes AJAX, on the reasoning that admin-ajax is the
	 * dashboard talking to itself. WooCommerce uses it for **storefront**
	 * actions too — add-to-cart, cart fragments — and a shopper waits on those,
	 * so the AC3 condition holds while this returns `false`. It is unreachable
	 * today: this plugin registers no AJAX handler, and `Config\Synchroniser`
	 * fires only on its cron hook. The same answer as REST below applies if that
	 * ever changes.
	 *
	 * **REST is excluded, and Store API is the case that tests that.**
	 *
	 * A REST request is normally a machine asking — this plugin's own push
	 * endpoint, or the WordPress admin over `wp-json`. A Store API request is
	 * not: [M10.4](../../../developePlan.md) extends it for block themes, and a
	 * shopper waits on that response, so the AC3 condition holds while this
	 * returns `false`.
	 *
	 * Narrowing the exclusion to this plugin's own routes was considered and
	 * rejected: the route is not knowable here. `REST_REQUEST` is a bare
	 * constant, and the matched route lives in `WP_REST_Server`, which has not
	 * dispatched by the time a caller reaches this. A guard that guessed from
	 * `REQUEST_URI` would be defeated by any site with a non-default permalink
	 * or `?rest_route=`, and a guard that is right most of the time is worse
	 * than one whose boundary is written down.
	 *
	 * So Store API is out of scope **here**, and covered where it can be:
	 * `bin/check-architecture.sh` asserts the storefront read path reaches no
	 * transport at all, whatever context it runs in. M10.4's handler reads the
	 * same cache as the classic renderer, so it inherits that guarantee rather
	 * than needing this classification to be cleverer.
	 */
	public static function is_frontend_render(): bool {
		return ! is_admin()
			&& ! wp_doing_cron()
			&& ! wp_doing_ajax()
			&& ! ( defined( 'REST_REQUEST' ) && REST_REQUEST )
			&& ! ( defined( 'WP_CLI' ) && WP_CLI );
	}
}
