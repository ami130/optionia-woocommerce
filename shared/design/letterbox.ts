import type { AuthoringCanvas } from './design-geometry.types';

/**
 * Fitting a design onto a product whose photo is a different shape (M26c.3).
 *
 * ## The defect this exists to prevent
 *
 * 🔴 **Every stored coordinate is a fraction of the canvas**, so a design
 * composed on a square mug photo and assigned to a tall bottle photo reflows:
 * text that fitted the mug stretches down the bottle. `optionia-app` has exactly
 * this behaviour — `buildScene` takes whatever dimensions the caller supplies
 * and nothing records what the merchant composed against.
 *
 * ⚠️ **The merchant does not find out until a physical object is wrong.** A
 * preview shows the design on whichever product is open; the print file is
 * produced from whichever product was ordered. A band of unused photo is a
 * visible, correctable compromise. A stretched engraving is a reprint.
 *
 * ## What this does
 *
 * Decision 5: the design records the aspect it was authored at, and renders
 * inside the largest centred box of that aspect that fits the target. The rest
 * of the product photo is left alone.
 *
 * 📌 **Nothing here is stored.** The letterbox is derived at render time from
 * the authoring canvas and the target, so one design serves every product it is
 * assigned to without a per-product row.
 */

/** Where a design sits within a target canvas, in target units. */
export interface Letterbox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The largest centred box of the authoring aspect that fits the target.
 *
 * 🔴 **Compared as a ratio of ratios, never by comparing edges.** A 1000×1000
 * design on a 2000×2000 product has the same aspect and must fill it exactly —
 * an edge comparison would letterbox it for being smaller, which is the bug this
 * function exists to avoid rather than introduce.
 *
 * ⚠️ **A non-finite or non-positive dimension yields the full target rather
 * than a division by zero.** A design whose authoring canvas was never recorded
 * — every design predating M26c.3 — must still render, and rendering it edge to
 * edge is what it already did. Refusing would take away a merchant's existing
 * artwork to protect them from a reflow they have already accepted.
 */
export function letterboxFor(
  authoring: AuthoringCanvas | null | undefined,
  targetWidth: number,
  targetHeight: number,
): Letterbox {
  const full: Letterbox = { x: 0, y: 0, width: targetWidth, height: targetHeight };

  if (!isPositiveFinite(targetWidth) || !isPositiveFinite(targetHeight)) {
    return full;
  }

  if (
    !authoring ||
    !isPositiveFinite(authoring.width) ||
    !isPositiveFinite(authoring.height)
  ) {
    /* No recorded aspect: the legacy behaviour, which is to fill the target. */
    return full;
  }

  const authoredAspect = authoring.width / authoring.height;
  const targetAspect = targetWidth / targetHeight;

  /*
   * 📌 **Defensive, not load-bearing — and that is measured rather than
   * assumed.** The claim here was originally that floating-point division of
   * equal ratios can leave a sub-pixel inset. A mutation removing this branch
   * survived, and probing for a case that bites found none: when the aspects
   * genuinely match, `targetWidth / aspect` already returns the target height
   * exactly, at every scale tried.
   *
   * ⚠️ **It stays because the cost is one comparison and the failure it guards
   * is invisible.** A seam of a third of a pixel down one edge of every design
   * would be reported as "the preview looks slightly off" and never traced.
   * ✏️ **The 1366×768 case that looked like proof is not 16:9** — 1.7786
   * against 1.7778 — so letterboxing it is correct behaviour rather than the
   * defect it appeared to be.
   */
  if (Math.abs(authoredAspect - targetAspect) < 1e-9) {
    return full;
  }

  if (authoredAspect > targetAspect) {
    /* Wider than the target: full width, bars above and below. */
    const height = targetWidth / authoredAspect;

    return { x: 0, y: (targetHeight - height) / 2, width: targetWidth, height };
  }

  /* Taller than the target: full height, bars left and right. */
  const width = targetHeight * authoredAspect;

  return { x: (targetWidth - width) / 2, y: 0, width, height: targetHeight };
}

/**
 * Whether a design will be letterboxed onto this target.
 *
 * 📌 **The editor needs to say so before a merchant saves.** Telling them their
 * artwork will sit inside a band is a supported limitation; letting them find
 * out from a customer's order is a defect wearing the same clothes.
 */
export function willLetterbox(
  authoring: AuthoringCanvas | null | undefined,
  targetWidth: number,
  targetHeight: number,
): boolean {
  const box = letterboxFor(authoring, targetWidth, targetHeight);

  return box.width !== targetWidth || box.height !== targetHeight;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
