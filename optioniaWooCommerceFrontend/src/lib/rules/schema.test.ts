import { describe, expect, it } from 'vitest';

import { conditionSchema, RULE_LIMITS, ruleSchema } from './schema';
import { RULE_OPERATORS, operandShape } from './vocabulary';

/**
 * The rule form's mirrored validation.
 *
 * 🔴 **Every bound is stated here, not merely exercised.** The cross-repo gate
 * holds the *vocabulary* — nine operators, six actions, five groupings — but
 * nothing compares these numbers against the API's. Writing each one down is
 * what turns a drift into a failing test instead of a surprised merchant, and it
 * is the arrangement `lib/schemas/option-sets.test.ts` already uses.
 *
 * ⚠️ **If a number here changes, check `rule-condition.schema.ts` first.** The
 * API is the source of truth; this file is the copy.
 */

function condition(over: Record<string, unknown> = {}) {
  return { optionId: 'opt-a', operator: 'equals', value: 'Yes', ...over };
}

function rule(over: Record<string, unknown> = {}) {
  return {
    targetType: 'option',
    targetId: 'opt-b',
    action: 'hide',
    matchType: 'all',
    conditions: [condition()],
    ...over,
  };
}

describe('the bounds, as the API states them', () => {
  it('caps conditions per rule at 20', () => {
    expect(RULE_LIMITS.MAX_CONDITIONS).toBe(20);
  });

  it('caps a list operand at 50 entries', () => {
    expect(RULE_LIMITS.MAX_LIST_ENTRIES).toBe(50);
  });

  it('caps one operand at 5000 characters', () => {
    expect(RULE_LIMITS.MAX_OPERAND).toBe(5000);
  });

  it('caps the serialised conditions at 16384 bytes', () => {
    expect(RULE_LIMITS.MAX_CONDITIONS_BYTES).toBe(16384);
  });
});

describe('one condition', () => {
  it('accepts a well-formed equality condition', () => {
    expect(conditionSchema.safeParse(condition()).success).toBe(true);
  });

  /**
   * 🔴 A value on a unary operator is a 400, not an ignored field — the API's
   * schema is `.strict()`, so the form must refuse it too.
   */
  it('refuses a value on an operator that takes none', () => {
    const parsed = conditionSchema.safeParse(condition({ operator: 'is_empty', value: 'Blue' }));

    expect(parsed.success).toBe(false);
  });

  it('accepts a unary operator with no value at all', () => {
    const parsed = conditionSchema.safeParse({ optionId: 'opt-a', operator: 'is_empty' });

    expect(parsed.success).toBe(true);
  });

  /**
   * ⚠️ Text has no ordering PHP and JavaScript agree on, so the ordering
   * operators are numeric only — the API refuses a string, and a merchant should
   * learn that from the form rather than from a 400.
   */
  it('refuses text where a number is required', () => {
    const parsed = conditionSchema.safeParse(condition({ operator: 'greater_than', value: '10' }));

    expect(parsed.success).toBe(false);
  });

  it('accepts a number for an ordering operator', () => {
    expect(
      conditionSchema.safeParse(condition({ operator: 'greater_than', value: 10 })).success,
    ).toBe(true);
  });

  it('refuses a number where `contains` requires text', () => {
    expect(conditionSchema.safeParse(condition({ operator: 'contains', value: 5 })).success).toBe(
      false,
    );
  });

  it('refuses an empty list for `in`', () => {
    expect(conditionSchema.safeParse(condition({ operator: 'in', value: [] })).success).toBe(false);
  });

  it('refuses a list longer than the cap', () => {
    const tooMany = Array.from({ length: RULE_LIMITS.MAX_LIST_ENTRIES + 1 }, (_, i) => `v${i}`);

    expect(conditionSchema.safeParse(condition({ operator: 'in', value: tooMany })).success).toBe(
      false,
    );
  });

  it('refuses an operand past the character cap', () => {
    const long = 'x'.repeat(RULE_LIMITS.MAX_OPERAND + 1);

    expect(conditionSchema.safeParse(condition({ value: long })).success).toBe(false);
  });

  it('refuses an unknown operator', () => {
    expect(conditionSchema.safeParse(condition({ operator: 'starts_with' })).success).toBe(false);
  });

  /**
   * 🔴 **Every operator must be expressible.** An operator the form can never
   * produce a valid condition for is one a merchant cannot use — the same defect
   * as omitting it from the picker, reached a different way.
   */
  it('accepts a valid condition for every operator the API offers', () => {
    RULE_OPERATORS.forEach((operator) => {
      const shape = operandShape(operator);
      const value =
        shape === 'none'
          ? undefined
          : shape === 'list'
            ? ['Yes']
            : shape === 'number'
              ? 10
              : 'Yes';

      const built =
        value === undefined
          ? { optionId: 'opt-a', operator }
          : { optionId: 'opt-a', operator, value };

      expect(conditionSchema.safeParse(built).success, operator).toBe(true);
    });
  });
});

describe('a whole rule', () => {
  it('accepts a well-formed rule', () => {
    expect(ruleSchema.safeParse(rule()).success).toBe(true);
  });

  /**
   * ⚠️ A rule with no conditions never fires, in all three evaluators — so the
   * API refuses one rather than storing a rule that does nothing.
   */
  it('refuses a rule with no conditions', () => {
    expect(ruleSchema.safeParse(rule({ conditions: [] })).success).toBe(false);
  });

  it('refuses more conditions than the cap', () => {
    const many = Array.from({ length: RULE_LIMITS.MAX_CONDITIONS + 1 }, () => condition());

    expect(ruleSchema.safeParse(rule({ conditions: many })).success).toBe(false);
  });

  /**
   * 🔴 **The byte cap is reachable with conditions that are each legal.**
   *
   * Twenty conditions of 5000 characters pass every per-field bound and fail
   * this one — which is the case a form has to explain rather than refuse
   * blankly, because nothing the merchant typed was individually wrong.
   */
  it('refuses conditions that are legal apart and too large together', () => {
    const fat = Array.from({ length: RULE_LIMITS.MAX_CONDITIONS }, () =>
      condition({ value: 'x'.repeat(RULE_LIMITS.MAX_OPERAND - 1) }),
    );

    const parsed = ruleSchema.safeParse(rule({ conditions: fat }));

    expect(parsed.success).toBe(false);
  });

  it('refuses a target type the API does not know', () => {
    expect(ruleSchema.safeParse(rule({ targetType: 'product' })).success).toBe(false);
  });

  it('refuses an action the API does not know', () => {
    expect(ruleSchema.safeParse(rule({ action: 'delete' })).success).toBe(false);
  });
});
