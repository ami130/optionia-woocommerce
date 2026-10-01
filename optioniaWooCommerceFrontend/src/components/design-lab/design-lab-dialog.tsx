'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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
import { type DesignData, DesignStore } from '@/lib/design-lab/store';

import { DesignCanvas } from './design-canvas';
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

  useSyncExternalStore(
    useCallback((fn) => store.subscribe(fn), [store]),
    () => store.version,
    () => store.version,
  );

  /*
   * ⚠️ **Hydrate on OPEN, not on mount.** The dialog stays mounted while closed,
   * so hydrating once would show the first choice's design for every later one.
   *
   * 🔴 **Tracked in a ref rather than state, and that is not a shortcut.**
   * Hydration is a one-way push into an external system — the store notifies
   * React by itself — so recording "already done" in state would schedule a
   * render that changes nothing React draws. React's compiler refuses a
   * setState inside an effect body for exactly that reason, and it is right
   * here: the only consumer of this flag is the effect that writes it.
   */
  const hydratedFor = useRef<DesignData | null | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      /* Re-hydrate next time it opens, with whatever design is current then. */
      hydratedFor.current = undefined;

      return;
    }

    if (hydratedFor.current !== design) {
      hydratedFor.current = design;
      store.importDesign(design, background);
    }
  }, [open, design, background, store]);

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
