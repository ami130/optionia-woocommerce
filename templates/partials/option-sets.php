<?php
/**
 * Every option group applying to one product.
 *
 * Overridable at `{theme}/woocommerce/optionia/partials/option-sets.php`.
 *
 * Receives groups whose options are already rendered: `Frontend\Renderer` builds
 * each control from its own type template, so this file lays out the block and
 * nothing more. A template gets a prepared view-model and no services.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: product_id, groups.
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

$optionia_groups = isset( $optionia['groups'] ) && is_array( $optionia['groups'] ) ? $optionia['groups'] : array();

if ( array() === $optionia_groups ) {
	return;
}
?>
<div class="optionia-options" data-optionia="options" data-optionia-product="<?php echo esc_attr( (string) ( $optionia['product_id'] ?? '' ) ); ?>">
	<?php foreach ( $optionia_groups as $optionia_group ) : ?>
		<fieldset class="optionia-group" data-optionia="group" data-optionia-group="<?php echo esc_attr( (string) ( $optionia_group['id'] ?? '' ) ); ?>">
			<?php if ( '' !== (string) ( $optionia_group['label'] ?? '' ) ) : ?>
				<legend class="optionia-group__label"><?php echo esc_html( (string) $optionia_group['label'] ); ?></legend>
			<?php endif; ?>

			<?php if ( '' !== (string) ( $optionia_group['description'] ?? '' ) ) : ?>
				<p class="optionia-group__description"><?php echo esc_html( (string) $optionia_group['description'] ); ?></p>
			<?php endif; ?>

			<?php
			// Built by the renderer from each option's own type template, which
			// escapes its own output.
			echo $optionia_group['options']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			?>
		</fieldset>
	<?php endforeach; ?>

	<?php
	/*
	 * Where the running estimate is written.
	 *
	 * Rendered hidden and empty: the server has not been asked anything yet, and
	 * a total that appears before a customer has chosen is a number nobody
	 * requested. The runtime unhides it once a priced value is selected.
	 *
	 * `aria-live="polite"` so a screen reader announces the new total after the
	 * selection it followed, rather than interrupting it. `role="status"` gives
	 * the same meaning to readers that do not honour `aria-live` on a plain div.
	 *
	 * Marked an estimate in the markup, not only in the script: AC4 makes the
	 * server authoritative, and a customer who has JavaScript disabled — or who
	 * reads this before the bundle parses — must not be told a price this page
	 * cannot promise.
	 */
	?>
	<p class="optionia-estimate" data-optionia="estimate" role="status" aria-live="polite" hidden></p>
	<p class="optionia-estimate__note"><?php esc_html_e( 'Estimated options total. The final price is confirmed at checkout.', 'optionia' ); ?></p>
</div>
