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
