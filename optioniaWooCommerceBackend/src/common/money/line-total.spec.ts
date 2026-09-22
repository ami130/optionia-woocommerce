import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clampToZero, sumDeltas } from './line-total';

/**
 * The cases come from the file the PHP suite also reads.
 *
 * Until Stage 4 these twelve — now sixteen — were hashed by the gate and
 * executed by nobody: the fixture guaranteed both repositories held the same
 * bytes, and nothing ran them. A fixture nobody runs is data, not a test.
 */
interface PricingCase {
  readonly name: string;
  readonly base_minor: number;
  readonly deltas: number[];
  readonly expect_minor: number;
}

/**
 * A case too large to write out.
 *
 * `AUTHORING_LIMITS` allows 100 groups of 200 options, so one option set can put
 * **20,000** deltas on a single line. Twenty thousand numbers in a file humans
 * read would be worse than the gap they close, so these carry the delta and a
 * repeat count and are expanded here.
 */
interface GeneratedCase {
  readonly name: string;
  readonly base_minor: number;
  readonly repeat_delta: number;
  readonly repeat_count: number;
  readonly expect_minor: number;
}

/**
 * A case at the shared safe-integer bound, which may be accepted or refused.
 *
 * `expect_minor` is null exactly when `throws` is true.
 */
interface BoundCase {
  readonly name: string;
  readonly base_minor: number;
  readonly deltas: number[];
  readonly expect_minor: number | null;
  readonly throws: boolean;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../test/fixtures/shared/pricing-fixtures.json'), 'utf8'),
) as {
  case_count: number;
  cases: PricingCase[];
  generated_case_count: number;
  generated_cases: GeneratedCase[];
  bound_minor: number;
  bound_case_count: number;
  bound_cases: BoundCase[];
};

describe('sumDeltas', () => {
  it.each(
    fixture.cases.map((c) => [c.name, c.base_minor, c.deltas, c.expect_minor] as const),
  )('%s', (_name, base, deltas, expected) => {
    expect(sumDeltas(base, deltas)).toBe(expected);
  });

  it('runs every pricing case the fixture declares', () => {
    expect(fixture.cases).toHaveLength(fixture.case_count);
  });

  /**
   * Order within the sum is unobservable — integer addition commutes — and
   * asserting it stops someone "fixing" a future ordering bug by sorting the
   * deltas, which would change nothing here and everything in Phase 16 where
   * percentages depend on what they are taken of.
   */
  it('does not depend on the order of the deltas', () => {
    const deltas = [500, -200, 125, -50];
    const reversed = [...deltas].reverse();

    expect(sumDeltas(3000, deltas)).toBe(sumDeltas(3000, reversed));
  });

  /**
   * The clamp is the one part that does *not* commute, and the wrong choice is
   * exploitable: clamping per step lets a large discount be followed by a small
   * addition and have the line rise from zero.
   */
  it('clamps once at the end, so a later addition cannot revive a clamped line', () => {
    expect(sumDeltas(3000, [-5000, 400])).toBe(0);

    // What clamping at each step would have produced.
    expect(Math.max(0, Math.max(0, 3000 - 5000) + 400)).toBe(400);
  });

  /**
   * The structural bound, not a sample of it.
   *
   * The literal cases top out at fifty deltas — enough to prove the arithmetic,
   * and a four-hundredth of what a merchant can actually configure. At the real
   * limit the total reaches 2.0001e13, which is still exact in both languages
   * with roughly 450x headroom before `Number.MAX_SAFE_INTEGER`. Asserting it
   * here means a future change that loses precision at scale fails a build
   * rather than being rediscovered in an audit.
   */
  it.each(
    fixture.generated_cases.map(
      (c) => [c.name, c.base_minor, c.repeat_delta, c.repeat_count, c.expect_minor] as const,
    ),
  )('%s', (_name, base, delta, count, expected) => {
    expect(sumDeltas(base, Array<number>(count).fill(delta))).toBe(expected);
  });

  it('runs every generated case the fixture declares', () => {
    expect(fixture.generated_cases).toHaveLength(fixture.generated_case_count);
  });

  it('refuses non-integer input rather than rounding it silently', () => {
    expect(() => sumDeltas(10.5, [])).toThrow(RangeError);
    expect(() => sumDeltas(10, [0.5])).toThrow(RangeError);
  });

  /**
   * The bound is the fixture's, not this file's.
   *
   * Measured: with the bound hardcoded here *and* in the PHP suite *and* stated
   * in `PRICING-SPEC.md`, the specification could be edited to claim a different
   * bound, both fixture hashes re-pinned, and every gate still passed. The one
   * number the whole cross-language reconciliation rests on was the one number
   * the cross-repo mechanism did not protect. It is data now.
   */
  it('agrees with the shared fixture about the safe range', () => {
    expect(fixture.bound_minor).toBe(Number.MAX_SAFE_INTEGER);
  });

  /**
   * Includes the sum that leaves the safe range and returns: 2^53 + 1 − 1 is
   * 2^53, which passes a check made only at the end while having lost a unit.
   */
  it.each(
    fixture.bound_cases.map(
      (c) => [c.name, c.base_minor, c.deltas, c.expect_minor, c.throws] as const,
    ),
  )('%s', (_name, base, deltas, expected, throws) => {
    if (throws) {
      expect(() => sumDeltas(base, deltas)).toThrow(RangeError);

      return;
    }

    expect(sumDeltas(base, deltas)).toBe(expected);
  });

  it('runs every bound case the fixture declares', () => {
    expect(fixture.bound_cases).toHaveLength(fixture.bound_case_count);
  });
});

describe('clampToZero', () => {
  /**
   * Asserted separately because `sumDeltas` clamps internally, so a broken clamp
   * could still produce a right-looking total on input that never goes negative.
   */
  it('floors a negative total and leaves a positive one alone', () => {
    expect(clampToZero(-1)).toBe(0);
    expect(clampToZero(0)).toBe(0);
    expect(clampToZero(1)).toBe(1);
    expect(clampToZero(-1_000_000_000)).toBe(0);
  });

  it('refuses a non-integer total', () => {
    expect(() => clampToZero(1.5)).toThrow(RangeError);
  });
});
