import { z } from 'zod';

import { MAX_AMOUNT_MINOR } from './pricing.schema';

import {
  EQUALITY_RULE_OPERATORS,
  LIST_RULE_OPERATORS,
  ORDERING_RULE_OPERATORS,
  SUBSTRING_RULE_OPERATORS,
  UNARY_RULE_OPERATORS,
} from '../../common/database/enums';

/**
 * Rule conditions, validated at the API boundary (M17.1).
 *
 * A condition asks one question about one option's answer:
 *
 * ```text
 * optionId  operator  value?
 * ```
 *
 * `OptionRule.conditions` is a `json` column typed `Record<string, unknown>` in
 * the entity, which is the shape this file exists to constrain. The column stays
 * open because the database cannot express a discriminated union; the schema is
 * what makes the API refuse anything else.
 *
 * ⚠️ **Nothing imports this yet, and that is a stage boundary rather than an
 * oversight.** 17-1 defines the shape; 17-2 builds the CRUD that validates
 * against it. Stated explicitly because **16c shipped a complete `per_char`
 * evaluator behind a closed API gate** — every registry type carried
 * `noTypeLevelPricing`, so nothing could author it, and nobody noticed for two
 * phases. An unwired schema is the same silhouette; the difference is that this
 * one is written down with the stage that wires it.
 *
 * 🔴 **Everything here is `.strict()` from its first commit.** Phase 16's audit
 * found that *no* price schema was, and the consequence was measured: a merchant
 * setting `freeUnits: 5` on a `per_unit` price saved successfully and was charged
 * as though they had set nothing. Nothing wrong is stored and nothing wrong is
 * charged — the setting simply evaporates, which is the hardest kind of bug to
 * diagnose because the UI accepted it. A rule that silently does nothing is the
 * same defect with a worse blast radius, because a rule governs whether a
 * customer is charged at all.
 */

/**
 * The largest number of conditions one rule may carry.
 *
 * Not a performance limit — it is a **legibility** limit. M17.6 requires
 * plain-language rule summaries ("Show Engraving Text when Engraving = Yes"),
 * and a rule with fifty conditions has no readable summary, so a merchant cannot
 * confirm it does what they meant. A merchant needing more is describing two
 * rules.
 */
export const MAX_CONDITIONS_PER_RULE = 20;

/**
 * The largest list an `in` / `not_in` operand may hold.
 *
 * Bounded for the same reason `ABSOLUTE_MAX_LENGTH` bounds an engraving: an
 * unbounded list reaches the database, the published document, and every
 * storefront that caches it. Fifty is well past any real option's value count in
 * a condition — a merchant listing fifty of an option's values is describing its
 * complement, and has `not_in`.
 *
 * ⚠️ **This alone does not bound a rule.** Fifty operands of 5,000 characters
 * satisfies every per-item limit here and totals a quarter of a megabyte, which
 * is why `MAX_CONDITIONS_BYTES` exists below.
 */
export const MAX_OPERAND_LIST_LENGTH = 50;

/**
 * The longest scalar operand accepted.
 *
 * Matched to the 5,000-grapheme ceiling the resolver puts on customer text: a
 * condition comparing against a longer string could never be true, so accepting
 * one stores a rule that cannot fire.
 */
export const MAX_OPERAND_LENGTH = 5000;

/**
 * An option id: the rule's left-hand side.
 *
 * ⚠️ **Not validated as a UUID here.** Ids are `char(36)` and generated as
 * UUIDv7, but this schema runs at the API boundary where the *shape* is all that
 * can be checked cheaply — whether the id names an option **in this option set**
 * is a cross-object question that needs the set loaded, and it belongs with the
 * publish-time check that also detects cycles (M17.3). Validating it in two
 * places would be two answers to one question.
 */
const optionId = z
  .string()
  .trim()
  .min(1, 'A condition must name the option it tests.')
  /*
   * 🔴 **A UUID, not merely a short string.** Measured before this: an
   * `optionId` of `'not-a-uuid'` was accepted and stored. It can never match a
   * real option, so the condition is permanently unsatisfiable — and unlike a
   * *deleted* target, nothing sweeps it: `CascadeService` disables rules whose
   * target row vanished, and a row that never existed cannot vanish. The rule
   * looks authored and governs nothing, for ever.
   *
   * `.uuid()` accepts v7, which is what `BaseEntity` generates. Kept beside
   * `.trim()` so `'  <uuid>  '` is still normalised rather than refused.
   */
  .uuid('A condition must name an option by its id.');

/** A single scalar operand. */
const scalarOperand = z.union([
  z.string().max(MAX_OPERAND_LENGTH, 'Operand is implausibly long.'),
  z.number(),
  z.boolean(),
]);

/**
 * A comparison that takes a single operand: `equals`, `contains`, `greater_than`…
 *
 * `value` is required. An `equals` with no operand is a merchant asking "equals
 * what?", and accepting it stores a condition that can never be evaluated.
 */
const equalityCondition = z
  .object({
    optionId,
    operator: z.enum(EQUALITY_RULE_OPERATORS),
    value: scalarOperand,
  })
  .strict();

/**
 * `contains`, whose operand must be a **string**.
 *
 * 🔴 `contains 42` looks answerable and is a trap: stringifying the operand
 * makes `contains 1` match the answer `"10"`, and `contains false` match the
 * engraving `"falsely modest"`. A merchant asking about text supplies text.
 */
const substringCondition = z
  .object({
    optionId,
    operator: z.enum(SUBSTRING_RULE_OPERATORS),
    value: z.string().max(MAX_OPERAND_LENGTH, 'Operand is implausibly long.'),
  })
  .strict();

/**
 * `greater_than` and `less_than`, whose operand must be a **number**.
 *
 * 🔴 **Text has no ordering this project is willing to define.** Is
 * `"Blue" > "apple"`? Byte order says yes, alphabetical says no, and a
 * locale-aware collation says it depends — and PHP's `>` on strings is already a
 * different function from JavaScript's. ADR-050 and `option_delta()` both give
 * the same reasoning for refusing rather than inventing: two languages that each
 * guess will disagree, and the disagreement surfaces as a price.
 *
 * A merchant wanting "is this text one of these" has `in`.
 */
const orderingCondition = z
  .object({
    optionId,
    operator: z.enum(ORDERING_RULE_OPERATORS),
    value: z
      .number()
      .finite('A magnitude comparison needs a real number.')
      .refine((n) => !Object.is(n, -0), 'Use 0 rather than -0.'),
  })
  .strict();

/**
 * A comparison against a list: `in`, `not_in`.
 *
 * Separated from the binary form because `in` with a scalar operand is a
 * merchant meaning `equals` and getting silence — the schema says which shape
 * each operator takes rather than accepting both and guessing.
 */
const listCondition = z
  .object({
    optionId,
    operator: z.enum(LIST_RULE_OPERATORS),
    value: z
      .array(scalarOperand)
      .min(1, 'An `in` condition needs at least one value to match against.')
      .max(MAX_OPERAND_LIST_LENGTH, 'Too many values in one condition.'),
  })
  .strict();

/**
 * A comparison that takes no operand: `is_empty`, `is_not_empty`.
 *
 * 🔴 **`.strict()` is doing real work here.** Without it a merchant could save
 * `{ operator: 'is_empty', value: 'Blue' }` — a condition half of which is
 * silently ignored, which is exactly the `freeUnits: 5` shape. With it, the API
 * answers with the field name.
 */
const unaryCondition = z
  .object({
    optionId,
    operator: z.enum(UNARY_RULE_OPERATORS),
  })
  .strict();

/**
 * One condition, in any of its three shapes.
 *
 * A discriminated union on `operator`, so an unknown operator produces
 * "expected one of…" rather than three stacked branch failures. The error a
 * merchant reads is the difference between a usable message and a wall of noise
 * — the same reasoning `pricingConfigSchema` gives.
 */
export const ruleConditionSchema = z.discriminatedUnion('operator', [
  equalityCondition,
  substringCondition,
  orderingCondition,
  listCondition,
  unaryCondition,
]);

/**
 * The largest a rule's stored `conditions` may be, serialized, in bytes.
 *
 * 🔴 **A per-item cap is not an aggregate bound, and this project has already
 * paid for learning that.** `SelectionResolver::ABSOLUTE_MAX_LENGTH` caps one
 * engraving at 5,000 graphemes, and its own docblock records why that was not
 * enough: *"50 text options x 5000 characters = 244 KB accepted in one
 * request"*. `MAX_TEXT_BYTES` was added as the budget.
 *
 * The same arithmetic applies here, and was measured before this constant
 * existed: **20 conditions x 50 operands x 5,000 characters = 4.77 MB, accepted**
 * by a schema whose every individual limit was satisfied.
 *
 * 16 KB is far above any real rule — twenty conditions comparing against
 * forty-character labels is under 2 KB — and far below the point where a rule
 * burdens the published document that every storefront caches.
 */
export const MAX_CONDITIONS_BYTES = 16384;

/**
 * The conditions stored on one rule: a flat list, and nothing else.
 *
 * 🔴 **`matchType` is deliberately NOT in here.** It is a **column** on
 * `OptionRule` and a **sibling** of `conditions` in `PublishedRule`, which is
 * frozen at `schema_version: 1`. An earlier version of this schema nested it
 * inside the JSON, which would have given one fact two homes — a column and a
 * key, free to disagree — and contradicted a wire contract that cannot change.
 *
 * ⚠️ **Flat, not nested.** M17.1 specifies `IF <conditions, matched ALL|ANY>`:
 * one list, one connective. The entity's docblock mentions "nested groups", and
 * this schema deliberately does not implement them — nesting multiplies what the
 * cycle detector, both evaluators, the shared fixture and the rule builder each
 * must handle, for expressiveness no milestone asks for. A merchant needing
 * `(A AND B) OR C` writes two rules.
 *
 * ## What this schema deliberately does not decide
 *
 * Four questions belong elsewhere, each settled where the whole picture is
 * visible:
 *
 * - **Whether `optionId` names an option in this set** — a cross-object question
 *   needing the set loaded. It belongs with the publish-time check that also
 *   detects cycles (M17.3), not in two places giving two answers.
 * - **What a `set_price` rule does to an option that already prices itself** —
 *   ADR-049. Refused at publish against `per_char`, `per_unit` and `tiered`,
 *   because those hold a function of customer input rather than an amount.
 * - **What happens when rules do not converge** — ADR-050. An evaluator cap in
 *   both languages, independent of the publish-time cycle check, because the
 *   plugin evaluates a cached document no check has seen.
 * - **Whether a rule-hidden option is still charged or stored** — ADR-051.
 *   Neither, and not restored if the field re-shows.
 */
export const ruleConditionsSchema = z
  .array(ruleConditionSchema)
  .min(1, 'A rule needs at least one condition, or it always fires.')
  .max(MAX_CONDITIONS_PER_RULE, 'Too many conditions for one rule to stay readable.')
  .refine(
    (conditions) => Buffer.byteLength(JSON.stringify(conditions), 'utf8') <= MAX_CONDITIONS_BYTES,
    `A rule's conditions must serialize to at most ${MAX_CONDITIONS_BYTES} bytes.`,
  );

export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

/**
 * What an action acts **with**, validated per action (M17.4).
 *
 * 🔴 **Three of the six actions could not be expressed at all until this.**
 * `OptionRule` carried no payload column, so a `set_price` rule had no amount to
 * set and `set_default` no value to write — while ADR-049 reasoned in detail
 * about what `set_price` *means*. The reasoning was sound and the schema could
 * not carry it.
 *
 * ⚠️ **Keyed on `action`, not a free-form bag.** `set_price` needs an integer of
 * minor units; `set_default` needs a value key; the other four need nothing.
 * Accepting `{ amountMinor }` on a `hide` rule would store a number nothing ever
 * reads — the `freeUnits: 5` shape Phase 16 measured, where a setting saved
 * successfully and evaporated.
 */

/** The amount a `set_price` rule sets, in minor units. */
const setPriceValue = z
  .object({
    /*
     * 🔴 **A replacement, never an addition** (ADR-049). "Set price to 5.00"
     * means the price *is* 5.00 — the only reading that is idempotent, and
     * therefore the only one compatible with M17.2's order-independence: two
     * rules both setting 5.00 leave 5.00, where adding would leave 10.00 and
     * make the result depend on which ran first.
     *
     * Negative is allowed, as it is for `price_config`: a rule may discount.
     * `Pricing` already floors a line at zero, so the floor is not this
     * schema's job and duplicating it here would be a second answer.
     */
    amountMinor: z
      .number()
      .int('An amount must be a whole number of minor units (1000 = £10.00).')
      .min(-MAX_AMOUNT_MINOR, 'Amount is implausibly large.')
      .max(MAX_AMOUNT_MINOR, 'Amount is implausibly large.'),
  })
  .strict();

/** The value a `set_default` rule preselects. */
const setDefaultValue = z
  .object({
    /*
     * A **value key**, not a value id. The published document identifies a
     * choice by its key within an option, and a rule that named an id would be
     * the only thing in the document that does — a second identifier for one
     * thing, and a second way for the two evaluators to disagree.
     */
    valueKey: z
      .string()
      .trim()
      .min(1, 'A default must name the value it selects.')
      .max(100, 'A value key is at most 100 characters.'),
  })
  .strict();

/**
 * Validate a rule's payload against the action that will use it.
 *
 * Returns the parsed payload, or `null` for the four actions that take none.
 * Throws nothing: the caller decides how a failure is reported, because a
 * service raising a domain error and a validator collecting findings need the
 * same answer in different shapes.
 */
export function ruleActionValueSchema(action: string): z.ZodType {
  switch (action) {
    case 'set_price':
      return setPriceValue;
    case 'set_default':
      return setDefaultValue;
    default:
      /*
       * ⚠️ **`null` and `undefined` both accepted, nothing else.** An action
       * that acts on its own must not carry a payload — one that does is a
       * merchant believing they configured something.
       */
      return z
        .union([z.null(), z.undefined()])
        .refine((value) => value === null || value === undefined, {
          message: `A ${action} rule takes no value.`,
        });
  }
}

/** The actions that require a payload, and cannot be authored without one. */
export const ACTIONS_REQUIRING_A_VALUE: readonly string[] = ['set_price', 'set_default'];
