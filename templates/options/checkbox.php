<?php
/**
 * A checkbox option: one choice from several, drawn as checkboxes.
 *
 * ## Why this is a `[ONE]` type today, and looks like a radio
 *
 * M14.1 describes `checkbox` as `one | many` — a yes/no toggle at `one`, a
 * multi-select at `many`. Only `one` is registered, because
 * `Engine\SelectionResolver` requires a **scalar** selection and answers
 * `ERROR_NOT_SCALAR` for the array a multi-select posts. Registering `many`
 * before that path exists would let a merchant author an option the storefront
 * refuses at add-to-cart.
 *
 * So each input carries the **same** `name`, exactly as a radio group does: the
 * browser submits one value, and the resolver receives the scalar it requires.
 * When the array path lands, the `many` case gets `name="…[]"` and this template
 * branches on cardinality — the one place it will need to.
 *
 * ⚠️ **A checkbox is not self-deselecting.** Unlike a radio, clicking a checked
 * box unchecks it, so a `[ONE]` group can legitimately submit *nothing*. That is
 * correct for an optional option and refused by `required` for a mandatory one —
 * which is why `required` sits on every input rather than on the fieldset.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/checkbox.php`.
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

/*
 * Guidance blocks and the `aria-describedby` that points at them, from the one
 * helper every template shares. `description` and `help_text` are **both**
 * published by the API; each template used to associate only the first, so help
 * text rendered nowhere at all — see `OptionView`.
 */
$optionia_guidance = OptionView::guidance( $optionia_option );
$optionia_display  = OptionView::display( $optionia_option );
$optionia_describe = OptionView::described_by( $optionia_option );
?>
<div class="optionia-option optionia-option--checkbox optionia-option--cols-<?php echo esc_attr( (string) $optionia_display['columns'] ); ?><?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>" data-optionia="option" data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>">
	<?php
	/*
	 * A `fieldset` for the same reason radio uses one: several inputs form a
	 * single question, and a `<label>` on one box names that box rather than the
	 * question a screen reader needs announced.
	 */
	?>
	<fieldset
		class="optionia-option__field"
		<?php echo $optionia_required ? ' aria-required="true"' : ''; ?>
		<?php echo '' !== $optionia_describe ? ' aria-describedby="' . esc_attr( $optionia_describe ) . '"' : ''; ?>
	>
		<legend class="optionia-option__label">
			<?php echo esc_html( (string) ( $optionia_option['label'] ?? '' ) ); ?>
			<?php if ( $optionia_required ) : ?>
				<span class="optionia-option__required" aria-hidden="true">*</span>
				<span class="screen-reader-text"><?php esc_html_e( '(required)', 'optionia' ); ?></span>
			<?php endif; ?>
		</legend>

		<?php foreach ( $optionia_guidance as $optionia_block ) : ?>
			<p class="<?php echo esc_attr( $optionia_block['class'] ); ?>" id="<?php echo esc_attr( $optionia_block['id'] ); ?>">
				<?php echo esc_html( $optionia_block['text'] ); ?>
			</p>
		<?php endforeach; ?>

		<?php
		foreach ( $optionia_values as $optionia_index => $optionia_value ) {
			if ( ! is_array( $optionia_value ) || ! isset( $optionia_value['value_key'] ) ) {
				continue;
			}

			$optionia_key      = (string) $optionia_value['value_key'];
			$optionia_input_id = 'optionia-' . $optionia_id . '-' . sanitize_key( $optionia_key );

			/*
			 * Only `fixed` is emitted as a number a client may total. The other
			 * four price types each need a rounding decision `PRICING-SPEC.md`
			 * has not made, and a storefront guessing would show a figure the
			 * server disagrees with. The *type* is emitted regardless, so the
			 * runtime can tell "adds nothing" from "cannot be priced here yet".
			 */
			$optionia_price  = isset( $optionia_value['price_config'] ) && is_array( $optionia_value['price_config'] )
				? $optionia_value['price_config']
				: array();
			$optionia_ptype  = isset( $optionia_price['type'] ) ? (string) $optionia_price['type'] : '';
			$optionia_pminor = 'fixed' === $optionia_ptype && isset( $optionia_price['amount_minor'] )
				? (int) $optionia_price['amount_minor']
				: null;
			?>
			<label class="optionia-value" for="<?php echo esc_attr( $optionia_input_id ); ?>">
				<input
					type="checkbox"
					id="<?php echo esc_attr( $optionia_input_id ); ?>"
					name="<?php echo esc_attr( $optionia_field ); ?>"
					value="<?php echo esc_attr( $optionia_key ); ?>"
					data-optionia="value"
					<?php if ( '' !== $optionia_ptype ) : ?>
						data-optionia-price-type="<?php echo esc_attr( $optionia_ptype ); ?>"
					<?php endif; ?>
					<?php if ( null !== $optionia_pminor ) : ?>
						data-optionia-price="<?php echo esc_attr( (string) $optionia_pminor ); ?>"
					<?php endif; ?>
					<?php checked( ! empty( $optionia_value['is_default'] ) ); ?>
					<?php echo $optionia_required ? ' required' : ''; ?>
				/>
				<span class="optionia-value__label"><?php echo esc_html( (string) ( $optionia_value['label'] ?? $optionia_key ) ); ?></span>
			</label>
			<?php
			unset( $optionia_index );
		}
		?>
	</fieldset>
</div>
