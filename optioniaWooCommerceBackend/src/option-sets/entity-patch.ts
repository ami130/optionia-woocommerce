/**
 * Building a patch from a caller's changes.
 *
 * Shared by groups, options and values — the three levels apply the same M7.2
 * lifecycle and need the same "what actually differs" logic. It lived in
 * `option-groups.service.ts` and was imported by the other two, which made
 * options and values depend on **groups** for no domain reason. The repositories
 * already shared `nextSortOrder` this way; the services did not.
 */
/**
 * The subset of `changes` that differs from what is stored.
 *
 * An unchanged field is not a change: including it would burn a `rowVersion`
 * and write an audit entry for a save that altered nothing.
 */
export function buildPatch<T extends object>(before: T, changes: Partial<T>): Partial<T> {
  const patch: Partial<T> = {};

  (Object.keys(changes) as Array<keyof T>).forEach((field) => {
    const next = changes[field];

    if (next === undefined) {
      return;
    }

    const value = typeof next === 'string' ? (next.trim() as T[keyof T]) : next;

    if (value !== before[field]) {
      patch[field] = value;
    }
  });

  return patch;
}

/** The named fields of an object, for diffing against a patch. */
export function pick<T extends object>(source: T, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, source[field as keyof T]]));
}
