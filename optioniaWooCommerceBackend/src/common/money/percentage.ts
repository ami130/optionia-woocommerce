/**
 * A percentage of an integer minor amount, rounded as `PRICING-SPEC.md` §4 requires.
 *
 * ## Why this is not `Math.round`
 *
 * The specification says **half up, away from zero**, and the qualifier is the
 * whole point. `Math.round` rounds toward positive infinity: it agrees with PHP
 * on every positive tie and disagrees on every negative one.
 *
 * ```text
 *   exact    PHP    Math.round
 *    -0.5     -1        0
 *    -1.5     -2       -1
 *    -2.5     -3       -2
 * ```
 *
 * A 5% discount on 30 minor units is −2 in the plugin and −1 here if this used
 * `Math.round` — a penny between what a merchant is shown while authoring and
 * what a customer is charged. Measured before either evaluator existed; the
 * negative cases in `pricing-fixtures.json` are what keep it measured.
 *
 * ## Why integer arithmetic throughout
 *
 * `minor * basisPoints / 10000` in floating point drifts, and a total that
 * drifts differs between two machines computing the same order. The quotient and
 * remainder are taken in integer space and the tie is decided by comparing the
 * remainder against half the divisor — the same shape as `Support\Money` in the
 * plugin, deliberately, so the two are readable side by side.
 */

/** Basis points per whole unit: 10000 bp = 100%. */
const BASIS_POINTS_DIVISOR = 10000;

/**
 * Take a percentage of an amount in minor units.
 *
 * @param minor Amount in the currency's smallest unit; never a float.
 * @param basisPoints Percentage in basis points — 250 is 2.5%, −500 is −5%.
 * @returns The percentage, in minor units, rounded half up away from zero.
 */
export function percentageOf(minor: number, basisPoints: number): number {
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(basisPoints)) {
    throw new RangeError('Money arithmetic takes integer minor units and integer basis points.');
  }

  const numerator = minor * basisPoints;

  if (!Number.isSafeInteger(numerator)) {
    // Beyond this the intermediate itself is approximate, and an approximate
    // intermediate is how a total starts disagreeing between two machines.
    throw new RangeError('Percentage intermediate exceeds the safe integer range.');
  }

  const magnitude = Math.abs(numerator);
  const quotient = Math.floor(magnitude / BASIS_POINTS_DIVISOR);
  const remainder = magnitude % BASIS_POINTS_DIVISOR;

  // Rounded on the absolute value, then the sign reapplied, so −0.5 and +0.5
  // round symmetrically away from zero rather than both toward +∞.
  const rounded = remainder * 2 >= BASIS_POINTS_DIVISOR ? quotient + 1 : quotient;

  return numerator < 0 ? -rounded : rounded;
}
