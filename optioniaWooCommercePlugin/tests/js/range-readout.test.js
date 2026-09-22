import { describe, expect, it } from 'vitest';

import { fire, loadStorefront } from './harness.js';

/**
 * The number shown beside a slider, updated as the customer drags.
 *
 * 🔴 **A slider is the one control that says nothing about itself.** A radio
 * shows its label, a text field shows the text — a range shows a thumb on a
 * track and no number at all. On a size or an engraving depth, *"which value did
 * I pick?"* is the entire question, and the browser does not answer it.
 */
const slider = (min, max, value) => `
  <div data-optionia="options">
    <div data-optionia="option" data-optionia-option="opt-r">
      <input type="range" data-optionia="value" data-optionia-range="1"
             min="${min}" max="${max}" value="${value}">
      <output data-optionia="range-value">${value}</output>
    </div>
  </div>`;

const readout = (document) =>
  document.querySelector('[data-optionia="range-value"]').textContent;

describe('slider readout', () => {
  it('shows the starting value before anything is dragged', async () => {
    const { document } = await loadStorefront(slider(10, 50, 25));

    expect(readout(document)).toBe('25');
  });

  /**
   * 🔴 **`input`, not `change`.**
   *
   * A range fires `change` only when the customer lets go — by which point they
   * have already read a stale number and decided. `input` fires on every pixel
   * of the drag, which is what makes the readout worth having.
   */
  it('follows the slider as it moves', async () => {
    const { window, document } = await loadStorefront(slider(10, 50, 25));

    const input = document.querySelector('input[type="range"]');
    input.value = '40';
    fire(window, input, 'input');

    expect(readout(document)).toBe('40');
  });

  it('follows a second move', async () => {
    const { window, document } = await loadStorefront(slider(0, 100, 50));

    const input = document.querySelector('input[type="range"]');

    input.value = '75';
    fire(window, input, 'input');
    expect(readout(document)).toBe('75');

    input.value = '12';
    fire(window, input, 'input');
    expect(readout(document)).toBe('12');
  });

  /**
   * 🔴 **First paint corrects a readout the server could not know.**
   *
   * With no default, `range.php` renders the readout at the **minimum** and the
   * input with no `value` attribute — at which point the browser places the
   * thumb at the **midpoint**. Measured on the real fixture: readout `10`,
   * thumb at 30.
   *
   * So the two disagree before anything is dragged, and only the browser knows
   * where the thumb actually is. A mutant removing this loop survived until this
   * test existed.
   *
   * ✏️ **The expected value is measured, not assumed.** The HTML default for a
   * value-less range is the midpoint *of 0–100*, which jsdom reports as `50`
   * here rather than the 30 that midpoint-of-10-to-50 would give. Whatever the
   * number, the point stands: it is not the `10` the server wrote.
   */
  it('corrects the readout on first paint when no value is set', async () => {
    const { document } = await loadStorefront(`
      <div data-optionia="options">
        <div data-optionia="option">
          <input type="range" data-optionia="value" data-optionia-range="1" min="10" max="50">
          <output data-optionia="range-value">10</output>
        </div>
      </div>`);

    // Not the server's `10` — the correction is the whole point.
    expect(readout(document)).not.toBe('10');
    expect(readout(document)).toBe('50');
  });

  /**
   * A slider with no readout element must not throw.
   *
   * A theme overriding `range.php` may drop the `<output>` while keeping the
   * control; the runtime returns early rather than taking the page down.
   */
  it('tolerates a slider with no readout', async () => {
    const { window, document } = await loadStorefront(`
      <div data-optionia="options">
        <div data-optionia="option">
          <input type="range" data-optionia="value" data-optionia-range="1" min="0" max="10" value="5">
        </div>
      </div>`);

    const input = document.querySelector('input[type="range"]');
    input.value = '8';

    expect(() => fire(window, input, 'input')).not.toThrow();
  });
});
