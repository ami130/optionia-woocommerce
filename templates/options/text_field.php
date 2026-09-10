<?php
/**
 * A text option: the customer types the value.
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
$optionia_describe = OptionView::described_by( $optionia_option );
$optionia_place    = (string) ( $optionia_option['placeholder'] ?? '' );
$optionia_default  = (string) ( $optionia_option['default_value'] ?? '' );

/*
 * The character limit, and the counter M14.4b makes **required** alongside it.
 *
 * *"Silently rejecting the 21st character of an engraving is a support ticket
 * and often an abandoned cart."* The dashboard derives `character_counter` from
 * the limit rather than offering it as a separate switch, so the two cannot
 * disagree — but this template still checks both, because a document published
 * by an older dashboard may carry one without the other.
 *
 * ⚠️ **`maxlength` here is a courtesy, not the rule.** It stops the keystroke;
 * `SelectionResolver` decides (AC4). And it counts UTF-16 code units, so an
 * emoji it treats as two `measure()` counts as one — the attribute may stop the
 * customer early, and the server is what refuses.
 */
$optionia_validation  = isset( $optionia_option['validation'] ) && is_array( $optionia_option['validation'] )
	? $optionia_option['validation']
	: array();
$optionia_raw_display = isset( $optionia_option['display'] ) && is_array( $optionia_option['display'] )
	? $optionia_option['display']
	: array();

$optionia_max = isset( $optionia_validation['max_length'] ) && is_int( $optionia_validation['max_length'] )
	&& $optionia_validation['max_length'] > 0
		? (int) $optionia_validation['max_length']
		: null;

$optionia_counter    = null !== $optionia_max && ! empty( $optionia_raw_display['character_counter'] );
$optionia_counter_id = 'optionia-count-' . $optionia_id;

/*
 * The counter is named in `aria-describedby` too, after the guidance blocks.
 *
 * A limit a screen reader never hears is the same defect as a limit with no
 * counter — the customer meets it only by being refused.
 */
if ( $optionia_counter ) {
	$optionia_describe = '' === $optionia_describe
		? $optionia_counter_id
		: $optionia_describe . ' ' . $optionia_counter_id;
}
?>
<div class="optionia-option optionia-option--text optionia-option--cols-<?php echo esc_attr( (string) $optionia_display['columns'] ); ?><?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>" data-optionia="option" data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>">
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
		type="text"
		class="optionia-option__field"
		id="<?php echo esc_attr( $optionia_input_id ); ?>"
		name="<?php echo esc_attr( $optionia_field ); ?>"
		data-optionia="value"
		value="<?php echo esc_attr( $optionia_default ); ?>"
		<?php echo '' !== $optionia_place ? ' placeholder="' . esc_attr( $optionia_place ) . '"' : ''; ?>
		<?php echo null !== $optionia_max ? ' maxlength="' . esc_attr( (string) $optionia_max ) . '"' : ''; ?>
		<?php echo null !== $optionia_max ? ' data-optionia-max="' . esc_attr( (string) $optionia_max ) . '"' : ''; ?>
		<?php echo $optionia_required ? ' required aria-required="true"' : ''; ?>
		<?php echo '' !== $optionia_describe ? ' aria-describedby="' . esc_attr( $optionia_describe ) . '"' : ''; ?>
	/>

	<?php if ( $optionia_counter ) : ?>
		<?php
		/*
		 * `aria-live="polite"` rather than `assertive`: the count changes on
		 * every keystroke, and an assertive region would interrupt the customer
		 * continuously as they type their own engraving.
		 *
		 * The initial value is rendered server-side so it is correct before any
		 * script runs — a default that reads `0/20` beside a pre-filled field
		 * would be wrong on first paint.
		 */
		$optionia_used = \Optionia\Engine\Text::measure( $optionia_default );
		?>
		<p
			class="optionia-option__counter"
			id="<?php echo esc_attr( $optionia_counter_id ); ?>"
			data-optionia="counter"
			aria-live="polite"
		>
			<span data-optionia="counter-used"><?php echo esc_html( (string) $optionia_used ); ?></span>
			<?php
			// phpcs:ignore Generic.WhiteSpace.ScopeIndent.Incorrect -- the slash must not add whitespace inside the count.
			?>
			/<span data-optionia="counter-max"><?php echo esc_html( (string) $optionia_max ); ?></span>
		</p>
	<?php endif; ?>
</div>
