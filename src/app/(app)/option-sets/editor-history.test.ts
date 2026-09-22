import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * How the editor's undo log is wired, asserted against the source.
 *
 * 🔴 **`history.ts` claimed "Deletes therefore CLEAR the log" and nothing did.**
 * The only `clear()` was on the publish path; all four delete sites called
 * `onChanged` and cleared nothing. A merchant who edited a value, deleted its
 * option and pressed Undo would have sent a `PATCH` to a soft-deleted row —
 * `findOne` throws `notFound`, so a **404** presented as a bug rather than a
 * boundary. The docblock read as a guarantee that was never implemented.
 *
 * ⚠️ **Asserted on the SOURCE rather than by rendering**, for the same reason
 * `editor-contracts.test.ts` exists: these are wiring facts — which callback
 * clears the log — and a render test would need the whole editor mounted with a
 * server behind it to observe them.
 */
const editorDir = join(process.cwd(), 'src/app/(app)/option-sets');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      return sources(path);
    }

    return path.endsWith('.tsx') && !path.includes('.test.') ? [readFileSync(path, 'utf8')] : [];
  });

const editor = sources(editorDir).join('\n');

describe('the undo log clears when the tree changes shape', () => {
  /**
   * 🔴 **Cleared in `reload`, not at each delete.** `reload` is what every
   * create, delete and reorder already calls — the shape changes the log cannot
   * survive. Wiring four delete sites would leave the fifth, added later, to be
   * remembered by whoever adds it.
   */
  it('clears the log inside the shape-change reload', () => {
    const reload = editor.slice(editor.indexOf('const reload ='), editor.indexOf('const reloadAfterPublish'));

    expect(reload).toMatch(/history\.clear\(\)/);
  });

  /** ⚠️ The publish boundary stays — undoing through a publish is rollback. */
  it('still clears the log on publish', () => {
    const publish = editor.slice(
      editor.indexOf('const reloadAfterPublish'),
      editor.indexOf('const patch: TreePatch'),
    );

    expect(publish).toMatch(/history\.clear\(\)/);
  });

  /**
   * 🔴 **An in-place edit must NOT clear it** — that is the whole feature. If
   * `patchTree` ever cleared, undo would be dead on arrival and every test
   * above would still pass.
   */
  it('does not clear the log when an edit is patched in', () => {
    const patch = editor.slice(
      editor.indexOf('const patch: TreePatch'),
      editor.indexOf('if (query.isLoading)'),
    );

    expect(patch).not.toMatch(/history\.clear\(\)/);
  });
});

/**
 * Which operations are undoable.
 *
 * 🔴 **Undo shipped covering ONE of seven invertible operations.** Only
 * `ValueRow` recorded; the required-toggle, item edit, both group edits and all
 * three reorders wrote silently. The toolbar told merchants undo existed, with
 * nothing distinguishing the one operation it covered — worse than no toolbar,
 * because it invites trust it cannot honour.
 *
 * ⚠️ **Deletes stay out on purpose** — `CascadeResult` never leaves the server,
 * so a group delete cannot be reversed blind. That is a boundary, and `reload`
 * clears the log at it.
 */
describe('every in-place edit is recorded', () => {
  const recorders = [
    ['the value editor', 'onRecord={patch.record}'],
    ['the required toggle', 'toggleRequired'],
    ['the item editor', 'onRecord={patch.record}'],
  ] as const;

  it.each(recorders)('%s hands an entry to the log', (_name, marker) => {
    expect(editor).toContain(marker);
  });

  /**
   * 🔴 **A reorder must be undoable — it is the easiest edit to make by
   * accident**, and `reorderGroups` writes the COMPLETE ordering by id rather
   * than a relative move. That is what makes its inverse safe: replaying the
   * previous ordering is valid whatever else has changed since.
   *
   * ⚠️ **So a reorder must NOT go through the clearing reload.** The first
   * version of this fix cleared on every shape change, which would have
   * recorded a reorder and erased it in the same handler. Reorders refresh the
   * tree through `reorderChanged`, which does not clear.
   */
  it('records group reorders', () => {
    const move = editor.slice(editor.indexOf('const move = useMutation'), editor.length);

    expect(move.slice(0, 1600)).toMatch(/record\(/);
  });

  /**
   * 🔴 The reorder refresh must not clear what the reorder just recorded.
   *
   * ⚠️ **Asserted on what it CALLS, not on absent text.** The first version
   * checked that the slice held no `history.clear()` and survived a mutant that
   * wrote `const reorderChanged = reload` — an alias containing no such text
   * while clearing the log every time. Naming the invalidation it must call is
   * what makes the alias fail.
   */
  it('refreshes a reorder without clearing the log', () => {
    const fn = editor.slice(
      editor.indexOf('const reorderChanged ='),
      editor.indexOf('\n', editor.indexOf('const reorderChanged =')),
    );

    expect(fn).toMatch(/invalidateAfterEdit\(queryClient, setId\)/);
    expect(fn).not.toMatch(/history\.clear\(\)|=\s*reload\b/);
  });

  /**
   * ⚠️ **The required toggle records its own inverse**, which is the previous
   * boolean — the one operation whose inverse needs no captured state at all.
   */
  it('records the required toggle with an inverse', () => {
    const block = editor.slice(editor.indexOf('const toggleRequired'), editor.indexOf('const remove', editor.indexOf('const toggleRequired')));

    expect(block).toMatch(/record\(/);
    expect(block).toMatch(/isRequired/);
  });
});
