<?php
/**
 * A value the merchant sets and the customer never sees.
 *
 * ## Why this renders almost nothing
 *
 * 🔴 **The input is not the source of truth, and must not look like one.**
 *
 * `Engine\SelectionResolver` ignores whatever is posted for a hidden option and
 * uses the merchant's `default_value` instead — because a hidden field is hidden
 * from the *page*, not from the customer, and anyone with developer tools can
 * post whatever they like. Measured before that branch existed: a forged value
 * replaced the merchant's own.
 *
 * So why render an input at all? Because WooCommerce's cart and reorder paths
 * round-trip the posted fields, and an option absent from the form is an option
 * some of those paths cannot see. The input carries the value for continuity;
 * the server carries the truth.
 *
 * ⚠️ **No label, no description, no counter.** Every other template announces
 * itself to a screen reader; this one deliberately does not, because there is
 * nothing for a customer to do and a label with no control is noise.
 *
 * Overridable at `{theme}/woocommerce/optionia/options/hidden.php`.
 *
 * @package Optionia
 *
 * @var array<string, mixed> $optionia View model: option, field_name.
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

$optionia_option = isset( $optionia['option'] ) && is_array( $optionia['option'] ) ? $optionia['option'] : array();
$optionia_id     = isset( $optionia_option['id'] ) ? (string) $optionia_option['id'] : '';

if ( '' === $optionia_id ) {
	return;
}

$optionia_field   = (string) ( $optionia['field_name'] ?? 'optionia' ) . '[' . $optionia_id . ']';
$optionia_default = (string) ( $optionia_option['default_value'] ?? '' );

// Nothing configured means nothing to carry.
if ( '' === $optionia_default ) {
	return;
}

unset( $optionia_option );
?>
<?php
/*
 * 🔴 **`data-optionia-option` is on the input itself, and M17.9 needs it.**
 *
 * Every other type wraps its controls in a `<div data-optionia-option>`; a
 * hidden field has nothing to show, so wrapping it would put an empty box in
 * the layout. `file_input.php` carries the attribute on its own element for the
 * same reason, and this follows it.
 *
 * ⚠️ **Without it the storefront runtime cannot see this field at all.** A rule
 * reading a hidden field — *"apply when the campaign tag is `spring`"* — would
 * evaluate against nothing in the browser while the server evaluates against
 * the merchant's configured value, and the page would show an option the server
 * has hidden. Found by the 17-9 audit.
 *
 * The value is the merchant's `default_value`, which is the same thing
 * `SelectionResolver::rule_answers()` substitutes server-side — so both ends
 * read one value, not two.
 */
?>
<input
	type="hidden"
	name="<?php echo esc_attr( $optionia_field ); ?>"
	value="<?php echo esc_attr( $optionia_default ); ?>"
	data-optionia="value"
	data-optionia-option="<?php echo esc_attr( $optionia_id ); ?>"
/>
