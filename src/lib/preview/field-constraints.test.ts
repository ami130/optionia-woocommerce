import { describe, expect, it } from 'vitest';

import { fieldConstraints } from './field-constraints';

describe('fieldConstraints', () => {
  it('reads the numeric bounds a browser enforces', () => {
    expect(fieldConstraints({ min: 1, max: 100, step: 5 })).toEqual({
      min: 1,
      max: 100,
      step: 5,
      maxLength: undefined,
    });
  });

  it('reads a length limit', () => {
    expect(fieldConstraints({ max_length: 20 }).maxLength).toBe(20);
  });

  /**
   * 🔴 **`integer_only` is expressed as `step="1"`** — the storefront's own
   * wording, because there is no `integer` attribute and a browser that does not
   * know the rule still refuses a fraction.
   */
  it('expresses integer_only as a step of one', () => {
    expect(fieldConstraints({ integer_only: true }).step).toBe(1);
  });

  /**
   * 🔴 **A quantity always steps by one, whatever the merchant set.** Three
   * numeric templates, two behaviours: `number_field` and `range` fall back to
   * `integer_only`; `quantity.php` falls back to `'1'` unconditionally, because
   * a quantity is inherently whole. The rendered fixture shows `step="1"` on a
   * quantity whose validation set neither rule.
   *
   * ✏️ **This function took no `presentation` at first**, so it could not make
   * the distinction: a merchant previewing a quantity saw a field accepting
   * `2.5` that the storefront refuses.
   */
  it('steps a quantity by one even with no rule set', () => {
    expect(fieldConstraints({}, 'quantity').step).toBe(1);
  });

  it('does not step a number field with no rule set', () => {
    expect(fieldConstraints({}, 'number_field').step).toBeUndefined();
  });

  it('does not step a range with no rule set', () => {
    expect(fieldConstraints({}, 'range').step).toBeUndefined();
  });

  /** An explicit step still wins on a quantity. */
  it('prefers an explicit step over a quantity’s implied one', () => {
    expect(fieldConstraints({ step: 5 }, 'quantity').step).toBe(5);
  });

  /** A merchant who set a step meant it. */
  it('prefers an explicit step over integer_only', () => {
    expect(fieldConstraints({ integer_only: true, step: 0.5 }).step).toBe(0.5);
  });

  /**
   * ⚠️ **`step="0"` makes a number input refuse every value**, which is why the
   * template tests `> 0` rather than merely "is numeric".
   */
  it('ignores a step of zero', () => {
    expect(fieldConstraints({ step: 0 }).step).toBeUndefined();
  });

  /** `maxlength="0"` refuses every character. */
  it('ignores a length limit of zero', () => {
    expect(fieldConstraints({ max_length: 0 }).maxLength).toBeUndefined();
  });

  it('omits anything that is not a number', () => {
    expect(fieldConstraints({ min: 'one', max: null, step: '2' })).toEqual({
      min: undefined,
      max: undefined,
      step: undefined,
      maxLength: undefined,
    });
  });

  /**
   * ⚠️ **Selection and date bounds are server-enforced only**, and no template
   * emits them — verified against `rendered-fixtures.json`, where a
   * `date_picker` carries `required` and nothing else despite the fixture
   * setting both date rules. A preview that invented them would show a customer
   * a limit their browser will not apply.
   */
  it('emits nothing for rules the storefront never sends to a browser', () => {
    expect(
      fieldConstraints({
        min_selections: 1,
        max_selections: 3,
        min_date: '2026-01-01',
        max_date: '2026-12-31',
        pattern: '^[a-z]+$',
      }),
    ).toEqual({ min: undefined, max: undefined, step: undefined, maxLength: undefined });
  });

  it('handles an option with no validation at all', () => {
    expect(fieldConstraints(null)).toEqual({
      min: undefined,
      max: undefined,
      step: undefined,
      maxLength: undefined,
    });
  });
});
