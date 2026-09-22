<?php
/**
 * A heading between controls.
 *
 * ## Why a `<p>` and not an `<h3>`
 *
 * ⚠️ **The block is already inside a `<fieldset>` with a `<legend>`.** A heading
 * element here would open a new document section *inside* the group's own
 * labelled region, so a screen reader's heading list would gain entries that sit
 * below a legend describing them — two competing structures for one block. Worse,
 * the level is unknowable: the plugin cannot see whether the theme's product
 * title is an `h1` or an `h2`, so any fixed level risks skipping one, which is a
 * WCAG 1.3.1 failure.
 *
 * So this renders as styled text with `role="presentation"` deliberately absent:
 * the text still needs to be *read*, it just must not claim to be structure it
 * cannot verify. Merchants who want real headings can override this file, where
 * they know their own theme's levels.
 *
 * Overridable at `{theme}/woocommerce/optionia/presentational/heading.php`.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: item.
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

$optionia_item    = isset( $optionia['item'] ) && is_array( $optionia['item'] ) ? $optionia['item'] : array();
$optionia_content = isset( $optionia_item['content'] ) ? (string) $optionia_item['content'] : '';

// The API refuses a blank heading, but a document can be older than that rule.
if ( '' === trim( $optionia_content ) ) {
	return;
}

unset( $optionia_item );
?>
<p class="optionia-item optionia-item--heading" data-optionia="item"><?php echo esc_html( $optionia_content ); ?></p>
