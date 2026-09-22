import { describe, expect, it } from 'vitest';

import { toPublishedPriceConfig } from './to-wire-price-config';

const COLUMNS = { priceType: 'fixed', priceAmountMinor: 1000 };

/**
 * Stored shape in, wire shape out.
 *
 * 🔴 **Ported with the module (M20.6 audit).** The dashboard's worked example
 * fed the **authoring** projection's camelCase straight into evaluators that
 * read snake_case, and every configured value rendered *"could not be priced"*.
 * The unit tests passed because they were written in wire shape — agreeing with
 * the misunderstanding rather than with the API.
 *
 * ⚠️ **These cases are the backend's, deliberately unchanged.** A dashboard
 * rewrite of them would be a second opinion about what the storefront receives,
 * which is the failure the whole shared-evaluator arrangement exists to avoid.
 */
describe('toPublishedPriceConfig', () => {
  it('uses the columns when no JSON is configured', () => {
    expect(toPublishedPriceConfig(null, COLUMNS)).toEqual({
      type: 'fixed',
      amount_minor: 1000,
    });
  });

  it('converts a fixed price', () => {
    expect(toPublishedPriceConfig({ type: 'fixed', amountMinor: 250 }, COLUMNS)).toEqual({
      type: 'fixed',
      amount_minor: 250,
    });
  });

  it('converts a per-unit price', () => {
    expect(toPublishedPriceConfig({ type: 'per_unit', amountMinor: 50 }, COLUMNS)).toEqual({
      type: 'per_unit',
      amount_minor: 50,
    });
  });

  it('converts a percentage', () => {
    expect(toPublishedPriceConfig({ type: 'percentage', basisPoints: 250 }, COLUMNS)).toEqual({
      type: 'percentage',
      basis_points: 250,
    });
  });

  it('converts a per-character price with its free allowance', () => {
    expect(
      toPublishedPriceConfig(
        { type: 'per_char', amountMinor: 25, freeCharacters: 10 },
        COLUMNS,
      ),
    ).toEqual({ type: 'per_char', amount_minor: 25, free_characters: 10 });
  });

  /** The schema defaults it, but a row stored before that default must not emit undefined. */
  it('defaults free characters to zero', () => {
    expect(toPublishedPriceConfig({ type: 'per_char', amountMinor: 25 }, COLUMNS)).toEqual({
      type: 'per_char',
      amount_minor: 25,
      free_characters: 0,
    });
  });

  it('converts tiers, bracket by bracket', () => {
    const result = toPublishedPriceConfig(
      {
        type: 'tiered',
        tiers: [
          { minQuantity: 1, maxQuantity: 9, amountMinor: 100 },
          { minQuantity: 10, maxQuantity: null, amountMinor: 80 },
        ],
      },
      COLUMNS,
    );

    expect(result).toEqual({
      type: 'tiered',
      tiers: [
        { min_quantity: 1, max_quantity: 9, amount_minor: 100 },
        { min_quantity: 10, max_quantity: null, amount_minor: 80 },
      ],
    });
  });

  /** `null` means open-ended, which an evaluator must tell apart from absent. */
  it('keeps an open-ended tier’s null explicit', () => {
    const result = toPublishedPriceConfig(
      { type: 'tiered', tiers: [{ minQuantity: 1, maxQuantity: null, amountMinor: 100 }] },
      COLUMNS,
    ) as { tiers: Array<Record<string, unknown>> };

    expect(result.tiers[0]).toHaveProperty('max_quantity');
    expect(result.tiers[0].max_quantity).toBeNull();
  });

  it('survives tiered pricing with no tiers', () => {
    expect(toPublishedPriceConfig({ type: 'tiered' }, COLUMNS)).toEqual({
      type: 'tiered',
      tiers: [],
    });
  });

  /**
   * The validator refuses unknown types at the boundary, so a stored one means
   * the registry grew and this did not. Visible and wrong-looking beats a value
   * that silently loses its price.
   */
  it('passes an unrecognised type through unchanged', () => {
    const exotic = { type: 'interpretive_dance', amountMinor: 1 };

    expect(toPublishedPriceConfig(exotic, COLUMNS)).toEqual(exotic);
  });

  /** No camelCase may reach the document for any known type. */
  it.each([
    ['fixed', { type: 'fixed', amountMinor: 1 }],
    ['per_unit', { type: 'per_unit', amountMinor: 1 }],
    ['percentage', { type: 'percentage', basisPoints: 1 }],
    ['per_char', { type: 'per_char', amountMinor: 1, freeCharacters: 1 }],
    ['tiered', { type: 'tiered', tiers: [{ minQuantity: 1, maxQuantity: 2, amountMinor: 1 }] }],
    ['columns', null],
  ])('emits no camelCase keys for %s', (_label, config) => {
    const json = JSON.stringify(toPublishedPriceConfig(config, COLUMNS));

    expect(json).not.toMatch(/[a-z][A-Z]/);
  });

  /** Money is an integer in minor units on the wire (ADR-013). */
  it('preserves negative and large amounts exactly', () => {
    expect(
      toPublishedPriceConfig({ type: 'fixed', amountMinor: -999_999_999 }, COLUMNS),
    ).toEqual({ type: 'fixed', amount_minor: -999_999_999 });
    expect(
      toPublishedPriceConfig({ type: 'fixed', amountMinor: 1_000_000_000 }, COLUMNS),
    ).toEqual({ type: 'fixed', amount_minor: 1_000_000_000 });
  });
});
