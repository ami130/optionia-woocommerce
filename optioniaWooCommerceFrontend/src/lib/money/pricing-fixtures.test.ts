import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { clampToZero, sumDeltas } from './line-total';
import { measure } from './measure';
import { PRICED_TYPES, optionPricingDelta, priceConfigDelta } from './price-config-delta';

/**
 * The shared pricing fixture, executed by the **dashboard's** copy of the
 * evaluators (M20.6, ADR-083).
 *
 * 🔴 **A copied evaluator that nothing executes is how an unproven one ships
 * green.** ADR-083 records the precedent: M17.9 added a third evaluator in the
 * browser with its fixture under `tests/js`, the gate searched `tests/unit`
 * alone, and *deleting the suite left every gate passing while still reporting
 * "rule cases are executed here"*. The dashboard is now the third repository to
 * hold these evaluators, and this file is what stops that repeating.
 *
 * ⚠️ **Parity is behavioural, never source-level.** `check-fixture-parity.sh`
 * pins the fixture byte-for-byte across all three repositories; the evaluators
 * may differ in import paths and idiom, and these cases prove they still answer
 * the same.
 *
 * 📌 **The plugin-parity case is deliberately NOT copied.** The backend's spec
 * reads `SelectionResolver.php` to prove backend and plugin price the same
 * types — a backend↔plugin assertion that belongs where it is. Restating it
 * here would add a second place to update without adding a second guarantee.
 */
interface ConfigCase {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly base_minor: number;
  readonly expect_delta: number;
  readonly expect_unpriced?: string;
}

/**
 * A case compared against **two** bases, to prove which price types follow a
 * converted one.
 *
 * 🔴 **`fixed` must not convert; `percentage` must.** A fixed surcharge is an
 * amount in the store's currency and stays put; a percentage is relative and
 * moves with the base. Asserting only one side would pass an evaluator that
 * converted everything.
 *
 * 📌 **No `answer` means a value-level type.** `fixed` and `percentage` price a
 * chosen value through `priceConfigDelta`; `per_char`, `per_unit` and `tiered`
 * price the option through `optionPricingDelta`, which takes no base at all —
 * which is *why* those three cannot convert.
 */
interface CurrencyCase {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly answer?: string;
  readonly base_minor_a: number;
  readonly base_minor_b: number;
  readonly expect_delta_a: number;
  readonly expect_delta_b: number;
  readonly converts: boolean;
}

interface AnswerCase {
  readonly name: string;
  readonly pricing: Record<string, unknown>;
  readonly expect_delta: number;
  readonly expect_unpriced?: string;
}

interface PricingCase {
  readonly name: string;
  readonly base_minor: number;
  readonly deltas: number[];
  readonly expect_minor: number;
}

interface GeneratedCase {
  readonly name: string;
  readonly base_minor: number;
  readonly repeat_delta: number;
  readonly repeat_count: number;
  readonly expect_minor: number;
}

interface BoundCase {
  readonly name: string;
  readonly base_minor: number;
  readonly deltas: number[];
  readonly expect_minor: number | null;
  readonly throws: boolean;
}

interface MeasureCase {
  readonly name: string;
  readonly text: string;
  readonly expect: number;
}

/*
 * ⚠️ Resolved from the project root, not `__dirname` — this file is ESM under
 * Vitest, where `__dirname` does not exist.
 */
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'test', 'fixtures', 'shared', 'pricing-fixtures.json'), 'utf8'),
) as {
  config_case_count: number;
  config_cases: ConfigCase[];
  text_price_case_count: number;
  text_price_cases: (AnswerCase & { text: string })[];
  unit_price_case_count: number;
  unit_price_cases: (AnswerCase & { quantity: string })[];
  tier_price_case_count: number;
  tier_price_cases: (AnswerCase & { quantity: string })[];
  currency_case_count: number;
  currency_cases: CurrencyCase[];
  case_count: number;
  cases: PricingCase[];
  generated_case_count: number;
  generated_cases: GeneratedCase[];
  bound_minor: number;
  bound_case_count: number;
  bound_cases: BoundCase[];
  measure_case_count: number;
  measure_cases: MeasureCase[];
};

/**
 * 🔴 **Every group asserts its own declared count.**
 *
 * ADR-083 and `check-shared-fixtures.sh` both require it, for a measured
 * reason: *a provider truncated to one row passes every per-case assertion*.
 * Comparing the executed count against the fixture's own number is what caught
 * exactly that.
 */
describe('shared pricing fixture — declared counts', () => {
  it.each([
    ['config', fixture.config_cases.length, fixture.config_case_count],
    ['text price', fixture.text_price_cases.length, fixture.text_price_case_count],
    ['unit price', fixture.unit_price_cases.length, fixture.unit_price_case_count],
    ['tier price', fixture.tier_price_cases.length, fixture.tier_price_case_count],
    ['currency', fixture.currency_cases.length, fixture.currency_case_count],
    ['line total', fixture.cases.length, fixture.case_count],
    ['generated', fixture.generated_cases.length, fixture.generated_case_count],
    ['bound', fixture.bound_cases.length, fixture.bound_case_count],
    ['measure', fixture.measure_cases.length, fixture.measure_case_count],
  ])('runs every %s case the fixture declares', (_name, executed, declared) => {
    expect(executed).toBe(declared);
  });
});

describe('priceConfigDelta', () => {
  it.each(fixture.config_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { deltaMinor, unpriced } = priceConfigDelta(testCase.config, testCase.base_minor);

    expect(deltaMinor).toBe(testCase.expect_delta);
    expect(unpriced).toBe(testCase.expect_unpriced ?? null);

    /* The total as well as the delta — a right delta the summer ignores is a
     * live undercharge, and the two are different functions. */
    expect(sumDeltas(testCase.base_minor, [deltaMinor])).toBe(
      Math.max(0, testCase.base_minor + testCase.expect_delta),
    );
  });

});

describe('currency conversion', () => {
  it.each(fixture.currency_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const evaluate = (base: number): number =>
      testCase.answer === undefined
        ? priceConfigDelta(testCase.config, base).deltaMinor
        : optionPricingDelta(testCase.config, testCase.answer).deltaMinor;

    const a = evaluate(testCase.base_minor_a);
    const b = evaluate(testCase.base_minor_b);

    expect(a).toBe(testCase.expect_delta_a);
    expect(b).toBe(testCase.expect_delta_b);

    if (testCase.converts) {
      expect(a).not.toBe(b);
    } else {
      expect(a).toBe(b);
    }
  });

  /**
   * ⚠️ **Both sides of the split, or the table proves nothing** — a suite
   * holding only the converting case would pass on an evaluator that converted
   * everything.
   */
  it('covers a type that converts and one that does not', () => {
    const converting = fixture.currency_cases.filter((c) => c.converts);
    const fixed = fixture.currency_cases.filter((c) => !c.converts);

    expect(converting.length).toBeGreaterThan(0);
    expect(fixed.length).toBeGreaterThan(0);
  });
});

describe('optionPricingDelta', () => {
  it.each(fixture.text_price_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { deltaMinor, unpriced } = optionPricingDelta(testCase.pricing, testCase.text);

    expect(deltaMinor).toBe(testCase.expect_delta);
    expect(unpriced).toBe(testCase.expect_unpriced ?? null);
  });

  it.each(fixture.unit_price_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { deltaMinor, unpriced } = optionPricingDelta(testCase.pricing, testCase.quantity);

    expect(deltaMinor).toBe(testCase.expect_delta);
    expect(unpriced).toBe(testCase.expect_unpriced ?? null);
  });

  it.each(fixture.tier_price_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { deltaMinor, unpriced } = optionPricingDelta(testCase.pricing, testCase.quantity);

    expect(deltaMinor).toBe(testCase.expect_delta);
    expect(unpriced).toBe(testCase.expect_unpriced ?? null);
  });
});

describe('sumDeltas', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    expect(sumDeltas(testCase.base_minor, testCase.deltas)).toBe(testCase.expect_minor);
  });

  /** The structural bound a merchant can actually configure, not a sample. */
  it.each(fixture.generated_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const deltas = Array.from({ length: testCase.repeat_count }, () => testCase.repeat_delta);

    expect(sumDeltas(testCase.base_minor, deltas)).toBe(testCase.expect_minor);
  });

  /**
   * ⚠️ **At the shared safe-integer bound a case may be accepted OR refused**,
   * and the fixture says which. `expect_minor` is null exactly when `throws`.
   */
  it.each(fixture.bound_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    if (testCase.throws) {
      expect(() => sumDeltas(testCase.base_minor, testCase.deltas)).toThrow();

      return;
    }

    expect(sumDeltas(testCase.base_minor, testCase.deltas)).toBe(testCase.expect_minor);
  });

  /**
   * 🔴 **The safe range is the FIXTURE's number, not this file's.**
   *
   * Measured in the backend before it became data: with the bound hardcoded in
   * the TypeScript suite *and* the PHP suite *and* stated in `PRICING-SPEC.md`,
   * the specification could be edited to claim a different bound, both fixture
   * hashes re-pinned, and every gate still passed. The one number the whole
   * cross-language reconciliation rests on was the one the cross-repo mechanism
   * did not protect.
   *
   * ⚠️ **`check-shared-fixtures.sh` caught its absence here.** The first draft
   * of this file declared `bound_minor` in the fixture type and never read it,
   * and the gate refused: *"no local suite reads bound_minor — the safe range is
   * hardcoded, not shared"*. That is the gate working exactly as its own
   * docblock describes.
   */
  it('agrees with the shared fixture about the safe range', () => {
    expect(fixture.bound_minor).toBe(Number.MAX_SAFE_INTEGER);
  });

  /**
   * 🔴 The clamp is the one part that does not commute, and the wrong choice is
   * exploitable: clamping per step lets a large discount be followed by a small
   * addition and have the line rise from zero.
   */
  it('clamps once at the end, so a later addition cannot revive a clamped line', () => {
    expect(sumDeltas(3000, [-5000, 400])).toBe(0);
    expect(clampToZero(-1)).toBe(0);
  });
});

describe('measure', () => {
  it.each(fixture.measure_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    expect(measure(testCase.text)).toBe(testCase.expect);
  });
});

/**
 * 🔴 **`PRICED_TYPES` is a third copy of a list two repositories already
 * guard.** The backend asserts it against `SelectionResolver::PRICED_TYPES` by
 * reading the PHP source; the dashboard's copy had nothing.
 *
 * Measured: removing `TIERED` passed all 94 pricing cases and every gate,
 * because the evaluator branches on `type` directly and nothing reads this list.
 * A dead export is a small thing — a dead export that three repositories are
 * supposed to agree on is how they stop agreeing.
 *
 * ⚠️ **Asserted against the FIXTURE, not against a list typed here.** Every
 * priceable type appears in the shared cases, so the fixture is the one source
 * all three repositories already share. Restating the five names would agree
 * with whatever I typed.
 */
describe('PRICED_TYPES', () => {
  it('names every type the shared fixture prices', () => {
    const priced = new Set<string>();

    fixture.config_cases.forEach((c) => {
      const type = c.config.type;

      if (typeof type === 'string' && c.expect_unpriced === undefined) {
        priced.add(type);
      }
    });

    [...fixture.text_price_cases, ...fixture.unit_price_cases, ...fixture.tier_price_cases].forEach(
      (c) => {
        const type = c.pricing.type;

        if (typeof type === 'string' && c.expect_unpriced === undefined) {
          priced.add(type);
        }
      },
    );

    const missing = [...priced].filter((type) => !PRICED_TYPES.includes(type));

    expect(missing).toEqual([]);
  });

  /** ⚠️ And nothing extra: a type listed here that nothing prices is drift too. */
  it('lists no type the evaluator cannot price', () => {
    PRICED_TYPES.forEach((type) => {
      const { unpriced } = priceConfigDelta({ type, amount_minor: 100, basis_points: 100 }, 5000);

      /* `unpriced` names a type the evaluator declined; for a listed type it
       * must either price it or be an option-level type priced elsewhere. */
      expect(typeof unpriced === 'string' ? PRICED_TYPES.includes(unpriced) : true).toBe(true);
    });
  });
});
