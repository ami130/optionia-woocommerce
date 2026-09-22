import { describe, expect, it } from 'vitest';

import {
  optionValidationKind,
  parseOptionValidation,
  readOptionValidation,
} from './option-validation';

/**
 * The limits a customer's answer must satisfy (Phase 20 audit, F2).
 *
 * 🔴 **The storefront enforces these and no merchant could set them.** A
 * merchant could write *"Up to 20 characters"* as help text — which M20's audit
 * added — and **not enforce twenty characters**. Advisory text with no rule
 * behind it is worse than neither: the customer reads a limit that does not
 * hold, and the order arrives with forty.
 *
 * ⚠️ **Scoped to length and range.** `textValidationSchema` also carries
 * `pattern`, `allowedCharset` and `blocklist`. A merchant-authored regular
 * expression is the one rule written as code — M14.4 calls it a security
 * boundary, because it runs on every add-to-cart and a backtracking pattern is
 * a denial-of-service vector. That needs its own treatment, not a text box
 * beside two number fields.
 */
describe('optionValidationKind', () => {
  it('is length for a text option', () => {
    expect(optionValidationKind('text_field')).toBe('length');
    expect(optionValidationKind('textarea')).toBe('length');
  });

  it('is range for a number option', () => {
    expect(optionValidationKind('number_field')).toBe('range');
    expect(optionValidationKind('range')).toBe('range');
    expect(optionValidationKind('quantity')).toBe('range');
  });

  /** ⚠️ A choice option's answer is a value id — there is nothing to bound. */
  it('is none for a choice option', () => {
    expect(optionValidationKind('dropdown')).toBeNull();
    expect(optionValidationKind('radio')).toBeNull();
  });
});

describe('parseOptionValidation', () => {
  it('builds a length rule', () => {
    const parsed = parseOptionValidation('length', { lower: '1', upper: '20' }, null);

    expect(parsed.ok && parsed.validation).toEqual({ minLength: 1, maxLength: 20 });
  });

  it('builds a range rule', () => {
    const parsed = parseOptionValidation('range', { lower: '1', upper: '100' }, null);

    expect(parsed.ok && parsed.validation).toEqual({ min: 1, max: 100 });
  });

  /** 📌 One bound alone is legitimate — "at least 3", with no ceiling. */
  it('accepts a lower bound alone', () => {
    const parsed = parseOptionValidation('length', { lower: '3', upper: '' }, null);

    expect(parsed.ok && parsed.validation).toEqual({ minLength: 3 });
  });

  /** ⚠️ Both blank CLEARS the rule rather than failing. */
  it('clears the rule when both bounds are blank', () => {
    const parsed = parseOptionValidation('length', { lower: '', upper: '' }, null);

    expect(parsed.ok && parsed.validation).toBeNull();
  });

  /** 🔴 The API's own cross-field rule — a minimum above a maximum is refused. */
  it('refuses a minimum above the maximum', () => {
    const parsed = parseOptionValidation('range', { lower: '10', upper: '5' }, null);

    expect(parsed.ok).toBe(false);
  });

  it('refuses a length minimum above the maximum', () => {
    const parsed = parseOptionValidation('length', { lower: '20', upper: '5' }, null);

    expect(parsed.ok).toBe(false);
  });

  it('refuses a malformed bound', () => {
    expect(parseOptionValidation('length', { lower: 'five', upper: '' }, null).ok).toBe(false);
  });

  /** ⚠️ The API caps text length at 5000; the form refuses before the wire. */
  it('refuses a length beyond the API bound', () => {
    expect(parseOptionValidation('length', { lower: '', upper: '5001' }, null).ok).toBe(false);
  });

  /**
   * 🔴 **Fields this form does not edit must SURVIVE.** `textValidationSchema`
   * is `.strict()`, so a stored `pattern` dropped on save would be silently
   * deleted — a merchant setting a length limit would lose a rule they never
   * touched.
   */
  it('preserves stored fields it does not edit', () => {
    const parsed = parseOptionValidation('length', { lower: '1', upper: '20' }, {
      pattern: '^[A-Z]+$',
      allowedCharset: 'alpha',
    });

    expect(parsed.ok && parsed.validation).toMatchObject({
      minLength: 1,
      maxLength: 20,
      pattern: '^[A-Z]+$',
      allowedCharset: 'alpha',
    });
  });

  /** ⚠️ And clearing the bounds must not delete them either. */
  it('preserves untouched fields when the bounds are cleared', () => {
    const parsed = parseOptionValidation('length', { lower: '', upper: '' }, {
      pattern: '^[A-Z]+$',
    });

    expect(parsed.ok && parsed.validation).toEqual({ pattern: '^[A-Z]+$' });
  });
});

describe('readOptionValidation', () => {
  it('reads stored length bounds', () => {
    expect(readOptionValidation('length', { minLength: 1, maxLength: 20 })).toEqual({
      lower: '1',
      upper: '20',
    });
  });

  it('reads stored range bounds', () => {
    expect(readOptionValidation('range', { min: 0, max: 99 })).toEqual({
      lower: '0',
      upper: '99',
    });
  });

  it('reads absent validation as empty', () => {
    expect(readOptionValidation('length', null)).toEqual({ lower: '', upper: '' });
  });
});
