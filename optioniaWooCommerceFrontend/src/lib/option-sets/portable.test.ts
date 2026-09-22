import { describe, expect, it } from 'vitest';

import type { AuthoringSet } from './api';
import { PORTABLE_VERSION, toPortable } from './portable';

/**
 * Exporting a set as JSON (M20.8).
 *
 * 🔴 **What travels is not a design decision here — `duplication.ts` already
 * made it.** `copyOptionsInto` and `copyableValueFields` define exactly which
 * fields survive a copy, and an export carrying less would silently lose
 * settings a duplicate keeps. Two answers to "what is this set, portably" is
 * two places for them to disagree.
 *
 * ⚠️ **Ids are deliberately ABSENT.** They are meaningless in another set or
 * another store, and including them would invite an importer to trust them.
 * Rules are the exception that proves it: they target by id, so an export
 * carries them by **index path** instead.
 *
 * 📌 **Versioned from the first release.** An export is a file a merchant keeps;
 * a format with no version is one nothing can ever safely change.
 */
const set = (over: Partial<AuthoringSet> = {}): AuthoringSet =>
  ({
    id: 's1',
    storeId: 'store-1',
    name: 'Finish',
    status: 'draft',
    version: 0,
    rowVersion: 1,
    publishedAt: null,
    publishedConfigVersion: 0,
    groups: [
      {
        id: 'g1',
        label: 'Finish',
        description: 'Pick one',
        sortOrder: 0,
        isEnabled: true,
        displayType: 'inline',
        isCollapsible: false,
        options: [
          {
            id: 'o1',
            key: 'colour',
            label: 'Colour',
            presentation: 'dropdown',
            isRequired: true,
            sortOrder: 0,
            isEnabled: true,
            helpText: 'Choose carefully',
            values: [
              {
                id: 'v1',
                valueKey: 'gold',
                label: 'Gold',
                sortOrder: 0,
                priceType: 'fixed',
                priceAmountMinor: 500,
                skuSuffix: '-GD',
              },
            ],
          },
        ],
        items: [{ id: 'i1', kind: 'heading', content: 'Choose a finish', sortOrder: 1 }],
      },
    ],
    ...over,
  }) as AuthoringSet;

describe('toPortable', () => {
  it('carries the set name', () => {
    expect(toPortable(set()).name).toBe('Finish');
  });

  it('declares a format version', () => {
    expect(toPortable(set()).version).toBe(PORTABLE_VERSION);
  });

  /** 🔴 Ids mean nothing in another set; carrying them would invite trust. */
  it('carries no ids', () => {
    expect(JSON.stringify(toPortable(set()))).not.toMatch(/"id"/);
  });

  /** ⚠️ Nor the store, the row version, or anything about publishing. */
  it('carries nothing about this set’s store or publish state', () => {
    const json = JSON.stringify(toPortable(set()));

    expect(json).not.toMatch(/storeId|rowVersion|publishedAt|publishedConfigVersion/);
  });

  it('carries every group field a duplicate keeps', () => {
    const [group] = toPortable(set()).groups;

    expect(group).toMatchObject({
      label: 'Finish',
      description: 'Pick one',
      displayType: 'inline',
      isCollapsible: false,
      isEnabled: true,
      sortOrder: 0,
    });
  });

  it('carries every option field a duplicate keeps', () => {
    const [option] = toPortable(set()).groups[0]!.options;

    expect(option).toMatchObject({
      key: 'colour',
      label: 'Colour',
      presentation: 'dropdown',
      isRequired: true,
      helpText: 'Choose carefully',
      isEnabled: true,
    });
  });

  /** 🔴 `skuSuffix` is the one a naive export forgets — it is fulfilment data. */
  it('carries every value field a duplicate keeps', () => {
    const [value] = toPortable(set()).groups[0]!.options[0]!.values;

    expect(value).toMatchObject({
      valueKey: 'gold',
      label: 'Gold',
      priceType: 'fixed',
      priceAmountMinor: 500,
      skuSuffix: '-GD',
    });
  });

  it('carries presentational items', () => {
    const [item] = toPortable(set()).groups[0]!.items;

    expect(item).toMatchObject({ kind: 'heading', content: 'Choose a finish', sortOrder: 1 });
  });

  /**
   * 🔴 **Rules travel by INDEX PATH, not by id.** A rule names its target by
   * row id, which is meaningless in an imported set — so the export records
   * *"group 0, option 0, value 0"* and an importer resolves it against what it
   * just created.
   */
  it('rewrites a rule target as an index path', () => {
    const withRule = set({
      rules: [
        {
          id: 'r1',
          targetType: 'option',
          targetId: 'o1',
          action: 'hide',
          matchType: 'all',
          conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          actionValue: null,
          sortOrder: 0,
          isEnabled: true,
          disabledReason: null,
        },
      ],
    } as Partial<AuthoringSet>);

    const [rule] = toPortable(withRule).rules;

    expect(rule?.target).toEqual({ kind: 'option', path: [0, 0] });
    expect(rule?.conditions[0]?.option).toEqual([0, 0]);
  });

  /** ⚠️ A rule whose target is not in the tree cannot be exported meaningfully. */
  it('drops a rule whose target it cannot resolve', () => {
    const orphan = set({
      rules: [
        {
          id: 'r1',
          targetType: 'option',
          targetId: 'missing',
          action: 'hide',
          matchType: 'all',
          conditions: [],
          actionValue: null,
          sortOrder: 0,
          isEnabled: true,
          disabledReason: null,
        },
      ],
    } as Partial<AuthoringSet>);

    expect(toPortable(orphan).rules).toEqual([]);
  });

  it('exports an empty rule list when the set has none', () => {
    expect(toPortable(set()).rules).toEqual([]);
  });
});
