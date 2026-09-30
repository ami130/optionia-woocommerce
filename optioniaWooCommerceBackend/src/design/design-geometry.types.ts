/**
 * The shape of a stored design (M26c.1).
 *
 * ## Why this is a port and not a rewrite
 *
 * 🔴 **These types carry eight verified parity fixes.** `optionia-app` derived
 * them across four rendering surfaces that had to agree to the pixel, and the
 * plan calls re-deriving them *"the most expensive avoidable work in this
 * project"*. The comments came with them deliberately: they record which
 * spellings were tried and why they were wrong, which is the part that cannot
 * be recovered by reading the formulas.
 *
 * ## The rule every field obeys
 *
 * 🔴 **Fractions of the canvas, never pixels.** A design must re-place exactly
 * at any display size and again at print resolution, so nothing here is an
 * absolute length. The editor works in pixels; conversion happens at export and
 * import and nowhere else (M26c.2).
 *
 * ⚠️ **Several fields are optional because older designs lack them**, and that
 * is permanent rather than transitional — a design saved before a field existed
 * cannot be backfilled. Each optional field records what its absence means, and
 * a reader must honour that rather than treating absence as zero.
 */

/** How a layer fills its canvas. */
export type LayerStyle = 'free' | 'cover' | 'fit' | 'fullw' | 'fullh';

/**
 * A frame mask applied to a layer.
 *
 * ⚠️ **`square` is a REAL frame, not "no mask".** It is a rectangle that resizes
 * freely while the image inside keeps its aspect; the other built-in shapes are
 * ratio-locked. 🔴 **Legacy data used `square` to mean "no mask"** and is mapped
 * to `none` on read — so a reader that treats a stored `square` as unmasked is
 * wrong for every design saved since the frames shipped.
 *
 * `image` is a merchant-uploaded PNG mask whose alpha decides what shows.
 */
export type LayerShape = 'none' | 'square' | 'rounded' | 'circle' | 'heart' | 'star' | 'image';

/** The built-in vector shapes — every `LayerShape` that has a clip path. */
export type PathShape = Exclude<LayerShape, 'none' | 'image'>;

/**
 * Where the image sits INSIDE a shape frame — a mini layer one level down, with
 * the frame as its canvas.
 *
 * 📌 **`style` here fits the image to the FRAME**, while the layer's own `style`
 * fits the frame to the CANVAS. Two levels, same rules: `free` trusts the stored
 * box, `cover`/`fit` centre, `fullw` keeps `yPct`, `fullh` keeps `xPct`.
 *
 * Only meaningful when `shape !== 'square'`.
 */
export interface LayerCrop {
  style: LayerStyle;
  xPct: number;
  yPct: number;
  wPct: number;
  /** The image's own rotation inside the frame; the clip stays fixed. */
  rot: number;
  /** 0–100, multiplied with the layer's own opacity. */
  opacity: number;
}

/** One overlay image and where it sits, normalised 0..1 to the image box. */
export interface DesignLayer {
  name: string;
  src: string;
  natW: number;
  natH: number;
  pos: { xPct: number; yPct: number; wPct: number; hPct: number };
  rot: number;
  style: LayerStyle;
  /** 0–100. ⚠️ Absent in designs saved before opacity existed — treat as 100. */
  opacity?: number;
  /** ⚠️ Absent in older designs — treat as `none`. See `LayerShape`. */
  shape?: LayerShape;
  /** The custom PNG mask URL when `shape === 'image'`. */
  shapeSrc?: string;
  /** ⚠️ Absent means a centred cover. */
  crop?: LayerCrop;
  visible: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';

/** Vertical placement of text within its fixed box. */
export type TextVAlign = 'top' | 'middle' | 'bottom';

/**
 * A text element a customer personalises.
 *
 * Every measurement is a fraction of the canvas, like `DesignLayer`.
 */
export interface TextDesign {
  text: string;
  font: string;
  /** Font size as a fraction of the canvas HEIGHT. */
  sizePct: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** ⚠️ Absent = `middle`, which is the legacy centred-on-`cy` behaviour. */
  valign?: TextVAlign;
  /** Hex colour, with alpha. */
  color: string;
  /**
   * Centre and box size as fractions of the canvas.
   *
   * 🔴 **`hPct` is the FIXED box height, and its absence changes behaviour.**
   * When above zero the text wraps inside a `w × h` box and its font size
   * shrinks — never grows past the merchant's size — to fit that height. Absent
   * or zero on older designs means the box auto-grows with the wrapped lines,
   * with no shrink and no clip, until the design is re-saved.
   */
  pos: { xPct: number; yPct: number; wPct: number; hPct?: number };
  rot: number;
  /** Curved text: 0 flat, >0 arches up, <0 arcs down, ±100 a full circle. */
  curve: number;
  /** Letter spacing as a fraction of the canvas HEIGHT. ⚠️ Absent = 0. */
  letterSpacing?: number;
  /**
   * The measured average glyph advance for this text and font, as a fraction of
   * the font size.
   *
   * 🔴 **This is what makes a full circle actually close.** Measured in a
   * browser at authoring time and persisted, so every surface sizes the arc to
   * the REAL glyph widths rather than a generic estimate — narrow text (i, j, s)
   * otherwise leaves a visible gap in the ring. Scale-invariant.
   *
   * ⚠️ **Absent on older or server-built designs**, where the geometry falls
   * back to `CHAR_ADVANCE`.
   */
  advanceRatio?: number;
}

/**
 * The canvas a design was composed against (M26c.3, Decision 5).
 *
 * 🔴 **This field does not exist in `optionia-app`, and its absence is the
 * defect it exists to prevent.** There, `buildScene` takes whatever width and
 * height the caller supplies and nothing records what the merchant actually
 * composed against — so a design authored on a square mug photo and assigned to
 * a tall bottle photo silently reflows, and the merchant discovers it on a
 * printed object.
 *
 * ⚠️ **The stored aspect belongs to the DESIGN, not to the assignment.** Two
 * products of different shapes share one design and one authoring aspect; the
 * letterbox that fits it onto each product is computed at render time and never
 * stored.
 */
export interface AuthoringCanvas {
  /** Width of the canvas the design was composed on, in any unit. */
  readonly width: number;
  /** Height of the same canvas, in the same unit. */
  readonly height: number;
}
