<?php
/**
 * Tells a merchant that some of their options are not being charged for.
 *
 * The cloud's schema publishes five price types — `fixed`, `percentage`,
 * `per_unit`, `per_char`, `tiered` — and this build's evaluator implements the
 * subset named by `Engine\SelectionResolver::PRICED_TYPES`. An option of any
 * other type contributes **nothing** to the line total.
 *
 * ⚠️ **The message names what is NOT charged, never what is.** It read *"this
 * version can only price fixed-amount options"* until M16.1 made that false, and
 * the sentence was wrong for a merchant reading it about a `tiered` option while
 * their percentages charged correctly. A notice that misdescribes the build
 * teaches merchants to disregard it, and the next one is the one that matters.
 *
 * The implemented list is deliberately **not** interpolated in its place. It
 * would be a third statement of something two other places already state, and
 * the merchant's question is "why is this option free?" -- which the unpriced
 * list answers and the implemented list does not.
 *
 * That is the right arithmetic. Guessing at an unimplemented type would be
 * worse, and refusing the whole document would take a working storefront down
 * over a publish it can otherwise mostly honour. It is also, from the merchant's
 * side, indistinguishable from an option they deliberately made free.
 *
 * Measured before this notice existed: a 50% surcharge configured on an £80
 * product charged £80.00. The merchant lost £40 a unit, every unit, and nothing
 * in the plugin said so — no notice, no log, no failing test. Correct by scope
 * and still a silent undercharge, which is the worst combination a pricing
 * system can have: the code is behaving as designed and the money is wrong.
 *
 * Deliberately parallel to `SchemaNotice`, which exists for the same shape of
 * problem — the plugin quietly doing less than the cloud asked, while everything
 * looks healthy.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Config\Repository;

defined( 'ABSPATH' ) || exit;

/**
 * An admin notice for option types this build cannot price.
 */
final class UnpricedTypesNotice {

	/**
	 * Register the notice.
	 */
	public function register(): void {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Show the notice when — and only when — the stored document has one.
	 */
	public function render(): void {
		if ( ! Request::user_can_manage() ) {
			return;
		}

		$entry = Repository::unpriced_types();

		if ( null === $entry ) {
			return;
		}

		$types = isset( $entry['price_types'] ) && is_array( $entry['price_types'] )
			? implode( ', ', array_map( 'sanitize_text_field', $entry['price_types'] ) )
			: '';

		if ( '' === $types ) {
			return;
		}

		/**
		 * Warning, not error — but stronger wording than `SchemaNotice`.
		 *
		 * Nothing is broken and the shop is selling, so an error notice would
		 * send a merchant looking for an outage that is not happening. But the
		 * consequence here is money rather than staleness, and a merchant who
		 * skims this and moves on keeps undercharging — so the notice says what
		 * is happening to their prices, not just that something is unsupported.
		 */
		printf(
			'<div class="notice notice-warning"><p><strong>%s</strong> %s <a href="%s">%s</a></p></div>',
			esc_html__( 'Optionia is not charging for some of your options.', 'optionia' ),
			esc_html(
				sprintf(
					/* translators: %s: comma-separated list of price types, e.g. "per_unit, tiered". */
					__( 'Options priced by %s are being added to the cart for free, because this version cannot charge for them. Update the plugin to charge for them.', 'optionia' ),
					$types
				)
			),
			esc_url( admin_url( 'plugins.php' ) ),
			esc_html__( 'Update plugins', 'optionia' )
		);
	}

	/**
	 * Whether a merchant is currently being told about unpriced options.
	 *
	 * Read by System Status, so the support screen and the notice cannot
	 * disagree about whether this shop is undercharging.
	 */
	public static function is_showing(): bool {
		return null !== Repository::unpriced_types();
	}
}
