import { getMetadataArgsStorage } from 'typeorm';

import {
  COPY_DECIDED_BY_CALLER,
  copyableItemFields,
  copyableRuleFields,
  copyableValueFields,
} from './duplication';
import { OptionRule } from './entities/option-rule.entity';
import { OptionValue } from './entities/option-value.entity';
import { PresentationalItem } from './entities/presentational-item.entity';

/**
 * Every column an entity declares, including those from its base class.
 *
 * Read from TypeORM's own metadata rather than a hand-written list — a second
 * list would drift from the first exactly as the four copy paths drifted from
 * each other.
 */
type EntityClass = abstract new (...args: never[]) => object;

function columnsOf(entity: EntityClass): string[] {
  const storage = getMetadataArgsStorage();
  const names = new Set<string>();

  for (const column of storage.columns) {
    // `target` is the declaring class, so a base-class column is attributed to
    // the base — walk the prototype chain to catch `id`, timestamps and friends.
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
 * 🔴 **The test whose absence let silent data loss ship.**
 *
 * `groupLabel` was added to one of four hand-written copy paths, and
 * presentational items were copied by none of them — so duplicating an option
 * set dropped every `<optgroup>` heading and every heading, paragraph and
 * divider. Measured before the fix: 1 item in the source, 0 in the copy.
 *
 * Every suite stayed green, because nothing asserted that a copy is *complete*.
 *
 * This compares against the entity's own column metadata, so a new column fails
 * here until it is either copied or explicitly named as caller-decided. It
 * cannot drift the way a second hand-written list would.
 */
describe('copy completeness', () => {
  describe('OptionValue', () => {
    const copied = Object.keys(copyableValueFields({} as OptionValue));

    it('accounts for every column', () => {
      const unaccounted = columnsOf(OptionValue).filter(
        (column) =>
          !copied.includes(column) &&
          !(COPY_DECIDED_BY_CALLER as readonly string[]).includes(column) &&
          column !== 'isDefault',
      );

      expect(unaccounted).toEqual([]);
    });

    /** The regression itself: the field that reached only one of four paths. */
    it('carries groupLabel', () => {
      expect(copied).toContain('groupLabel');
    });

    it('carries the swatch fields', () => {
      expect(copied).toContain('colorHex');
      expect(copied).toContain('imageUrl');
    });

    it('carries pricing', () => {
      expect(copied).toContain('priceType');
      expect(copied).toContain('priceAmountMinor');
      expect(copied).toContain('priceConfig');
    });

    /**
     * ⚠️ **`isDefault` must stay out of the shared list.**
     *
     * Duplicating a value beside its source must not create a second default —
     * two defaults is a document the renderer cannot resolve — while copying a
     * whole option into a new set must keep it. Only the caller knows which.
     */
    it('leaves isDefault to the caller', () => {
      expect(copied).not.toContain('isDefault');
    });

    it('never copies identity or parentage', () => {
      expect(copied).not.toContain('id');
      expect(copied).not.toContain('optionId');
      expect(copied).not.toContain('valueKey');
    });
  });

  describe('PresentationalItem', () => {
    const copied = Object.keys(copyableItemFields({} as PresentationalItem));

    it('accounts for every column', () => {
      const unaccounted = columnsOf(PresentationalItem).filter(
        (column) =>
          !copied.includes(column) &&
          !(COPY_DECIDED_BY_CALLER as readonly string[]).includes(column),
      );

      expect(unaccounted).toEqual([]);
    });

    it('carries kind, content and display', () => {
      expect(copied).toEqual(expect.arrayContaining(['kind', 'content', 'display']));
    });

    /**
     * Items share the `sortOrder` scale with options, so a copy inherits its
     * position rather than being renumbered — renumbering one list alone would
     * break the interleaving the storefront renders.
     */
    it('inherits sortOrder rather than reassigning it', () => {
      expect(copied).toContain('sortOrder');
    });

    it('never copies identity or parentage', () => {
      expect(copied).not.toContain('id');
      expect(copied).not.toContain('optionGroupId');
    });
  });

  /**
   * 🔴 **The third instance of this bug, found by auditing Stage 17-1.**
   *
   * `duplicate()` copied groups, options, values and items — and **no rules at
   * all**. A merchant duplicating a configured set got one with every piece of
   * its conditional logic silently removed. Same shape as `groupLabel` and the
   * presentational items before it: a new thing to copy, hand-written lists, and
   * a green suite over real data loss.
   */
  describe('OptionRule', () => {
    const copied = Object.keys(copyableRuleFields({} as OptionRule));

    it('accounts for every column', () => {
      const unaccounted = columnsOf(OptionRule).filter(
        (column) =>
          !copied.includes(column) &&
          !(COPY_DECIDED_BY_CALLER as readonly string[]).includes(column),
      );

      expect(unaccounted).toEqual([]);
    });

    it('carries what the rule DOES — its target kind, action and connective', () => {
      expect(copied).toEqual(expect.arrayContaining(['targetType', 'action', 'matchType']));
    });

    /**
     * 🔴 The two fields that must NOT travel verbatim.
     *
     * `targetId` names a row in the source set and `conditions` names options in
     * it. Copying either as-is produces a rule aimed at another set's rows —
     * worse than dropping the rule, because it would evaluate and silently
     * govern the wrong document. The caller remaps both through its id map, and
     * their absence here is what forces it to.
     */
    it('never carries an id that points into the source set', () => {
      expect(copied).not.toContain('targetId');
      expect(copied).not.toContain('conditions');
      expect(copied).not.toContain('id');
      expect(copied).not.toContain('optionSetId');
    });

    /**
     * A rule disabled because its target was deleted must not come back enabled
     * in a copy — the target is still gone. The reason travels with the flag,
     * because `isEnabled` alone cannot say whether the merchant or the system
     * turned it off.
     */
    it('keeps a disabled rule disabled, with the reason it was disabled for', () => {
      expect(copied).toEqual(expect.arrayContaining(['isEnabled', 'disabledReason']));
    });
  });
});
