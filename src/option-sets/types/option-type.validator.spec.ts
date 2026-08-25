import { Presentation } from '../../common/database/enums';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OptionTypeValidator } from './option-type.validator';

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
  function detailsFrom(fn: () => void): Array<{ field: string; code: string }> {
    try {
      fn();
    } catch (error) {
      const exception = error as DomainException;

      expect(exception.code).toBe(ErrorCode.VALIDATION_FAILED);

      return (exception.details ?? []) as Array<{ field: string; code: string }>;
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
      const details = detailsFrom(() =>
        validator.assertValidOption(Presentation.DROPDOWN, {}),
      );

      expect(details[0].field).toBe('presentation');
      expect(details[0].code).toBe('UNSUPPORTED_OPTION_TYPE');
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

    it('reaches into a nested tier', () => {
      const details = detailsFrom(() =>
        validator.assertValidValuePricing({
          type: 'tiered',
          tiers: [
            { minQuantity: 1, maxQuantity: 9, amountMinor: 100 },
            { minQuantity: 20, maxQuantity: null, amountMinor: 90 },
          ],
        }),
      );

      expect(details[0].field).toBe('priceConfig.tiers.1.minQuantity');
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
    it('accepts every supported price type', () => {
      const configs = [
        { type: 'fixed', amountMinor: 1000 },
        { type: 'percentage', basisPoints: 250 },
        { type: 'per_unit', amountMinor: 50 },
        { type: 'per_char', amountMinor: 25 },
        { type: 'tiered', tiers: [{ minQuantity: 1, maxQuantity: null, amountMinor: 100 }] },
      ];

      configs.forEach((config) => {
        expect(() => validator.assertValidValuePricing(config)).not.toThrow();
      });
    });

    it('rejects an unknown price type', () => {
      const details = detailsFrom(() =>
        validator.assertValidValuePricing({ type: 'barter', amountMinor: 1 }),
      );

      expect(details).not.toHaveLength(0);
    });
  });
});
