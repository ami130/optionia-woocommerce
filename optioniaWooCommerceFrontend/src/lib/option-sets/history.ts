/**
 * Undo and redo for the option editor (M20.10).
 *
 * ## An inverse log, not a snapshot stack
 *
 * 🔴 **Snapshots of the tree are the memory problem `patchTree` just solved.**
 * At `AUTHORING_LIMITS` scale a set is 600 options and 12,000 values; keeping
 * twenty of those so a merchant can undo a renamed label trades one waste for a
 * larger one. Each entry stores the **inverse call** instead — for a field
 * edit, the previous values, which the editor already held in order to render
 * the form it edited.
 *
 * ## What is deliberately NOT undoable, and why
 *
 * 🔴 **Deletes.** Measured rather than assumed: all four delete endpoints
 * return `void`, and `CascadeResult` — which counts the options, values, items
 * and rules a group delete takes with it — never leaves the server. Deleting a
 * group soft-deletes its whole subtree *and disables every rule targeting any
 * of it*; the dashboard is told none of that.
 *
 * An "undo" that recreated the group and silently lost its options, or left the
 * rules disabled, would be **worse than no undo**: the merchant would believe
 * the delete had been reversed. The rows are soft-deleted, so the data is still
 * there — a restore endpoint would make this honest, and that is backend work.
 *
 * ⚠️ **Any SHAPE CHANGE clears the log** — every create, delete and reorder,
 * because all of them go through the editor's `reload`. Leaving earlier entries
 * undoable across a delete would let an undo target a value whose parent no
 * longer exists, and the resulting 404 would read as a bug rather than a
 * boundary; across a reorder it is worse, because the inverse can *succeed* and
 * put the wrong thing back.
 *
 * 🔴 **This docblock once claimed it and nothing did it.** The only `clear()`
 * was on the publish path; all four delete sites cleared nothing. A comment
 * that reads as a guarantee is worse than no comment, and the wiring is now
 * pinned by `editor-history.test.ts` rather than by this paragraph.
 *
 * ## Publish is a boundary, not a step
 *
 * 📌 Undoing *through* a publish is rollback, which M20.9 already built and
 * which operates on published versions rather than editor operations. Two
 * mechanisms for one idea would let undo appear to revert what a storefront is
 * currently serving.
 */

/** One reversible operation. */
export interface HistoryEntry {
  /** Named for the merchant: "Rename value", "Reorder options". */
  readonly label: string;

  /** Puts the tree back as it was. Rejects if the server refuses. */
  readonly inverse: () => Promise<void>;

  /**
   * Performs the operation again, for redo.
   *
   * ⚠️ **Optional on purpose.** An operation that cannot be replayed safely —
   * anything whose payload depended on ids that have since changed — records no
   * replay, and `canRedo` reports false rather than offering a button that
   * would fail.
   */
  readonly replay?: () => Promise<void>;
}

export interface History {
  record: (entry: HistoryEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | undefined;
  redoLabel: () => string | undefined;
  clear: () => void;
}

/** A bound on the log, so a long editing session cannot grow without limit. */
export const HISTORY_LIMIT = 50;

export function createHistory(limit: number = HISTORY_LIMIT): History {
  let done: HistoryEntry[] = [];
  let undone: HistoryEntry[] = [];

  return {
    record(entry) {
      done = [...done, entry].slice(-limit);

      /*
       * 🔴 **A new operation discards the redo branch.** Keeping it would let a
       * merchant redo something that no longer makes sense against the tree
       * they have since changed — the classic undo-tree defect.
       */
      undone = [];
    },

    async undo() {
      const entry = done[done.length - 1];

      if (entry === undefined) {
        return;
      }

      /*
       * 🔴 **Run the inverse BEFORE consuming the entry.** If the server
       * refuses, the operation still stands: dropping it would leave the
       * merchant unable to retry and believing the undo had worked.
       */
      await entry.inverse();

      done = done.slice(0, -1);
      undone = entry.replay === undefined ? [] : [...undone, entry];
    },

    async redo() {
      const entry = undone[undone.length - 1];

      if (entry?.replay === undefined) {
        return;
      }

      await entry.replay();

      undone = undone.slice(0, -1);
      done = [...done, entry];
    },

    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
    undoLabel: () => done[done.length - 1]?.label,
    redoLabel: () => undone[undone.length - 1]?.label,

    clear() {
      done = [];
      undone = [];
    },
  };
}
