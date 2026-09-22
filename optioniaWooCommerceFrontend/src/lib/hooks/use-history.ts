import { useCallback, useRef, useState } from 'react';

import { createHistory, type History, type HistoryEntry } from '@/lib/option-sets/history';

/**
 * The React binding for the editor's inverse log (M20.10).
 *
 * 🔴 **The log lives in a ref; its DEPTH lives in state.** A ref alone survives
 * re-renders but changing it notifies nothing, so "Undo" would stay disabled
 * forever — the same shape of defect as reading `formState.isDirty` outside
 * render and finding it never updates. State alone would be rebuilt whenever a
 * parent re-rendered and lose the log. Both, with the state deliberately a
 * *derived summary* rather than a copy of the entries.
 *
 * ⚠️ **`version` is a counter, not the log.** Storing entries in state would
 * put closures over server calls into React's render path, and comparing them
 * by reference on every render is exactly the work this avoids.
 */
export interface HistoryBinding {
  record: (entry: HistoryEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

/** What the buttons need, read out of the log after every change. */
interface HistorySummary {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

const summarise = (log: History): HistorySummary => ({
  canUndo: log.canUndo(),
  canRedo: log.canRedo(),
  undoLabel: log.undoLabel(),
  redoLabel: log.redoLabel(),
});

const EMPTY: HistorySummary = {
  canUndo: false,
  canRedo: false,
  undoLabel: undefined,
  redoLabel: undefined,
};

export function useHistory(): HistoryBinding {
  const log = useRef<History | undefined>(undefined);

  /*
   * 🔴 **The summary is STATE, derived from the log after each change — the
   * flags are never read from the ref during render.**
   *
   * An earlier version returned `log.current.canUndo()` directly and the React
   * Compiler refused it: *"Accessing a ref value during render can cause your
   * component not to update as expected."* It was right, and the failure would
   * have been the subtle kind — the buttons looked correct only because
   * `notify()` happened to re-render, not because React tracked the value. The
   * same shape as `formState` being a Proxy that tracks what render reads.
   */
  const [summary, setSummary] = useState<HistorySummary>(EMPTY);

  const notify = useCallback(() => {
    const current = log.current;

    if (current !== undefined) {
      setSummary(summarise(current));
    }
  }, []);

  /*
   * ⚠️ **Created on first use, inside a callback rather than during render.**
   * `log.current ??= createHistory()` in the body is also a render-time ref
   * access, and the compiler refuses it for the same reason.
   */
  const ensure = useCallback((): History => {
    log.current ??= createHistory();

    return log.current;
  }, []);

  const record = useCallback(
    (entry: HistoryEntry) => {
      ensure().record(entry);
      notify();
    },
    [ensure, notify],
  );

  /*
   * 🔴 **`notify()` runs even when the inverse throws.** The entry stays in the
   * log on failure, and the buttons must keep reflecting that — a `finally` is
   * the difference between "undo failed, try again" and a UI frozen mid-undo.
   */
  const undo = useCallback(async () => {
    try {
      await ensure().undo();
    } finally {
      notify();
    }
  }, [ensure, notify]);

  const redo = useCallback(async () => {
    try {
      await ensure().redo();
    } finally {
      notify();
    }
  }, [ensure, notify]);

  const clear = useCallback(() => {
    ensure().clear();
    notify();
  }, [ensure, notify]);

  return { record, undo, redo, clear, ...summary };
}
