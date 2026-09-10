<?php
/**
 * Orders awaiting report to the cloud (M12.7).
 *
 * ## Why a queue at all
 *
 * M12.7's hard requirement is that reporting **never blocks checkout**, and the
 * only way to guarantee that is to do no network work in the checkout request.
 * `wc_create_order()` runs inside it; a POST there — however short its timeout —
 * is latency on the customer's most valuable click, and a cloud outage would
 * turn into a slow checkout for every shop at once.
 *
 * So checkout does one bounded thing: append an order id to an option. The
 * network happens later, on cron, where a failure costs nothing and a retry is
 * free.
 *
 * ## Why an option rather than a table
 *
 * The queue holds a handful of ids for minutes. A custom table would need an
 * install path, an upgrade path, an uninstall path and a migration for data
 * that is disposable by definition — the order itself is the durable record,
 * and `Keys::META_REPORTED_AT` on it is what actually prevents double-reporting.
 *
 * ## The cap is a safety valve, not a policy
 *
 * A store whose credential has been revoked keeps completing orders while every
 * report fails. Without a bound the option grows until it exceeds
 * `max_allowed_packet` and *every* `update_option()` fails — taking unrelated
 * plugin settings with it. The oldest entries are dropped, because the newest
 * are the ones a merchant is most likely to be looking at.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Reporting;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * A bounded, persistent list of order ids waiting to be reported.
 */
final class OrderQueue {

	/**
	 * The most orders held at once.
	 *
	 * At one report per cron run per order and a fifteen-minute schedule, a
	 * healthy store never approaches this. Reaching it means reporting has been
	 * failing for a long time, and that is worth a warning rather than silence.
	 */
	public const MAX_ENTRIES = 500;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * Add an order id, if it is not already waiting.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return bool Whether the queue changed.
	 */
	public function push( int $order_id ): bool {
		if ( $order_id <= 0 ) {
			return false;
		}

		$queue = $this->all();

		if ( in_array( $order_id, $queue, true ) ) {
			return false;
		}

		$queue[] = $order_id;

		if ( count( $queue ) > self::MAX_ENTRIES ) {
			$dropped = count( $queue ) - self::MAX_ENTRIES;
			$queue   = array_slice( $queue, $dropped );

			$this->logger->warning(
				'Order report queue is full; oldest entries dropped.',
				array(
					'dropped' => $dropped,
					'kept'    => self::MAX_ENTRIES,
				)
			);
		}

		return $this->write( $queue );
	}

	/**
	 * Remove an order id.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return bool Whether the queue changed.
	 */
	public function forget( int $order_id ): bool {
		$queue = $this->all();
		$kept  = array_values(
			array_filter(
				$queue,
				static fn ( int $queued ): bool => $queued !== $order_id
			)
		);

		if ( count( $kept ) === count( $queue ) ) {
			return false;
		}

		return $this->write( $kept );
	}

	/**
	 * Every queued order id, oldest first.
	 *
	 * @return array<int, int>
	 */
	public function all(): array {
		$stored = get_option( Keys::OPTION_ORDER_QUEUE, array() );

		if ( ! is_array( $stored ) ) {
			return array();
		}

		$ids = array();

		foreach ( $stored as $entry ) {
			/*
			 * Non-integers are dropped rather than cast. A corrupted option --
			 * another plugin, a bad import, a partial write -- would otherwise
			 * turn into order id 0 and be requested from the cloud forever.
			 */
			if ( ! is_int( $entry ) && ! ( is_string( $entry ) && ctype_digit( $entry ) ) ) {
				continue;
			}

			$id = (int) $entry;

			if ( $id > 0 && ! in_array( $id, $ids, true ) ) {
				$ids[] = $id;
			}
		}

		return $ids;
	}

	/**
	 * How many orders are waiting.
	 */
	public function count(): int {
		return count( $this->all() );
	}

	/**
	 * Empty the queue.
	 */
	public function clear(): void {
		$this->write( array() );
	}

	/**
	 * Persist the queue.
	 *
	 * `false` for autoload: the storefront never reads this, and autoloading it
	 * would put a growing option on every page load of the site.
	 *
	 * @param array<int, int> $queue Order ids.
	 */
	private function write( array $queue ): bool {
		return update_option( Keys::OPTION_ORDER_QUEUE, array_values( $queue ), false );
	}
}
