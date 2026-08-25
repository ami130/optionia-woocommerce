import { MAX_AMOUNT_MINOR, pricingConfigSchema } from './pricing.schema';

/**
 * Pricing configuration.
 *
 * **The acceptance criterion for M7.3 is that malformed pricing is rejected with
 * a precise error**, so these tests are as much about the message as the verdict:
 * a merchant told "pricing is invalid" has to guess, and one told which field and
 * why does not.
 */
describe('pricingConfigSchema', () => {
  describe('fixed', () => {
    it('accepts a whole number of minor units', () => {
      expect(pricingConfigSchema.safeParse({ type: 'fixed', amountMinor: 1000 }).success).toBe(
        true,
      );
    });

    it('accepts zero and a negative amount', () => {
      // A value can reduce the price — "no engraving" against a priced default.
      expect(pricingConfigSchema.safeParse({ type: 'fixed', amountMinor: 0 }).success).toBe(true);
      expect(pricingConfigSchema.safeParse({ type: 'fixed', amountMinor: -500 }).success).toBe(
        true,
      );
    });

    /**
     * The defect this exists to prevent. `10.50` looks like £10.50 and means ten
     * and a half pence — and truncating it silently would charge the wrong
     * amount forever.
     */
    it('rejects a decimal, and says why', () => {
      const result = pricingConfigSchema.safeParse({ type: 'fixed', amountMinor: 10.5 });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/whole number of minor units/);
      expect(result.error?.issues[0].message).toMatch(/1000 = £10\.00/);
    });

    it('rejects a string that looks like a number', () => {
      expect(
        pricingConfigSchema.safeParse({ type: 'fixed', amountMinor: '1000' }).success,
      ).toBe(false);
    });

    /** A typo of a few extra digits is caught where it happens. */
    it('rejects an implausible amount', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'fixed',
        amountMinor: MAX_AMOUNT_MINOR + 1,
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/implausibly large/);
    });

    it('rejects a missing amount', () => {
      expect(pricingConfigSchema.safeParse({ type: 'fixed' }).success).toBe(false);
    });
  });

  describe('percentage', () => {
    it('accepts basis points', () => {
      expect(
        pricingConfigSchema.safeParse({ type: 'percentage', basisPoints: 250 }).success,
      ).toBe(true);
    });

    /**
     * Basis points rather than a float, for the same reason money is minor
     * units: 0.1 + 0.2 !== 0.3, and a percentage that drifts produces a
     * different total on two machines.
     */
    it('rejects a fractional percentage', () => {
      const result = pricingConfigSchema.safeParse({ type: 'percentage', basisPoints: 2.5 });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/basis points/);
    });
  });

  describe('per_char', () => {
    it('defaults freeCharacters to zero', () => {
      const result = pricingConfigSchema.parse({ type: 'per_char', amountMinor: 50 });

      expect(result).toMatchObject({ freeCharacters: 0 });
    });

    it('accepts an explicit allowance', () => {
      const result = pricingConfigSchema.parse({
        type: 'per_char',
        amountMinor: 50,
        freeCharacters: 10,
      });

      expect(result).toMatchObject({ freeCharacters: 10 });
    });

    it('rejects a negative allowance', () => {
      expect(
        pricingConfigSchema.safeParse({ type: 'per_char', amountMinor: 50, freeCharacters: -1 })
          .success,
      ).toBe(false);
    });
  });

  describe('tiered', () => {
    const tier = (minQuantity: number, maxQuantity: number | null, amountMinor: number) => ({
      minQuantity,
      maxQuantity,
      amountMinor,
    });

    it('accepts contiguous tiers ending open-ended', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'tiered',
        tiers: [tier(1, 9, 1000), tier(10, 49, 900), tier(50, null, 800)],
      });

      expect(result.success).toBe(true);
    });

    /**
     * The relationship failures are the ones that matter — each is a wrong
     * charge rather than a malformed document, and none is visible from a single
     * bracket.
     */
    it('rejects a gap that would leave quantities unpriced', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'tiered',
        tiers: [tier(1, 9, 1000), tier(20, null, 800)],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/10 to 19 fall between tiers/);
    });

    it('rejects overlapping tiers', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'tiered',
        tiers: [tier(1, 20, 1000), tier(10, null, 800)],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/overlaps the previous one/);
    });

    it('rejects a tier that ends before it starts', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'tiered',
        tiers: [tier(10, 5, 1000)],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/ends at 5 but starts at 10/);
    });

    /** An unbounded tier in the middle swallows every bracket after it. */
    it('rejects an open-ended tier that is not last', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'tiered',
        tiers: [tier(1, null, 1000), tier(10, 20, 800)],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/Only the last tier may be open-ended/);
    });

    it('rejects an empty tier list', () => {
      const result = pricingConfigSchema.safeParse({ type: 'tiered', tiers: [] });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/at least one tier/);
    });

    it('names the offending tier by index', () => {
      const result = pricingConfigSchema.safeParse({
        type: 'tiered',
        tiers: [tier(1, 9, 1000), tier(20, null, 800)],
      });

      expect(result.error?.issues[0].path).toEqual(['tiers', 1, 'minQuantity']);
    });
  });

  describe('unknown types', () => {
    it('rejects a type that does not exist', () => {
      expect(pricingConfigSchema.safeParse({ type: 'magic', amountMinor: 1 }).success).toBe(
        false,
      );
    });

    it('rejects a missing type', () => {
      expect(pricingConfigSchema.safeParse({ amountMinor: 1000 }).success).toBe(false);
    });

    it('rejects a non-object', () => {
      expect(pricingConfigSchema.safeParse('fixed').success).toBe(false);
      expect(pricingConfigSchema.safeParse(null).success).toBe(false);
      expect(pricingConfigSchema.safeParse([]).success).toBe(false);
    });
  });
});
