import { sumDeltas } from '@/lib/money/line-total';
import { priceConfigDelta } from '@/lib/money/price-config-delta';
import { toPublishedPriceConfig } from '@/lib/money/to-wire-price-config';

import type { AuthoringOption, AuthoringValue } from './api';

/**
 * The worked example M20.6 asks for: what one option adds to a line.
 *
 * ## Why this module computes nothing itself
 *
 * 🔴 **Every number here comes from the SHARED evaluators.** M21.1 states the
 * rule — a preview must share the storefront's semantics, *"never a second set
 * of rules"* — and a sample total doing its own arithmetic would be exactly
 * that second set, disagreeing with the storefront precisely in the cases a
 * merchant opens the example to check. `priceConfigDelta` and `sumDeltas` are
 * the same functions the cloud and the plugin run, proven by **157 shared
 * fixture cases** executed in all three repositories (ADR-083).
 *
 * ⚠️ **No clamping, no rounding, no summing written by hand.** `sumDeltas`
 * clamps once at the end, and reproducing that here would be the easiest way to
 * get a discount wrong: clamping per value lets a large discount be followed by
 * a small surcharge and have the line rise from zero.
 */

/**
 * The base the worked example prices against.
 *
 * 🔴 **A STATED sample, not a real product's price.** Pricing against a chosen
 * product is **M21.4**, and reaching for one here would pull half that
 * milestone into this one — and leave the editor unable to show an example at
 * all for a set with no assignment yet, which is every set while it is being
 * written.
 *
 * ⚠️ **Shown beside the total, never implied.** A number a merchant mistakes
 * for "what my customer pays" is worse than no number, so the UI states the
 * base every time it states a total.
 *
 * 📌 £50.00 because percentages of it are legible: 10% is £5.00, not £4.99.
 *
 * ✏️ **Still the DEFAULT after M21.4, not a leftover.** `sampleLines` and
 * `sampleTotal` now take a base, so the live preview can pass a real product's
 * — but a set with no assignment yet, *"which is every set while it is being
 * written"*, still needs an example to show. The stated sample is what it falls
 * back to.
 */
export const SAMPLE_BASE_MINOR = 5000;

/** One priced value, what it would add, and the line it would make. */
export interface SampleLine {
  readonly id: string;
  readonly label: string;
  readonly deltaMinor: number;

  /**
   * The line total if a customer chose this value.
   *
   * 🔴 **Carried on the line rather than computed where it is shown.** The
   * display component first wrote `base + delta` inline — which is the "second
   * set of rules" M21.1 forbids, arriving by convenience rather than decision:
   * it would disagree with the storefront on any discount larger than the base,
   * because `sumDeltas` clamps and `+` does not.
   */
  readonly totalMinor: number;

  /**
   * The price type the evaluator could not resolve, or `null`.
   *
   * ⚠️ **Reported rather than shown as free.** A malformed amount silently
   * priced at zero is indistinguishable from a deliberate zero, and the
   * merchant would ship the giveaway believing they had configured a charge.
   */
  readonly unpriced: string | null;
}

/**
 * What a value would add to the sample base.
 *
 * 🔴 **`priceConfig` wins over `priceAmountMinor`.** The storefront resolves it
 * that way: a configured percentage or tier is what the merchant authored, and
 * the flat column is what the row defaults to. A worked example reading the
 * flat number while the storefront charged the percentage would be wrong in
 * exactly the case the example exists to illustrate.
 */
function deltaFor(
  value: AuthoringValue,
  baseMinor: number,
): { deltaMinor: number; unpriced: string | null } {
  /*
   * 🔴 **Converted from the STORED shape to the WIRE shape before evaluating.**
   *
   * The authoring projection sends `priceConfig` exactly as it is stored —
   * `amountMinor`, `basisPoints`, `freeCharacters`, `minQuantity` — and the
   * evaluators read the document the plugin receives, which is snake_case.
   * Passing one into the other reported *"could not be priced"* for **every**
   * correctly configured value, measured.
   *
   * ⚠️ **`toPublishedPriceConfig` is the backend's own converter**, copied
   * rather than reimplemented: it is the single answer to "what does the
   * storefront actually receive for this value", and a second answer written
   * here is precisely what M21.1 forbids.
   *
   * 📌 **The columns are the fallback, with the value's own `priceType`** — not
   * a hardcoded `'fixed'`. That is what the serializer does, so a value typed as
   * a percentage is reported as unpriceable rather than shown as a flat amount.
   */
  const wire = toPublishedPriceConfig(value.priceConfig ?? null, {
    priceType: value.priceType,
    priceAmountMinor: value.priceAmountMinor,
  });

  return priceConfigDelta(wire, baseMinor);
}

/**
 * One line per value that changes the price, in authored order.
 *
 * ⚠️ **Values worth nothing are omitted, not listed as £0.00.** An option of
 * twelve free colours would otherwise render twelve rows saying nothing, and
 * bury the one value that does carry a charge.
 */
export function sampleLines(
  option: AuthoringOption,
  baseMinor: number = SAMPLE_BASE_MINOR,
): SampleLine[] {
  return option.values
    .map((value) => ({ value, priced: deltaFor(value, baseMinor) }))
    .filter(({ priced }) => priced.deltaMinor !== 0 || priced.unpriced !== null)
    .map(({ value, priced }) => ({
      id: value.id,
      label: value.label,
      deltaMinor: priced.deltaMinor,
      totalMinor: sampleTotal(priced.deltaMinor, baseMinor),
      unpriced: priced.unpriced,
    }));
}

/**
 * The line total if a customer chose one value.
 *
 * 📌 **`sumDeltas` rather than `base + delta`** — it is the function that owns
 * clamping and the safe-integer bound, and the shared fixture proves it agrees
 * with PHP. Adding two numbers here would pass every test in this file and
 * disagree with the storefront on a discount larger than the base.
 */
export function sampleTotal(
  deltaMinor: number,
  baseMinor: number = SAMPLE_BASE_MINOR,
): number {
  return sumDeltas(baseMinor, [deltaMinor]);
}
