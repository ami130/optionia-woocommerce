<?php
/**
 * Turning what a customer chose into the scene the cloud renders (M26e.4).
 *
 * ## Why this is in `Engine/`
 *
 * It is a pure function of (option sets, selections) → scene. No WordPress, no
 * network, no order lookup — the architecture gate enforces that, and it is
 * what makes every case below testable as a table rather than through a
 * checkout.
 *
 * ## What it does NOT do, deliberately
 *
 * 🔴 **No geometry.** M26e.1's rule — *"no geometry computed in PHP"* — is
 * honoured by this computing none. A value's `design` is copied through
 * untouched; `shared/design/` resolves layers against the canvas, and it does
 * so for the dashboard preview, the storefront overlay and the print file
 * alike. A second implementation here is how the three drift apart, and the
 * drift would not be visible until a merchant printed something that did not
 * match what the customer approved.
 *
 * ⚠️ **No validation of the design's contents.** The serializer refuses what it
 * cannot draw, and refusing earlier here would mean two definitions of a
 * drawable scene. What IS checked is the shape this class is responsible for:
 * that a selection names a real value, and that the value carries artwork.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Engine;

defined( 'ABSPATH' ) || exit;

/**
 * Composes a render scene from a line's selections.
 */
final class SceneComposer {

	/**
	 * Build the scene for one line, or null when it has no artwork.
	 *
	 * 🔴 **Null rather than an empty scene when nothing was designed.** A line
	 * with no design must not produce a render request at all: the cloud would
	 * accept it, the worker would rasterise a blank canvas, and a merchant
	 * would be handed an empty print file for an ordinary product. "Nothing to
	 * draw" and "draw nothing" are different answers.
	 *
	 * @param array<int, mixed>    $option_sets Published sets for the product.
	 * @param array<string, mixed> $selections  Option id → value key.
	 * @param int                  $width       Target canvas width.
	 * @param int                  $height      Target canvas height.
	 *
	 * @return array<string, mixed>|null The scene, or null when nothing is designed.
	 */
	public static function compose(
		array $option_sets,
		array $selections,
		int $width,
		int $height
	): ?array {
		if ( $width < 1 || $height < 1 ) {
			return null;
		}

		$groups    = array();
		$texts     = array();
		$authoring = null;

		foreach ( self::options_in( $option_sets ) as $option ) {
			$option_id = isset( $option['id'] ) && is_scalar( $option['id'] ) ? (string) $option['id'] : '';

			if ( '' === $option_id || ! array_key_exists( $option_id, $selections ) ) {
				continue;
			}

			$chosen = $selections[ $option_id ];

			/*
			 * 📌 **An option-level design belongs to the option, not a value.**
			 * `DesignCarrier.OPTION_TEXT` types carry one design and the
			 * customer's typing replaces its sample text — so the selection is
			 * the TEXT, not a value key.
			 */
			$option_design = self::design_of( $option );

			if ( null !== $option_design ) {
				$texts[] = array(
					'key'    => $option_id,
					'design' => $option_design,
					'value'  => is_scalar( $chosen ) ? (string) $chosen : '',
				);

				$authoring = $authoring ?? self::authoring_of( $option_design );

				continue;
			}

			foreach ( self::values_in( $option ) as $value ) {
				$design = self::design_of( $value );

				if ( null === $design ) {
					continue;
				}

				$key = isset( $value['value_key'] ) && is_scalar( $value['value_key'] )
					? (string) $value['value_key']
					: '';

				if ( '' === $key ) {
					continue;
				}

				/*
				 * 🔴 **Every designed value becomes a group; only the chosen one
				 * is visible.** The alternative — emitting just the selection —
				 * would make the storefront re-fetch a whole scene on every
				 * click, and `shared/design/` is built around toggling
				 * visibility precisely so an overlay can update without a round
				 * trip. The print path takes the same scene so that what is
				 * rasterised is what was previewed.
				 */
				$groups[] = array(
					'key'     => $option_id . ':' . $key,
					'layers'  => self::layers_of( $design ),
					'visible' => self::matches( $chosen, $key ),
				);

				$authoring = $authoring ?? self::authoring_of( $design );
			}
		}

		if ( array() === $groups && array() === $texts ) {
			return null;
		}

		/*
		 * ⚠️ **A scene whose every group is hidden draws nothing**, and asking
		 * the cloud to rasterise it would spend a render on a blank canvas. It
		 * happens whenever a customer picks the undesigned choice of a designed
		 * option — "no engraving" on an engravable mug — which is an ordinary
		 * purchase, not an error.
		 */
		if ( array() === $texts && ! self::any_visible( $groups ) ) {
			return null;
		}

		$scene = array(
			'width'  => $width,
			'height' => $height,
			'groups' => $groups,
		);

		if ( array() !== $texts ) {
			$scene['textOptions'] = $texts;
		}

		/*
		 * 📌 **The canvas the design was composed on (Decision 5).** Carried
		 * through so the cloud letterboxes a square design on a tall product
		 * rather than stretching it. Absent on designs predating M26c.3, which
		 * `buildScene` already handles by using the full target.
		 */
		if ( null !== $authoring ) {
			$scene['authoring'] = $authoring;
		}

		return $scene;
	}

	/**
	 * Every option across every set, flattened.
	 *
	 * @param array<int, mixed> $option_sets Published sets.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function options_in( array $option_sets ): array {
		$out = array();

		foreach ( $option_sets as $set ) {
			if ( ! is_array( $set ) ) {
				continue;
			}

			foreach ( (array) ( $set['groups'] ?? array() ) as $group ) {
				if ( ! is_array( $group ) ) {
					continue;
				}

				foreach ( (array) ( $group['options'] ?? array() ) as $option ) {
					if ( is_array( $option ) ) {
						$out[] = $option;
					}
				}
			}
		}

		return $out;
	}

	/**
	 * An option's values.
	 *
	 * @param array<string, mixed> $option One option.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function values_in( array $option ): array {
		$out = array();

		foreach ( (array) ( $option['values'] ?? array() ) as $value ) {
			if ( is_array( $value ) ) {
				$out[] = $value;
			}
		}

		return $out;
	}

	/**
	 * The artwork on a value or option, or null when there is none.
	 *
	 * ⚠️ **An empty array is NOT a design.** `design: {}` reaches here from a
	 * value whose artwork was cleared, and treating it as present would emit a
	 * group with no layers — a render of nothing, charged as a render.
	 *
	 * @param array<string, mixed> $carrier A value or an option.
	 *
	 * @return array<string, mixed>|null
	 */
	private static function design_of( array $carrier ): ?array {
		$design = $carrier['design'] ?? null;

		if ( ! is_array( $design ) || array() === $design ) {
			return null;
		}

		return $design;
	}

	/**
	 * A design's layers.
	 *
	 * @param array<string, mixed> $design One design.
	 *
	 * @return array<int, mixed>
	 */
	private static function layers_of( array $design ): array {
		$layers = $design['layers'] ?? array();

		return is_array( $layers ) ? array_values( $layers ) : array();
	}

	/**
	 * The canvas a design was composed on, when it records one.
	 *
	 * @param array<string, mixed> $design One design.
	 *
	 * @return array<string, mixed>|null
	 */
	private static function authoring_of( array $design ): ?array {
		$authoring = $design['authoring'] ?? null;

		return is_array( $authoring ) && array() !== $authoring ? $authoring : null;
	}

	/**
	 * Whether a selection names this value.
	 *
	 * 📌 **A selection may be a list.** A multi-select option sends every chosen
	 * key, and each designed value it names is visible at once.
	 *
	 * @param mixed  $chosen What the customer selected.
	 * @param string $key    The value key being tested.
	 */
	private static function matches( $chosen, string $key ): bool {
		if ( is_array( $chosen ) ) {
			foreach ( $chosen as $one ) {
				if ( is_scalar( $one ) && (string) $one === $key ) {
					return true;
				}
			}

			return false;
		}

		return is_scalar( $chosen ) && (string) $chosen === $key;
	}

	/**
	 * Whether any group will actually draw.
	 *
	 * @param array<int, array<string, mixed>> $groups Composed groups.
	 */
	private static function any_visible( array $groups ): bool {
		foreach ( $groups as $group ) {
			if ( ! empty( $group['visible'] ) && array() !== ( $group['layers'] ?? array() ) ) {
				return true;
			}
		}

		return false;
	}
}
