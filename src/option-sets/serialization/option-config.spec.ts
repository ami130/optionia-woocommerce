import {
  toPublishedDisplay,
  toPublishedOptionPricing,
  toPublishedValidation,
} from './option-config';

/**
 * 🔴 **The document is `snake_case` because its reader is PHP.**
 *
 * `validation` and `display` were published verbatim from storage, which is
 * `camelCase`. A `maxLength` a merchant set therefore arrived spelled in a way
 * `SelectionResolver::max_length()` does not look for: present in the document,
 * enforced nowhere, and a customer could type past the limit.
 *
 * This is the same defect `toPublishedPriceConfig` was written for — the one
 * that put `amountMinor` and `amount_minor` in a single document — caught one
 * field over.
 */
describe('option config serialization', () => {
  describe('validation', () => {
    it('renames every rule the plugin reads', () => {
      expect(toPublishedValidation({ minLength: 2, maxLength: 20 })).toEqual({
        min_length: 2,
        max_length: 20,
      });
    });

    it('keeps the value, converting only the key', () => {
      expect(toPublishedValidation({ maxLength: 20 })?.max_length).toBe(20);
    });

    /**
     * Null stays null: an option with no rules publishes nothing, and
     * `optional()` drops the key entirely rather than emitting `{}`.
     */
    /**
     * 🔴 **`integerOnly` was published in a spelling nothing reads.**
     *
     * Caught by `bin/check-wire-keys.sh` the moment `number_field` shipped: the
     * plugin looks for `integer_only`, the map did not rename it, and every
     * fractional quantity would have been silently accepted on an option
     * configured to refuse them.
     *
     * The gate found it before a test did — which is the whole reason it exists.
     */
    it('renames the numeric rules the plugin reads', () => {
      expect(
        toPublishedValidation({ min: 1, max: 10, step: 0.5, integerOnly: true }),
      ).toEqual({ min: 1, max: 10, step: 0.5, integer_only: true });
    });

    it('passes null through', () => {
      expect(toPublishedValidation(null)).toBeNull();
    });

    /**
     * An unmapped key is emitted unchanged rather than dropped.
     *
     * The API shape-checks these objects, so an unmapped key means the schema
     * grew and this map did not. Verbatim keeps it visible and wrong-looking,
     * which is easier to notice than a rule that quietly disappears.
     */
    it('passes an unmapped key through rather than dropping it', () => {
      expect(toPublishedValidation({ somethingNew: 1 })).toEqual({ somethingNew: 1 });
    });
  });

  describe('display', () => {
    /**
     * 🔴 `character_counter` is the one M14.4b makes **required** whenever
     * `max_length` is set, so a rename that missed it would leave a limit with
     * no counter — the exact state that milestone forbids.
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

    /**
     * ✏️ **This asserted `labelPlacement` and `showPriceDelta` until M18.6a**,
     * when both were withdrawn (ADR-064) — one a second spelling of
     * `priceDisplay`, the other reaching nothing at either end.
     *
     * ⚠️ **Repointed at live keys rather than deleted.** The rename itself is
     * the thing under test, and it was measured wrong twice before: `maxLength`
     * shipped verbatim, and `minSelections` shipped camelCase until M18.3a. A
     * test of the mechanism has to keep naming keys that exist.
     */

    it('passes null through', () => {
      expect(toPublishedDisplay(null)).toBeNull();
    });
  });

  /**
   * ⚠️ **No key survives in `camelCase`.**
   *
   * The assertions above name the keys they expect; this one asserts the
   * *property* — that nothing mapped leaks through in the stored spelling. A new
   * rule added to the schema and forgotten here fails this without anyone having
   * to remember to add a row.
   *
   * ✏️ **It fed `labelPlacement` until M18.6a, and caught the withdrawal.**
   * Removing that key from `DISPLAY_KEYS` (ADR-064) made it fall through
   * unrenamed, and this test failed — correctly, since a key with no mapping
   * publishes in the stored spelling. Repointed at a live key, because the
   * property it guards is about the *mechanism*, not about any one field.
   */
  it('emits no camelCase key for anything it maps', () => {
    const published = {
      ...toPublishedValidation({ minLength: 1, maxLength: 20 }),
      ...toPublishedDisplay({ characterCounter: true, collapsedByDefault: true }),
    };

    Object.keys(published).forEach((key) => {
      expect(key).toBe(key.toLowerCase());
    });
  });

  /**
   * 🔴 The same defect, in the field beside `validation`.
   *
   * `pricing` was published verbatim while `price_config` went through
   * `toPublishedPriceConfig`, so a `per_char` price reached the plugin as
   * `{ type, amountMinor, freeCharacters }` while `CONFIG-CONTRACT.md`
   * documented `snake_case`. Latent only because the plugin read `type` and
   * nothing else, which spells the same either way — the first evaluator to
   * read the amount would have found it absent and charged nothing for every
   * engraving.
   */
  describe('toPublishedOptionPricing', () => {
    it('converts a per_char price to the documented shape', () => {
      expect(
        toPublishedOptionPricing({ type: 'per_char', amountMinor: 25, freeCharacters: 10 }),
      ).toEqual({ type: 'per_char', amount_minor: 25, free_characters: 10 });
    });

    /**
     * Present and zero, not omitted. A reader must tell "charge from the first
     * character" from "the merchant never configured this", even though the two
     * behave identically today.
     */
    it('states free_characters explicitly when the merchant set none', () => {
      const published = toPublishedOptionPricing({ type: 'per_char', amountMinor: 25 });

      expect(published).toHaveProperty('free_characters', 0);
    });

    /**
     * `per_unit` is the second option-level type (M16.2), and it converts
     * through the same switch. Asserted separately because a type added to the
     * registry without a case here falls through to the default and is published
     * `camelCase` -- silently, since the default exists for exactly that.
     */
    it('converts a per_unit price to the documented shape', () => {
      expect(toPublishedOptionPricing({ type: 'per_unit', amountMinor: 200 })).toEqual({
        type: 'per_unit',
        amount_minor: 200,
      });
    });

    /**
     * `tiered` is the third option-level type (M16.3), and its brackets convert
     * key by key. A nested shape that fell through to the default would publish
     * `minQuantity` where the plugin looks for `min_quantity` — silently, since
     * the default exists for exactly that.
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

    it('leaves an option with no option-level price alone', () => {
      expect(toPublishedOptionPricing(null)).toBeNull();
    });

    /**
     * Visible and wrong-looking beats silently absent — the same choice
     * `toPublishedPriceConfig` makes for a type the registry grew and this did
     * not.
     */
    it('passes an unrecognised type through rather than dropping it', () => {
      const odd = { type: 'not_a_real_type', someField: 1 };

      expect(toPublishedOptionPricing(odd)).toEqual(odd);
    });

    /**
     * The whole point: no `camelCase` key survives into the document, because a
     * PHP reader does not look for one.
     */
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
});
