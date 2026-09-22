import { describe, expect, it } from 'vitest';

import {
  toPublishedDisplay,
  toPublishedOptionPricing,
  toPublishedValidation,
} from './published-shape';

/**
 * ⚠️ **These are the backend's own cases, re-asserted against the port.**
 *
 * `bin/check-evaluator-parity.sh` compares the four *evaluator* pairs as text,
 * so a drift between the two copies of `priceConfigDelta` fails a gate. It
 * cannot reach this file: both transforms here widen their signature to accept
 * `undefined` (the preview reads an in-progress draft, the serializer reads a
 * stored row), so the bodies are deliberately not textually identical and a
 * text comparison would fail against correct code.
 *
 * What is shared is the *behaviour*, so that is what is pinned — case for case
 * from `option-config.spec.ts` in the backend. A divergence shows up as a
 * failing assertion here rather than as a preview that prices differently from
 * the storefront.
 *
 * ✏️ **This caught one on arrival.** The first draft of the port returned
 * `{ type: pricing.type }` for an unrecognised type, dropping every other
 * field — the "silently absent" outcome the backend's default branch exists to
 * avoid. It was invisible in the port's own reading and failed the moment the
 * backend's case ran against it.
 */
describe('published shape (ported from the serializer)', () => {
  describe('toPublishedOptionPricing', () => {
    it('converts a per_char price to the documented shape', () => {
      expect(
        toPublishedOptionPricing({ type: 'per_char', amountMinor: 25, freeCharacters: 10 }),
      ).toEqual({ type: 'per_char', amount_minor: 25, free_characters: 10 });
    });

    /**
     * Present and zero, not omitted — a reader must tell "charge from the first
     * character" from "the merchant never configured this".
     */
    it('states free_characters explicitly when the merchant set none', () => {
      const published = toPublishedOptionPricing({ type: 'per_char', amountMinor: 25 });

      expect(published).toHaveProperty('free_characters', 0);
    });

    it('converts a per_unit price to the documented shape', () => {
      expect(toPublishedOptionPricing({ type: 'per_unit', amountMinor: 200 })).toEqual({
        type: 'per_unit',
        amount_minor: 200,
      });
    });

    /**
     * The nested shape. A `tiered` price that fell through to the default would
     * carry `minQuantity` where the evaluator reads `min_quantity`, and every
     * bracket would miss.
     */
    it('converts a tiered price and its brackets to the documented shape', () => {
      expect(
        toPublishedOptionPricing({
          type: 'tiered',
          tiers: [
            { minQuantity: 1, maxQuantity: 9, amountMinor: 100 },
            { minQuantity: 10, maxQuantity: null, amountMinor: 80 },
          ],
        }),
      ).toEqual({
        type: 'tiered',
        tiers: [
          { min_quantity: 1, max_quantity: 9, amount_minor: 100 },
          { min_quantity: 10, max_quantity: null, amount_minor: 80 },
        ],
      });
    });

    /**
     * 🔴 **The open-ended top tier, with the key absent rather than null.**
     *
     * A draft's last bracket often carries no `maxQuantity` at all, and
     * `?? null` is what turns that into the `max_quantity: null` the evaluator
     * reads as "no ceiling". Without it the key is `undefined`, which
     * `JSON.stringify` drops from the document entirely — the top tier arrives
     * with no ceiling *marker*, not with no ceiling.
     *
     * ⚠️ **The backend's own spec does not cover this**: its fixture spells the
     * open bracket `maxQuantity: null`, on which `?? null` is a no-op. Mutating
     * the default away left every ported case passing, which is how the hole
     * showed up.
     */
    it('states max_quantity explicitly when a bracket has no ceiling', () => {
      const published = toPublishedOptionPricing({
        type: 'tiered',
        tiers: [{ minQuantity: 10, amountMinor: 80 }],
      }) as { tiers: Record<string, unknown>[] };

      expect(published.tiers[0]).toHaveProperty('max_quantity', null);
    });

    it('leaves an option with no option-level price alone', () => {
      expect(toPublishedOptionPricing(null)).toBeNull();
    });

    /**
     * 🔴 **The case the port failed.** Visible and wrong-looking beats silently
     * absent: an unrecognised type keeps every field it arrived with, so a type
     * the registry grew and this switch did not is noticeable rather than empty.
     */
    it('passes an unrecognised type through rather than dropping it', () => {
      const odd = { type: 'not_a_real_type', someField: 1 };

      expect(toPublishedOptionPricing(odd)).toEqual(odd);
    });

    /**
     * A draft that has not chosen a pricing type yet — the preview's own case,
     * which the serializer never sees because a stored row is either null or
     * complete.
     */
    it('leaves an unset price alone', () => {
      expect(toPublishedOptionPricing(undefined)).toBeUndefined();
    });

    it('emits no camelCase key for any known type', () => {
      const configs = [
        { type: 'per_char', amountMinor: 25, freeCharacters: 10 },
        { type: 'fixed', amountMinor: 100 },
        { type: 'per_unit', amountMinor: 100 },
        { type: 'percentage', basisPoints: 250 },
        { type: 'tiered', tiers: [{ minQuantity: 1, maxQuantity: null, amountMinor: 100 }] },
      ];

      configs.forEach((config) => {
        const published = toPublishedOptionPricing(config) as Record<string, unknown>;

        Object.keys(published).forEach((key) => {
          expect(key).toBe(key.toLowerCase());
        });
      });
    });
  });

  describe('toPublishedValidation', () => {
    /**
     * 🔴 **The original defect, one field over.** A merchant's `maxLength`
     * published verbatim reached the plugin spelled in a way
     * `SelectionResolver::max_length()` does not look for: present in the
     * document, enforced nowhere, and a customer could type past the limit.
     */
    it('renames the length rules the plugin reads', () => {
      expect(toPublishedValidation({ minLength: 2, maxLength: 20 })).toEqual({
        min_length: 2,
        max_length: 20,
      });
    });

    it('keeps the value, converting only the key', () => {
      expect(toPublishedValidation({ maxLength: 20 })?.max_length).toBe(20);
    });

    /**
     * `integerOnly` is the key that was actually missed when `number_field`
     * shipped — the plugin reads `integer_only`, so every fractional quantity
     * would have been accepted against a rule forbidding them.
     */
    it('renames the numeric rules', () => {
      expect(
        toPublishedValidation({ min: 1, max: 10, step: 2, integerOnly: true }),
      ).toEqual({ min: 1, max: 10, step: 2, integer_only: true });
    });

    it('renames the content rules', () => {
      expect(
        toPublishedValidation({
          pattern: '^[a-z]+$',
          allowedCharset: 'latin',
          forbiddenWords: ['no'],
        }),
      ).toEqual({
        pattern: '^[a-z]+$',
        allowed_charset: 'latin',
        forbidden_words: ['no'],
      });
    });

    it('renames the date rules', () => {
      expect(
        toPublishedValidation({
          minDate: '2026-01-01',
          maxDate: '2026-12-31',
          blackoutDates: ['2026-07-04'],
          allowedWeekdays: [1, 2],
          leadTimeDays: 3,
          maxAdvanceDays: 90,
        }),
      ).toEqual({
        min_date: '2026-01-01',
        max_date: '2026-12-31',
        blackout_dates: ['2026-07-04'],
        allowed_weekdays: [1, 2],
        lead_time_days: 3,
        max_advance_days: 90,
      });
    });

    /**
     * 🔴 **These shipped camelCase until M18.3a**, because `rename()` falls
     * through with `keys[key] ?? key` and the map simply omitted them.
     */
    it('renames the selection counts', () => {
      expect(toPublishedValidation({ minSelections: 1, maxSelections: 3 })).toEqual({
        min_selections: 1,
        max_selections: 3,
      });
    });

    it('passes an unmapped key through rather than dropping it', () => {
      expect(toPublishedValidation({ somethingNew: 1 })).toEqual({ somethingNew: 1 });
    });

    it('passes null through', () => {
      expect(toPublishedValidation(null)).toBeNull();
    });

    it('leaves an unset validation alone', () => {
      expect(toPublishedValidation(undefined)).toBeUndefined();
    });

    /**
     * The property rather than the row: every one of the 17 mapped keys at once,
     * so a rule added to the schema and forgotten in the map fails here without
     * anyone having to remember to add an assertion.
     */
    it('emits no camelCase key for anything it maps', () => {
      const published = toPublishedValidation({
        minLength: 1,
        maxLength: 20,
        min: 1,
        max: 10,
        step: 1,
        integerOnly: true,
        pattern: 'x',
        allowedCharset: 'latin',
        forbiddenWords: ['a'],
        minDate: '2026-01-01',
        maxDate: '2026-12-31',
        blackoutDates: [],
        allowedWeekdays: [1],
        leadTimeDays: 1,
        maxAdvanceDays: 2,
        minSelections: 1,
        maxSelections: 2,
      }) as Record<string, unknown>;

      expect(Object.keys(published)).toHaveLength(17);
      Object.keys(published).forEach((key) => {
        expect(key).toBe(key.toLowerCase());
      });
    });
  });

  describe('toPublishedDisplay', () => {
    /**
     * `character_counter` is the flag M14.4b makes required whenever
     * `max_length` is set, so a rename that missed it would preview a limit with
     * no counter.
     */
    it('renames the counter flag', () => {
      expect(toPublishedDisplay({ characterCounter: true })).toEqual({
        character_counter: true,
      });
    });

    it('renames the other display keys', () => {
      expect(
        toPublishedDisplay({
          priceDisplay: 'delta',
          swatchSize: 'large',
          collapsedByDefault: true,
        }),
      ).toEqual({
        price_display: 'delta',
        swatch_size: 'large',
        collapsed_by_default: true,
      });
    });

    it('passes null through', () => {
      expect(toPublishedDisplay(null)).toBeNull();
    });

    it('leaves an unset display alone', () => {
      expect(toPublishedDisplay(undefined)).toBeUndefined();
    });

    /**
     * The property rather than the row: a key added to the schema and forgotten
     * in `DISPLAY_KEYS` publishes in the stored spelling, and fails here without
     * anyone having to remember to add an assertion.
     */
    it('emits no camelCase key for anything it maps', () => {
      const published = toPublishedDisplay({
        characterCounter: true,
        collapsedByDefault: true,
      }) as Record<string, unknown>;

      Object.keys(published).forEach((key) => {
        expect(key).toBe(key.toLowerCase());
      });
    });
  });
});
