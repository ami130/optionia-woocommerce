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
}).strict();

/** A percentage of the base product price. */
const percentagePricing = z.object({
  type: z.literal('percentage'),
  basisPoints: percentageBasisPoints,
}).strict();

/**
 * An amount per unit of quantity.
 *
 * Exported since M16.2, for the reason `perCharPricing` is: the **type
 * registry** needs this exact shape, because `per_unit` is an option-level type
 * and a number option's `pricingSchema` must accept it and nothing else.
 *
 * ⚠️ **No `freeUnits`, deliberately.** `per_char` has `freeCharacters` because a
 * merchant absorbing a short engraving is a real intent. A free-unit allowance
 * is a **volume discount**, which is what `tiered` expresses — with brackets a
 * merchant can see and reason about. Two mechanisms for one intent is two places
 * for them to disagree.
 */
export const perUnitPricing = z.object({
  type: z.literal('per_unit'),
  amountMinor,
}).strict();

/**
 * An amount per character, for engraving and similar.
 *
 * Exported since M16.2, because the **type registry** needs this exact shape:
 * `per_char` is the one type `PRICING-SPEC.md` defines at the option level, and
 * a text option's `pricingSchema` must accept it and nothing else. Restating the
 * shape there would be two definitions of one wire contract — which is the
 * defect `toPublishedPriceConfig` exists to prevent, one layer up.
 */
export const perCharPricing = z.object({
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
}).strict();

/**
 * Tiered pricing: brackets by quantity.
 *
 * Exported since M16.3, for the reason `perCharPricing` and `perUnitPricing`
 * are: the **type registry** needs this exact shape, because `tiered` is an
 * option-level type and a number option's `pricingSchema` must accept it.
 *
 * The brackets are validated as a set rather than individually, because the
 * failures that matter are relationships — a gap between tiers, an overlap, a
 * tier that starts above where it ends. Each is a wrong charge rather than a
 * malformed document, and none is visible from a single bracket.
 */
export const tieredPricing = z
  .object({
    type: z.literal('tiered'),
    tiers: z
      .array(
        z.object({
          minQuantity: z.number().int().min(1),
          maxQuantity: z.number().int().min(1).nullable(),
          amountMinor,
        })
  .strict(),
      )
      .min(1, 'Tiered pricing needs at least one tier.')
      .max(50, 'More than 50 tiers is almost certainly a mistake.'),
  })
  .superRefine((value, ctx) => {
    const sorted = [...value.tiers].sort((a, b) => a.minQuantity - b.minQuantity);

    /*
     * 🔴 **Every quantity from 1 upward must be covered.**
     *
     * Gaps *between* tiers were refused from the start; gaps at the **ends**
     * were not. Measured before M16.3: `[{min: 5, max: null}]` was accepted with
     * quantities 1-4 unpriced, and `[{1-9}, {10-20}]` with 21 upward unpriced —
     * `[{100-200}]` left both ends open at once.
     *
     * A bracket set that does not cover a quantity the customer can enter is a
     * configuration whose behaviour nobody decided: the evaluator must either
     * charge nothing, which is a silent free option, or report it, which reads
     * to a merchant as a bug in a price they successfully saved.
     *
     * A merchant wanting a minimum order sets `min` on the option — a validation
     * rule, which produces a message the customer can act on.
     */
    if (sorted.length > 0 && sorted[0].minQuantity !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiers', 0, 'minQuantity'],
        message:
          `Tiers must start at 1; quantities 1 to ${sorted[0].minQuantity - 1} would be ` +
          `unpriced. Use the option's own minimum to require a larger order.`,
      });
    }

    const last = sorted[sorted.length - 1];

    if (last && last.maxQuantity !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiers', sorted.length - 1, 'maxQuantity'],
        message:
          `The last tier must be open-ended; quantities above ${last.maxQuantity} would be ` +
          `unpriced. Use the option's own maximum to cap the order.`,
      });
    }

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

/*
 * 🔴 **Every price shape above is `.strict()`.**
 *
 * Zod's default strips an unknown key silently, so a merchant who set
 * `freeUnits: 5` on a `per_unit` price -- a real thing to reach for, since
 * `per_char` has `freeCharacters` -- saved successfully and was charged as
 * though they had set nothing. Nothing wrong is stored and nothing wrong is
 * charged; the setting simply evaporates, which is the hardest kind of bug for a
 * merchant to diagnose because the UI accepted it.
 *
 * `.strict()` turns that into a validation error naming the field, which is what
 * the authoring API is for. It also makes a typo in a field a merchant DOES have
 * -- `freeCharacter` for `freeCharacters` -- fail loudly rather than quietly
 * charging from the first character.
 */
/**
 * Any pricing configuration.
 *
 * A discriminated union, so an unknown `type` produces "expected one of…" rather
 * than a list of every failed branch. The error a merchant sees is the difference
 * between a usable message and a wall of noise.
 */
/*
 * 🔴 **The VALUE-level union. `per_char`, `per_unit` and `tiered` are not in it.**
 *
 * `PRICING-SPEC.md` §2 places all three at the **option** level, because each
 * prices what the customer *supplied* rather than which value they picked — and
 * the options that supply a quantity or a string have no values to hang a
 * `price_config` on.
 *
 * `tiered` was in this union until M16.3, which made it configurable **only**
 * where it cannot work: on a radio choice, which has no quantity to bracket. The
 * evaluator reported it as unpriced, correctly, so a merchant could save a
 * tiered price and have it charge nothing.
 *
 * The three option-level shapes live in the type registry instead, each attached
 * to the presentations whose answer they can price.
 */
export const pricingConfigSchema = z.discriminatedUnion('type', [
  fixedPricing,
  percentagePricing,
]);

export type PricingConfig = z.infer<typeof pricingConfigSchema>;
