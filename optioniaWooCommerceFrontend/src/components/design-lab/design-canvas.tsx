'use client';

import { useEffect, useId, useRef } from 'react';

import type { PathShape } from '@shared/design/design-geometry.types';
import { arcTextAnchor } from '@shared/design/arc-geometry';
import { SHAPE_CLIP_PATHS } from '@shared/design/layer-geometry';
import { textAnchorFor } from '@shared/design/text-geometry';
import {
  type CropHitKind,
  type CropIntent,
  canEnterCrop,
  cropIntentFor,
} from '@/lib/design-lab/crop-dispatch';
import {
  cropMoveTo,
  cropResizeTo,
  innerPlacement,
} from '@/lib/design-lab/crop-geometry';
import type { DesignStore } from '@/lib/design-lab/store';
import type { EditorLayer } from '@/lib/design-lab/layer.types';
import { type DragIntent, dragIntentFor, type HitKind, selectsLayer } from '@/lib/design-lab/drag-dispatch';
import { moveTo, resizeFrom, rotateTo } from '@/lib/design-lab/drag-geometry';
import {
  drawnSelectionRect,
  handlesFor,
  layerCursor,
  showsHandles,
} from '@/lib/design-lab/selection-box';

import {
  MEASURE_PX,
  advanceRatioChanged,
  fontShorthand,
  measureAdvanceRatio,
} from '@/lib/design-lab/text-fonts';
import { placeText } from '@/lib/design-lab/text-render';
import type { EditorText } from '@/lib/design-lab/text-model';

import { useDesignStore } from './use-design-store';

import './design-lab.css';

/**
 * The Design Lab canvas: layers, the selection overlay, and the pointer
 * gestures that move them.
 *
 * 🔴 **This file is the DOM, and almost nothing else.** Every decision it makes
 * was extracted first — `drag-dispatch` decides what a mousedown starts,
 * `drag-geometry` does the arithmetic, `selection-box` sizes the overlay. What
 * is left here is `closest()`, `getBoundingClientRect`, two document listeners
 * and a subscription.
 *
 * ⚠️ **That split is deliberate and the honest part of it is this: what remains
 * here is NOT unit-tested, and has NOT been run.** This project has no JSX test
 * runner (`@vitejs/plugin-react` wants Babel 8 against a Babel 7 toolchain), and
 * nothing mounts the Design Lab yet — so the event plumbing is verified by a
 * gate and by reading, and by nothing else. Pushing the decisions out was
 * the way to make that unverified surface small enough that reading it is
 * sufficient; it is not a claim that it was exercised.
 *
 * 📌 **Crop mode is M26d.2**, and with it the double-click handler. The source
 * dispatcher opens with three crop branches and binds `onDoubleClick` to toggle
 * crop on a shaped layer; `store.cropping` is always null until that stage, so
 * all four would be unreachable code here. They arrive together with the
 * feature, because a double-click that toggles nothing is worse than none.
 *
 * ⚠️ **Shaped layers are M26d.2 too.** Every layer currently draws as a plain
 * box: the frame clip-paths, the inner image placement and the crop overlay all
 * belong to that stage. `shape` already rides on the type and through
 * {@link resizeFrom}'s aspect lock, so the frames arrive without disturbing
 * this file's geometry.
 */

/** Marks the drag surface — a click on the surround deselects, as on the canvas. */
const STAGE_CLASS = 'optionia-designlab-stage';
const LAYER_CLASS = 'optionia-designlab-layer';
const BG_LAYER_CLASS = 'optionia-designlab-bg-layer';
const SEL_BOX_CLASS = 'optionia-designlab-sel-box';
const HANDLE_CLASS = 'optionia-designlab-handle-pt';
const ROTATE_CLASS = 'optionia-designlab-rotate-pt';
/** The dashed box around the IMAGE while crop mode is open (M26d.2). */
const CROP_BOX_CLASS = 'optionia-designlab-crop-box';

/**
 * A gesture in progress.
 *
 * ⚠️ **`scale` is FROZEN at pointer-down, and that is load-bearing.** Client
 * pixels become canvas pixels by dividing by the canvas scale; reading it live
 * means a zoom mid-drag re-divides the whole accumulated delta and the layer
 * jumps. The source hook records the same warning.
 */
interface ActiveDrag {
  /**
   * 🔴 **Either dispatcher's intent.** Crop mode replaces the outer gestures
   * rather than adding to them, so one drag record carries whichever is open —
   * the alternative is a second ref that must never be non-null at the same
   * time as this one.
   */
  intent: DragIntent | CropIntent;
  layer: EditorLayer;
  startX: number;
  startY: number;
  scale: number;
  /** Rotation only: the selection box's screen centre and the opening angle. */
  pivotX?: number;
  pivotY?: number;
  startAngle?: number;
  /**
   * Crop gestures only: the inner image's box when the gesture began, in
   * frame-local pixels. Read from `frameImageRect` once rather than recomputed
   * per move, so a clamp mid-drag cannot feed back into the start.
   */
  cropStart?: { icx: number; icy: number; w: number; h: number };
  /** Whether anything actually moved, so a click does not push a history entry. */
  changed: boolean;
}

/** What the pointer landed on, resolved from the DOM. */
function resolveHit(target: HTMLElement): {
  hit: HitKind;
  layerId: string | null;
  handleDir?: string;
} {
  const selBox = target.closest(`.${SEL_BOX_CLASS}`) as HTMLElement | null;

  /*
   * 📌 Handles only exist inside a selection box, so a handle with no box is a
   * stray element rather than a gesture — the source makes the same pairing.
   */
  if (selBox) {
    const boxId = selBox.dataset.id ?? null;

    if (target.closest(`.${ROTATE_CLASS}`)) {
      return { hit: 'rotate-handle', layerId: boxId };
    }

    const handle = target.closest(`.${HANDLE_CLASS}`) as HTMLElement | null;

    if (handle) {
      return { hit: 'resize-handle', layerId: boxId, handleDir: handle.dataset.h };
    }
  }

  const layerEl = target.closest(
    `.${LAYER_CLASS}:not(.${BG_LAYER_CLASS})`,
  ) as HTMLElement | null;

  if (layerEl) {
    return { hit: 'layer', layerId: layerEl.dataset.id ?? null };
  }

  return { hit: 'empty', layerId: null };
}

/**
 * What the pointer landed on while crop mode is open.
 *
 * 🔴 **The grips belong to the CROP box here, not the selection box.** Both
 * carry the same handle classes, and crop mode hides the selection box — so
 * scoping to the crop box is what stops a stale selection grip answering.
 */
function resolveCropHit(
  target: HTMLElement,
  croppingId: string,
): { hit: CropHitKind; handleDir?: string } {
  const cropBox = target.closest(`.${CROP_BOX_CLASS}`) as HTMLElement | null;

  if (cropBox) {
    if (target.closest(`.${ROTATE_CLASS}`)) return { hit: 'crop-rotate-handle' };

    const handle = target.closest(`.${HANDLE_CLASS}`) as HTMLElement | null;

    if (handle) return { hit: 'crop-resize-handle', handleDir: handle.dataset.h };
  }

  /* The layer being cropped — a drag on the image pans it inside its frame. */
  if (target.closest(`.${LAYER_CLASS}[data-id="${croppingId}"]`)) {
    return { hit: 'cropped-layer' };
  }

  return { hit: 'outside' };
}

/**
 * The screen centre a rotation turns about, and the angle it began at.
 *
 * 🔴 **One copy, and a gate counts the calls to prove it.** That check exists
 * because the opening angle was once measured twice — here and again inside
 * `rotateTo` — so the function received the result of the first. Crop mode
 * added a second rotation gesture with the identical five lines, which is the
 * duplication the count is there to notice.
 *
 * ⚠️ **Only a browser can answer this.** The pivot is the box's SCREEN centre,
 * which depends on layout, scroll and the page transform — no amount of
 * extraction computes it.
 */
function rotationPivot(
  box: HTMLElement,
  e: { clientX: number; clientY: number },
): { pivotX: number; pivotY: number; startAngle: number } {
  const rect = box.getBoundingClientRect();
  const pivotX = rect.left + rect.width / 2;
  const pivotY = rect.top + rect.height / 2;

  return {
    pivotX,
    pivotY,
    startAngle: Math.atan2(e.clientY - pivotY, e.clientX - pivotX),
  };
}

export function DesignCanvas({ store }: Readonly<{ store: DesignStore }>) {
  /*
   * ⚠️ **A per-instance prefix for the clip ids**, with `:` stripped so the
   * result is safe inside `url(#…)`. One Design Lab mounts per choice, and a
   * shared id resolves document-wide to the first match — which may be a closed
   * dialog's hidden defs, clipping the layer to nothing.
   */
  const clipPrefix = useId().replaceAll(':', '');

  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);

  /* This component's own subscription — see `useDesignStore`. */
  useDesignStore(store);

  /* Register the three elements the fit measures and writes. */
  useEffect(() => {
    store.attachStage({
      stage: stageRef.current,
      wrap: wrapRef.current,
      scale: scaleRef.current,
    });
    store.fitCanvas();

    const onResize = () => store.fitCanvas();

    window.addEventListener('resize', onResize);

    let observer: ResizeObserver | undefined;

    if (typeof ResizeObserver !== 'undefined' && stageRef.current) {
      observer = new ResizeObserver(() => store.fitCanvas());
      observer.observe(stageRef.current);
    }

    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      store.attachStage(null);
    };
  }, [store]);

  /*
   * ⚠️ **Re-fit after every render, deliberately dependency-free.** A layout
   * change with no window resize — a panel opening, the viewport settling after
   * fonts load — moves the stage without firing an event. `canvasScale` is the
   * divisor for every drag delta, so a stale one makes dragging wrong by a
   * factor while the canvas still LOOKS correct, which is the hardest kind of
   * wrong to see. The ResizeObserver above catches most of it; this catches the
   * rest, and `fitCanvas` writes nothing when the numbers have not moved.
   */
  useEffect(() => {
    store.fitCanvas();
  });

  /**
   * Double-clicking a framed layer adjusts the image inside it.
   *
   * 🔴 **The only way into crop mode**, and the source's gesture. `canEnterCrop`
   * refuses exactly what `enterCrop` refuses, so a double-click on a plain or
   * locked layer does nothing rather than appearing to work.
   *
   * 📌 **A toggle**: double-clicking the layer being cropped leaves.
   */
  function onDoubleClick(e: React.MouseEvent) {
    const layerEl = (e.target as HTMLElement).closest(
      `.${LAYER_CLASS}:not(.${BG_LAYER_CLASS})`,
    ) as HTMLElement | null;

    if (!layerEl) return;

    const id = layerEl.dataset.id ?? '';
    const layer = store.layers.find((l) => l.id === id) ?? null;

    if (store.cropping === id) {
      store.exitCrop();

      return;
    }

    if (canEnterCrop(layer)) store.enterCrop(id);
  }

  function onCropMouseDown(e: React.MouseEvent, croppingId: string) {
    const layer = store.layers.find((l) => l.id === croppingId) ?? null;
    const { hit, handleDir } = resolveCropHit(e.target as HTMLElement, croppingId);
    const intent = cropIntentFor(hit, layer, handleDir);

    if (intent.kind === 'exit-crop') {
      store.exitCrop();

      return;
    }

    /*
     * 📌 `none` is a refused gesture, not a reason to leave — a pinned image
     * cannot pan, and both grips live inside the same box.
     */
    if (intent.kind === 'none' || !layer) return;

    e.preventDefault();

    const placed = innerPlacement(layer);
    const drag: ActiveDrag = {
      intent,
      layer,
      startX: e.clientX,
      startY: e.clientY,
      scale: store.canvasScale,
      cropStart: {
        icx: placed.rect.x + placed.rect.w / 2,
        icy: placed.rect.y + placed.rect.h / 2,
        w: placed.rect.w,
        h: placed.rect.h,
      },
      changed: false,
    };

    if (intent.kind === 'crop-rotate') {
      /*
       * 🔴 **The crop box's screen centre**, which only the DOM can give. The
       * angle maths is `rotateTo`'s, exactly as the outer rotation — rotation
       * offsets compose additively, so a screen-space delta equals the
       * frame-local one and no un-rotation is needed here.
       */
      const box = (e.target as HTMLElement).closest(
        `.${CROP_BOX_CLASS}`,
      ) as HTMLElement | null;

      if (!box) return;

      const pivot = rotationPivot(box, e);

      drag.pivotX = pivot.pivotX;
      drag.pivotY = pivot.pivotY;
      drag.startAngle = pivot.startAngle;
    }

    dragRef.current = drag;
  }

  function onMouseDown(e: React.MouseEvent) {
    /*
     * 🔴 **Crop mode replaces the outer gestures entirely.** While it is open
     * the same pixels mean different things — a drag pans the image inside its
     * frame rather than moving the frame — so this returns rather than falling
     * through, and the outer dispatcher never runs.
     */
    if (store.cropping !== null) {
      onCropMouseDown(e, store.cropping);

      return;
    }

    const { hit, layerId, handleDir } = resolveHit(e.target as HTMLElement);
    const layer = layerId ? (store.layers.find((l) => l.id === layerId) ?? null) : null;
    const intent = dragIntentFor(hit, layer, { cw: store.cw, ch: store.ch }, handleDir);

    if (intent.kind === 'deselect') {
      if (store.selectedId !== null) store.select(null);

      return;
    }

    if (intent.kind === 'none' || !layer) return;

    e.preventDefault();

    /*
     * ⚠️ Selection before the drag decision, and through `select()` rather than
     * by assigning `selectedId` — the setter is what notifies subscribers, and
     * a locked layer must still select so the merchant can reach the control
     * that unlocks it.
     */
    if (selectsLayer(intent) && store.selectedId !== layer.id) {
      store.select(layer.id);
    }

    if (intent.kind === 'select-only') return;

    const drag: ActiveDrag = {
      intent,
      layer,
      startX: e.clientX,
      startY: e.clientY,
      scale: store.canvasScale,
      changed: false,
    };

    if (intent.kind === 'rotate') {
      /*
       * 🔴 **The one thing only a browser can answer.** Rotation is measured
       * from the selection box's SCREEN centre, which no amount of extraction
       * can compute — it depends on layout, scroll and the page transform.
       */
      const selBox = (e.target as HTMLElement).closest(
        `.${SEL_BOX_CLASS}`,
      ) as HTMLElement | null;

      if (!selBox) return;

      const pivot = rotationPivot(selBox, e);

      drag.pivotX = pivot.pivotX;
      drag.pivotY = pivot.pivotY;
      drag.startAngle = pivot.startAngle;
    }

    dragRef.current = drag;
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragRef.current;

      if (!drag) return;

      drag.changed = true;
      overlayRef.current?.classList.add('optionia-designlab-is-dragging');

      const { intent, layer } = drag;

      /*
       * 🔴 **Crop gestures first, because they replace the outer ones.** The
       * maths is `crop-geometry`'s — including the two different un-rotations a
       * pan and a resize need, which are identical at rot = 0 and diverge the
       * moment anything is turned.
       */
      if (intent.kind === 'crop-rotate') {
        store.setInnerRotation(
          layer,
          rotateTo(
            { x: e.clientX, y: e.clientY },
            { x: drag.pivotX!, y: drag.pivotY! },
            drag.startAngle!,
            intent.startRotationDeg,
            e.shiftKey,
          ),
        );

        return;
      }

      if (intent.kind === 'crop-move' || intent.kind === 'crop-resize') {
        const cropDx = (e.clientX - drag.startX) / drag.scale;
        const cropDy = (e.clientY - drag.startY) / drag.scale;
        const start = drag.cropStart!;

        store.setCropBox(
          layer,
          intent.kind === 'crop-move'
            ? cropMoveTo(start, { dx: cropDx, dy: cropDy }, intent.axes, layer.rot)
            : cropResizeTo(
                start,
                { dx: cropDx, dy: cropDy },
                intent.dir,
                layer.rot,
                layer.crop?.rot ?? 0,
              ),
        );

        return;
      }

      if (intent.kind === 'rotate') {
        layer.rot = rotateTo(
          { x: e.clientX, y: e.clientY },
          { x: drag.pivotX!, y: drag.pivotY! },
          drag.startAngle!,
          intent.startRotationDeg,
          e.shiftKey,
        );
        store.notify();

        return;
      }

      /* Client pixels → canvas pixels, at the scale frozen when the drag began. */
      const dx = (e.clientX - drag.startX) / drag.scale;
      const dy = (e.clientY - drag.startY) / drag.scale;

      if (intent.kind === 'move') {
        const next = moveTo(
          intent.start,
          { dx, dy },
          intent.axes,
          { w: layer.w, h: layer.h },
          { cw: store.cw, ch: store.ch },
        );

        layer.cx = next.cx;
        layer.cy = next.cy;
        store.notify();

        return;
      }

      if (intent.kind === 'resize') {
        const next = resizeFrom(
          intent.start,
          { dx, dy },
          intent.dir,
          layer.rot,
          layer.shape,
        );

        layer.cx = next.cx;
        layer.cy = next.cy;
        layer.w = next.w;
        layer.h = next.h;
        store.notify();
      }
    }

    function onUp() {
      const drag = dragRef.current;

      /*
       * 📌 **The commit/notify split closes here.** A gesture notifies on every
       * frame and commits ONCE, on release — and only if something moved, so a
       * plain click does not fill the undo stack with no-ops.
       */
      if (drag?.changed) store.commit();

      dragRef.current = null;
      overlayRef.current?.classList.remove('optionia-designlab-is-dragging');
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [store]);

  const selected = store.getSelected();
  const cropped =
    store.cropping === null
      ? null
      : (store.layers.find((l) => l.id === store.cropping) ?? null);
  const showSelection =
    cropped === null && selected && selected.kind !== 'background' && selected.visible;

  return (
    <div
      className={STAGE_CLASS}
      ref={stageRef}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      <ShapeClipDefs prefix={clipPrefix} />
      <div className="optionia-designlab-canvas-wrap" ref={wrapRef}>
        <div className="optionia-designlab-canvas-scale" ref={scaleRef}>
          <div
            className={
              'optionia-designlab-canvas' +
              (store.checker ? ' optionia-designlab-checker' : '')
            }
            style={{
              width: store.cw,
              height: store.ch,
              background: store.bg === 'transparent' ? 'transparent' : store.bg,
            }}
          >
            {store.layers.map((layer) =>
              layer.visible ? (
                <LayerElement
                  key={layer.id}
                  layer={layer}
                  cw={store.cw}
                  ch={store.ch}
                  clipPrefix={clipPrefix}
                />
              ) : null,
            )}
            {/*
              📌 **After the layers, so the text draws on top.** A text option's
              artwork is the thing being personalised; the images are what it
              sits on. The renderer orders them the same way — `buildScene`
              appends the text groups after the image groups.
            */}
            {store.text ? (
              <TextElement
                text={store.text}
                cw={store.cw}
                ch={store.ch}
                idPrefix={clipPrefix}
                store={store}
              />
            ) : null}
          </div>
          <div className="optionia-designlab-canvas-overlay" ref={overlayRef}>
            {/*
              ⚠️ **One overlay at a time.** Crop mode adjusts the image inside a
              frame; showing the layer's own selection box as well would put two
              sets of grips on screen meaning different things.
            */}
            {cropped !== null ? (
              <CropBox layer={cropped} />
            ) : showSelection ? (
              <SelectionBox layer={selected} cw={store.cw} ch={store.ch} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One layer on the canvas. Shaped frames are M26d.2 — see the file header. */
function LayerElement({
  layer,
  cw,
  ch,
  clipPrefix,
}: Readonly<{ layer: EditorLayer; cw: number; ch: number; clipPrefix: string }>) {
  if (layer.kind === 'background') {
    return (
      <div
        className={`${LAYER_CLASS} ${BG_LAYER_CLASS}`}
        data-id={layer.id}
        style={{ position: 'absolute', left: 0, top: 0, width: cw, height: ch }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={layer.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
    );
  }

  return (
    <div
      /*
       * ⚠️ **No `selected` class, deliberately.** In the source it carries one
       * declaration on a layer — `cursor: move` — which `layerCursor` now
       * computes properly, including the pinned and locked cases the blanket
       * rule got wrong. The selection is DRAWN by the overlay's box, not by a
       * class on the layer, so emitting one that styles nothing would be a
       * hook for a rule that should never be written.
       */
      className={LAYER_CLASS + (layer.locked ? ' optionia-designlab-locked' : '')}
      data-id={layer.id}
      style={{
        position: 'absolute',
        left: layer.cx - layer.w / 2,
        top: layer.cy - layer.h / 2,
        width: layer.w,
        height: layer.h,
        transform: `rotate(${layer.rot}deg)`,
        opacity: layer.opacity < 100 ? layer.opacity / 100 : undefined,
        /*
         * 🔴 The only signal that a layer cannot be dragged. `layerCursor`
         * reads the same `moveAxes` the dispatcher does, so the cursor says
         * `default` on exactly the layers that answer `select-only`.
         */
        cursor: layerCursor(layer, cw, ch),
      }}
    >
      {layer.shape === 'none' ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={layer.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
      ) : (
        <FramedImage layer={layer} clipPrefix={clipPrefix} />
      )}
    </div>
  );
}

/**
 * The image inside a frame (M26d.2).
 *
 * 🔴 **Two boxes, not one.** The outer `div` is the frame and carries the
 * clip-path; this sits inside it, positioned by `innerPlacement` in frame-local
 * pixels. A merchant moves the image within a fixed window — which is what makes
 * the output look designed rather than pasted.
 *
 * ⚠️ **The clip stays put while the image rotates.** `transform` is on the
 * `<img>`, never on the clipping element: rotating the clip would turn a circle
 * into a tilted circle, and the frame would follow the photo instead of holding
 * it.
 */
function FramedImage({
  layer,
  clipPrefix,
}: Readonly<{ layer: EditorLayer; clipPrefix: string }>) {
  const inner = innerPlacement(layer);

  return (
    <div
      className="optionia-designlab-frame-clip"
      style={{
        /*
         * 📌 **An instance-scoped id.** `clip-path: url(#…)` resolves document
         * wide to the FIRST match — and one Design Lab mounts per choice, so a
         * shared id could resolve into a closed dialog's hidden defs and clip
         * the layer to nothing. The source carries the same warning.
         */
        clipPath: `url(#${clipPrefix}-clip-${layer.shape})`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={layer.src}
        alt=""
        style={{
          position: 'absolute',
          left: inner.rect.x,
          top: inner.rect.y,
          width: inner.rect.w,
          height: inner.rect.h,
          /* The box is already the right shape; stretching it is the defect. */
          maxWidth: 'none',
          objectFit: 'fill',
          transform: inner.rot === 0 ? undefined : `rotate(${inner.rot}deg)`,
          opacity: inner.opacity < 100 ? inner.opacity / 100 : undefined,
        }}
      />
    </div>
  );
}

/**
 * One `clipPath` per shape, referenced by the framed layers above.
 *
 * ⚠️ **`objectBoundingBox` units**, so a single path serves every frame size —
 * the paths in `SHAPE_CLIP_PATHS` are written in a 0..1 box and scale to
 * whatever the frame is.
 */
/**
 * The design's text, drawn as the renderer will draw it.
 *
 * 🔴 **Every number comes from `placeText`, which delegates to the SHARED
 * geometry.** The storefront and the print renderer call the same functions, so
 * what the merchant positions here is what gets printed. Computing any of it
 * from CSS instead would produce an editor that agrees until it quietly does
 * not.
 *
 * ⚠️ **SVG for BOTH branches, not just the curve.** Flat text could be a div,
 * but then the browser's own line breaking would decide the wrap — and
 * `wrapTextLines` has already decided it. One `<tspan>` per computed line is
 * what the renderer emits, so it is what the editor emits.
 */
function TextElement({
  text,
  cw,
  ch,
  idPrefix,
  store,
}: Readonly<{
  text: EditorText;
  cw: number;
  ch: number;
  idPrefix: string;
  store: DesignStore;
}>) {
  /*
   * Measure the real glyph advance for this run and persist it.
   *
   * 🔴 **It is what makes a full circle actually close.** The generic estimate
   * overshoots narrow text, so a ring sized by it leaves a visible gap at the
   * seam. Measured after the webfont resolves, because measuring before gives
   * the fallback face's metrics — the wrong glyphs, stored as if right.
   *
   * ⚠️ **`nudgeText`, not `updateText`.** A measurement is not a merchant's
   * edit; committing one would put a history entry between their actions and
   * make undo step through changes they never made.
   *
   * 📌 **Guarded by an epsilon, or it loops**: storing re-renders, which
   * re-measures, which stores again, and float noise means it never settles.
   */
  const { text: content, font, bold, italic } = text;

  useEffect(() => {
    let cancelled = false;

    const apply = () => {
      if (cancelled) return;

      const current = store.text;

      if (!current) return;

      const ratio = measureAdvanceRatio(
        current.text,
        current.font,
        current.bold,
        current.italic,
      );

      if (advanceRatioChanged(ratio, current.advanceRatio)) {
        store.nudgeText({ advanceRatio: ratio ?? undefined });
      }
    };

    const fonts = typeof document === 'undefined' ? undefined : document.fonts;

    if (fonts?.load) {
      fonts
        .load(fontShorthand(font, bold, italic, MEASURE_PX), content || ' ')
        .then(apply, apply);
    } else {
      apply();
    }

    return () => {
      cancelled = true;
    };
  }, [content, font, bold, italic, store]);

  const placed = placeText(text, cw, ch);
  const common = {
    fontFamily: `"${text.font}", sans-serif`,
    fontWeight: text.bold ? 700 : 400,
    fontStyle: text.italic ? 'italic' : 'normal',
    fill: text.color,
  } as const;

  if (placed.kind === 'curved') {
    const pathId = `${idPrefix}-textpath`;
    const { startOffset, anchor } = arcTextAnchor(placed.align);

    return (
      <svg
        className="optionia-designlab-text"
        width={cw}
        height={ch}
        viewBox={`0 0 ${cw} ${ch}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {/*
            🔴 **The path is in ARC-LOCAL coordinates**, which is why the group
            translates it into place rather than the path carrying the offset.
            The renderer does exactly this, and the rotation origin is expressed
            in CANVAS coordinates — so the rotate must sit OUTSIDE the
            translate, as it does here.
          */}
          <path id={pathId} d={placed.d} fill="none" />
        </defs>
        <g
          transform={
            (text.rot ? `rotate(${text.rot} ${placed.originX} ${placed.originY}) ` : '') +
            `translate(${placed.left} ${placed.top})`
          }
        >
          <text
            {...common}
            fontSize={placed.fontSize}
            letterSpacing={placed.letterSpacing || undefined}
          >
            <textPath href={`#${pathId}`} startOffset={startOffset} textAnchor={anchor}>
              {text.text}
            </textPath>
          </text>
        </g>
      </svg>
    );
  }

  const { anchor } = textAnchorFor(placed.align);

  return (
    <svg
      className="optionia-designlab-text"
      width={cw}
      height={ch}
      viewBox={`0 0 ${cw} ${ch}`}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={text.rot ? `rotate(${text.rot} ${text.cx} ${text.cy})` : undefined}>
        <text
          {...common}
          y={placed.firstY}
          fontSize={placed.fontSize}
          letterSpacing={placed.letterSpacing || undefined}
          textAnchor={anchor}
          dominantBaseline="central"
        >
          {placed.lines.map((line, i) => (
            <tspan
              /*
               * ⚠️ **Indexed key, deliberately.** These are wrapped fragments of
               * one string, not entities — two identical lines are a normal
               * outcome of wrapping, so the text itself is not a key.
               */
              key={i}
              x={placed.anchorX}
              dy={i === 0 ? undefined : placed.lineHeight}
            >
              {/* An empty tspan collapses; a space keeps the line's height. */}
              {line || ' '}
            </tspan>
          ))}
        </text>
      </g>
    </svg>
  );
}

function ShapeClipDefs({ prefix }: Readonly<{ prefix: string }>) {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        {(Object.keys(SHAPE_CLIP_PATHS) as PathShape[]).map((shape) => (
          <clipPath key={shape} id={`${prefix}-clip-${shape}`} clipPathUnits="objectBoundingBox">
            <path d={SHAPE_CLIP_PATHS[shape]} />
          </clipPath>
        ))}
      </defs>
    </svg>
  );
}

/**
 * The dashed box around the IMAGE while crop mode is open (M26d.2).
 *
 * 🔴 **Two nested transforms, and the order is the whole thing.** The outer
 * wrapper sits on the frame and carries the FRAME's rotation; the box inside
 * carries the image's own. That composition is why the drag maths un-rotates by
 * the frame for a pan and by frame + inner for a resize — the grips live on the
 * inner box, which has been turned twice.
 *
 * ⚠️ **Grips only on a `free` inner image.** Every other inner style derives
 * its box from the frame on each re-fit, so a resize handle would be overwritten
 * — the same rule `showsHandles` applies one level up.
 */
function CropBox({ layer }: Readonly<{ layer: EditorLayer }>) {
  const inner = innerPlacement(layer);
  const withGrips = !layer.locked && (layer.crop?.style ?? 'cover') === 'free';

  return (
    <div
      className="optionia-designlab-crop-wrap"
      style={{
        position: 'absolute',
        left: layer.cx - layer.w / 2,
        top: layer.cy - layer.h / 2,
        width: layer.w,
        height: layer.h,
        transform: `rotate(${layer.rot}deg)`,
      }}
    >
      <div
        className={`${SEL_BOX_CLASS} ${CROP_BOX_CLASS}`}
        data-id={layer.id}
        style={{
          position: 'absolute',
          left: inner.rect.x,
          top: inner.rect.y,
          width: inner.rect.w,
          height: inner.rect.h,
          transform: inner.rot === 0 ? undefined : `rotate(${inner.rot}deg)`,
        }}
      >
        {/*
          📌 **Corners only.** The inner image is aspect-locked — stretching it
          is what a frame exists to avoid — so an edge handle would have no
          one-axis resize to offer.
        */}
        {withGrips &&
          (['nw', 'ne', 'se', 'sw'] as const).map((dir) => (
            <div className={HANDLE_CLASS} data-h={dir} key={dir} />
          ))}
        {withGrips && <div className="optionia-designlab-rotate-stem" />}
        {withGrips && (
          <div className={ROTATE_CLASS} data-h="rotate" title="Drag to rotate the image" />
        )}
      </div>
    </div>
  );
}

/** The dashed box and its grips, sized by {@link drawnSelectionRect}. */
function SelectionBox({
  layer,
  cw,
  ch,
}: Readonly<{ layer: EditorLayer; cw: number; ch: number }>) {
  const rect = drawnSelectionRect(layer, cw, ch);
  const withHandles = showsHandles(layer);

  return (
    <div
      className={SEL_BOX_CLASS}
      data-id={layer.id}
      style={{
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.w,
        height: rect.h,
        transform: `rotate(${layer.rot}deg)`,
      }}
    >
      {withHandles &&
        handlesFor(layer).map((dir) => (
          <div className={HANDLE_CLASS} data-h={dir} key={dir} />
        ))}
      {withHandles && <div className="optionia-designlab-rotate-stem" />}
      {withHandles && (
        <div className={ROTATE_CLASS} data-h="rotate" title="Drag to rotate" />
      )}
    </div>
  );
}
