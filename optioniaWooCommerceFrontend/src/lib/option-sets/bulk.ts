/**
 * Splitting a merchant's selection into requests the API will accept (M19.5).
 *
 * 🔴 **Its own module because it could not be tested where it was.**
 * `@testing-library/react` is not a dependency, so nothing in this repo can
 * mount a component — the loop lived inside a `useMutation` and therefore never
 * executed in any test. It was also written **twice**, once for assign and once
 * for unassign, which is two places for an off-by-one to hide.
 */

/**
 * The most targets one request may carry.
 *
 * ⚠️ **Mirrors `MAX_TARGETS` in the API's `assign-product.dto.ts`.** Exceeding
 * it is a `400` for the whole request, so a selection larger than this is
 * **split**, never truncated: dropping the tail would assign some of what a
 * merchant chose and report success.
 */
export const BULK_CHUNK = 100;

/**
 * Split `items` into consecutive runs of at most `size`.
 *
 * Order is preserved and every item appears exactly once — a merchant who
 * selected forty products must get forty, in the order the list showed them.
 */
export function chunk<T>(items: readonly T[], size: number = BULK_CHUNK): T[][] {
  /*
   * 🔴 **A non-positive size would loop forever.** `index += 0` never advances,
   * so a caller passing `0` — or a mis-edited constant — would hang the tab
   * rather than fail. Refused loudly instead.
   */
  if (size < 1) {
    throw new RangeError('chunk size must be at least 1');
  }

  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
