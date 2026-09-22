<?php
/**
 * Uniform outcome type for engine operations.
 *
 * Principle 5: validation and pricing both answer "did this work, and if not
 * why" — expressed once, here, rather than as a mix of booleans, nulls,
 * WP_Error objects and thrown exceptions.
 *
 * Deliberately free of WordPress: Engine\ is pure so it can be unit-tested
 * without a WordPress bootstrap and share fixtures with the TypeScript
 * implementation (see M11.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Engine;

defined( 'ABSPATH' ) || exit;

/**
 * Success-or-errors result carrying an arbitrary value.
 *
 * Errors are structured rather than pre-formatted strings: the engine reports
 * `code`, `field` and `params`, and the presentation layer turns those into a
 * translated, merchant-overridable message. An engine that returned English
 * sentences could not be localised (M29.8).
 */
final class Result {

	/**
	 * Whether the operation succeeded.
	 *
	 * @var bool
	 */
	private bool $ok;

	/**
	 * Result value on success; null on failure.
	 *
	 * @var mixed
	 */
	private $value;

	/**
	 * Structured errors: each entry has `code`, optional `field`, optional `params`.
	 *
	 * @var array<int, array<string, mixed>>
	 */
	private array $errors;

	/**
	 * Constructor.
	 *
	 * @param bool                             $ok     Success flag.
	 * @param mixed                            $value  Result value.
	 * @param array<int, array<string, mixed>> $errors Structured errors.
	 */
	private function __construct( bool $ok, $value, array $errors ) {
		$this->ok     = $ok;
		$this->value  = $value;
		$this->errors = $errors;
	}

	/**
	 * A successful result.
	 *
	 * @param mixed $value Result value.
	 */
	public static function ok( $value = null ): self {
		return new self( true, $value, array() );
	}

	/**
	 * A failed result carrying a single error.
	 *
	 * @param string               $code   Machine-readable error code.
	 * @param string|null          $field  Option key the error belongs to, if any.
	 * @param array<string, mixed> $params Values for message interpolation.
	 */
	public static function error( string $code, ?string $field = null, array $params = array() ): self {
		return new self(
			false,
			null,
			array(
				array(
					'code'   => $code,
					'field'  => $field,
					'params' => $params,
				),
			)
		);
	}

	/**
	 * A failed result carrying several errors.
	 *
	 * @param array<int, array<string, mixed>> $errors Structured errors.
	 */
	public static function errors( array $errors ): self {
		return new self( false, null, $errors );
	}

	/**
	 * Combine results, collecting every error rather than stopping at the first.
	 *
	 * Validation should tell a customer everything that is wrong in one pass;
	 * fixing one field only to discover a second is a poor experience.
	 *
	 * @param Result ...$results Results to merge.
	 */
	public static function merge( Result ...$results ): self {
		$errors = array();

		foreach ( $results as $result ) {
			if ( ! $result->is_ok() ) {
				$errors = array_merge( $errors, $result->get_errors() );
			}
		}

		return array() === $errors ? self::ok() : self::errors( $errors );
	}

	/**
	 * Whether the operation succeeded.
	 */
	public function is_ok(): bool {
		return $this->ok;
	}

	/**
	 * The value on success, or the supplied fallback on failure.
	 *
	 * @param mixed $fallback Returned when the result is an error.
	 * @return mixed
	 */
	public function value( $fallback = null ) {
		return $this->ok ? $this->value : $fallback;
	}

	/**
	 * Structured errors. Empty when the result succeeded.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function get_errors(): array {
		return $this->errors;
	}

	/**
	 * The first error code, or null when the result succeeded.
	 */
	public function first_error_code(): ?string {
		return isset( $this->errors[0]['code'] ) ? (string) $this->errors[0]['code'] : null;
	}
}
