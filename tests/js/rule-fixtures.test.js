import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 **The real file, evaluated exactly as a browser evaluates it.**
 *
 * `rules.js` ships as a classic script, not a module — see the note at its top.
 * Importing it would test a shape the storefront never loads, so this runs the
 * source and reads the namespace it publishes, the way `harness.js` runs
 * `frontend.js`.
 */
function loadEngine() {
  const source = readFileSync(resolve(ROOT, 'assets/js/rules.js'), 'utf8');
  const scope = {};

  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', source)(scope, scope);

  return scope.optioniaRuleEngine;
}


const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const { evaluate, MAX_PASSES } = loadEngine();

/**
 * 🔴 **The same file the PHP and TypeScript evaluators execute.**
 *
 * Byte-identical across both repositories and hash-pinned by
 * `bin/check-shared-fixtures.sh`. A third implementation is a third chance to
 * disagree (16d); this is what makes the disagreement fail a build instead of
 * reaching a storefront.
 */
const FIXTURE = JSON.parse(
  readFileSync(resolve(ROOT, 'tests/fixtures/shared/rule-fixtures.json'), 'utf8'),
);

/**
 * The containment map, built exactly as the PHP suite builds it.
 *
 * A case may declare `options_under` — it must whenever the map is not the
 * identity, because synthesising `id => [id]` cannot express a group target (one
 * target, several answers) or a value target (one target, **no** answer).
 */
function optionsUnder(testCase) {
  if (testCase.options_under) {
    return testCase.options_under;
  }

  const ids = new Set();

  testCase.rules.forEach((rule) => {
    ids.add(String(rule.target_id));
    (rule.conditions ?? []).forEach((condition) => {
      if (condition && typeof condition === 'object' && condition.option_id) {
        ids.add(String(condition.option_id));
      }
    });
  });
  Object.keys(testCase.answers).forEach((id) => ids.add(id));

  const map = {};
  ids.forEach((id) => {
    map[id] = [id];
  });

  return map;
}

/**
 * What the fixture asserts about a target, projected from the browser's state.
 *
 * ⚠️ **The browser resolves less than the servers do**, and that is deliberate:
 * `price_minor`, `default_value_key` and `price_conflict` are pricing and
 * rendering decisions this runtime does not take (AC4, and M17.9 is show/hide).
 * So only the two fields it *does* resolve are compared, and a case asserting a
 * price is checked for the half that belongs here rather than skipped.
 */
function stated(states) {
  const out = {};

  Object.keys(states).forEach((targetId) => {
    const state = states[targetId];
    const projected = {};

    if (true === state.hidden) {
      projected.hidden = true;
    }

    if (null !== state.required) {
      projected.required = state.required;
    }

    if (Object.keys(projected).length > 0) {
      out[targetId] = projected;
    }
  });

  return out;
}

/** The same projection, applied to what the fixture expects. */
function expectedStates(testCase) {
  const out = {};

  Object.entries(testCase.expect_states).forEach(([targetId, state]) => {
    const projected = {};

    if (true === state.hidden) {
      projected.hidden = true;
    }

    if (undefined !== state.required && null !== state.required) {
      projected.required = state.required;
    }

    if (Object.keys(projected).length > 0) {
      out[targetId] = projected;
    }
  });

  return out;
}

describe('the storefront evaluator against the shared fixture', () => {
  it.each(FIXTURE.rule_cases.map((c) => [c.name, c]))('%s', (_name, testCase) => {
    const outcome = evaluate(testCase.rules, testCase.answers, optionsUnder(testCase));

    expect(outcome.refused !== null).toBe(testCase.expect_refused);

    /* 🔴 The middle, not only the ends: a cascade's depth is the interesting part. */
    expect(outcome.passes).toBe(testCase.expect_passes);

    expect(stated(outcome.states)).toEqual(expectedStates(testCase));
  });

  /**
   * 🔴 **The assertion that makes this a shared fixture rather than a file.**
   *
   * A provider truncated to one row passes every per-case assertion. Comparing
   * the executed count against the fixture's own declared count is what caught
   * exactly that in the pricing suite.
   */
  it('executes every declared case', () => {
    expect(FIXTURE.rule_cases).toHaveLength(FIXTURE.rule_case_count);
  });

  /**
   * The cap must be the same number in all three languages, or a cascade that
   * settles on the server refuses in the browser.
   */
  it('caps at the same number of passes as the other two evaluators', () => {
    const php = readFileSync(resolve(ROOT, 'src/Engine/RuleEvaluator.php'), 'utf8');
    const declared = /MAX_PASSES\s*=\s*(\d+)/.exec(php)?.[1];

    expect(Number(declared)).toBe(MAX_PASSES);
  });
});
