import { Presentation } from '../../common/database/enums';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { ErrorDetail } from '../../common/http/api-response.types';
import { OptionTypeValidator } from './option-type.validator';
import { findType } from './type-registry';

/**
 * The API boundary.
 *
 * **M7.3's acceptance criterion in full: "malformed pricing config is rejected at
 * the API boundary with a precise error."** Both halves are tested — that it is
 * rejected, and that the error names the field, because MySQL accepts
 * `{"amountMinor":"ten"}` as valid JSON and the mistake otherwise surfaces at a
 * customer's checkout.
 */
describe('OptionTypeValidator', () => {
  const validator = new OptionTypeValidator();

  /** Pull the structured details out of a thrown DomainException. */
  function detailsFrom(fn: () => void): ErrorDetail[] {
    try {
      fn();
    } catch (error) {
      const exception = error as DomainException;

      expect(exception.code).toBe(ErrorCode.VALIDATION_FAILED);

      return exception.details ?? [];
    }

    throw new Error('expected a validation error, and none was thrown');
  }

  describe('option types', () => {
    it('accepts a well-formed radio', () => {
      expect(() =>
        validator.assertValidOption(Presentation.RADIO, {
          validation: { minSelections: 1, maxSelections: 1 },
          display: { columns: 2 },
          pricing: null,
        }),
      ).not.toThrow();
    });

    it('accepts an option that configures nothing', () => {
      expect(() => validator.assertValidOption(Presentation.RADIO, {})).not.toThrow();
    });

    /**
     * A type Phase 14 will add but Phase 7 has not. The message names what *is*
     * available, because "unsupported" without a list is a dead end.
     */
    it('names the supported types when one is unavailable', () => {
      /*
       * ✏️ **The rotation ended here.** This named whichever presentation was
       * still unregistered — `DROPDOWN`, then `TEXT_FIELD`, `NUMBER_FIELD`,
       * `DATE_PICKER`, and finally `FILE_INPUT`, described at the time as "the
       * last honest choice". Phase 15 registers it, so **every member of
       * `Presentation` is registered** and no enum value can serve any more.
       *
       * A string outside the enum is used instead, and it tests the same thing
       * better: the route must answer `UNSUPPORTED_OPTION_TYPE` for input it
       * does not recognise, whether that input is a future presentation or a
       * typo in a request body. Pointing this at a registered type would make it
       * pass for the wrong reason; pointing it at a string cannot go stale.
       */
      const details = detailsFrom(() => validator.assertValidOption('not-a-presentation', {}));

      expect(details[0].field).toBe('presentation');
      expect(details[0].code).toBe('UNSUPPORTED_OPTION_TYPE');
    });
  });

  describe('the three axes must agree with the type', () => {
    /**
     * The registry says `radio` is `choice`/`one`. Nothing in the column
     * definitions prevents `radio`/`text`/`many`, and no renderer, validator or
     * pricing path can do anything with it — the axes carry the behaviour
     * (M5.4b), so an incoherent triple is an option that exists and cannot work.
     */
    it('accepts the combination the registry declares', () => {
      expect(() =>
        validator.assertValidOption(Presentation.RADIO, {
          valueKind: 'choice',
          cardinality: 'one',
        }),
      ).not.toThrow();
    });

    it('rejects a value kind the type does not produce', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.RADIO, { valueKind: 'text' }),
      );

      expect(details[0].field).toBe('valueKind');
      expect(details[0].code).toBe('INCOMPATIBLE_AXIS');
    });

    it('rejects a cardinality the type does not support', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.RADIO, { cardinality: 'many' }),
      );

      expect(details[0].field).toBe('cardinality');
      expect(details[0].code).toBe('INCOMPATIBLE_AXIS');
    });

    /** The message says what the type does support, not merely that it failed. */
    it('names what the type actually supports', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.RADIO, { cardinality: 'many' }),
      );

      expect(String(details[0].params?.message)).toMatch(/supports one/);
    });

    /**
     * ✅ **A checkbox may be a multi-select — the gate M18.3 opened.**
     *
     * Withheld until M18.1–M18.2 built the array path through the resolver,
     * the cart, the labels and the order: declaring it earlier would have let
     * the API accept a selection `SelectionResolver` refused, so a merchant
     * could author and publish something a customer then hit an error on.
     */
    it('accepts many for a checkbox', () => {
      expect(() =>
        validator.assertValidOption(Presentation.CHECKBOX, { cardinality: 'many' }),
      ).not.toThrow();
    });

    /**
     * ⚠️ The control: widening one type must not widen its neighbours.
     *
     * `radio`, `color_swatch` and `image_swatch` share the checkbox's axes and
     * sit beside it in the registry. A radio at `many` sells two sizes of one
     * shirt — measured in the plugin before its own guard landed.
     */
    it('still refuses many for the types that cannot take it', () => {
      [Presentation.RADIO, Presentation.COLOR_SWATCH, Presentation.IMAGE_SWATCH].forEach(
        (presentation) => {
          const details = detailsFrom(() =>
            validator.assertValidOption(presentation, { cardinality: 'many' }),
          );

          expect(details[0].code).toBe('INCOMPATIBLE_AXIS');
        },
      );
    });

    /** Absent axes are not a mistake — a patch need not restate them. */
    it('skips an axis that was not supplied', () => {
      expect(() => validator.assertValidOption(Presentation.RADIO, {})).not.toThrow();
    });

    it('reports both axes together when both are wrong', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.RADIO, {
          valueKind: 'file',
          cardinality: 'many',
        }),
      );

      expect(details.map((d) => d.field).sort()).toEqual(['cardinality', 'valueKind']);
    });
  });

  describe('precise errors', () => {
    /** The named acceptance case. */
    it('rejects a decimal amount and names the exact field', () => {
      const details = detailsFrom(() =>
        validator.assertValidValuePricing({ type: 'fixed', amountMinor: 10.5 }),
      );

      expect(details[0].field).toBe('priceConfig.amountMinor');
      expect(details[0].code).toBe('INVALID_TYPE');
    });

    it('names the value by index when validating a list', () => {
      const details = detailsFrom(() =>
        validator.assertValidValuePricing({ type: 'fixed', amountMinor: 10.5 }, 3),
      );

      expect(details[0].field).toBe('values.3.priceConfig.amountMinor');
    });

    /**
     * A path into an array element, not just a field name.
     *
     * Validated through `assertValidOption` since M16.3: `tiered` moved to the
     * option level, so a value can no longer carry one. The property under test
     * is unchanged — that a merchant is told *which* tier is wrong, because "a
     * tier is invalid" leaves them counting brackets by hand.
     */
    it('reaches into a nested tier', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.NUMBER_FIELD, {
          pricing: {
            type: 'tiered',
            tiers: [
              { minQuantity: 1, maxQuantity: 9, amountMinor: 100 },
              { minQuantity: 20, maxQuantity: null, amountMinor: 90 },
            ],
          },
        }),
      );

      expect(details[0].field).toBe('pricing.tiers.1.minQuantity');
    });

    it('prefixes the column being validated', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.RADIO, { display: { columns: 99 } }),
      );

      expect(details[0].field).toBe('display.columns');
      expect(details[0].code).toBe('TOO_BIG');
    });

    /**
     * All three columns are checked before throwing, so a merchant fixing a form
     * sees every problem at once rather than one per submission.
     */
    it('reports problems in every column together', () => {
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.RADIO, {
          validation: { minSelections: 5, maxSelections: 1 },
          display: { columns: 99 },
          pricing: { type: 'fixed', amountMinor: 100 },
        }),
      );

      const fields = details.map((d) => d.field);

      expect(fields.some((f) => f.startsWith('validation'))).toBe(true);
      expect(fields.some((f) => f.startsWith('display'))).toBe(true);
      expect(fields.some((f) => f.startsWith('pricing'))).toBe(true);
    });

    it('carries a human-readable message alongside the code', () => {
      try {
        validator.assertValidValuePricing({ type: 'fixed', amountMinor: 10.5 });
        throw new Error('expected a throw');
      } catch (error) {
        const details = (error as DomainException).details ?? [];

        expect(String(details[0].params?.message)).toMatch(/whole number of minor units/);
      }
    });
  });

  describe('nullable columns', () => {
    /** All three columns are nullable; not configuring one is not a mistake. */
    it('skips a column that was not supplied', () => {
      expect(() =>
        validator.assertValidOption(Presentation.RADIO, { validation: undefined }),
      ).not.toThrow();
    });

    it('still validates an explicit null against the schema', () => {
      // A radio's pricing schema requires null, so null passes and an object does not.
      expect(() =>
        validator.assertValidOption(Presentation.RADIO, { pricing: null }),
      ).not.toThrow();
    });
  });

  describe('value pricing', () => {
    it('accepts every price type a VALUE may carry', () => {
      const configs = [
        { type: 'fixed', amountMinor: 1000 },
        { type: 'percentage', basisPoints: 250 },
      ];

      configs.forEach((config) => {
        expect(() => validator.assertValidValuePricing(config)).not.toThrow();
      });
    });

    /**
     * 🔴 The option-level types are refused HERE, which is the point.
     *
     * `per_char`, `per_unit` and `tiered` price what the customer *supplied*
     * rather than which value they picked, and the options that supply a string
     * or a quantity have no values to hang a `price_config` on.
     *
     * `tiered` was accepted here until M16.3, which made it configurable **only**
     * where it cannot work: on a radio choice, which has no quantity to bracket.
     * A merchant could save a tiered price and have it charge nothing — the
     * evaluator reported it as unpriced, correctly, and the API had let them.
     */
    it.each([
      ['per_unit', { type: 'per_unit', amountMinor: 50 }],
      ['per_char', { type: 'per_char', amountMinor: 25 }],
      ['tiered', { type: 'tiered', tiers: [{ minQuantity: 1, maxQuantity: null, amountMinor: 100 }] }],
    ])('refuses %s on a value, because it belongs on the option', (_name, config) => {
      expect(() => validator.assertValidValuePricing(config)).toThrow();
    });

    it('rejects an unknown price type', () => {
      const details = detailsFrom(() =>
        validator.assertValidValuePricing({ type: 'barter', amountMinor: 1 }),
      );

      expect(details).not.toHaveLength(0);
    });
  });

  describe('a stored config whose schema has moved on', () => {
    const radio = findType(Presentation.RADIO);

    /**
     * 🔴 **The defect this exists to prevent: an option nobody can edit.**
     *
     * `OptionsService.update()` re-validates the STORED `display`, and the
     * display schemas are `.strict()` — so a row holding a field withdrawn in
     * M18.6a (ADR-064) failed with `unrecognized_keys`, and the merchant could
     * not change its label, its price, or clear the offending field, because
     * clearing it requires an update.
     *
     * ⚠️ **ADR-056 is the obligation.** Withdrawing the `show` rule action
     * degraded harmlessly because every evaluator IGNORES an action it does not
     * know. `.strict()` REJECTS, so a config withdrawal has to be made to
     * degrade the same way.
     */
    it('drops a key the schema no longer recognises', () => {
      const stored = { columns: 3, labelPlacement: 'above', showPriceDelta: true };

      expect(radio?.displaySchema.safeParse(stored).success).toBe(false);

      const cleaned = validator.stripWithdrawn(radio!.displaySchema, stored);

      expect(cleaned).toEqual({ columns: 3 });
      expect(radio?.displaySchema.safeParse(cleaned).success).toBe(true);
    });

    /**
     * 🔴 **A wrong VALUE is not forgiven, only a withdrawn KEY.**
     *
     * `columns: 99` breaks a bound the schema still enforces. Returning it
     * unchanged is what keeps `assertValidOption` reporting it — a strip that
     * swallowed every failure would turn this guard into a way of accepting
     * anything the database happened to hold.
     */
    it('leaves a value that breaks a bound alone', () => {
      expect(validator.stripWithdrawn(radio!.displaySchema, { columns: 99 })).toEqual({
        columns: 99,
      });
    });

    /**
     * 🔴 **A row with BOTH problems keeps the bad value and loses the dead key.**
     *
     * The case that decides whether this method forgives too much: `columns:
     * 99` breaks a bound the schema still enforces, and `labelPlacement` is
     * withdrawn. The key goes; the bad value stays, so `assertValidOption`
     * still refuses the update and tells the merchant which bound they broke.
     *
     * ⚠️ **The `unrecognized_keys` filter is redundant *today* and kept
     * deliberately.** Measured: other issue codes carry no `keys` field, so
     * filtering on all of them strips exactly the same set. It states the
     * intent, and it is what stops a future Zod version — one that attached
     * `keys` to some other issue — from turning this into a way of deleting
     * whatever the database happened to hold.
     */
    it('drops the withdrawn key and keeps the invalid value', () => {
      expect(
        validator.stripWithdrawn(radio!.displaySchema, { columns: 99, labelPlacement: 'above' }),
      ).toEqual({ columns: 99 });
    });

    /** A config that already parses is returned untouched. */
    it('changes nothing when the stored value is valid', () => {
      const stored = { columns: 2, priceDisplay: 'total' };

      expect(validator.stripWithdrawn(radio!.displaySchema, stored)).toBe(stored);
    });

    /**
     * ⚠️ **`null` is the common case** — most options store no display config
     * at all — and it must pass through rather than becoming `{}`, which would
     * write an empty object into every row that had none.
     */
    it('passes null and non-objects through', () => {
      expect(validator.stripWithdrawn(radio!.displaySchema, null)).toBeNull();
      expect(validator.stripWithdrawn(radio!.displaySchema, 'nonsense')).toBe('nonsense');
    });
  });

});
