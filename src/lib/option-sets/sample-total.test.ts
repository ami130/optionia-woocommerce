import { describe, expect, it } from 'vitest';

import type { AuthoringOption, AuthoringValue } from './api';
import { sampleLines, sampleTotal, SAMPLE_BASE_MINOR } from './sample-total';

/**
 * The worked example M20.6 asks for: a computed sample total.
 *
 * 🔴 **Computed by the SHARED evaluators, never by arithmetic written here.**
 * M21.1 states the rule — the preview must share the storefront's semantics,
 * *"never a second set of rules"* — and a sample total that added up its own
 * numbers would be exactly that second set, disagreeing with the storefront in
 * the cases a merchant is checking. `priceConfigDelta` and `sumDeltas` are the
 * same functions the cloud and the plugin run, proven by 157 shared cases.
 *
 * ⚠️ **A STATED sample base, not a real product's price.** Pricing against a
 * chosen product is M21.4, and reaching for one here would put half of that
 * milestone in this one and leave the editor lying when no product is assigned.
 * The base is shown beside the total so the number is never mistaken for what a
 * specific customer would pay.
 */
const value = (over: Partial<AuthoringValue> = {}): AuthoringValue => ({
  id: 'v1',
  valueKey: 'matte',
  label: 'Matte',
  sortOrder: 0,
  priceType: 'fixed',
  priceAmountMinor: 0,
  ...over,
});

const option = (values: AuthoringValue[]): AuthoringOption =>
  ({ id: 'o1', label: 'Finish', presentation: 'dropdown', values }) as AuthoringOption;

describe('sampleLines', () => {
  it('has no lines when an option has no priced values', () => {
    expect(sampleLines(option([value()]))).toEqual([]);
  });

  it('reports a flat surcharge from priceAmountMinor', () => {
    const [line] = sampleLines(option([value({ priceAmountMinor: 500 })]));

    expect(line?.deltaMinor).toBe(500);
    expect(line?.label).toBe('Matte');
  });

  /**
   * 🔴 **The STORED shape is what the API actually sends, and it is camelCase.**
   *
   * Measured before this was fixed: `{type:'percentage', basisPoints:1000}` —
   * the shape `pricing.schema.ts` validates and the authoring projection sends
   * **verbatim** — produced `delta=0 unpriced=percentage`. Every correctly
   * configured value rendered a red *"could not be priced"* in the editor.
   *
   * ⚠️ **The earlier tests in this file passed because they were written in
   * WIRE shape**, matching the shared fixture. The fixture is wire-shaped on
   * purpose — it is what both evaluators receive — so it proves the evaluator
   * and says nothing about a caller handing it the wrong dialect.
   */
  it('prices a stored camelCase percentage', () => {
    const [line] = sampleLines(
      option([value({ priceConfig: { type: 'percentage', basisPoints: 1000 } })]),
    );

    expect(line?.unpriced).toBeNull();
    expect(line?.deltaMinor).toBe(SAMPLE_BASE_MINOR / 10);
  });

  it('prices a stored camelCase fixed amount', () => {
    const [line] = sampleLines(
      option([value({ priceConfig: { type: 'fixed', amountMinor: 750 } })]),
    );

    expect(line?.unpriced).toBeNull();
    expect(line?.deltaMinor).toBe(750);
  });

  /**
   * 🔴 **`priceType` decides the fallback shape, not a hardcoded `'fixed'`.**
   *
   * `toPublishedPriceConfig` emits `{type: fallback.priceType, amount_minor}`
   * when no JSON is configured. Hardcoding `'fixed'` showed a value typed as a
   * percentage as a flat amount — a divergence from the storefront that would
   * activate the moment per-type authoring lands.
   */
  it('uses the value’s own priceType when no config is stored', () => {
    const [line] = sampleLines(
      option([value({ priceType: 'percentage', priceAmountMinor: 500 })]),
    );

    /* Percentage reads `basis_points`; an `amount_minor` fallback cannot price
     * it, and saying so is right — silently charging 5.00 would not be. */
    expect(line?.unpriced).toBe('percentage');
  });

  /**
   * 🔴 **`priceConfig` wins over `priceAmountMinor` when both are present.**
   * The storefront resolves it that way — a configured percentage is what the
   * merchant authored, and the flat column is what the type defaults to.
   * Showing the flat number while the storefront charged the percentage would
   * make the worked example wrong exactly where it matters.
   */
  it('prefers priceConfig over the flat amount', () => {
    const [line] = sampleLines(
      option([
        value({
          priceAmountMinor: 500,
          /* ⚠️ **Stored shape.** This case was written in wire shape and passed
           * against the defect it was meant to guard — the test agreeing with
           * the misunderstanding rather than with the API. */
          priceConfig: { type: 'percentage', basisPoints: 1000 },
        }),
      ]),
    );

    /* 10% of the sample base, not the 500 in the flat column. */
    expect(line?.deltaMinor).toBe(SAMPLE_BASE_MINOR / 10);
  });

  /** ⚠️ A value the evaluator cannot price is REPORTED, not silently zero. */
  it('reports a value it cannot price', () => {
    const [line] = sampleLines(
      option([value({ priceConfig: { type: 'percentage', basis_points: 'nonsense' } })]),
    );

    expect(line?.unpriced).toBe('percentage');
    expect(line?.deltaMinor).toBe(0);
  });

  /** One line per priced value, so a merchant sees which value costs what. */
  it('returns one line per priced value', () => {
    const lines = sampleLines(
      option([
        value({ id: 'v1', label: 'Matte', priceAmountMinor: 500 }),
        value({ id: 'v2', label: 'Gloss', priceAmountMinor: 750 }),
      ]),
    );

    expect(lines.map((line) => line.deltaMinor)).toEqual([500, 750]);
  });

  /**
   * 🔴 **The line carries its own clamped total**, so the display never adds.
   * A discount larger than the base must show 0.00, not a negative price.
   */
  it('carries a clamped total on each line', () => {
    const [line] = sampleLines(
      option([value({ priceAmountMinor: -(SAMPLE_BASE_MINOR + 100) })]),
    );

    expect(line?.deltaMinor).toBe(-(SAMPLE_BASE_MINOR + 100));
    expect(line?.totalMinor).toBe(0);
  });

  /**
   * 🔴 **A negative delta is a discount, and must not be dropped.** The
   * clamping happens once at the line total, never per value — `sumDeltas`
   * owns that, and duplicating it here would be the second set of rules.
   */
  it('keeps a negative delta as authored', () => {
    const [line] = sampleLines(option([value({ priceAmountMinor: -200 })]));

    expect(line?.deltaMinor).toBe(-200);
  });
});

/**
 * 🔴 **`sampleTotal` exists ONLY to delegate, so its test has to prove the
 * delegation.** A mutant replacing `sumDeltas(base, [delta])` with
 * `base + delta` survived the first version of this file — every `sampleLines`
 * test passed, because none of them ever called `sampleTotal`. An untested
 * function whose entire job is to reuse shared logic is the exact shape of the
 * "second set of rules" M21.1 forbids.
 */
describe('sampleTotal', () => {
  it('adds a surcharge to the sample base', () => {
    expect(sampleTotal(500)).toBe(SAMPLE_BASE_MINOR + 500);
  });

  it('subtracts a discount from the sample base', () => {
    expect(sampleTotal(-500)).toBe(SAMPLE_BASE_MINOR - 500);
  });

  /**
   * 🔴 **The case a hand-written `base + delta` gets wrong.** A discount larger
   * than the base must clamp to zero rather than going negative — `sumDeltas`
   * owns that rule and the shared fixture proves PHP agrees with it.
   */
  it('clamps a discount larger than the base to zero', () => {
    expect(sampleTotal(-(SAMPLE_BASE_MINOR + 1))).toBe(0);
  });
});
