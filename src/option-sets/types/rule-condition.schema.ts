import { z } from 'zod';

import { RuleMatchType, RuleOperator } from '../../common/database/enums';

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
 * storefront that caches it. Twenty is well past any real option's value count.
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
const optionId = z.string().min(1, 'A condition must name the option it tests.').max(36);

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
const binaryCondition = z
  .object({
    optionId,
    operator: z.enum([
      RuleOperator.EQUALS,
      RuleOperator.NOT_EQUALS,
      RuleOperator.CONTAINS,
      RuleOperator.GREATER_THAN,
      RuleOperator.LESS_THAN,
    ]),
    value: scalarOperand,
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
    operator: z.enum([RuleOperator.IN, RuleOperator.NOT_IN]),
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
    operator: z.enum([RuleOperator.IS_EMPTY, RuleOperator.IS_NOT_EMPTY]),
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
  binaryCondition,
  listCondition,
  unaryCondition,
]);

/**
 * The whole condition tree stored on a rule.
 *
 * ⚠️ **Flat, not nested.** M17.1 specifies `IF <conditions, matched ALL|ANY>`,
 * which is one list and one connective — not arbitrary nesting. The entity's
 * docblock mentions "nested groups", and this schema deliberately does not
 * implement them: nesting multiplies what the cycle detector, both evaluators,
 * the fixture and the rule builder each have to handle, for an expressiveness no
 * milestone asks for. A merchant needing `(A AND B) OR C` writes two rules.
 *
 * Recorded here rather than assumed, because a later phase adding nesting must
 * do it deliberately — and `matchType` living beside the list is what makes the
 * flat reading unambiguous.
 *
 * ## What this schema deliberately does not decide
 *
 * Three questions belong to ADRs rather than to a shape, and each is settled
 * where the whole picture is visible:
 *
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
  .object({
    matchType: z.enum([RuleMatchType.ALL, RuleMatchType.ANY]),
    conditions: z
      .array(ruleConditionSchema)
      .min(1, 'A rule needs at least one condition, or it always fires.')
      .max(MAX_CONDITIONS_PER_RULE, 'Too many conditions for one rule to stay readable.'),
  })
  .strict();

export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;
