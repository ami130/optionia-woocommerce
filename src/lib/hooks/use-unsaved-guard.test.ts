import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearDirtyValues,
  confirmDiscard,
  confirmGroupSwitch,
  setValueDirty,
} from './use-unsaved-guard';

/**
 * The half of M20.10's guard that a browser dialog cannot cover.
 *
 * 🔴 **`beforeunload` never fires for an in-app route change.** Next's
 * client-side navigation and the editor's own group switch both bypass it
 * entirely, so the case most likely to lose work — one click, inside the
 * page — needs its own question.
 */
describe('confirmDiscard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * ⚠️ **A clean form must never interrupt.** A guard that asks every time
   * teaches a merchant to dismiss it without reading, which costs more than it
   * saves the first time the form really is dirty.
   */
  it('allows the switch without asking when nothing is unsaved', () => {
    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);

    expect(confirmDiscard(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before discarding unsaved work', () => {
    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);

    expect(confirmDiscard(true)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  /** 🔴 Declining must block the switch, or the question was decoration. */
  it('blocks the switch when the merchant declines', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));

    expect(confirmDiscard(true)).toBe(false);
  });

  /** The message names what is at stake, not just "are you sure?". */
  it('says what will be lost', () => {
    const confirm = vi.fn((message?: string) => {
      expect(message).toMatch(/not saved|discard/i);

      return true;
    });

    vi.stubGlobal('confirm', confirm);
    confirmDiscard(true);

    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

/**
 * Unsaved **value** edits, which the group switch did not see.
 *
 * 🔴 **Proven lost before this existed.** A probe typed into an open `ValueRow`
 * and clicked another group: `confirmCalled=0 rowDestroyed=true`. `GroupCard`
 * carries `key={selected.id}`, so a switch remounts it and destroys every row
 * beneath — and `confirmGroupSwitch` consulted only `AddOption`'s flag.
 *
 * ⚠️ **A set of ids, not a boolean.** `editing` is per-row state, so several
 * rows can be dirty at once — one flag would be cleared by whichever row went
 * clean last, leaving the others unguarded.
 */
describe('unsaved value edits', () => {
  beforeEach(() => {
    clearDirtyValues();
  });

  it('asks before a group switch when a value edit is unsaved', () => {
    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);
    setValueDirty('v1', true);

    expect(confirmGroupSwitch()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('does not ask when every value edit is saved', () => {
    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);
    setValueDirty('v1', true);
    setValueDirty('v1', false);

    expect(confirmGroupSwitch()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  /** 🔴 The case a single boolean gets wrong. */
  it('still guards a second dirty row when the first goes clean', () => {
    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);
    setValueDirty('v1', true);
    setValueDirty('v2', true);
    setValueDirty('v1', false);

    confirmGroupSwitch();

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  /** ⚠️ Declining must block the switch, as it does for a half-typed option. */
  it('blocks the switch when the merchant declines', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    setValueDirty('v1', true);

    expect(confirmGroupSwitch()).toBe(false);
  });
});
