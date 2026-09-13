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
	<?php
	foreach ( $optionia_groups as $optionia_group ) :
		$optionia_type  = (string) ( $optionia_group['display_type'] ?? 'inline' );
		$optionia_fold  = 'accordion' === $optionia_type || ! empty( $optionia_group['is_collapsible'] );
		$optionia_title = (string) ( $optionia_group['label'] ?? '' );
		$optionia_desc  = (string) ( $optionia_group['description'] ?? '' );

		/*
		 * 🔴 **A folded group needs a heading to fold behind.** `<summary>` is
		 * the control that opens a `<details>`, so a group with no label would
		 * render an empty, unlabelled click target — worse than not folding.
		 * Falls back to laying it out plainly, which is what it did before.
		 */
		$optionia_fold = $optionia_fold && '' !== $optionia_title;
		?>
		<fieldset
			class="optionia-group optionia-group--<?php echo esc_attr( $optionia_type ); ?>"
			data-optionia="group"
			data-optionia-group="<?php echo esc_attr( (string) ( $optionia_group['id'] ?? '' ) ); ?>"
			data-optionia-display="<?php echo esc_attr( $optionia_type ); ?>"
		>
			<?php
			/*
			 * 🔴 **`data-optionia-group` stays on the `<fieldset>`, whatever the
			 * layout.** The rule runtime sets `hidden` on the element carrying
			 * that attribute, so moving it inside a `<details>` would let a rule
			 * hide a group's *contents* while its heading stayed on the page —
			 * a fieldset legend for options nobody can reach.
			 *
			 * ⚠️ **A `<legend>` must be the first child of its `<fieldset>`**,
			 * which is why the folded branch does not use one: `<summary>` is
			 * the heading there, and a `<legend>` inside `<details>` would be
			 * neither valid nor announced as the group's name.
			 */
			if ( $optionia_fold ) :
				?>
				<details class="optionia-group__fold"<?php echo 'accordion' === $optionia_type ? '' : ' open'; ?>>
					<summary class="optionia-group__label optionia-group__summary"><?php echo esc_html( $optionia_title ); ?></summary>

					<?php if ( '' !== $optionia_desc ) : ?>
						<p class="optionia-group__description"><?php echo esc_html( $optionia_desc ); ?></p>
					<?php endif; ?>

					<?php
					// Built by the renderer from each option's own type template,
					// which escapes its own output.
					echo $optionia_group['options']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
					?>
				</details>
			<?php else : ?>
				<?php if ( '' !== $optionia_title ) : ?>
					<legend class="optionia-group__label"><?php echo esc_html( $optionia_title ); ?></legend>
				<?php endif; ?>

				<?php if ( '' !== $optionia_desc ) : ?>
					<p class="optionia-group__description"><?php echo esc_html( $optionia_desc ); ?></p>
				<?php endif; ?>

				<?php
				// Built by the renderer from each option's own type template,
				// which escapes its own output.
				echo $optionia_group['options']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
				?>
			<?php endif; ?>
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
	<?php
	/*
	 * 🔴 **What a rule did, for a customer who cannot see it happen (M17.5).**
	 *
	 * A rule showing or hiding an option changes the form under someone using a
	 * screen reader, and silence is indistinguishable from nothing having
	 * happened. Measured before this existed: options appeared and vanished with
	 * no announcement at all.
	 *
	 * ⚠️ **`screen-reader-text`, not `hidden`.** A `hidden` live region is
	 * removed from the accessibility tree, so nothing in it is ever announced —
	 * the estimate above can be `hidden` because a sighted customer reads it, and
	 * this one exists solely to be spoken.
	 *
	 * `polite` rather than `assertive`: the customer is mid-form, and a rule
	 * firing is information rather than an interruption.
	 */
	?>
	<p class="screen-reader-text" data-optionia="rule-status" role="status" aria-live="polite"></p>
	<p class="optionia-estimate__note"><?php esc_html_e( 'Estimated options total. The final price is confirmed at checkout.', 'optionia' ); ?></p>
</div>
