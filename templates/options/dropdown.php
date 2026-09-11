<?php
/**
 * A dropdown option: one choice from several, drawn as a `<select>`.
 *
 * The same option as `radio` — same `choice`/`one` axes, same values, same
 * pricing — differing only in how it is drawn. Phase 14's first added type, and
 * deliberately the cheapest one: if this costs a registry entry and this file,
 * the abstraction Phase 7 built is real.
 *
 * ## Why this is not a copy of `radio.php` with the input swapped
 *
 * A `<select>` is **one** control, so the markup around it differs in ways that
 * matter to a screen reader:
 *
 * - `<label for>` rather than `<fieldset><legend>`. Radio buttons are several
 *   inputs forming one question and need the question announced with each; a
 *   select is a single control whose label belongs to it directly. A fieldset
 *   here would announce the question twice.
 * - `required` on the control itself, with a placeholder option carrying an
 *   empty value — a `<select>` always has something selected, so "nothing chosen
 *   yet" has to be an option rather than an absence.
 *
 * ## `<optgroup>`, and why it is not a separate type
 *
 * M14.3 listed `dropdown_grouped`. It is **not a type**: the axes, the values and
 * the pricing are identical, and only the drawing differs — so grouping is a
 * `group_label` on a value, read here. Registering a second type would give
 * merchants two ways to describe one thing.
 *
 * ⚠️ **Groups are contiguous runs in `sort_order`, not a re-sort.** The merchant's
 * ordering is authoritative; if two values share a label but sit either side of a
 * third, they render as **two** groups with the same heading. Regrouping them
 * silently would move values the merchant deliberately placed, and `<optgroup>`
 * cannot nest or resume anyway.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/dropdown.php`.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: option, field_name.
 */

declare( strict_types=1 );

use Optionia\Frontend\OptionView;

defined( 'ABSPATH' ) || exit;

$optionia_option = isset( $optionia['option'] ) && is_array( $optionia['option'] ) ? $optionia['option'] : array();
$optionia_values = isset( $optionia_option['values'] ) && is_array( $optionia_option['values'] ) ? $optionia_option['values'] : array();
$optionia_id     = isset( $optionia_option['id'] ) ? (string) $optionia_option['id'] : '';

if ( '' === $optionia_id || array() === $optionia_values ) {
	return;
}

$optionia_field    = (string) ( $optionia['field_name'] ?? 'optionia' ) . '[' . $optionia_id . ']';
$optionia_required = ! empty( $optionia_option['is_required'] );
$optionia_input_id = 'optionia-' . $optionia_id;

/*
 * Guidance blocks and the `aria-describedby` that points at them, from the one
 * helper every template shares. `description` and `help_text` are **both**
 * published by the API; each template used to associate only the first, so help
 * text rendered nowhere at all — see `OptionView`.
 */
$optionia_guidance = OptionView::guidance( $optionia_option );
$optionia_display  = OptionView::display( $optionia_option );
$optionia_describe = OptionView::described_by( $optionia_option );

/*
 * Whether any value is pre-selected.
 *
 * A `<select>` selects its first option when none is marked, so without a
 * placeholder a required dropdown would arrive already answered — and a customer
 * who never looked at it would be charged for a choice they did not make. The
 * placeholder exists only when nothing is defaulted.
 */
$optionia_has_default = false;

foreach ( $optionia_values as $optionia_probe ) {
	if ( is_array( $optionia_probe ) && ! empty( $optionia_probe['is_default'] ) ) {
		$optionia_has_default = true;
		break;
	}
}

unset( $optionia_probe );
?>
<div class="optionia-option optionia-option--dropdown optionia-option--cols-<?php echo esc_attr( (string) $optionia_display['columns'] ); ?><?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>" data-optionia="option" data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>">
	<label class="optionia-option__label" for="<?php echo esc_attr( $optionia_input_id ); ?>">
		<?php echo esc_html( (string) ( $optionia_option['label'] ?? '' ) ); ?>
		<?php if ( $optionia_required ) : ?>
			<span class="optionia-option__required" aria-hidden="true">*</span>
			<span class="screen-reader-text"><?php esc_html_e( '(required)', 'optionia' ); ?></span>
		<?php endif; ?>
	</label>

	<?php foreach ( $optionia_guidance as $optionia_block ) : ?>
		<p class="<?php echo esc_attr( $optionia_block['class'] ); ?>" id="<?php echo esc_attr( $optionia_block['id'] ); ?>">
			<?php echo esc_html( $optionia_block['text'] ); ?>
		</p>
	<?php endforeach; ?>

	<select
		class="optionia-option__field"
		id="<?php echo esc_attr( $optionia_input_id ); ?>"
		name="<?php echo esc_attr( $optionia_field ); ?>"
		data-optionia="value"
		<?php echo $optionia_required ? ' required aria-required="true"' : ''; ?>
		<?php echo '' !== $optionia_describe ? ' aria-describedby="' . esc_attr( $optionia_describe ) . '"' : ''; ?>
	>
		<?php if ( ! $optionia_has_default ) : ?>
			<option value=""><?php esc_html_e( 'Choose an option', 'optionia' ); ?></option>
		<?php endif; ?>

		<?php
		/*
		 * The heading currently open, so a run of values sharing one label sits
		 * inside a single `<optgroup>`. `null` means no group is open.
		 */
		$optionia_open_group = null;

		foreach ( $optionia_values as $optionia_index => $optionia_value ) {
			if ( ! is_array( $optionia_value ) || ! isset( $optionia_value['value_key'] ) ) {
				continue;
			}

			$optionia_key = (string) $optionia_value['value_key'];

			/*
			 * 🔴 **The value's own id, for a rule that targets one value.**
			 * `value_key` is unique only within one option; a rule's `target_id`
			 * must identify a value across a whole set. Emitted only when
			 * present, so a document from a cloud older than M17.8 carries no
			 * empty attribute the runtime could match by accident.
			 */
			$optionia_value_id = isset( $optionia_value['id'] ) && is_scalar( $optionia_value['id'] )
				? (string) $optionia_value['id']
				: '';

			/*
			 * A blank label is treated as no group: an empty `<optgroup label="">`
			 * renders as an unlabelled indent in every browser, which reads as a
			 * rendering fault rather than a merchant's choice.
			 */
			$optionia_group = isset( $optionia_value['group_label'] )
				? trim( (string) $optionia_value['group_label'] )
				: '';
			$optionia_group = '' !== $optionia_group ? $optionia_group : null;

			if ( $optionia_group !== $optionia_open_group ) {
				if ( null !== $optionia_open_group ) {
					echo '</optgroup>';
				}

				if ( null !== $optionia_group ) {
					printf( '<optgroup label="%s">', esc_attr( $optionia_group ) );
				}

				$optionia_open_group = $optionia_group;
			}

			/*
			 * Price carried on the option, exactly as `radio.php` carries it on
			 * the input, and for the same reason: the runtime totals a selection
			 * without a second source of truth.
			 *
			 * Only `fixed` is emitted as a number a client may add up.
			 * `percentage`, `per_unit`, `per_char` and `tiered` each need a
			 * decision `docs/PRICING-SPEC.md` has not made, and a storefront
			 * guessing at rounding would show a total the server disagrees with.
			 * The *type* is emitted regardless, so the runtime can tell "this
			 * adds nothing" from "this cannot be priced here yet".
			 */
			$optionia_price  = isset( $optionia_value['price_config'] ) && is_array( $optionia_value['price_config'] )
				? $optionia_value['price_config']
				: array();
			$optionia_ptype  = isset( $optionia_price['type'] ) ? (string) $optionia_price['type'] : '';
			$optionia_pminor = 'fixed' === $optionia_ptype && isset( $optionia_price['amount_minor'] )
				? (int) $optionia_price['amount_minor']
				: null;
			?>
			<option
				value="<?php echo esc_attr( $optionia_key ); ?>"
				<?php if ( '' !== $optionia_value_id ) : ?>
					data-optionia-value="<?php echo esc_attr( $optionia_value_id ); ?>"
				<?php endif; ?>
				<?php if ( '' !== $optionia_ptype ) : ?>
					data-optionia-price-type="<?php echo esc_attr( $optionia_ptype ); ?>"
				<?php endif; ?>
				<?php if ( null !== $optionia_pminor ) : ?>
					data-optionia-price="<?php echo esc_attr( (string) $optionia_pminor ); ?>"
				<?php endif; ?>
				<?php selected( ! empty( $optionia_value['is_default'] ) ); ?>
			><?php echo esc_html( (string) ( $optionia_value['label'] ?? $optionia_key ) ); ?></option>
			<?php
			unset( $optionia_index );
		}

		// A group open at the end of the list still needs closing.
		if ( null !== $optionia_open_group ) {
			echo '</optgroup>';
		}
		?>
	</select>
</div>
