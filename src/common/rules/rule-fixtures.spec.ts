import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  evaluateRules,
  type Answers,
  type EvaluableRule,
} from './rule-evaluator';

/**
 * The shared rule fixture, executed by the TypeScript evaluator (M17.2).
 *
 * The plugin runs a PHP suite over a byte-identical copy of this file. Neither
 * suite can read the other's — CI checks out one repository at a time — so
 * `bin/check-shared-fixtures.sh` hashes both copies and fails whichever
 * repository the edit was made in until the other matches.
 *
 * 🔴 **Every case asserts `expect_passes`, not only the final state.** 16b's
 * lesson, recorded: *the fixture proved both ends of pricing and neither
 * language proved the middle*. For rules the interesting failures are **cascade
 * depth** and **cap behaviour**, and neither is visible in a final state — an
 * evaluator that settled in one pass where the fixture says two has a different
 * cascade and the same answer, until the day it does not.
 */

interface FixtureCase {
  readonly name: string;
  readonly rules: readonly Record<string, unknown>[];
  readonly answers: Record<string, unknown>;
  readonly expect_passes: number;
  readonly expect_refused: boolean;
  readonly expect_states: Record<string, Record<string, unknown>>;
  /** Target id -> the options whose answers it clears. Identity when absent. */
  readonly options_under?: Record<string, readonly string[]>;
}

interface Fixture {
  readonly rule_case_count: number;
  readonly rule_cases: readonly FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'test', 'fixtures', 'shared', 'rule-fixtures.json'), 'utf8'),
) as Fixture;

/**
 * The document's snake_case, converted to the evaluator's camelCase.
 *
 * The fixture is written in the **wire** shape deliberately: it is what both
 * languages actually receive, and a fixture in either evaluator's internal shape
 * would test the evaluator against itself.
 */
function toRule(raw: Record<string, unknown>): EvaluableRule {
  return {
    id: String(raw.id),
    targetType: String(raw.target_type),
    targetId: String(raw.target_id),
    action: String(raw.action),
    matchType: String(raw.match_type),
    conditions: (raw.conditions as readonly Record<string, unknown>[]).map((condition) => ({
      optionId: String(condition.option_id),
      operator: String(condition.operator),
      value: condition.value,
    })),
    actionValue: raw.action_value
      ? camelPayload(raw.action_value as Record<string, unknown>)
      : null,
  };
}

function camelPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (raw.amount_minor !== undefined) {
    payload.amountMinor = raw.amount_minor;
  }

  if (raw.value_key !== undefined) {
    payload.valueKey = raw.value_key;
  }

  return payload;
}

describe('shared rule fixture', () => {
  /**
   * 🔴 **The assertion that makes this a shared fixture rather than a file.**
   *
   * A provider truncated to one row passes every per-case assertion. Comparing
   * the executed count against the fixture's own declared count is what caught
   * exactly that in the pricing suite, and it is the check
   * `check-shared-fixtures.sh` requires to exist.
   */
  it(`executes all ${fixture.rule_case_count} declared cases`, () => {
    expect(fixture.rule_cases).toHaveLength(fixture.rule_case_count);
  });

  it.each(fixture.rule_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    /* Every option in the fixture controls its own answer. */
    const optionIds = new Set<string>();

    testCase.rules.forEach((raw) => {
      optionIds.add(String(raw.target_id));
      (raw.conditions as readonly Record<string, unknown>[]).forEach((condition) => {
        optionIds.add(String(condition.option_id));
      });
    });
    Object.keys(testCase.answers).forEach((id) => optionIds.add(id));

    /*
     * 🔴 **A case may declare the map, and one must whenever it is not the
     * identity.**
     *
     * ✏️ **Added in M17.8's audit.** Synthesising `id => [id]` is only correct
     * when every target is an option — it cannot express a `group` target (one
     * target, several answers) or a `value` target (one target, **no** answer),
     * so such a case would have been handed a map the real code never builds and
     * would have passed while production was wrong.
     */
    const optionsUnder = testCase.options_under
      ? new Map(Object.entries(testCase.options_under))
      : new Map([...optionIds].map((id) => [id, [id]] as const));

    const outcome = evaluateRules(
      testCase.rules.map(toRule),
      testCase.answers as Answers,
      optionsUnder,
    );

    expect(outcome.refused !== null).toBe(testCase.expect_refused);

    /* 🔴 The middle, not only the ends. */
    expect(outcome.passes).toBe(testCase.expect_passes);

    const actual: Record<string, Record<string, unknown>> = {};

    outcome.states.forEach((state, targetId) => {
      const stated: Record<string, unknown> = {};

      if (state.hidden) {
        stated.hidden = true;
      }

      if (state.required !== null) {
        stated.required = state.required;
      }

      if (state.priceMinor !== null) {
        stated.price_minor = state.priceMinor;
      }

      if (state.defaultValueKey !== null) {
        stated.default_value_key = state.defaultValueKey;
      }

      /*
       * Projected only when true, like `hidden`: a fixture case that says
       * nothing about a conflict is asserting there is none, and spelling
       * `false` into every case would bury the two that matter.
       */
      if (state.priceConflict) {
        stated.price_conflict = true;
      }

      if (Object.keys(stated).length > 0) {
        actual[targetId] = stated;
      }
    });

    expect(actual).toEqual(testCase.expect_states);
  });
});
