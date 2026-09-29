<?php
/**
 * Counts which options a customer saw, without ever blocking a page (M25.1).
 *
 * ## Why this exists at all
 *
 * 🔴 **M25.3 asks for "conversion with vs. without options" and nothing recorded
 * a view.** A conversion rate needs a denominator -- of the customers who saw an
 * option, how many bought -- and the cloud holds only orders that completed. The
 * dashboard shipped average order value as an honest substitute and deliberately
 * never used the word *conversion*. This is the missing half.
 *
 * ## Why a count and not an event
 *
 * 🔴 **A view is every product page load; an order is roughly one per fifty.**
 * Reusing `OrderReporter`'s queue -- an append per event -- would write a
 * thousand rows per thousand views into `wp_options`, a table every other plugin
 * on the site also locks, in the request the customer is waiting on. Phase 25's
 * exit criterion says *"ingestion never affects storefront performance"*, and
 * that design would break it on the merchant's own server.
 *
 * So the beacon increments an integer. A day's looking is one number per option,
 * however many customers looked.
 *
 * ## What bounds abuse, since the nonce does not
 *
 * ⚠️ **The nonce is a filter, not a credential**, exactly as `UploadEndpoint`
 * records: every guest holds the same value for 24 hours, so it refuses a
 * request that never loaded a page and nothing more. The real bound is
 * `MAX_PER_OPTION`: a forged beacon can inflate a count only to a ceiling the
 * customer could have reached by reloading the page anyway, and the cloud
 * refuses anything past its own limit regardless.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Analytics;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Accumulates option view counts in an option, for the cron drain to send.
 */
final class ViewCollector {

	/**
	 * The most any one option may accumulate between two drains.
	 *
	 * 🔴 **This is the abuse bound, not a storage bound.** A quarter-hourly drain
	 * and a busy shop is thousands of views, not a hundred thousand -- so a count
	 * past this is a forged beacon or a bug, and either way adding it would
	 * corrupt a merchant's conversion rate with no way to tell which day was
	 * wrong. Matches the cloud's own ceiling so the plugin never sends something
	 * the API will refuse.
	 */
	private const MAX_PER_OPTION = 1000000;

	/**
	 * The most (set, option, day) pairs held at once.
	 *
	 * ⚠️ **A store that has been offline for weeks must not grow this without
	 * limit.** The option is read and rewritten whole on every flush, so an
	 * unbounded array would make each flush slower than the last -- the failure
	 * mode this class exists to avoid, arriving by a different route.
	 */
	private const MAX_PAIRS = 500;

	/**
	 * Add views to the running counts.
	 *
	 * ⚠️ **Read-modify-write, and deliberately not transactional.** Two
	 * simultaneous beacons can lose one increment, and that is the right trade:
	 * a lock here would put contention in a request a customer is waiting on, to
	 * protect a number whose whole purpose is a ratio. Losing one view in a
	 * thousand changes no decision a merchant makes.
	 *
	 * @param string               $set_id  The option set the options belong to.
	 * @param array<int, string>   $options Option keys the customer saw.
	 * @param string               $day     The store's own date, `Y-m-d`.
	 * @return int How many option keys were counted.
	 */
	public function add( string $set_id, array $options, string $day ): int {
		if ( '' === $set_id || '' === $day || array() === $options ) {
			return 0;
		}

		$counts  = $this->counts();
		$counted = 0;

		foreach ( $options as $option_key ) {
			if ( ! is_string( $option_key ) || '' === $option_key ) {
				continue;
			}

			$key = $this->pair_key( $set_id, $option_key, $day );

			if ( ! isset( $counts[ $key ] ) && count( $counts ) >= self::MAX_PAIRS ) {
				/*
				 * Full. Dropping the new pair is better than growing without
				 * bound -- and better than dropping an existing one, which would
				 * discard counts already earned.
				 */
				continue;
			}

			$current = isset( $counts[ $key ] ) ? (int) $counts[ $key ] : 0;

			if ( $current >= self::MAX_PER_OPTION ) {
				continue;
			}

			$counts[ $key ] = $current + 1;
			++$counted;
		}

		if ( $counted > 0 ) {
			$this->store( $counts );
		}

		return $counted;
	}

	/**
	 * Everything accumulated, in the shape the API accepts.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function pending(): array {
		$out = array();

		foreach ( $this->counts() as $key => $views ) {
			$parts = explode( '|', (string) $key );

			if ( 3 !== count( $parts ) ) {
				continue;
			}

			$out[] = array(
				'option_set_id' => $parts[0],
				'option_key'    => $parts[1],
				'day'           => $parts[2],
				'views'         => (int) $views,
			);
		}

		return $out;
	}

	/**
	 * Forget what was just reported.
	 *
	 * 🔴 **Called ONLY after the cloud accepts**, which is the whole idempotency
	 * story: the cloud adds what arrives, so clearing before a confirmed 2xx
	 * would lose the counts, and clearing after a failure would lose them
	 * silently. A failed drain simply resends.
	 *
	 * ⚠️ **It clears only what was SENT.** A beacon arriving during the request
	 * has already incremented the option, and wiping the whole thing would
	 * discard a view the customer really made. The sent counts are subtracted
	 * instead.
	 *
	 * @param array<int, array<string, mixed>> $sent What the cloud accepted.
	 */
	public function clear( array $sent ): void {
		$counts = $this->counts();

		foreach ( $sent as $row ) {
			if ( ! is_array( $row ) ) {
				continue;
			}

			$key = $this->pair_key(
				(string) ( $row['option_set_id'] ?? '' ),
				(string) ( $row['option_key'] ?? '' ),
				(string) ( $row['day'] ?? '' )
			);

			if ( ! isset( $counts[ $key ] ) ) {
				continue;
			}

			$remaining = (int) $counts[ $key ] - (int) ( $row['views'] ?? 0 );

			if ( $remaining > 0 ) {
				$counts[ $key ] = $remaining;
			} else {
				unset( $counts[ $key ] );
			}
		}

		$this->store( $counts );
	}

	/**
	 * The counts as stored.
	 *
	 * @return array<string, int>
	 */
	private function counts(): array {
		$stored = get_option( Keys::OPTION_VIEW_COUNTS, array() );

		return is_array( $stored ) ? $stored : array();
	}

	/**
	 * Write the counts back.
	 *
	 * 📌 **`autoload = false`, always.** This is written by customer traffic, so
	 * an autoloaded copy would be read on every request to the site -- including
	 * every request that has nothing to do with Optionia.
	 *
	 * @param array<string, int> $counts The counts to store.
	 */
	private function store( array $counts ): void {
		update_option( Keys::OPTION_VIEW_COUNTS, $counts, false );
	}

	/**
	 * One storage key for a (set, option, day) triple.
	 *
	 * ⚠️ **`|` is safe as a separator because none of the three may contain
	 * one**: a set id is a UUID, an option key is validated at authoring time,
	 * and a day is `Y-m-d`. `pending()` splits on it and drops anything that
	 * does not yield exactly three parts rather than guessing.
	 *
	 * @param string $set_id     Option set id.
	 * @param string $option_key Option key.
	 * @param string $day        `Y-m-d`.
	 */
	private function pair_key( string $set_id, string $option_key, string $day ): string {
		return $set_id . '|' . $option_key . '|' . $day;
	}
}
