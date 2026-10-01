import { getMetadataArgsStorage } from 'typeorm';

import { Option } from '../entities/option.entity';
import { OptionValue } from '../entities/option-value.entity';
import type { AuthoringOption, AuthoringOptionValue } from './projections';

/**
 * Every column an entity declares reaches the dashboard, or is excused by name.
 *
 * 🔴 **`duplication.spec.ts` was the ONLY completeness guard in this
 * repository**, and it watches the copy paths. It caught `design` missing from
 * a duplicate — and nothing watched the three other hand-written field lists
 * that enumerate the same columns: the authoring projection, the config
 * document, and the portable import. A design was stored and never returned, so
 * the Design Lab would have reopened on an empty canvas: a feature that appears
 * to save and does not.
 *
 * ⚠️ **The authoring projection is the one with that consequence.** The config
 * document and the portable import lose data on publish and on import; this one
 * loses it on every page load, which looks like the feature never worked.
 *
 * 📌 **Excused BY NAME with a reason, following `check-reachable.ts`.** A
 * pattern would quietly widen; a name expires the moment someone reads it.
 */
type EntityClass = abstract new (...args: never[]) => object;

function columnsOf(entity: EntityClass): string[] {
  const storage = getMetadataArgsStorage();
  const names = new Set<string>();

  for (const column of storage.columns) {
    let current: EntityClass | null = entity;

    while (current) {
      if (column.target === current) {
        names.add(column.propertyName);
        break;
      }

      current = Object.getPrototypeOf(current);
    }
  }

  return [...names];
}

/**
 * Columns the dashboard is not given, each for a stated reason.
 *
 * ⚠️ **`deletedAt` is the interesting one**: the projection only ever carries
 * live rows, so exposing it would invite a client to filter on a field that is
 * always the same value.
 */
const NOT_PROJECTED: Readonly<Record<string, string>> = {
  deletedAt: 'the projection carries live rows only',
  optionId: 'implied by the nesting — values arrive inside their option',
  optionGroupId: 'implied by the nesting',
  optionSetId: 'implied by the nesting',
};

/** The keys a projection actually declares, read from a fully-populated value. */
const AUTHORING_VALUE_KEYS: Array<keyof AuthoringOptionValue> = [
  'id',
  'valueKey',
  'label',
  'sortOrder',
  'priceType',
  'priceAmountMinor',
  'priceConfig',
  'imageUrl',
  'colorHex',
  'design',
  'groupLabel',
  'skuSuffix',
  'weightDeltaGrams',
  'isDefault',
  'isEnabled',
  'createdAt',
  'updatedAt',
];

const AUTHORING_OPTION_KEYS: Array<keyof AuthoringOption> = [
  'id',
  'key',
  'valueKind',
  'cardinality',
  'presentation',
  'label',
  'description',
  'placeholder',
  'helpText',
  'isRequired',
  'isEnabled',
  'sortOrder',
  'defaultValue',
  'validation',
  'pricing',
  'display',
  'textDesign',
  'createdAt',
  'updatedAt',
  'values',
];

describe('projection completeness', () => {
  describe('OptionValue → AuthoringOptionValue', () => {
    it('projects every column, or excuses it by name', () => {
      const unaccounted = columnsOf(OptionValue).filter(
        (column) =>
          !(AUTHORING_VALUE_KEYS as string[]).includes(column) &&
          !(column in NOT_PROJECTED),
      );

      expect(unaccounted).toEqual([]);
    });

    it('carries the design the editor reopens from', () => {
      /* The regression itself: stored, and never returned. */
      expect(AUTHORING_VALUE_KEYS).toContain('design');
    });
  });

  describe('Option → AuthoringOption', () => {
    it('projects every column, or excuses it by name', () => {
      const unaccounted = columnsOf(Option).filter(
        (column) =>
          !(AUTHORING_OPTION_KEYS as string[]).includes(column) &&
          !(column in NOT_PROJECTED),
      );

      expect(unaccounted).toEqual([]);
    });

    it('carries the text design a free-text option prints', () => {
      expect(AUTHORING_OPTION_KEYS).toContain('textDesign');
    });
  });

  /*
   * 🔴 **The list above is a hand-written mirror, and that is exactly the shape
   * that drifted.** This asserts it against the TYPE, so a key added to the
   * interface and forgotten here fails rather than silently widening the
   * excuse list.
   */
  it('keeps the key lists in step with the interfaces they mirror', () => {
    const valueProbe: Record<keyof AuthoringOptionValue, true> = {
      id: true,
      valueKey: true,
      label: true,
      sortOrder: true,
      priceType: true,
      priceAmountMinor: true,
      priceConfig: true,
      imageUrl: true,
      colorHex: true,
      design: true,
      groupLabel: true,
      skuSuffix: true,
      weightDeltaGrams: true,
      isDefault: true,
      isEnabled: true,
      createdAt: true,
      updatedAt: true,
    };

    expect(Object.keys(valueProbe).sort()).toEqual([...AUTHORING_VALUE_KEYS].sort());

    const optionProbe: Record<keyof AuthoringOption, true> = {
      id: true,
      key: true,
      valueKind: true,
      cardinality: true,
      presentation: true,
      label: true,
      description: true,
      placeholder: true,
      helpText: true,
      isRequired: true,
      isEnabled: true,
      sortOrder: true,
      defaultValue: true,
      validation: true,
      pricing: true,
      display: true,
      textDesign: true,
      createdAt: true,
      updatedAt: true,
      values: true,
    };

    expect(Object.keys(optionProbe).sort()).toEqual([...AUTHORING_OPTION_KEYS].sort());
  });
});
