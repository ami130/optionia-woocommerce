<?php
/**
 * Money value object — integer minor units, never a float.
 *
 * Principle 5: this is the ONLY representation of money in the plugin. Floats
 * cannot represent 0.1 exactly, so accumulating them produces cent-level drift
 * that shows up as a customer being charged the wrong total. Conversion to and
 * from WooCommerce's decimal strings happens here, at the boundary, once.
 *
 * A CI check asserts no float cast appears in src/Engine/.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * An immutable amount in the store's currency, held as integer minor units.
 *
 * "Minor units" means the smallest indivisible unit of the currency: cents for
 * USD (2 decimals), yen for JPY (0 decimals), fils for KWD (3 decimals). The
 * decimal count is supplied by the caller rather than assumed, because
 * assuming 2 breaks both JPY and KWD.
 */
final class Money {

	/**
	 * Amount in minor units. May be negative (discount options).
	 *
	 * @var int
	 */
	private int $minor;

	/**
	 * Number of decimal places for the currency this amount is expressed in.
	 *
	 * @var int
	 */
	private int $decimals;

	/**
	 * Constructor.
	 *
	 * @param int $minor    Amount in minor units.
	 * @param int $decimals Decimal places for the currency (0, 2 or 3 in practice).
	 */
	private function __construct( int $minor, int $decimals ) {
		$this->minor    = $minor;
		$this->decimals = $decimals;
	}

	/**
	 * Build from minor units — the canonical constructor.
	 *
	 * Config documents and API payloads always carry minor units, so this is
	 * the path used almost everywhere.
	 *
	 * @param int      $minor    Amount in minor units.
	 * @param int|null $decimals Currency decimals; defaults to the store's setting.
	 */
	public static function from_minor( int $minor, ?int $decimals = null ): self {
		return new self( $minor, $decimals ?? self::store_decimals() );
	}

	/**
	 * Build a zero amount.
	 *
	 * @param int|null $decimals Currency decimals; defaults to the store's setting.
	 */
	public static function zero( ?int $decimals = null ): self {
		return new self( 0, $decimals ?? self::store_decimals() );
	}

	/**
	 * Build from a decimal string or number, as WooCommerce stores prices.
	 *
	 * Strict by design. A malformed price must not become a plausible-looking
	 * wrong number, because the result is what a customer is charged. Verified
	 * failure modes of a permissive parser:
	 *
	 *   '19,99' -> 1900     European decimal comma read as a thousands separator
	 *   '1e3'   -> 100000   scientific notation silently accepted
	 *   'abc'   -> 0        garbage becomes free
	 *
	 * Each of those is now a TypeError. Callers that legitimately handle
	 * untrusted input should use {@see self::try_from_decimal()} and decide what
	 * an unparseable value means in their context.
	 *
	 * Uses string arithmetic rather than `(float) $value * 100` so a price of
	 * "19.99" cannot become 1998 through binary rounding.
	 *
	 * @param string|int|float $amount   Decimal amount, e.g. "19.99".
	 * @param int|null         $decimals Currency decimals; defaults to store setting.
	 * @throws \InvalidArgumentException When the value is not a well-formed decimal.
	 */
	public static function from_decimal( $amount, ?int $decimals = null ): self {
		$money = self::try_from_decimal( $amount, $decimals );

		if ( null === $money ) {
			// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
			throw new \InvalidArgumentException(
				sprintf(
					'Not a well-formed decimal amount: %s.',
					is_scalar( $amount ) ? '"' . (string) $amount . '"' : gettype( $amount )
				)
			);
			// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}

		return $money;
	}

	/**
	 * Build from a decimal value, or return null when it cannot be parsed.
	 *
	 * The non-throwing counterpart to {@see self::from_decimal()}, for parsing
	 * values that may legitimately be absent or malformed — a config document
	 * from the network, or a merchant-entered field.
	 *
	 * @param string|int|float $amount   Decimal amount, e.g. "19.99".
	 * @param int|null         $decimals Currency decimals; defaults to store setting.
	 */
	public static function try_from_decimal( $amount, ?int $decimals = null ): ?self {
		$decimals = $decimals ?? self::store_decimals();

		if ( is_int( $amount ) ) {
			return new self( $amount * ( 10 ** $decimals ), $decimals );
		}

		if ( ! is_string( $amount ) && ! is_float( $amount ) ) {
			return null;
		}

		if ( is_float( $amount ) ) {
			if ( ! is_finite( $amount ) ) {
				return null;
			}

			// Render at full precision first so the string path below, not a
			// float multiplication, performs the scaling.
			$amount = number_format( $amount, $decimals + 1, '.', '' );
		}

		$candidate = trim( $amount );

		// Exactly: optional sign, digits, optional single dot and digits.
		// Deliberately rejects thousands separators, exponents, hex, whitespace
		// inside the number, and the empty string.
		if ( 1 !== preg_match( '/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/', $candidate ) ) {
			return null;
		}

		$negative  = 0 === strpos( $candidate, '-' );
		$candidate = ltrim( $candidate, '+-' );

		$parts    = explode( '.', $candidate, 2 );
		$whole    = '' === $parts[0] ? '0' : $parts[0];
		$fraction = $parts[1] ?? '';

		// Round half up at the currency's precision rather than truncating, so
		// 0.005 becomes 0.01 and not 0.00.
		$round_up = false;

		if ( strlen( $fraction ) > $decimals ) {
			$next     = (int) substr( $fraction, $decimals, 1 );
			$round_up = $next >= 5;
			$fraction = substr( $fraction, 0, $decimals );
		}

		$fraction = str_pad( $fraction, $decimals, '0' );
		$digits   = ltrim( $whole . $fraction, '0' );

		if ( '' === $digits ) {
			$digits = '0';
		}

		// Guard against silently wrapping past PHP_INT_MAX, which would turn a
		// very large price into a negative one.
		if ( ! self::fits_in_int( $digits ) ) {
			return null;
		}

		$minor = (int) $digits;

		if ( $round_up ) {
			++$minor;
		}

		return new self( $negative ? -$minor : $minor, $decimals );
	}

	/**
	 * Amount in minor units.
	 */
	public function minor(): int {
		return $this->minor;
	}

	/**
	 * Currency decimal places for this amount.
	 */
	public function decimals(): int {
		return $this->decimals;
	}

	/**
	 * Decimal string suitable for handing back to WooCommerce.
	 *
	 * Returned as a string, not a float, so the caller cannot reintroduce
	 * floating-point error downstream.
	 */
	public function to_decimal_string(): string {
		$sign = $this->minor < 0 ? '-' : '';
		$abs  = (string) abs( $this->minor );

		if ( 0 === $this->decimals ) {
			return $sign . $abs;
		}

		$abs      = str_pad( $abs, $this->decimals + 1, '0', STR_PAD_LEFT );
		$whole    = substr( $abs, 0, -$this->decimals );
		$fraction = substr( $abs, -$this->decimals );

		return $sign . $whole . '.' . $fraction;
	}

	/**
	 * Add another amount.
	 *
	 * @param Money $other Amount to add.
	 * @throws \InvalidArgumentException When decimal scales differ.
	 * @throws \RangeException When the result overflows the integer range.
	 */
	public function plus( Money $other ): self {
		$this->assert_same_scale( $other );
		self::assert_in_range( (float) $this->minor + (float) $other->minor );

		return new self( $this->minor + $other->minor, $this->decimals );
	}

	/**
	 * Subtract another amount.
	 *
	 * @param Money $other Amount to subtract.
	 * @throws \InvalidArgumentException When decimal scales differ.
	 * @throws \RangeException When the result overflows the integer range.
	 */
	public function minus( Money $other ): self {
		$this->assert_same_scale( $other );
		self::assert_in_range( (float) $this->minor - (float) $other->minor );

		return new self( $this->minor - $other->minor, $this->decimals );
	}

	/**
	 * Multiply by an integer factor — quantity, character count, unit count.
	 *
	 * @param int $factor Integer multiplier.
	 * @throws \RangeException When the result overflows the integer range.
	 */
	public function times( int $factor ): self {
		self::assert_in_range( (float) $this->minor * (float) $factor );

		return new self( $this->minor * $factor, $this->decimals );
	}

	/**
	 * Take a percentage of this amount, rounding half up.
	 *
	 * Half-up matches WooCommerce's own rounding, so an Optionia total agrees
	 * with a WooCommerce total computed the same way. The intermediate is kept
	 * in integer space: minor * basis_points / 10000.
	 *
	 * @param int $basis_points Percentage in basis points (1000 = 10%).
	 * @throws \RangeException When the intermediate overflows the integer range.
	 */
	public function percentage( int $basis_points ): self {
		self::assert_in_range( (float) $this->minor * (float) $basis_points );

		$numerator = $this->minor * $basis_points;
		$divisor   = 10000;

		$quotient  = intdiv( abs( $numerator ), $divisor );
		$remainder = abs( $numerator ) % $divisor;

		// Round half up on the absolute value, then reapply the sign, so that
		// -0.5 and +0.5 round symmetrically away from zero.
		if ( $remainder * 2 >= $divisor ) {
			++$quotient;
		}

		$sign = $numerator < 0 ? -1 : 1;

		return new self( $sign * $quotient, $this->decimals );
	}

	/**
	 * True when the amount is exactly zero.
	 */
	public function is_zero(): bool {
		return 0 === $this->minor;
	}

	/**
	 * True when the amount is below zero.
	 */
	public function is_negative(): bool {
		return $this->minor < 0;
	}

	/**
	 * Value equality, including scale.
	 *
	 * @param Money $other Amount to compare.
	 */
	public function equals( Money $other ): bool {
		return $this->minor === $other->minor && $this->decimals === $other->decimals;
	}

	/**
	 * Decimal places configured for the store, defaulting to 2 outside WooCommerce.
	 */
	private static function store_decimals(): int {
		return function_exists( 'wc_get_price_decimals' ) ? (int) wc_get_price_decimals() : 2;
	}

	/**
	 * Whether a digit string fits in a PHP integer.
	 *
	 * PHP wraps silently past PHP_INT_MAX, which would turn a very large price
	 * into a negative one. Compared as strings to avoid the very overflow being
	 * guarded against.
	 *
	 * @param string $digits Digits only, no sign.
	 */
	private static function fits_in_int( string $digits ): bool {
		$max = (string) PHP_INT_MAX;

		if ( strlen( $digits ) !== strlen( $max ) ) {
			return strlen( $digits ) < strlen( $max );
		}

		return strcmp( $digits, $max ) <= 0;
	}

	/**
	 * Guard an arithmetic result against integer overflow.
	 *
	 * @param float $exact Result computed in float space, for range checking only.
	 * @throws \RangeException When the result cannot be represented exactly.
	 */
	private static function assert_in_range( float $exact ): void {
		if ( abs( $exact ) <= (float) PHP_INT_MAX ) {
			return;
		}

		// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
		throw new \RangeException(
			'Money arithmetic overflowed the platform integer range.'
		);
		// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
	}

	/**
	 * Guard against combining amounts of different scale.
	 *
	 * @param Money $other Amount being combined.
	 * @throws \InvalidArgumentException When the scales differ.
	 */
	private function assert_same_scale( Money $other ): void {
		if ( $this->decimals !== $other->decimals ) {
			// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
			throw new \InvalidArgumentException(
				sprintf(
					'Cannot combine Money with %d decimals and Money with %d decimals.',
					$this->decimals,
					$other->decimals
				)
			);
			// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
	}
}
