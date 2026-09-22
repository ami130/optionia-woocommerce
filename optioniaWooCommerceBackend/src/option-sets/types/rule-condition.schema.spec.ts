import { v7 as uuidv7 } from 'uuid';

import {
  BINARY_RULE_OPERATORS,
  LIST_RULE_OPERATORS,
  ORDERING_RULE_OPERATORS,
  RuleMatchType,
  RuleOperator,
  UNARY_RULE_OPERATORS,
} from '../../common/database/enums';
import {
  MAX_CONDITIONS_PER_RULE,
  MAX_OPERAND_LENGTH,
  MAX_OPERAND_LIST_LENGTH,
  ruleConditionSchema,
  ruleConditionsSchema,
} from './rule-condition.schema';

/**
 * A real UUIDv7-shaped id.
 *
 * ✏️ **These tests used `'opt-1'` until the 17-2 audit**, which is not an id any
 * option could have — so every one of them asserted behaviour against input the
 * API now refuses. A fixture standing in for a valid id has to *be* a valid id,
 * the same lesson `UploadContentTest`'s polyglot PNG constants taught in Phase 15.
 */
const OPTION_ID = '0199b8c2-0000-7000-8000-000000000001';

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
        optionId: OPTION_ID,
        operator: RuleOperator.EQUALS,
        value: 'yes',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a list comparison with a non-empty list', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.IN,
        value: ['red', 'blue'],
      });

      expect(result.success).toBe(true);
    });

    it('accepts a unary comparison with no operand at all', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
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
        optionId: OPTION_ID,
        operator: RuleOperator.IS_EMPTY,
        value: 'Blue',
      });

      expect(result.success).toBe(false);
    });

    it('names the offending field rather than saying the condition is invalid', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.IS_NOT_EMPTY,
        value: 'Blue',
      });

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(JSON.stringify(result.error.issues)).toContain('value');
    });

    it('refuses an unknown field, however plausible', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
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
        optionId: OPTION_ID,
        operator: RuleOperator.IN,
        value: 'red',
      });

      expect(result.success).toBe(false);
    });

    it('refuses an empty list, which could never match', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.IN,
        value: [],
      });

      expect(result.success).toBe(false);
    });

    it('refuses a list longer than the ceiling', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.IN,
        value: Array.from({ length: MAX_OPERAND_LIST_LENGTH + 1 }, (_, i) => `v${i}`),
      });

      expect(result.success).toBe(false);
    });

    it('refuses a binary comparison with no operand — "equals what?"', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.EQUALS,
      });

      expect(result.success).toBe(false);
    });
  });

  /*
   * 🔴 An operator whose operand type is nonsense produces a comparison no
   * evaluator can answer consistently in two languages.
   *
   * Measured before this split: `greater_than 'blue'`, `greater_than true`,
   * `contains 42`, `contains false` and `in ['a', 1, true]` were all accepted.
   */
  describe('operands whose TYPE the operator cannot compare', () => {
    it('refuses greater_than against text — there is no ordering to agree on', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.GREATER_THAN,
        value: 'blue',
      });

      expect(result.success).toBe(false);
    });

    it('refuses less_than against a boolean', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.LESS_THAN,
        value: true,
      });

      expect(result.success).toBe(false);
    });

    it('refuses contains against a number — `contains 1` would match "10"', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.CONTAINS,
        value: 42,
      });

      expect(result.success).toBe(false);
    });

    it('refuses contains against a boolean — `contains false` would match "falsely modest"', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.CONTAINS,
        value: false,
      });

      expect(result.success).toBe(false);
    });

    it('still accepts equals against any scalar — equality is well defined in both languages', () => {
      for (const value of ['blue', 42, true]) {
        expect(
          ruleConditionSchema.safeParse({
            optionId: OPTION_ID,
            operator: RuleOperator.EQUALS,
            value,
          }).success,
        ).toBe(true);
      }
    });

    it('refuses a non-finite magnitude — NaN and Infinity compare with nothing', () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          ruleConditionSchema.safeParse({
            optionId: OPTION_ID,
            operator: RuleOperator.GREATER_THAN,
            value,
          }).success,
        ).toBe(false);
      }
    });

    /*
     * `-0 === 0` in both languages, but they serialize differently: JSON.stringify
     * gives `0`, PHP's json_encode gives `-0`. A stored `-0` is a value that
     * round-trips into a different one.
     */
    it('refuses -0, which does not survive a round trip intact', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: OPTION_ID,
        operator: RuleOperator.LESS_THAN,
        value: -0,
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

    /*
     * ⚠️ `.min(1)` alone accepted `'  '` — a guard bypassed by pressing space.
     * Measured before `.trim()`: stored as `{"optionId":"  "}`, naming no option
     * and matching nothing, on a rule that looked authored.
     */
    it('refuses a whitespace-only option id, which names no option', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: '   ',
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(false);
    });

    /*
     * 🔴 A malformed id is worse than a deleted one, because nothing sweeps it.
     *
     * `CascadeService` disables a rule whose target row vanished, recording
     * `TARGET_DELETED` so the merchant is told which target went missing. A row
     * that never existed cannot vanish — so a condition naming `'not-a-uuid'`
     * is permanently unsatisfiable, and permanently invisible.
     */
    it('refuses an id no option could ever have', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: 'not-a-uuid',
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(false);
    });

    it('accepts the UUIDv7 that BaseEntity actually generates', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: uuidv7(),
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(true);
    });

    it('trims a padded id rather than storing the padding', () => {
      const result = ruleConditionSchema.safeParse({
        optionId: `  ${OPTION_ID}  `,
        operator: RuleOperator.IS_EMPTY,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.optionId).toBe(OPTION_ID);
    });
  });

  it('refuses an operator nobody defined', () => {
    const result = ruleConditionSchema.safeParse({
      optionId: OPTION_ID,
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
    /*
     * The operand is chosen from the same partitions the schema is built from,
     * so this asks "can every operator be authored?" rather than "does every
     * operator take a string?". Hard-coding a string here would have made the
     * test fail when ordering operators became numeric — a correct change
     * reported as a regression.
     */
    const operandFor = (operator: RuleOperator): Record<string, unknown> => {
      if ((UNARY_RULE_OPERATORS as readonly RuleOperator[]).includes(operator)) return {};
      if ((LIST_RULE_OPERATORS as readonly RuleOperator[]).includes(operator)) {
        return { value: ['a'] };
      }
      if ((ORDERING_RULE_OPERATORS as readonly RuleOperator[]).includes(operator)) {
        return { value: 10 };
      }

      return { value: 'a' };
    };

    const unreachable = Object.values(RuleOperator).filter(
      (operator) =>
        !ruleConditionSchema.safeParse({ optionId: OPTION_ID, operator, ...operandFor(operator) })
          .success,
    );

    expect(unreachable).toEqual([]);
  });

  /*
   * 🔴 The partitions in `enums.ts` are the single source the schema is built
   * from. If an operator were added to the enum but to no partition, it would be
   * silently unauthorable while the enum advertised it — 16c's defect, where a
   * complete `per_char` evaluator shipped behind a closed API gate.
   */
  it('sorts every operator into exactly one operand partition', () => {
    const partitioned = [
      ...UNARY_RULE_OPERATORS,
      ...LIST_RULE_OPERATORS,
      ...BINARY_RULE_OPERATORS,
    ] as readonly RuleOperator[];

    expect([...partitioned].sort()).toEqual([...Object.values(RuleOperator)].sort());
    expect(new Set(partitioned).size).toBe(partitioned.length);
  });
});

describe('ruleConditionsSchema', () => {
  const one = { optionId: OPTION_ID, operator: RuleOperator.IS_EMPTY } as const;

  it('accepts a flat list of conditions', () => {
    expect(ruleConditionsSchema.safeParse([one]).success).toBe(true);
  });

  /*
   * 🔴 `matchType` is a COLUMN on OptionRule and a SIBLING of `conditions` in
   * `PublishedRule`, which is frozen at schema_version 1.
   *
   * An earlier version of this schema nested it inside the JSON. That would have
   * given one fact two homes — a column and a key, free to disagree — and
   * contradicted a wire contract that cannot change. This test is what stops it
   * coming back.
   */
  it('does not carry matchType: that is a column, not part of the JSON', () => {
    expect(ruleConditionsSchema.safeParse({ matchType: RuleMatchType.ALL, conditions: [one] }).success).toBe(
      false,
    );
  });

  /*
   * A rule with no conditions always fires, which makes it not a conditional
   * rule at all — and one that hides an option would hide it permanently, with
   * no condition a merchant could edit to get it back.
   */
  it('refuses a rule with no conditions, because it would always fire', () => {
    expect(ruleConditionsSchema.safeParse([]).success).toBe(false);
  });

  it('refuses more conditions than a plain-language summary can carry', () => {
    const tooMany = Array.from({ length: MAX_CONDITIONS_PER_RULE + 1 }, () => one);

    expect(ruleConditionsSchema.safeParse(tooMany).success).toBe(false);
  });

  /*
   * 🔴 The aggregate bound, and the reason it exists.
   *
   * Every per-item limit here is satisfied by 20 conditions x 50 operands x
   * 5,000 characters — and that payload measured **4.77 MB**, accepted, before
   * `MAX_CONDITIONS_BYTES` existed. `SelectionResolver::ABSOLUTE_MAX_LENGTH`
   * learned the same lesson one phase earlier: a per-item cap is not a bound on
   * a request.
   */
  describe('the aggregate byte budget', () => {
    const fatCondition = {
      optionId: OPTION_ID,
      operator: RuleOperator.IN,
      value: Array.from({ length: MAX_OPERAND_LIST_LENGTH }, () => 'x'.repeat(MAX_OPERAND_LENGTH)),
    };

    it('refuses a rule that satisfies every per-item limit and is megabytes long', () => {
      const payload = Array.from({ length: MAX_CONDITIONS_PER_RULE }, () => fatCondition);

      /* The premise: each part is individually legal. */
      expect(ruleConditionSchema.safeParse(fatCondition).success).toBe(true);
      expect(payload.length).toBeLessThanOrEqual(MAX_CONDITIONS_PER_RULE);

      expect(ruleConditionsSchema.safeParse(payload).success).toBe(false);
    });

    it('refuses even ONE condition that is over the budget by itself', () => {
      expect(ruleConditionsSchema.safeParse([fatCondition]).success).toBe(false);
    });

    it('accepts a realistic rule comfortably — the budget does not bite normal use', () => {
      const realistic = Array.from({ length: MAX_CONDITIONS_PER_RULE }, (_, i) => ({
        optionId: `0199b8c2-0000-7000-8000-00000000${String(i).padStart(4, '0')}`,
        operator: RuleOperator.EQUALS,
        value: 'Midnight Blue Anodised Aluminium',
      }));

      expect(ruleConditionsSchema.safeParse(realistic).success).toBe(true);
    });
  });

  /*
   * ⚠️ Nesting is deliberately not supported — see the schema's own docblock.
   * M17.1 specifies one list and one connective. This test records the decision
   * so that adding nesting later is a deliberate act rather than an accident.
   */
  it('refuses a nested condition group', () => {
    expect(ruleConditionsSchema.safeParse([{ conditions: [one] }]).success).toBe(false);
  });
});
