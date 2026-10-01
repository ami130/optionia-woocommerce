import type { EditorLayer } from './layer.types';

/**
 * What the layer list shows, and what each row may do.
 *
 * 🔴 **The list runs TOP-TO-BOTTOM; the store runs BOTTOM-TO-TOP.** A merchant
 * reads a layer list as "topmost first", which is how every editor presents it,
 * while `store.layers` is paint order — index 0 is drawn first and therefore
 * sits at the back. Those are opposite, and the reversal between them is the
 * single place that must not be skipped: get it wrong and the list is
 * upside-down, or worse, a drag-reorder moves a layer the other way.
 *
 * ⚠️ **The background is not a row like the others.** It is pinned to the back,
 * cannot be reordered past anything, and does not share the option rows' menu.
 * Keeping it out of the ordered list is what makes `reorderByIds` safe to call
 * with whatever the list hands back.
 */

/**
 * The option layers, topmost first.
 *
 * 📌 **Excludes the background**, which the sidebar renders separately because
 * it has no grip and no reorder. Handing it to the list would let a drag move it
 * off the back, and `reorderByIds` would silently put it back — a gesture that
 * appears to work and then undoes itself.
 */
export function listOrder(layers: readonly EditorLayer[]): EditorLayer[] {
  return layers.filter((l) => l.kind !== 'background').reverse();
}

/**
 * The background layer, or null.
 *
 * 📌 Found by KIND rather than by position. The store pins it to index 0 and
 * `reorderByIds` restores that, but a lookup that assumed the position would
 * start lying the moment anything reordered before the pin was reapplied.
 */
export function backgroundOf(layers: readonly EditorLayer[]): EditorLayer | null {
  return layers.find((l) => l.kind === 'background') ?? null;
}

/**
 * Whether a row can move in the list.
 *
 * ⚠️ **Position in the LIST, not in the store.** Index 0 is the topmost row, so
 * it cannot move up; the last row cannot move down. Reading these against
 * `store.layers` would invert both.
 */
export function canMoveUp(listIndex: number): boolean {
  return listIndex > 0;
}

export function canMoveDown(listIndex: number, listLength: number): boolean {
  return listIndex >= 0 && listIndex < listLength - 1;
}

/**
 * The list order after moving one row, for the arrow controls.
 *
 * 🔴 **Returns ids in LIST order**, which is what `reorderByIds` expects — it
 * reverses them itself. Returning store order here would double the reversal and
 * move the layer the wrong way.
 *
 * 📌 **A refused move returns the order unchanged** rather than throwing, so a
 * caller that does not check `canMoveUp` first cannot corrupt the order.
 */
export function moveInList(
  ids: readonly string[],
  from: number,
  direction: 'up' | 'down',
): string[] {
  const to = direction === 'up' ? from - 1 : from + 1;

  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) {
    return [...ids];
  }

  const next = [...ids];
  const [moved] = next.splice(from, 1);

  next.splice(to, 0, moved);

  return next;
}

/** The actions a row offers. */
export interface RowActions {
  lock: boolean;
  duplicate: boolean;
  visibility: boolean;
  remove: boolean;
  reorder: boolean;
}

/**
 * What a row may do.
 *
 * 🔴 **A LOCKED layer keeps every menu action, including delete.** The lock
 * guards the canvas — it is what makes `dragIntentFor` answer `select-only` —
 * and it is reversible from this very menu. Disabling the menu would strand the
 * merchant with a layer they can neither move nor unlock. The source makes the
 * same choice, and it is easy to get wrong by assuming "locked" means "frozen".
 *
 * ⚠️ **The background is the opposite case**: it cannot be reordered or deleted
 * from here. Its own controls (replace, remove) are M26d.5 and belong to the
 * background row, not to this menu.
 */
export function rowActions(layer: EditorLayer): RowActions {
  if (layer.kind === 'background') {
    return {
      lock: false,
      duplicate: false,
      visibility: false,
      remove: false,
      reorder: false,
    };
  }

  return {
    lock: true,
    duplicate: true,
    visibility: true,
    remove: true,
    /* Reordering is a list gesture, and a lock does not forbid it. */
    reorder: true,
  };
}
