'use client';

import { useEffect, useMemo, useState } from 'react';

import { buildScene, sceneToSvgString } from '@shared/design/design-scene';
import type { Product } from '@/lib/products/api';
import {
  designGroups,
  designTexts,
  hasAnythingToDraw,
  previewBackdrop,
  type DesignBearingOption,
} from '@/lib/preview/preview-scene';

/**
 * The saved design, drawn by the SHARED scene module (M26d.6).
 *
 * 🔴 **"Rendered through the M26c.1 scene module — never a second renderer."**
 * That is the milestone's own wording. Every number on screen comes from
 * `buildScene` and `sceneToSvgString` — the same functions the storefront and
 * the print pipeline call — so what a merchant approves here is what gets
 * printed. A component that laid artwork out itself would agree only by
 * accident, which is the defect this milestone exists to prevent.
 *
 * ⚠️ **This is the scene module's FIRST production caller.** It was built and
 * tested in M26c.1 and wired to nothing: `shared/design` sits outside the
 * symbol gate's watch path, and `check-shared-design` asserts the tree is
 * framework-free rather than reached. Four milestones of geometry had never
 * drawn a pixel in this repository until here.
 */

/** The natural size of the backdrop, once the browser has measured it. */
interface Measured {
  width: number;
  height: number;
}

export function DesignPreview({
  options,
  answers,
  product,
}: Readonly<{
  options: readonly DesignBearingOption[];
  answers: Readonly<Record<string, unknown>>;
  product: Product | null;
}>) {
  /*
   * 🔴 **The photo is MEASURED, not assumed.** Decision 5 letterboxes a design
   * into a box of its own aspect, and the aspect comes from the product's
   * natural size — the Design Lab measures it the same way, for the same
   * reason. Guessing would stretch artwork the merchant drew square.
   */
  const [loaded, setLoaded] = useState<(Measured & { src: string }) | null>(null);
  const imageUrl = product?.imageUrl ?? null;

  /*
   * 🔴 **The measurement is DERIVED against the current url, not synced to
   * it.** Clearing it with `setMeasured(null)` the moment the photo changed
   * meant a setState in the effect body — a cascading render, and the lint rule
   * that names it is right: the stale size is already knowable from the state
   * itself, so it never needs to be written away.
   */
  const measured: Measured | null = loaded && loaded.src === imageUrl ? loaded : null;

  useEffect(() => {
    if (imageUrl === null) return;

    let cancelled = false;
    const img = new Image();

    /*
     * ⚠️ **A photo that will not load must not block the preview.** The design
     * still renders, against no backdrop — the documented behaviour for a
     * design with no recorded aspect.
     */
    img.onload = () => {
      if (!cancelled) {
        setLoaded({ src: imageUrl, width: img.naturalWidth, height: img.naturalHeight });
      }
    };
    /*
     * ⚠️ **A photo that will not load leaves `measured` null**, which the
     * derivation already gives us — there is nothing to write.
     */
    img.onerror = () => {};
    img.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const markup = useMemo(() => {
    const groups = designGroups(options, answers);
    const texts = designTexts(options, answers);

    if (!hasAnythingToDraw(groups, texts)) return null;

    const backdrop = previewBackdrop(product, measured);

    /*
     * 📌 **The scene's own pixel size is the AUTHORING aspect when there is
     * one.** The SVG scales to its container either way — `sceneToSvgString`
     * emits `width:100%;height:100%` — so these are viewBox units, not layout.
     */
    const width = backdrop?.canvas.width ?? 1000;
    const height = backdrop?.canvas.height ?? 1000;

    const scene = buildScene({
      width,
      height,
      backgroundHref: backdrop?.image.src,
      groups,
      textOptions: texts,
      authoring: backdrop?.canvas ?? null,
    });

    return sceneToSvgString(scene, 'dl-preview');
  }, [options, answers, product, measured]);

  if (markup === null) return null;

  /*
   * ⚠️ **The box takes the AUTHORING aspect**, so the preview is not a
   * differently-shaped window onto the same design. Square until a photo is
   * measured, which is what the scene falls back to as well.
   */
  const aspect = measured ? `${measured.width} / ${measured.height}` : '1 / 1';

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">
        Design preview — what the storefront will render.
      </p>
      {/*
        🔴 **`dangerouslySetInnerHTML`, because the renderer returns a STRING**,
        and that is the whole point: one serializer for the dashboard, the
        storefront and the print file. Rebuilding this as JSX would be the
        second renderer the milestone forbids.

        ⚠️ **Every URL inside it was re-checked against `checkLayerSource`**
        before it reached the scene — see `previewableSource`. The API stores a
        design body unvalidated by design, so a row written by any other path
        can carry a `javascript:` href that `escAttr` would escape perfectly and
        still hand to the browser.
      */}
      {/*
        📌 **A bounded box with a neutral ground.** `sceneToSvgString` emits
        `width:100%;height:100%`, so the SVG fills whatever it is given — left
        unbounded it would collapse to nothing in a flex column.
      */}
      <div
        className="bg-muted overflow-hidden rounded-md border"
        style={{ aspectRatio: aspect }}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  );
}
