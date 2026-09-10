import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_DEBOUNCE_MS } from './use-debounced';

/**
 * The debounce contract, tested as the timer algebra it is.
 *
 * `useDebounced` is a hook, and no React renderer is installed
 * (`@testing-library/react` is not a dependency), so the *effect body* is
 * reproduced here rather than mocked away: same `setTimeout`/`clearTimeout`
 * pairing, driven by fake timers.
 *
 * ⚠️ **This proves the algorithm, not the wiring.** That a component actually
 * passes its search term through the hook is asserted by
 * `search-debounce.test.ts`, which reads the source — the two together cover
 * what a render test would.
 */
function simulate(keystrokes: Array<{ value: string; afterMs: number }>, delayMs: number) {
  let settled = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const commit = (value: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      settled = value;
    }, delayMs);
  };

  for (const key of keystrokes) {
    vi.advanceTimersByTime(key.afterMs);
    commit(key.value);
  }

  return {
    /** What has reached the API so far. */
    now: () => settled,
    /** Let everything pending fire. */
    flush: () => {
      vi.advanceTimersByTime(delayMs);
      return settled;
    },
  };
}

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * 🔴 The defect: seventeen keystrokes against a 20/second throttle.
   *
   * "Oak Serving Board" typed at 80ms per character must reach the API **once**,
   * not once per character.
   */
  it('collapses a typed product name into a single request', () => {
    const term = 'Oak Serving Board';
    const keystrokes = term.split('').map((_, index) => ({
      value: term.slice(0, index + 1),
      afterMs: 80,
    }));

    const run = simulate(keystrokes, SEARCH_DEBOUNCE_MS);

    // Nothing has fired while the merchant is still typing.
    expect(run.now()).toBe('');
    // And what lands is the whole term, not a prefix of it.
    expect(run.flush()).toBe('Oak Serving Board');
  });

  it('emits once the value holds still', () => {
    const run = simulate([{ value: 'oak', afterMs: 0 }], SEARCH_DEBOUNCE_MS);

    expect(run.now()).toBe('');
    expect(run.flush()).toBe('oak');
  });

  /** A pause longer than the delay is a real search, not a keystroke. */
  it('emits each term when the merchant pauses between them', () => {
    const run = simulate(
      [
        { value: 'oak', afterMs: 0 },
        { value: 'linen', afterMs: SEARCH_DEBOUNCE_MS + 50 },
      ],
      SEARCH_DEBOUNCE_MS,
    );

    expect(run.now()).toBe('oak');
    expect(run.flush()).toBe('linen');
  });

  /** Clearing a term must reach the API too, or the list stays filtered. */
  it('propagates an emptied search box', () => {
    const run = simulate(
      [
        { value: 'oak', afterMs: 0 },
        { value: '', afterMs: SEARCH_DEBOUNCE_MS + 50 },
      ],
      SEARCH_DEBOUNCE_MS,
    );

    expect(run.flush()).toBe('');
  });

  /** Below the ~400ms a reader notices, above one-request-per-keystroke. */
  it('uses a delay that is neither perceptible nor useless', () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(150);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(400);
  });
});
