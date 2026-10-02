import type {
  AuthoringCanvas,
  DesignImage,
  DesignLayer,
  TextDesign,
} from '@shared/design/design-geometry.types';
import { authoringCanvasOf } from '@shared/design/design-geometry.types';
import type { DesignGroupInput, DesignTextInput } from '@shared/design/design-scene';

import { checkLayerSource } from '@/lib/design-lab/layer-source';

/**
 * Turning authoring data into what the SHARED scene module renders (M26d.6).
 *
 * 🔴 **"The saved design rendered through the M26c.1 scene module — never a
 * second renderer."** That is the milestone's own wording, and this module
 * exists to obey it: it decides WHAT to render and hands the decision to
 * `buildScene`. Nothing here computes geometry — the moment it did, the
 * dashboard would have a renderer of its own and could agree with the
 * storefront only by accident.
 *
 * ⚠️ **The scene module had no production caller before this.** `buildScene`
 * and `sceneToSvgString` were built, tested and wired to nothing since M26c.1 —
 * invisible because `shared/design` sits outside the symbol gate's watch path
 * and `check-shared-design` asserts structure rather than reachability.
 */

/**
 * What this module needs of an option, structurally.
 *
 * 📌 **Structural, so `preview-tree`'s own `PreviewOption` satisfies it without
 * a conversion.** Declaring a second concrete type would have given the preview
 * two vocabularies for one thing — and this one is narrower on purpose: it
 * names only the fields the scene reads, so a change to the authoring shape
 * that does not touch artwork cannot break the renderer.
 */
export interface DesignBearingOption {
  readonly id: string;
  /** A text option's artwork, stored opaquely by the API. */
  readonly textDesign?: Record<string, unknown> | null;
  readonly values: readonly DesignBearingValue[];
}

export interface DesignBearingValue {
  readonly id: string;
  readonly valueKey: string;
  /** A choice's artwork, stored opaquely by the API. */
  readonly design?: Record<string, unknown> | null;
}

/**
 * Whether a stored URL may be put into the preview's markup.
 *
 * 🔴 **The preview is the FIRST surface to read a stored design back and inject
 * it, so it is the first that must re-check.** `checkLayerSource` guards what
 * the editor accepts; the API stores the design body unvalidated by design
 * (`option.dto.ts` says so), so a row written by any other path — an import, a
 * direct write, a design authored before a rule existed — can carry anything.
 *
 * ⚠️ **`escAttr` is not a substitute.** It escapes `&"<>` so the attribute
 * cannot be broken out of, which does nothing about a `javascript:` href that
 * is perfectly well-formed. This is the same shape as the gap `backgroundFor`
 * had: one rule, stated once, repeated at every surface that needs it.
 *
 * 📌 **SVG stays refused**, as M26d.5 requires — `checkLayerSource` carries
 * that rule and this reuses it rather than restating it.
 */
export function previewableSource(url: unknown): url is string {
  return typeof url === 'string' && checkLayerSource(url).ok;
}

/**
 * One stored layer, kept only if everything it points at is safe to render.
 *
 * ⚠️ **A bad layer is DROPPED, not the whole design.** A merchant with one
 * unreachable image should still see the rest of their artwork; refusing the
 * design outright would turn a cosmetic problem into a blank preview with no
 * explanation.
 */
export function previewableLayer(raw: unknown): DesignLayer | null {
  if (raw === null || typeof raw !== 'object') return null;

  const layer = raw as Partial<DesignLayer>;

  if (!previewableSource(layer.src)) return null;

  /* A custom PNG mask is a second URL, and needs the same check. */
  if (layer.shape === 'image' && !previewableSource(layer.shapeSrc)) return null;

  return layer as DesignLayer;
}

/** The layers of one stored design, filtered. */
export function previewableLayers(design: unknown): DesignLayer[] {
  if (design === null || typeof design !== 'object') return [];

  const layers = (design as { layers?: unknown }).layers;

  if (!Array.isArray(layers)) return [];

  return layers
    .map((layer) => previewableLayer(layer))
    .filter((layer): layer is DesignLayer => layer !== null);
}

/**
 * The image groups a preview renders, one per value that carries a design.
 *
 * 🔴 **Visibility follows the customer's ANSWER**, which is what makes this a
 * preview rather than a gallery: a swatch's artwork appears when that swatch is
 * chosen, exactly as the storefront shows it. `buildScene` takes `visible` per
 * group and the scene carries every group either way, so toggling a choice does
 * not rebuild the scene.
 */
export function designGroups(
  options: readonly DesignBearingOption[],
  answers: Readonly<Record<string, unknown>>,
): DesignGroupInput[] {
  const groups: DesignGroupInput[] = [];

  for (const option of options) {
    const answer = answers[option.id];

    for (const value of option.values) {
      const layers = previewableLayers(value.design);

      if (layers.length === 0) continue;

      groups.push({
        key: value.id,
        layers,
        /*
         * ⚠️ **A multi-select answer is an ARRAY**, and a checkbox group is the
         * case that makes this more than an equality test.
         */
        visible: Array.isArray(answer)
          ? answer.includes(value.valueKey)
          : answer === value.valueKey,
      });
    }
  }

  return groups;
}

/**
 * The text nodes a preview renders, one per text option that carries a design.
 *
 * 📌 **Always visible, and the customer's typing replaces the sample live** —
 * `buildScene` documents both. The merchant's wording is what shows until a
 * customer types, which is exactly what the Design Lab calls a sample.
 */
export function designTexts(
  options: readonly DesignBearingOption[],
  answers: Readonly<Record<string, unknown>>,
): DesignTextInput[] {
  const texts: DesignTextInput[] = [];

  for (const option of options) {
    if (option.textDesign === null || option.textDesign === undefined) continue;

    const answer = answers[option.id];

    texts.push({
      key: option.id,
      design: option.textDesign as unknown as TextDesign,
      /*
       * ⚠️ **Only a non-empty string replaces the sample.** An empty box is a
       * customer who has not typed yet, and `resolveSceneText` would render it
       * as nothing at all — so the merchant's artwork would vanish the instant
       * the field was focused and cleared.
       */
      ...(typeof answer === 'string' && answer !== '' ? { value: answer } : {}),
    });
  }

  return texts;
}

/**
 * The backdrop a design is composed over, and the canvas it implies.
 *
 * 🔴 **The authoring canvas comes from the PHOTO, not the preview's box.**
 * Decision 5 letterboxes the design into a box of its own aspect; handing
 * `buildScene` the wrong aspect would stretch artwork that the Design Lab drew
 * square. `authoringCanvasOf` is the shared derivation, so both surfaces agree.
 *
 * ⚠️ **Null when the photo cannot be previewed**, which keeps the scene honest:
 * no background node, and a letterbox that is the full target — the documented
 * behaviour for a design with no recorded aspect.
 */
export function previewBackdrop(
  product: { imageUrl?: string | null; name?: string | null } | null | undefined,
  natural: { width: number; height: number } | null,
): { image: DesignImage; canvas: AuthoringCanvas } | null {
  if (!product || !previewableSource(product.imageUrl)) return null;
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return null;

  const image: DesignImage = {
    src: product.imageUrl,
    name: product.name ?? 'Product',
    natW: natural.width,
    natH: natural.height,
  };

  return { image, canvas: authoringCanvasOf(image) };
}

/**
 * Whether there is anything to draw at all.
 *
 * 📌 **An empty scene is not an error**, and the caller shows nothing rather
 * than an empty frame — most option sets carry no artwork.
 */
export function hasAnythingToDraw(
  groups: readonly DesignGroupInput[],
  texts: readonly DesignTextInput[],
): boolean {
  return groups.length > 0 || texts.length > 0;
}
