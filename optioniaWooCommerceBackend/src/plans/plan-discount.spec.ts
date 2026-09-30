import {
  MAX_DISCOUNT_BASIS_POINTS,
  applyDiscount,
  impliedDiscount,
} from './plan-discount';

describe('applyDiscount', () => {
  it('takes a plain percentage off a yearly list price', () => {
    // £290.00 less 20% = £232.00
    expect(applyDiscount(29_000, 2_000)).toEqual({
      listMinor: 29_000,
      amountMinor: 23_200,
      savingMinor: 5_800,
      basisPoints: 2_000,
    });
  });

  it('charges the list price when there is no discount', () => {
    const d = applyDiscount(29_000, 0);
    expect(d.amountMinor).toBe(29_000);
    expect(d.savingMinor).toBe(0);
  });

  it('charges nothing at a full 100% discount', () => {
    const d = applyDiscount(29_000, MAX_DISCOUNT_BASIS_POINTS);
    expect(d.amountMinor).toBe(0);
    expect(d.savingMinor).toBe(29_000);
  });

  it('keeps the three figures consistent, whatever the rounding', () => {
    // 🔴 The saving is rounded and the charge derived from it, so a receipt can
    // never read "£290.00 − £58.00 = £232.01".
    for (let list = 0; list <= 5_000; list += 7) {
      for (const bp of [1, 33, 250, 1_234, 3_333, 6_667, 9_999]) {
        const d = applyDiscount(list, bp);
        expect(d.amountMinor + d.savingMinor).toBe(d.listMinor);
      }
    }
  });

  it('never charges more than the list price, or less than nothing', () => {
    for (let list = 0; list <= 2_000; list += 13) {
      for (const bp of [0, 1, 500, 5_000, 9_999, 10_000]) {
        const d = applyDiscount(list, bp);
        expect(d.amountMinor).toBeGreaterThanOrEqual(0);
        expect(d.amountMinor).toBeLessThanOrEqual(list);
      }
    }
  });

  it('rounds half up, agreeing with the plugin rather than with Math.round', () => {
    // 5% of 30 minor units is exactly 1.5 — the tie PRICING-SPEC §4 governs.
    expect(applyDiscount(30, 500).savingMinor).toBe(2);
  });

  it('refuses a discount above 100% rather than clamping it', () => {
    // ⚠️ Clamping would silently charge zero for a typo — someone meaning 15%
    // and reaching for basis points writes exactly this number.
    expect(() => applyDiscount(29_000, 15_000)).toThrow(RangeError);
  });

  it('refuses a negative discount, which would be a surcharge', () => {
    expect(() => applyDiscount(29_000, -500)).toThrow(RangeError);
  });

  it('refuses fractional inputs rather than rounding them silently', () => {
    expect(() => applyDiscount(29_000.5, 2_000)).toThrow(RangeError);
    expect(() => applyDiscount(29_000, 2_000.5)).toThrow(RangeError);
  });

  it('refuses a negative list price', () => {
    expect(() => applyDiscount(-1, 0)).toThrow(RangeError);
  });

  it('handles a zero list price without dividing by it', () => {
    const d = applyDiscount(0, 5_000);
    expect(d).toEqual({ listMinor: 0, amountMinor: 0, savingMinor: 0, basisPoints: 5_000 });
  });
});

describe('impliedDiscount', () => {
  it('recovers a clean discount for display', () => {
    expect(impliedDiscount(29_000, 23_200)).toBe(2_000);
  });

  it('reports no discount when the amount is the list price', () => {
    expect(impliedDiscount(29_000, 29_000)).toBe(0);
  });

  it('reports no discount for a nonsensical pair rather than a negative one', () => {
    expect(impliedDiscount(29_000, 40_000)).toBe(0);
    expect(impliedDiscount(0, 100)).toBe(0);
    expect(impliedDiscount(-5, 1)).toBe(0);
  });

  it('is an APPROXIMATION and does not always round-trip', () => {
    // ⚠️ The saving was rounded to whole minor units on the way in, so the
    // authored figure is genuinely gone. This asserts the documented limit
    // rather than a round trip the function cannot promise.
    let exact = 0;
    let near = 0;
    for (let list = 100; list <= 3_000; list += 37) {
      for (const bp of [333, 1_234, 6_667]) {
        const back = impliedDiscount(list, applyDiscount(list, bp).amountMinor);
        if (back === bp) exact++;
        else {
          near++;
          expect(Math.abs(back - bp)).toBeLessThanOrEqual(60);
        }
      }
    }
    // Both outcomes occur — so the approximation is real, not a round trip.
    expect(exact).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(0);
  });
});
