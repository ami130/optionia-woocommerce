import { describe, expect, it } from 'vitest';

import { formatBasisPoints, MAX_BASIS_POINTS, parsePercent } from './percent';

/**
 * Percentages, as merchants type them and the API stores them.
 *
 * 🔴 **Basis points, never a float** — the same rule money follows. `250` is
 * 2.5%, and `0.1 + 0.2 !== 0.3` in binary floating point, so a percentage that
 * drifts produces a different total on two machines. The API's
 * `percentageBasisPoints` refuses anything but an integer.
 *
 * ⚠️ **A merchant types "2.5", not "250".** The conversion happens here, at the
 * one boundary, rather than in a form that would learn it twice.
 */
describe('parsePercent', () => {
  it('reads a whole percentage', () => {
    expect(parsePercent('10')).toEqual({ ok: true, basisPoints: 1000 });
  });

  it('reads a fractional percentage', () => {
    expect(parsePercent('2.5')).toEqual({ ok: true, basisPoints: 250 });
  });

  /** 🔴 Two decimal places is the limit — 0.01% is one basis point. */
  it('reads the smallest expressible percentage', () => {
    expect(parsePercent('0.01')).toEqual({ ok: true, basisPoints: 1 });
  });

  it('refuses more precision than a basis point', () => {
    expect(parsePercent('2.555').ok).toBe(false);
  });

  /** ⚠️ A discount is a negative percentage, and must survive. */
  it('reads a negative percentage', () => {
    expect(parsePercent('-15')).toEqual({ ok: true, basisPoints: -1500 });
  });

  it('refuses text', () => {
    expect(parsePercent('ten').ok).toBe(false);
  });

  it('refuses an empty string', () => {
    expect(parsePercent('').ok).toBe(false);
  });

  /** 🔴 Mirrors the API's ±100,000 bound, so the form refuses before the wire. */
  it('refuses a percentage beyond the API bound', () => {
    expect(parsePercent('1001').ok).toBe(false);
    expect(parsePercent('1000').ok).toBe(true);
  });

  it('accepts the negative bound', () => {
    expect(parsePercent('-1000')).toEqual({ ok: true, basisPoints: -MAX_BASIS_POINTS });
  });
});

describe('formatBasisPoints', () => {
  it('shows a whole percentage without decimals', () => {
    expect(formatBasisPoints(1000)).toBe('10');
  });

  it('shows a fractional percentage', () => {
    expect(formatBasisPoints(250)).toBe('2.5');
  });

  it('shows a negative percentage', () => {
    expect(formatBasisPoints(-1500)).toBe('-15');
  });

  /** 📌 Round-trips, so editing a stored value and saving changes nothing. */
  it('round-trips through the parser', () => {
    ['10', '2.5', '0.01', '-15', '1000'].forEach((input) => {
      const parsed = parsePercent(input);

      expect(parsed.ok && formatBasisPoints(parsed.basisPoints)).toBe(input);
    });
  });
});
