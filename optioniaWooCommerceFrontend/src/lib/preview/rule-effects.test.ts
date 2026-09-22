import { describe, expect, it } from 'vitest';

import { evaluateRules } from '@/lib/rules/rule-evaluator';

import { optionsUnder } from './options-under';
import { previewTree } from './preview-tree';
import { pricingState, ruleEffects } from './rule-effects';
import type { AuthoringSet } from '@/lib/option-sets/api';

const value = (id: string) => ({
  id, valueKey: id, label: id, sortOrder: 0,
  priceType: 'fixed', priceAmountMinor: 0, isEnabled: true,
});

const option = (id: string, values: unknown[] = []) => ({
  id, key: id, label: id, presentation: 'dropdown',
  isRequired: false, sortOrder: 0, isEnabled: true, values,
});

const group = (id: string, options: unknown[]) => ({
  id, label: id, description: null, sortOrder: 0, isEnabled: true,
  displayType: 'inline', isCollapsible: false, items: [], options,
});

const tree = (groups: unknown[], rules: unknown[]) =>
  previewTree({
    id: 's', storeId: 'x', name: 'n', status: 'draft', version: 1, rowVersion: 1,
    publishedAt: null, publishedConfigVersion: 0, groups, rules,
  } as unknown as AuthoringSet);

const rule = (over: Record<string, unknown>) => ({
  id: 'r1', targetType: 'option', targetId: 'o1', action: 'hide', matchType: 'all',
  conditions: [{ optionId: 'trigger', operator: 'equals', value: 'yes' }],
  actionValue: null, sortOrder: 0, isEnabled: true, disabledReason: null, ...over,
});

function effectsFor(groups: unknown[], rules: unknown[], answers: Record<string, unknown>) {
  const t = tree(groups, rules);
  const under = optionsUnder(t);
  const valueIds = new Set(
    t.groups.flatMap((g) => g.options.flatMap((o) => o.values.map((v) => v.id))),
  );

  return ruleEffects(evaluateRules(t.rules as never, answers, under), under, valueIds);
}

describe('ruleEffects', () => {
  /**
   * 🔴 **F21.** A rule hiding a GROUP must hide every option inside it. The
   * evaluator reports state for the group id only, so a renderer reading option
   * states alone draws the whole group — which is what the preview did.
   */
  it('hides every option inside a hidden group', () => {
    const effects = effectsFor(
      [group('g1', [option('trigger', [value('yes')])]), group('g2', [option('o2'), option('o3')])],
      [rule({ targetType: 'group', targetId: 'g2' })],
      { trigger: 'yes' },
    );

    expect([...effects.hiddenOptions].sort()).toEqual(['o2', 'o3']);
  });

  it('hides an option targeted directly', () => {
    const effects = effectsFor(
      [group('g1', [option('trigger', [value('yes')]), option('o2')])],
      [rule({ targetId: 'o2' })],
      { trigger: 'yes' },
    );

    expect([...effects.hiddenOptions]).toEqual(['o2']);
  });

  /**
   * 🔴 **F22.** A value target hides that value and nothing else — not its
   * option, and not its option's other values. `hidden_values()` is a separate
   * mechanism from the containment expansion for exactly this reason.
   */
  it('hides a single value without touching its option', () => {
    const effects = effectsFor(
      [group('g1', [option('trigger', [value('yes')]), option('o2', [value('v1'), value('v2')])])],
      [rule({ targetType: 'value', targetId: 'v1' })],
      { trigger: 'yes' },
    );

    expect([...effects.hiddenValues]).toEqual(['v1']);
    expect([...effects.hiddenOptions]).toEqual([]);
  });

  it('reports nothing when no rule fires', () => {
    const effects = effectsFor(
      [group('g1', [option('trigger', [value('yes')]), option('o2')])],
      [rule({ targetId: 'o2' })],
      {},
    );

    expect(effects.hiddenOptions.size).toBe(0);
    expect(effects.hiddenValues.size).toBe(0);
  });

  /**
   * 🔴 **A state exists without `hidden` being true.** A `require` rule records
   * `{ hidden: false, required: true }`, and a reader that walked every state
   * regardless would hide the option it merely made mandatory.
   *
   * ✏️ **Added because a mutation survived.** Removing the `hidden` guard broke
   * no test: the "no rule fires" case leaves **no state at all** (measured,
   * `states.size === 0`), so it never exercised the guard it appeared to cover.
   */
  it('ignores a state whose rule fired without hiding anything', () => {
    const effects = effectsFor(
      [group('g1', [option('trigger', [value('yes')]), option('o2')])],
      [rule({ targetId: 'o2', action: 'require' })],
      { trigger: 'yes' },
    );

    expect(effects.hiddenOptions.size).toBe(0);
    expect(effects.hiddenValues.size).toBe(0);
  });

  /**
   * ⚠️ **A hidden value must not fall through into the expansion.**
   * `optionsUnder` maps a value to an **empty** list, so falling through is
   * harmless today — but only by accident of that map, and the M17.8 audit is
   * the reason that map is empty. Pinned so the two facts cannot drift apart:
   * if a value ever mapped to its option again, this fails rather than silently
   * hiding the question along with the choice.
   */
  it('does not let a hidden value reach the containment expansion', () => {
    const t = tree(
      [group('g1', [option('trigger', [value('yes')]), option('o2', [value('v1')])])],
      [rule({ targetType: 'value', targetId: 'v1' })],
    );

    /* A deliberately WRONG map, the pre-M17.8 one: value -> its option. */
    const broadMap = new Map([...optionsUnder(t), ['v1', ['o2']]]);
    const valueIds = new Set(['yes', 'v1']);
    const effects = ruleEffects(
      evaluateRules(t.rules as never, { trigger: 'yes' }, broadMap),
      broadMap,
      valueIds,
    );

    expect([...effects.hiddenValues]).toEqual(['v1']);
    expect([...effects.hiddenOptions]).toEqual([]);
  });

  /** A group and a value hidden at once are kept in their own buckets. */
  it('keeps group and value effects apart', () => {
    const effects = effectsFor(
      [
        group('g1', [option('trigger', [value('yes')])]),
        group('g2', [option('o2', [value('v1')])]),
      ],
      [
        rule({ id: 'r1', targetType: 'group', targetId: 'g2' }),
        rule({ id: 'r2', targetType: 'value', targetId: 'v1', sortOrder: 10 }),
      ],
      { trigger: 'yes' },
    );

    expect([...effects.hiddenOptions]).toEqual(['o2']);
    expect([...effects.hiddenValues]).toEqual(['v1']);
  });
});

describe('pricingState', () => {
  const state = (over: Record<string, unknown> = {}) =>
    ({ hidden: false, required: null, priceMinor: null, priceConflict: false, ...over }) as never;

  it('uses the option’s price when the value has none', () => {
    expect(pricingState(state({ priceMinor: 500 }), undefined)).toEqual({
      priceMinor: 500,
      priceConflict: false,
    });
  });

  /** 🔴 **F23.** The value wins, exactly as `set_price_for()` prefers it. */
  it('prefers the value’s price over the option’s', () => {
    expect(pricingState(state({ priceMinor: 500 }), state({ priceMinor: 700 }))).toEqual({
      priceMinor: 700,
      priceConflict: false,
    });
  });

  it('refuses when the option conflicts', () => {
    expect(pricingState(state({ priceConflict: true, priceMinor: 500 }), undefined)).toEqual({
      priceMinor: null,
      priceConflict: true,
    });
  });

  /** A conflict on either side refuses — the storefront checks both. */
  it('refuses when the value conflicts', () => {
    expect(pricingState(state({ priceMinor: 500 }), state({ priceConflict: true }))).toEqual({
      priceMinor: null,
      priceConflict: true,
    });
  });

  it('reports nothing when no rule set a price', () => {
    expect(pricingState(undefined, undefined)).toEqual({ priceMinor: null, priceConflict: false });
  });
});
