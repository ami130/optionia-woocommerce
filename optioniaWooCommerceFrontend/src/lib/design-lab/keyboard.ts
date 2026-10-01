/**
 * What a keypress means in the Design Lab.
 *
 * 🔴 **Separated from the listener so it can be tested.** The source holds this
 * in a 40-line `onKey` inside an effect, where a project with no JSX runner
 * cannot reach it — and the rules are not obvious: a nudge is refused on a
 * locked layer, Shift makes it ten times larger, and Delete must not fire while
 * the merchant is typing in a text box.
 */

/** A key event, reduced to what the decision needs. */
export interface KeyContext {
  key: string;
  shiftKey: boolean;
  /** `metaKey` on macOS, `ctrlKey` elsewhere — resolved by the caller. */
  modifier: boolean;
  /** True when focus is in a field that consumes typing. */
  inTextEntry: boolean;
  /** Whether a layer is selected, and whether it is locked. */
  selection: { present: boolean; locked: boolean };
}

export type KeyAction =
  | { kind: 'nudge'; dx: number; dy: number }
  | { kind: 'delete' }
  | { kind: 'deselect' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'duplicate' }
  | { kind: 'none' };

/** A plain arrow step, and the larger one Shift asks for. */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 10;

/**
 * How long a run of nudges rests before becoming one undo step.
 *
 * 📌 **Longer than the slider's 250ms**, and the source chose the same: arrow
 * presses arrive further apart than slider input, so a shorter window would
 * split one deliberate movement into several undo entries.
 */
export const NUDGE_COMMIT_MS = 400;

const ARROWS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

/**
 * Decide what a keypress does.
 *
 * ⚠️ **Text entry wins over everything**, and that is the guard most likely to
 * be left out. A merchant typing a layer name, or an image URL into the add
 * box, presses Backspace to correct a typo — without this check that deletes
 * their selected layer instead. The same applies to arrows moving a caret.
 */
export function keyAction(ctx: KeyContext): KeyAction {
  if (ctx.inTextEntry) {
    return { kind: 'none' };
  }

  if (ctx.modifier) {
    const lower = ctx.key.toLowerCase();

    /* ⚠️ Shift+Z is redo on every platform that offers it, alongside Ctrl+Y. */
    if (lower === 'z') {
      return ctx.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
    }

    if (lower === 'y') return { kind: 'redo' };
    if (lower === 'd' && ctx.selection.present) return { kind: 'duplicate' };

    /*
     * 📌 Any other modifier combination is the browser's — Ctrl+R, Cmd+L and
     * the rest must keep working inside a dialog.
     */
    return { kind: 'none' };
  }

  if (ctx.key === 'Escape') {
    return ctx.selection.present ? { kind: 'deselect' } : { kind: 'none' };
  }

  if (ctx.key === 'Delete' || ctx.key === 'Backspace') {
    /*
     * ⚠️ **A locked layer is NOT deleted by the keyboard**, though the layer
     * list still offers delete. The list is a deliberate act on a named row;
     * a keypress is easy to send at the wrong moment, and a lock exists to
     * make the layer hard to change by accident.
     */
    if (!ctx.selection.present || ctx.selection.locked) return { kind: 'none' };

    return { kind: 'delete' };
  }

  const arrow = ARROWS[ctx.key];

  if (arrow) {
    if (!ctx.selection.present || ctx.selection.locked) return { kind: 'none' };

    const step = ctx.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;

    return { kind: 'nudge', dx: arrow.dx * step, dy: arrow.dy * step };
  }

  return { kind: 'none' };
}

/**
 * Whether an action should stop the browser's own handling.
 *
 * 📌 **Only when something was actually done.** Calling `preventDefault` on
 * every key would break tabbing out of the dialog and typing anywhere in it.
 */
export function preventsDefault(action: KeyAction): boolean {
  return action.kind !== 'none';
}
