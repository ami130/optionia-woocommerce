import { describe, expect, it } from 'vitest';

import {
  type KeyContext,
  keyAction,
  NUDGE_COMMIT_MS,
  NUDGE_STEP,
  NUDGE_STEP_LARGE,
  preventsDefault,
} from './keyboard';

function ctx(over: Partial<KeyContext> = {}): KeyContext {
  return {
    key: 'ArrowRight',
    shiftKey: false,
    modifier: false,
    inTextEntry: false,
    selection: { present: true, locked: false },
    ...over,
  };
}

describe('keyAction — nudging', () => {
  it.each([
    ['ArrowUp', 0, -NUDGE_STEP],
    ['ArrowDown', 0, NUDGE_STEP],
    ['ArrowLeft', -NUDGE_STEP, 0],
    ['ArrowRight', NUDGE_STEP, 0],
  ])('%s moves the selection', (key, dx, dy) => {
    /*
     * 🔴 All four, with DISTINCT expectations per axis and sign. Testing one
     * arrow would let the whole table be wired to a single direction.
     */
    expect(keyAction(ctx({ key }))).toEqual({ kind: 'nudge', dx, dy });
  });

  it('nudges further with Shift held', () => {
    expect(keyAction(ctx({ key: 'ArrowRight', shiftKey: true }))).toEqual({
      kind: 'nudge',
      dx: NUDGE_STEP_LARGE,
      dy: 0,
    });
  });

  it('keeps the direction when Shift enlarges the step', () => {
    /* ⚠️ A sign dropped alongside the magnitude would pass the test above. */
    expect(keyAction(ctx({ key: 'ArrowLeft', shiftKey: true }))).toEqual({
      kind: 'nudge',
      dx: -NUDGE_STEP_LARGE,
      dy: 0,
    });
  });

  it('refuses to nudge a locked layer', () => {
    expect(
      keyAction(ctx({ key: 'ArrowRight', selection: { present: true, locked: true } })),
    ).toEqual({ kind: 'none' });
  });

  it('refuses to nudge with nothing selected', () => {
    expect(
      keyAction(ctx({ key: 'ArrowRight', selection: { present: false, locked: false } })),
    ).toEqual({ kind: 'none' });
  });
});

describe('keyAction — text entry wins', () => {
  /*
   * 🔴 The guard most likely to be left out, and the one whose absence is worst:
   * a merchant correcting a typo in the add-layer box presses Backspace and
   * their selected layer disappears.
   */
  it.each(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Escape'])(
    'ignores %s while typing',
    (key) => {
      expect(keyAction(ctx({ key, inTextEntry: true }))).toEqual({ kind: 'none' });
    },
  );

  it('ignores an undo shortcut while typing, so the field keeps its own', () => {
    expect(
      keyAction(ctx({ key: 'z', modifier: true, inTextEntry: true })),
    ).toEqual({ kind: 'none' });
  });
});

describe('keyAction — deleting', () => {
  it.each(['Delete', 'Backspace'])('%s removes the selection', (key) => {
    expect(keyAction(ctx({ key }))).toEqual({ kind: 'delete' });
  });

  it('refuses to delete a LOCKED layer from the keyboard', () => {
    /*
     * ⚠️ The layer list still offers delete on a locked row — that is a
     * deliberate act on a named row. A keypress is easy to send by accident,
     * which is what a lock exists to guard against.
     */
    expect(
      keyAction(ctx({ key: 'Delete', selection: { present: true, locked: true } })),
    ).toEqual({ kind: 'none' });
  });

  it('does nothing with nothing selected', () => {
    expect(
      keyAction(ctx({ key: 'Delete', selection: { present: false, locked: false } })),
    ).toEqual({ kind: 'none' });
  });
});

describe('keyAction — history and selection', () => {
  it('undoes with the modifier and z', () => {
    expect(keyAction(ctx({ key: 'z', modifier: true }))).toEqual({ kind: 'undo' });
  });

  it('redoes with shift held, and with y', () => {
    expect(keyAction(ctx({ key: 'z', modifier: true, shiftKey: true }))).toEqual({
      kind: 'redo',
    });
    expect(keyAction(ctx({ key: 'y', modifier: true }))).toEqual({ kind: 'redo' });
  });

  it('reads the shortcut whatever its case', () => {
    /* Shift+Z arrives as 'Z' on most browsers — the obvious way to miss redo. */
    expect(keyAction(ctx({ key: 'Z', modifier: true, shiftKey: true }))).toEqual({
      kind: 'redo',
    });
    expect(keyAction(ctx({ key: 'Z', modifier: true }))).toEqual({ kind: 'undo' });
  });

  it('duplicates with the modifier and d', () => {
    expect(keyAction(ctx({ key: 'd', modifier: true }))).toEqual({ kind: 'duplicate' });
  });

  it('does not duplicate with nothing selected', () => {
    expect(
      keyAction(ctx({ key: 'd', modifier: true, selection: { present: false, locked: false } })),
    ).toEqual({ kind: 'none' });
  });

  it('leaves other modifier combinations to the browser', () => {
    /*
     * 📌 Ctrl+R, Cmd+L and the rest must keep working inside a dialog. A
     * catch-all that swallowed them would trap the merchant.
     */
    for (const key of ['r', 'l', 't', 'w', 'a']) {
      expect(keyAction(ctx({ key, modifier: true }))).toEqual({ kind: 'none' });
    }
  });

  it('deselects on Escape, and does nothing when there is no selection', () => {
    expect(keyAction(ctx({ key: 'Escape' }))).toEqual({ kind: 'deselect' });
    expect(
      keyAction(ctx({ key: 'Escape', selection: { present: false, locked: false } })),
    ).toEqual({ kind: 'none' });
  });

  it('deselects a LOCKED layer, which is not a change to it', () => {
    /* ⚠️ Unlike delete and nudge: deselecting alters nothing about the layer. */
    expect(
      keyAction(ctx({ key: 'Escape', selection: { present: true, locked: true } })),
    ).toEqual({ kind: 'deselect' });
  });

  it('ignores an unhandled key', () => {
    expect(keyAction(ctx({ key: 'q' }))).toEqual({ kind: 'none' });
  });
});

describe('preventsDefault', () => {
  it('stops the browser only when something was done', () => {
    expect(preventsDefault({ kind: 'nudge', dx: 1, dy: 0 })).toBe(true);
    expect(preventsDefault({ kind: 'delete' })).toBe(true);
    expect(preventsDefault({ kind: 'none' })).toBe(false);
  });
});

describe('the commit windows', () => {
  it('rests longer than a slider does', () => {
    /*
     * 📌 Arrow presses arrive further apart than slider input, so a shorter
     * window would split one deliberate movement into several undo entries.
     * Pinned as a RELATIONSHIP, which survives either constant being tuned.
     */
    expect(NUDGE_COMMIT_MS).toBeGreaterThan(250);
  });

  it('keeps the large step a real multiple of the small one', () => {
    expect(NUDGE_STEP_LARGE).toBeGreaterThan(NUDGE_STEP);
    expect(NUDGE_STEP_LARGE % NUDGE_STEP).toBe(0);
  });
});
