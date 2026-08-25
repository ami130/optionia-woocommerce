import { readFileSync } from 'node:fs';

import { CHILD_ORDER } from './option-set-tree.loader';

describe('child ordering', () => {
  /**
   * The tie-break is what makes serialization deterministic when two rows share
   * a `sort_order` — a bulk reorder can assign the same value, and nothing
   * forbids it. Without it the storage engine chooses, and a config document
   * that differs between two builds of unchanged data makes every snapshot diff
   * ([7i]) untrustworthy.
   *
   * Asserted on the clause rather than on returned rows: removing it changes the
   * SQL but not today's results, because InnoDB returns these rows in
   * primary-key order anyway. A test of the rows therefore cannot fail; this one
   * can.
   */
  it('breaks ties on id', () => {
    expect(CHILD_ORDER).toEqual({ sortOrder: 'ASC', id: 'ASC' });
  });

  /**
   * Four queries load the tree — groups, options, items, values. A tie-break on
   * three of them and not the fourth is the kind of drift nobody notices until a
   * diff is wrong.
   */
  it('is the only ordering the loader uses', () => {
    const source = readFileSync('src/option-sets/serialization/option-set-tree.loader.ts', 'utf8');
    const orderClauses = source.match(/order:\s*[^,\n]+/g) ?? [];

    expect(orderClauses.length).toBeGreaterThanOrEqual(4);
    orderClauses.forEach((clause) => expect(clause).toContain('CHILD_ORDER'));
  });
});
