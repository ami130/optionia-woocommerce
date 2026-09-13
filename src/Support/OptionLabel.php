<?php
/**
 * One reading of a cart line's stored labels, shared by everything that shows them.
 *
 * 🔴 **Written because three consumers each answered this question their own
 * way.** `CartDisplay`, `OrderLineItem` and `CheckoutValidator` all take
 * `labels[ option_id ]` and turn it into a name and a value to show a human —
 * and all three did it with different code. `CartItemPayload`'s docblock
 * already says this kind of question is "asked in three places and must get one
 * answer"; this is the answer for labels.
 *
 * ⚠️ **The shape has two forms, and that is what broke them.** M18.1 made
 * `labels[ id ]` a `{option, value}` pair at `cardinality: one` and a **list**
 * of those pairs at `many`. Every one of the three read `$label['option']`
 * directly, which is `null` for a list — so a multi-select line rendered the
 * raw option id and the word `"Array"`, with a PHP notice. Measured at
 * `OrderLineItem`:
 *
 * ```
 * Warning: Array to string conversion
 * order meta -> name='opt-a'  value='Array'
 * ```
 *
 * 🔴 **That reached the merchant's fulfilment record**, not just a screen:
 * packing slips, order emails, CSV export and refund tooling, permanently.
 *
 * ## Why the joining lives here and not in the resolver
 *
 * `Engine\SelectionResolver` is a pure function with a TypeScript twin held to
 * shared fixtures, and it deliberately does not decide presentation — the same
 * reason `sku_suffixes` is returned keyed rather than concatenated. A separator
 * is a display decision, so it belongs on the display side of that line.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * Reads the `{option, value}` pairs a cart line stored for one option.
 */
final class OptionLabel {

	/**
	 * How several chosen values read as one string.
	 *
	 * ⚠️ **A comma and a space, matching how a person writes a list.** The cart
	 * row and the order meta both name an option once and print what was chosen
	 * for it, so `Extras: Red, Blue` is one row rather than two.
	 */
	private const JOIN = ', ';

	/**
	 * The option's own name, or the fallback when nothing usable was stored.
	 *
	 * 🔴 **Every entry of a list carries the same option name**, because
	 * `labels_for()` builds each pair from the same option — so the first entry
	 * answers for all of them, and an empty list falls back.
	 *
	 * @param mixed  $label    What `labels[ option_id ]` held.
	 * @param string $fallback Shown when no name was stored — normally the option id.
	 * @return string A name safe to show a human.
	 */
	public static function name( $label, string $fallback ): string {
		foreach ( self::pairs( $label ) as $pair ) {
			$name = self::text( $pair['option'] ?? null );

			if ( '' !== $name ) {
				return $name;
			}
		}

		return $fallback;
	}

	/**
	 * What the customer chose, as one string.
	 *
	 * ⚠️ **Every chosen value appears, or the line understates what was
	 * bought.** A multi-select showing only its first value is the shape M11.5
	 * exists to prevent — a customer reading a total they cannot account for.
	 *
	 * 🔴 **A value that stored no label falls back to its own key**, per entry
	 * rather than for the whole option, so one unlabelled value does not erase
	 * its siblings.
	 *
	 * @param mixed $label    What `labels[ option_id ]` held.
	 * @param mixed $fallback The raw selection — a string, or a list of them.
	 * @return string A value safe to show a human.
	 */
	public static function value( $label, $fallback ): string {
		$pairs = self::pairs( $label );
		$keys  = is_array( $fallback ) ? array_values( $fallback ) : array( $fallback );
		$parts = array();

		foreach ( $pairs as $index => $pair ) {
			$text = self::text( $pair['value'] ?? null );

			if ( '' === $text ) {
				$text = self::text( $keys[ $index ] ?? null );
			}

			if ( '' !== $text ) {
				$parts[] = $text;
			}
		}

		if ( array() === $parts ) {
			/*
			 * Nothing usable was stored, so the raw selection is all there is.
			 * `array_filter` drops entries that are not scalar rather than
			 * letting one coerce to "Array" — the defect this class removes.
			 */
			$parts = array_map(
				array( self::class, 'text' ),
				array_filter( $keys, 'is_scalar' )
			);
			$parts = array_values( array_filter( $parts, 'strlen' ) );
		}

		return implode( self::JOIN, $parts );
	}

	/**
	 * The stored label in list form, whatever shape it arrived in.
	 *
	 * 🔴 **One pair and a list of pairs are told apart by `option`, not by
	 * `is_array()`.** Both forms *are* arrays — `{option, value}` is an array
	 * too — so testing for an array answers the wrong question. A single pair
	 * has an `option` key; a list has integer keys holding pairs.
	 *
	 * @param mixed $label What `labels[ option_id ]` held.
	 * @return array<int, array<string, mixed>> Zero or more pairs.
	 */
	private static function pairs( $label ): array {
		if ( ! is_array( $label ) || array() === $label ) {
			return array();
		}

		if ( isset( $label['option'] ) || isset( $label['value'] ) ) {
			return array( $label );
		}

		$pairs = array();

		foreach ( $label as $entry ) {
			if ( is_array( $entry ) ) {
				$pairs[] = $entry;
			}
		}

		return $pairs;
	}

	/**
	 * A scalar as a trimmed string; anything else as an empty one.
	 *
	 * 🔴 **An array must never reach `(string)`.** That is the coercion that
	 * produced `"Array"` in an order a merchant had to fulfil.
	 *
	 * ⚠️ **An array INSIDE a single pair's `value` is joined, not dropped.**
	 * A third shape, and a defensive one: `{option: 'Finish', value: ['Red',
	 * 'Large']}` is not what this plugin writes, but another plugin filtering
	 * the payload can produce it — and the block cart discards a whole row whose
	 * value is not scalar, so the customer would lose the line rather than see a
	 * clumsy one. `CartDisplay` guarded this before M18.2 and the guard moved
	 * here with the rest of the reading.
	 *
	 * Non-scalar members are dropped rather than coerced, for the same reason
	 * the outer case is.
	 *
	 * @param mixed $candidate Anything a stored label might hold.
	 */
	private static function text( $candidate ): string {
		if ( is_array( $candidate ) ) {
			$candidate = implode( self::JOIN, array_filter( $candidate, 'is_scalar' ) );
		}

		return is_scalar( $candidate ) ? trim( (string) $candidate ) : '';
	}
}
