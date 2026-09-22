/** One field's change, as stored in `audit_logs.changes`. */
export interface FieldChange {
  readonly from: unknown;
  readonly to: unknown;
}

/**
 * Build the `{ field: { from, to } }` diff every audit entry records.
 *
 * **One shape for every mutation.** M7.6 requires a diff, and a trail where a
 * create records `{name}`, an update records `{name: {from, to}}` and a delete
 * records something else again cannot be rendered, searched or exported by any
 * single piece of code — support ends up reading four formats by eye.
 *
 * A create passes `null` for `before` and a delete passes the removed state as
 * `after`, so "created" and "deleted" are diffs from and to nothing rather than
 * special cases.
 *
 * Unchanged fields are omitted: the point is what changed, and a diff padded
 * with equal values buries it.
 */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, FieldChange> {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: Record<string, FieldChange> = {};

  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;

    if (!isEqual(from, to)) {
      changes[field] = { from, to };
    }
  }

  return changes;
}

/**
 * Structural equality, so a JSON column whose contents are unchanged does not
 * read as a change on every save.
 *
 * Values here come from entity columns and are JSON-serialisable by definition,
 * which is what makes this comparison sound.
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  return JSON.stringify(a) === JSON.stringify(b);
}
