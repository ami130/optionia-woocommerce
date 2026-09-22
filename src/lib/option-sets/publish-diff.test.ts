import { describe, expect, it } from 'vitest';

import { describeChanges } from './publish-diff';

/**
 * What changed since the last publish (M20.9's `diff-vs-published`).
 *
 * 🔴 **"Something differs" is materially less useful than "these three options
 * changed."** `hasUnpublishedChanges` fetched both documents, canonicalised
 * them and returned a **boolean** — so a merchant about to publish to a live
 * storefront was told *that* something changed and never *what*.
 *
 * ⚠️ **Key order is NOT stable between the two documents**, and that is the
 * first thing this must survive. Measured in the API module: `preview` returns
 * `[id, version, assignments, groups, rules]` while the stored snapshot returns
 * `[id, rules, groups, version, assignments]` — the snapshot round-tripped
 * through a JSON column, which does not preserve insertion order. A diff that
 * reported those as changes would be worse than the boolean.
 */
const doc = (groups: unknown[]) => ({ id: 's1', version: 1, groups, rules: [], assignments: [] });

const group = (id: string, label: string, options: unknown[] = []) => ({
  id,
  label,
  display_type: 'inline',
  sort_order: 10,
  is_collapsible: false,
  options,
  items: [],
});

const option = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id,
  key: label.toLowerCase(),
  type: 'dropdown',
  label,
  is_required: false,
  sort_order: 10,
  values: [],
  ...over,
});

describe('describeChanges', () => {
  it('reports nothing when the documents match', () => {
    const a = doc([group('g1', 'Finish')]);

    expect(describeChanges(a, a)).toEqual([]);
  });

  /**
   * 🔴 **The trap the boolean already knew about.** Identical content in a
   * different key order must read as no change.
   */
  it('reports nothing when only key order differs', () => {
    const published = { id: 's1', rules: [], groups: [group('g1', 'Finish')], version: 1, assignments: [] };
    const preview = { id: 's1', version: 1, assignments: [], groups: [group('g1', 'Finish')], rules: [] };

    expect(describeChanges(preview, published)).toEqual([]);
  });

  /**
   * 🔴 **Key order INSIDE an option — the case that actually bites.**
   *
   * The test above reorders only the document's top-level keys, which this diff
   * never compares — so a mutant removing `canonical`'s `.sort()` **survived**
   * it. The comparison that matters is the per-option one, and a JSON round-trip
   * reorders *those* keys too.
   *
   * Measured with the sort removed: identical options reported
   * `["Option changed: F → C"]` — a false change on every publish, which is the
   * cry-wolf failure that makes a diff worse than the boolean it replaced.
   */
  it('reports nothing when an option’s own key order differs', () => {
    const published = doc([
      { ...group('g1', 'Finish'), options: [{ id: 'o1', key: 'c', type: 'dropdown', label: 'Colour', is_required: false, sort_order: 10, values: [] }] },
    ]);
    const preview = doc([
      { ...group('g1', 'Finish'), options: [{ values: [], sort_order: 10, is_required: false, label: 'Colour', type: 'dropdown', key: 'c', id: 'o1' }] },
    ]);

    expect(describeChanges(preview, published)).toEqual([]);
  });

  it('names a group that was added', () => {
    const changes = describeChanges(
      doc([group('g1', 'Finish'), group('g2', 'Size')]),
      doc([group('g1', 'Finish')]),
    );

    expect(changes).toContain('Group added: Size');
  });

  it('names a group that was removed', () => {
    const changes = describeChanges(doc([group('g1', 'Finish')]), doc([group('g1', 'Finish'), group('g2', 'Size')]));

    expect(changes).toContain('Group removed: Size');
  });

  /** 📌 A rename is named on both sides — a merchant needs to recognise it. */
  it('names a renamed group', () => {
    const changes = describeChanges(doc([group('g1', 'Finishes')]), doc([group('g1', 'Finish')]));

    expect(changes).toContain('Group renamed: Finish → Finishes');
  });

  it('names an added option, under its group', () => {
    const changes = describeChanges(
      doc([group('g1', 'Finish', [option('o1', 'Colour')])]),
      doc([group('g1', 'Finish')]),
    );

    expect(changes).toContain('Option added: Finish → Colour');
  });

  it('names a removed option', () => {
    const changes = describeChanges(
      doc([group('g1', 'Finish')]),
      doc([group('g1', 'Finish', [option('o1', 'Colour')])]),
    );

    expect(changes).toContain('Option removed: Finish → Colour');
  });

  /**
   * 🔴 **A changed option is reported without enumerating its fields.** The
   * boolean's docblock gives the reason: enumerating fields *"would go stale as
   * the document grows"*. Naming the option is what a merchant acts on; the
   * editor is where they see the detail.
   */
  it('names an option that changed', () => {
    const changes = describeChanges(
      doc([group('g1', 'Finish', [option('o1', 'Colour', { is_required: true })])]),
      doc([group('g1', 'Finish', [option('o1', 'Colour')])]),
    );

    expect(changes).toContain('Option changed: Finish → Colour');
  });

  /** ⚠️ A rename is a rename, not a rename *and* a change. */
  it('reports a renamed option once', () => {
    const changes = describeChanges(
      doc([group('g1', 'Finish', [option('o1', 'Shade')])]),
      doc([group('g1', 'Finish', [option('o1', 'Colour')])]),
    );

    expect(changes).toEqual(['Option renamed: Finish → Colour → Shade']);
  });

  /** 📌 Several changes at once, all reported. */
  it('reports every change, not only the first', () => {
    const changes = describeChanges(
      doc([group('g1', 'Finish', [option('o1', 'Colour', { is_required: true })]), group('g2', 'Size')]),
      doc([group('g1', 'Finish', [option('o1', 'Colour')])]),
    );

    expect(changes.length).toBe(2);
  });

  /** ⚠️ A set never published has nothing to compare against. */
  it('reports nothing when there is no published document', () => {
    expect(describeChanges(doc([group('g1', 'Finish')]), null)).toEqual([]);
  });

  /**
   * ⚠️ **Capped, because a merchant cannot act on a hundred lines.** The count
   * is stated rather than the list truncated silently.
   */
  it('caps a very long list and says how many more', () => {
    const many = Array.from({ length: 30 }, (_, i) => group(`g${i}`, `Group ${i}`));
    const changes = describeChanges(doc(many), doc([]));

    expect(changes.length).toBeLessThan(30);
    expect(changes.at(-1)).toMatch(/more/i);
  });
});
