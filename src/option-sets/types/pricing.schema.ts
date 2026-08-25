import { z } from 'zod';

/**
 * Pricing configuration, validated at the API boundary.
 *
 * **Money is an integer count of minor units, everywhere.** A price of £10.00 is
 * `1000`, never `10.00` — a float here becomes a rounding error in a merchant's
 * revenue, and the plugin, the wire format and the database all agree on this
 * already (ADR-013). The schema refuses a fractional amount rather than
 * truncating it, because silently charging 999 instead of 999.5 is worse than an
 * error a merchant can read.
 */

/**
 * The largest amount accepted: £10,000,000 in minor units.
 *
 * Not `Number.MAX_SAFE_INTEGER`. A price beyond this is a typo — a merchant who
 * meant £100 and typed the minor units twice — and accepting it means an order
 * total that overflows a display, a payment provider's limit, or an accountant's
 * patience. Rejecting at a plausible ceiling catches the typo where it happens.
 */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

/** An amount in minor units: a whole number, within a plausible range. */
const amountMinor = z
  .number()
  .int('Amount must be a whole number of minor units (1000 = £10.00), not a decimal.')
  .min(-MAX_AMOUNT_MINOR, 'Amount is implausibly large.')
  .max(MAX_AMOUNT_MINOR, 'Amount is implausibly large.');

/**
 * A percentage, as basis points.
 *
 * 250 is 2.5%. Basis points rather than a float for the same reason money is
 * minor units: `0.1 + 0.2 !== 0.3` in binary floating point, and a percentage
 * that drifts is a percentage that produces a different total on two machines.
 */
const percentageBasisPoints = z
  .number()
  .int('Percentage must be given in basis points (250 = 2.5%), not as a decimal.')
  .min(-100_000, 'Percentage is implausibly large.')
  .max(100_000, 'Percentage is implausibly large.');

/** A fixed amount added to the line price. */
const fixedPricing = z.object({
  type: z.literal('fixed'),
  amountMinor,
});

/** A percentage of the base product price. */
const percentagePricing = z.object({
  type: z.literal('percentage'),
  basisPoints: percentageBasisPoints,
});

/** An amount per unit of quantity. */
const perUnitPricing = z.object({
  type: z.literal('per_unit'),
  amountMinor,
});

/** An amount per character, for engraving and similar. */
const perCharPricing = z.object({
  type: z.literal('per_char'),
  amountMinor,
  /**
   * Characters included before charging starts.
   *
   * Defaulted rather than required: a merchant who does not think about it means
   * "charge from the first character", and requiring the field would make the
   * simple case harder than the complex one.
   */
  freeCharacters: z.number().int().min(0).max(10_000).default(0),
});

/**
 * Tiered pricing: brackets by quantity.
 *
 * The brackets are validated as a set rather than individually, because the
 * failures that matter are relationships — a gap between tiers, an overlap, a
 * tier that starts above where it ends. Each is a wrong charge rather than a
 * malformed document, and none is visible from a single bracket.
 */
const tieredPricing = z
  .object({
    type: z.literal('tiered'),
    tiers: z
      .array(
        z.object({
          minQuantity: z.number().int().min(1),
          maxQuantity: z.number().int().min(1).nullable(),
          amountMinor,
        }),
      )
      .min(1, 'Tiered pricing needs at least one tier.')
      .max(50, 'More than 50 tiers is almost certainly a mistake.'),
  })
  .superRefine((value, ctx) => {
    const sorted = [...value.tiers].sort((a, b) => a.minQuantity - b.minQuantity);

    sorted.forEach((tier, index) => {
      if (tier.maxQuantity !== null && tier.maxQuantity < tier.minQuantity) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiers', index, 'maxQuantity'],
          message: `Tier ends at ${tier.maxQuantity} but starts at ${tier.minQuantity}.`,
        });
      }

      // Only the last tier may be open-ended; an unbounded tier in the middle
      // swallows every bracket after it.
      if (tier.maxQuantity === null && index !== sorted.length - 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiers', index, 'maxQuantity'],
          message: 'Only the last tier may be open-ended.',
        });
      }

      const next = sorted[index + 1];

      if (next && tier.maxQuantity !== null) {
        if (next.minQuantity <= tier.maxQuantity) {
          ctx.addIssue({
            code: 'custom',
            path: ['tiers', index + 1, 'minQuantity'],
            message: `Tier overlaps the previous one, which ends at ${tier.maxQuantity}.`,
          });
        }

        if (next.minQuantity > tier.maxQuantity + 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['tiers', index + 1, 'minQuantity'],
            message:
              `Quantities ${tier.maxQuantity + 1} to ${next.minQuantity - 1} fall between ` +
              `tiers and would be unpriced.`,
          });
        }
      }
    });
  });

/**
 * Any pricing configuration.
 *
 * A discriminated union, so an unknown `type` produces "expected one of…" rather
 * than a list of every failed branch. The error a merchant sees is the difference
 * between a usable message and a wall of noise.
 */
export const pricingConfigSchema = z.discriminatedUnion('type', [
  fixedPricing,
  percentagePricing,
  perUnitPricing,
  perCharPricing,
  tieredPricing,
]);

export type PricingConfig = z.infer<typeof pricingConfigSchema>;
