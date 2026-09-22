import { describe, expect, it } from 'vitest';

import { estimate, fire, loadStorefront, pricedOption } from './harness.js';

/**
 * The running estimate shown as a customer chooses options.
 *
 * ## Why these exist
 *
 * 🔴 **A dropdown's estimate totalled £0 for an entire stage.** `selectedTotal`
 * queried `'[data-optionia="value"]:checked'`, but that attribute marks the
 * *control*: for a radio the input itself, and for a `<select>` the select —
 * which is never `:checked`. The prices sit on its `<option>` children, so the
 * sum was over an empty list.
 *
 * It shipped in Stage 2a and was found in Stage 3b while scoping an unrelated
 * feature. No test could have caught it, because the plugin had no JavaScript
 * tests at all.
 *
 * ⚠️ **Nothing here is authoritative.** The server recomputes at add-to-cart
 * (AC4); a customer with the console open can make this display any number. What
 * these assert is that an honest customer sees an honest number.
 */

const OPTIONS_BLOCK = (inner) => `
  <div data-optionia="options">
    ${inner}
    <p data-optionia="estimate" hidden></p>
  </div>`;

const radio = (key, minor) =>
  `<input type="radio" name="o" data-optionia="value" value="${key}"
          data-optionia-price-type="fixed" data-optionia-price="${minor}">`;

describe('price estimate', () => {
  describe('dropdown', () => {
    /**
     * 🔴 **The regression test for the £0 bug.**
     *
     * A `<select>` is never `:checked`; its selected `<option>` carries the
     * price. This fails against the original selector.
     */
    it('totals the selected option, not the select', async () => {
      const { window, document } = await loadStorefront(
        OPTIONS_BLOCK(`
          <select data-optionia="value">
            <option value="">Choose</option>
            ${pricedOption('lux', 'Luxury', 1050)}
          </select>`),
      );

      const select = document.querySelector('select');
      select.value = 'lux';
      fire(window, select, 'change');

      expect(estimate(document)).toEqual({ visible: true, text: '+£10.50' });
    });

    /** The placeholder carries no price, so nothing is shown. */
    it('shows nothing while the placeholder is selected', async () => {
      const { document } = await loadStorefront(
        OPTIONS_BLOCK(`
          <select data-optionia="value">
            <option value="">Choose</option>
            ${pricedOption('lux', 'Luxury', 1050)}
          </select>`),
      );

      expect(estimate(document).visible).toBe(false);
    });
  });

  describe('radio', () => {
    it('totals the checked input', async () => {
      const { window, document } = await loadStorefront(
        OPTIONS_BLOCK(`${radio('a', 500)}${radio('b', 750)}`),
      );

      const [, second] = document.querySelectorAll('input[type="radio"]');
      second.checked = true;
      fire(window, second, 'change');

      expect(estimate(document).text).toBe('+£7.50');
    });

    it('shows nothing when none is chosen', async () => {
      const { document } = await loadStorefront(OPTIONS_BLOCK(radio('a', 500)));

      expect(estimate(document).visible).toBe(false);
    });
  });

  /**
   * 🔴 **A radio and a dropdown on one product must both count.**
   *
   * The bug was invisible on a product with only a dropdown *and* on one with
   * only radios — the first showed nothing at all, which looks like "no priced
   * options", and the second worked. It is the mixed case that shows a total
   * that is wrong rather than absent, and wrong-but-plausible is the failure
   * that reaches a customer.
   */
  it('sums a radio and a dropdown together', async () => {
    const { window, document } = await loadStorefront(
      OPTIONS_BLOCK(`
        ${radio('a', 500)}
        <select data-optionia="value">
          <option value="">Choose</option>
          ${pricedOption('lux', 'Luxury', 1050)}
        </select>`),
    );

    const input = document.querySelector('input[type="radio"]');
    input.checked = true;
    fire(window, input, 'change');

    const select = document.querySelector('select');
    select.value = 'lux';
    fire(window, select, 'change');

    expect(estimate(document).text).toBe('+£15.50');
  });

  /**
   * ⚠️ **An unpriceable type hides the estimate rather than under-counting.**
   *
   * `percentage`, `per_unit`, `per_char` and `tiered` each need a decision
   * `PRICING-SPEC.md` has not made. A partial total is the failure mode worth
   * avoiding: it looks right. `selectedTotal` returns null, and the estimate
   * disappears — the same rule the server follows one layer up.
   */
  it('hides the estimate when a chosen value cannot be priced', async () => {
    const { window, document } = await loadStorefront(
      OPTIONS_BLOCK(`
        ${radio('a', 500)}
        <select data-optionia="value">
          <option value="">Choose</option>
          ${pricedOption('pct', 'Percentage', null, 'percentage')}
        </select>`),
    );

    const input = document.querySelector('input[type="radio"]');
    input.checked = true;
    fire(window, input, 'change');

    expect(estimate(document).text).toBe('+£5.00');

    const select = document.querySelector('select');
    select.value = 'pct';
    fire(window, select, 'change');

    expect(estimate(document)).toEqual({ visible: false, text: '' });
  });

  /**
   * A text option contributes nothing to the estimate.
   *
   * Text prices `per_char`, computed server-side from `Engine\Text::measure()`
   * and deliberately not previewed: a client-side count disagreeing with the
   * server's is the M14.4b credibility bug. The field carries no price
   * attributes, so it is invisible to the total rather than counted as zero.
   */
  it('ignores a text field', async () => {
    const { window, document } = await loadStorefront(
      OPTIONS_BLOCK(`
        ${radio('a', 500)}
        <input type="text" data-optionia="value" value="Mum">`),
    );

    const input = document.querySelector('input[type="radio"]');
    input.checked = true;
    fire(window, input, 'change');

    const text = document.querySelector('input[type="text"]');
    text.value = 'Something much longer';
    fire(window, text, 'change');

    expect(estimate(document).text).toBe('+£5.00');
  });

  /**
   * ⚠️ **An empty `<select>` has `selectedIndex === -1`.**
   *
   * Measured, not assumed: a select with no options at all reports -1, and
   * `options[-1]` is `undefined`. A theme or a published document with an
   * option set that lost its values can produce one, and reading a price off
   * `undefined` would throw on a product page (Principle 7).
   *
   * The bound check that prevents it survived every mutant until this test.
   */
  it('tolerates a select with no options', async () => {
    const { document } = await loadStorefront(
      OPTIONS_BLOCK('<select data-optionia="value"></select>'),
    );

    expect(estimate(document).visible).toBe(false);
  });

  /**
   * 🔴 **A non-numeric price contributes nothing rather than `NaN`.**
   *
   * `parseInt('abc', 10)` is `NaN`, and `0 + NaN` is `NaN` — which would render
   * as `+£NaN` on a live product page. The `|| 0` fallback is what stops it, and
   * a mutant removing it survived the whole suite.
   *
   * A corrupt attribute is not hypothetical: it is what a partially-written
   * cache entry or a theme filter mangling output produces.
   */
  it('ignores a price attribute that is not a number', async () => {
    const { window, document } = await loadStorefront(
      OPTIONS_BLOCK(`
        <input type="radio" data-optionia="value" value="a"
               data-optionia-price-type="fixed" data-optionia-price="abc">`),
    );

    const input = document.querySelector('input[type="radio"]');
    input.checked = true;
    fire(window, input, 'change');

    // Nothing to add, so nothing shown — and emphatically not "+£NaN".
    expect(estimate(document).text).not.toContain('NaN');
    expect(estimate(document).visible).toBe(false);
  });

  /**
   * A corrupt price among good ones does not poison the total.
   *
   * The single-value case above shows nothing either way; this is the case that
   * distinguishes "contributed zero" from "made the whole sum `NaN`".
   */
  it('keeps totalling when one price is corrupt', async () => {
    const { window, document } = await loadStorefront(
      OPTIONS_BLOCK(`
        <input type="radio" name="x" data-optionia="value" value="a"
               data-optionia-price-type="fixed" data-optionia-price="abc">
        <input type="checkbox" data-optionia="value" value="b"
               data-optionia-price-type="fixed" data-optionia-price="500">`),
    );

    document.querySelector('input[type="radio"]').checked = true;
    const box = document.querySelector('input[type="checkbox"]');
    box.checked = true;
    fire(window, box, 'change');

    expect(estimate(document).text).toBe('+£5.00');
  });

  /**
   * Zero is shown as nothing, not as "+£0.00".
   *
   * A free choice that displays a zero surcharge reads as a broken calculation
   * rather than an absent one.
   */
  it('shows nothing for a free choice', async () => {
    const { window, document } = await loadStorefront(OPTIONS_BLOCK(radio('a', 0)));

    const input = document.querySelector('input[type="radio"]');
    input.checked = true;
    fire(window, input, 'change');

    expect(estimate(document).visible).toBe(false);
  });
});
