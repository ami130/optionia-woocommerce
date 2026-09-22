import { describe, expect, it } from 'vitest';

import { BULK_CHUNK, chunk } from './bulk';

/**
 * The split a bulk assign depends on (M19.5).
 *
 * 🔴 **This code shipped never having run.** It lived inside a `useMutation`
 * in `product-picker.tsx`, and with no renderer in this repo no test could
 * reach it — while the only fixtures anywhere are far below the boundary it
 * exists to handle, so even a manual click would not have crossed it.
 */
describe('chunk', () => {
  it('returns nothing for an empty selection', () => {
    expect(chunk([])).toEqual([]);
  });

  it('keeps a selection under the cap as one request', () => {
    expect(chunk([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  /**
   * 🔴 **Exactly the cap is ONE request, not two.** `index += size` leaves
   * `index === items.length` on the next pass, and a `<=` written where `<`
   * belongs would send an empty second batch — which the API refuses with a
   * `400` for `ArrayNotEmpty`, failing a bulk assign of exactly 100.
   */
  it('sends exactly the cap as a single request', () => {
    const items = Array.from({ length: BULK_CHUNK }, (unused, index) => index);
    const batches = chunk(items);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(BULK_CHUNK);
  });

  it('splits one past the cap into two, the second holding the remainder', () => {
    const items = Array.from({ length: BULK_CHUNK + 1 }, (unused, index) => index);
    const batches = chunk(items);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(BULK_CHUNK);
    expect(batches[1]).toEqual([BULK_CHUNK]);
  });

  /**
   * ⚠️ **Nothing lost and nothing duplicated.** A merchant who selected 250
   * products must get 250 assignments — the failure worth guarding is a split
   * that silently drops the tail and still reports success.
   */
  it('preserves every item, once, in order', () => {
    const items = Array.from({ length: 250 }, (unused, index) => index);

    expect(chunk(items).flat()).toEqual(items);
  });

  it('never exceeds the cap in any batch', () => {
    const items = Array.from({ length: 250 }, (unused, index) => index);

    for (const batch of chunk(items)) {
      expect(batch.length).toBeLessThanOrEqual(BULK_CHUNK);
    }
  });

  /**
   * 🔴 **A zero size would loop forever**, hanging the tab rather than failing.
   * Refused loudly so a mis-edited constant is a test failure, not a freeze.
   */
  it('refuses a size that could not make progress', () => {
    expect(() => chunk([1, 2], 0)).toThrow(RangeError);
    expect(() => chunk([1, 2], -1)).toThrow(RangeError);
  });

  it('matches the API cap', () => {
    expect(BULK_CHUNK).toBe(100);
  });
});
