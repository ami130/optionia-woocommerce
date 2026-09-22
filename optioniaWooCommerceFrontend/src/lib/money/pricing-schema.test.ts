import { describe, expect, it } from 'vitest';

import { tieredPricing } from './pricing-schema';

/**
 * The tier rules, copied from the API rather than restated.
 *
 * 🔴 **Six cross-bracket rules, none visible from a single tier.** A gap, an
 * overlap, an unbounded tier in the middle, a set that does not start at 1, a
 * last tier that is not open-ended, a tier ending before it starts — each is a
 * **wrong charge** rather than a malformed document, which is why
 * `pricing.schema.ts` validates the tiers as a set.
 *
 * ⚠️ **Copied, not reimplemented — ADR-083's discipline applied to a schema.**
 * `pricing.schema.ts` imports only `zod`, so it ports exactly; writing these
 * rules again in the dashboard would be a second opinion about what the API
 * accepts, and the two would disagree the first time one changed.
 *
 * 🔴 **The zod major differs — backend 4.4.3, dashboard 3.25.76 — and that was
 * checked before copying, not after.** `code: 'custom'`, `.strict()`,
 * `discriminatedUnion` and `.default()` were each probed under zod 3 and behave
 * identically. These cases are what keep that true.
 */
const tiers = (...rows: [number, number | null, number][]) => ({
  type: 'tiered' as const,
  tiers: rows.map(([minQuantity, maxQuantity, amountMinor]) => ({
    minQuantity,
    maxQuantity,
    amountMinor,
  })),
});

describe('tieredPricing', () => {
  it('accepts a covering set', () => {
    expect(tieredPricing.safeParse(tiers([1, 9, 500], [10, null, 400])).success).toBe(true);
  });

  it('accepts a single open-ended tier from 1', () => {
    expect(tieredPricing.safeParse(tiers([1, null, 500])).success).toBe(true);
  });

  /** 🔴 Quantities 1-4 would be unpriced. */
  it('refuses a set that does not start at 1', () => {
    const result = tieredPricing.safeParse(tiers([5, null, 500]));

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toMatch(/start at 1/i);
  });

  /** 🔴 Quantities above the last bracket would be unpriced. */
  it('refuses a last tier that is not open-ended', () => {
    const result = tieredPricing.safeParse(tiers([1, 20, 500]));

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toMatch(/open-ended/i);
  });

  it('refuses a gap between tiers', () => {
    const result = tieredPricing.safeParse(tiers([1, 9, 500], [15, null, 400]));

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toMatch(/fall between/i);
  });

  it('refuses overlapping tiers', () => {
    const result = tieredPricing.safeParse(tiers([1, 10, 500], [5, null, 400]));

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toMatch(/overlaps/i);
  });

  /** ⚠️ An unbounded tier in the middle swallows every bracket after it. */
  it('refuses an open-ended tier that is not last', () => {
    const result = tieredPricing.safeParse(tiers([1, null, 500], [10, null, 400]));

    expect(result.success).toBe(false);
  });

  it('refuses a tier that ends before it starts', () => {
    const result = tieredPricing.safeParse(tiers([1, 9, 500], [10, 5, 400]));

    expect(result.success).toBe(false);
  });

  it('refuses an empty set', () => {
    expect(tieredPricing.safeParse({ type: 'tiered', tiers: [] }).success).toBe(false);
  });

  /** ⚠️ `.strict()` — an unknown key must not be silently stripped. */
  it('refuses an unknown key on a tier', () => {
    const result = tieredPricing.safeParse({
      type: 'tiered',
      tiers: [{ minQuantity: 1, maxQuantity: null, amountMinor: 500, freeUnits: 5 }],
    });

    expect(result.success).toBe(false);
  });

  /** 📌 Order does not matter — the rules sort before checking. */
  it('accepts a covering set given out of order', () => {
    expect(tieredPricing.safeParse(tiers([10, null, 400], [1, 9, 500])).success).toBe(true);
  });
});
