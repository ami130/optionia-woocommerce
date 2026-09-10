<?php
/**
 * The one normative line-total evaluation (M11.2, `fixed` plus the floor).
 *
 * ## Why this is arithmetic and not `(config, selections, ...)`
 *
 * M11.2 words the evaluator as a pure function
 * `(config, selections, base_price, quantity) -> price_delta + breakdown`.
 * This file implements the inner half of that: the arithmetic over a base and a
 * list of deltas. The outer half — turning `config` and `selections` into that
 * list — is **M11.5's**, which already owns "accept only selection keys; reject
 * unknown option or value keys; reject options not applicable to this product;
 * enforce required; enforce validation rules; recompute price from cached
 * config". Resolution is that milestone's subject, and writing it here would
 * mean writing it twice and having two answers to the same question.
 *
 * M11.4 corroborates the split: every case it enumerates — each pricing type
 * alone, combinations, zero and negative deltas, rounding boundaries, large
 * quantities, percentage-of-percentage, JPY and KWD — is arithmetic. Even
 * "empty selections" is stated as an empty delta list rather than as a
 * selection naming an option that does not exist.
 *
 * So the shared fixture stays a table of numbers. See M11.5 in the plan for the
 * façade that composes over this.
 *
 * ## Why plain functions over integer minor units, not `Support\Money`
 *
 * `Money` carries a `decimals` field and asserts both operands share a scale.
 * That is right for money the storefront will format and wrong here: minor
 * units need no scale to add, deltas carry no currency anywhere in the schema,
 * and the cloud's mirror of this file has no WooCommerce to ask for a decimal
 * count. Scale matters at display, which `wp_localize_script` already handles.
 *
 * The one thing `Money` provides that is wanted here — an overflow floor — is
 * reproduced below, deliberately at a *different* threshold. See `MAX_MINOR`.
 *
 * ## The cross-language contract
 *
 * `PRICING-SPEC.md` is normative for this file and for
 * `src/common/money/line-total.ts` in the cloud. Both read the same
 * `pricing-fixtures.json`, and `bin/check-shared-fixtures.sh` fails if either
 * stops executing it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Engine;

defined( 'ABSPATH' ) || exit;

/**
 * The line-total formula from `PRICING-SPEC.md` §3.
 *
 * ```text
 * line_total = max(0, base_price_minor + sum(deltas))
 * ```
 */
final class Pricing {

	/**
	 * The largest magnitude either language will evaluate: 2^53 - 1.
	 *
	 * **This is JavaScript's limit, adopted here on purpose.** PHP integers are
	 * 64-bit, so `Support\Money` refuses above `PHP_INT_MAX` — about 9.2e18.
	 * TypeScript refuses above `Number.MAX_SAFE_INTEGER` — about 9.0e15. That is
	 * a thousand-fold gap, and inside it the storefront computes a total the
	 * cloud declines to compute: the two sides disagree about whether a cart is
	 * even representable, which is worse than either answer alone.
	 *
	 * A cross-language contract can only promise what both sides can keep, so
	 * the stricter floor is the shared one. The schema caps a single amount at
	 * 1e9 and AUTHORING_LIMITS caps a set at 20,000 options, so the reachable
	 * maximum is 2.0e13 — roughly 450 times under this bound. Nothing legitimate
	 * approaches it; this guards the case where those caps are bypassed.
	 *
	 * PHP's own failure mode is why the check cannot be skipped: past
	 * `PHP_INT_MAX` an integer silently becomes a float, and `is_int()` turns
	 * false on a value that still prints like a number.
	 */
	public const MAX_MINOR = 9007199254740991;

	/**
	 * Not instantiable — this is a namespace for two functions.
	 */
	private function __construct() {
	}

	/**
	 * The floor, applied to a line total and never to an individual delta.
	 *
	 * **A single option may be negative** — that is what a discount option *is*.
	 * Clamping each delta at zero would silently turn a −£50 discount into £0
	 * and charge full price, which is a different wrong answer rather than a
	 * safe one.
	 *
	 * @param mixed $total_minor A line total in integer minor units, possibly negative.
	 * @return int The total, or zero if it had gone below.
	 * @throws \InvalidArgumentException When the total is not an integer.
	 * @throws \RangeException When the total is outside the shared safe range.
	 */
	public static function clamp_to_zero( $total_minor ): int {
		self::assert_integer( $total_minor, 'A line total' );
		self::assert_in_range( $total_minor, 'A line total' );

		return $total_minor < 0 ? 0 : $total_minor;
	}

	/**
	 * A base price plus every selected delta, clamped once at the end.
	 *
	 * **The clamp is applied once, to the total — not at each step.** The
	 * difference is real and the wrong choice is exploitable:
	 *
	 * ```text
	 * base 3000, deltas [-5000, +400]
	 *   clamped at each step : 400
	 *   clamped at the end   :   0     <- normative
	 * ```
	 *
	 * Clamping per step lets a merchant configure a large discount followed by a
	 * small addition and have the line *rise* from zero — a discount that pays
	 * out. Clamping once means a line that has gone negative stays there until
	 * the sum finishes.
	 *
	 * Order within the sum is unobservable: integer addition commutes, so
	 * reversing the deltas gives the same total. Only the clamp is
	 * order-sensitive, which is why it is a separate method rather than folded
	 * into the loop.
	 *
	 * `$base_minor` is deliberately untyped in the signature. See
	 * `assert_integer()` -- an `int` hint is a coercion, not a guard, whenever
	 * the caller is not itself `strict_types`, and WooCommerce is not.
	 *
	 * @param mixed      $base_minor  The product's own price, in integer minor units.
	 * @param array<int> $delta_minor Each selected option's contribution; may be negative.
	 * @return int The line total, never below zero.
	 * @throws \InvalidArgumentException When any input is not an integer.
	 * @throws \RangeException When any input or the running sum leaves the shared safe range.
	 */
	public static function sum_deltas( $base_minor, array $delta_minor ): int {
		self::assert_integer( $base_minor, 'A base price' );
		self::assert_in_range( $base_minor, 'A base price' );

		$total = $base_minor;

		foreach ( $delta_minor as $delta ) {
			self::assert_integer( $delta, 'A price delta' );
			self::assert_in_range( $delta, 'A price delta' );

			/*
			 * Summed as floats first, then as integers.
			 *
			 * PHP has no `Number.isSafeInteger`: past `PHP_INT_MAX` the addition
			 * itself produces a float, so checking the result would mean checking
			 * a value the overflow has already corrupted. The float sum is exact
			 * for every magnitude this bound permits — 2^53 is precisely where
			 * doubles stop being exact over integers — so it can be tested before
			 * the integer addition commits.
			 */
			self::assert_in_range( (float) $total + (float) $delta, 'The line total' );  // overflow-guard.

			$total += $delta;
		}

		return self::clamp_to_zero( $total );
	}

	/**
	 * A percentage of a base, in integer minor units.
	 *
	 * `basis_points` because a percentage is not expressible in integers: 12.5%
	 * has no integer form, and storing `12.5` as a float reintroduces exactly the
	 * imprecision minor units exist to avoid. 12.5% is `1250`.
	 *
	 * ## Rounding is half up AWAY FROM ZERO, and that is the whole difficulty
	 *
	 * PHP's `round()` and JavaScript's `Math.round` agree on every positive tie
	 * and disagree on every negative one -- `Math.round(-2.5)` is `-2`, while
	 * away-from-zero gives `-3`. A discount configured as a negative percentage
	 * therefore lands on the tie that diverges, and the two implementations would
	 * disagree by one minor unit on real merchant configurations while both
	 * looked correct.
	 *
	 * So the sign is stripped, the magnitude is rounded, and the sign is
	 * reapplied. `intdiv()` truncates toward zero, which on a non-negative
	 * numerator is floor, so `remainder * 2 >= divisor` is the tie test.
	 *
	 * This duplicates `Support\Money::percentage()` deliberately. `Money` asserts
	 * a shared `decimals` scale, and a *delta* has no currency anywhere in the
	 * schema -- the same reason this file uses plain integers throughout, argued
	 * at the top. Both are held to `rounding_cases` in the shared fixture, so the
	 * duplication cannot drift silently.
	 *
	 * @param mixed $base_minor   The amount to take a percentage of, in minor units.
	 * @param mixed $basis_points Hundredths of a percent; may be negative.
	 * @return int The percentage, in minor units, possibly negative.
	 * @throws \InvalidArgumentException When either input is not an integer.
	 * @throws \RangeException When an input or the product leaves the shared safe range.
	 */
	public static function percentage_of( $base_minor, $basis_points ): int {
		self::assert_integer( $base_minor, 'A base price' );
		self::assert_in_range( $base_minor, 'A base price' );
		self::assert_integer( $basis_points, 'A basis-point rate' );
		self::assert_in_range( $basis_points, 'A basis-point rate' );

		/*
		 * The PRODUCT is checked, not the result.
		 *
		 * Both operands can sit inside the safe range while `base * rate`
		 * overflows -- 10^9 minor units at 10^6 basis points is 10^15, which is
		 * inside 2^53, but an order of magnitude more on either side is not. Past
		 * that point the multiplication has already produced a float, so checking
		 * afterwards checks a corrupted value. Same reasoning as the overflow
		 * guard in `sum_deltas()`.
		 */
		self::assert_in_range( (float) $base_minor * (float) $basis_points, 'A percentage' );  // overflow-guard.

		$numerator = $base_minor * $basis_points;
		$divisor   = 10000;

		$quotient  = intdiv( abs( $numerator ), $divisor );
		$remainder = abs( $numerator ) % $divisor;

		if ( $remainder * 2 >= $divisor ) {
			++$quotient;
		}

		return ( $numerator < 0 ? -1 : 1 ) * $quotient;
	}

	/**
	 * An amount per unit, for a quantity the customer supplied.
	 *
	 * ```text
	 * delta = round(max(0, quantity) * amount_minor)
	 * ```
	 *
	 * ## The quantity is a FLOAT here, and that is deliberate
	 *
	 * Every other function in this file refuses a non-integer, because money in
	 * minor units is an integer and a float amount is the imprecision this file
	 * exists to prevent. A **quantity** is not money: "1.5 metres" is a real
	 * measurement, and refusing it would make the number option types unpriceable
	 * for anything measured.
	 *
	 * The float never reaches a total. It is multiplied by an integer amount and
	 * the **product is rounded immediately**, so what leaves this function is an
	 * integer number of minor units like every other delta. `sum_deltas()` still
	 * sees only integers.
	 *
	 * ## The floor is on the QUANTITY, not the delta
	 *
	 * `max(0, ...)` wraps the quantity. A customer submitting `-5` would
	 * otherwise produce a negative delta -- a discount for asking for less than
	 * nothing, farmable by anyone who can type a minus sign into a number field
	 * the merchant left unbounded.
	 *
	 * The floor cannot move to the delta: `amount_minor` may legitimately be
	 * negative, which is how a discount option is expressed, and `max(0, delta)`
	 * would silently discard every one of them. Same rule, same reason, as
	 * `per_char`'s character-count floor.
	 *
	 * ## Rounding is half up AWAY FROM ZERO
	 *
	 * The shared rule from `PRICING-SPEC.md` §4, for the same reason percentages
	 * use it: PHP's `round()` and JavaScript's `Math.round` agree on every
	 * positive tie and disagree on every negative one, so an implementation using
	 * either language's default would disagree by a minor unit on a real order.
	 *
	 * @param mixed $amount_minor The per-unit amount, in integer minor units.
	 * @param mixed $quantity     The customer's quantity; may be fractional.
	 * @return int Minor units, possibly negative.
	 * @throws \InvalidArgumentException When the amount is not an integer, or the quantity not a number.
	 * @throws \RangeException When an input or the product leaves the shared safe range.
	 */
	public static function per_unit_of( $amount_minor, $quantity ): int {
		self::assert_integer( $amount_minor, 'A per-unit amount' );
		self::assert_in_range( $amount_minor, 'A per-unit amount' );

		if ( ! is_int( $quantity ) && ! is_float( $quantity ) ) {
			throw new \InvalidArgumentException( 'A quantity must be a number.' );
		}

		if ( is_float( $quantity ) && ! is_finite( $quantity ) ) {
			throw new \RangeException( 'A quantity must be finite.' );
		}

		$units = (float) $quantity;  // quantity-not-money: the working value, rounded below.

		if ( $units <= 0.0 ) {
			return 0;
		}

		self::assert_in_range( $units, 'A quantity' );

		/*
		 * The PRODUCT is checked before it is rounded.
		 *
		 * A number option's answer has no length ceiling the way text does -- a
		 * customer can submit `1e20` where the merchant configured no `max` --
		 * and at the schema's maximum amount a quantity near nine million already
		 * leaves the safe range. Checking afterwards checks a value the overflow
		 * has corrupted, which is the lesson `sum_deltas()` and `percentage_of()`
		 * both record.
		 */
		$product = $units * (float) $amount_minor;  // quantity-not-money: rounded on the next statement.

		self::assert_in_range( $product, 'A per-unit product' );  // overflow-guard.

		$magnitude = abs( $product );
		$rounded   = (int) floor( $magnitude );

		// Half up on the absolute value, then the sign reapplied -- so -0.5 and
		// +0.5 round symmetrically away from zero rather than both toward +inf.
		if ( ( $magnitude - (float) $rounded ) >= 0.5 ) {
			++$rounded;
		}

		return $product < 0.0 ? -$rounded : $rounded;
	}

	/**
	 * Refuse a multiplication whose product would leave the safe range.
	 *
	 * Both operands can sit comfortably inside the bound while their product
	 * does not, and past that point the multiplication has already produced a
	 * float -- so checking the result checks a value the overflow has already
	 * corrupted. The float product is exact for every magnitude this bound
	 * permits, because 2^53 is precisely where doubles stop being exact over
	 * integers, so it can be tested before the integer multiplication commits.
	 *
	 * The same guard `percentage_of()` applies inline. Exposed here because
	 * `per_char` needs it too, and its operands are worse: the API caps the
	 * amount, but the **customer** supplies the character count.
	 *
	 * @param mixed $left  One operand, in integer minor units or a plain count.
	 * @param mixed $right The other operand.
	 * @throws \InvalidArgumentException When either operand is not an integer.
	 * @throws \RangeException When an operand or the product leaves the safe range.
	 */
	public static function assert_multiplication_in_range( $left, $right ): void {
		self::assert_integer( $left, 'A multiplicand' );
		self::assert_in_range( $left, 'A multiplicand' );
		self::assert_integer( $right, 'A multiplicand' );
		self::assert_in_range( $right, 'A multiplicand' );

		self::assert_in_range( (float) $left * (float) $right, 'A product' );  // overflow-guard.
	}

	/**
	 * Refuse anything that is not already an integer.
	 *
	 * **An `int` type hint would not do this.** PHP's coercive mode -- the
	 * default -- converts on the way in, and `strict_types=1` binds the file
	 * making the call, never the file receiving it. Every one of this plugin's
	 * 45 source files declares it, so every call site today is safe; WordPress
	 * and WooCommerce declare it nowhere, and `WC_Product::get_price()` returns
	 * the **string** `"10.50"`. Hinted `int`, that arrives as `10`: a price
	 * quietly truncated by 50 minor units, with no error anywhere.
	 *
	 * M11.5 hooks `woocommerce_add_to_cart_validation`, which WooCommerce
	 * invokes -- so the guard has to hold for a caller that is not ours. The
	 * parameters are therefore untyped and checked here instead.
	 *
	 * The cloud has no equivalent problem and needs no equivalent code:
	 * `Number.isSafeInteger` already rejects `10.5`, `"10.50"`, `NaN` and
	 * `Infinity` alike. This method is what makes the two sides refuse the same
	 * inputs, not merely the same magnitudes.
	 *
	 * @param mixed  $value   The amount to test.
	 * @param string $subject What the amount is, for the message.
	 * @throws \InvalidArgumentException When the value is not an integer.
	 */
	private static function assert_integer( $value, string $subject ): void {
		if ( is_int( $value ) ) {
			return;
		}

		// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
		throw new \InvalidArgumentException(
			$subject . ' must be an integer number of minor units, not ' . gettype( $value ) . '.'
		);
		// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
	}

	/**
	 * Refuse a magnitude neither language can carry exactly.
	 *
	 * Checked each step rather than once at the end. A sum can leave the safe
	 * range and come back — 2^53 + 1 - 1 is 2^53, which passes a final check
	 * while having lost a unit on the way.
	 *
	 * @param int|float $value   The amount to test.
	 * @param string    $subject What the amount is, for the message.
	 * @throws \RangeException When the magnitude exceeds `MAX_MINOR`.
	 */
	private static function assert_in_range( $value, string $subject ): void {
		if ( abs( (float) $value ) <= (float) self::MAX_MINOR ) {  // overflow-guard.
			return;
		}

		// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Developer-facing message, never rendered to a page.
		throw new \RangeException(
			$subject . ' must be an integer number of minor units within the shared safe range.'
		);
		// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
	}
}
