import { describe, expect, it } from 'vitest';

import { fire, loadStorefront } from './harness.js';

/**
 * What the page shows, and what the form then submits (M17.9).
 *
 * 🔴 **The test class the 17-9 audit found missing, and the defect it found.**
 *
 * Every other suite here asserts one end or the other: `rule-fixtures.test.js`
 * proves the evaluator decides correctly, `rule-visibility.test.js` proves the
 * page reacts. Neither proved that **the two ends agree for one interaction** —
 * and they did not.
 *
 * Measured: hiding a typed option cleared the field but left it enabled, so the
 * form still submitted `opt-b=""`. The server reads that as a value supplied for
 * a rule-hidden option and refuses the line with `hidden_by_rule`, where an
 * absent key is accepted. A customer following the UI exactly could not add to
 * cart — the stage's own purpose, defeated by the gap between "looks hidden" and
 * "submits nothing".
 *
 * So these assert the **payload**, which is the only thing the server ever sees.
 */

/** What this form would actually POST, as `SelectionResolver` receives it. */
function submitted(window, root) {
  const payload = {};
  const controls = root.querySelectorAll('[data-optionia="value"]');

  controls.forEach((control) => {
    /* A disabled control submits nothing. That is the whole point. */
    if (control.disabled) {
      return;
    }

    if ('radio' === control.type || 'checkbox' === control.type) {
      if (control.checked) {
        payload[optionIdOf(control)] = control.value;
      }

      return;
    }

    payload[optionIdOf(control)] = control.value;
  });

  return payload;
}

/** The option id a control belongs to. */
function optionIdOf(control) {
  const owner = control.closest('[data-optionia-option]');

  return owner ? owner.getAttribute('data-optionia-option') : '(none)';
}

function page() {
  return `
    <div class="optionia-options" data-optionia="options" data-optionia-product="1">
      <fieldset data-optionia="group" data-optionia-group="group-a">
        <div data-optionia="option" data-optionia-option="opt-a">
          <label><input type="radio" name="optionia[opt-a]" value="yes" data-optionia="value"> Yes</label>
          <label><input type="radio" name="optionia[opt-a]" value="no" data-optionia="value"> No</label>
        </div>
      </fieldset>
      <fieldset data-optionia="group" data-optionia-group="group-b">
        <div data-optionia="option" data-optionia-option="opt-text">
          <input type="text" name="optionia[opt-text]" data-optionia="value">
        </div>
        <div data-optionia="option" data-optionia-option="opt-select">
          <select name="optionia[opt-select]" data-optionia="value">
            <option value="">Choose</option>
            <option value="lux" data-optionia-value="val-lux">Luxury</option>
          </select>
        </div>
      </fieldset>
    </div>
  `;
}

function hideRule(targetType, targetId) {
  return {
    target_type: targetType,
    target_id: targetId,
    action: 'hide',
    match_type: 'all',
    conditions: [{ option_id: 'opt-a', operator: 'equals', value: 'yes' }],
  };
}

describe('what the page shows and what it submits', () => {
  /**
   * 🔴 The defect itself: an empty string is not the same as an absent key.
   *
   * `SelectionResolver` refuses `opt-text=''` for a rule-hidden option and
   * accepts its absence. Asserting `hidden` would pass either way.
   */
  it('submits no key at all for a hidden text option', async () => {
    const { window } = await loadStorefront(page(), { rules: [hideRule('option', 'opt-text')] });
    const root = window.document.querySelector('[data-optionia="options"]');

    window.document.querySelector('input[type="text"]').value = 'Engraving';

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    const payload = submitted(window, root);

    expect(payload).not.toHaveProperty('opt-text');
    expect(payload['opt-a']).toBe('yes');
  });

  /** A select always submits too, so it needs the same treatment. */
  it('submits no key at all for a hidden select option', async () => {
    const { window } = await loadStorefront(page(), { rules: [hideRule('option', 'opt-select')] });
    const root = window.document.querySelector('[data-optionia="options"]');

    window.document.querySelector('select').value = 'lux';

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(submitted(window, root)).not.toHaveProperty('opt-select');
  });

  /** Hiding a group must take every control inside it out of the payload. */
  it('submits nothing for any option in a hidden group', async () => {
    const { window } = await loadStorefront(page(), { rules: [hideRule('group', 'group-b')] });
    const root = window.document.querySelector('[data-optionia="options"]');

    window.document.querySelector('input[type="text"]').value = 'Engraving';
    window.document.querySelector('select').value = 'lux';

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    const payload = submitted(window, root);

    expect(payload).not.toHaveProperty('opt-text');
    expect(payload).not.toHaveProperty('opt-select');
  });

  /**
   * 🔴 The control that matters most: a re-shown option must submit again.
   *
   * Disabling is how a hidden control stops submitting, so a bug that forgot to
   * re-enable it would make the option permanently unanswerable — silently, and
   * only for customers who changed their mind.
   */
  it('submits again once the rule stops firing', async () => {
    const { window } = await loadStorefront(page(), { rules: [hideRule('option', 'opt-text')] });
    const root = window.document.querySelector('[data-optionia="options"]');

    const yes = window.document.querySelector('input[value="yes"]');
    const no = window.document.querySelector('input[value="no"]');

    yes.checked = true;
    fire(window, yes, 'change');
    expect(submitted(window, root)).not.toHaveProperty('opt-text');

    yes.checked = false;
    no.checked = true;
    fire(window, no, 'change');

    const field = window.document.querySelector('input[type="text"]');
    field.value = 'Typed again';

    expect(submitted(window, root)['opt-text']).toBe('Typed again');
  });

  /**
   * 🔴 A rule reading a hidden field must reach the same answer as the server.
   *
   * The hidden template renders a bare `<input>` with no option wrapper, so the
   * runtime could not see the field at all — it evaluated the rule against
   * **nothing** while the server evaluated it against the merchant's configured
   * value. Same rule, same page, two answers; the page showed an option the
   * server had hidden. Found by the 17-9 audit.
   *
   * The value is the merchant's, on both ends: `rule_answers()` substitutes
   * `default_value` server-side, and the template prints that same value here.
   */
  it('reads a hidden field, so a rule on it decides the same way as the server', async () => {
    const markup = `
      <div class="optionia-options" data-optionia="options" data-optionia-product="1">
        <fieldset data-optionia="group" data-optionia-group="group-a">
          <input type="hidden" name="optionia[opt-h]" value="batch-77"
            data-optionia="value" data-optionia-option="opt-h">
          <div data-optionia="option" data-optionia-option="opt-text">
            <input type="text" name="optionia[opt-text]" data-optionia="value">
          </div>
        </fieldset>
      </div>`;

    const { window } = await loadStorefront(markup, {
      rules: [{
        target_type: 'option',
        target_id: 'opt-text',
        action: 'hide',
        match_type: 'all',
        conditions: [{ option_id: 'opt-h', operator: 'equals', value: 'batch-77' }],
      }],
    });

    expect(window.document.querySelector('[data-optionia-option="opt-text"]').hidden).toBe(true);
  });

  /**
   * ...and the hidden field itself is never cleared or disabled by a rule.
   *
   * It carries merchant data, not an answer. Disabling it would drop a batch
   * code from the order because an unrelated rule fired.
   */
  it('never clears or disables a hidden field', async () => {
    const markup = `
      <div class="optionia-options" data-optionia="options" data-optionia-product="1">
        <fieldset data-optionia="group" data-optionia-group="group-a">
          <div data-optionia="option" data-optionia-option="opt-a">
            <label><input type="radio" name="optionia[opt-a]" value="yes" data-optionia="value"> Yes</label>
          </div>
        </fieldset>
        <fieldset data-optionia="group" data-optionia-group="group-b">
          <input type="hidden" name="optionia[opt-h]" value="batch-77"
            data-optionia="value" data-optionia-option="opt-h">
        </fieldset>
      </div>`;

    const { window } = await loadStorefront(markup, {
      rules: [{
        target_type: 'group',
        target_id: 'group-b',
        action: 'hide',
        match_type: 'all',
        conditions: [{ option_id: 'opt-a', operator: 'equals', value: 'yes' }],
      }],
    });

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    const field = window.document.querySelector('input[type="hidden"]');

    expect(field.value).toBe('batch-77');
    expect(field.disabled).toBe(false);
  });

  /**
   * ⚠️ A control the merchant disabled stays disabled.
   *
   * `revealAll()` re-enables only what a rule disabled, tracked by attribute —
   * so an upload in flight, or a merchant's own disabled field, is not switched
   * on by an unrelated rule ceasing to fire.
   */
  it('does not enable a control the runtime never disabled', async () => {
    const markup = page().replace(
      '<input type="text" name="optionia[opt-text]" data-optionia="value">',
      '<input type="text" name="optionia[opt-text]" data-optionia="value" disabled>',
    );

    const { window } = await loadStorefront(markup, { rules: [hideRule('option', 'opt-select')] });

    const yes = window.document.querySelector('input[value="yes"]');
    const no = window.document.querySelector('input[value="no"]');

    yes.checked = true;
    fire(window, yes, 'change');
    yes.checked = false;
    no.checked = true;
    fire(window, no, 'change');

    expect(window.document.querySelector('input[type="text"]').disabled).toBe(true);
  });
});
