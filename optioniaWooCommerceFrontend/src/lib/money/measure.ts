/**
 * The one normative text measurement (M11.1a).
 *
 * ## Why this exists
 *
 * In `optionia-app` the price and the character counter were written separately,
 * with different rules. For `"AB CD"` the customer is charged for five
 * characters while the counter beside the field shows four — live there today.
 *
 * Nothing is over- or under-charged relative to the preview, which is exactly
 * why it survived: display and server agree with each other. It is not a pricing
 * bug, it is a **credibility** bug, and it lands on engraving — one of the
 * best-fit segments for this product.
 *
 * So there is one function per language and they agree case for case. The PHP
 * port is `Engine\Text` in the plugin; `pricing-fixtures.json` is what keeps the
 * two honest, since two implementations that merely intend to match are how the
 * original bug happened.
 *
 * ## Why graphemes
 *
 * `text.length` counts UTF-16 code units — a family emoji is 8. Spreading with
 * `[...text]` counts code points, which is closer and still wrong: that family
 * is 5, a flag is 2, and a combining accent splits `é` into two.
 *
 * A grapheme is what a customer sees and what an engraving machine cuts.
 * `Intl.Segmenter` was verified against PHP's `grapheme_strlen` on twelve cases
 * including combining marks, ZWJ families, flags and skin-tone modifiers: all
 * twelve agree. Node is declared `>=20` and CI runs 20 and 24, so it is always
 * available.
 *
 * ## Why the ends are trimmed and inner spaces are not
 *
 * M11.1a recommended excluding whitespace entirely. That reads two ways, and
 * they disagree on ordinary input: `"John Smith"` is nine characters if all
 * whitespace is stripped and ten if only the ends are trimmed.
 *
 * The space between the names **is cut into the material**, so charging nine for
 * a name that engraves ten charges for less than is produced. Leading and
 * trailing whitespace is different — a typing artefact that engraves nothing and
 * nobody intends to pay for.
 */

/**
 * One segmenter, built once.
 *
 * Constructing an `Intl.Segmenter` is not free, and this runs per option per
 * request. The locale is deliberately `undefined`: grapheme segmentation is
 * locale-independent under UAX #29, and passing one would invite a
 * locale-dependent price.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Leading and trailing whitespace, including the kinds a bare `trim()` misses.
 *
 * A non-breaking space pasted from a word processor is invisible and would
 * otherwise be charged for; so would a zero-width byte-order mark.
 */
/*
 * Written as escapes rather than literal characters: `no-irregular-whitespace`
 * flags them on sight, and it is right to — a stray non-breaking space is
 * normally a paste accident. Here they are the subject, so the escape keeps the
 * intent legible and the rule useful everywhere else.
 */
const OUTER_WHITESPACE = /^[\s\u00A0\uFEFF]+|[\s\u00A0\uFEFF]+$/gu;

/**
 * Normalise text before it is measured, priced or validated.
 *
 * **Runs before `measure()`, always.** Phase 14 gives text options a
 * merchant-configurable `trim_whitespace`, and a setting that changed the count
 * *after* measuring would make the pipeline non-deterministic even though this
 * function is not.
 */
export function normalise(text: string): string {
  return text.replace(OUTER_WHITESPACE, '');
}

/**
 * How many characters a customer is charged for, and shown.
 *
 * Counts grapheme clusters of the normalised text. Callers need not normalise
 * first — doing it here is what stops two call sites disagreeing.
 */
export function measure(text: string): number {
  const normalised = normalise(text);

  if (normalised === '') {
    return 0;
  }

  let count = 0;

  // Counted by iteration rather than `[...segment()].length`, which allocates an
  // array of every cluster to discard it immediately.
  for (const _ of GRAPHEMES.segment(normalised)) {
    void _;
    count += 1;
  }

  return count;
}
