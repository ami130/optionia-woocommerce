import { z } from 'zod';

import {
  LIST_OPERATORS,
  NUMERIC_OPERATORS,
  RULE_ACTIONS,
  RULE_MATCH_TYPES,
  RULE_OPERATORS,
  RULE_TARGET_TYPES,
  SUBSTRING_OPERATORS,
  UNARY_OPERATORS,
  operandShape,
} from './vocabulary';

/**
 * The rule API's validation rules, mirrored.
 *
 * Client-side validation is a **convenience** — the server checks everything
 * again — but a form that accepts what the API refuses wastes a round trip and
 * shows a message written for a developer. Every bound below is copied from
 * `rule-condition.schema.ts`, and `schema.test.ts` states each one so a drift is
 * a failing test rather than a surprised merchant.
 *
 * ⚠️ **The same arrangement `lib/schemas/option-sets.ts` uses**, and with the
 * same limitation: the *vocabulary* is held by a cross-repo gate, the *bounds*
 * by these tests. A bound that drifts fails here rather than in CI's parity
 * check — which is weaker, and better than nothing.
 */

/** `MAX_CONDITIONS_PER_RULE`, from `rule-condition.schema.ts`. */
const MAX_CONDITIONS = 20;

/** `MAX_OPERAND_LIST_LENGTH` — how many entries an `in` list may hold. */
const MAX_LIST_ENTRIES = 50;

/** `MAX_OPERAND_LENGTH` — a single operand's character cap. */
const MAX_OPERAND = 5000;

/**
 * `MAX_CONDITIONS_BYTES` — the serialised cap on one rule's conditions.
 *
 * 🔴 **Bytes, not characters, and the difference is the whole point.** The API
 * measures `JSON.stringify(conditions)` because that is what the column holds —
 * so twenty conditions of 5000 characters each pass every per-field bound and
 * fail this one. A merchant hitting it has authored something legal
 * field-by-field, which is exactly the case a form must explain rather than
 * refuse blankly.
 */
const MAX_CONDITIONS_BYTES = 16384;

/**
 * One condition, validated against the shape its operator demands.
 *
 * 🔴 **Five branches, keyed on the operator** — the API's
 * `ruleConditionSchema` is a discriminated union, and a form that sent a string
 * where a number belongs would be refused with a message about a union. The
 * shape comes from `operandShape()`, so the input a merchant is shown and the
 * value that is validated cannot disagree.
 */
export const conditionSchema = z
  .object({
    optionId: z.string().min(1, 'Choose which answer this looks at.'),
    operator: z.enum(RULE_OPERATORS),
    value: z.unknown().optional(),
  })
  .superRefine((condition, ctx) => {
    const shape = operandShape(condition.operator);

    if (shape === 'none') {
      /*
       * ⚠️ **A value here is a 400, not an ignored field.** The API's schema is
       * `.strict()`, so `{ operator: 'is_empty', value: 'Blue' }` is refused
       * outright — a condition half of which contradicts the other half.
       */
      if (condition.value !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'This comparison takes no value.',
        });
      }

      return;
    }

    if (condition.value === undefined || condition.value === '') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Give something to compare against.' });

      return;
    }

    if (shape === 'list') {
      if (!Array.isArray(condition.value) || condition.value.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'Add at least one choice.' });

        return;
      }

      if (condition.value.length > MAX_LIST_ENTRIES) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: `That is more than ${MAX_LIST_ENTRIES} choices.`,
        });
      }

      return;
    }

    if (shape === 'number') {
      if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'This comparison needs a number.',
        });
      }

      return;
    }

    if (shape === 'text' && typeof condition.value !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'This comparison needs text.' });

      return;
    }

    if (typeof condition.value === 'string' && condition.value.length > MAX_OPERAND) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'That value is too long.' });
    }
  });

/** A whole rule, as the builder assembles it. */
export const ruleSchema = z
  .object({
    targetType: z.enum(RULE_TARGET_TYPES),
    targetId: z.string().min(1, 'Choose what this rule acts on.'),
    action: z.enum(RULE_ACTIONS),
    matchType: z.enum(RULE_MATCH_TYPES),
    conditions: z
      .array(conditionSchema)
      /*
       * ⚠️ **A rule with no conditions never fires**, in all three evaluators —
       * so the API refuses one rather than storing a rule that does nothing.
       */
      .min(1, 'A rule needs at least one condition, or it never applies.')
      .max(MAX_CONDITIONS, `A rule may have at most ${MAX_CONDITIONS} conditions.`),
  })
  .superRefine((rule, ctx) => {
    /*
     * The byte cap, measured the way the API measures it. Checked last, so a
     * merchant sees the specific problem with a condition before the general
     * one about all of them.
     */
    const bytes = new TextEncoder().encode(JSON.stringify(rule.conditions)).length;

    if (bytes > MAX_CONDITIONS_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditions'],
        message: 'Together these conditions are too large. Use fewer, or shorter values.',
      });
    }
  });

export type ConditionInput = z.infer<typeof conditionSchema>;
export type RuleInput = z.infer<typeof ruleSchema>;

export const RULE_LIMITS = {
  MAX_CONDITIONS,
  MAX_LIST_ENTRIES,
  MAX_OPERAND,
  MAX_CONDITIONS_BYTES,
  UNARY_OPERATORS,
  LIST_OPERATORS,
  NUMERIC_OPERATORS,
  SUBSTRING_OPERATORS,
} as const;
