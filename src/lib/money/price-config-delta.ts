import { PriceType } from './price-type';
import { measure } from './measure';
import { percentageOf } from './percentage';

/**
 * The step from a **published** price config to a delta in minor units.
 *
 * ## Why this exists, and why it is the cloud's first one
 *
 * Before M16.1 the cloud had `percentageOf` and `sumDeltas` and nothing between
 * them: it could round a percentage and it could add deltas, but nothing turned
 * `{type: 'percentage', basis_points: 500}` on a base of 10 into a delta of 1.
 * The plugin had that step and the cloud did not, so the shared fixture proved
 * both ENDS of pricing in two languages and the middle in one.
 *
 * That middle is precisely where two implementations diverge while both suites
 * stay green — read `basis_points` as a percent on one side and as basis points
 * on the other, and every existing test in both repositories still passes. So
 * this file is the counterpart to `Engine\SelectionResolver::delta_for()`, and
 * `pricing-fixtures.json`'s `config_cases` hold the two to the same answers.
 *
 * ## The shape it reads is the PUBLISHED one
 *
 * `snake_case`, as `toPublishedPriceConfig()` emits it and as the plugin reads
 * it — not the `camelCase` stored shape. The published document is the contract
 * between the two implementations; the stored shape is an internal detail of
 * this repository, and evaluating that instead would test a shape the plugin
 * never sees.
 *
 * ## Unimplemented types contribute nothing AND say so
 *
 * `PRICING-SPEC.md` §2 is normative: a type this build cannot price contributes
 * nothing and is reported. Returning 0 alone is the arithmetic half — 0 is also
 * indistinguishable from "this option is free", and on the plugin side that
 * ambiguity cost a merchant 40.00 per unit with nothing anywhere saying so.
 * `unpriced` is the other half.
 */

/**
 * Every price type this build charges.
 *
 * The plugin publishes the same list as `SelectionResolver::PRICED_TYPES`, and
 * the two growing apart is a real defect rather than a tidiness issue: a type
 * one side prices and the other reports as unpriceable produces two different
 * totals for one configuration.
 */
export const PRICED_TYPES: readonly string[] = [
  PriceType.FIXED,
  PriceType.PERCENTAGE,
  PriceType.PER_CHAR,
  PriceType.PER_UNIT,
  PriceType.TIERED,
];

/**
 * What one price config contributed, and whether it could be priced at all.
 */
export interface PriceConfigDelta {
  /** The contribution in minor units; may be negative, and is 0 when unpriced. */
  readonly deltaMinor: number;

  /**
   * The price type that could not be charged, or null.
   *
   * A string rather than a boolean so callers can name it: the plugin's admin
   * notice tells a merchant *which* type is going uncharged, and a boolean
   * would leave them looking through every option.
   */
  readonly unpriced: string | null;
}

/**
 * The delta a published price config contributes against a base price.
 *
 * `baseMinor` is the **product's own price**, and it is the base for every
 * percentage in a selection — never a running total. Two 50% options on an
 * 80.00 product add 40.00 each, not 40.00 and 60.00: compounding would make the
 * total depend on option order, which the published schema does not define and
 * the customer cannot see.
 *
 * @param config The published `price_config`, or null when a value has none.
 * @param baseMinor The product's own price, in integer minor units.
 * @returns The delta and, when the type could not be charged, its name.
 * @throws RangeError When `baseMinor` is not a safe integer.
 */
export function priceConfigDelta(
  config: Record<string, unknown> | null | undefined,
  baseMinor: number,
): PriceConfigDelta {
  if (!Number.isSafeInteger(baseMinor)) {
    throw new RangeError('A base price must be an integer number of minor units.');
  }

  if (!config || typeof config !== 'object') {
    // A value may legitimately be free. Not an error, and nothing to report.
    return { deltaMinor: 0, unpriced: null };
  }

  const type = typeof config.type === 'string' ? config.type : '';

  if (type === PriceType.FIXED) {
    const amount = config.amount_minor;

    // A malformed amount is reported rather than coerced. `Number(x) || 0`
    // would turn `"abc"` into a free option and `"500"` into a charge, so a
    // publish bug becomes either a silent giveaway or a charge nobody
    // configured — both indistinguishable from a deliberate 0.
    return Number.isSafeInteger(amount)
      ? { deltaMinor: amount as number, unpriced: null }
      : { deltaMinor: 0, unpriced: type };
  }

  if (type === PriceType.PERCENTAGE) {
    const points = config.basis_points;

    if (!Number.isSafeInteger(points)) {
      return { deltaMinor: 0, unpriced: type };
    }

    /*
     * `percentageOf` throws when the product leaves the safe integer range, and
     * an unpriceable amount is reported here rather than raised.
     *
     * The plugin makes the same choice, and the audit that found it there is
     * why: its uncaught `RangeException` escaped into
     * `woocommerce_before_calculate_totals` and fatalled cart and checkout. That
     * exact exposure does not exist in this repository -- nothing calls this in
     * production yet -- but the two evaluators disagreeing about what an
     * impossible number means is precisely what `config_cases` exists to
     * prevent, and a divergence introduced *before* the first caller is one
     * nobody would think to look for afterwards.
     *
     * Reachable on a legal publish: `basisPoints` is capped at 100,000 by the
     * schema, and the base is the merchant's product price, which this schema
     * does not bound at all.
     */
    try {
      return { deltaMinor: percentageOf(baseMinor, points as number), unpriced: null };
    } catch (error) {
      if (error instanceof RangeError) {
        return { deltaMinor: 0, unpriced: type };
      }

      throw error;
    }
  }

  // A type with no name is a malformed config, not an unimplemented type, and
  // naming '' in a merchant-facing notice would say nothing useful.
  return { deltaMinor: 0, unpriced: type === '' ? null : type };
}

/**
 * The delta an **option-level** price contributes for one answer.
 *
 * The counterpart to `priceConfigDelta`, which prices a chosen value. An option
 * with no values — text, date, number, file — has no value row to hang a price
 * on, so its price hangs on the option itself. `PRICING-SPEC.md` §2 defines
 * `per_char` as the only type that belongs there.
 *
 * ## The floor is on the COUNT, not the delta
 *
 * ```text
 * delta = max(0, measure(text) - free_characters) * amount_minor
 * ```
 *
 * Without the floor on the count, a string shorter than the allowance produces
 * a negative count and therefore a **negative delta** — a discount for typing
 * less, which no merchant configured and which a customer could farm by leaving
 * the field nearly empty.
 *
 * The floor cannot move to the delta instead: `amountMinor` may legitimately be
 * negative (that is how a discount is expressed), and `Math.max(0, delta)`
 * would silently discard it. §3's line-total clamp is what stops a negative
 * delta paying out.
 *
 * ## `measure()`, never `text.length`
 *
 * M11.1a's whole reason for existing. In `optionia-app` the price and the
 * character counter were written separately, and `"AB CD"` is charged as five
 * characters while the counter shows four. Display and server agree with each
 * other, which is why nobody noticed — not a pricing bug but a credibility one,
 * on engraving. `text.length` is UTF-16 code units: a family emoji is 8.
 *
 * ## Which options may carry it is decided BEFORE this function
 *
 * `PRICING-SPEC.md` §2 restricts `per_char` to an option the customer types
 * into — not `file` (whose answer is a 64-character upload token), not `date`,
 * not `number`, and not `hidden` (whose value is the merchant's own
 * `default_value`). Measured in the plugin before that rule existed: a
 * `per_char` price on a file option charged **32.00** for the length of a hash.
 *
 * This function does not enforce it, deliberately. In this repository the rule
 * lives in the **type registry**, which refuses the combination when a merchant
 * saves it — a clear error at authoring time beats a silent zero at checkout,
 * and the registry is the only place that knows an option's presentation. The
 * plugin enforces it a second time because a published document is input rather
 * than authority (AC4) and can arrive from a stale cache or an older build.
 *
 * So a caller here must already have established that the option is one a
 * customer types into. Today there is no such caller: this exists to hold the
 * two languages to the same arithmetic through `text_price_cases`.
 *
 * @param pricing The option's published `pricing`, or null.
 * @param answer What the customer typed.
 * @returns The delta and, when the type could not be charged, its name.
 */
export function optionPricingDelta(
  pricing: Record<string, unknown> | null | undefined,
  answer: string,
): PriceConfigDelta {
  if (!pricing || typeof pricing !== 'object') {
    return { deltaMinor: 0, unpriced: null };
  }

  const type = typeof pricing.type === 'string' ? pricing.type : '';

  /*
   * `fixed` at the option level has no defined meaning — the specification
   * prices it per value. Not reported either, since the type IS implemented;
   * it is simply not this shape of thing, and naming it in a merchant-facing
   * notice would send them looking for an unsupported feature.
   */
  if (type === '' || type === PriceType.FIXED) {
    return { deltaMinor: 0, unpriced: null };
  }

  if (type === PriceType.PER_UNIT) {
    return perUnitDelta(pricing, answer);
  }

  if (type === PriceType.TIERED) {
    return tieredDelta(pricing, answer);
  }

  if (type !== PriceType.PER_CHAR) {
    return { deltaMinor: 0, unpriced: type };
  }

  const amount = pricing.amount_minor;

  if (!Number.isSafeInteger(amount)) {
    // Malformed, not unimplemented — reported the same way a malformed
    // percentage rate is, rather than coerced into a charge nobody configured.
    return { deltaMinor: 0, unpriced: null };
  }

  const free =
    Number.isSafeInteger(pricing.free_characters) && (pricing.free_characters as number) > 0
      ? (pricing.free_characters as number)
      : 0;

  const charged = measure(answer) - free;

  if (charged <= 0) {
    return { deltaMinor: 0, unpriced: null };
  }

  const delta = charged * (amount as number);

  if (!Number.isSafeInteger(delta)) {
    // The API caps the amount, but the CUSTOMER supplies the text. Reported
    // rather than raised, matching what an over-range percentage does.
    return { deltaMinor: 0, unpriced: type };
  }

  return { deltaMinor: delta, unpriced: null };
}

/**
 * The delta a `per_unit` price contributes for one answer.
 *
 * ```text
 * delta = round(max(0, quantity) * amount_minor)
 * ```
 *
 * ## The floor is on the QUANTITY, not the delta
 *
 * A customer submitting `-5` would otherwise produce a negative delta — a
 * discount for asking for less than nothing, farmable by anyone who can type a
 * minus sign into a number field the merchant left unbounded.
 *
 * It cannot move to the delta: `amount_minor` may legitimately be negative,
 * which is how a discount option is expressed, and `Math.max(0, delta)` would
 * silently discard every one of them.
 *
 * ## Fractional quantities are allowed, and rounded away from zero
 *
 * "£2.50 per metre × 1.5m" is a real measurement. The product may be fractional
 * and is rounded **half up away from zero** — `Math.round` rounds toward
 * positive infinity, so it agrees on every positive tie and disagrees on every
 * negative one. `-1.5` is `-2` here and `-1` there.
 *
 * ## The quantity is bounded before the multiplication
 *
 * A number option's answer has no length ceiling the way text does: a customer
 * can submit `1e20`-scale digits wherever the merchant set no `max`, and at the
 * schema's maximum amount a quantity near nine million already leaves the safe
 * integer range. Reported rather than raised, matching every other guard here.
 *
 * ## Which options may carry it is decided BEFORE this function
 *
 * `PRICING-SPEC.md` §2 restricts `per_unit` to an option that produces a number.
 * As with `per_char`, that rule lives in the type registry — the only place that
 * knows an option's presentation — and again in the plugin, because a published
 * document is input rather than authority.
 *
 * @param pricing The option's published `pricing`.
 * @param answer The number the customer supplied, as the document spells it.
 * @returns The delta and, when it could not be charged, the type's name.
 */
function perUnitDelta(
  pricing: Record<string, unknown>,
  answer: string,
): PriceConfigDelta {
  const amount = pricing.amount_minor;

  if (!Number.isSafeInteger(amount)) {
    return { deltaMinor: 0, unpriced: null };
  }

  /*
   * Parsed strictly, never `Number(answer)`.
   *
   * `Number("")` is 0, `Number("1e3")` is 1000, and `Number(" 7 ")` is 7 — a
   * customer typing a quantity does not mean scientific notation, and the
   * plugin's own parser refuses all three. Two parsers disagreeing about what
   * counts as a number is the same class of divergence `measure()` exists to
   * prevent for text.
   */
  if (!/^[+-]?\d+(\.\d+)?$/.test(answer)) {
    return { deltaMinor: 0, unpriced: null };
  }

  const units = Number.parseFloat(answer);

  if (!Number.isFinite(units) || units <= 0) {
    return { deltaMinor: 0, unpriced: null };
  }

  /*
   * Reported rather than clamped: charging for a million units when the customer
   * asked for more would invent a number nobody chose, and charging zero would
   * make the option free. Neither is defensible, so the line prices without this
   * option and the merchant is told.
   */
  if (units > ABSOLUTE_MAX_QUANTITY) {
    return { deltaMinor: 0, unpriced: type(pricing) };
  }

  if (!Number.isSafeInteger(Math.trunc(units))) {
    return { deltaMinor: 0, unpriced: type(pricing) };
  }

  const product = units * (amount as number);

  if (!Number.isSafeInteger(Math.trunc(product))) {
    return { deltaMinor: 0, unpriced: type(pricing) };
  }

  const magnitude = Math.abs(product);
  const floored = Math.floor(magnitude);
  const rounded = magnitude - floored >= 0.5 ? floored + 1 : floored;

  return { deltaMinor: product < 0 ? -rounded : rounded, unpriced: null };
}

/**
 * The largest quantity a `per_unit` price will charge for.
 *
 * 🔴 **The counterpart to the plugin's `ABSOLUTE_MAX_LENGTH`, and it was
 * missing on both sides.** A text answer is capped at 5000 graphemes whether or
 * not a merchant configured a limit, so `per_char` cannot be driven arbitrarily
 * high. A number answer had no equivalent: `min` and `max` are optional and the
 * schema bounds neither, unlike `maxLength` which it caps at 5000.
 *
 * Measured in the plugin at 2.00 per unit with no `max` configured: a customer
 * typing `9999999999999` added a line worth **20,000,000,000,078.00**.
 * Arithmetically correct, and not a total any merchant meant to be reachable.
 *
 * A backstop for the *absence* of configuration, not a second limit competing
 * with the merchant's. Mirrored here rather than derived, because the two
 * evaluators must refuse the same inputs — a ceiling in one language only is a
 * divergence the shared fixture would have to catch after the fact.
 */
const ABSOLUTE_MAX_QUANTITY = 1_000_000;

/** The declared type of a pricing block, for reporting. */
function type(pricing: Record<string, unknown>): string {
  return typeof pricing.type === 'string' ? pricing.type : '';
}

/**
 * The delta a `tiered` price contributes for one answer.
 *
 * ```text
 * delta = round(max(0, quantity) * amount_minor(of the matching tier))
 * ```
 *
 * ## `tiered` IS `per_unit`, with the amount looked up rather than fixed
 *
 * So this resolves the bracket and delegates, rather than repeating the
 * arithmetic. Every guard `perUnitDelta` carries — the strict parse, the zero
 * floor, the absolute ceiling, the safe-range check and the reporting — applies
 * unchanged and from one place. Duplicating them would be five more chances for
 * the two types to disagree about the same customer input.
 *
 * ## The bracket is chosen by `min_quantity` alone
 *
 * The authoring schema guarantees the set is contiguous from 1 and ends
 * open-ended, so the last tier whose `min_quantity` does not exceed the quantity
 * is the one `max_quantity` would select — for every **whole** number.
 *
 * 🔴 **It differs for a fractional quantity.** With tiers `1-9` and `10+`, a
 * quantity of `9.5` satisfies neither `<= 9` nor `>= 10`, so matching on both
 * bounds leaves it unpriced — a customer paying nothing for 9.5 metres of rope.
 * Selecting by `min_quantity` puts it in `1-9`, which is what a merchant reading
 * "under ten metres" means.
 *
 * @param pricing The option's published `pricing`.
 * @param answer The number the customer supplied, as the document spells it.
 * @returns The delta and, when it could not be charged, the type's name.
 */
function tieredDelta(pricing: Record<string, unknown>, answer: string): PriceConfigDelta {
  if (!/^[+-]?\d+(\.\d+)?$/.test(answer)) {
    return { deltaMinor: 0, unpriced: null };
  }

  const quantity = Number.parseFloat(answer);

  if (!Number.isFinite(quantity)) {
    return { deltaMinor: 0, unpriced: null };
  }

  const amount = tierAmount(pricing.tiers, quantity);

  if (amount === null) {
    /*
     * No bracket covers this quantity. A negative one is excluded here rather
     * than reported: `perUnitDelta` floors it to zero, and a customer typing
     * `-5` has not found a configuration gap.
     */
    return { deltaMinor: 0, unpriced: quantity > 0 ? type(pricing) : null };
  }

  return perUnitDelta({ type: type(pricing), amount_minor: amount }, answer);
}

/**
 * The amount of the bracket a quantity falls in, or null when none covers it.
 *
 * The **last** tier whose `min_quantity` does not exceed the quantity. Walked
 * rather than assumed sorted: the published document preserves whatever order
 * the dashboard stored, and a reader trusting that order would price by whichever
 * bracket happened to come first.
 *
 * `max_quantity` is deliberately not consulted. See `tieredDelta`.
 */
function tierAmount(tiers: unknown, quantity: number): number | null {
  if (!Array.isArray(tiers)) {
    return null;
  }

  let bestMin: number | null = null;
  let amount: number | null = null;

  for (const entry of tiers) {
    const tier = entry as Record<string, unknown>;
    const min = tier?.min_quantity;
    const amt = tier?.amount_minor;

    // A malformed tier is skipped rather than failing the whole set: the others
    // may still price this quantity, and refusing everything would take a
    // storefront down over one bad bracket.
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(amt) || quantity < (min as number)) {
      continue;
    }

    if (bestMin === null || (min as number) > bestMin) {
      bestMin = min as number;
      amount = amt as number;
    }
  }

  return amount;
}
