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
  return {
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
