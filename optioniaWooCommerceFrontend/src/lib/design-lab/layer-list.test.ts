import { describe, expect, it } from 'vitest';

import type { EditorLayer } from './layer.types';
import {
  backgroundOf,
  canMoveDown,
  canMoveUp,
  listOrder,
  moveInList,
  rowActions,
} from './layer-list';

function layer(id: string, over: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id,
    name: id,
    src: `${id}.png`,
    natW: 200,
    natH: 100,
    kind: 'layer',
    cx: 100,
    cy: 100,
    w: 80,
    h: 40,
    rot: 0,
    style: 'free',
    opacity: 100,
    shape: 'none',
    visible: true,
    locked: false,
    ...over,
  };
}

/* Paint order: 'back' is drawn first, so it belongs at the BOTTOM of the list. */
const BG = layer('bg', { kind: 'background' });
const STORE_ORDER = [BG, layer('back'), layer('middle'), layer('front')];

describe('listOrder', () => {
  /*
   * 🔴 Three option layers, not two. With two, a dropped `.reverse()` and a
   * correct one differ only in which of two elements comes first — a mutation
   * that swaps them is caught, but one that rotates or mis-slices is not.
   * Three distinguishes reversal from every other rearrangement.
   */
  it('shows the topmost layer first, reversing paint order', () => {
    expect(listOrder(STORE_ORDER).map((l) => l.id)).toEqual([
      'front',
      'middle',
      'back',
    ]);
  });

  it('leaves the background out of the list', () => {
    expect(listOrder(STORE_ORDER).some((l) => l.kind === 'background')).toBe(false);
  });

  it('does not mutate the array it was given', () => {
    /*
     * ⚠️ `reverse()` is in-place on the array it is called on. Reversing the
     * store's own array would flip the paint order as a side effect of merely
     * rendering the list — the canvas would redraw inverted.
     */
    const original = [...STORE_ORDER];

    listOrder(STORE_ORDER);

    expect(STORE_ORDER).toEqual(original);
  });

  it('returns an empty list when there is only a background', () => {
    expect(listOrder([BG])).toEqual([]);
  });
});

describe('backgroundOf', () => {
  it('finds the background wherever it sits', () => {
    /*
     * 📌 Deliberately NOT at index 0. The store pins it there, but a lookup
     * that assumed the position would start lying mid-reorder.
     */
    const scrambled = [layer('a'), BG, layer('b')];

    expect(backgroundOf(scrambled)?.id).toBe('bg');
  });

  it('reports none when there is no background', () => {
    expect(backgroundOf([layer('a')])).toBeNull();
  });
});

describe('canMoveUp / canMoveDown', () => {
  it('refuses to move the topmost row up', () => {
    expect(canMoveUp(0)).toBe(false);
    expect(canMoveUp(1)).toBe(true);
  });

  it('refuses to move the bottom row down', () => {
    expect(canMoveDown(2, 3)).toBe(false);
    expect(canMoveDown(1, 3)).toBe(true);
  });

  it('refuses both on a single-row list', () => {
    expect(canMoveUp(0)).toBe(false);
    expect(canMoveDown(0, 1)).toBe(false);
  });

  it('refuses both for an index that is not in the list', () => {
    expect(canMoveUp(-1)).toBe(false);
    expect(canMoveDown(-1, 3)).toBe(false);
    expect(canMoveDown(5, 3)).toBe(false);
  });
});

describe('moveInList', () => {
  const IDS = ['front', 'middle', 'back'];

  it('moves a row up by one', () => {
    expect(moveInList(IDS, 1, 'up')).toEqual(['middle', 'front', 'back']);
  });

  it('moves a row down by one', () => {
    expect(moveInList(IDS, 1, 'down')).toEqual(['front', 'back', 'middle']);
  });

  /*
   * 🔴 Up from the top and down from the bottom are the two refusals, and they
   * must not silently rotate the list — a wrap-around reads as the layer
   * teleporting from one end to the other.
   */
  it('refuses to move the first row up, leaving the order alone', () => {
    expect(moveInList(IDS, 0, 'up')).toEqual(IDS);
  });

  it('refuses to move the last row down, leaving the order alone', () => {
    expect(moveInList(IDS, 2, 'down')).toEqual(IDS);
  });

  it('refuses an index outside the list', () => {
    expect(moveInList(IDS, 9, 'up')).toEqual(IDS);
    expect(moveInList(IDS, -1, 'down')).toEqual(IDS);
  });

  it('does not mutate the array it was given', () => {
    const ids = [...IDS];

    moveInList(ids, 1, 'up');

    expect(ids).toEqual(IDS);
  });

  /*
   * ⚠️ The round trip that matters: the list hands ids back in LIST order and
   * `reorderByIds` reverses them itself. Moving up then down must land exactly
   * where it started, or a merchant nudging a layer twice finds it drifted.
   */
  it('returns to the original order when a move is undone', () => {
    const moved = moveInList(IDS, 2, 'up');

    expect(moveInList(moved, 1, 'down')).toEqual(IDS);
  });
});

describe('rowActions', () => {
  /*
   * 🔴 The rule most likely to be "fixed" into a bug. A lock guards the CANVAS
   * — it is what makes dragIntentFor answer select-only — and it is reversible
   * from this very menu. Disabling the menu would strand a merchant with a
   * layer they can neither move nor unlock.
   */
  it('keeps every action on a locked layer, including delete', () => {
    expect(rowActions(layer('a', { locked: true }))).toEqual({
      lock: true,
      duplicate: true,
      visibility: true,
      remove: true,
      reorder: true,
    });
  });

  it('keeps every action on a hidden layer, so it can be shown again', () => {
    expect(rowActions(layer('a', { visible: false })).visibility).toBe(true);
  });

  it('offers an ordinary layer the full menu', () => {
    const actions = rowActions(layer('a'));

    expect(Object.values(actions).every(Boolean)).toBe(true);
  });

  it('offers the background none of them', () => {
    /*
     * 📌 The background is pinned to the back and replaced rather than
     * reordered or deleted; its own controls are M26d.5 and live on its row.
     */
    const actions = rowActions(BG);

    expect(Object.values(actions).some(Boolean)).toBe(false);
  });

  it('refuses the background even when it is somehow unlocked and visible', () => {
    /* The KIND decides, not the flags — a background is never an option row. */
    expect(rowActions(layer('bg2', { kind: 'background', locked: false })).remove).toBe(
      false,
    );
  });
});
