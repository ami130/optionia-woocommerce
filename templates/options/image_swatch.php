<?php
/**
 * An image swatch: one choice from several, each drawn as its image.
 *
 * The same option as `radio` — same axes, same values, same pricing — with a
 * thumbnail in place of a radio dot. `option_values.imageUrl` has existed since
 * Phase 5's schema and reaches the storefront as `image_url`, so this template
 * needed no schema work: it reads a field that was already published.
 *
 * ## The label is not decoration
 *
 * ⚠️ **An image alone is not an accessible choice**, and a thumbnail may fail to
 * load. The value's label is always rendered beside it and never replaced by the
 * image — so the `alt` is deliberately **empty**: the image repeats what the
 * label already says, and announcing the filename twice is noise.
 *
 * `loading="lazy"` because a swatch grid can hold dozens of thumbnails, and
 * AC3's rule is that nothing about options delays a product page.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/image_swatch.php`.
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
$optionia_styles   = OptionView::styles( $optionia_option );
$optionia_describe = OptionView::described_by( $optionia_option );
?>
<div class="optionia-option optionia-option--image-swatch optionia-option--cols-<?php echo esc_attr( (string) $optionia_display['columns'] ); ?> optionia-option--swatch-<?php echo esc_attr( $optionia_display['swatch_size'] ); ?><?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>" data-optionia="option" data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>"<?php echo '' !== $optionia_styles ? ' style="' . esc_attr( $optionia_styles ) . '"' : ''; ?>>
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
			 * A URL is merchant input reaching `src`, so it goes through
			 * `esc_url` — which strips `javascript:` and other non-http schemes
			 * rather than trusting the stored value. An empty result means the
			 * URL was unusable, and no image is drawn.
			 */
			$optionia_src   = isset( $optionia_value['image_url'] ) ? esc_url( (string) $optionia_value['image_url'] ) : '';
			$optionia_valid = '' !== $optionia_src;

			$optionia_price  = isset( $optionia_value['price_config'] ) && is_array( $optionia_value['price_config'] )
				? $optionia_value['price_config']
				: array();
			$optionia_ptype  = isset( $optionia_price['type'] ) ? (string) $optionia_price['type'] : '';
			$optionia_pminor = 'fixed' === $optionia_ptype && isset( $optionia_price['amount_minor'] )
				? (int) $optionia_price['amount_minor']
				: null;
			?>
			<label class="optionia-value optionia-value--swatch" for="<?php echo esc_attr( $optionia_input_id ); ?>">
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
				<?php if ( $optionia_valid ) : ?>
					<img
						class="optionia-value__swatch"
						src="<?php echo esc_url( $optionia_src ); ?>"
						alt=""
						loading="lazy"
					/>
				<?php endif; ?>
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
