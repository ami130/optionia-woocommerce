/**
 * What changed since the last publish (M20.9's `diff-vs-published`).
 *
 * ## Why a boolean was not enough
 *
 * 🔴 **`hasUnpublishedChanges` fetched both documents and returned `true`.** A
 * merchant about to publish to a live storefront was told *that* something
 * differed and never *what* — and both documents were already in hand, so only
 * the comparison was missing.
 *
 * ## The trap this must survive
 *
 * ⚠️ **Key order is NOT stable between the two sides.** Measured when the
 * boolean was written: `preview` returns `[id, version, assignments, groups,
 * rules]` while the stored snapshot returns `[id, rules, groups, version,
 * assignments]` — the snapshot round-tripped through a JSON column, which does
 * not preserve insertion order. A diff reporting those as changes would be
 * **worse than the boolean**, because it would cry wolf on every publish.
 *
 * ## What it reports, and what it deliberately does not
 *
 * 📌 **Named things, not fields.** "Option changed: Finish → Colour" rather
 * than a list of which properties moved. The boolean's own docblock gives the
 * reason — enumerating fields *"would go stale as the document grows"* — and the
 * editor is where a merchant sees the detail. What they need here is *where to
 * look*.
 */

/**
 * A stable string for any value, with object keys sorted.
 *
 * 📌 **The same canonicalisation `hasUnpublishedChanges` uses**, exported here
 * so the boolean and the diff cannot disagree about what "identical" means.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/** How many changes to name before summarising the rest. */
const MAX_LISTED = 12;

interface Named {
  id?: unknown;
  label?: unknown;
}

const idOf = (node: Named): string => (typeof node.id === 'string' ? node.id : '');
const labelOf = (node: Named): string => (typeof node.label === 'string' ? node.label : '(unnamed)');

const groupsOf = (doc: unknown): Record<string, unknown>[] => {
  const groups = (doc as { groups?: unknown })?.groups;

  return Array.isArray(groups) ? (groups as Record<string, unknown>[]) : [];
};

const optionsOf = (group: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(group.options) ? (group.options as Record<string, unknown>[]) : [];

/**
 * Describe what differs between what would publish and what is published.
 *
 * ⚠️ **Matched by id, not by position.** A reordered group is not a removal and
 * an addition, and reporting it as two changes would send a merchant looking
 * for work they did not do.
 */
export function describeChanges(preview: unknown, published: unknown): string[] {
  /* A set never published has nothing to compare against. */
  if (published === null || published === undefined) {
    return [];
  }

  const changes: string[] = [];

  const before = new Map(groupsOf(published).map((group) => [idOf(group), group]));
  const after = new Map(groupsOf(preview).map((group) => [idOf(group), group]));

  for (const [id, group] of after) {
    const was = before.get(id);

    if (was === undefined) {
      changes.push(`Group added: ${labelOf(group)}`);

      continue;
    }

    if (labelOf(was) !== labelOf(group)) {
      changes.push(`Group renamed: ${labelOf(was)} → ${labelOf(group)}`);
    }

    const optionsBefore = new Map(optionsOf(was).map((option) => [idOf(option), option]));
    const optionsAfter = new Map(optionsOf(group).map((option) => [idOf(option), option]));

    for (const [optionId, option] of optionsAfter) {
      const optionWas = optionsBefore.get(optionId);
      const where = labelOf(group);

      if (optionWas === undefined) {
        changes.push(`Option added: ${where} → ${labelOf(option)}`);

        continue;
      }

      /*
       * 🔴 **A rename is reported once, as a rename.** Saying both "renamed"
       * and "changed" for one edit would make a merchant look for a second
       * change that does not exist.
       */
      if (labelOf(optionWas) !== labelOf(option)) {
        changes.push(`Option renamed: ${where} → ${labelOf(optionWas)} → ${labelOf(option)}`);

        continue;
      }

      if (canonical(optionWas) !== canonical(option)) {
        changes.push(`Option changed: ${where} → ${labelOf(option)}`);
      }
    }

    for (const [optionId, option] of optionsBefore) {
      if (!optionsAfter.has(optionId)) {
        changes.push(`Option removed: ${labelOf(group)} → ${labelOf(option)}`);
      }
    }
  }

  for (const [id, group] of before) {
    if (!after.has(id)) {
      changes.push(`Group removed: ${labelOf(group)}`);
    }
  }

  /*
   * ⚠️ **Capped, and the remainder is STATED.** A merchant cannot act on a
   * hundred lines, and silently truncating would hide work they are about to
   * publish.
   */
  if (changes.length > MAX_LISTED) {
    const shown = changes.slice(0, MAX_LISTED);

    return [...shown, `…and ${changes.length - MAX_LISTED} more changes.`];
  }

  return changes;
}
