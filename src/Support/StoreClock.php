<?php
/**
 * Today, in the merchant's own timezone.
 *
 * ## Why this exists at all
 *
 * `Engine\SelectionResolver` has no clock, deliberately: it is a pure function
 * shared with a TypeScript twin, and a function that reads the time is one that
 * cannot be tested against fixtures. But `lead_time_days` and
 * `max_advance_days` are relative to *today*, so something has to answer.
 *
 * ## Why the store's timezone rather than the server's or the customer's
 *
 * A workshop in Auckland and one in Los Angeles disagree about what day it is
 * for twenty-one hours out of every twenty-four. A lead time is a promise about
 * the **merchant's** working days — "we need three days to make this" — so the
 * merchant's calendar is the one that decides.
 *
 * The customer's timezone would be wrong for the same reason: a customer in
 * Sydney ordering from a London workshop does not shorten London's lead time by
 * being ahead.
 *
 * ⚠️ **Read from WordPress rather than published in the config document.**
 * WordPress already knows the site's timezone, and it is the thing a merchant
 * changes in their own settings. A copy in the document would be a second source
 * that drifts the moment they change it — and the plugin would keep enforcing
 * yesterday's answer until the next publish.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Support;

defined( 'ABSPATH' ) || exit;

/**
 * The store's calendar.
 */
final class StoreClock {

	/**
	 * Today as `Y-m-d` in the store's timezone, or null when it cannot be known.
	 *
	 * Null rather than a fallback to the server's date: the relative date rules
	 * treat null as *"these rules do not apply"*, which is the safe direction. A
	 * guessed date would refuse a customer's booking on the strength of a
	 * timezone nobody chose.
	 */
	public static function today(): ?string {
		if ( ! function_exists( 'wp_date' ) ) {
			return null;
		}

		$today = wp_date( 'Y-m-d' );

		// `wp_date` answers false when the timezone is unreadable.
		return is_string( $today ) && '' !== $today ? $today : null;
	}
}
