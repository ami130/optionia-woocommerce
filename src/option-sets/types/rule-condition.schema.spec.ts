import { RuleMatchType, RuleOperator } from '../../common/database/enums';
import {
  MAX_CONDITIONS_PER_RULE,
  MAX_OPERAND_LIST_LENGTH,
  ruleConditionSchema,
  ruleConditionsSchema,
} from './rule-condition.schema';

/**
 * Rule conditions (M17.1).
 *
 * **These tests are as much about the message as the verdict.** A merchant told
 * "conditions are invalid" has to guess; one told which field and why does not —
 * the same standard M7.3 set for pricing.
 */
describe('ruleConditionSchema', () => {
  describe('the three operator shapes', () => {
    it('accepts a binary comparison with its operand', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.EQUALS,
        value: 'yes',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a list comparison with a non-empty list', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IN,
        value: ['red', 'blue'],
      });

      expect(result.success).toBe(true);
    });

    it('accepts a unary comparison with no operand at all', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(true);
    });
  });

  /*
   * 🔴 The `freeUnits: 5` shape, in its rule form.
   *
   * Phase 16's audit found no price schema was `.strict()`, so a merchant could
   * save a setting that evaporated — stored, accepted by the UI, and charged as
   * though absent. A condition carrying an operand its operator ignores is the
   * same defect: the merchant believes they narrowed the rule, and did not.
   */
  describe('an operand the operator cannot use', () => {
    it('refuses a value alongside is_empty', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IS_EMPTY,
        value: 'Blue',
      });

      expect(result.success).toBe(false);
    });

    it('names the offending field rather than saying the condition is invalid', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IS_NOT_EMPTY,
        value: 'Blue',
      });

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(JSON.stringify(result.error.issues)).toContain('value');
    });

    it('refuses an unknown field, however plausible', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.EQUALS,
        value: 'yes',
        caseSensitive: true,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('an operand of the wrong shape', () => {
    it('refuses a scalar where a list is required — `in` is not `equals`', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IN,
        value: 'red',
      });

      expect(result.success).toBe(false);
    });

    it('refuses an empty list, which could never match', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IN,
        value: [],
      });

      expect(result.success).toBe(false);
    });

    it('refuses a list longer than the ceiling', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.IN,
        value: Array.from({ length: MAX_OPERAND_LIST_LENGTH + 1 }, (_, i) => `v${i}`),
      });

      expect(result.success).toBe(false);
    });

    it('refuses a binary comparison with no operand — "equals what?"', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator: RuleOperator.EQUALS,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('the option under test', () => {
    it('refuses a condition that names no option', () => {
      const result = ruleConditionSchema.safeParse({
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(false);
    });

    it('refuses an empty option id', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: '',
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(false);
    });
  });

  it('refuses an operator nobody defined', () => {
    const result = ruleConditionSchema.safeParse({
      optionId: 'opt-1',
      operator: 'starts_with',
      value: 'A',
    });

    expect(result.success).toBe(false);
  });

  /*
   * Every operator the enum declares must be reachable through this schema.
   *
   * A schema covering eight of nine operators would let the ninth be authored
   * nowhere while the enum advertised it — the shape of 16c, where an evaluator
   * shipped complete behind a closed API gate and nothing could reach it.
   */
  it('accepts every operator RuleOperator declares', () => {
    const unreachable = Object.values(RuleOperator).filter((operator) => {
      const listOperand = operator === RuleOperator.IN || operator === RuleOperator.NOT_IN;
      const unary =
        operator === RuleOperator.IS_EMPTY || operator === RuleOperator.IS_NOT_EMPTY;

      return !ruleConditionSchema.safeParse({
        optionId: 'opt-1',
        operator,
        ...(unary ? {} : { value: listOperand ? ['a'] : 'a' }),
      }).success;
    });

    expect(unreachable).toEqual([]);
  });
});

describe('ruleConditionsSchema', () => {
  const one = { optionId: 'opt-1', operator: RuleOperator.IS_EMPTY } as const;

  it('accepts a rule with one condition and a connective', () => {
    const result = ruleConditionsSchema.safeParse({
      matchType: RuleMatchType.ALL,
      conditions: [one],
    });

    expect(result.success).toBe(true);
  });

  /*
   * A rule with no conditions always fires, which makes it not a conditional
   * rule at all — and one that hides an option would hide it permanently, with
   * no condition a merchant could edit to get it back.
   */
  it('refuses a rule with no conditions, because it would always fire', () => {
    const result = ruleConditionsSchema.safeParse({
      matchType: RuleMatchType.ALL,
      conditions: [],
    });

    expect(result.success).toBe(false);
  });

  it('refuses more conditions than a plain-language summary can carry', () => {
    const result = ruleConditionsSchema.safeParse({
      matchType: RuleMatchType.ANY,
      conditions: Array.from({ length: MAX_CONDITIONS_PER_RULE + 1 }, () => one),
    });

    expect(result.success).toBe(false);
  });

  it('refuses a missing connective — ALL and ANY are not interchangeable', () => {
    const result = ruleConditionsSchema.safeParse({ conditions: [one] });

    expect(result.success).toBe(false);
  });

  it('refuses an unknown connective', () => {
    const result = ruleConditionsSchema.safeParse({
      matchType: 'none_of',
      conditions: [one],
    });

    expect(result.success).toBe(false);
  });

  it('refuses an unknown top-level field', () => {
    const result = ruleConditionsSchema.safeParse({
      matchType: RuleMatchType.ALL,
      conditions: [one],
      stopOnFirstMatch: true,
    });

    expect(result.success).toBe(false);
  });

  /*
   * ⚠️ Nesting is deliberately not supported — see the schema's own docblock.
   * M17.1 specifies one list and one connective. This test records the decision
   * so that adding nesting later is a deliberate act rather than an accident.
   */
  it('refuses a nested condition group', () => {
    const result = ruleConditionsSchema.safeParse({
      matchType: RuleMatchType.ALL,
      conditions: [{ matchType: RuleMatchType.ANY, conditions: [one] }],
    });

    expect(result.success).toBe(false);
  });
});
