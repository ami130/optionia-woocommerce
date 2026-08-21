<?php
/**
 * Schema and data upgrades between plugin versions.
 *
 * Activation hooks do not fire on plugin update — WordPress simply replaces the
 * files. Anything that must happen on upgrade therefore has to be detected on a
 * normal request by comparing the stored version against the running one.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Activation;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Runs pending upgrades, once per version change.
 */
final class Migrator {

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
	 * Run any upgrade the stored version implies.
	 *
	 * Deliberately cheap on the happy path: a single option read and a string
	 * comparison, because this runs on every admin request.
	 */
	public function maybe_upgrade(): void {
		$stored = (string) get_option( Keys::OPTION_VERSION, '' );

		if ( OPTIONIA_VERSION === $stored ) {
			return;
		}

		// Fresh install: the activator has already prepared everything.
		if ( '' === $stored ) {
			update_option( Keys::OPTION_VERSION, OPTIONIA_VERSION, false );

			return;
		}

		$this->logger->info(
			'Upgrading Optionia.',
			array(
				'from' => $stored,
				'to'   => OPTIONIA_VERSION,
			)
		);

		$this->upgrade_schema();
		$this->ensure_cron();

		update_option( Keys::OPTION_VERSION, OPTIONIA_VERSION, false );
	}

	/**
	 * Bring custom tables up to the current definition.
	 *
	 * Note: dbDelta is safe to re-run — it diffs the live schema against the
	 * target and issues only the necessary ALTERs.
	 */
	private function upgrade_schema(): void {
		$stored = (string) get_option( Keys::OPTION_DB_VERSION, '0' );

		if ( version_compare( $stored, Activator::DB_VERSION, '>=' ) ) {
			return;
		}

		// Re-runs the same CREATE TABLE statements through dbDelta.
		Activator::activate();

		update_option( Keys::OPTION_DB_VERSION, Activator::DB_VERSION, false );
	}

	/**
	 * Re-schedule cron if an upgrade changed the hook or interval.
	 */
	private function ensure_cron(): void {
		Scheduler::schedule();
	}
}
