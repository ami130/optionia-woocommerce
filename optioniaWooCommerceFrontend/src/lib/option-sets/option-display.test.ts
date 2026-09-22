import { describe, expect, it } from 'vitest';

import { deriveDisplay, optionDisplayFields, readOptionDisplay } from './option-display';

/**
 * How an option is drawn, and the one setting the dashboard must DERIVE.
 *
 * 🔴 **`character_counter` is a contract the plugin states and the dashboard
 * broke.** `text_field.php`: *"The dashboard derives `character_counter` from
 * the limit rather than offering it as a separate switch, so the two cannot
 * disagree."* Making `maxLength` authorable without it produced exactly the
 * defect M14.4b names — *"silently rejecting the 21st character of an engraving
 * is a support ticket and often an abandoned cart."*
 *
 * ⚠️ **Derived, never offered.** A switch a merchant could turn off while a
 * limit was set is the disagreement the plugin's comment exists to prevent.
 */
describe('deriveDisplay', () => {
  it('turns the counter on when a length limit is set', () => {
    expect(deriveDisplay('length', { maxLength: 20 }, null)).toMatchObject({
      characterCounter: true,
    });
  });

  it('turns the counter off when the limit is removed', () => {
    expect(
      deriveDisplay('length', null, { characterCounter: true, priceDisplay: 'delta' }),
    ).toMatchObject({ characterCounter: false, priceDisplay: 'delta' });
  });

  /** ⚠️ A minimum alone is not a ceiling — nothing to count towards. */
  it('leaves the counter off for a minimum alone', () => {
    expect(deriveDisplay('length', { minLength: 3 }, null)).toMatchObject({
      characterCounter: false,
    });
  });

  /**
   * 🔴 **A number option has no characters to count**, and
   * `numberOptionPricing`'s display schema has no such field — sending one to a
   * `.strict()` schema is a refused write.
   *
   * ⚠️ Asserted with a stored setting present, because a range option with no
   * display at all correctly returns `null` — and `not.toHaveProperty` on
   * `null` throws rather than passing, which is the assertion failing for its
   * own reason rather than the code's.
   */
  it('does not set a counter on a range option', () => {
    expect(deriveDisplay('range', { max: 10 }, { tooltip: 'Why' })).toEqual({ tooltip: 'Why' });
  });

  /** 🔴 And strips one a text option left behind when the type changed. */
  it('removes a stale counter from a range option', () => {
    expect(
      deriveDisplay('range', { max: 10 }, { characterCounter: true, tooltip: 'Why' }),
    ).toEqual({ tooltip: 'Why' });
  });

  /** 📌 Settings the merchant chose are carried through untouched. */
  it('preserves other display settings', () => {
    expect(
      deriveDisplay('length', { maxLength: 20 }, { tooltip: 'Explain it', columns: 2 }),
    ).toMatchObject({ tooltip: 'Explain it', columns: 2, characterCounter: true });
  });

  /** ⚠️ Nothing to say at all is `null`, not an empty object. */
  it('returns null when there is nothing to store', () => {
    expect(deriveDisplay('range', null, null)).toBeNull();
  });
});

describe('optionDisplayFields', () => {
  it('offers columns and swatch size for a choice option', () => {
    const fields = optionDisplayFields('radio');

    expect(fields).toContain('columns');
    expect(fields).toContain('priceDisplay');
  });

  it('offers no columns for a text option', () => {
    expect(optionDisplayFields('text_field')).not.toContain('columns');
  });

  /** ⚠️ `tooltip` is shared vocabulary — a merchant learns it once. */
  it('offers a tooltip everywhere', () => {
    ['radio', 'text_field', 'number_field'].forEach((kind) => {
      expect(optionDisplayFields(kind)).toContain('tooltip');
    });
  });

  /** 🔴 Never `characterCounter` — it is derived, not chosen. */
  it('never offers the character counter', () => {
    ['radio', 'text_field', 'textarea'].forEach((kind) => {
      expect(optionDisplayFields(kind)).not.toContain('characterCounter');
    });
  });
});

describe('readOptionDisplay', () => {
  it('reads stored settings into fields', () => {
    expect(readOptionDisplay({ columns: 3, priceDisplay: 'total', tooltip: 'Why' })).toEqual({
      columns: '3',
      priceDisplay: 'total',
      tooltip: 'Why',
    });
  });

  it('reads absent display as empty', () => {
    expect(readOptionDisplay(null)).toEqual({ columns: '', priceDisplay: '', tooltip: '' });
  });
});
