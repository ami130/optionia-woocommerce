import { PriceType } from '../../common/database/enums';

/**
 * The `price_config` object as it appears in the config document.
 *
 * ## Why this exists
 *
 * The stored shape is `camelCase` — `amountMinor`, `basisPoints`,
 * `freeCharacters`, `minQuantity` — because it is validated by a Zod schema
 * written in TypeScript (M7.3). The document is `snake_case`, because it is read
 * by a PHP plugin.
 *
 * Passing the stored object through unchanged produced a document carrying
 * **two spellings of the same field**: a value priced through `price_config`
 * emitted `amountMinor`, and one priced through the `price_type` /
 * `price_amount_minor` columns emitted `amount_minor`. A PHP evaluator reading
 * `price_config['amount_minor']` would get `null` for every value configured the
 * first way — the exact "two ways to disagree" that one price shape exists to
 * prevent, reintroduced by the fallback.
 *
 * ## Why it is written out per type rather than walked
 *
 * A generic camelCase-to-snake_case converter would convert keys nobody decided
 * about, including anything a future pricing type adds, and would rename keys
 * inside a merchant's arbitrary JSON. Each type is mapped explicitly, so adding
 * one to the registry means deciding what its document shape is — the same
 * property the projections have.
 *
 * An unrecognised type is passed through unchanged rather than dropped: the
 * validator refuses unknown types at the API boundary, so a stored one means the
 * registry grew and this did not. Emitting it verbatim keeps the data visible
 * and wrong-looking, which is easier to notice than a value that silently
 * loses its price.
 */
export function toPublishedPriceConfig(
  priceConfig: Record<string, unknown> | null,
  fallback: { priceType: string; priceAmountMinor: number },
): Record<string, unknown> {
  if (!priceConfig) {
    // No JSON configured: the columns are the price. Every choice-type value
    // takes this path, because a radio prices per value rather than per option.
    return { type: fallback.priceType, amount_minor: fallback.priceAmountMinor };
  }

  const type = priceConfig.type;

  switch (type) {
    case PriceType.FIXED:
    case PriceType.PER_UNIT:
      return {
        type,
        amount_minor: priceConfig.amountMinor,
      };

    case PriceType.PERCENTAGE:
      return {
        type,
        basis_points: priceConfig.basisPoints,
      };

    case PriceType.PER_CHAR:
      return {
        type,
        amount_minor: priceConfig.amountMinor,
        free_characters: priceConfig.freeCharacters ?? 0,
      };

    case PriceType.TIERED:
      return {
        type,
        tiers: (Array.isArray(priceConfig.tiers) ? priceConfig.tiers : []).map((tier) => {
          const bracket = tier as Record<string, unknown>;

          return {
            min_quantity: bracket.minQuantity,
            // Explicitly null rather than omitted: `null` means "open-ended",
            // which is a value the evaluator must distinguish from "absent".
            max_quantity: bracket.maxQuantity ?? null,
            amount_minor: bracket.amountMinor,
          };
        }),
      };

    default:
      return priceConfig;
  }
}
