import { nextSortOrder, SORT_ORDER_STEP } from './option-groups.repository';
import { buildPatch, pick } from './entity-patch';

describe('nextSortOrder', () => {
  it('starts at the first step when there are no siblings', () => {
    expect(nextSortOrder([])).toBe(SORT_ORDER_STEP);
  });

  it('appends after the highest sibling', () => {
    expect(nextSortOrder([{ sortOrder: 10 }, { sortOrder: 20 }])).toBe(30);
  });

  /** Order is by value, not by position — a list may arrive unsorted. */
  it('uses the highest value regardless of position', () => {
    expect(nextSortOrder([{ sortOrder: 50 }, { sortOrder: 10 }])).toBe(60);
  });

  /**
   * Gaps are the point: a merchant moving one group between two others should
   * cost one write, not a renumber of every sibling.
   */
  it('leaves a gap between siblings', () => {
    expect(nextSortOrder([{ sortOrder: 10 }]) - 10).toBe(SORT_ORDER_STEP);
  });

  it('does not go backwards for a negative sort order', () => {
    expect(nextSortOrder([{ sortOrder: -5 }])).toBe(SORT_ORDER_STEP);
  });
});

describe('buildPatch', () => {
  it('keeps only fields that differ', () => {
    expect(buildPatch({ label: 'A', isEnabled: true }, { label: 'B', isEnabled: true })).toEqual({
      label: 'B',
    });
  });

  it('ignores undefined, which is a field the caller omitted', () => {
    expect(buildPatch({ label: 'A' }, { label: undefined })).toEqual({});
  });

  /** `null` is a value — clearing a description is a real change. */
  it('treats null as a value rather than an omission', () => {
    // Typed as the entity types it: these columns are nullable, and `null` must
    // reach the patch while `undefined` must not.
    const before: { description: string | null } = { description: 'text' };

    expect(buildPatch(before, { description: null })).toEqual({ description: null });
  });

  it('trims strings before comparing, so whitespace is not a change', () => {
    expect(buildPatch({ label: 'A' }, { label: '  A  ' })).toEqual({});
  });

  it('trims the stored value of a real change', () => {
    expect(buildPatch({ label: 'A' }, { label: '  B  ' })).toEqual({ label: 'B' });
  });

  it('is empty when nothing differs', () => {
    expect(buildPatch({ label: 'A', isEnabled: false }, {})).toEqual({});
  });

  it('records a boolean flipping to false', () => {
    expect(buildPatch({ isEnabled: true }, { isEnabled: false })).toEqual({ isEnabled: false });
  });
});

describe('pick', () => {
  it('takes the named fields', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('yields undefined for a field that is absent', () => {
    expect(pick({ a: 1 }, ['missing'])).toEqual({ missing: undefined });
  });

  it('is empty for no fields', () => {
    expect(pick({ a: 1 }, [])).toEqual({});
  });
});
