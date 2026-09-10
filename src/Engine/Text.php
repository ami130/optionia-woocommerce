<?php
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
 * So there is one function, and `per_char` pricing, the character counter, and
 * `min_length` / `max_length` validation all call it. Not "the same rule
 * implemented twice" — the same function.
 *
 * ## Why graphemes, not bytes or code points
 *
 * `strlen()` is byte length: `"café"` is 5, and `"👨‍👩‍👧"` is 18. `mb_strlen()`
 * counts code points, which is closer but still wrong for anything a human
 * would call one character — that family is 5 code points, a flag is 2, and a
 * combining accent splits `"é"` into two.
 *
 * A grapheme is what a customer sees and what an engraving machine cuts. One
 * flag is one character because one flag is one mark in the material.
 *
 * Verified against the TypeScript side on twelve cases including combining
 * marks, ZWJ families, flags and skin-tone modifiers: `Intl.Segmenter` and
 * `grapheme_strlen()` agree on all twelve.
 *
 * ## Why the ends are trimmed and inner spaces are not
 *
 * M11.1a recommended excluding whitespace entirely, on the reasoning that "the
 * counter is what the customer believes". That argues for **one** rule — the
 * milestone's actual point — rather than for dropping spaces, and the two
 * readings of "whitespace does not count" disagree on ordinary input:
 * `"John Smith"` is nine characters if all whitespace is stripped and ten if
 * only the ends are trimmed.
 *
 * The space between the names **is cut into the material**. Charging nine for a
 * name that engraves ten charges for less than is produced, and every complaint
 * becomes a merchant explaining why a space was free. Leading and trailing
 * whitespace is different: it is almost always a typing artefact, it engraves
 * nothing visible, and no customer intends to pay for it.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Engine;

defined( 'ABSPATH' ) || exit;

/**
 * Text measurement, shared by pricing, validation and display.
 */
final class Text {

	/**
	 * Normalise text before it is measured, priced or validated.
	 *
	 * Trims leading and trailing whitespace, including the Unicode kinds a
	 * `trim()` without a pattern would miss — a non-breaking space pasted from a
	 * word processor is invisible and would otherwise be charged for.
	 *
	 * **Runs before `measure()`, always.** Phase 14 gives text options a
	 * merchant-configurable `trim_whitespace`, and a setting that changes the
	 * count *after* measuring would make the pipeline non-deterministic even
	 * though this function is not.
	 *
	 * @param string $text Raw customer input.
	 */
	public static function normalise( string $text ): string {
		$trimmed = preg_replace( '/^[\s\x{00A0}\x{FEFF}]+|[\s\x{00A0}\x{FEFF}]+$/u', '', $text );

		// `preg_replace` returns null on a malformed UTF-8 subject. Falling back
		// to the input is the safe answer: measuring something is better than a
		// fatal on a product page, and the validation layer rejects it anyway.
		return null === $trimmed ? $text : $trimmed;
	}

	/**
	 * How many characters a customer is charged for, and shown.
	 *
	 * Counts **grapheme clusters** of the normalised text.
	 *
	 * @param string $text Raw customer input; normalised here, so callers need not.
	 */
	public static function measure( string $text ): int {
		$normalised = self::normalise( $text );

		if ( '' === $normalised ) {
			return 0;
		}

		$count = grapheme_strlen( $normalised );

		/**
		 * `grapheme_strlen` returns false on invalid UTF-8, and null on some
		 * builds. Neither is a count, and returning either as an integer would
		 * make a malformed string free.
		 *
		 * `mb_strlen` over-counts a family emoji, which is the wrong answer —
		 * but a wrong answer that charges *more* on input the validator will
		 * reject anyway is better than one that charges nothing.
		 */
		if ( ! is_int( $count ) ) {
			return mb_strlen( $normalised, 'UTF-8' );
		}

		return $count;
	}
}
