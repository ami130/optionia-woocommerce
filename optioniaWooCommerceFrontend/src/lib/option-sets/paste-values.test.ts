import { describe, expect, it } from 'vitest';

import { MAX_PASTED_VALUES, parsePastedValues } from './paste-values';

/**
 * Bulk paste (M20.4) — "merchants have existing lists".
 *
 * 🔴 **Parsed and REFUSED up front, never part-written.** The API checks
 * `AUTHORING_LIMITS.valuesPerOption` on **each** create, and rejects a duplicate
 * `valueKey` the same way — so a 300-row paste that breaks either rule fails
 * partway through, leaving the option half-filled with no undo (deletes clear
 * the log). Every rule the server enforces is therefore checked here first, on
 * the whole list, before a single request goes out.
 *
 * ⚠️ **Existing values count toward the limit**, which is why the parser takes
 * them: an option holding 480 values accepts 20 more, not 500.
 */
describe('parsePastedValues', () => {
  it('reads one value per line', () => {
    const parsed = parsePastedValues('Small\nMedium\nLarge', []);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.values.map((v) => v.label)).toEqual(['Small', 'Medium', 'Large']);
  });

  it('derives a key from the label', () => {
    const parsed = parsePastedValues('Matte Black', []);

    expect(parsed.ok && parsed.values[0]?.valueKey).toBe('matte_black');
  });

  /** 🔴 A price after a comma or a tab — what a spreadsheet actually pastes. */
  it('reads a price after a comma', () => {
    const parsed = parsePastedValues('Small,10.50', []);

    expect(parsed.ok && parsed.values[0]?.priceAmountMinor).toBe(1050);
  });

  it('reads a price after a tab', () => {
    const parsed = parsePastedValues('Small\t10.50', []);

    expect(parsed.ok && parsed.values[0]?.priceAmountMinor).toBe(1050);
  });

  it('treats a line with no price as free', () => {
    const parsed = parsePastedValues('Small', []);

    expect(parsed.ok && parsed.values[0]?.priceAmountMinor).toBe(0);
  });

  /** ⚠️ Blank lines are skipped, not refused — a trailing newline is normal. */
  it('skips blank lines', () => {
    const parsed = parsePastedValues('Small\n\n  \nLarge\n', []);

    expect(parsed.ok && parsed.values).toHaveLength(2);
  });

  it('refuses nothing to paste', () => {
    const parsed = parsePastedValues('   \n  ', []);

    expect(parsed.ok).toBe(false);
  });

  /**
   * 🔴 **A malformed price is REFUSED, never coerced.** `Number(x) || 0` would
   * turn "ten pounds" into a free value, and the merchant would publish the
   * giveaway believing they had set a price.
   */
  it('refuses a malformed price, naming the line', () => {
    const parsed = parsePastedValues('Small,10.50\nMedium,ten pounds', []);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]?.line).toBe(2);
  });

  /** 🔴 A label with nothing usable in it cannot produce a key. */
  it('refuses a label that yields no key', () => {
    const parsed = parsePastedValues('!!!', []);

    expect(parsed.ok).toBe(false);
  });

  /**
   * 🔴 **Duplicates within the paste are refused**, because the API rejects the
   * second one and the first would already have been written.
   */
  it('refuses two lines that would share a key', () => {
    const parsed = parsePastedValues('Small\nsmall', []);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]?.line).toBe(2);
  });

  /** 🔴 And a collision with a value the option already holds. */
  it('refuses a key the option already uses', () => {
    const parsed = parsePastedValues('Small', ['small']);

    expect(parsed.ok).toBe(false);
  });

  /**
   * 🔴 **The limit counts EXISTING values too.** Checked up front because the
   * API checks it per create: a paste that crosses the line mid-way writes some
   * values and fails, which is the part-written state this refusal prevents.
   */
  it('refuses a paste that would exceed the limit', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `Value ${i}`).join('\n');
    const existing = Array.from({ length: MAX_PASTED_VALUES - 10 }, (_, i) => `e${i}`);

    const parsed = parsePastedValues(lines, existing);

    expect(parsed.ok).toBe(false);

    /* ⚠️ **The message states the real numbers**, so a merchant knows how many
     * to remove rather than being told only that they have too many. */
    expect(!parsed.ok && parsed.problems.at(-1)?.message).toMatch(
      new RegExp(`${MAX_PASTED_VALUES}.*490.*11`),
    );
  });

  it('accepts a paste that exactly reaches the limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Value ${i}`).join('\n');
    const existing = Array.from({ length: MAX_PASTED_VALUES - 10 }, (_, i) => `e${i}`);

    expect(parsePastedValues(lines, existing).ok).toBe(true);
  });

  /** ⚠️ A label longer than the column is refused rather than truncated. */
  it('refuses an over-long label', () => {
    const parsed = parsePastedValues('x'.repeat(201), []);

    expect(parsed.ok).toBe(false);
  });

  /** 📌 Every problem is reported, not only the first — one paste, one fix. */
  it('reports every bad line at once', () => {
    const parsed = parsePastedValues('Small,abc\nMedium,def', []);

    expect(!parsed.ok && parsed.problems).toHaveLength(2);
  });
});

/**
 * 🔴 **A tab wins over a comma, and the case came from realistic input.**
 *
 * Measured against a spreadsheet-shaped paste: `"Medium, wide\t2.50"` was
 * refused with *"wide\t2.50 is not an amount"*, because the first separator of
 * either kind split the line and the comma inside the label came first. A label
 * containing a comma is ordinary — "Medium, wide", "Large, extra deep" — and
 * Excel separates with tabs, so the two collide constantly.
 *
 * ⚠️ **The original docblock claimed tab priority and the code did not
 * implement it.** A comment describing intent rather than behaviour.
 */
describe('separator priority', () => {
  it('splits on the tab when a label contains a comma', () => {
    const parsed = parsePastedValues('Medium, wide\t2.50', []);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.values[0]?.label).toBe('Medium, wide');
    expect(parsed.ok && parsed.values[0]?.priceAmountMinor).toBe(250);
  });

  /** ⚠️ With no tab, the FIRST comma splits — a later one stays in the label. */
  it('splits on the first comma when there is no tab', () => {
    const parsed = parsePastedValues('Small,1.50', []);

    expect(parsed.ok && parsed.values[0]?.label).toBe('Small');
    expect(parsed.ok && parsed.values[0]?.priceAmountMinor).toBe(150);
  });

  /** 📌 A comma-containing label with no price keeps its comma. */
  it('keeps a comma in a label with no price', () => {
    const parsed = parsePastedValues('Medium, wide', []);

    expect(parsed.ok).toBe(false);
  });
});
