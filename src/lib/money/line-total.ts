/**
 * The line-total formula from `PRICING-SPEC.md` §3.
 *
 * ```text
 * line_total = max(0, base_price_minor + sum(deltas))
 * ```
 *
 * Plain functions over integer minor units, deliberately — not a `Money` class
 * mirroring the plugin's `Support\Money`.
 *
 * That class carries a `decimals` field it reads from **WooCommerce**, and the
 * cloud has no WooCommerce: all nineteen fields the plugin sends over connect
 * and heartbeat were checked, and none carries a currency or a decimal count. A
 * TypeScript `Money` would have to hardcode 2 — wrong for JPY and KWD — or
 * expose a field nothing can populate.
 *
 * Minor units need no scale to add. Scale matters only at display, which is the
 * storefront's job and already solved by `wp_localize_script`. Option prices
 * carry no currency anywhere in the schema either, so the multi-currency mixing
 * `assert_same_scale()` guards against cannot arise here. See M11.0f.
 */

/**
 * The floor, applied to a line total and never to an individual delta.
 *
 * **A single option may be negative** — that is what a discount option *is*.
 * Clamping each delta at zero would silently turn a −£50 discount into £0 and
 * charge full price, which is a different wrong answer rather than a safe one.
 *
 * @param totalMinor A line total in integer minor units, possibly negative.
 * @returns The total, or zero if it had gone below.
 */
export function clampToZero(totalMinor: number): number {
  if (!Number.isSafeInteger(totalMinor)) {
    throw new RangeError('A line total must be an integer number of minor units.');
  }

  return totalMinor < 0 ? 0 : totalMinor;
}

/**
 * A base price plus every selected delta, clamped once at the end.
 *
 * **The clamp is applied once, to the total — not at each step.** The difference
 * is real and the wrong choice is exploitable:
 *
 * ```text
 * base 3000, deltas [-5000, +400]
 *   clamped at each step : 400
 *   clamped at the end   :   0     ← normative
 * ```
 *
 * Clamping per step lets a merchant configure a large discount followed by a
 * small addition and have the line *rise* from zero — a discount that pays out.
 * Clamping once means a line that has gone negative stays there until the sum
 * finishes.
 *
 * Order within the sum is unobservable: integer addition commutes, so reversing
 * the deltas gives the same total. Only the clamp is order-sensitive, which is
 * why it is a separate function above rather than folded into the loop.
 *
 * @param baseMinor The product's own price, in integer minor units.
 * @param deltaMinor Each selected option's contribution; may be negative.
 * @returns The line total, never below zero.
 */
export function sumDeltas(baseMinor: number, deltaMinor: readonly number[]): number {
  if (!Number.isSafeInteger(baseMinor)) {
    throw new RangeError('A base price must be an integer number of minor units.');
  }

  let total = baseMinor;

  for (const delta of deltaMinor) {
    if (!Number.isSafeInteger(delta)) {
      throw new RangeError('A price delta must be an integer number of minor units.');
    }

    total += delta;

    /*
     * Checked each step rather than once at the end.
     *
     * A sum can leave the safe-integer range and come back — 2^53 + 1 - 1 is
     * 2^53, which passes a final check while having lost a unit on the way. The
     * schema caps a single amount at 1e9, so fifty maximum deltas reach 5.1e10
     * and stay exact; this guards the case where that cap is bypassed rather
     * than the case it permits.
     */
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('The line total exceeded the safe integer range.');
    }
  }

  return clampToZero(total);
}
