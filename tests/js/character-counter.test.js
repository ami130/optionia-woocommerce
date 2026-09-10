import { describe, expect, it } from 'vitest';

import { fire, loadStorefront } from './harness.js';

/**
 * The live `12/20` beside a text field.
 *
 * ## Why these exist
 *
 * M14.4b makes the counter **required** wherever a limit exists: *"Silently
 * rejecting the 21st character of an engraving is a support ticket and often an
 * abandoned cart."*
 *
 * 🔴 **And it must count the way the server counts.** In `optionia-app` the
 * price and the counter were written separately, so `"AB CD"` is charged as five
 * characters while the counter beside the field shows four — live there today.
 * Display and server agree with each other, which is why it survived: it is not
 * a pricing bug but a **credibility** one, on engraving.
 *
 * The parity was proven twice by throwaway harnesses that were then deleted.
 * This is the version that stays.
 */

const textField = (max, value = '') => `
  <div data-optionia="options">
    <div data-optionia="option" data-optionia-option="opt-t">
      <input type="text" data-optionia="value" data-optionia-max="${max}"
             maxlength="${max}" value="${value}">
      <p data-optionia="counter" aria-live="polite">
        <span data-optionia="counter-used">0</span>/<span data-optionia="counter-max">${max}</span>
      </p>
    </div>
  </div>`;

const used = (document) =>
  document.querySelector('[data-optionia="counter-used"]').textContent;

describe('character counter', () => {
  it('counts what the customer typed', async () => {
    const { window, document } = await loadStorefront(textField(20));

    const input = document.querySelector('input[type="text"]');
    input.value = 'Mum';
    fire(window, input, 'input');

    expect(used(document)).toBe('3');
  });

  /**
   * 🔴 **Graphemes, not `String.length`.**
   *
   * `.length` is UTF-16 code units: a family emoji is **11**, a flag is 4, and a
   * combining accent splits `é` into 2. The server counts grapheme clusters via
   * `Engine\Text::measure()`, because one flag is one mark in the engraved
   * material.
   *
   * Each expectation below is PHP's answer, taken from a direct comparison run
   * across both implementations.
   */
  it.each([
    ['Mum', 3],
    ['AB CD', 5],
    // Inner spaces survive: the space between two names is cut into the material.
    ['AB  CD', 6],
    ['John Smith', 10],
    // Combining accent: one character, two code points.
    ['café', 4],
    // ZWJ family: `.length` says 11.
    ['\u{1F468}‍\u{1F469}‍\u{1F467}', 1],
    // Regional-indicator flag: `.length` says 4.
    ['\u{1F1EC}\u{1F1E7}', 1],
    // Skin-tone modifier: `.length` says 4.
    ['\u{1F44D}\u{1F3FD}', 1],
  ])('counts %j as %i, as the server does', async (text, expected) => {
    const { window, document } = await loadStorefront(textField(50));

    const input = document.querySelector('input[type="text"]');
    input.value = text;
    fire(window, input, 'input');

    expect(used(document)).toBe(String(expected));
  });

  /**
   * 🔴 **The fallback for browsers without `Intl.Segmenter`.**
   *
   * Older Safari has no `Intl.Segmenter`, so `measure()` falls back to
   * `Array.from().length` — code **points**, not code units. That is still wrong
   * for a ZWJ family, and far closer than `.length`: measured, the family emoji
   * counts 5 rather than 11, and a flag counts 2 rather than 4.
   *
   * ⚠️ **It over-counts, never under-counts**, which is the safe direction: the
   * customer is warned early rather than refused by surprise at submit, and the
   * server (`Engine\Text::measure()`) is what actually decides.
   *
   * Untested until now — a mutant breaking this path survived every test, so the
   * browsers most likely to need the fallback had zero coverage.
   */
  describe('without Intl.Segmenter', () => {
    it.each([
      ['Mum', 3],
      ['AB CD', 5],
      ['café', 4],
      ['John Smith', 10],
    ])('counts plain text %j as %i, exactly as Segmenter does', async (text, expected) => {
      const { window, document } = await loadStorefront(textField(50), { segmenter: false });

      const input = document.querySelector('input[type="text"]');
      input.value = text;
      fire(window, input, 'input');

      expect(used(document)).toBe(String(expected));
    });

    /**
     * Emoji over-count, and that is the documented trade.
     *
     * `Array.from` iterates by code point, so a ZWJ family is 5 and a flag is 2.
     * Asserted rather than tolerated: if this ever silently became `.length` the
     * numbers would be 11 and 4, and nothing else in the suite would notice.
     */
    it.each([
      ['\u{1F468}‍\u{1F469}‍\u{1F467}', 5],
      ['\u{1F1EC}\u{1F1E7}', 2],
    ])('over-counts %j as %i rather than under-counting', async (text, expected) => {
      const { window, document } = await loadStorefront(textField(50), { segmenter: false });

      const input = document.querySelector('input[type="text"]');
      input.value = text;
      fire(window, input, 'input');

      expect(used(document)).toBe(String(expected));
    });
  });

  /**
   * ⚠️ **Outer whitespace is trimmed before counting, inner is not.**
   *
   * `Engine\Text::normalise()` runs first, always: leading and trailing space is
   * a typing artefact that engraves nothing visible, and no customer intends to
   * pay for it. The space *between* two names is different — it is cut.
   */
  it('trims the ends before counting', async () => {
    const { window, document } = await loadStorefront(textField(50));

    const input = document.querySelector('input[type="text"]');
    input.value = '  Mum  ';
    fire(window, input, 'input');

    expect(used(document)).toBe('3');
  });

  /**
   * 🔴 **`input`, not `change`.**
   *
   * A counter that only updates when the field loses focus is a counter the
   * customer never sees move — which is the same as not having one.
   */
  it('updates as the customer types, not only on blur', async () => {
    const { window, document } = await loadStorefront(textField(20));

    const input = document.querySelector('input[type="text"]');
    input.value = 'Mum';
    fire(window, input, 'input');

    expect(used(document)).toBe('3');
  });

  /**
   * The count is right on first paint, before anything is typed.
   *
   * A pre-filled default beside a counter reading `0/20` is wrong the moment the
   * page renders. The template emits the initial number server-side and the
   * script corrects it on bind; both must agree.
   */
  it('is correct for a pre-filled default', async () => {
    const { document } = await loadStorefront(textField(20, 'Mum'));

    expect(used(document)).toBe('3');
  });

  /**
   * ⚠️ **Over the limit is flagged, even though `maxlength` usually prevents it.**
   *
   * `maxlength` counts UTF-16 code units while this counts graphemes, so an
   * emoji the browser lets through can still exceed the real limit. The server
   * refuses it either way (AC4); the customer should see why before submitting.
   */
  it('flags an answer over the limit', async () => {
    const { window, document } = await loadStorefront(textField(3));

    const input = document.querySelector('input[type="text"]');
    input.value = 'Much too long';
    fire(window, input, 'input');

    const option = document.querySelector('[data-optionia="option"]');
    expect(option.classList.contains('optionia-option--over-limit')).toBe(true);
  });

  it('clears the flag when the answer fits again', async () => {
    const { window, document } = await loadStorefront(textField(3));

    const input = document.querySelector('input[type="text"]');
    const option = document.querySelector('[data-optionia="option"]');

    input.value = 'Much too long';
    fire(window, input, 'input');
    expect(option.classList.contains('optionia-option--over-limit')).toBe(true);

    input.value = 'Mum';
    fire(window, input, 'input');
    expect(option.classList.contains('optionia-option--over-limit')).toBe(false);
  });

  /**
   * ⚠️ **A text field with no counter markup must not throw.**
   *
   * A theme overriding `text_field.php` may drop the counter while keeping the
   * input, and a merchant may publish a limit from an older dashboard that never
   * set `character_counter`. `refreshCounter` returns early in both cases.
   *
   * Untested until now: mutants removing either guard survived the whole suite.
   */
  it('tolerates an input with no counter element', async () => {
    const { window, document } = await loadStorefront(`
      <div data-optionia="options">
        <div data-optionia="option">
          <input type="text" data-optionia="value" data-optionia-max="20" value="">
        </div>
      </div>`);

    const input = document.querySelector('input[type="text"]');
    input.value = 'Mum';

    expect(() => fire(window, input, 'input')).not.toThrow();
  });

  /**
   * An input outside any option wrapper is ignored rather than fatal.
   *
   * `refreshCounter` walks up to `[data-optionia="option"]`; a theme that
   * restructures the markup can leave the input without one.
   */
  it('tolerates an input outside an option wrapper', async () => {
    const { window, document } = await loadStorefront(`
      <div data-optionia="options">
        <input type="text" data-optionia="value" data-optionia-max="20" value="">
      </div>`);

    const input = document.querySelector('input[type="text"]');
    input.value = 'Mum';

    expect(() => fire(window, input, 'input')).not.toThrow();
  });

  /**
   * 🔴 **A missing or malformed limit must not flag every answer as over.**
   *
   * `parseInt(null)` is `NaN`, and `count > NaN` is false — but only because of
   * the `isNaN` guard's short-circuit ordering. Without the guard the class
   * would still not be applied, so this asserts the *outcome* rather than the
   * mechanism: a counter with no limit never marks the customer over.
   *
   * The mutant dropping `! isNaN( max )` survived until this existed.
   */
  it('never flags over-limit when no limit is set', async () => {
    const { window, document } = await loadStorefront(`
      <div data-optionia="options">
        <div data-optionia="option">
          <input type="text" data-optionia="value" value="">
          <span data-optionia="counter-used">0</span>
        </div>
      </div>`);

    const input = document.querySelector('input[type="text"]');
    input.value = 'A very long engraving indeed';
    fire(window, input, 'input');

    const option = document.querySelector('[data-optionia="option"]');
    expect(option.classList.contains('optionia-option--over-limit')).toBe(false);
    // The count is still shown: no limit is not the same as no counter.
    expect(used(document)).toBe('28');
  });

  /** An empty field is zero, not blank. */
  it('shows zero for an empty field', async () => {
    const { window, document } = await loadStorefront(textField(20, 'Mum'));

    const input = document.querySelector('input[type="text"]');
    input.value = '';
    fire(window, input, 'input');

    expect(used(document)).toBe('0');
  });

  /** Whitespace alone is zero: it engraves nothing. */
  it('counts whitespace-only input as zero', async () => {
    const { window, document } = await loadStorefront(textField(20));

    const input = document.querySelector('input[type="text"]');
    input.value = '   ';
    fire(window, input, 'input');

    expect(used(document)).toBe('0');
  });
});
