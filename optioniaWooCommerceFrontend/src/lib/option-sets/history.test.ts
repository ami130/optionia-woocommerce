import { describe, expect, it, vi } from 'vitest';

import { createHistory } from './history';

/**
 * Undo and redo for the option editor (M20.10).
 *
 * ## An inverse log, not a snapshot stack
 *
 * 🔴 **Snapshots of the tree are the memory problem `patchTree` just solved.**
 * At `AUTHORING_LIMITS` scale a set is 600 options and 12,000 values; keeping
 * twenty of those so a merchant can undo a renamed label trades one waste for
 * a larger one. Each entry here stores the *inverse call* — the previous field
 * values, which the editor already held in order to render the form.
 *
 * ## What is deliberately NOT undoable
 *
 * 🔴 **Deletes.** Measured, not assumed: all four delete endpoints return
 * `void`, and `CascadeResult` — which counts the options, values, items and
 * rules a group delete takes with it — never leaves the server. A group delete
 * soft-deletes its whole subtree and *disables every rule targeting any of it*;
 * the dashboard is told none of that. An "undo" that recreated a group and
 * silently lost its options, or left rules disabled, would be worse than no
 * undo at all, because the merchant would believe the delete was reversed.
 *
 * ⚠️ **A restore endpoint would make this honest**, and that is backend work
 * (the rows are soft-deleted, so the data is still there). Until then the
 * editor says so rather than pretending.
 *
 * ## Publish is a boundary, not a step
 *
 * 📌 Undoing *through* a publish is rollback, which M20.9 already built and
 * which works on published versions rather than editor operations. Mixing them
 * would give two mechanisms for one idea and let undo appear to revert what a
 * storefront is serving.
 */
const entry = (label: string, inverse: () => Promise<void>) => ({ label, inverse });

describe('createHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const history = createHistory();

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('can undo after one recorded operation', () => {
    const history = createHistory();

    history.record(entry('Rename value', async () => {}));

    expect(history.canUndo()).toBe(true);
  });

  it('runs the inverse when undoing', async () => {
    const inverse = vi.fn(async () => {});
    const history = createHistory();

    history.record(entry('Rename value', inverse));
    await history.undo();

    expect(inverse).toHaveBeenCalledTimes(1);
  });

  /** 🔴 Undoing twice must reach the older operation, not repeat the newer. */
  it('undoes in reverse order', async () => {
    const calls: string[] = [];
    const history = createHistory();

    history.record(entry('first', async () => void calls.push('first')));
    history.record(entry('second', async () => void calls.push('second')));

    await history.undo();
    await history.undo();

    expect(calls).toEqual(['second', 'first']);
  });

  it('has nothing left to undo once the log is exhausted', async () => {
    const history = createHistory();

    history.record(entry('only', async () => {}));
    await history.undo();

    expect(history.canUndo()).toBe(false);
  });

  /** ⚠️ Undoing nothing must be a no-op, not a crash. */
  it('does nothing when there is nothing to undo', async () => {
    const history = createHistory();

    await expect(history.undo()).resolves.toBeUndefined();
  });

  it('names the operation that would be undone', () => {
    const history = createHistory();

    history.record(entry('Rename value', async () => {}));

    expect(history.undoLabel()).toBe('Rename value');
  });

  /**
   * 🔴 **A failed inverse must NOT be consumed.** The server refused, so the
   * operation still stands — dropping it would leave the merchant unable to
   * retry and believing the undo had worked.
   */
  it('keeps the entry when the inverse fails', async () => {
    const history = createHistory();

    history.record(
      entry('Rename value', async () => {
        throw new Error('refused');
      }),
    );

    await expect(history.undo()).rejects.toThrow('refused');
    expect(history.canUndo()).toBe(true);
  });

  /** 📌 Publish clears the log — undoing through it is rollback's job. */
  it('clears on publish', async () => {
    const history = createHistory();

    history.record(entry('Rename value', async () => {}));
    history.clear();

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

describe('redo', () => {
  /**
   * ⚠️ **Only a replayable entry can be redone**, which is why this records a
   * `replay`. An earlier draft of this test used a bare entry and contradicted
   * "cannot redo an entry that has no replay" two tests below — both could not
   * hold, and the implementation was right.
   */
  it('can redo what was undone', async () => {
    const history = createHistory();

    history.record({ label: 'Rename', inverse: async () => {}, replay: async () => {} });
    await history.undo();

    expect(history.canRedo()).toBe(true);
  });

  it('replays the original operation when redoing', async () => {
    const redo = vi.fn(async () => {});
    const history = createHistory();

    history.record({ label: 'Rename', inverse: async () => {}, replay: redo });
    await history.undo();
    await history.redo();

    expect(redo).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **A new edit after an undo discards the redo branch.** Keeping it would
   * let a merchant redo an operation that no longer makes sense against the
   * tree they have since changed — the classic undo-tree defect.
   */
  /**
   * 🔴 **The first draft of this test SURVIVED a mutant that deleted the
   * clearing.** It recorded an entry with no `replay`, so `undone` was already
   * empty after the undo and `canRedo()` was false either way — the test passed
   * by coincidence, exactly like the cold-cache test in `cache.test.ts`. A
   * replayable entry is what makes the branch observable.
   */
  it('drops the redo branch when a new operation is recorded', async () => {
    const history = createHistory();

    history.record({ label: 'first', inverse: async () => {}, replay: async () => {} });
    await history.undo();

    expect(history.canRedo()).toBe(true);

    history.record(entry('second', async () => {}));

    expect(history.canRedo()).toBe(false);
  });

  /** ⚠️ An entry with no replay cannot be redone, and must say so. */
  it('cannot redo an entry that has no replay', async () => {
    const history = createHistory();

    history.record(entry('Rename value', async () => {}));
    await history.undo();

    expect(history.canRedo()).toBe(false);
  });
});
