import { describe, expect, it } from 'vitest';

import { MAX_AMOUNT_MINOR, amountError, formatAmount, parseAmount } from './money';

const minorOf = (input: string): number | string => {
  const result = parseAmount(input);

  return result.ok ? result.minor : result.reason;
};

describe('parseAmount', () => {
  /**
   * 🔴 **The case that cost Phase 11 a stage.**
   *
   * `(int) (17.9 * 100)` is `1789`, not `1790`, because 17.9 has no exact binary
   * representation. Every value below is one a float multiplication gets wrong
   * or nearly wrong, and none of them touch a float here.
   */
  it.each([
    ['17.9', 1790],
    ['17.90', 1790],
    ['0.29', 29],
    ['1.005', 101],
    ['8.11', 811],
    ['1.15', 115],
    ['4.35', 435],
  ])('parses %s exactly', (input, expected) => {
    expect(minorOf(input)).toBe(expected);
  });

  it.each([
    ['10.50', 1050],
    ['10.5', 1050],
    ['10', 1000],
    ['0', 0],
    ['0.00', 0],
    ['.5', 50],
    ['00010.50', 1050],
    ['+10.50', 1050],
    ['  10.50  ', 1050],
  ])('accepts %s', (input, expected) => {
    expect(minorOf(input)).toBe(expected);
  });

  /** A discount option is legitimate, so the amount is signed. */
  it.each([
    ['-5', -500],
    ['-0.01', -1],
  ])('accepts the negative %s', (input, expected) => {
    expect(minorOf(input)).toBe(expected);
  });

  /** Half-up on the first discarded digit, decided on the digit itself. */
  it.each([
    ['10.504', 1050],
    ['10.505', 1051],
    ['10.509', 1051],
    ['-10.505', -1051],
  ])('rounds %s half-up', (input, expected) => {
    expect(minorOf(input)).toBe(expected);
  });

  /**
   * `Number('1e3')` is 1000 and `Number('1,000')` is `NaN`. Neither is what a
   * merchant meant, so both are refused rather than guessed at.
   */
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['letters', 'ten'],
    ['thousands separator', '1,000'],
    ['exponent', '1e3'],
    ['two dots', '1.0.0'],
    ['just a dot', '.'],
    ['hex', '0x10'],
    ['trailing letters', '10abc'],
    ['currency symbol', '£10.50'],
  ])('refuses %s as malformed', (_label, input) => {
    expect(minorOf(input)).toBe('malformed');
  });

  it('refuses an amount over the cap', () => {
    expect(minorOf('10000000.01')).toBe('too-large');
    expect(minorOf('-10000000.01')).toBe('too-large');
  });

  it('accepts the cap exactly', () => {
    expect(minorOf('10000000')).toBe(MAX_AMOUNT_MINOR);
  });

  /** A value beyond safe-integer range must not silently lose precision. */
  it('refuses a number too large to represent', () => {
    expect(minorOf('999999999999999999999')).toBe('too-large');
  });
});

describe('formatAmount', () => {
  it.each([
    [1050, '10.50'],
    [1000, '10.00'],
    [5, '0.05'],
    [0, '0.00'],
    [-1051, '-10.51'],
    [MAX_AMOUNT_MINOR, '10000000.00'],
  ])('renders %s as %s', (minor, expected) => {
    expect(formatAmount(minor)).toBe(expected);
  });

  /** Whatever a merchant types, editing what they see round-trips. */
  it.each(['10.50', '0.05', '-3.99', '10000000.00'])('round-trips %s', (input) => {
    const parsed = parseAmount(input);

    expect(parsed.ok).toBe(true);
    expect(formatAmount((parsed as { minor: number }).minor)).toBe(
      input.startsWith('-') ? input : input.replace(/^\+/, ''),
    );
  });
});

describe('amountError', () => {
  /** The API says "must not be greater than 1000000000". Nobody types minor units. */
  it('speaks in amounts a merchant recognises', () => {
    expect(amountError('malformed')).toContain('10.50');
    expect(amountError('too-large')).toContain('10000000.00');
    expect(amountError('too-large')).not.toContain('1000000000');
  });
});
