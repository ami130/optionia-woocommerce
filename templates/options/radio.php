<?php
/**
 * A radio option: one choice from several.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/radio.php`.
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
<div class="optionia-option optionia-option--radio optionia-option--cols-<?php echo esc_attr( (string) $optionia_display['columns'] ); ?><?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>" data-optionia="option" data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>">
	<?php
	/*
	 * A `fieldset` inside the group's `fieldset`, deliberately.
	 *
	 * Radio buttons are a single control made of several inputs, and a screen
	 * reader needs the option's own label announced with each one. A `<label>`
	 * pointing at one radio would name that radio, not the question.
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

			$optionia_key = (string) $optionia_value['value_key'];

			/*
			 * 🔴 **The value's own id, for a rule that targets one value.**
			 *
			 * `value_key` is unique only **within one option**, so it cannot
			 * identify a value across a set — matching on it would let a rule
			 * hiding `large` in one option hide `large` in every other. The
			 * published document carries a value `id` since M17.8 for exactly
			 * this, and M17.9 is what reads it on the page.
			 *
			 * Emitted only when present: a document from a cloud older than
			 * M17.8 has no value ids, and an empty attribute would be a target
			 * the runtime could match by accident.
			 */
			$optionia_value_id = isset( $optionia_value['id'] ) && is_scalar( $optionia_value['id'] )
				? (string) $optionia_value['id']
				: '';
			$optionia_input_id = 'optionia-' . $optionia_id . '-' . sanitize_key( $optionia_key );

			/*
			 * Price carried on the input, so the runtime can total a selection
			 * without a second source of truth.
			 *
			 * `price_config` is `{ type, amount_minor }` -- integer minor units,
			 * never a float, for the reason `Support\Money` exists. Only `fixed`
			 * is emitted as a number a client may add up: `percentage`,
			 * `per_unit`, `per_char` and `tiered` each need a decision
			 * `docs/PRICING-SPEC.md` has not made yet, and a storefront guessing
			 * at rounding would show a total the server then disagrees with.
			 * The type is emitted regardless, so the runtime can tell "this adds
			 * nothing" from "this cannot be priced here yet".
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
					type="radio"
					id="<?php echo esc_attr( $optionia_input_id ); ?>"
					name="<?php echo esc_attr( $optionia_field ); ?>"
					value="<?php echo esc_attr( $optionia_key ); ?>"
					data-optionia="value"
					<?php if ( '' !== $optionia_value_id ) : ?>
						data-optionia-value="<?php echo esc_attr( $optionia_value_id ); ?>"
					<?php endif; ?>
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
				<?php
				/*
				 * 🔴 **The first per-choice price this plugin shows** (M18.6b).
				 * Until now a price reached the page only as
				 * `data-optionia-price` for the running estimate.
				 *
				 * ⚠️ **`aria-hidden`, because the label already carries it for a
				 * screen reader?** No — it does not, and that is why this is
				 * announced. A customer who cannot see the page must still learn
				 * that a choice costs more before they make it.
				 */
				$optionia_vprice = OptionView::value_price( $optionia_value, $optionia_display['price_display'] );
				?>
				<?php if ( '' !== $optionia_vprice ) : ?>
					<span class="optionia-value__price"><?php echo esc_html( $optionia_vprice ); ?></span>
				<?php endif; ?>
			</label>
			<?php
			unset( $optionia_index );
		}
		?>
	</fieldset>
</div>
