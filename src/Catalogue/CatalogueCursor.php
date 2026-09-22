<?php
/**
 * Where the catalogue push has reached (M19.1).
 *
 * ## A cursor, not a queue
 *
 * `Reporting\OrderQueue` is the obvious template and the wrong one. An order
 * report is an **event**: it happens once, it is appended when it happens, and
 * the queue holds a handful of ids for minutes. A catalogue push is a **walk**
 * over rows WooCommerce already stores, and a 100k catalogue copied into an
 * option to be walked would be a second copy of the thing being walked --
 * megabytes in a single row, rewritten on every batch.
 *
 * So this stores a **position**, not a payload: how far the walk has reached,
 * how far it has to go, and which run it belongs to.
 *
 * ## Why a run id
 *
 * A walk that restarts must not be confused with one that is continuing. Two
 * facts depend on telling them apart: progress reporting cannot say "412 of
 * 3,000" if the 3,000 belongs to a previous run, and a catalogue that shrank
 * mid-walk would otherwise leave the offset past the end with no way to notice.
 * The run id changes only when a walk begins.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Catalogue;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Reads and writes the catalogue push position.
 */
final class CatalogueCursor {

	/**
	 * A cursor that has never run.
	 *
	 * Distinct from a finished one: `offset === total` means the walk completed,
	 * while this means it never started. The System Status row reads differently
	 * for each, and a merchant asking "has it synced?" is asking exactly that.
	 */
	private const EMPTY_CURSOR = array(
		'run_id'     => '',
		'offset'     => 0,
		'total'      => 0,
		'started_at' => 0,
		'updated_at' => 0,
		'claimed_at' => 0,
	);

	/**
	 * How long a claim holds before another run may take it.
	 *
	 * 🔴 **Longer than a batch can possibly take, shorter than the cron
	 * interval.** `Api\Client` allows 8 seconds per attempt with retries inside
	 * a bounded total, so a batch finishes well under a minute; the schedule is
	 * 900 seconds. Five minutes leaves a crashed run's claim to expire on its
	 * own without a second run ever stealing a live one.
	 */
	private const CLAIM_SECONDS = 300;

	/**
	 * The stored cursor, or an empty one.
	 *
	 * @return array{run_id: string, offset: int, total: int, started_at: int, updated_at: int, claimed_at: int}
	 */
	public function read(): array {
		$stored = get_option( Keys::OPTION_CATALOGUE_CURSOR, array() );

		if ( ! is_array( $stored ) ) {
			return self::EMPTY_CURSOR;
		}

		/*
		 * Each field is read and cast individually rather than merged wholesale.
		 * An option is user-writable through the database and survives plugin
		 * downgrades, so a stored value of the wrong type is a real state -- and
		 * `array_merge` would carry it straight into arithmetic.
		 */
		return array(
			'run_id'     => isset( $stored['run_id'] ) && is_string( $stored['run_id'] ) ? $stored['run_id'] : '',
			'offset'     => isset( $stored['offset'] ) ? max( 0, (int) $stored['offset'] ) : 0,
			'total'      => isset( $stored['total'] ) ? max( 0, (int) $stored['total'] ) : 0,
			'started_at' => isset( $stored['started_at'] ) ? max( 0, (int) $stored['started_at'] ) : 0,
			'updated_at' => isset( $stored['updated_at'] ) ? max( 0, (int) $stored['updated_at'] ) : 0,
			'claimed_at' => isset( $stored['claimed_at'] ) ? max( 0, (int) $stored['claimed_at'] ) : 0,
		);
	}

	/**
	 * Begin a walk of `$total` products.
	 *
	 * @param int $total How many products the catalogue holds.
	 * @return string The new run id.
	 */
	public function start( int $total ): string {
		$run_id = wp_generate_uuid4();

		/*
		 * 🔴 **The existing claim is carried over, not cleared.** Writing
		 * `claimed_at => 0` here discarded the lock of the very run calling
		 * `start()` — a first run released its own claim mid-flight, and a
		 * concurrent run could then enter and skip a batch. That is exactly the
		 * overlap `claim()` exists to prevent, reintroduced three lines away
		 * from it. Proven before the fix: claim, start, and a second cursor
		 * claimed successfully.
		 */
		$claimed_at = $this->read()['claimed_at'];

		$this->write(
			array(
				'run_id'     => $run_id,
				'offset'     => 0,
				'total'      => max( 0, $total ),
				'started_at' => time(),
				'updated_at' => time(),
				'claimed_at' => $claimed_at,
			)
		);

		return $run_id;
	}

	/**
	 * Record that `$count` more products have been pushed.
	 *
	 * ⚠️ **Advances only when the run id still matches.** A batch whose response
	 * arrives after a new walk began would otherwise move the new walk's offset
	 * by the old walk's count, skipping products nothing would report.
	 *
	 * @param string $run_id The run this batch belongs to.
	 * @param int    $count  How many products were accepted.
	 * @return bool Whether the cursor advanced.
	 */
	public function advance( string $run_id, int $count ): bool {
		$cursor = $this->read();

		if ( '' === $run_id || $cursor['run_id'] !== $run_id ) {
			return false;
		}

		$cursor['offset']     = $cursor['offset'] + max( 0, $count );
		$cursor['updated_at'] = time();

		return $this->write( $cursor );
	}

	/**
	 * Claim the right to push the next batch, or refuse.
	 *
	 * 🔴 **Two cron runs overlapping would skip a batch, and the run id does not
	 * stop it.** That guard distinguishes a *stale* walk from the current one;
	 * two concurrent runs of the **same** walk carry the same id. Modelled: both
	 * read offset 0, both send products 0-249, then both advance — leaving the
	 * offset at 500 with **products 250-499 never sent**. The duplicate send is
	 * harmless (the ingest upserts); the double advance is the defect.
	 *
	 * ⚠️ **Reachable on a common configuration.** A batch takes seconds against
	 * a 900-second schedule, so WordPress's own cron will not overlap — but
	 * `DISABLE_WP_CRON` with a system crontab can fire runs concurrently, and
	 * System Status already reports that setup because merchants use it.
	 *
	 * 📌 **Not a transient, deliberately.** This is the plugin's first lock, and
	 * a transient is a second storage mechanism to install, test and uninstall
	 * for one flag. The cursor is already read and written on every run, so the
	 * claim costs no extra query — and a claim stored beside the offset it
	 * protects cannot be cleaned up separately from it.
	 *
	 * @return bool Whether this run may proceed.
	 */
	public function claim(): bool {
		$cursor = $this->read();
		$now    = time();

		if ( 0 !== $cursor['claimed_at'] && ( $now - $cursor['claimed_at'] ) < self::CLAIM_SECONDS ) {
			return false;
		}

		$cursor['claimed_at'] = $now;

		return $this->write( $cursor );
	}

	/**
	 * Release the claim, so the next run may start immediately.
	 *
	 * A run that finishes normally releases; one that dies mid-batch does not,
	 * and its claim expires on its own after `CLAIM_SECONDS`.
	 */
	public function release(): bool {
		$cursor = $this->read();

		if ( 0 === $cursor['claimed_at'] ) {
			return true;
		}

		$cursor['claimed_at'] = 0;

		return $this->write( $cursor );
	}

	/**
	 * Whether the walk has reached the end of the catalogue.
	 *
	 * `>=` rather than `===`: a catalogue that shrank mid-walk leaves the offset
	 * past the total, and that is finished rather than broken.
	 *
	 * @param array{run_id: string, offset: int, total: int, started_at: int, updated_at: int, claimed_at: int} $cursor A cursor.
	 */
	public function is_complete( array $cursor ): bool {
		return '' !== $cursor['run_id'] && $cursor['offset'] >= $cursor['total'];
	}

	/**
	 * Whether a walk has ever run.
	 *
	 * @param array{run_id: string, offset: int, total: int, started_at: int, updated_at: int, claimed_at: int} $cursor A cursor.
	 */
	public function has_run( array $cursor ): bool {
		return '' !== $cursor['run_id'];
	}

	/**
	 * Forget the cursor entirely.
	 *
	 * Used on disconnect: a credential that no longer works cannot push, and a
	 * position held against a store this site is no longer connected to would
	 * resume a walk into a cloud that has forgotten it.
	 */
	public function forget(): bool {
		return delete_option( Keys::OPTION_CATALOGUE_CURSOR );
	}

	/**
	 * Persist a cursor.
	 *
	 * `false` for autoload: this is read by cron and by one admin screen, never
	 * by the storefront, and autoloading it would put it on every page load of
	 * the site for no reader.
	 *
	 * @param array{run_id: string, offset: int, total: int, started_at: int, updated_at: int, claimed_at: int} $cursor A cursor.
	 */
	private function write( array $cursor ): bool {
		return update_option( Keys::OPTION_CATALOGUE_CURSOR, $cursor, false );
	}
}
