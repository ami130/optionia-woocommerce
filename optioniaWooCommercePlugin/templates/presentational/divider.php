<?php
/**
 * A rule between controls.
 *
 * ⚠️ **`<hr>` with `aria-hidden`.** A horizontal rule is a separator with
 * semantics — some screen readers announce it — and this one carries no
 * information a customer needs: it is a visual break inside a form the
 * `<fieldset>` already delimits. Announcing it interrupts the run of controls
 * for nothing.
 *
 * Its `content` is ignored rather than rendered. The API allows a divider's
 * content to be empty, and a document that carries text on one is malformed or
 * from a future schema; drawing it would put unlabelled text in the form.
 *
 * Overridable at `{theme}/woocommerce/optionia/presentational/divider.php`.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: item.
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

use Optionia\Frontend\OptionView;

$optionia_item  = isset( $optionia['item'] ) && is_array( $optionia['item'] ) ? $optionia['item'] : array();
$optionia_style = OptionView::divider_style( $optionia_item );

unset( $optionia_item );
?>
<hr
	class="optionia-item optionia-item--divider optionia-item--divider-<?php echo esc_attr( $optionia_style ); ?>"
	data-optionia="item"
	aria-hidden="true"
/>
