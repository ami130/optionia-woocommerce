/**
 * The scene: a stored design resolved into resolution-independent nodes, and
 * those nodes serialised to SVG.
 *
 * Ported from `optionia-app/app/components/design-lab/designScene.ts` (M26c.1),
 * completing the port at 27 of 27 symbols. This is the module every other piece
 * of geometry in this directory exists to serve — `layer-geometry` resolves each
 * image, `text-geometry` measures and fits flat text, `arc-geometry` builds the
 * ring for curved text, and `buildScene` is what calls all three.
 *
 * 🔴 **One renderer, two emitters, four surfaces.** `sceneToSvgString` takes a
 * pluggable {@link SceneTextRenderer} so the editor, the storefront preview and
 * the order renderer all walk the SAME scene — they differ only in how a text
 * node becomes ink. That is the mechanism that keeps a customer's proof and
 * their printed object identical, and it is why re-deriving any of this
 * per-surface is the failure this port exists to prevent.
 */

import {
  SHAPE_CLIP_PATHS,
  effectiveShape,
  frameClipId,
  frameImageRect,
  layerRect,
} from './layer-geometry';
import {
  LINE_HEIGHT,
  type SceneText,
  fitTextToBox,
  flatBlockFirstY,
  resolveSceneText,
  textAnchorFor,
  wrapTextLines,
} from './text-geometry';
import {
  arcTextAnchor,
  curveBoxPlace,
  curveRotOrigin,
  textArcPath,
} from './arc-geometry';
import type {
  DesignLayer,
  LayerShape,
  TextDesign,
} from './design-geometry.types';

/** A single resolved image node in viewBox (background-pixel) coordinates. */
export interface SceneImage {
  readonly href: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Rotation centre. */
  readonly cx: number;
  readonly cy: number;
  /** Degrees. */
  readonly rot: number;
  /** Opacity 0..1 — for shaped images this is layer × inner (crop) opacity. */
  readonly opacity: number;
  readonly shape: LayerShape;
  /**
   * Custom PNG mask URL — set only when `shape === 'image'`. Renderers use an
   * SVG alpha `<mask>` (stretched to the frame) instead of a clipPath.
   */
  readonly shapeHref?: string;
  /**
   * The image's own rotation INSIDE the frame (deg, about the image centre; the
   * clip does not rotate with it). Always 0 for plain (`none`) layers.
   */
  readonly innerRot: number;
  /**
   * Present only when framed (`shape !== 'none'`): the clip frame. Square frames
   * may be rectangular; the others keep `w === h`. The image sits inside it per
   * `crop.style`, clipped to `shape`.
   */
  readonly frame?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/** One choice's layer set (plus any text nodes), with whether it is shown. */
export interface SceneGroup {
  readonly key: string;
  readonly visible: boolean;
  readonly images: readonly SceneImage[];
  readonly texts: readonly SceneText[];
}

export interface DesignScene {
  readonly width: number;
  readonly height: number;
  readonly backgroundHref?: string;
  readonly groups: readonly SceneGroup[];
}

/** Input group: a choice's raw layers plus its current visibility. */
export interface DesignGroupInput {
  readonly key: string;
  readonly layers: readonly DesignLayer[];
  readonly visible: boolean;
}

/**
 * Input for a TEXT option's design.
 *
 * ⚠️ Unlike image groups — which are per choice and toggled by selection — a
 * text option is ALWAYS visible, and its `value` (what the customer typed)
 * replaces the merchant's sample text live.
 */
export interface DesignTextInput {
  /** Stable key = the option id, so the storefront can live-update its text. */
  readonly key: string;
  readonly design: TextDesign;
  /** Customer-typed value; falls back to `design.text` (the merchant sample). */
  readonly value?: string;
}

/**
 * Resolve a stored design into a scene of viewBox-pixel nodes.
 *
 * 📌 **Text options become always-visible groups** keyed by option id and
 * appended after the image choice groups, so both render through one pipeline
 * rather than two.
 */
export function buildScene(input: {
  width: number;
  height: number;
  backgroundHref?: string;
  groups: readonly DesignGroupInput[];
  /** TEXT options — always visible; each resolves to one text node. */
  textOptions?: readonly DesignTextInput[];
}): DesignScene {
  const width = input.width || 1;
  const height = input.height || 1;
  const textGroups: SceneGroup[] = (input.textOptions ?? []).map((t) => ({
    key: t.key,
    visible: true,
    images: [],
    texts: [resolveSceneText(t.design, width, height, t.value)],
  }));
  return {
    width,
    height,
    backgroundHref: input.backgroundHref,
    groups: [
      ...(input.groups ?? []).map((g) => ({
        key: g.key,
        visible: g.visible,
        texts: [] as readonly SceneText[],
        images: g.layers
          .filter((l) => l.visible)
          .map((l): SceneImage => {
            const r = layerRect(l, width, height); // frame box when framed
            const shape = effectiveShape(l);
            if (shape === 'none') {
              return {
                href: l.src,
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
                cx: r.cx,
                cy: r.cy,
                rot: r.rot,
                opacity: (l.opacity ?? 100) / 100,
                shape,
                innerRot: 0,
              };
            }
            // Framed: `r` is the frame; the image fits inside it per crop.style.
            // ⚠️ Inner rotation and opacity mirror the outer rules one level
            // down: only a free inner style renders rotation, and opacities
            // multiply rather than override.
            const c = l.crop && Number.isFinite(l.crop.wPct) ? l.crop : undefined;
            const innerStyle = c ? (c.style ?? 'free') : 'cover';
            const ir = frameImageRect(l, r.x, r.y, r.w, r.h);
            return {
              href: l.src,
              x: ir.x,
              y: ir.y,
              w: ir.w,
              h: ir.h,
              cx: r.cx,
              cy: r.cy,
              rot: r.rot,
              opacity: ((l.opacity ?? 100) / 100) * ((c?.opacity ?? 100) / 100),
              shape,
              shapeHref: shape === 'image' ? (l.shapeSrc ?? undefined) : undefined,
              innerRot: innerStyle === 'free' ? (c?.rot ?? 0) : 0,
              frame: { x: r.x, y: r.y, w: r.w, h: r.h },
            };
          }),
      })),
      ...textGroups,
    ],
  };
}

/** XML-escape an attribute value. */
function escAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Serialize ONE resolved text node to its `<g data-design-text="1">…</g>` markup
 * — flat `<text>`/`<tspan>` (wrapped) or curved `<textPath>` on an arc.
 *
 * 📌 **Extracted so both the server and the storefront runtime go through the
 * identical code path.** `sceneToSvgString` calls it for every text node; the
 * storefront calls it again for a single node as the customer types. One code
 * path is what guarantees the preview matches the print file.
 *
 * `sceneW`/`sceneH` are the viewBox dimensions, used to clamp a curved node's
 * bbox on-canvas; `idPrefix` plus `gi`/`ti` make the arc path id unique.
 */
export function serializeTextNode(
  tx: SceneText,
  idPrefix: string,
  gi: number,
  ti: number,
  sceneW: number,
  sceneH: number,
): string {
  const fam = `&quot;${escAttr(tx.font)}&quot;, sans-serif`;
  const weight = tx.bold ? 'bold' : 'normal';
  const style = tx.italic ? 'italic' : 'normal';
  const attrs = (fontSize: number, letterSpacing: number) =>
    `font-family="${fam}" font-size="${fontSize}" font-weight="${weight}" font-style="${style}" fill="${escAttr(tx.color)}"` +
    (letterSpacing ? ` letter-spacing="${letterSpacing}"` : '');

  if (tx.curve !== 0) {
    // Curved: the ring's radius comes from the curve + the box, and the font
    // keeps its merchant size until the run outgrows the ring. The bbox is
    // CENTRED horizontally (the ring already spans the box); VERTICAL alignment
    // places it in the box, HORIZONTAL alignment picks where the run starts.
    const { d, width, height, fontSize, letterSpacing } = textArcPath(
      tx.text,
      tx.fontSize,
      tx.letterSpacing,
      tx.curve,
      tx.w,
      tx.h,
      tx.advanceRatio,
    );
    const { startOffset, anchor } = arcTextAnchor(tx.align);
    const { left, top } = curveBoxPlace(tx, width, height, sceneW, sceneH);
    const pathId = `${idPrefix}-txp-${gi}-${ti}`;
    // Pivot on whatever the EDITOR spins: the box centre for a real fixed box,
    // the arc bbox for a legacy auto-height one (see curveRotOrigin).
    const { ox, oy } = curveRotOrigin(tx, left, top, width, height);
    const rot = tx.rot ? `rotate(${tx.rot} ${ox} ${oy}) ` : '';
    return (
      `<g data-design-text="1" transform="${rot}translate(${left} ${top})">` +
      `<defs><path id="${pathId}" d="${d}" fill="none"/></defs>` +
      `<text ${attrs(fontSize, letterSpacing)}><textPath href="#${pathId}" xlink:href="#${pathId}" startOffset="${startOffset}" text-anchor="${anchor}">${escAttr(tx.text)}</textPath></text>` +
      `</g>`
    );
  }

  // Fixed-height box (tx.h > 0): shrink the font (shrink-only) so the wrapped
  // lines fit inside tx.h. Legacy tx.h === 0 keeps the merchant's size and auto
  // height. The same fit runs in the editor and storefront, so breaks match.
  const flat =
    tx.h > 0
      ? fitTextToBox(
          tx.text,
          tx.fontSize,
          tx.letterSpacing,
          tx.w,
          tx.h,
          tx.advanceRatio,
        )
      : { fontSize: tx.fontSize, letterSpacing: tx.letterSpacing };
  const common = attrs(flat.fontSize, flat.letterSpacing);
  const { anchor } = textAnchorFor(tx.align);
  const ax =
    tx.align === 'left'
      ? tx.cx - tx.w / 2
      : tx.align === 'right'
        ? tx.cx + tx.w / 2
        : tx.cx;
  const rot = tx.rot ? ` transform="rotate(${tx.rot} ${tx.cx} ${tx.cy})"` : '';
  const lines = wrapTextLines(
    tx.text,
    flat.fontSize,
    flat.letterSpacing,
    tx.w,
    tx.advanceRatio,
  );
  // 🔴 **`LINE_HEIGHT`, not a bare `1.25`.** The source writes the literal here
  // and again inside `fitTextToBox`, which is what decides how many lines fit
  // and therefore what size to shrink to. If the two ever diverged, text would
  // be MEASURED at one line height and DRAWN at another — fitting in the editor
  // and overflowing the print file.
  const lineH = flat.fontSize * LINE_HEIGHT;
  const firstY = flatBlockFirstY(tx.valign, tx.cy, tx.h, lines.length, lineH);
  const tspans = lines
    .map(
      (ln, i) =>
        `<tspan x="${ax}"${i === 0 ? '' : ` dy="${lineH}"`}>${escAttr(ln) || ' '}</tspan>`,
    )
    .join('');
  return (
    `<g data-design-text="1"${rot}>` +
    `<text y="${firstY}" ${common} text-anchor="${anchor}" dominant-baseline="central">${tspans}</text>` +
    `</g>`
  );
}

/**
 * Pluggable per-text-node emitter for {@link sceneToSvgString}.
 *
 * 📌 The default is {@link serializeTextNode} (`<text>`/`<textPath>` markup, for
 * browsers). A renderer without `<textPath>` support swaps in a glyph-outline
 * emitter — same scene, different final ink.
 */
export type SceneTextRenderer = (
  tx: SceneText,
  idPrefix: string,
  gi: number,
  ti: number,
  sceneW: number,
  sceneH: number,
) => string;

/**
 * Serialize a scene to SVG markup — for the storefront and for order capture.
 *
 * Each group carries `data-design-group="<key>"` so the storefront can toggle
 * its visibility on selection, and each text node `data-design-text` so it can
 * live-swap the content on input.
 *
 * ⚠️ **Ids are prefixed and index-qualified** so multiple scenes on one page
 * never cross-reference each other's clip paths or masks.
 */
export function sceneToSvgString(
  scene: DesignScene,
  idPrefix = 'dl',
  renderText: SceneTextRenderer = serializeTextNode,
): string {
  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${scene.width} ${scene.height}" preserveAspectRatio="xMidYMid slice" ` +
      `xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `style="display:block;width:100%;height:100%">`,
  );

  // Per-instance userSpaceOnUse clipPath for every shaped image: the shape path
  // scaled to that image's frame rect.
  // ⚠️ Custom PNG shapes use an alpha <mask> (the PNG stretched to the frame;
  // opaque = visible) instead of a clipPath, and `mask-type` is set as BOTH
  // attribute and style so every renderer reads alpha rather than luminance.
  const defs: string[] = [];
  scene.groups.forEach((g, gi) =>
    g.images.forEach((im, ii) => {
      if (!im.frame || im.shape === 'none') return;
      const id = frameClipId(idPrefix, gi, ii);
      if (im.shape === 'image') {
        if (!im.shapeHref) return;
        defs.push(
          `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="alpha" style="mask-type:alpha">` +
            `<image href="${escAttr(im.shapeHref)}" x="${im.frame.x}" y="${im.frame.y}" ` +
            `width="${im.frame.w}" height="${im.frame.h}" preserveAspectRatio="none"/></mask>`,
        );
      } else {
        defs.push(
          `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${SHAPE_CLIP_PATHS[im.shape]}" ` +
            `transform="translate(${im.frame.x} ${im.frame.y}) scale(${im.frame.w} ${im.frame.h})"/></clipPath>`,
        );
      }
    }),
  );
  if (defs.length) parts.push(`<defs>${defs.join('')}</defs>`);

  if (scene.backgroundHref) {
    // `data-design-bg` lets the storefront drop this node in overlay mode, where
    // the theme's real product image shows through underneath.
    parts.push(
      `<image data-design-bg="1" href="${escAttr(scene.backgroundHref)}" x="0" y="0" width="${scene.width}" height="${scene.height}" preserveAspectRatio="xMidYMid slice"/>`,
    );
  }

  scene.groups.forEach((g, gi) => {
    parts.push(
      `<g data-design-group="${escAttr(g.key)}" style="display:${g.visible ? 'block' : 'none'}">`,
    );
    g.images.forEach((im, ii) => {
      const o = im.opacity < 1 ? ` opacity="${im.opacity}"` : '';
      if (im.frame && im.shape !== 'none') {
        // The clip/mask lives on a <g> pinned to the frame; the image may rotate
        // INSIDE it (innerRot, about its own centre) without turning the mask.
        // The frame's own rotation wraps everything.
        const it = im.innerRot
          ? ` transform="rotate(${im.innerRot} ${im.x + im.w / 2} ${im.y + im.h / 2})"`
          : '';
        const img =
          `<image href="${escAttr(im.href)}" x="${im.x}" y="${im.y}" width="${im.w}" height="${im.h}" ` +
          `preserveAspectRatio="none"${o}${it}/>`;
        const id = frameClipId(idPrefix, gi, ii);
        // PNG-mask frames reference their alpha <mask>; path shapes their clipPath.
        const ref =
          im.shape === 'image'
            ? im.shapeHref
              ? `mask="url(#${id})"`
              : ''
            : `clip-path="url(#${id})"`;
        const clipped = ref ? `<g ${ref}>${img}</g>` : img;
        parts.push(
          im.rot
            ? `<g transform="rotate(${im.rot} ${im.cx} ${im.cy})">${clipped}</g>`
            : clipped,
        );
      } else {
        const t = im.rot
          ? ` transform="rotate(${im.rot} ${im.cx} ${im.cy})"`
          : '';
        parts.push(
          `<image href="${escAttr(im.href)}" x="${im.x}" y="${im.y}" width="${im.w}" height="${im.h}" ` +
            `preserveAspectRatio="none"${o}${t}/>`,
        );
      }
    });
    g.texts.forEach((tx, ti) => {
      parts.push(renderText(tx, idPrefix, gi, ti, scene.width, scene.height));
    });
    parts.push(`</g>`);
  });

  parts.push(`</svg>`);
  return parts.join('');
}
