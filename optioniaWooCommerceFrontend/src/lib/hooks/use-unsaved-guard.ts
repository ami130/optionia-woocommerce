'use client';

import { useEffect } from 'react';

/**
 * Warn before half-typed work is thrown away (M20.10).
 *
 * ## Why this exists
 *
 * 🔴 **Phase 20's exit says "no data loss on navigation", and the editor lost
 * it silently.** Four forms hold unsaved work — `AddOption` fourteen fields,
 * `AddValue` six, `AddItem` two, `AddGroup` one — and nothing warned before any
 * of it went. A merchant part-way through an option who clicked *All option
 * sets* lost the lot with no dialog.
 *
 * ## What it does NOT do
 *
 * ⚠️ **It cannot stop an in-app route change**, and pretending otherwise would
 * be worse than the gap. `beforeunload` fires for a reload, a closed tab and a
 * typed URL; Next's client-side `<Link>` navigation never reaches it. The
 * in-app case is handled where the click happens — `confirmDiscard` below —
 * because only the component that owns the form knows whether it is dirty.
 *
 * 📌 **The browser decides the wording.** Chrome and Firefox have shown their
 * own text since 2016 and ignore whatever a page supplies, so no message is
 * passed: `preventDefault()` plus a legacy `returnValue` is the whole contract.
 */
export function useUnsavedGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();

      /*
       * Safari and older Chrome still require a non-empty `returnValue`; the
       * string is never displayed. Setting it is what makes the dialog appear
       * at all in those engines.
       */
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warn);

    /*
     * 🔴 **Removed when the form goes clean, not only on unmount.** A listener
     * that outlived its dirty state would warn a merchant who had just saved —
     * the fastest way to teach someone to click through warnings without
     * reading them.
     */
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);
}

/**
 * Ask before discarding a dirty form, for navigation the browser cannot see.
 *
 * 🔴 **Switching groups remounts the editor and clears it** — deliberately.
 * M110 proved the alternative: without the remount a half-typed option carries
 * into the *next* group and can be created there, against a group the merchant
 * never meant. So clearing is correct; doing it **silently** is the defect.
 *
 * ⚠️ **Returns `true` when there is nothing to lose**, so a clean form never
 * interrupts anyone. The confirm is the exception, not the routine.
 */
export function confirmDiscard(isDirty: boolean): boolean {
  if (!isDirty) {
    return true;
  }

  return window.confirm(
    'You have started an option that is not saved yet. Switching groups will discard it.',
  );
}

/**
 * Whether the one mounted option form has unsaved work.
 *
 * 🔴 **A module-level flag rather than threading a prop through two
 * components.** `AddOption` sits inside `GroupCard` inside `GroupList`, and the
 * only consumer is the group switch at the top — passing `isDirty` up would
 * mean two new props on two components whose contracts are otherwise about the
 * group, not about a form's state.
 *
 * ⚠️ **Safe only because exactly ONE editor is mounted.** 20-2d made the
 * structure pane select a single group, so there is never a second form to
 * confuse this with. If that ever changes — a compact view showing two groups —
 * this becomes wrong and must go back to a prop.
 */
let optionFormDirty = false;

/** Record whether the mounted option form is dirty. */
export function setOptionFormDirty(dirty: boolean): void {
  optionFormDirty = dirty;
}

/**
 * Which value rows have unsaved edits.
 *
 * 🔴 **A set, not a boolean — unlike `optionFormDirty` above.** Exactly one
 * `AddOption` is mounted, but `ValueRow` keeps its `editing` state per row, so
 * a merchant can have several open at once. One shared flag would be cleared by
 * whichever row went clean last and the rest would lose their guard.
 *
 * ⚠️ **Rows must deregister on unmount**, or an id left behind would make the
 * guard ask about work that no longer exists — the false alarm that teaches
 * people to click through warnings.
 */
const dirtyValues = new Set<string>();

/** Record whether one value row has unsaved edits. */
export function setValueDirty(valueId: string, dirty: boolean): void {
  if (dirty) {
    dirtyValues.add(valueId);
  } else {
    dirtyValues.delete(valueId);
  }
}

/** Forget every row — for a test, and for a remount that discards them all. */
export function clearDirtyValues(): void {
  dirtyValues.clear();
}

/**
 * Whether anything in the editor would be lost by a remount.
 *
 * 🔴 **`ValueRow` was invisible to this until M20.10's audit.** A probe typed
 * into an open row and switched groups: `confirmCalled=0 rowDestroyed=true`.
 * Autosave made it worse rather than better — removing the Save button teaches
 * a merchant that changes are handled for them, so silent loss is *more*
 * surprising, not less.
 */
function hasUnsavedWork(): boolean {
  return optionFormDirty || dirtyValues.size > 0;
}

/** Ask before a group switch throws away a half-typed option or value edit. */
export function confirmGroupSwitch(): boolean {
  return confirmDiscard(hasUnsavedWork());
}
