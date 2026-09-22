import { describe, expect, it } from 'vitest';

import { evaluateRules } from '@/lib/rules/rule-evaluator';

import { optionsUnder } from './options-under';
import { previewTree } from './preview-tree';
import type { AuthoringSet } from '@/lib/option-sets/api';

function tree(groups: unknown[], rules: unknown[] = []) {
  return previewTree({
    id: 's', storeId: 'x', name: 'n', status: 'draft', version: 1, rowVersion: 1,
    publishedAt: null, publishedConfigVersion: 0,
    groups, rules,
  } as unknown as AuthoringSet);
}

function grp(id: string, options: unknown[], over: Record<string, unknown> = {}) {
  return {
    id, label: id, description: null, sortOrder: 0, isEnabled: true,
    displayType: 'inline', isCollapsible: false, items: [], options, ...over,
  };
}

function opt(id: string, values: unknown[] = [], over: Record<string, unknown> = {}) {
  return {
    id, key: id, label: id, presentation: 'dropdown', isRequired: false,
    sortOrder: 0, isEnabled: true, values, ...over,
  };
}

function val(id: string, over: Record<string, unknown> = {}) {
  return {
    id, valueKey: id, label: id, sortOrder: 0,
    priceType: 'fixed', priceAmountMinor: 0, isEnabled: true, ...over,
  };
}

describe('optionsUnder', () => {
  it('maps a group to every option inside it', () => {
    const map = optionsUnder(tree([grp('g1', [opt('o1'), opt('o2')])]));

    expect(map.get('g1')).toEqual(['o1', 'o2']);
  });

  it('maps an option to itself', () => {
    expect(optionsUnder(tree([grp('g1', [opt('o1')])])).get('o1')).toEqual(['o1']);
  });

  /**
   * 🔴 **The M17.8 rule.** A value clears nothing — not even its own option's
   * answer. Mapping it to the owning option deleted a real customer's answer.
   */
  it('maps a value to nothing at all', () => {
    const map = optionsUnder(tree([grp('g1', [opt('o1', [val('v1')])])]));

    expect(map.get('v1')).toEqual([]);
  });

  /**
   * Known-and-clears-nothing is a different state from never-heard-of-it, and
   * the plugin registers values explicitly for exactly that reason.
   */
  it('registers a value as a known target rather than omitting it', () => {
    const map = optionsUnder(tree([grp('g1', [opt('o1', [val('v1')])])]));

    expect(map.has('v1')).toBe(true);
  });

  it('registers a group that contains no options', () => {
    const map = optionsUnder(tree([grp('empty', [])]));

    expect(map.get('empty')).toEqual([]);
  });

  it('keeps each group to its own options', () => {
    const map = optionsUnder(tree([grp('g1', [opt('o1')]), grp('g2', [opt('o2')])]));

    expect(map.get('g1')).toEqual(['o1']);
    expect(map.get('g2')).toEqual(['o2']);
  });

  /**
   * The map is built from the preview projection, where disabled nodes are
   * already filtered — so it describes the storefront's document, not the
   * editor's tree. A disabled option is not a target the storefront can hide,
   * because it was never published.
   */
  it('omits what the storefront never receives', () => {
    const map = optionsUnder(
      tree([grp('g1', [opt('live'), opt('off', [], { isEnabled: false })])]),
    );

    expect(map.get('g1')).toEqual(['live']);
    expect(map.has('off')).toBe(false);
  });

  describe('through the real evaluator', () => {
    /**
     * 🔴 **The M17.8 defect, reproduced end to end.**
     *
     * A rule hides `v-extra`, a value of `o-colour`. The customer has answered
     * `o-colour` with `plain`. With the broad map that answer is deleted, and an
     * unrelated rule reading *"o-colour is empty"* then fires and hides `o-third`
     * — an option nothing was meant to touch.
     *
     * With the correct map, the answer survives and the second rule stays quiet.
     */
    it('does not clear an answer when a value is hidden', () => {
      const t = tree(
        [grp('g1', [opt('o-colour', [val('v-extra')]), opt('o-third'), opt('o-trigger')])],
        [
          {
            id: 'r1', targetType: 'value', targetId: 'v-extra', action: 'hide',
            matchType: 'all', sortOrder: 0, isEnabled: true, disabledReason: null,
            actionValue: null,
            conditions: [{ optionId: 'o-trigger', operator: 'equals', value: 'yes' }],
          },
          {
            id: 'r2', targetType: 'option', targetId: 'o-third', action: 'hide',
            matchType: 'all', sortOrder: 1, isEnabled: true, disabledReason: null,
            actionValue: null,
            conditions: [{ optionId: 'o-colour', operator: 'is_empty' }],
          },
        ],
      );

      const outcome = evaluateRules(
        t.rules as never,
        { 'o-trigger': 'yes', 'o-colour': 'plain' },
        optionsUnder(t),
      );

      expect(outcome.states.get('v-extra')?.hidden).toBe(true);
      expect(outcome.states.get('o-third')?.hidden ?? false).toBe(false);
    });

    /**
     * The control: a rule hiding the OPTION does clear its answer, so the test
     * above cannot pass by the evaluator simply never clearing anything.
     */
    it('does clear an answer when the owning option is hidden', () => {
      const t = tree(
        [grp('g1', [opt('o-colour'), opt('o-third'), opt('o-trigger')])],
        [
          {
            id: 'r1', targetType: 'option', targetId: 'o-colour', action: 'hide',
            matchType: 'all', sortOrder: 0, isEnabled: true, disabledReason: null,
            actionValue: null,
            conditions: [{ optionId: 'o-trigger', operator: 'equals', value: 'yes' }],
          },
          {
            id: 'r2', targetType: 'option', targetId: 'o-third', action: 'hide',
            matchType: 'all', sortOrder: 1, isEnabled: true, disabledReason: null,
            actionValue: null,
            conditions: [{ optionId: 'o-colour', operator: 'is_empty' }],
          },
        ],
      );

      const outcome = evaluateRules(
        t.rules as never,
        { 'o-trigger': 'yes', 'o-colour': 'plain' },
        optionsUnder(t),
      );

      expect(outcome.states.get('o-colour')?.hidden).toBe(true);
      expect(outcome.states.get('o-third')?.hidden).toBe(true);
    });

    /** A group target clears every answer inside it. */
    it('clears every answer under a hidden group', () => {
      const t = tree(
        [
          grp('g1', [opt('o-a'), opt('o-b')]),
          grp('g2', [opt('o-trigger'), opt('o-watch')]),
        ],
        [
          {
            id: 'r1', targetType: 'group', targetId: 'g1', action: 'hide',
            matchType: 'all', sortOrder: 0, isEnabled: true, disabledReason: null,
            actionValue: null,
            conditions: [{ optionId: 'o-trigger', operator: 'equals', value: 'yes' }],
          },
          {
            id: 'r2', targetType: 'option', targetId: 'o-watch', action: 'hide',
            matchType: 'all', sortOrder: 1, isEnabled: true, disabledReason: null,
            actionValue: null,
            conditions: [{ optionId: 'o-b', operator: 'is_empty' }],
          },
        ],
      );

      const outcome = evaluateRules(
        t.rules as never,
        { 'o-trigger': 'yes', 'o-a': 'x', 'o-b': 'y' },
        optionsUnder(t),
      );

      expect(outcome.states.get('g1')?.hidden).toBe(true);
      expect(outcome.states.get('o-watch')?.hidden).toBe(true);
    });
  });
});
