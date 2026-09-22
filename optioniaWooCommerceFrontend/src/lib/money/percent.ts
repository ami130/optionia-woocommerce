/**
 * Percentages, as a merchant types them and the API stores them.
 *
 * ## Basis points, never a float
 *
 * 🔴 **The same rule money follows, for the same reason.** `250` is 2.5%, and
 * `0.1 + 0.2 !== 0.3` in binary floating point — a percentage that drifts
 * produces a different total on two machines, which is the class of defect
 * ADR-013 settled for money and this mirrors for percentages. The API's
 * `percentageBasisPoints` refuses anything but an integer.
 *
 * ⚠️ **A merchant types "2.5", not "250".** Basis points are the storage unit,
 * not a thing to ask anyone to think in. The conversion lives here, at the one
 * boundary, rather than in a form that would learn it twice.
 *
 * 📌 **Parsed, never `Number()`.** `Number('1e3')` is 1000 and `Number('')` is
 * 0 — a blank field would silently become "no change" and an exponent would
 * become a price nobody typed.
 */

/**
 * The largest percentage the API accepts, in basis points: 1000%.
 *
 * ⚠️ **Mirrors `percentageBasisPoints` in `pricing.schema.ts`.** Duplicated so
 * the form can refuse before the wire rather than after a 400 — and the bound
 * is a plausibility ceiling, not a technical one: beyond it is a merchant who
 * typed basis points into a percent field.
 */
export const MAX_BASIS_POINTS = 100_000;

/** Digits of a percent one basis point can express. */
const PERCENT_DECIMALS = 2;

/**
 * Optional sign, digits, optional dot and **at most two** decimals.
 *
 * The decimal cap is the point: 2.555% is not expressible in basis points, and
 * rounding it silently would charge a percentage the merchant did not type.
 */
const PERCENT_PATTERN = /^[+-]?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;

export type PercentParse =
  | { ok: true; basisPoints: number }
  | { ok: false; reason: 'malformed' | 'too-large' };

/**
 * Parse what a merchant typed into basis points.
 *
 * Returns a result rather than throwing: a half-typed percentage is the
 * ordinary state of an input, not an exception.
 */
export function parsePercent(input: string): PercentParse {
  const candidate = input.trim();

  if (!PERCENT_PATTERN.test(candidate)) {
    return { ok: false, reason: 'malformed' };
  }

  const negative = candidate.startsWith('-');
  const unsigned = candidate.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');

  /*
   * **Assembled from the digits rather than multiplied.**
   *
   * The imprecision is real — `0.07 * 100` is `7.000000000000001`, and four
   * more values below 1% behave the same way. But `Math.round` corrects every
   * one of them, so this is a matter of *not relying on a correction*, not a
   * behavioural difference.
   *
   * ⚠️ **Recorded as an EQUIVALENT MUTANT (M184).** Replacing this with
   * `Math.round(Number(unsigned) * 100)` passes every test, and that is
   * correct: checked exhaustively across all 100,001 values the pattern admits,
   * the two agree everywhere. No test can distinguish them, and writing one
   * that appeared to would be asserting a difference that does not exist.
   */
  const points = Number(`${whole}${fraction.padEnd(PERCENT_DECIMALS, '0')}`);

  if (!Number.isSafeInteger(points) || points > MAX_BASIS_POINTS) {
    return { ok: false, reason: 'too-large' };
  }

  return { ok: true, basisPoints: negative ? -points : points };
}

/**
 * Show basis points as a merchant would write them.
 *
 * 📌 **Trailing zeros are dropped**, so a stored `1000` reads as "10" rather
 * than "10.00" — and round-trips: editing a value and saving it unchanged must
 * not rewrite what is stored.
 */
export function formatBasisPoints(basisPoints: number): string {
  const negative = basisPoints < 0;
  const digits = String(Math.abs(basisPoints)).padStart(PERCENT_DECIMALS + 1, '0');
  const whole = digits.slice(0, -PERCENT_DECIMALS);
  const fraction = digits.slice(-PERCENT_DECIMALS).replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}
