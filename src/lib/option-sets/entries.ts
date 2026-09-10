import type { AuthoringGroup, AuthoringItem, AuthoringOption } from './api';

/**
 * One row in a group's merged sequence.
 *
 * A discriminated union rather than a nullable pair, so a renderer cannot reach
 * `entry.option` on an item — TypeScript narrows on `kind`.
 */
export type Entry =
  | { kind: 'option'; id: string; sortOrder: number; option: AuthoringOption }
  | { kind: 'item'; id: string; sortOrder: number; item: AuthoringItem };

/**
 * A group's options and presentational items as **one ordered sequence**.
 *
 * 🔴 **Not two lists.** They share the `sortOrder` scale, and `Frontend\Renderer`
 * interleaves them on the storefront — a heading's only job is to sit above the
 * right control. An editor showing options and items in separate sections would
 * let a merchant arrange something they cannot see the result of.
 *
 * ⚠️ **Ties break toward options, then by arrival — from sort *stability*, not
 * from a comparator clause.** `Array.prototype.sort` has been required to be
 * stable since ES2019, and options are spread first, so entries sharing a
 * `sortOrder` keep exactly that order.
 *
 * ✏️ This carried an explicit `seq` tie-break first, with a comment claiming the
 * concatenated input made one necessary. **A mutation probe disproved that**:
 * deleting the clause changed no result, because `seq` was assigned *in*
 * concatenation order — precisely what stability already preserves. It was dead
 * code defended by a wrong rationale, so it is gone rather than tested.
 *
 * 🔴 **The plugin's `usort` is a different case and still needs its tie-break** —
 * PHP's sort is not stable, so `Frontend\Renderer` breaks ties explicitly. The
 * two implementations agree on the *rule*; only one gets it for free.
 *
 * Extracted from the editor rather than inlined so this ordering can be tested
 * directly: it is the one piece of logic that must agree with the storefront.
 */
export function mergedEntries(group: Pick<AuthoringGroup, 'options' | 'items'>): Entry[] {
  const options = group.options ?? [];
  const items = group.items ?? [];

  const merged: Entry[] = [
    ...options.map((option) => ({
      kind: 'option' as const,
      id: option.id,
      sortOrder: option.sortOrder,
      option,
    })),
    ...items.map((item) => ({
      kind: 'item' as const,
      id: item.id,
      sortOrder: item.sortOrder,
      item,
    })),
  ];

  return merged.sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The two reorder payloads for moving one entry past its neighbour.
 *
 * 🔴 **`sortOrder` comes from the entry's position in the *merged* sequence, not
 * its index within its own list.** Numbering each list independently was the
 * first implementation and it was silently broken: with two options and three
 * items, options are renumbered `10,20` and items `10,20,30` **whatever order
 * they are in**, so a cross-kind move wrote two successful requests and changed
 * nothing. Each list can only encode its *internal* order that way, never its
 * position relative to the other.
 *
 * Measured against the live API before the fix: both endpoints answered `201`
 * and the merged order was byte-identical. A green request is not a moved item.
 *
 * ⚠️ **Both lists are returned, and both must be written when the two entries
 * swapped are of different kinds** — options and items live in different tables
 * with separate endpoints, so one write cannot express the new interleaving.
 * `null` means that list did not change and needs no request.
 *
 * Gaps of 10 match what the server assigns on create, so a later single-item
 * insert still lands between two neighbours.
 */
export function reorderPayloads(
  entries: readonly Entry[],
  index: number,
  direction: -1 | 1,
): { options: SortEntry[] | null; items: SortEntry[] | null } {
  const target = index + direction;

  if (target < 0 || target >= entries.length) {
    return { options: null, items: null };
  }

  const next = [...entries];

  [next[index], next[target]] = [next[target], next[index]];

  const moved = new Set([next[index].kind, next[target].kind]);

  // The merged position is the whole point: both lists share one scale.
  const numbered = next.map((entry, position) => ({
    kind: entry.kind,
    id: entry.id,
    sortOrder: sortOrderFor(position),
  }));

  const of = (kind: Entry['kind']): SortEntry[] =>
    numbered.filter((e) => e.kind === kind).map(({ id, sortOrder }) => ({ id, sortOrder }));

  return {
    options: moved.has('option') ? of('option') : null,
    items: moved.has('item') ? of('item') : null,
  };
}

/** One sibling's new position, as both reorder endpoints take it. */
export interface SortEntry {
  id: string;
  sortOrder: number;
}

/**
 * Position in the merged sequence → `sortOrder`.
 *
 * Gaps of 10 match what the server assigns on create, so a later single-entry
 * insert still lands between two neighbours.
 */
export function sortOrderFor(mergedIndex: number): number {
  return (mergedIndex + 1) * 10;
}
