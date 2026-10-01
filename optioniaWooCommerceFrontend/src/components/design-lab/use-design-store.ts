'use client';

import { useCallback, useSyncExternalStore } from 'react';

import type { DesignStore } from '@/lib/design-lab/store';

/**
 * Subscribe THIS component to the store.
 *
 * 🔴 **Every component that reads the store calls this, and that is the point.**
 * M26d.1 is the one milestone in its phase that dictates an implementation:
 *
 * > *"an explicit state engine with subscribe/notify rather than React state,
 * > and that choice is load-bearing — a canvas mutates on every pointer move,
 * > and reconciliation on each one is why naive implementations feel laggy."*
 *
 * ⚠️ **Adopting the store without adopting this is the trap, and I fell into
 * it.** The first assembly subscribed only in the dialog, and the panels read
 * the store with no subscription of their own — so they updated only because
 * the dialog re-rendered its whole subtree, reconciling the layer list, the
 * properties panel and the dialog chrome on every pointer move of a drag. That
 * is precisely the cost the architecture exists to avoid, reintroduced one level
 * up. With each component subscribed independently, a notify re-renders each on
 * its own and React can bail out of the subtrees that did not change.
 *
 * 📌 **The snapshot is a version counter**, not a structure: the store mutates
 * layers in place, so the layers array is the same reference across a drag and
 * `Object.is` would see no change. Returning a fresh object instead would
 * re-render correctly and allocate on every pointer move — the cost the
 * in-place design exists to avoid.
 */
export function useDesignStore(store: DesignStore): DesignStore {
  useSyncExternalStore(
    useCallback((fn) => store.subscribe(fn), [store]),
    () => store.version,
    () => store.version,
  );

  return store;
}
