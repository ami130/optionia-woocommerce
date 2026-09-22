import { describe, expect, it } from 'vitest';

import { parseTextRules, readTextRules } from './text-rules';

/**
 * The three text rules a merchant writes, one of which is a security boundary.
 *
 * 🔴 **`pattern` is the one rule written as CODE.** M14.4 calls it a security
 * boundary: merchant-authored regex runs on every add-to-cart, and a
 * catastrophically backtracking one is a denial-of-service vector.
 *
 * ⚠️ **The API deliberately ACCEPTS an unsafe pattern at authoring and refuses
 * it at PUBLISH.** `type-registry.ts` says so: *"refusing it at authoring would
 * stop a merchant saving a draft they are still writing"*, and `patternsAreSafe`
 * is a publish **blocker**. So this parser checks length and syntax — what
 * stops a merchant saving nonsense — and leaves the complexity judgement to the
 * gate that owns it. A form that refused early would diverge from the API and
 * block a legitimate work-in-progress.
 *
 * 📌 **The field is `forbiddenWords`, not `blocklist`.** An earlier audit of
 * mine named it wrongly from memory; the schema is the authority.
 */
describe('parseTextRules', () => {
  it('builds a pattern rule', () => {
    const parsed = parseTextRules({ pattern: '^[A-Z]+$', charset: '', words: '' }, null);

    expect(parsed.ok && parsed.validation).toEqual({ pattern: '^[A-Z]+$' });
  });

  it('builds a charset rule', () => {
    const parsed = parseTextRules({ pattern: '', charset: 'alpha', words: '' }, null);

    expect(parsed.ok && parsed.validation).toEqual({ allowedCharset: 'alpha' });
  });

  /** 📌 One word per line — what a merchant pastes from a list. */
  it('reads forbidden words one per line', () => {
    const parsed = parseTextRules({ pattern: '', charset: '', words: 'damn\nhell' }, null);

    expect(parsed.ok && parsed.validation).toEqual({ forbiddenWords: ['damn', 'hell'] });
  });

  it('skips blank lines in the word list', () => {
    const parsed = parseTextRules({ pattern: '', charset: '', words: 'damn\n\n  \nhell\n' }, null);

    expect(parsed.ok && parsed.validation).toMatchObject({ forbiddenWords: ['damn', 'hell'] });
  });

  /** 🔴 A pattern that cannot compile is refused — it would match nothing. */
  it('refuses a malformed pattern', () => {
    const parsed = parseTextRules({ pattern: '[unclosed', charset: '', words: '' }, null);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toMatch(/not a valid/i);
  });

  /** ⚠️ The API caps a pattern at 200 characters. */
  it('refuses an over-long pattern', () => {
    const parsed = parseTextRules({ pattern: 'a'.repeat(201), charset: '', words: '' }, null);

    expect(parsed.ok).toBe(false);
  });

  /**
   * 🔴 **An unsafe pattern is ACCEPTED here, and blocked at publish.**
   *
   * `(a+)+` is the catastrophic shape `patternsAreSafe` refuses — and the
   * registry is explicit that authoring must accept it, because a merchant
   * mid-edit has half a pattern and refusing early would stop them saving a
   * draft. The publish blocker is what protects the customer.
   */
  it('accepts a pattern the publish check will refuse', () => {
    const parsed = parseTextRules({ pattern: '(a+)+', charset: '', words: '' }, null);

    expect(parsed.ok).toBe(true);
  });

  /** ⚠️ The API caps the list at 200 words, each at most 100 characters. */
  it('refuses more than 200 forbidden words', () => {
    const words = Array.from({ length: 201 }, (_, i) => `w${i}`).join('\n');

    expect(parseTextRules({ pattern: '', charset: '', words }, null).ok).toBe(false);
  });

  it('refuses an over-long word', () => {
    const parsed = parseTextRules({ pattern: '', charset: '', words: 'x'.repeat(101) }, null);

    expect(parsed.ok).toBe(false);
  });

  /** ⚠️ Blank fields CLEAR their rules rather than being ignored. */
  it('clears a rule the merchant emptied', () => {
    const parsed = parseTextRules({ pattern: '', charset: '', words: '' }, {
      pattern: '^[A-Z]+$',
      allowedCharset: 'alpha',
    });

    expect(parsed.ok && parsed.validation).toBeNull();
  });

  /**
   * 🔴 **Bounds this form does not edit must SURVIVE.** `textValidationSchema`
   * is `.strict()`, so a merchant setting a pattern would otherwise delete the
   * length limit they set in the wording panel.
   */
  it('preserves the length bounds it does not edit', () => {
    const parsed = parseTextRules({ pattern: '^[A-Z]+$', charset: '', words: '' }, {
      minLength: 2,
      maxLength: 20,
    });

    expect(parsed.ok && parsed.validation).toEqual({
      minLength: 2,
      maxLength: 20,
      pattern: '^[A-Z]+$',
    });
  });
});

describe('readTextRules', () => {
  it('reads stored rules into fields', () => {
    expect(
      readTextRules({
        pattern: '^[A-Z]+$',
        allowedCharset: 'alpha',
        forbiddenWords: ['damn', 'hell'],
      }),
    ).toEqual({ pattern: '^[A-Z]+$', charset: 'alpha', words: 'damn\nhell' });
  });

  it('reads absent rules as empty', () => {
    expect(readTextRules(null)).toEqual({ pattern: '', charset: '', words: '' });
  });
});
