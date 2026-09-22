import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useHistory } from './use-history';

/**
 * The React binding for the inverse log.
 *
 * 🔴 **The log itself must survive re-renders, and the BUTTONS must not.**
 * Holding it in a ref alone would keep the log but leave "Undo" permanently
 * disabled, because nothing would re-render when its depth changed — the same
 * class of defect as `formState` being a Proxy that tracks only what is read
 * during render.
 */
function Harness({ onRecord }: { onRecord?: (record: ReturnType<typeof useHistory>) => void }) {
  const history = useHistory();

  onRecord?.(history);

  return (
    <div>
      <span data-testid="can-undo">{String(history.canUndo)}</span>
      <span data-testid="label">{history.undoLabel ?? 'none'}</span>
    </div>
  );
}

describe('useHistory', () => {
  it('starts with nothing to undo', () => {
    render(<Harness />);

    expect(screen.getByTestId('can-undo').textContent).toBe('false');
  });

  /** 🔴 Recording must re-render, or the button never enables. */
  it('re-renders when an operation is recorded', () => {
    let api: ReturnType<typeof useHistory> | undefined;

    render(<Harness onRecord={(h) => (api = h)} />);

    act(() => {
      api?.record({ label: 'Rename value', inverse: async () => {} });
    });

    expect(screen.getByTestId('can-undo').textContent).toBe('true');
    expect(screen.getByTestId('label').textContent).toBe('Rename value');
  });

  it('re-renders when an operation is undone', async () => {
    let api: ReturnType<typeof useHistory> | undefined;

    render(<Harness onRecord={(h) => (api = h)} />);

    act(() => {
      api?.record({ label: 'Rename value', inverse: async () => {} });
    });

    await act(async () => {
      await api?.undo();
    });

    expect(screen.getByTestId('can-undo').textContent).toBe('false');
  });

  /** ⚠️ The log survives re-renders — a new one each render would lose it. */
  it('keeps the log across re-renders', () => {
    let api: ReturnType<typeof useHistory> | undefined;

    const { rerender } = render(<Harness onRecord={(h) => (api = h)} />);

    act(() => {
      api?.record({ label: 'Rename value', inverse: async () => {} });
    });

    rerender(<Harness onRecord={(h) => (api = h)} />);

    expect(screen.getByTestId('can-undo').textContent).toBe('true');
  });

  /**
   * 🔴 A refused inverse leaves the entry in place, and says so.
   *
   * ⚠️ **This asserts a RE-RENDER, not just the flag.** An earlier version
   * checked `canUndo` alone and survived a mutant that moved `notify()` out of
   * the `finally` — the harness re-rendered anyway because the test's own
   * `act()` flushed, so the flag read true either way. Counting renders is what
   * distinguishes "the UI was told" from "the value happened to be right".
   */
  it('surfaces the error and keeps the entry when the inverse fails', async () => {
    let api: ReturnType<typeof useHistory> | undefined;
    let renders = 0;

    render(
      <Harness
        onRecord={(h) => {
          api = h;
          renders += 1;
        }}
      />,
    );

    act(() => {
      api?.record({
        label: 'Rename value',
        inverse: async () => {
          throw new Error('refused');
        },
      });
    });

    const before = renders;

    await act(async () => {
      await expect(api?.undo()).rejects.toThrow('refused');
    });

    expect(renders).toBeGreaterThan(before);
    expect(screen.getByTestId('can-undo').textContent).toBe('true');
  });
});
