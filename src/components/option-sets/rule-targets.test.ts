import { describe, expect, it } from 'vitest';

import type { AuthoringSet } from '@/lib/option-sets/api';

import { answerableIn, choicesFor, targetsIn } from './rule-targets';

/**
 * What the rule builder may offer (M17.6).
 *
 * 🔴 **The defect these exist to prevent is a set that cannot be published.**
 * `assertTargetIsWhatItClaims` checks only that a target exists — anywhere in
 * the tenant — and whether it belongs to *this* set is a publish-time check
 * whose severity is `BLOCKER`. So a picker offering a foreign id lets a merchant
 * save a rule successfully and then block publish for the whole set, with only
 * one cure: find and delete the rule.
 */

const set = {
  id: 'set-1',
  groups: [
    {
      id: 'group-a',
      label: 'Customisation',
      options: [
        {
          id: 'opt-a',
          label: 'Engraving',
          values: [
            { id: 'val-yes', valueKey: 'yes', label: 'Yes' },
            { id: 'val-no', valueKey: 'no', label: 'No' },
          ],
        },
        { id: 'opt-b', label: 'Engraving Text', values: [] },
      ],
    },
    {
      id: 'group-b',
      label: 'Delivery',
      options: [{ id: 'opt-c', label: 'Speed', values: [] }],
    },
  ],
} as unknown as AuthoringSet;

describe('what a rule may target', () => {
  /**
   * 🔴 Every id comes from the loaded set, so a foreign one is unreachable by
   * construction rather than by a check somebody has to remember.
   */
  it('offers only ids that belong to this set', () => {
    const ids = targetsIn(set).map((target) => target.id);

    expect(ids).toEqual([
      'group-a',
      'opt-a',
      'val-yes',
      'val-no',
      'opt-b',
      'group-b',
      'opt-c',
    ]);
  });

  it('names each id by the kind a rule calls it', () => {
    const kinds = new Map(targetsIn(set).map((target) => [target.id, target.kind]));

    expect(kinds.get('group-a')).toBe('group');
    expect(kinds.get('opt-a')).toBe('option');
    expect(kinds.get('val-yes')).toBe('value');
  });

  /**
   * ⚠️ A bare "Yes" is ambiguous in a set with two yes/no options — and a
   * value-targeted rule is exactly where that ambiguity bites. `summary.ts`
   * labels them the same way, so the picker and the sentence agree.
   */
  it('reads a value with the option that owns it', () => {
    const value = targetsIn(set).find((target) => target.id === 'val-yes');

    expect(value?.label).toBe('Engraving: Yes');
  });
});

describe('what a condition may read', () => {
  /**
   * 🔴 **Options only.** A condition asks what the customer *answered*, and only
   * an option holds an answer — a group is a heading and a value is one of the
   * possible answers. `EvaluableCondition.optionId` says the same in its name.
   */
  it('offers options, never groups or values', () => {
    const ids = answerableIn(set).map((option) => option.id);

    expect(ids).toEqual(['opt-a', 'opt-b', 'opt-c']);
  });
});

describe('the choices a condition compares against', () => {
  /**
   * 🔴 **Keys, not ids.** A condition is compared against what the *customer
   * submits*, which the templates render as the `value_key`. Comparing against a
   * value id would compare an answer to something no form ever posts, and the
   * rule would silently never fire.
   */
  it('returns value keys, not value ids', () => {
    expect(choicesFor(set, 'opt-a')).toEqual([
      { key: 'yes', label: 'Yes' },
      { key: 'no', label: 'No' },
    ]);
  });

  it('returns nothing for an option with no choices', () => {
    expect(choicesFor(set, 'opt-b')).toEqual([]);
  });

  it('returns nothing for an id this set does not contain', () => {
    expect(choicesFor(set, 'opt-elsewhere')).toEqual([]);
  });
});
