import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { measure, normalise } from './measure';

/**
 * The cases come from the file, not from this spec.
 *
 * Two implementations that merely intend to agree is how the `optionia-app` bug
 * happened: pricing counted five characters for `"AB CD"` while the counter
 * beside the field showed four. `bin/check-shared-fixtures.sh` hashes this
 * fixture in both repositories, so a case added here without being added to the
 * plugin's copy fails the build.
 */
interface MeasureCase {
  readonly name: string;
  readonly text: string;
  readonly expect: number;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../test/fixtures/shared/pricing-fixtures.json'), 'utf8'),
) as { measure_case_count: number; measure_cases: MeasureCase[] };

describe('measure', () => {
  it.each(fixture.measure_cases.map((c) => [c.name, c.text, c.expect] as const))(
    '%s',
    (_name, text, expected) => {
      expect(measure(text)).toBe(expected);
    },
  );

  /**
   * A hash proves both repositories hold the same bytes. It does not prove
   * either one *executed* them — a runner looping fewer cases than the file
   * declares passes every checksum ever written. The gate asserts this from
   * outside; this asserts it from inside, where the loop happens.
   */
  it('runs every case the fixture declares', () => {
    expect(fixture.measure_cases).toHaveLength(fixture.measure_case_count);
  });
});

describe('normalise', () => {
  /**
   * Asserted separately because `measure()` normalises internally, so a broken
   * `normalise()` could still produce a right-looking count on symmetric input.
   */
  it('trims only the ends', () => {
    expect(normalise('  AB CD  ')).toBe('AB CD');
    expect(normalise('\tAB CD\n')).toBe('AB CD');
    expect(normalise('   ')).toBe('');
  });

  it('keeps inner whitespace, which is engraved', () => {
    expect(normalise('AB  CD')).toBe('AB  CD');
  });

  /**
   * A non-breaking space arrives by paste from a word processor, renders as
   * nothing, and a bare `trim()` would leave it in place.
   */
  it('strips invisible outer whitespace', () => {
    expect(normalise('AB ')).toBe('AB');
    expect(normalise('﻿AB')).toBe('AB');
  });
});
