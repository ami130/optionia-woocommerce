import { PriceType } from '@/lib/money/price-type';

/**
 * The document dialect, for the parts of a preview that need it (ADR-103).
 *
 * 🔴 **The two evaluators take opposite shapes**, which is the most surprising
 * fact in this phase and the reason this file exists:
 *
 * | Evaluator | Reads | Dialect |
 * | --- | --- | --- |
 * | `priceConfigDelta` | `amount_minor`, `basis_points` | snake_case — published |
 * | `rule-evaluator` | `targetType`, `matchType` | camelCase — authoring |
 *
 * The authoring tree stores `amountMinor`, so handing the raw tree to both gives
 * **correct rules and silently zero prices** — the failure already recorded once,
 * where every real `priceConfig` showed "could not be priced".
 *
 * ⚠️ **So pricing converts and rules do not.** That reads as an inconsistency and
 * is not: the two evaluators were written at different times against the data
 * each had, and normalising them would mean editing shared logic whose
 * cross-repository equivalence is what `bin/check-evaluator-parity.sh` protects —
 * to serve a third consumer.
 *
 * 📌 **`toPublishedPriceConfig` already lives in `to-wire-price-config.ts`**,
 * copied during M20 for exactly this reason. These are its missing siblings.
 */

/**
 * Storage key → document key, for `validation`'s flat bag of independent rules.
 *
 * 🔴 **Copied verbatim from the serializer's `VALIDATION_KEYS`, all 17 entries.**
 * `rename()` passes an unmapped key **through unchanged**, so a rule missing from
 * this map publishes in the stored spelling — present in the document and
 * enforced nowhere. That has happened in this codebase repeatedly:
 * `minSelections` shipped camelCase until M18.3a, and `integerOnly` was caught
 * only by a gate as `number_field` shipped.
 *
 * ⚠️ **Keys that need no rename are listed anyway** — `min`, `max`, `step`,
 * `pattern` are already lower-case. They are here so this map is the *complete*
 * statement of what the document carries, which is what makes a missing key
 * visible rather than something a reader must cross-check against the plugin.
 */
const VALIDATION_KEYS: Readonly<Record<string, string>> = {
  minLength: 'min_length',
  maxLength: 'max_length',

  /* Numeric rules (M14.4). */
  min: 'min',
  max: 'max',
  step: 'step',
  integerOnly: 'integer_only',

  /* Content rules (M14.4). */
  pattern: 'pattern',
  allowedCharset: 'allowed_charset',
  forbiddenWords: 'forbidden_words',

  /* Date rules (M14.2). */
  minDate: 'min_date',
  maxDate: 'max_date',
  blackoutDates: 'blackout_dates',
  allowedWeekdays: 'allowed_weekdays',
  leadTimeDays: 'lead_time_days',
  maxAdvanceDays: 'max_advance_days',

  /* Selection counts (M5.4b, published from M18.3a). */
  minSelections: 'min_selections',
  maxSelections: 'max_selections',
};

/** Storage key → document key, for `display`'s flat bag of independent rules. */
const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  characterCounter: 'character_counter',

  /* Display config (M14.4b). */
  priceDisplay: 'price_display',
  swatchSize: 'swatch_size',
  collapsedByDefault: 'collapsed_by_default',
  tooltip: 'tooltip',
  columns: 'columns',
};

/**
 * Rename the keys a payload actually carries, leaving the rest untouched.
 *
 * ⚠️ Unmapped keys pass through rather than being dropped. A key the map does not
 * know is either new or wrong, and silently discarding it would hide both.
 */
function rename(
  source: Record<string, unknown> | null | undefined,
  keys: Readonly<Record<string, string>>,
): Record<string, unknown> | null | undefined {
  /* `undefined` survives rather than collapsing to `null` — see
   * `toPublishedOptionPricing` for why the preview needs the two kept apart. */
  if (source === undefined) {
    return undefined;
  }

  if (!source) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [keys[key] ?? key, value]),
  );
}

/**
 * An option's `validation`, in the document's convention.
 *
 * 🔴 **The preview must convert this too, and did not until M21.1 step 4.**
 * `previewTree()` converted `pricing` and `display` while the serializer
 * converts three things. A renderer enforcing `validation.maxLength` would work
 * against the authoring spelling while the storefront reads `max_length` — a
 * limit the preview honours and the shop does not.
 */
export function toPublishedValidation(
  validation: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  return rename(validation, VALIDATION_KEYS);
}

/** An option's `display`, in the document's convention. */
export function toPublishedDisplay(
  display: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  return rename(display, DISPLAY_KEYS);
}

/**
 * An option's `pricing`, in the document's convention.
 *
 * ## Why this is per type rather than a key rename
 *
 * `display` is a flat bag of independent rules, so renaming its keys is the whole
 * job. `pricing` is a **discriminated union**: which fields are meaningful depends
 * on `type`. Adding a type to the registry should mean deciding what its document
 * shape is, not inheriting one by accident.
 */
export function toPublishedOptionPricing(
  pricing: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  /*
   * ⚠️ **`undefined` is not `null` here**, which is the one behavioural
   * difference from the serializer. The serializer reads a stored row, where the
   * field is either absent-as-null or complete; the preview reads a draft the
   * merchant is still filling in, and "not chosen yet" has to survive the round
   * trip or the preview renders a priced option as free.
   */
  if (pricing === undefined) {
    return undefined;
  }

  if (!pricing) {
    return null;
  }

  switch (pricing.type) {
    case PriceType.PER_CHAR:
      return {
        type: pricing.type,
        amount_minor: pricing.amountMinor,
        /*
         * Explicit rather than omitted when zero: a reader must tell "charge from
         * the first character" from "the merchant never set this", even though
         * both behave the same.
         */
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
      /*
       * Visible and wrong-looking beats silently absent — the same choice
       * `toPublishedPriceConfig` makes for a type the registry grew and this did
       * not.
       *
       * ✏️ **The whole object, not `{ type }`.** A first draft of this port
       * returned only the discriminant, which drops every other field — the
       * "silently absent" outcome the backend's own comment argues against, and
       * caught by porting its test alongside it.
       */
      return pricing;
  }
}
