import { describe, expect, it } from 'vitest';

import { fire, loadStorefront } from './harness.js';

/**
 * Show and hide on the page (M17.9).
 *
 * 🔴 **Black-box, against markup shaped like the real templates.** The runtime
 * exports nothing, so these drive it the way a customer does: dispatch an event,
 * assert the DOM. What the templates and the script agree to call things is
 * pinned separately by `frontend-contract.test.js`.
 *
 * ⚠️ **These assert what a customer SEES, never what the evaluator returned.**
 * The evaluator is proven against the shared fixture in `rule-fixtures.test.js`;
 * duplicating that here would test the same logic twice and the binding not at
 * all. The defect this file exists to catch is a correct decision applied to the
 * wrong element — which is how the dropdown £0 bug happened.
 */

/** Two options in two groups, shaped like the rendered templates. */
function page() {
  return `
    <div class="optionia-options" data-optionia="options" data-optionia-product="1">
      <fieldset data-optionia="group" data-optionia-group="group-a">
        <div data-optionia="option" data-optionia-option="opt-a">
          <label><input type="radio" name="optionia[opt-a]" value="yes"
            data-optionia="value" data-optionia-value="val-yes"> Yes</label>
          <label><input type="radio" name="optionia[opt-a]" value="no"
            data-optionia="value" data-optionia-value="val-no"> No</label>
        </div>
      </fieldset>
      <fieldset data-optionia="group" data-optionia-group="group-b">
        <div data-optionia="option" data-optionia-option="opt-b">
          <input type="text" name="optionia[opt-b]" data-optionia="value">
        </div>
      </fieldset>
    </div>
  `;
}

/** One rule, in the shape `Assets::publish_rules()` emits. */
function rule(targetType, targetId, action, optionId, operator, value) {
  const condition = { option_id: optionId, operator };

  if (undefined !== value) {
    condition.value = value;
  }

  return {
    target_type: targetType,
    target_id: targetId,
    action,
    match_type: 'all',
    conditions: [condition],
  };
}

describe('rule-driven visibility', () => {
  it('hides an option when its rule fires', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const target = window.document.querySelector('[data-optionia-option="opt-b"]');

    expect(target.hidden).toBe(false);

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(target.hidden).toBe(true);
  });

  it('shows it again when the rule stops firing', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const target = window.document.querySelector('[data-optionia-option="opt-b"]');
    const yes = window.document.querySelector('input[value="yes"]');
    const no = window.document.querySelector('input[value="no"]');

    yes.checked = true;
    fire(window, yes, 'change');
    expect(target.hidden).toBe(true);

    yes.checked = false;
    no.checked = true;
    fire(window, no, 'change');

    expect(target.hidden).toBe(false);
  });

  /**
   * 🔴 ADR-051: not charged, not stored, **not restored**.
   *
   * Restoring would mean the page holds a value the customer cannot see, cannot
   * edit and did not re-confirm — and charges for it the moment a rule flips.
   */
  it('clears what the customer typed, and does not restore it', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const typed = window.document.querySelector('input[type="text"]');
    typed.value = 'Happy Birthday';

    const yes = window.document.querySelector('input[value="yes"]');
    const no = window.document.querySelector('input[value="no"]');

    yes.checked = true;
    fire(window, yes, 'change');
    expect(typed.value).toBe('');

    yes.checked = false;
    no.checked = true;
    fire(window, no, 'change');

    expect(typed.value).toBe('');
  });

  it('hides every option in a group when the group is the target', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('group', 'group-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const group = window.document.querySelector('[data-optionia-group="group-b"]');
    const yes = window.document.querySelector('input[value="yes"]');

    yes.checked = true;
    fire(window, yes, 'change');

    expect(group.hidden).toBe(true);
  });

  /**
   * 🔴 Hiding one value must not take the question with it.
   *
   * The asymmetry `containmentIn()` preserves, and the defect M17.8's audit
   * found on the server: a value maps to no option, so hiding a choice leaves
   * the option answerable with its others.
   */
  it('hides one value without hiding the option that owns it', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('value', 'val-no', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const option = window.document.querySelector('[data-optionia-option="opt-a"]');
    const no = window.document.querySelector('[data-optionia-value="val-no"]');
    const yes = window.document.querySelector('input[value="yes"]');

    yes.checked = true;
    fire(window, yes, 'change');

    expect(no.hidden).toBe(true);
    expect(option.hidden).toBe(false);
  });

  /**
   * ⚠️ A page whose defaults already satisfy a rule must paint correctly, not
   * flash the whole form and then collapse it.
   */
  it('applies rules on first paint, not only on change', async () => {
    const markup = page().replace(
      'value="yes"\n            data-optionia="value"',
      'value="yes" checked\n            data-optionia="value"',
    );

    const { window } = await loadStorefront(markup, {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    expect(window.document.querySelector('[data-optionia-option="opt-b"]').hidden).toBe(true);
  });

  /** A page with no rules is exactly the page the merchant authored. */
  it('changes nothing when there are no rules', async () => {
    const { window } = await loadStorefront(page(), {});

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(window.document.querySelector('[data-optionia-option="opt-b"]').hidden).toBe(false);
  });

  /**
   * 🔴 The runtime must survive the evaluator failing to load.
   *
   * A CDN hiccup or an aggressive optimiser plugin can drop one file. AC3's
   * point is that the storefront degrades rather than breaks: every option
   * visible is the safe direction, because the server still refuses what it
   * must.
   */
  it('shows every option when the evaluator is missing', async () => {
    const { window } = await loadStorefront(page(), {
      engine: false,
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(window.document.querySelector('[data-optionia-option="opt-b"]').hidden).toBe(false);
  });

  /**
   * 🔴 The estimate refuses when a `set_price` rule could change the total.
   *
   * The amount a rule sets never reaches the page — `action_value` is withheld,
   * because a price on the storefront is a second source of truth for a number
   * AC4 makes server-authoritative. So the browser knows *that* a rule sets a
   * price and never *what*.
   *
   * Measured by the 17-11 exit audit: a value authored at 5.00 with a rule
   * setting 25.00 showed **+£5.00** while the server charged **£25.00**. The
   * estimate now shows nothing, which is the line `selectedTotal()` already
   * draws for every price type it cannot compute.
   */
  it('shows no estimate when a rule sets a price', async () => {
    const markup = `
      <div class="optionia-options" data-optionia="options" data-optionia-product="1">
        <fieldset data-optionia="group" data-optionia-group="group-a">
          <div data-optionia="option" data-optionia-option="opt-a">
            <label><input type="checkbox" name="optionia[opt-a]" value="gift" data-optionia="value"
              data-optionia-price-type="fixed" data-optionia-price="500"> Gift</label>
          </div>
        </fieldset>
        <p data-optionia="estimate" hidden></p>
      </div>`;

    const { window } = await loadStorefront(markup, {
      rules: [{
        target_type: 'option',
        target_id: 'opt-a',
        action: 'set_price',
        match_type: 'all',
        conditions: [{ option_id: 'opt-a', operator: 'is_not_empty' }],
      }],
    });

    const gift = window.document.querySelector('input[type="checkbox"]');
    gift.checked = true;
    fire(window, gift, 'change');

    expect(window.document.querySelector('[data-optionia="estimate"]').textContent).toBe('');
  });

  /**
   * The control: with no `set_price` rule, the same option still estimates.
   *
   * Without it, a runtime that had stopped estimating entirely would satisfy
   * the test above — and a missing estimate everywhere is its own defect.
   */
  it('still estimates when no rule sets a price', async () => {
    const markup = `
      <div class="optionia-options" data-optionia="options" data-optionia-product="1">
        <fieldset data-optionia="group" data-optionia-group="group-a">
          <div data-optionia="option" data-optionia-option="opt-a">
            <label><input type="checkbox" name="optionia[opt-a]" value="gift" data-optionia="value"
              data-optionia-price-type="fixed" data-optionia-price="500"> Gift</label>
          </div>
        </fieldset>
        <p data-optionia="estimate" hidden></p>
      </div>`;

    const { window } = await loadStorefront(markup, {});

    const gift = window.document.querySelector('input[type="checkbox"]');
    gift.checked = true;
    fire(window, gift, 'change');

    expect(window.document.querySelector('[data-optionia="estimate"]').textContent).toContain('5');
  });

  /**
   * 🔴 Focus does not stay on a field a rule has just hidden.
   *
   * Measured before this: a customer typing in an option when a rule hid it kept
   * focus on an element that was then `hidden` **and** `disabled` — an invisible
   * tab stop, and a screen reader with nothing to announce. M17.5 asks to "keep
   * focus management sane", and there was no focus code at all, only comments
   * about it.
   */
  it('moves focus out of an option it is hiding', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const typed = window.document.querySelector('input[type="text"]');
    typed.focus();

    expect(window.document.activeElement).toBe(typed);

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(window.document.activeElement).not.toBe(typed);
  });

  /**
   * ⚠️ ...and does not steal focus when the customer is elsewhere.
   *
   * A rule usually fires because a *different* option was answered, so taking
   * focus from the control they just used would be its own defect. Without this
   * control, a `blur()` on every pass would satisfy the test above.
   */
  it('leaves focus alone when the hidden option did not have it', async () => {
    const { window } = await loadStorefront(page(), {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const yes = window.document.querySelector('input[value="yes"]');
    yes.focus();
    yes.checked = true;
    fire(window, yes, 'change');

    expect(window.document.activeElement).toBe(yes);
  });

  /**
   * 🔴 A rule says what it did, for a customer who cannot see it happen.
   *
   * Silence is indistinguishable from nothing having happened. The region is
   * `screen-reader-text` rather than `hidden`, because a hidden live region is
   * removed from the accessibility tree and never announced.
   */
  it('announces that options were removed', async () => {
    /*
     * The live region, inside the block. `page()` is a fragment shaped like the
     * real partial; the partial itself emits this region, and
     * `frontend-contract.test.js` pins that the templates and the runtime agree
     * on its name.
     */
    const markup = page().replace(
      /<\/div>\s*$/,
      '<p data-optionia="rule-status" role="status" aria-live="polite"></p></div>',
    );

    const { window } = await loadStorefront(markup, {
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const status = window.document.querySelector('[data-optionia="rule-status"]');

    expect(status.textContent).toBe('');

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(status.textContent).not.toBe('');
  });

  /** One product's rules must not reach another's controls. */
  it('ignores rules published for a different product', async () => {
    const { window } = await loadStorefront(page(), {
      productId: 999,
      rules: [rule('option', 'opt-b', 'hide', 'opt-a', 'equals', 'yes')],
    });

    const yes = window.document.querySelector('input[value="yes"]');
    yes.checked = true;
    fire(window, yes, 'change');

    expect(window.document.querySelector('[data-optionia-option="opt-b"]').hidden).toBe(false);
  });
});
