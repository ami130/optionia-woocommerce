<?php
/**
 * A checkbox option: one choice from several, drawn as checkboxes.
 *
 * ## One type, two shapes, decided by `cardinality`
 *
 * M14.1 describes `checkbox` as `one | many` — a yes/no toggle at `one`, a
 * multi-select at `many` — and this template is the one place that branches on
 * it, exactly as its earlier note said it would.
 *
 * | | `one` | `many` |
 * |---|---|---|
 * | field name | `optionia[opt-id]` | `optionia[opt-id][]` |
 * | posts | a scalar | an array |
 * | `required` | on each input | **never** — see below |
 *
 * 🔴 **The `[]` is not cosmetic.** Without it every box shares one key and PHP
 * keeps only the last, so a customer checking two is charged for one and
 * nothing fails. That was the behaviour before M18.1, and it was reachable by
 * any merchant who gave a `one` checkbox two values.
 *
 * ⚠️ **A checkbox is not self-deselecting.** Unlike a radio, clicking a checked
 * box unchecks it, so a group can legitimately submit *nothing*. At `one` that
 * is correct for an optional option and refused by `required` for a mandatory
 * one, which is why the attribute sits on the input rather than the fieldset.
 *
 * 🔴 **At `many` the attribute is dropped entirely**, because HTML's `required`
 * on a checkbox means *this box*, not *one of these*. Measured on two required
 * boxes sharing a name: checking one leaves the group invalid, because the
 * browser demands both. `SelectionResolver` still answers `ERROR_REQUIRED` for
 * an unanswered required option, so what is lost is an early message, never the
 * rule.
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

/*
 * 🔴 **`many` posts an ARRAY, and the `[]` is what makes that true.**
 *
 * Without it every box shares one key, and PHP keeps only the **last** — so a
 * customer checking two is charged for one, with nothing failing. Measured
 * before this branch existed: `optionia[opt-a]=red&optionia[opt-a]=blue` parses
 * to `{"opt-a":"blue"}` and the resolver reports success on half the answer.
 *
 * ⚠️ **`one` keeps the bare name deliberately.** A yes/no toggle submits a
 * scalar, and wrapping it in an array would make every single-value checkbox a
 * one-element list for the resolver, the cart key and the order meta to carry.
 */
$optionia_many  = 'many' === (string) ( $optionia_option['cardinality'] ?? 'one' );
$optionia_field = (string) ( $optionia['field_name'] ?? 'optionia' ) . '[' . $optionia_id . ']'
	. ( $optionia_many ? '[]' : '' );

/*
 * 🔴 **`required` cannot sit on a `many` input, and the reason is HTML's.**
 *
 * `required` on a checkbox means *this box must be checked* — not *one of this
 * group*. Measured on two required boxes sharing a name: checking one leaves
 * the group **invalid**, because the browser demands both. A required
 * multi-select would be unsubmittable.
 *
 * At `one` it is still correct and still needed: a checkbox is not
 * self-deselecting, so a lone box can legitimately submit nothing, and
 * `required` is what refuses that for a mandatory option.
 *
 * ⚠️ **The server enforces it either way.** `SelectionResolver` answers
 * `ERROR_REQUIRED` for an unanswered required option whatever the browser did —
 * so dropping the attribute at `many` loses an early message, never the rule.
 */
$optionia_required = ! empty( $optionia_option['is_required'] );
$optionia_mark     = $optionia_required && ! $optionia_many;

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
					<?php echo $optionia_mark ? ' required' : ''; ?>
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
