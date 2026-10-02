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
import { type BackgroundSource, backgroundFor, canBeBackground } from '@/lib/design-lab/background';
import {
  keyAction,
  NUDGE_COMMIT_MS,
  preventsDefault,
} from '@/lib/design-lab/keyboard';
import type { DesignImage, TextDesign } from '@shared/design/design-geometry.types';
import { type DesignData, DesignStore } from '@/lib/design-lab/store';
import { googleFontsHref } from '@/lib/design-lab/text-fonts';

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
  /**
   * The product the design is composed against, or null for a blank canvas.
   *
   * 🔴 **A product, not a `DesignImage`.** The canvas needs the photo's natural
   * dimensions — `setCanvasSize` divides by them — and a synced product carries
   * a URL and no size. Measuring belongs here, where the image is loaded once on
   * open, rather than in every caller.
   */
  product: BackgroundSource | null;
  /**
   * The option's saved text design, or null when it has none (M26d.3).
   *
   * 🔴 **A SEPARATE channel from `design`, because it persists to a different
   * column.** A value's artwork is `option_values.design`; a text option's is
   * `options.textDesign`, and a text option has no values to hang the first one
   * on. Folding the two into one prop would send the text where nothing reads
   * it — which is exactly what happened while this prop did not exist: a
   * merchant could compose a text and `onApply` discarded it in silence.
   */
  text?: TextDesign | null;
  /** Called with the edited design when the merchant applies it. */
  onApply: (design: DesignData) => void;
  /**
   * Called with the edited text when the merchant applies it.
   *
   * ⚠️ **Absent for a value's design**, which carries no text — the lab is then
   * a layer editor and `exportText` has nothing to return.
   */
  onApplyText?: (text: TextDesign | null) => void;
  title?: string;
}

/**
 * The id the curated-font stylesheet is deduplicated by.
 *
 * 📌 **Not spelled `optionia-designlab-…`, deliberately.** The design-store
 * gate reads every `optionia-designlab-*` string the components emit and
 * requires a CSS rule for it — correctly, since that prefix is this editor's
 * class namespace. This is an element id on a `<link>`, which has no rule and
 * should never have one, so it stays outside the namespace rather than being
 * exempted from the check.
 */
const FONT_LINK_ID = 'optionia-text-fonts-stylesheet';

export function DesignLabDialog({
  open,
  onOpenChange,
  design,
  product,
  text,
  onApplyText,
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
  const productRef = useRef(product);
  const textRef = useRef(text);

  /*
   * ⚠️ **Written in an effect, not during render.** React's compiler refuses a
   * ref assignment in the render body — correctly: a ref is invisible to it, so
   * it cannot tell whether the write is safe. This effect runs after every
   * render, which is exactly when the latest props are known.
   */
  useEffect(() => {
    designRef.current = design;
    productRef.current = product;
    textRef.current = text;
  }, [design, product, text]);

  /*
   * Load the curated families, once, the first time a lab opens.
   *
   * 🔴 **Without this the canvas measures FALLBACK metrics.** A `<link>` is
   * what makes the browser resolve `font-family: "Pacifico"` to Pacifico rather
   * than to whatever sans-serif it has — and `measureAdvanceRatio` would then
   * persist a ratio taken from the wrong glyphs, baking the mistake into the
   * stored design.
   *
   * 📌 **No font FILE is added to the repository by this.** The licence
   * sign-off that M26d.3 guards is about shipping TTFs for server-side
   * rasterisation (Decision 4); a webfont stylesheet is how the browser has
   * always drawn this text, and is what the original editor and the storefront
   * both do.
   *
   * ⚠️ **Deduplicated by id and never removed.** A second dialog must not
   * append a second copy, and removing it on close would re-fetch — and
   * re-flash — every time the merchant reopened the lab.
   */
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    if (document.getElementById(FONT_LINK_ID)) return;

    const link = document.createElement('link');

    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = googleFontsHref();
    document.head.appendChild(link);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    /*
     * Hydrate both channels, in this order.
     *
     * 🔴 **`importText` runs AFTER `importDesign`, always.** `importDesign`
     * sets the canvas size from the product photo's aspect, and `importText`
     * turns stored fractions into pixels against `cw`/`ch` — so running it
     * first would place the text against the PREVIOUS canvas. One helper
     * rather than three call sites, because the ordering rule is the thing
     * worth having in one place.
     */
    const hydrate = (background: DesignImage | null) => {
      store.importDesign(designRef.current, background);
      store.importText(textRef.current ?? null);
    };

    const chosen = productRef.current;

    /*
     * 📌 **No photo is the ordinary case**, not a failure: a synced catalogue
     * carries plenty of products without one, and the lab composes on a blank
     * canvas exactly as it did before backgrounds existed.
     */
    if (!canBeBackground(chosen)) {
      hydrate(null);

      return;
    }

    /*
     * 🔴 **The image is MEASURED before the design is imported, and the order
     * is load-bearing.** `importDesign` calls `setCanvasSize` from the photo's
     * aspect and then places every layer against that canvas; importing first
     * and resizing after would place them against 392×464 and leave them there.
     *
     * ⚠️ **Hydration still happens exactly once per open.** The effect depends
     * on `open` alone — see above — and `cancelled` stops a late `onload` from
     * a previous open re-importing over a canvas the merchant has since edited.
     */
    let cancelled = false;
    const img = new Image();

    img.crossOrigin = 'anonymous';

    img.onload = () => {
      if (cancelled) return;

      hydrate(
        backgroundFor(chosen, { width: img.naturalWidth, height: img.naturalHeight }),
      );
    };

    /*
     * ⚠️ **A photo that will not load must not block the lab.** A merchant's
     * CDN may refuse the cross-origin request, or the URL may have rotted; the
     * design is still editable, and refusing to open would be a worse failure
     * than a blank canvas.
     */
    img.onerror = () => {
      if (cancelled) return;

      hydrate(null);
    };

    img.src = chosen?.imageUrl ?? '';

    return () => {
      cancelled = true;
    };
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

    /*
     * 🔴 **The text goes back on its OWN channel.** It persists to a different
     * column than the layers, so a single `onApply(DesignData)` cannot carry
     * it — and for four commits it did not: the merchant's text was composed,
     * drawn, styled and then dropped on the way out.
     *
     * 📌 **Sent even when null**, so removing a text persists the removal
     * rather than leaving the stored one behind.
     */
    onApplyText?.(store.exportText());
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
