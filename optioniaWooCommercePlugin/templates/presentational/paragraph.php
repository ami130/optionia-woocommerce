<?php
/**
 * Explanatory copy between controls.
 *
 * ⚠️ **Escaped, not filtered.** The content is merchant-authored text and is
 * printed with `esc_html`, so `<b>bold</b>` appears literally rather than as
 * markup. That is the intended behaviour: `paragraph` is the *safe* kind, and
 * M5.4c puts markup behind `rich_text`, which is sanitizer-gated and refused by
 * the authoring API until that sanitizer exists. Allowing a subset of tags here
 * would quietly become the unsanitised path.
 *
 * Newlines are preserved with `nl2br` after escaping — never before, or the
 * inserted `<br />` would itself be escaped.
 *
 * Overridable at `{theme}/woocommerce/optionia/presentational/paragraph.php`.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: item.
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

$optionia_item    = isset( $optionia['item'] ) && is_array( $optionia['item'] ) ? $optionia['item'] : array();
$optionia_content = isset( $optionia_item['content'] ) ? (string) $optionia_item['content'] : '';

if ( '' === trim( $optionia_content ) ) {
	return;
}

unset( $optionia_item );
?>
<p class="optionia-item optionia-item--paragraph" data-optionia="item">
	<?php
	// Escaped first; `nl2br` then adds only `<br />` to already-safe text.
	echo nl2br( esc_html( $optionia_content ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	?>
</p>
