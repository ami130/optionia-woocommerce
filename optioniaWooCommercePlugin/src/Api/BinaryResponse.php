<?php
/**
 * Immutable result of an API call that carries bytes rather than JSON.
 *
 * ## Why this is not `Response`
 *
 * 🔴 **`Response::data()` returns an array, and a print file is not one.**
 * Widening it to hold a string would mean every existing caller — all of which
 * expect decoded JSON — could be handed bytes by a route that changed shape,
 * and would discover it by passing binary to `array_key_exists`. A separate
 * type makes that a type error at the call site instead of a mystery later.
 *
 * ⚠️ **The failure vocabulary is deliberately the SAME.** `is_ok()`,
 * `status()`, `error_code()` and `error_message()` mean exactly what they mean
 * on `Response`, because the transport underneath is the same transport: the
 * circuit breaker, the retry budget, the 401 revocation hook and the size cap
 * all apply. Only the decoding differs, so only the payload accessor differs.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

defined( 'ABSPATH' ) || exit;

/**
 * API response carrying a binary body.
 */
final class BinaryResponse {

	/**
	 * HTTP status code, or 0 when the request never completed.
	 *
	 * @var int
	 */
	private int $status;

	/**
	 * Raw response body.
	 *
	 * @var string
	 */
	private string $bytes;

	/**
	 * Machine-readable error code, or null on success.
	 *
	 * @var string|null
	 */
	private ?string $error_code;

	/**
	 * Developer-facing error message, or null on success.
	 *
	 * @var string|null
	 */
	private ?string $error_message;

	/**
	 * Response headers of interest, lower-cased keys.
	 *
	 * @var array<string, string>
	 */
	private array $headers;

	/**
	 * Constructor.
	 *
	 * @param int                   $status        HTTP status.
	 * @param string                $bytes         Raw body.
	 * @param string|null           $error_code    Error code.
	 * @param string|null           $error_message Error message.
	 * @param array<string, string> $headers       Selected headers.
	 */
	private function __construct(
		int $status,
		string $bytes,
		?string $error_code,
		?string $error_message,
		array $headers
	) {
		$this->status        = $status;
		$this->bytes         = $bytes;
		$this->error_code    = $error_code;
		$this->error_message = $error_message;
		$this->headers       = $headers;
	}

	/**
	 * Successful response.
	 *
	 * @param int                   $status  HTTP status.
	 * @param string                $bytes   Raw body.
	 * @param array<string, string> $headers Selected headers.
	 */
	public static function success( int $status, string $bytes, array $headers = array() ): self {
		return new self( $status, $bytes, null, null, $headers );
	}

	/**
	 * Failed response.
	 *
	 * @param int                   $status  HTTP status, or 0 for a transport failure.
	 * @param string                $code    Machine-readable error code.
	 * @param string                $message Developer-facing message.
	 * @param array<string, string> $headers Selected headers.
	 */
	public static function failure( int $status, string $code, string $message, array $headers = array() ): self {
		return new self( $status, '', $code, $message, $headers );
	}

	/**
	 * Whether the call succeeded.
	 */
	public function is_ok(): bool {
		return null === $this->error_code;
	}

	/**
	 * HTTP status, or 0 when the request never completed.
	 */
	public function status(): int {
		return $this->status;
	}

	/**
	 * The raw body.
	 *
	 * ⚠️ **Empty on failure, and a caller must check `is_ok()` first.** An
	 * empty string is also a legitimate — if useless — successful body, so
	 * emptiness alone does not distinguish the two.
	 */
	public function bytes(): string {
		return $this->bytes;
	}

	/**
	 * Size of the body in bytes.
	 *
	 * 📌 **`strlen`, never `mb_strlen`.** These are octets, not characters: a
	 * PNG counted as UTF-8 would report a length that matches nothing on disk
	 * and would not compare against `Content-Length`.
	 */
	public function size(): int {
		return strlen( $this->bytes );
	}

	/**
	 * Machine-readable error code, or null on success.
	 */
	public function error_code(): ?string {
		return $this->error_code;
	}

	/**
	 * Developer-facing error message, or null on success.
	 */
	public function error_message(): ?string {
		return $this->error_message;
	}

	/**
	 * A response header, or null when absent.
	 *
	 * @param string $name Header name, case-insensitive.
	 */
	public function header( string $name ): ?string {
		return $this->headers[ strtolower( $name ) ] ?? null;
	}
}
