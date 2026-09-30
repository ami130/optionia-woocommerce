/**
 * Yearly discounts, expressed as an authoring input rather than a stored field.
 *
 * ## Why a discount is not a column on `plan_prices`
 *
 * 🔴 **`amountMinor` must equal what the provider charges, exactly.**
 * `provider-prices.ts` reconciles every local row against Stripe and refuses any
 * disagreement by name — `amount 2900 at provider vs 2320 locally`. A
 * `discountBasisPoints` column sitting beside `amountMinor` would make the
 * charged figure a computation rather than a fact, and every reconciliation run
 * would either fail or have to learn to re-derive it. One price row, one Stripe
 * price, one invoice line.
 *
 * 📌 **So a discount PRODUCES a price.** Staff say "20% off the list price"; the
 * system computes the figure, writes a new row at that amount and retires the
 * previous one — which is precisely the supersession the schema already
 * performs, and what a real price change is. A merchant already subscribed keeps
 * the row they bought, because that is what `planPriceId` pins.
 *
 * ⚠️ **The list price is therefore not lost.** `plans.priceYearlyMinor` remains
 * the declared list figure, so a pricing page can show "was £290, now £232" from
 * two numbers that both exist — rather than reconstructing the original by
 * dividing, which is where a rounded discount stops round-tripping.
 */

import { percentageOf } from '../common/money/percentage';

/** 100% in basis points. Not reachable — see {@link MAX_DISCOUNT_BASIS_POINTS}. */
const FULL_DISCOUNT_BASIS_POINTS = 10_000;

/**
 * The largest discount staff may apply: 99.99%, one basis point short of free.
 *
 * 🔴 **A full discount on a PAID plan is refused, and that is a product
 * decision rather than a technical limit.** Free access already has a home —
 * the Free plan, which provisions with `provider: 'none'` and no provider
 * subscription at all. A £0 Pro price would create a SECOND way to be free: one
 * that still holds a live subscription, still renews, and still appears in
 * billing reports as a paying customer worth nothing.
 *
 * ⚠️ **It is also the likeliest typo to be catastrophic.** Someone meaning 10%
 * who types basis points wrong lands on 10000, and the difference between "90%
 * off" and "free forever" is one keystroke. Every other wrong figure costs
 * revenue proportionally; this one costs all of it.
 *
 * 📌 Whoever genuinely wants a merchant on free moves them to the Free plan,
 * which is the supported path and leaves an audit trail saying so.
 */
export const MAX_DISCOUNT_BASIS_POINTS = FULL_DISCOUNT_BASIS_POINTS - 1;

/**
 * The outcome of applying a discount to a list price.
 *
 * 📌 Carries BOTH figures. The caller needs the discounted amount to write a
 * price row and the list amount to show what it was reduced from, and deriving
 * either from the other after rounding does not reliably return the original.
 */
export interface DiscountedPrice {
  /** The undiscounted figure, in minor units. */
  readonly listMinor: number;
  /** What the merchant is actually charged, in minor units. */
  readonly amountMinor: number;
  /** The reduction applied, in minor units. Always `listMinor − amountMinor`. */
  readonly savingMinor: number;
  /** The discount that produced this, in basis points. */
  readonly basisPoints: number;
}

/**
 * Apply a percentage discount to a list price.
 *
 * 🔴 **Rounds through `percentageOf`, never with its own arithmetic.** That
 * function implements `PRICING-SPEC.md` §4 — half up, away from zero, in integer
 * space — and is proven against the PHP evaluator by shared fixtures. A second
 * rounding rule in the billing path is how a figure starts disagreeing with the
 * one a merchant was shown.
 *
 * ⚠️ **The SAVING is rounded, and the charge is derived from it.** Rounding the
 * charged amount directly would let `amountMinor + savingMinor` differ from
 * `listMinor` by a unit, so a receipt reading "£290.00 − £58.00 = £232.01" could
 * be produced. Deriving one from the other makes the three figures consistent by
 * construction.
 *
 * @throws RangeError if the inputs are not whole, non-negative and in range.
 */
export function applyDiscount(
  listMinor: number,
  basisPoints: number,
): DiscountedPrice {
  if (!Number.isSafeInteger(listMinor) || listMinor < 0) {
    throw new RangeError('A list price is a non-negative whole number of minor units.');
  }

  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError('A discount is a non-negative whole number of basis points.');
  }

  /*
   * ⚠️ **Refused rather than clamped.** Clamping would silently charge a figure
   * nobody chose for a number someone typed by mistake — and a staff member
   * meaning 15% who reaches for basis points is the likely author of `15000`.
   */
  if (basisPoints > MAX_DISCOUNT_BASIS_POINTS) {
    throw new RangeError(
      basisPoints >= FULL_DISCOUNT_BASIS_POINTS
        ? 'A paid plan cannot be discounted to nothing. Move the merchant to the Free plan instead.'
        : `A discount cannot exceed ${MAX_DISCOUNT_BASIS_POINTS} basis points.`,
    );
  }

  const savingMinor = percentageOf(listMinor, basisPoints);

  return {
    listMinor,
    amountMinor: listMinor - savingMinor,
    savingMinor,
    basisPoints,
  };
}

/**
 * The discount implied by a charged amount against its list price.
 *
 * 📌 **For DISPLAY, never for billing.** A pricing page that stores a discounted
 * amount still wants to print "20% off", and this recovers the figure.
 *
 * ⚠️ **Not a round trip.** `impliedDiscount(applyDiscount(x, bp))` may differ
 * from `bp` by a basis point, because the saving was rounded to whole minor
 * units on the way in and the information is genuinely gone. Callers that need
 * the authored figure exactly must store it; this is an approximation and says
 * so rather than pretending otherwise.
 */
export function impliedDiscount(listMinor: number, amountMinor: number): number {
  if (!Number.isSafeInteger(listMinor) || listMinor <= 0) return 0;
  if (!Number.isSafeInteger(amountMinor) || amountMinor >= listMinor) return 0;

  return Math.round(
    ((listMinor - amountMinor) * MAX_DISCOUNT_BASIS_POINTS) / listMinor,
  );
}
