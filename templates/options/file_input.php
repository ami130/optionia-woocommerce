<?php
/**
 * A file the customer uploads (M15.2).
 *
 * ## Why this renders two controls, not one
 *
 * 🔴 **The `<input type="file">` is never submitted with the form.** The file is
 * uploaded first, over `POST /optionia/v1/upload`, and what reaches add-to-cart
 * is the **token** in the hidden field beside it — never a path, never a
 * filename. That is AC4's rule applied to a file: the browser may send
 * identifiers only.
 *
 * ⚠️ **The file input therefore has no `name`.** A named file input would ride
 * the add-to-cart POST as `$_FILES`, which is exactly the design ADR-040
 * rejected: measured, WooCommerce's add-to-cart form carries **no nonce** and
 * reads its input under `phpcs:ignore …NonceVerification`, so riding it buys no
 * protection while costing a progress bar and re-posting the whole form on a
 * failed 20 MB upload.
 *
 * ⚠️ **`required` sits on the hidden token field, not on the file input.** The
 * browser's own validation must fire when no *token* exists — a customer who
 * chose a file whose upload failed has an empty token and must be stopped, and
 * one whose upload succeeded may have since cleared the file input without
 * losing their upload.
 *
 * ## What the merchant configured, and who enforces it
 *
 * `accepted_types` reaches the `accept` attribute as a courtesy — it filters the
 * file picker and stops a customer choosing a `.docx` for an artwork field. It
 * is **not** the boundary: the server re-checks by content (M15.3), because an
 * `accept` attribute is a hint a browser may ignore and an attacker will.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/file_input.php`.
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

// Id only: a file option has no values, which is the normal case.
if ( '' === $optionia_id ) {
	return;
}

$optionia_field    = (string) ( $optionia['field_name'] ?? 'optionia' ) . '[' . $optionia_id . ']';
$optionia_required = ! empty( $optionia_option['is_required'] );
$optionia_input_id = 'optionia-' . $optionia_id;

$optionia_guidance = OptionView::guidance( $optionia_option );
$optionia_display  = OptionView::display( $optionia_option );
$optionia_describe = OptionView::described_by( $optionia_option );

$optionia_rules = isset( $optionia_option['validation'] ) && is_array( $optionia_option['validation'] )
	? $optionia_option['validation']
	: array();

/*
 * The picker filter, built from the merchant's accepted types.
 *
 * Extensions rather than MIME types: a `.ai` file reports `application/pdf`, so
 * a MIME-based `accept` would offer the customer every PDF and reject the one
 * format the option actually wants.
 */
$optionia_accept = '';

if ( isset( $optionia_rules['accepted_types'] ) && is_array( $optionia_rules['accepted_types'] ) ) {
	$optionia_exts = array();

	foreach ( $optionia_rules['accepted_types'] as $optionia_ext ) {
		if ( is_scalar( $optionia_ext ) ) {
			$optionia_clean = preg_replace( '/[^a-z0-9]/', '', strtolower( (string) $optionia_ext ) );

			if ( '' !== (string) $optionia_clean ) {
				$optionia_exts[] = '.' . $optionia_clean;
			}
		}
	}

	$optionia_accept = implode( ',', $optionia_exts );
	unset( $optionia_exts, $optionia_ext, $optionia_clean );
}

$optionia_max_mb = isset( $optionia_rules['max_size_mb'] ) && is_numeric( $optionia_rules['max_size_mb'] )
	? (int) $optionia_rules['max_size_mb']
	: 0;

// Captured before the unset below, as every other template does.
$optionia_label = (string) ( $optionia_option['label'] ?? '' );

unset( $optionia_option, $optionia_rules );
?>
<div
	class="optionia-option optionia-option--file<?php echo $optionia_display['collapsed'] ? ' optionia-option--collapsed' : ''; ?>"
	data-optionia="option"
	data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>"
	data-optionia-upload="1"
	<?php if ( $optionia_max_mb > 0 ) : ?>
		data-optionia-max-mb="<?php echo esc_attr( (string) $optionia_max_mb ); ?>"
	<?php endif; ?>
>
	<label class="optionia-option__label" for="<?php echo esc_attr( $optionia_input_id ); ?>">
		<?php echo esc_html( $optionia_label ); ?>
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

	<?php
	/*
	 * No `name`: this control never reaches the server. The runtime reads the
	 * chosen file, uploads it, and writes the returned token to the hidden field
	 * below — which is what add-to-cart posts.
	 */
	?>
	<input
		type="file"
		class="optionia-option__field"
		id="<?php echo esc_attr( $optionia_input_id ); ?>"
		data-optionia="file"
		<?php echo '' !== $optionia_accept ? ' accept="' . esc_attr( $optionia_accept ) . '"' : ''; ?>
		<?php echo '' !== $optionia_describe ? ' aria-describedby="' . esc_attr( $optionia_describe ) . '"' : ''; ?>
	/>

	<?php
	/*
	 * Where the upload's outcome is announced.
	 *
	 * `aria-live="polite"` so a screen reader hears "uploaded" after the action
	 * that caused it rather than interrupting; `role="status"` gives the same
	 * meaning to readers that ignore `aria-live` on a plain element.
	 *
	 * Rendered empty rather than hidden: a customer who has chosen nothing has
	 * nothing to be told, and an element that appears mid-interaction moves the
	 * page under them.
	 */
	?>
	<p class="optionia-option__upload-status" data-optionia="upload-status" role="status" aria-live="polite"></p>

	<?php
	/*
	 * The token, and the only part of this option the server ever sees.
	 *
	 * `required` lives here rather than on the file input so the browser refuses
	 * a submit when no *upload completed*, which is the condition that matters —
	 * a chosen file whose upload failed leaves this empty.
	 */
	?>
	<input
		type="hidden"
		name="<?php echo esc_attr( $optionia_field ); ?>"
		value=""
		data-optionia="value"
		<?php echo $optionia_required ? ' required aria-required="true"' : ''; ?>
	/>
</div>
