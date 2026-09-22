<?php
/**
 * Immutable result of an API call.
 *
 * Returned instead of a raw array or WP_Error so call sites get a consistent
 * shape and cannot accidentally treat an error body as valid data.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Api;

defined( 'ABSPATH' ) || exit;

/**
 * API response value object.
 */
final class Response {

	/**
	 * HTTP status code, or 0 when the request never completed.
	 *
	 * @var int
	 */
	private int $status;

	/**
	 * Decoded response body.
	 *
	 * @var array<string, mixed>
	 */
	private array $data;

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
	 * @param array<string, mixed>  $data          Decoded body.
	 * @param string|null           $error_code    Error code.
	 * @param string|null           $error_message Error message.
	 * @param array<string, string> $headers       Selected headers.
	 */
	private function __construct(
		int $status,
		array $data,
		?string $error_code,
		?string $error_message,
		array $headers
	) {
		$this->status        = $status;
		$this->data          = $data;
		$this->error_code    = $error_code;
		$this->error_message = $error_message;
		$this->headers       = $headers;
	}

	/**
	 * Successful response.
	 *
	 * @param int                   $status  HTTP status.
	 * @param array<string, mixed>  $data    Decoded body.
	 * @param array<string, string> $headers Selected headers.
	 */
	public static function success( int $status, array $data, array $headers = array() ): self {
		return new self( $status, $data, null, null, $headers );
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
		return new self( $status, array(), $code, $message, $headers );
	}

	/**
	 * Whether the call succeeded.
	 */
	public function is_ok(): bool {
		return null === $this->error_code;
	}

	/**
	 * Whether the resource was unchanged (HTTP 304).
	 *
	 * Not an error: a conditional request answered with "you already have this",
	 * which is the expected outcome of most config syncs.
	 */
	public function is_not_modified(): bool {
		return 304 === $this->status;
	}

	/**
	 * HTTP status code.
	 */
	public function status(): int {
		return $this->status;
	}

	/**
	 * Decoded body.
	 *
	 * @return array<string, mixed>
	 */
	public function data(): array {
		return $this->data;
	}

	/**
	 * Error code, or null on success.
	 */
	public function error_code(): ?string {
		return $this->error_code;
	}

	/**
	 * Error message, or null on success.
	 */
	public function error_message(): ?string {
		return $this->error_message;
	}

	/**
	 * A response header.
	 *
	 * @param string $name Header name, case-insensitive.
	 */
	public function header( string $name ): ?string {
		return $this->headers[ strtolower( $name ) ] ?? null;
	}
}
