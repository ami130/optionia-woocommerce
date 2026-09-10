import { describe, expect, it } from 'vitest';

import { estimate, fire, loadStorefront, rebind } from './harness.js';

/**
 * Money formatting and the bind guard — driven through the DOM, like everything
 * else here, because `frontend.js` exports nothing.
 */

const block = (minor) => `
  <div data-optionia="options">
    <input type="radio" data-optionia="value" value="a"
           data-optionia-price-type="fixed" data-optionia-price="${minor}">
    <p data-optionia="estimate" hidden></p>
  </div>`;

async function totalWith(minor, currency) {
  const { window, document } = await loadStorefront(block(minor), { currency });

  const input = document.querySelector('input');
  input.checked = true;
  fire(window, input, 'change');

  return estimate(document).text;
}

describe('money formatting', () => {
  it('writes minor units as the store writes money', async () => {
    expect(await totalWith(1050)).toBe('+£10.50');
  });

  /**
   * Thousands are separated.
   *
   * A four-figure option is rare and not absurd — a bespoke finish, an oversized
   * frame — and `+£120000` for £1,200.00 is the kind of number a customer reads
   * as a mistake.
   */
  it('separates thousands', async () => {
    expect(await totalWith(120000)).toBe('+£1,200.00');
  });

  /**
   * A store whose currency uses the opposite conventions.
   *
   * `1.234,56` rather than `1,234.56`, with the symbol after the amount. These
   * come from WooCommerce's own settings, so a hard-coded assumption here is
   * wrong for a large part of Europe.
   */
  it('honours a comma decimal and a trailing symbol', async () => {
    const text = await totalWith(123456, {
      symbol: '€',
      decimal: ',',
      thousand: '.',
      format: '%2$s%1$s',
    });

    expect(text).toBe('+1.234,56€');
  });

  /**
   * A zero-decimal currency.
   *
   * Yen has no minor unit, so `decimals: 0` means the integer *is* the amount.
   * Dividing by 100 anyway would show ¥12 for ¥1,200.
   */
  it('handles a currency with no decimal places', async () => {
    const text = await totalWith(1200, { symbol: '¥', decimals: 0 });

    expect(text).toBe('+¥1,200');
  });

  /**
   * ⚠️ **No settings at all must not throw.**
   *
   * `optioniaSettings` is localised by `Assets.php`, but a caching plugin that
   * defers or strips inline script would leave it undefined. The estimate is a
   * convenience; taking the product page's JavaScript down with it is not
   * acceptable (Principle 7).
   */
  it('falls back to sane defaults when settings are missing', async () => {
    const { window, document } = await loadStorefront(block(1050), { settings: false });

    const input = document.querySelector('input');
    input.checked = true;
    fire(window, input, 'change');

    // No symbol is configured, so none is shown — but the amount is still right.
    expect(estimate(document).text).toBe('+10.50');
  });
});

describe('binding', () => {
  /**
   * 🔴 **Binding twice does not look broken — it totals wrong.**
   *
   * That is `bind()`'s own comment, and the reason for the `data-optionia-bound`
   * guard. Nothing re-runs `init()` today, but `found_variation` and a page
   * builder injecting a block after load both will.
   *
   * Re-dispatching `DOMContentLoaded` is the closest a test can get to that
   * without the future caller existing: if the guard were removed, a second
   * `init()` would attach a second `change` listener.
   */
  it('marks a bound block so it is not bound twice', async () => {
    const { document } = await loadStorefront(block(500));

    expect(document.querySelector('[data-optionia="options"]').hasAttribute('data-optionia-bound')).toBe(
      true,
    );
  });

  /**
   * 🔴 **The guard, actually exercised.**
   *
   * ✏️ **The assertion above does not test it.** It checks the marker attribute
   * is *set*, which stays true whether or not anything reads it — measured: a
   * mutant replacing the guard with `if ( false )` passed every test in this
   * suite. That is a check passing without exercising its subject, in the test
   * written specifically for the subject.
   *
   * Listener count is the observable damage. `bind()`'s own comment is the
   * reason: a doubled `change` listener *"does not look broken -- it just totals
   * wrong"*. With the guard a second run adds nothing; without it, both
   * listeners are attached again.
   */
  it('attaches no second set of listeners when the runtime re-runs', async () => {
    const { window } = await loadStorefront(block(500));

    expect(rebind(window)).toBe(0);
  });

  /**
   * A doubled listener still totals once.
   *
   * The estimate is recomputed from scratch on every event rather than
   * accumulated, so even a doubled handler produces the same number — this
   * asserts that property holds, which is what makes the guard a safety net
   * rather than the only thing standing between a customer and a wrong price.
   */
  it('totals the same after a second change event', async () => {
    const { window, document } = await loadStorefront(block(500));

    const input = document.querySelector('input');
    input.checked = true;

    fire(window, input, 'change');
    fire(window, input, 'change');

    expect(estimate(document).text).toBe('+£5.00');
  });

  /**
   * A page with no options block binds nothing and throws nothing.
   *
   * `init()` runs on every page the script is enqueued on, including ones with
   * no options at all.
   */
  it('does nothing on a page with no options', async () => {
    const { document } = await loadStorefront('<p>No options here</p>');

    expect(document.querySelector('[data-optionia-bound]')).toBeNull();
  });

  /**
   * An options block with no estimate element is not an error.
   *
   * A theme overriding the wrapper template may omit it; the counter and the
   * rest of the runtime must keep working.
   */
  it('tolerates a block with no estimate element', async () => {
    const { window, document } = await loadStorefront(`
      <div data-optionia="options">
        <input type="radio" data-optionia="value" value="a"
               data-optionia-price-type="fixed" data-optionia-price="500">
      </div>`);

    const input = document.querySelector('input');
    input.checked = true;

    expect(() => fire(window, input, 'change')).not.toThrow();
  });
});
