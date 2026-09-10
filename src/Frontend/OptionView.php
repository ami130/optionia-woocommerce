<?php
/**
 * View helpers shared by every option template.
 *
 * ## Why this exists
 *
 * The six templates in `templates/options/` each computed their own
 * `aria-describedby`, and each associated **only** `description` — so
 * `help_text`, which the API publishes on every option, rendered nowhere at all.
 * M14.4b requires it: *"`help_text` and `tooltip` must be associated via
 * `aria-describedby`"*, and M29.7b makes that accessibility rather than polish.
 *
 * Fixing it in six places would have meant six chances to get a
 * space-separated id list subtly wrong, and a seventh template would inherit
 * whichever copy it was pasted from. So the rule is written once.
 *
 * ⚠️ **Presentation only.** Nothing here escapes for output — templates escape
 * at the point of use, which is the convention `Templates::output()` documents
 * and the one PHPCS enforces.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Frontend;

defined( 'ABSPATH' ) || exit;

/**
 * Presentation helpers for option templates.
 */
final class OptionView {

	/**
	 * The guidance blocks an option carries, in the order they are rendered.
	 *
	 * `description` first, then `help_text`: a description says *what the option
	 * is* and help text says *how to answer it*, so a screen reader announcing
	 * them in that order matches the sighted reading order down the page.
	 *
	 * Each entry is `array{ id: string, text: string, class: string }`. An
	 * absent or blank field contributes nothing — an empty `<p>` with an id
	 * would be announced as a pause with no content.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @return array<int, array{id: string, text: string, class: string}>
	 */
	public static function guidance( array $option ): array {
		$id     = isset( $option['id'] ) ? (string) $option['id'] : '';
		$blocks = array();

		if ( '' === $id ) {
			return $blocks;
		}

		$fields = array(
			'description' => array( 'optionia-desc-', 'optionia-option__description' ),
			'help_text'   => array( 'optionia-help-', 'optionia-option__help' ),

			/*
			 * ⚠️ **A tooltip is announced, not hovered.** M29.7b is explicit: a
			 * tooltip reachable only by hover is invisible to a large group of
			 * customers. Including it here means a screen reader reads it with
			 * the control, and a `title` attribute — which is hover-only and
			 * inconsistently announced — is never used.
			 */
			'tooltip'     => array( 'optionia-tip-', 'optionia-option__tooltip' ),
		);

		foreach ( $fields as $field => $parts ) {
			/*
			 * ⚠️ **The tooltip lives in `display`, the others on the option.**
			 *
			 * `description` and `help_text` are columns; a tooltip is display
			 * configuration (M14.4b). Reading it from the wrong place would have
			 * meant it silently never rendered — which is how `help_text` itself
			 * went unrendered across all six templates until Stage 3c.
			 */
			$source = 'tooltip' === $field
				? ( isset( $option['display'] ) && is_array( $option['display'] ) ? $option['display'] : array() )
				: $option;

			$text = isset( $source[ $field ] ) && is_scalar( $source[ $field ] )
				? trim( (string) $source[ $field ] )
				: '';

			if ( '' === $text ) {
				continue;
			}

			$blocks[] = array(
				'id'    => $parts[0] . $id,
				'text'  => $text,
				'class' => $parts[1],
			);
		}

		return $blocks;
	}

	/**
	 * An option's display configuration, with every value already validated.
	 *
	 * 🔴 **Read once, here, rather than in every template.** Each setting is
	 * a small decision — is `columns` an integer, is `swatch_size` one of three
	 * words — and one copy of that reasoning per template is one chance per
	 * template to disagree. A template asks for the answer, not for the raw
	 * array. Written as "fourteen" until 2026-09-10, when there were fifteen:
	 * the argument does not depend on the number, so it no longer states one.
	 *
	 * Every unrecognised or malformed value falls back to the default rather
	 * than being rendered: a `swatch_size` of `"enormous"` must not reach a class
	 * attribute, and `columns: 99` must not produce a grid nobody can read.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @return array{columns: int, swatch_size: string, price_display: string,
	 *               collapsed: bool, tooltip: string}
	 */
	public static function display( array $option ): array {
		$config = isset( $option['display'] ) && is_array( $option['display'] ) ? $option['display'] : array();

		$columns = isset( $config['columns'] ) && is_int( $config['columns'] )
			&& $config['columns'] >= 1 && $config['columns'] <= 6
				? $config['columns']
				: 1;

		$size = isset( $config['swatch_size'] ) && is_scalar( $config['swatch_size'] )
			? (string) $config['swatch_size']
			: '';

		if ( ! in_array( $size, array( 'small', 'medium', 'large' ), true ) ) {
			$size = 'medium';
		}

		$price = isset( $config['price_display'] ) && is_scalar( $config['price_display'] )
			? (string) $config['price_display']
			: '';

		if ( ! in_array( $price, array( 'delta', 'total', 'hidden' ), true ) ) {
			// `delta` is the default because it is the honest framing: an option
			// adds to a price the customer has already seen.
			$price = 'delta';
		}

		$tooltip = isset( $config['tooltip'] ) && is_scalar( $config['tooltip'] )
			? trim( (string) $config['tooltip'] )
			: '';

		return array(
			'columns'       => $columns,
			'swatch_size'   => $size,
			'price_display' => $price,
			'collapsed'     => ! empty( $config['collapsed_by_default'] ),
			'tooltip'       => $tooltip,
		);
	}

	/**
	 * The `aria-describedby` value for an option's control, or `''`.
	 *
	 * A **space-separated list**, which is what the attribute takes: an option
	 * with both a description and help text must announce both, and returning
	 * only the first is the bug this helper exists to make impossible.
	 *
	 * Empty string when there is nothing to describe, so a caller can test it
	 * rather than emit `aria-describedby=""` — which points at no element and is
	 * worse than the attribute's absence.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	public static function described_by( array $option ): string {
		$ids = array();

		foreach ( self::guidance( $option ) as $block ) {
			$ids[] = $block['id'];
		}

		return implode( ' ', $ids );
	}
}
