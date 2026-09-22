import { describe, expect, it } from 'vitest';

import { parsePortable } from './portable-import';
import { STARTER_TEMPLATES, templateDocument } from './templates';

/**
 * Starter templates (M20.7).
 *
 * 🔴 **"A merchant's first option set should be a template they adapt, never a
 * blank canvas."** Phase 20b states the reason: a blank first run is where
 * builders lose people, because the merchant does not yet know what "option
 * group" means and an empty screen does not teach them.
 *
 * 📌 **Templates ARE portable documents.** They go through the same
 * `parsePortable` → `POST /import` path a merchant's own file does, so there is
 * one way to build a set from a description rather than two — and every rule
 * the import enforces applies to a template automatically.
 *
 * ⚠️ **The prices are defaults to edit, not recommendations.** A merchant's
 * first act is usually changing them; what the template teaches is the *shape*
 * — that engraving prices per character, that a gift message needs a length
 * limit.
 */
describe('STARTER_TEMPLATES', () => {
  it('offers the four the plan names', () => {
    expect(STARTER_TEMPLATES.map((template) => template.id)).toEqual([
      'tshirt',
      'engraving',
      'gift-wrap',
      'dimensions',
    ]);
  });

  it('names and describes each one', () => {
    STARTER_TEMPLATES.forEach((template) => {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    });
  });
});

describe('templateDocument', () => {
  /**
   * 🔴 **Every template must survive the importer it will go through.** A
   * template that the import refuses is one a merchant meets as an error on
   * their first action — the worst possible first run.
   */
  it.each(STARTER_TEMPLATES.map((template) => [template.id, template] as const))(
    '%s parses as a valid document',
    (_id, template) => {
      const parsed = parsePortable(JSON.stringify(templateDocument(template)));

      expect(parsed.ok).toBe(true);
    },
  );

  /** 🔴 Engraving is the one that teaches per-character pricing. */
  it('engraving prices per character with a free allowance', () => {
    const engraving = STARTER_TEMPLATES.find((template) => template.id === 'engraving')!;
    const option = templateDocument(engraving).groups[0]!.options[0]!;

    expect(option.presentation).toBe('text_field');
    expect(option.pricing).toMatchObject({ type: 'per_char', freeCharacters: expect.any(Number) });
  });

  /** ⚠️ And carries the length limit its help text describes. */
  it('engraving limits the length it promises', () => {
    const engraving = STARTER_TEMPLATES.find((template) => template.id === 'engraving')!;
    const option = templateDocument(engraving).groups[0]!.options[0]!;
    const max = (option.validation as { maxLength?: number } | null)?.maxLength;

    expect(typeof max).toBe('number');
    expect(option.helpText).toContain(String(max));
  });

  /** 🔴 Dimensions is the one that teaches per-unit pricing on a number. */
  it('dimensions prices per unit', () => {
    const dimensions = STARTER_TEMPLATES.find((template) => template.id === 'dimensions')!;
    const priced = templateDocument(dimensions)
      .groups[0]!.options.filter((option) => option.pricing !== null);

    expect(priced.length).toBeGreaterThan(0);
    expect(priced[0]?.pricing).toMatchObject({ type: 'per_unit' });
  });

  /** ⚠️ A valueless type must carry no values — the rule the import enforces. */
  it('gives no values to a type that takes none', () => {
    STARTER_TEMPLATES.forEach((template) => {
      templateDocument(template).groups.forEach((group) => {
        group.options.forEach((option) => {
          if (option.presentation === 'text_field' || option.presentation === 'textarea') {
            expect(option.values).toEqual([]);
          }
        });
      });
    });
  });

  /** 📌 The T-shirt is the one that teaches per-value pricing and swatches. */
  it('the t-shirt prices per value', () => {
    const tshirt = STARTER_TEMPLATES.find((template) => template.id === 'tshirt')!;
    const values = templateDocument(tshirt).groups.flatMap((group) =>
      group.options.flatMap((option) => option.values),
    );

    expect(values.some((value) => value.priceAmountMinor > 0)).toBe(true);
  });

  /** ⚠️ Every template is a draft with no publish state — it is a starting point. */
  it('carries no publish state', () => {
    STARTER_TEMPLATES.forEach((template) => {
      const json = JSON.stringify(templateDocument(template));

      expect(json).not.toMatch(/publishedAt|rowVersion|storeId/);
    });
  });
});
