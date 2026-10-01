'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DesignImage } from '@shared/design/design-geometry.types';
import {
  keyAction,
  NUDGE_COMMIT_MS,
  preventsDefault,
} from '@/lib/design-lab/keyboard';
import { type DesignData, DesignStore } from '@/lib/design-lab/store';

import { DesignCanvas } from './design-canvas';
import { useDesignStore } from './use-design-store';
import { LayerList } from './layer-list';
import { PropertiesPanel } from './properties-panel';

import './design-lab.css';

/**
 * The Design Lab, mounted over a choice.
 *
 * 🔴 **A dialog, not a page, and that follows the source.** `DesignLabModal`
 * opens from a choice, hydrates that choice's saved design and returns the
 * edited one. A standalone route would be a destination editing a design that
 * belongs to nothing — and would have to be removed once M26d.4 binds designs to
 * the option model.
 *
 * ⚠️ **The two conversion points are the only boundary.** `importDesign` on open
 * and `exportDesign` on apply are where fractions become editor pixels and back;
 * M26c.2's contract is that conversion happens in exactly those two functions
 * and nowhere else, and this component is the one place both are called.
 */

export interface DesignLabDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The choice's saved design, or null for a blank canvas. */
  design: DesignData | null;
  /** The product photo the design is composed against. */
  background: DesignImage | null;
  /** Called with the edited design when the merchant applies it. */
  onApply: (design: DesignData) => void;
  title?: string;
}

export function DesignLabDialog({
  open,
  onOpenChange,
  design,
  background,
  onApply,
  title = 'Design Lab',
}: Readonly<DesignLabDialogProps>) {
  /*
   * 📌 **One store per mount, via a lazy initialiser.** `new DesignStore()` in
   * the render body would allocate a fresh engine on every render and throw the
   * history away. A ref would also build it once, but reading `ref.current`
   * during render is what React's compiler refuses — and it is right to: a ref
   * read in render is invisible to it, so it cannot tell whether the value is
   * stable. `useState`'s initialiser runs exactly once and the value is a
   * legitimate render input.
   */
  const [store] = useState(() => new DesignStore());

  /*
   * The dialog's own subscription, for the footer's undo/redo state. The canvas
   * and both panels subscribe for themselves, so this re-render is the chrome's
   * alone rather than the whole tree's.
   */
  useDesignStore(store);

  /*
   * ⚠️ **Hydrate on OPEN, and ONLY on open.** The dialog stays mounted while
   * closed, so hydrating once on mount would show the first choice's design for
   * every later one.
   *
   * 🔴 **Depending on `design` too would discard a merchant's work mid-edit.**
   * `importDesign` empties the canvas and resets history, so any new object
   * identity arriving while the lab is open — an undo from the history panel,
   * a background refetch, a second tab — would wipe whatever they had composed.
   * `ValueRow` solves the identical problem the same way and states the reason:
   * *"On OPEN, not on every prop change. Resyncing whenever the prop moved
   * would discard a half-typed edit the moment a background refetch landed."*
   * I wrote the first version depending on the prop, having read that comment.
   *
   * 📌 **The props are read through refs**, so the effect sees the CURRENT
   * design at the moment it opens without listing it as a dependency. A stale
   * closure would be the opposite defect: reopening on whatever was current
   * when the component mounted.
   */
  const designRef = useRef(design);
  const backgroundRef = useRef(background);

  /*
   * ⚠️ **Written in an effect, not during render.** React's compiler refuses a
   * ref assignment in the render body — correctly: a ref is invisible to it, so
   * it cannot tell whether the write is safe. This effect runs after every
   * render, which is exactly when the latest props are known.
   */
  useEffect(() => {
    designRef.current = design;
    backgroundRef.current = background;
  }, [design, background]);

  useEffect(() => {
    if (!open) return;

    store.importDesign(designRef.current, backgroundRef.current);
  }, [open, store]);

  /*
   * Keyboard shortcuts: nudge, delete, duplicate, undo/redo, deselect.
   *
   * 🔴 **`store.nudge` had no caller at all** — the method, its lock guard and
   * its commit-debounce contract were built and tested, and nothing invoked
   * them. That is this repository's recurring defect, found by auditing each
   * store operation for reachability rather than by any gate.
   *
   * ⚠️ **What each key MEANS is decided in `keyboard.ts`**, including the guard
   * that matters most: a keypress inside a text field is the field's. Without
   * it, a merchant correcting a typo in the add-layer box with Backspace would
   * delete their selected layer.
   */
  useEffect(() => {
    if (!open) return;

    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;

      const action = keyAction({
        key: e.key,
        shiftKey: e.shiftKey,
        /* ⌘ on macOS, Ctrl elsewhere — both, so neither platform is wrong. */
        modifier: e.metaKey || e.ctrlKey,
        inTextEntry:
          tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true,
        selection: {
          present: store.selectedId !== null,
          locked: store.getSelected()?.locked ?? false,
        },
      });

      if (!preventsDefault(action)) return;

      e.preventDefault();

      switch (action.kind) {
        case 'nudge':
          store.nudge(action.dx, action.dy);

          /*
           * 📌 A run of arrow presses is ONE undo step. `nudge` notifies
           * without committing for exactly this reason.
           */
          if (nudgeTimer) clearTimeout(nudgeTimer);
          nudgeTimer = setTimeout(() => store.commit(), NUDGE_COMMIT_MS);
          break;
        case 'delete':
          if (store.selectedId) store.deleteLayer(store.selectedId);
          break;
        case 'duplicate':
          store.duplicateSelected();
          break;
        case 'undo':
          store.undo();
          break;
        case 'redo':
          store.redo();
          break;
        case 'deselect':
          store.select(null);
          break;
      }
    }

    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      if (nudgeTimer) clearTimeout(nudgeTimer);
    };
  }, [open, store]);

  function apply() {
    onApply(store.exportDesign());
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="optionia-designlab-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Compose the artwork printed on this choice.
          </DialogDescription>
        </DialogHeader>

        <div className="optionia-designlab-body">
          <LayerList store={store} />
          <DesignCanvas store={store} />
          <PropertiesPanel store={store} />
        </div>

        <DialogFooter>
          {/*
            📌 Undo and redo read the store's own history rather than tracking
            their own; `canUndo` is false at the first snapshot, so the button
            cannot walk off the start of the stack.
          */}
          <Button
            type="button"
            variant="outline"
            disabled={!store.canUndo()}
            onClick={() => store.undo()}
          >
            Undo
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!store.canRedo()}
            onClick={() => store.redo()}
          >
            Redo
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={apply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
