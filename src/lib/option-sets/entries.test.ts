import { describe, expect, it } from 'vitest';

import type { AuthoringItem, AuthoringOption } from './api';
import { groupReorderPayload, mergedEntries, reorderPayloads, sortOrderFor } from './entries';

const option = (id: string, sortOrder: number): AuthoringOption => ({
  id,
  key: id,
  label: id,
  presentation: 'radio',
  isRequired: false,
  sortOrder,
  isEnabled: true,
  values: [],
});

const item = (id: string, sortOrder: number, kind = 'heading'): AuthoringItem => ({
  id,
  kind,
  content: id,
  sortOrder,
});

describe('mergedEntries', () => {
  /**
   * 🔴 **The rule the storefront enforces.**
   *
   * `Frontend\Renderer::group_markup()` interleaves options and items on one
   * `sort_order` scale. If the editor grouped them instead, a merchant would
   * arrange one order and get another — and only find out on a live product page.
   */
  it('interleaves options and items by sortOrder', () => {
    const entries = mergedEntries({
      options: [option('engraving', 20)],
      items: [item('heading', 10), item('divider', 30, 'divider')],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['heading', 'engraving', 'divider']);
  });

  it('keeps an item ordered last at the end', () => {
    const entries = mergedEntries({
      options: [option('a', 10)],
      items: [item('z', 99)],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  /**
   * Ties break toward options, then by arrival — from sort stability.
   *
   * ✏️ A `seq` tie-break clause was written for this and **deleted**: a mutation
   * probe showed removing it changed nothing, because `seq` was assigned in the
   * same order stability already preserves.
   */
  it('breaks a tie toward the option', () => {
    const entries = mergedEntries({
      options: [option('opt', 10)],
      items: [item('itm', 10)],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['opt', 'itm']);
  });

  /**
   * 🔴 **Several options and several items, all tied.**
   *
   * The case that exposed the dead `seq` clause: with two of each sharing a
   * `sortOrder`, a broken tie-break interleaves them (`o1,i1,o2,i2`) instead of
   * keeping options first. One-of-each tests pass either way.
   */
  it('keeps every option before every item when all tie', () => {
    const entries = mergedEntries({
      options: [option('o1', 10), option('o2', 10)],
      items: [item('i1', 10), item('i2', 10)],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['o1', 'o2', 'i1', 'i2']);
  });

  it('orders equal sortOrders within one kind by arrival', () => {
    const entries = mergedEntries({
      options: [],
      items: [item('first', 10), item('second', 10)],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('narrows on kind', () => {
    const [entry] = mergedEntries({ options: [option('a', 10)], items: [] });

    expect(entry.kind).toBe('option');
    expect(entry.kind === 'option' ? entry.option.key : null).toBe('a');
  });

  it('handles a group with only items', () => {
    const entries = mergedEntries({ options: [], items: [item('only', 10)] });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('item');
  });

  it('handles an empty group', () => {
    expect(mergedEntries({ options: [], items: [] })).toEqual([]);
  });

  /**
   * ⚠️ A set loaded from an older release, or a cached response, may have no
   * `items` at all. The editor must render the options rather than crash.
   */
  it('tolerates a group with no items array', () => {
    const entries = mergedEntries({
      options: [option('a', 10)],
      items: undefined as unknown as AuthoringItem[],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('reorderPayloads', () => {
  /** The shape the live data actually had: options and items tied at 10 and 20. */
  const group = () =>
    mergedEntries({
      options: [option('A', 10), option('B', 20)],
      items: [item('h', 10), item('p', 20), item('d', 30)],
    });

  it('merges into the order the storefront draws', () => {
    expect(group().map((e) => e.id)).toEqual(['A', 'h', 'B', 'p', 'd']);
  });

  /**
   * 🔴 **The bug this function exists for.**
   *
   * Numbering each list by its own index gives options `10,20` and items
   * `10,20,30` *whatever order they are in* — so moving an option past a heading
   * wrote two successful requests and changed nothing. Verified against the live
   * API before the fix: both endpoints answered `201`, merged order unchanged.
   *
   * The assertion is on the resulting merged order, not on the raw numbers,
   * because that is what a merchant sees.
   */
  it('moves an option past an item, across both lists', () => {
    const entries = group();
    const payload = reorderPayloads(entries, 0, 1);

    expect(payload.options).not.toBeNull();
    expect(payload.items).not.toBeNull();

    const byId = new Map(
      [...(payload.options ?? []), ...(payload.items ?? [])].map((e) => [e.id, e.sortOrder]),
    );
    const kind = new Map(entries.map((e) => [e.id, e.kind]));

    const after = [...byId.entries()]
      .sort((a, b) => a[1] - b[1] || (kind.get(a[0]) === 'option' ? -1 : 1))
      .map(([id]) => id);

    expect(after).toEqual(['h', 'A', 'B', 'p', 'd']);
  });

  /** A same-kind move writes one list, and leaves the other alone. */
  it('writes only the list that changed', () => {
    const payload = reorderPayloads(group(), 3, 1); // paragraph past divider

    expect(payload.options).toBeNull();
    expect(payload.items?.map((e) => e.id)).toEqual(['h', 'd', 'p']);
  });

  /**
   * ⚠️ Item sort orders carry **merged** positions, so they are not `10,20,30`.
   * Asserting the numbers directly is what pins the scale the storefront shares.
   */
  it('numbers by merged position, not by index within a list', () => {
    const payload = reorderPayloads(group(), 3, 1);

    // merged after the move: A(0) h(1) B(2) d(3) p(4)
    expect(payload.items).toEqual([
      { id: 'h', sortOrder: 20 },
      { id: 'd', sortOrder: 40 },
      { id: 'p', sortOrder: 50 },
    ]);
  });

  it('refuses to move the first entry up', () => {
    expect(reorderPayloads(group(), 0, -1)).toEqual({ options: null, items: null });
  });

  it('refuses to move the last entry down', () => {
    const entries = group();

    expect(reorderPayloads(entries, entries.length - 1, 1)).toEqual({
      options: null,
      items: null,
    });
  });

  it('leaves gaps a later insert can land in', () => {
    expect(sortOrderFor(0)).toBe(10);
    expect(sortOrderFor(1) - sortOrderFor(0)).toBe(10);
  });
});

describe('moving a group within its set (M18.6)', () => {
  const groups = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }];

  /**
   * 🔴 **The whole list is renumbered, not just the pair that swapped.**
   *
   * The server applies the list in one transaction; sending only the moved two
   * would leave the others on whatever numbers they had, which is correct only
   * while the gaps happen to allow it. Renumbering everything makes the result
   * independent of what the numbers were before.
   */
  it('moves a group down and renumbers every sibling', () => {
    expect(groupReorderPayload(groups, 0, 1)).toEqual([
      { id: 'g2', sortOrder: 10 },
      { id: 'g1', sortOrder: 20 },
      { id: 'g3', sortOrder: 30 },
    ]);
  });

  it('moves a group up', () => {
    expect(groupReorderPayload(groups, 2, -1)).toEqual([
      { id: 'g1', sortOrder: 10 },
      { id: 'g3', sortOrder: 20 },
      { id: 'g2', sortOrder: 30 },
    ]);
  });

  /**
   * ⚠️ **Off either end is `null`, not a no-op request.**
   *
   * A payload that reorders nothing would still be a write, an audit entry and
   * a `configVersion` bump — telling every storefront its configuration changed
   * when it did not.
   */
  it('refuses to move the first group up or the last one down', () => {
    expect(groupReorderPayload(groups, 0, -1)).toBeNull();
    expect(groupReorderPayload(groups, 2, 1)).toBeNull();
  });

  /** A set with one group has nowhere to move it. */
  it('returns null for a single group', () => {
    expect(groupReorderPayload([{ id: 'only' }], 0, -1)).toBeNull();
    expect(groupReorderPayload([{ id: 'only' }], 0, 1)).toBeNull();
  });

  /**
   * ⚠️ **Gaps of 10 match what the server assigns on create**, so a group added
   * afterwards still lands between two neighbours rather than forcing a
   * renumber of the whole set.
   */
  it('numbers in tens, like the server', () => {
    const payload = groupReorderPayload(groups, 0, 1);

    expect(payload?.map((entry) => entry.sortOrder)).toEqual([10, 20, 30]);
  });

  /**
   * 🔴 **The input is never mutated.**
   *
   * The caller passes React state straight in. Swapping in place would mutate
   * the rendered array, so the list would appear to reorder before the server
   * agreed — and would stay reordered if the request then failed.
   */
  it('leaves the caller\'s array untouched', () => {
    const original = [{ id: 'g1' }, { id: 'g2' }];

    groupReorderPayload(original, 0, 1);

    expect(original).toEqual([{ id: 'g1' }, { id: 'g2' }]);
  });
});
