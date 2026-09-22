<?php
/**
 * A calendar day: a wedding, a delivery date.
 *
 * ## Why a native picker
 *
 * A native date input gives every platform its own calendar — the one the customer already knows how to use, localised, and reachable by keyboard without us building any of it.
 *
 * ⚠️ **The attributes below are a courtesy, not the rule.** A browser refuses an
 * out-of-range date before submit; `SelectionResolver` decides (AC4), and it
 * re-checks the blackout list and weekday rules a browser knows nothing about.
 *
 * ## Why `type="date"` rather than a text input
 *
 * The mobile keyboard is the reason. A numeric input shows a number pad, which
 * is the difference between a customer typing a quantity easily and hunting for
 * digits behind a symbol key. `min`, `max` and `step` also give the browser
 * enough to offer steppers and refuse an out-of-range value before submit.
 *
 * ⚠️ **None of that is enforcement.** `SelectionResolver` re-validates every
 * bound server-side (AC4) — the attributes here are a courtesy that stops a
 * mistake early, and a request that skips the page entirely is still refused.
 *
 * ## Why this is not shaped like the choice templates
 *
 * Every other template in this directory early-returns when the option has no
 * values:
 *
 *     if ( '' === $optionia_id || array() === $optionia_values ) { return; }
 *
 * For a text field that guard is **exactly wrong** — a text option legitimately
 * has no values (`takesValues: false` in the API registry, and the publish check
 * skips it for that reason). Copying the idiom would render nothing at all, so
 * the guard here is id-only.
 *
 * ## Why there is no price attribute
 *
 * A choice carries `data-optionia-price` on the element the customer picks, and
 * the storefront estimate sums them. Text has no per-value price: its pricing
 * model is `per_char`, which is computed server-side from
 * `Engine\Text::measure()` and deliberately not previewed, because a client-side
 * count that disagreed with the server's is the M14.4b credibility bug this
 * project exists to avoid.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/text_field.php`.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: option, field_name.
 */

declare( strict_types=1 );

use Optionia\Frontend\OptionView;

defined( 'ABSPATH' ) || exit;

$optionia_option = isset( $optionia['option'] ) && is_array( $optionia['option'] ) ? $optionia['option'] : array();
$optionia_id     = isset( $optionia_option['id'] ) ? (string) $optionia_option['id'] : '';

// Id only: a text option with no values is the normal case, not a broken one.
if ( '' === $optionia_id ) {
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
$optionia_styles   = OptionView::styles( $optionia_option );
$optionia_describe = OptionView::described_by( $optionia_option );
$optionia_place    = (string) ( $optionia_option['placeholder'] ?? '' );
$optionia_default  = (string) ( $optionia_option['default_value'] ?? '' );

/*
 * The numeric bounds, published as `min` / `max` / `step`.
 *
 * ⚠️ **No character counter here.** M14.4b ties one to `max_length`, which
 * bounds a *length*; a number's `max` bounds its *value*, and counting the
 * digits of a quantity tells a customer nothing they need. The browser's own
 * steppers are the affordance a numeric field gets instead.
 */
$optionia_validation = isset( $optionia_option['validation'] ) && is_array( $optionia_option['validation'] )
	? $optionia_option['validation']
	: array();

$optionia_min = isset( $optionia_validation['min'] ) && is_numeric( $optionia_validation['min'] )
	? (string) $optionia_validation['min']
	: '';
$optionia_max = isset( $optionia_validation['max'] ) && is_numeric( $optionia_validation['max'] )
	? (string) $optionia_validation['max']
	: '';

?>
<div class="optionia-option optionia-option--date-picker optionia-option--cols-<?php echo esc_attr( (string) $optionia_display['columns'] ); ?><?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>" data-optionia="option" data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>"<?php echo '' !== $optionia_styles ? ' style="' . esc_attr( $optionia_styles ) . '"' : ''; ?>>
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

	<input
		type="date"
		class="optionia-option__field"
		id="<?php echo esc_attr( $optionia_input_id ); ?>"
		name="<?php echo esc_attr( $optionia_field ); ?>"
		data-optionia="value"
		value="<?php echo esc_attr( $optionia_default ); ?>"
		<?php echo '' !== $optionia_min ? ' min="' . esc_attr( $optionia_min ) . '"' : ''; ?>
		<?php echo '' !== $optionia_max ? ' max="' . esc_attr( $optionia_max ) . '"' : ''; ?>
		<?php echo $optionia_required ? ' required aria-required="true"' : ''; ?>
		<?php echo '' !== $optionia_describe ? ' aria-describedby="' . esc_attr( $optionia_describe ) . '"' : ''; ?>
	/>

</div>
