/**
 * An option's `validation` and `display` objects, as they appear in the config
 * document.
 *
 * ## Why this exists
 *
 * The same reason `toPublishedPriceConfig` does, one field over. The stored
 * shape is `camelCase` — `maxLength`, `characterCounter` — because it is
 * validated by a Zod schema written in TypeScript. The document is `snake_case`,
 * because it is read by a PHP plugin.
 *
 * `validation` and `display` were published **verbatim**, so a `maxLength` a
 * merchant set reached the plugin spelled in a way its reader does not look for:
 * the limit would exist in the document, be enforced nowhere, and a customer
 * could type past it. Silent, and in the direction that produces a wrong
 * engraving rather than an error.
 *
 * ## Why it is written out per key rather than walked
 *
 * A generic converter would rename keys inside merchant-authored JSON and would
 * silently convert whatever a future rule adds, deciding a wire contract by
 * accident. Each key is mapped explicitly, so adding a rule to the catalogue
 * (M14.4) means deciding what its document shape is.
 *
 * Unrecognised keys pass through unchanged rather than being dropped: the API
 * shape-checks these objects against the registry, so an unmapped key means the
 * schema grew and this did not. Emitting it verbatim keeps it visible and
 * wrong-looking, which is easier to notice than a rule that quietly disappears.
 */

import { PriceType } from '../../common/database/enums';

/** Stored key → document key, for every rule the plugin reads. */
const VALIDATION_KEYS: Readonly<Record<string, string>> = {
  minLength: 'min_length',
  maxLength: 'max_length',

  /*
   * Numeric rules (M14.4). `min`, `max` and `step` are already lower-case and
   * pass through unchanged — they are listed anyway so this map is the complete
   * statement of what the document carries, rather than a partial one a reader
   * has to cross-check against the plugin.
   *
   * ⚠️ `integerOnly` is the one that actually needed renaming, and it was
   * missed: `bin/check-wire-keys.sh` caught it the moment `number_field` shipped
   * — the plugin reads `integer_only`, and the rule would have been published in
   * a spelling nothing looks for, so every fractional quantity would have been
   * accepted.
   */
  min: 'min',
  max: 'max',
  step: 'step',
  integerOnly: 'integer_only',

  /*
   * Content rules (M14.4). `pattern` is already lower-case; the other two need
   * renaming, and `bin/check-wire-keys.sh` failed the moment they were added to
   * the schema — the second time that gate has caught a rule mid-flight rather
   * than after a customer met it.
   */
  pattern: 'pattern',
  allowedCharset: 'allowed_charset',
  forbiddenWords: 'forbidden_words',

  /*
   * Date rules (M14.2). The gate caught all six at once — the fourth time it has
   * named a rule in transit rather than after a customer met it.
   */
  minDate: 'min_date',
  maxDate: 'max_date',
  blackoutDates: 'blackout_dates',
  allowedWeekdays: 'allowed_weekdays',
  leadTimeDays: 'lead_time_days',
  maxAdvanceDays: 'max_advance_days',
};

/** Stored key → document key, for every display affordance the plugin reads. */
const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  characterCounter: 'character_counter',
  labelPlacement: 'label_placement',
  showPriceDelta: 'show_price_delta',

  /* Display config (M14.4b). */
  priceDisplay: 'price_display',
  swatchSize: 'swatch_size',
  collapsedByDefault: 'collapsed_by_default',
  tooltip: 'tooltip',
  columns: 'columns',
};

function rename(
  source: Record<string, unknown> | null,
  keys: Readonly<Record<string, string>>,
): Record<string, unknown> | null {
  if (!source) {
    return null;
  }

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    out[keys[key] ?? key] = value;
  }

  return out;
}

/** An option's `validation`, in the document's convention. */
export function toPublishedValidation(
  validation: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return rename(validation, VALIDATION_KEYS);
}

/** An option's `display`, in the document's convention. */
export function toPublishedDisplay(
  display: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return rename(display, DISPLAY_KEYS);
}

/**
 * An option's `pricing`, in the document's convention.
 *
 * ## Why this is per type rather than a key rename
 *
 * `validation` and `display` are flat bags of independent rules, so renaming
 * their keys is the whole job. `pricing` is a **discriminated union**: what
 * fields are meaningful depends on `type`, and the same reasoning that made
 * `toPublishedPriceConfig` map per type applies one field over. Adding a type to
 * the registry should mean deciding what its document shape is, not inheriting
 * one by accident.
 *
 * 🔴 **This field was published verbatim until M16.2.** Values went through
 * `toPublishedPriceConfig` and options did not, so a `per_char` price reached
 * the plugin as `{ type, amountMinor, freeCharacters }` while
 * `CONFIG-CONTRACT.md` documented `{ type, amount_minor, free_characters }`.
 * Latent only because the plugin read `type` and nothing else -- which spells
 * the same either way. The first evaluator to read the amount would have found
 * the field absent and charged **nothing**, silently, for every engraving.
 *
 * Exactly the defect this file was created to fix for `maxLength`, in the field
 * next to it.
 *
 * ## Where each type belongs
 *
 * `PRICING-SPEC.md` §2 defines `per_char` at the option level and every other
 * type at the value level. An option carrying some other type is still
 * converted rather than dropped: the plugin reports what it cannot price, and it
 * can only report a type it can read.
 *
 * @param pricing The stored `pricing` object, or null.
 * @returns The published shape, or null when the option has no option-level price.
 */
export function toPublishedOptionPricing(
  pricing: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!pricing) {
    return null;
  }

  switch (pricing.type) {
    case PriceType.PER_CHAR:
      return {
        type: pricing.type,
        amount_minor: pricing.amountMinor,
        // Explicit rather than omitted when zero: a reader must tell "charge
        // from the first character" from "the merchant never set this", even
        // though both behave the same. The schema defaults it, so the document
        // should state it.
        free_characters: pricing.freeCharacters ?? 0,
      };

    case PriceType.FIXED:
    case PriceType.PER_UNIT:
      return { type: pricing.type, amount_minor: pricing.amountMinor };

    case PriceType.PERCENTAGE:
      return { type: pricing.type, basis_points: pricing.basisPoints };

    case PriceType.TIERED:
      return {
        type: pricing.type,
        tiers: (Array.isArray(pricing.tiers) ? pricing.tiers : []).map((tier) => {
          const bracket = tier as Record<string, unknown>;

          return {
            min_quantity: bracket.minQuantity,
            max_quantity: bracket.maxQuantity ?? null,
            amount_minor: bracket.amountMinor,
          };
        }),
      };

    default:
      // Visible and wrong-looking beats silently absent -- the same choice
      // `toPublishedPriceConfig` makes for a type the registry grew and this
      // did not.
      return pricing;
  }
}
