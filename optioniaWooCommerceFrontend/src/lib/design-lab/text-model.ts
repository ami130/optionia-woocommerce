import {
  type TextAlign,
  type TextDesign,
  type TextFont,
  type TextVAlign,
  TEXT_FONTS,
} from '@shared/design/design-geometry.types';

/**
 * The text a customer personalises, as the EDITOR holds it (M26d.3).
 *
 * 🔴 **One text per design, not a collection — and that is the architecture,
 * not a simplification.** `buildScene` takes `textOptions`, each resolving to
 * exactly one text node keyed by its option; and M26d.4 put `textDesign` on the
 * OPTIONS row rather than on a value, because a text option has no values. So a
 * text design is the design of one option, and a `texts: []` array here would
 * model something no surface can render.
 *
 * ⚠️ **The merchant's words are a SAMPLE.** M26d.3 is explicit — *"the
 * merchant's text is a sample; the customer's input replaces it live"* — so
 * `text` is placeholder wording that shows the merchant what their styling looks
 * like, and `resolveSceneText` substitutes the real value at render time.
 *
 * 📌 **Editor pixels, stored fractions**, exactly as `EditorLayer` is: the two
 * meet at the conversion functions below and nowhere else.
 */
export interface EditorText {
  /** Placeholder wording. Replaced by the customer's input when rendered. */
  text: string;
  font: TextFont;
  /** Font size in CANVAS pixels — stored as a fraction of the canvas height. */
  size: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  valign: TextVAlign;
  /** Hex colour, with alpha. */
  color: string;
  /** Centre and box, in canvas pixels. */
  cx: number;
  cy: number;
  w: number;
  /**
   * The FIXED box height in canvas pixels, or 0 for auto-grow.
   *
   * 🔴 **Zero is a behaviour, not an absence.** Above zero the text wraps and
   * shrinks to fit; at zero the box grows with the wrapped lines and never
   * shrinks. The stored shape makes the same distinction by omitting `hPct`.
   */
  h: number;
  rot: number;
  /** 0 flat, >0 arches up, <0 arcs down, ±100 a closed circle. */
  curve: number;
  /** Letter spacing in canvas pixels. */
  letterSpacing: number;
  /**
   * The measured average glyph advance, as a fraction of the font size.
   *
   * 🔴 **Measured in a BROWSER and persisted**, which is why it lives on the
   * model rather than being derived. It is what makes a closed circle actually
   * close: narrow text sized by a generic estimate leaves a visible gap in the
   * ring. `undefined` until something measures it; the geometry falls back to
   * `CHAR_ADVANCE`.
   */
  advanceRatio?: number;
}

/**
 * The widest arc the stored contract allows, in either direction.
 *
 * 🔴 **The RENDERER clamps to this and the editor did not, which is the whole
 * reason this constant exists.** `resolveSceneText` applies
 * `Math.max(-100, Math.min(100, curve))` before drawing, so a stored `500`
 * prints as `100` — while the lab, which clamped nothing, kept drawing `500`.
 * The merchant would see one arc on screen and get another on the object, which
 * is precisely the disagreement this milestone exists to prevent.
 *
 * ⚠️ **The editor is the only gatekeeper in this chain.** The API stores the
 * design body unvalidated by design — `option.dto.ts` says so — matching how a
 * value's `design` is handled. Nothing downstream will catch an out-of-range
 * value, so nothing downstream can be relied on to.
 */
export const MAX_TEXT_CURVE = 100;

/**
 * The smallest font and box width a merchant can set, in canvas pixels.
 *
 * 🔴 **A FLOOR, not a shrink limit — the two are different rules.**
 * `MIN_FONT_RATIO` is how far `fitTextToBox` may shrink text BELOW the
 * merchant's chosen size to fit a box; this is the smallest size they may
 * choose in the first place. A design is authored once and rendered at many
 * sizes, so this floor is in canvas pixels like {@link MIN_LAYER_SIZE}, and
 * converts to a fraction like every other measurement.
 *
 * ⚠️ **Zero and negative are the cases that matter, not smallness.** A negative
 * `sizePct` reached storage before this existed; `fitTextToBox` returns
 * `maxFontSize` unchanged when it is `<= 0`, so the bad value flows through
 * rather than being corrected, and the text renders inverted or not at all.
 */
export const MIN_TEXT_SIZE = 4;

/** The sample a new text starts with, before the merchant types their own. */
export const DEFAULT_SAMPLE_TEXT = 'Your text here';

/** The font a new text uses until the merchant picks one. */
export const DEFAULT_TEXT_FONT: TextFont = TEXT_FONTS[0];

/**
 * A new text, centred on the canvas.
 *
 * 📌 **Sized as a fraction of the canvas**, so a text created on a tall canvas
 * and one created on a wide canvas look alike — the same reason every other
 * measurement here is relative.
 */
export function defaultText(cw: number, ch: number): EditorText {
  const text: EditorText = {
    text: DEFAULT_SAMPLE_TEXT,
    font: DEFAULT_TEXT_FONT,
    /* 7% of the canvas height: large enough to read, small enough to place. */
    size: Math.round(ch * 0.07),
    bold: false,
    italic: false,
    align: 'center',
    valign: 'middle',
    color: '#000000',
    cx: cw / 2,
    cy: ch / 2,
    /* 80% of the width, leaving a margin a merchant can grab. */
    w: Math.round(cw * 0.8),
    /* 🔴 Auto-grow, so a new text is never clipped before it is placed. */
    h: 0,
    rot: 0,
    curve: 0,
    letterSpacing: 0,
  };

  /*
   * ⚠️ **Clamped, because the canvas can be smaller than the floor.** A store
   * whose size has not been set yet reports 0×0, and a percentage of nothing is
   * nothing — `defaultText(0, 0)` produced a size and width of 0 before this.
   */
  clampText(text);

  return text;
}

/**
 * Bring a text's numbers inside the bounds every surface agrees on.
 *
 * 🔴 **Applied at the MUTATION point, not at conversion.** Clamping inside
 * `editorTextToDesign` would let the editor hold and draw an out-of-range
 * value, correcting it only on save — so the canvas would show a 500 arc, the
 * merchant would save, reopen, and find it had changed to 100 behind their
 * back. Clamping as the value is set means what they see is what is stored.
 *
 * ⚠️ **Mutates in place and returns nothing**, because the store's mutators
 * `Object.assign` a patch onto a live text and the components hold that same
 * object across a gesture. Returning a copy would leave them holding the
 * unclamped original.
 *
 * 📌 **`rot` is deliberately NOT bounded.** The renderer passes it through
 * untouched (`rot: design.rot ?? 0`), a rotation of 370° and one of 10° draw
 * identically, and the layer model does not normalise its own `rot` either —
 * so wrapping it here would be this file inventing a rule no other surface has.
 */
export function clampText(text: EditorText): void {
  text.size = Math.max(MIN_TEXT_SIZE, text.size);
  text.w = Math.max(MIN_TEXT_SIZE, text.w);
  /*
   * 🔴 **Height is special: 0 is auto-grow, a BEHAVIOUR rather than a size.**
   * So exactly zero passes through, and anything else is floored.
   *
   * ⚠️ **A NEGATIVE height is floored, not rounded down to auto-grow.** Mapping
   * it to 0 would silently switch the text from a fixed box to auto-growing —
   * changing what it does, not correcting what it measures. The merchant set a
   * fixed box; they keep one.
   */
  if (text.h !== 0 || !Number.isFinite(text.h)) {
    text.h = Number.isFinite(text.h) ? Math.max(MIN_TEXT_SIZE, text.h) : 0;
  }
  text.curve = Math.max(-MAX_TEXT_CURVE, Math.min(MAX_TEXT_CURVE, text.curve));
  /*
   * ⚠️ **Letter spacing may be NEGATIVE** — tightening a run is a real thing a
   * merchant does, and the renderer scales it without complaint. Only the
   * non-finite case is corrected.
   */
  if (!Number.isFinite(text.letterSpacing)) text.letterSpacing = 0;
  if (!Number.isFinite(text.size)) text.size = MIN_TEXT_SIZE;
  if (!Number.isFinite(text.curve)) text.curve = 0;
  if (!Number.isFinite(text.rot)) text.rot = 0;

  /*
   * 📌 **A measured ratio is dropped rather than floored when it is not
   * usable.** `resolveSceneText` treats any non-positive `advanceRatio` as
   * absent and falls back to `CHAR_ADVANCE`; storing a clamped-to-tiny ratio
   * would instead make every arc size itself to a glyph width no font has.
   */
  if (
    text.advanceRatio !== undefined &&
    (!Number.isFinite(text.advanceRatio) || text.advanceRatio <= 0)
  ) {
    text.advanceRatio = undefined;
  }
}

/**
 * Editor pixels → stored fractions.
 *
 * 🔴 **One of the two conversion points for text**, mirroring
 * `editorLayerToDesign`. M26c.2's contract is that conversion happens in exactly
 * two functions per model and nowhere else.
 *
 * ⚠️ **`size` and `letterSpacing` divide by HEIGHT, not width.** The stored
 * shape says so — *"as a fraction of the canvas HEIGHT"* — and dividing by the
 * wrong dimension produces text that is the right size only on a square canvas.
 */
export function editorTextToDesign(text: EditorText, cw: number, ch: number): TextDesign {
  const width = cw || 1;
  const height = ch || 1;

  return {
    text: text.text,
    font: text.font,
    sizePct: text.size / height,
    bold: text.bold,
    italic: text.italic,
    align: text.align,
    valign: text.valign,
    color: text.color,
    pos: {
      xPct: text.cx / width,
      yPct: text.cy / height,
      wPct: text.w / width,
      /*
       * 📌 **Omitted when auto-growing**, not stored as zero. The stored
       * contract treats an absent `hPct` as auto-grow, and writing `0` would
       * be a second spelling of the same state that readers must then handle.
       */
      ...(text.h > 0 ? { hPct: text.h / height } : {}),
    },
    rot: text.rot,
    curve: text.curve,
    ...(text.letterSpacing !== 0 ? { letterSpacing: text.letterSpacing / height } : {}),
    ...(text.advanceRatio !== undefined ? { advanceRatio: text.advanceRatio } : {}),
  };
}

/**
 * Stored fractions → editor pixels.
 *
 * ⚠️ **Every optional field has a documented default**, because a design
 * composed before a field existed must open rather than crash: absent `valign`
 * is `middle`, absent `hPct` is auto-grow, absent `letterSpacing` is zero.
 */
export function designTextToEditor(stored: TextDesign, cw: number, ch: number): EditorText {
  const width = cw || 1;
  const height = ch || 1;

  return {
    text: stored.text,
    font: stored.font,
    size: stored.sizePct * height,
    bold: stored.bold,
    italic: stored.italic,
    align: stored.align,
    /* Absent = middle: the legacy centred-on-cy behaviour. */
    valign: stored.valign ?? 'middle',
    color: stored.color,
    cx: stored.pos.xPct * width,
    cy: stored.pos.yPct * height,
    w: stored.pos.wPct * width,
    /* Absent or zero = auto-grow. */
    h: (stored.pos.hPct ?? 0) * height,
    rot: stored.rot ?? 0,
    curve: stored.curve ?? 0,
    letterSpacing: (stored.letterSpacing ?? 0) * height,
    advanceRatio: stored.advanceRatio,
  };
}
