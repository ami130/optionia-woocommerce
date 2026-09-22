import { describe, expect, it } from 'vitest';

import { parseTiers, readTiers, type TierRow } from './tiers';

/**
 * Quantity brackets, as a merchant edits them (Phase 20 audit).
 *
 * 🔴 **Validated against the API's OWN schema, copied not restated.**
 * `tieredPricing` carries six cross-bracket rules — a gap, an overlap, an
 * unbounded tier in the middle, a set not starting at 1, a last tier that is
 * bounded, a tier ending before it starts. Each is a **wrong charge**, and each
 * is invisible from a single row, which is why the form validates the set.
 *
 * ⚠️ **The copied schema was verified across a zod MAJOR boundary** — backend
 * 4.4.3, dashboard 3.25.76. Eleven cases were run on both sides and every
 * answer matched.
 */
const row = (min: string, max: string, amount: string): TierRow => ({ min, max, amount });

describe('parseTiers', () => {
  it('builds a covering set', () => {
    const parsed = parseTiers([row('1', '9', '5.00'), row('10', '', '4.00')]);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.pricing).toEqual({
      type: 'tiered',
      tiers: [
        { minQuantity: 1, maxQuantity: 9, amountMinor: 500 },
        { minQuantity: 10, maxQuantity: null, amountMinor: 400 },
      ],
    });
  });

  /** 📌 A blank maximum is open-ended, which the last tier must be. */
  it('reads a blank maximum as open-ended', () => {
    const parsed = parseTiers([row('1', '', '5.00')]);

    expect(parsed.ok && parsed.pricing?.tiers[0]?.maxQuantity).toBeNull();
  });

  /** 🔴 The API's own messages, so the form and the wire agree. */
  it('refuses a set that does not start at 1', () => {
    const parsed = parseTiers([row('5', '', '5.00')]);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toMatch(/start at 1/i);
  });

  it('refuses a gap between brackets', () => {
    const parsed = parseTiers([row('1', '9', '5.00'), row('15', '', '4.00')]);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toMatch(/fall between/i);
  });

  it('refuses overlapping brackets', () => {
    const parsed = parseTiers([row('1', '10', '5.00'), row('5', '', '4.00')]);

    expect(parsed.ok).toBe(false);
  });

  it('refuses a bounded last bracket', () => {
    const parsed = parseTiers([row('1', '20', '5.00')]);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toMatch(/open-ended/i);
  });

  /** ⚠️ A malformed number is refused before the schema ever sees it. */
  it('refuses a malformed quantity', () => {
    expect(parseTiers([row('one', '', '5.00')]).ok).toBe(false);
  });

  it('refuses a malformed amount', () => {
    expect(parseTiers([row('1', '', 'lots')]).ok).toBe(false);
  });

  /** ⚠️ No rows means the option is not tier-priced — cleared, not refused. */
  it('clears the pricing when every row is blank', () => {
    const parsed = parseTiers([row('', '', '')]);

    expect(parsed.ok && parsed.pricing).toBeNull();
  });

  it('reports every bad row, not only the first', () => {
    const parsed = parseTiers([row('one', '', '5.00'), row('two', '', 'lots')]);

    expect(!parsed.ok && parsed.problems.length).toBeGreaterThan(1);
  });
});

describe('readTiers', () => {
  it('reads stored brackets back into rows', () => {
    expect(
      readTiers({
        type: 'tiered',
        tiers: [
          { minQuantity: 1, maxQuantity: 9, amountMinor: 500 },
          { minQuantity: 10, maxQuantity: null, amountMinor: 400 },
        ],
      }),
    ).toEqual([row('1', '9', '5.00'), row('10', '', '4.00')]);
  });

  /** 📌 Nothing stored gives one empty row to start from, not zero. */
  it('gives one empty row when nothing is stored', () => {
    expect(readTiers(null)).toEqual([row('', '', '')]);
  });
});
