import { describe, expect, it } from 'vitest';

import {
  optionPricingKinds,
  parseOptionPricing,
  readOptionPricing,
} from './option-pricing';

/**
 * Option-level pricing, as a merchant authors it (Phase 20 audit, F1 remainder).
 *
 * 🔴 **Three price types the storefront charges and nobody could create.**
 * `per_char` prices an engraving by the character, `per_unit` by the quantity
 * ordered — both implemented end to end, both proven by the shared fixture, and
 * neither authorable, because the editor had no option-level pricing at all.
 *
 * ⚠️ **Which types an option may use is the REGISTRY's decision, not this
 * module's.** A choice option prices per value and accepts nothing here; a text
 * option accepts `per_char`; a number option accepts `per_unit` or `tiered`.
 * Offering a merchant a type the API would refuse is a form that fails on save.
 *
 * 📌 **`tiered`'s own parsing lives in `tiers.ts`**, validated against the
 * API's copied schema — six set-level rules no single row can show.
 */
describe('optionPricingKinds', () => {
  it('offers per_char for a text option', () => {
    expect(optionPricingKinds('text_field')).toEqual(['per_char']);
    expect(optionPricingKinds('textarea')).toEqual(['per_char']);
  });

  it('offers per_unit for a number option', () => {
    expect(optionPricingKinds('number_field')).toContain('per_unit');
    expect(optionPricingKinds('range')).toContain('per_unit');
    expect(optionPricingKinds('quantity')).toContain('per_unit');
  });

  /** 🔴 A choice option prices per value — offering anything here would fail. */
  it('offers nothing for a choice option', () => {
    ['radio', 'dropdown', 'checkbox', 'color_swatch', 'image_swatch'].forEach((kind) => {
      expect(optionPricingKinds(kind)).toEqual([]);
    });
  });

  /**
   * ⚠️ **`tiered` joined the list once its bracket editor existed.** It was
   * deliberately withheld while the editor could only name a stored set — a
   * half-built bracket form would let a merchant save a quantity range that
   * charges nothing, which is what `tieredPricing`'s six set-level rules exist
   * to refuse.
   */
  it('offers tiered on a number option', () => {
    expect(optionPricingKinds('number_field')).toContain('tiered');
  });

  /** 🔴 A text option prices per character and must not be offered brackets. */
  it('does not offer tiered on a text option', () => {
    expect(optionPricingKinds('text_field')).not.toContain('tiered');
  });
});

describe('parseOptionPricing', () => {
  it('builds a per-character price', () => {
    const parsed = parseOptionPricing('per_char', { amount: '0.50', free: '5' });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.pricing).toEqual({
      type: 'per_char',
      amountMinor: 50,
      freeCharacters: 5,
    });
  });

  /** 📌 A merchant who ignores the allowance means "charge from the first". */
  it('defaults the free allowance to zero', () => {
    const parsed = parseOptionPricing('per_char', { amount: '0.50', free: '' });

    expect(parsed.ok && parsed.pricing).toMatchObject({ freeCharacters: 0 });
  });

  it('builds a per-unit price', () => {
    const parsed = parseOptionPricing('per_unit', { amount: '2.00', free: '' });

    expect(parsed.ok && parsed.pricing).toEqual({ type: 'per_unit', amountMinor: 200 });
  });

  /** ⚠️ `per_unit` has no free allowance — `tiered` expresses that intent. */
  it('ignores a free allowance on per_unit', () => {
    const parsed = parseOptionPricing('per_unit', { amount: '2.00', free: '5' });

    expect(parsed.ok && parsed.pricing).not.toHaveProperty('freeCharacters');
  });

  /** 🔴 A malformed amount is refused, never coerced to free. */
  it('refuses a malformed amount', () => {
    expect(parseOptionPricing('per_char', { amount: 'lots', free: '' }).ok).toBe(false);
  });

  it('refuses a malformed free allowance', () => {
    expect(parseOptionPricing('per_char', { amount: '0.50', free: 'many' }).ok).toBe(false);
  });

  it('refuses a negative free allowance', () => {
    expect(parseOptionPricing('per_char', { amount: '0.50', free: '-1' }).ok).toBe(false);
  });

  /** ⚠️ No amount at all means the option is not priced — cleared, not refused. */
  it('clears the pricing when the amount is blank', () => {
    const parsed = parseOptionPricing('per_char', { amount: '', free: '' });

    expect(parsed.ok && parsed.pricing).toBeNull();
  });
});

describe('readOptionPricing', () => {
  it('reads a stored per-character price back into fields', () => {
    expect(
      readOptionPricing({ type: 'per_char', amountMinor: 50, freeCharacters: 5 }),
    ).toEqual({ kind: 'per_char', amount: '0.50', free: '5' });
  });

  it('reads a stored per-unit price', () => {
    expect(readOptionPricing({ type: 'per_unit', amountMinor: 200 })).toEqual({
      kind: 'per_unit',
      amount: '2.00',
      free: '',
    });
  });

  /** 📌 Nothing stored reads as empty fields, not as a zero price. */
  it('reads absent pricing as empty', () => {
    expect(readOptionPricing(null)).toEqual({ kind: '', amount: '', free: '' });
  });

  /**
   * ⚠️ **A stored `tiered` is reported, not silently shown as unpriced.** The
   * editor cannot author one yet, and rendering it as "no price" would invite a
   * merchant to overwrite a bracket set they cannot see.
   */
  it('reports a stored tiered price it cannot edit', () => {
    expect(readOptionPricing({ type: 'tiered', tiers: [] })).toEqual({
      kind: 'tiered',
      amount: '',
      free: '',
    });
  });
});
