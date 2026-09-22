import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { percentageOf } from './percentage';

/**
 * The cases come from the file the PHP suite also reads.
 *
 * Two implementations that merely intend to agree is how the `optionia-app`
 * measurement bug happened. This is the same shape one layer over: PHP rounds
 * half up away from zero, `Math.round` rounds toward positive infinity, and they
 * differ on every negative tie.
 */
interface RoundingCase {
  readonly name: string;
  readonly minor: number;
  readonly basis_points: number;
  readonly expect: number;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../test/fixtures/shared/pricing-fixtures.json'), 'utf8'),
) as { rounding_case_count: number; rounding_cases: RoundingCase[] };

describe('percentageOf', () => {
  it.each(
    fixture.rounding_cases.map((c) => [c.name, c.minor, c.basis_points, c.expect] as const),
  )('%s', (_name, minor, basisPoints, expected) => {
    expect(percentageOf(minor, basisPoints)).toBe(expected);
  });

  it('runs every rounding case the fixture declares', () => {
    expect(fixture.rounding_cases).toHaveLength(fixture.rounding_case_count);
  });

  /**
   * Positive ties agree in both languages, so a suite holding only those would
   * prove the implementations agree where they never disagreed.
   */
  it('covers at least three negative ties', () => {
    const negative = fixture.rounding_cases.filter((c) => c.basis_points < 0);

    expect(negative.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Asserted directly as well as through the fixture: this is the property the
   * specification names, and it is the one `Math.round` gets wrong.
   */
  it('rounds symmetrically about zero, unlike Math.round', () => {
    expect(percentageOf(10, 500)).toBe(1);
    expect(percentageOf(10, -500)).toBe(-1);
    expect(percentageOf(30, -500)).toBe(-2);

    // What the naive implementation would have produced.
    expect(Math.round((30 * -500) / 10000)).toBe(-1);
  });

  it('refuses non-integer input rather than rounding it silently', () => {
    expect(() => percentageOf(10.5, 500)).toThrow(RangeError);
    expect(() => percentageOf(10, 500.5)).toThrow(RangeError);
  });
});
