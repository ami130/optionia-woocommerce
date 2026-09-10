import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fire, loadStorefront } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const JS = readFileSync(resolve(ROOT, 'assets/js/frontend.js'), 'utf8');

/**
 * Markup from the **real renderer**, produced by `generate-fixtures.php`.
 *
 * ⚠️ **Not a regex over the PHP source.** The attributes that matter sit inside
 * `<?php if ( … ) : ?>` blocks, so any `[^>]*` pattern stops at the `?>` and
 * matches nothing — a test built that way reports "no price attribute" for a
 * template full of them. Measured while writing this file.
 */
const RENDERED = JSON.parse(readFileSync(resolve(HERE, 'rendered-fixtures.json'), 'utf8'));

/** Which tag carries an attribute, in real rendered markup. */
function tagCarrying(markup, attribute) {
  return new RegExp(`<(\\w+)[^>]*?${attribute}`, 's').exec(markup)?.[1] ?? null;
}

/**
 * The `data-optionia` contract between the templates and the runtime.
 *
 * ## Why a contract test rather than more DOM tests
 *
 * 🔴 **The dropdown £0 bug was not a logic error.** The arithmetic was right;
 * the *selector* pointed at an element the template does not put prices on.
 * Every DOM test in this suite uses hand-written fixtures, so a fixture written
 * from the same misunderstanding would agree with the bug and pass.
 *
 * These read the **rendered templates** and the **real script** and check they
 * name the same things — the class of defect, not the two instances of it that
 * have already been found.
 */
describe('template ↔ runtime contract', () => {
  it('has markup for every option type', () => {
    // A fixture file that silently lost an entry is a test passing for the worst
    // possible reason.
    expect(Object.keys(RENDERED).sort()).toEqual([
      'checkbox',
      'color_swatch',
      'date_picker',
      'datetime_picker',
      'dropdown',
      // M15.2: the first control driven by a network call rather than by markup.
      'file_input',
      'hidden',
      'image_swatch',
      'number_field',
      'quantity',
      'radio',
      'range',
      'text_field',
      'textarea',
      'time_picker',
    ]);
  });

  /**
   * 🔴 **Where the price lives, per control shape.**
   *
   * This is the assertion that fails on the original bug.
   *
   * For an `<input>` type the price sits on the same element as
   * `data-optionia="value"`, and the runtime reads it via `:checked`. For a
   * `<select>` it sits on the `<option>` children — a `<select>` is never
   * `:checked` and carries no price of its own — so the runtime must read the
   * selected option instead.
   */
  it.each(
    Object.entries(RENDERED).filter(([, markup]) => markup.includes('data-optionia-price-type')),
  )('%s puts its price where the runtime looks for it', (_type, markup) => {
    const valueTag = tagCarrying(markup, 'data-optionia="value"');
    const priceTag = tagCarrying(markup, 'data-optionia-price-type');

    expect(valueTag).toBeTruthy();
    expect(priceTag).toBeTruthy();

    if (valueTag === 'select') {
      /*
       * ⚠️ **A `<select>` must not carry the price itself.**
       *
       * It is never `:checked`, so a price on the select is a price the runtime
       * cannot read — the original bug, in the template rather than the script.
       * A mutant that moved it here survived while this branch only checked
       * that a string appeared in the source.
       */
      expect(priceTag).toBe('option');
      expect(JS).toContain('select[data-optionia="value"]');
      expect(JS).toMatch(/\.options\[\s*\w+\s*\]/);
    } else {
      // Every other control carries its own price and is read via `:checked`.
      expect(valueTag).toBe('input');
      expect(priceTag).toBe('input');
      expect(JS).toContain('input[data-optionia="value"]:checked');
    }
  });

  /**
   * A text field carries no price attribute at all.
   *
   * Its pricing is `per_char`, computed server-side and deliberately not
   * previewed: a client-side count disagreeing with the server's is the M14.4b
   * credibility bug.
   */
  it('emits no price attribute for a text field', () => {
    expect(RENDERED.text_field).not.toContain('data-optionia-price');
  });

  /**
   * The character limit sits on the input the runtime counts.
   *
   * `refreshCounter` reads `data-optionia-max` off the input itself; on a
   * wrapper it would be invisible to the comparison.
   */
  it('puts the character limit on the input the runtime reads', () => {
    expect(tagCarrying(RENDERED.text_field, 'data-optionia-max')).toBe('input');
    expect(JS).toContain('data-optionia-max');
  });

  /**
   * Every role the script queries is emitted by something that renders.
   *
   * A script looking for a role no template writes is a silent no-op — which is
   * how the estimate came to sum an empty list.
   */
  it('queries no role the rendered pages never emit', () => {
    const queried = new Set([...JS.matchAll(/data-optionia="([a-z-]+)"/g)].map((m) => m[1]));

    const emitted = new Set(
      Object.values(RENDERED).flatMap((markup) =>
        [...markup.matchAll(/data-optionia="([a-z-]+)"/g)].map((m) => m[1]),
      ),
    );

    const missing = [...queried].filter((role) => !emitted.has(role));

    expect(missing).toEqual([]);
  });

  /**
   * 🔴 **The end-to-end proof: real markup, driven by the real script.**
   *
   * The hand-written fixtures elsewhere in this suite could encode the same
   * misunderstanding as a bug and agree with it. This one cannot: the markup is
   * what WooCommerce actually serves, and the £10.50 is the price the merchant
   * configured.
   */
  /**
   * 🔴 **The counter, driven on the page WooCommerce actually serves.**
   *
   * `character-counter.test.js` uses hand-written markup, which is fast to read
   * but shares the weakness the £0 bug exploited: a fixture written from the
   * same misunderstanding as a bug agrees with it. This one cannot — the input,
   * the `data-optionia-max`, and the counter spans are all rendered by
   * `text_field.php`.
   *
   * The limit is 20 (set by `generate-fixtures.php`), so 3 characters is under
   * it and 21 is over.
   */
  it('counts on a real text page', async () => {
    const { window, document } = await loadStorefront(RENDERED.text_field);

    const input = document.querySelector('input[data-optionia="value"]');
    expect(input, 'the rendered page must have a text input').toBeTruthy();

    input.value = 'Mum';
    fire(window, input, 'input');

    expect(document.querySelector('[data-optionia="counter-used"]').textContent).toBe('3');
    expect(document.querySelector('[data-optionia="counter-max"]').textContent).toBe('20');
  });

  /**
   * And it flags an over-limit answer on that same real page.
   *
   * `maxlength` would stop a browser typing this, but a paste, an autofill or a
   * grapheme the attribute counts differently all reach it — and the server
   * refuses either way (AC4).
   */
  it('flags over-limit on a real text page', async () => {
    const { window, document } = await loadStorefront(RENDERED.text_field);

    const input = document.querySelector('input[data-optionia="value"]');
    input.value = 'A very long engraving indeed';
    fire(window, input, 'input');

    const option = document.querySelector('[data-optionia="option"]');
    expect(option.classList.contains('optionia-option--over-limit')).toBe(true);
  });

  it.each(['radio', 'dropdown', 'checkbox', 'color_swatch', 'image_swatch'])(
    'totals a real %s page',
    async (type) => {
      const { window, document } = await loadStorefront(RENDERED[type]);

      const select = document.querySelector('select[data-optionia="value"]');

      if (select) {
        select.value = 'lux';
        fire(window, select, 'change');
      } else {
        const input = document.querySelector('input[data-optionia="value"]');
        input.checked = true;
        fire(window, input, 'change');
      }

      const output = document.querySelector('[data-optionia="estimate"]');
      expect(output).toBeTruthy();
      expect(output.textContent).toBe('+£10.50');
    },
  );
});
