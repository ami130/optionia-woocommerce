<?php
/**
 * The upload table, and the only place SQL for it lives (M15.2).
 *
 * ## What a token is, and what it is not
 *
 * A token is the **only** thing a browser ever holds. It is 64 hex characters of
 * `random_bytes()` — not a path, not an id, not derived from the filename. AC4
 * already settles the rule for every other option type: the browser may send
 * *selection identifiers only*, never paths and never prices. A file token obeys
 * it.
 *
 * ⚠️ **A token is bound to the session that created it.** Verified on lookup, so
 * a token copied from one visitor's network tab is useless in another's cart:
 * the row is found and then refused. Without that binding, a leaked token would
 * let anyone attach someone else's artwork to their own order.
 *
 * ## Why every row carries its own expiry
 *
 * 🔴 **`optionia_sync_log` is append-only and nothing prunes it** — it grows
 * forever on every merchant's database. Rows here point at real bytes on disk,
 * so the same omission fills a merchant's *disk*, not just their database.
 *
 * `expires_at` is written when the row is, and cleanup reads that column rather
 * than inferring a policy. An upload that reaches an order has its expiry
 * cleared and becomes permanent — that single transition is the whole lifecycle
 * (M15.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Activation\Activator;
use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Reads and writes for customer uploads.
 */
final class UploadRepository implements ReportsSessionUsage {

	/**
	 * How long an unclaimed upload survives, in seconds.
	 *
	 * ⚠️ **Longer than a cart session, deliberately.** WooCommerce keeps a guest
	 * cart for 48 hours by default; expiring a file sooner would empty a cart the
	 * customer can still see, and they would reach checkout with an option that
	 * silently lost its artwork. A day of margin past that is cheap in disk and
	 * expensive to get wrong in the other direction.
	 */
	public const ORPHAN_TTL = 259200; // 72 hours.

	/**
	 * The largest storage total this store will ever report, in bytes.
	 *
	 * 🔴 **Clamped high as well as low, because the cloud refuses more.** The
	 * heartbeat DTO caps `storage_bytes` at one terabyte, and an over-range value
	 * does not merely lose the metric — the request is rejected whole, so the
	 * connection state, the version report and the schema signal go with it,
	 * every day, until the figure comes back in range.
	 *
	 * Measured: a corrupt `SUM()` returning more than `PHP_INT_MAX` saturates to
	 * `9223372036854775807`, roughly nine million times this ceiling. Reporting a
	 * capped figure loses accuracy for a store that cannot exist; reporting the
	 * saturated one loses the heartbeat.
	 *
	 * One terabyte is ~40× the largest plan (business, 25 000 MB), so no real
	 * store reaches it.
	 */
	public const MAX_REPORTABLE_BYTES = 1099511627776; // 1 TB.

	/**
	 * The row was unclaimed and now belongs to this order.
	 */
	public const CLAIM_CLAIMED = 'claimed';

	/**
	 * This same order already owns the row — a replayed hook, not a conflict.
	 */
	public const CLAIM_ALREADY_OURS = 'already_ours';

	/**
	 * No claimable row: it is gone, or another order owns it.
	 */
	public const CLAIM_TAKEN = 'taken';

	/**
	 * The database refused the statement — a different thing from a conflict.
	 *
	 * 🔴 **Kept distinct because the two need opposite responses.** `taken` means
	 * this order genuinely has no artwork and never will. `error` means nobody
	 * knows yet: the row may be perfectly claimable a second later. Collapsing
	 * them would let one transient blip at checkout look identical to a permanent
	 * conflict, and the row would keep its `expires_at` — so cleanup would delete
	 * a paid order's artwork 72 hours later with the failure already logged and
	 * forgotten.
	 */
	public const CLAIM_ERROR = 'error';

	/**
	 * Store a newly written file and return its token.
	 *
	 * @param array<string, mixed> $file Row fields: session_key, option_id,
	 *                                   stored_name, original_name, mime_type,
	 *                                   size_bytes.
	 * @return string The token, or an empty string when the row could not be written.
	 */
	public function create( array $file ): string {
		global $wpdb;

		try {
			$token = bin2hex( random_bytes( 32 ) );
		} catch ( \Exception $e ) {
			/*
			 * No entropy source. Refusing is the only safe answer: a predictable
			 * token would let one customer guess another's file.
			 */
			return '';
		}

		$now = time();

		/*
		 * ⚠️ **Bounded here, not left to MySQL.**
		 *
		 * With `STRICT_TRANS_TABLES` on, an over-length value makes the insert
		 * *fail* — the file is already on disk, so that would leave an orphan
		 * nothing can find. With strict mode **off**, which is common on shared
		 * hosting, MySQL silently truncates instead: the merchant sees a mangled
		 * filename, and a truncated `option_id` would point at a different
		 * option entirely.
		 *
		 * Measured: a 5,000-character `original_name` was refused on this host.
		 * That refusal was the database's accident, not this code's decision, and
		 * a different host would have behaved differently. Truncating explicitly
		 * makes the outcome the same everywhere.
		 *
		 * `mb_substr` rather than `substr`: a filename is UTF-8, and cutting mid
		 * character would store a broken sequence.
		 */
		$fit = static fn ( $value, int $max ): string =>
			mb_substr( (string) $value, 0, $max );

		$table = Activator::table_name( Keys::TABLE_UPLOADS );
		$size  = (int) ( $file['size_bytes'] ?? 0 );

		/*
		 * 🔴 **The session's ceilings are part of the write, not a check before
		 * it.**
		 *
		 * `UploadQuota::allows()` asks whether a file fits, and the endpoint then
		 * verifies content, decodes an image and moves the bytes before this row
		 * lands — a window wide enough for two concurrent uploads from one session
		 * to both be told yes and both be stored. The same check-then-act shape as
		 * the `claim()` race in Stage 4b, and unlike that one no unique index can
		 * express it: the limit is a `SUM`, not a key.
		 *
		 * So the ceiling moves into the statement. `INSERT … SELECT … WHERE`
		 * evaluates the session's current usage *as the row is written*, so a
		 * request that was under the limit when it started and over it by the time
		 * it finished inserts nothing and is refused. Verified on both engines
		 * this plugin runs against — MySQL permits a self-referencing
		 * `INSERT … SELECT` (the 1093 restriction covers `UPDATE` and `DELETE`),
		 * and SQLite permits it too.
		 *
		 * ⚠️ `UploadQuota` stays exactly where it is. It refuses the ordinary case
		 * *before* the bytes are moved, which is what stops a doomed upload doing
		 * the work; this catches only the overlap it cannot see.
		 */
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- a custom table has no WP API, and an insert is never cached.
		$inserted = $wpdb->query(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- identifier, not value; see find_for_session().
			$wpdb->prepare(
				"INSERT INTO `{$table}`
				   (token, session_key, option_id, stored_name, original_name,
				    mime_type, size_bytes, created_at, expires_at)
				 SELECT %s, %s, %s, %s, %s, %s, %d, %s, %s
				  WHERE ( SELECT COUNT(*) FROM `{$table}`
				           WHERE session_key = %s AND order_id IS NULL ) + 1 <= %d
				    AND ( SELECT COALESCE(SUM(size_bytes), 0) FROM `{$table}`
				           WHERE session_key = %s AND order_id IS NULL ) + %d <= %d",
				$token,
				$fit( $file['session_key'] ?? '', 64 ),
				$fit( $file['option_id'] ?? '', 64 ),
				$fit( $file['stored_name'] ?? '', 255 ),
				$fit( $file['original_name'] ?? '', 255 ),
				$fit( $file['mime_type'] ?? '', 120 ),
				$size,
				gmdate( 'Y-m-d H:i:s', $now ),
				gmdate( 'Y-m-d H:i:s', $now + self::ORPHAN_TTL ),
				$fit( $file['session_key'] ?? '', 64 ),
				UploadQuota::MAX_FILES,
				$fit( $file['session_key'] ?? '', 64 ),
				$size,
				UploadQuota::MAX_BYTES
			)
			// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		/*
		 * `false` is a database error; `0` is the guard refusing. Both mean no row
		 * landed, and the caller's contract is the same either way — an empty
		 * token, which `UploadEndpoint` answers by deleting the stored file rather
		 * than leaving an orphan.
		 */
		return ( false === $inserted || (int) $inserted < 1 ) ? '' : $token;
	}

	/**
	 * Find an upload by token, for the session that owns it.
	 *
	 * ⚠️ **The session is part of the query, not a check afterwards.** Fetching
	 * the row first and comparing later is the shape that leaks: a mistake in the
	 * comparison returns someone else's file, while a mistake in a `WHERE` clause
	 * returns nothing.
	 *
	 * @param string $token       The token from the browser.
	 * @param string $session_key The current visitor's session.
	 * @return array<string, mixed>|null
	 */
	public function find_for_session( string $token, string $session_key ): ?array {
		global $wpdb;

		if ( '' === $token || '' === $session_key ) {
			return null;
		}

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		/*
		 * The table name is interpolated because an identifier cannot be a
		 * placeholder — `%s` would quote it as a string and the query would fail.
		 * It is built from a hardcoded suffix in `Keys` and the trusted
		 * `$wpdb->prefix`, so no caller input reaches it. Every *value* is bound.
		 */
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$row = $wpdb->get_row(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			$wpdb->prepare(
				"SELECT * FROM `{$table}` WHERE token = %s AND session_key = %s LIMIT 1",
				$token,
				$session_key
			),
			ARRAY_A
		);
		// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return is_array( $row ) ? $row : null;
	}

	/**
	 * Find an upload by token alone, for a merchant-side caller.
	 *
	 * 🔴 **Deliberately not session-bound, and that is why it is separate.**
	 * `find_for_session()` exists so one visitor cannot read another's file by
	 * guessing a token, and every storefront read must keep going through it.
	 * This one serves the opposite situation: `UploadRetention` deletes the files
	 * of an order being removed, and the session that uploaded them is long gone
	 * — often years gone, and never the merchant's.
	 *
	 * ⚠️ **Never call this on a customer's behalf.** The name says `find`, not
	 * `find_for_session`, precisely so the omission is visible at the call site.
	 *
	 * @param string $token The token to look up.
	 * @return array<string, mixed>|null
	 */
	public function find( string $token ): ?array {
		global $wpdb;

		if ( '' === $token ) {
			return null;
		}

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- see create().
		$row = $wpdb->get_row(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- identifier, not value; see find_for_session().
			$wpdb->prepare( "SELECT * FROM `{$table}` WHERE token = %s LIMIT 1", $token ),
			// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		return is_array( $row ) && array() !== $row ? $row : null;
	}

	/**
	 * What one session has already uploaded, for quota purposes.
	 *
	 * Counts only live rows: a file already claimed by an order is the customer's
	 * completed work, not pending consumption, so it must not count against their
	 * ability to upload for a second order.
	 *
	 * @param string $session_key The current visitor's session.
	 * @return array{count: int, bytes: int}
	 */
	public function session_usage( string $session_key ): array {
		global $wpdb;

		if ( '' === $session_key ) {
			return array(
				'count' => 0,
				'bytes' => 0,
			);
		}

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$row = $wpdb->get_row(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- see find_for_session(): identifier, not value.
			$wpdb->prepare(
				"SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b
				   FROM `{$table}`
				  WHERE session_key = %s AND order_id IS NULL",
				$session_key
			),
			ARRAY_A
		);
		// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return array(
			'count' => is_array( $row ) ? (int) ( $row['n'] ?? 0 ) : 0,
			'bytes' => is_array( $row ) ? (int) ( $row['b'] ?? 0 ) : 0,
		);
	}

	/**
	 * Claim an upload for an order, making it permanent.
	 *
	 * Clearing `expires_at` is what promotion *is*: cleanup reads that column, so
	 * a null there is the difference between artwork a merchant can still print
	 * next month and a row the next cron run deletes.
	 *
	 * 🔴 **The claim is refused if another order already owns the row.** Measured
	 * before this guard existed: ordering twice with the same token left
	 * `order_id` at the *second* order — the last claim silently won, and the
	 * first order's artwork moved off it. WooCommerce's `OrderAgain` replays a
	 * cart line's selections verbatim, token included, so a customer re-ordering
	 * was enough to strip the file from the order already in production.
	 * [ADR-040](../../../optioniaWooCommerceBackend/docs/DECISIONS.md) requires
	 * that case to fail loudly; stealing the row is the silent failure it names.
	 *
	 * ⚠️ **Three outcomes, not two.** `$wpdb->update()` reports 0 affected rows
	 * both for "no such row" *and* for "the values already match", so a boolean
	 * cannot tell a legitimate retry of the same order from a theft attempt. The
	 * caller needs that difference: one is normal, the other is a merchant about
	 * to receive an order with no artwork.
	 *
	 * @param string $token    The token being claimed.
	 * @param int    $order_id The order it now belongs to.
	 * @return self::CLAIM_* One of claimed, already-ours, or taken.
	 */
	public function claim( string $token, int $order_id ): string {
		global $wpdb;

		if ( '' === $token || $order_id <= 0 ) {
			return self::CLAIM_TAKEN;
		}

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		/*
		 * A prepared statement rather than `$wpdb->update()`: its `$where` is an
		 * equality map and cannot express `order_id IS NULL`, which is the whole
		 * guard. Identifier interpolated, every value bound — see
		 * find_for_session().
		 *
		 * ⚠️ **The guard is also what makes the row count trustworthy.**
		 * WordPress does not pass `CLIENT_FOUND_ROWS`, so MySQL reports rows
		 * *changed*, not rows *matched* — an UPDATE that matches a row and writes
		 * the values it already holds answers 0. That cannot happen here: the
		 * `WHERE` matches only `order_id IS NULL` and the `SET` always writes a
		 * positive id, so every matched row is a changed row.
		 *
		 * 🔴 **Relaxing that `WHERE` would silently break the count**, and with
		 * it every outcome below — a successful claim would read as a conflict.
		 * Verified against the running site's schema; the unit tests use a stub
		 * and cannot see this.
		 */
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- see create().
		$updated = $wpdb->query(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			$wpdb->prepare(
				"UPDATE `{$table}`
				    SET order_id = %d, expires_at = NULL
				  WHERE token = %s AND order_id IS NULL",
				$order_id,
				$token
			)
			// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		/*
		 * ⚠️ **`false` and `0` mean opposite things here.** `wpdb::query()`
		 * returns `false` only when the statement errored, and the affected-row
		 * count otherwise — so `0` is the honest "no row matched the guard" and
		 * `false` is "the database never answered". Testing `is_numeric()` alone
		 * would fold the error into the conflict and lose that difference.
		 */
		if ( false === $updated ) {
			return self::CLAIM_ERROR;
		}

		if ( (int) $updated > 0 ) {
			return self::CLAIM_CLAIMED;
		}

		/*
		 * Nothing was updated. Either the row is gone, or it is already claimed —
		 * and if this same order claimed it, that is a retry, not a conflict.
		 * WooCommerce can fire the line-item hook more than once for one order.
		 */
		return $order_id === $this->owner_of( $token ) ? self::CLAIM_ALREADY_OURS : self::CLAIM_TAKEN;
	}

	/**
	 * The order that owns a token, or zero if none does.
	 *
	 * @param string $token The token to look up.
	 */
	private function owner_of( string $token ): int {
		global $wpdb;

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- see create().
		$owner = $wpdb->get_var(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- see find_for_session().
			$wpdb->prepare( "SELECT order_id FROM `{$table}` WHERE token = %s LIMIT 1", $token )
			// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		return is_numeric( $owner ) ? (int) $owner : 0;
	}

	/**
	 * Every byte this store is holding in customer uploads (M15.6).
	 *
	 * 🔴 **Read from the table, never from the disk.** The table is the authority
	 * every other mechanism in this phase uses — the sweeper, the expirer and
	 * retention all decide from it — and a directory walk would meter bytes the
	 * merchant cannot see or delete: a leaked archive, an orphan mid-sweep. It
	 * would also put `O(files)` of disk I/O on a request a customer is waiting on.
	 *
	 * ⚠️ **Claimed and unclaimed alike.** A file promoted to an order occupies the
	 * merchant's disk exactly as much as one still waiting in a cart, so a total
	 * that counted only pending uploads would under-report what a plan is meant
	 * to limit.
	 *
	 * @return int Bytes, or 0 when the table cannot be read.
	 */
	public function total_bytes(): int {
		global $wpdb;

		if ( ! is_object( $wpdb ) ) {
			/*
			 * ⚠️ **The heartbeat must survive a database it cannot reach.** This
			 * is the one caller that runs on a schedule rather than in response to
			 * a customer, and a fatal here would take the whole check-in with it —
			 * losing the connection state, the version report and the schema
			 * signal to collect a number that is merely useful.
			 */
			return 0;
		}

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- see create(); a cached total would report a figure the merchant has already changed.
		$total = $wpdb->get_var(
			// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- identifier, not value; see find_for_session().
			"SELECT COALESCE(SUM(size_bytes), 0) FROM `{$table}`"
		);

		if ( ! is_numeric( $total ) ) {
			return 0;
		}

		return max( 0, min( self::MAX_REPORTABLE_BYTES, (int) $total ) );
	}

	/**
	 * Rows whose expiry has passed, for the cleanup job.
	 *
	 * Returned rather than deleted here, because the caller must remove the file
	 * from disk **before** the row: a deleted row with a surviving file is an
	 * orphan nothing knows how to find, which is precisely the state this whole
	 * mechanism exists to prevent.
	 *
	 * @param int $limit Most rows to return in one pass.
	 * @return array<int, array<string, mixed>>
	 */
	public function expired( int $limit = 100 ): array {
		global $wpdb;

		$table = Activator::table_name( Keys::TABLE_UPLOADS );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$rows = $wpdb->get_results(
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- see find_for_session(): identifier, not value.
			$wpdb->prepare(
				"SELECT * FROM `{$table}`
				  WHERE order_id IS NULL AND expires_at IS NOT NULL AND expires_at < %s
				  ORDER BY expires_at ASC
				  LIMIT %d",
				gmdate( 'Y-m-d H:i:s' ),
				max( 1, $limit )
			),
			ARRAY_A
		);
		// phpcs:enable WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * Remove a row by token, after its file has gone.
	 *
	 * @param string $token The token to remove.
	 */
	public function delete( string $token ): bool {
		global $wpdb;

		if ( '' === $token ) {
			return false;
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- see create().
		return false !== $wpdb->delete(
			Activator::table_name( Keys::TABLE_UPLOADS ),
			array( 'token' => $token ),
			array( '%s' )
		);
	}
}
