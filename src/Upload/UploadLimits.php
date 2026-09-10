<?php
/**
 * What this host will actually accept (M15.2).
 *
 * ## Why the host's limit is read rather than assumed
 *
 * 🔴 **Measured on the development site: `wp_max_upload_size()` returns
 * 2,097,152 bytes — 2 MB.** Phase 15 exists for print-on-demand and signage,
 * where a print-ready PDF is 10–50 MB. A merchant configuring "max 20 MB" on
 * that host has configured something their server refuses, and the failure
 * arrives as a truncated POST rather than a message anyone can act on.
 *
 * PHP enforces two separate ceilings and the smaller wins:
 *
 * - `upload_max_filesize` — the largest single file
 * - `post_max_size` — the largest whole request, which must also hold the rest
 *   of the add-to-cart form
 *
 * `wp_max_upload_size()` is WordPress's own `min()` of the two, so it is used
 * rather than reimplemented.
 *
 * ⚠️ **This class does not raise the limit and must not try.** `ini_set()` for
 * `upload_max_filesize` is `PHP_INI_PERDIR` — it silently does nothing from
 * inside a request, which would leave the plugin reporting a limit the host does
 * not honour. Raising it is the merchant's hosting decision; reporting it
 * honestly is this plugin's job.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

defined( 'ABSPATH' ) || exit;

/**
 * The effective upload ceiling, and what a merchant may configure against it.
 */
final class UploadLimits {

	/**
	 * A floor below which uploads are not worth offering.
	 *
	 * A host allowing less than this cannot carry a photograph, let alone
	 * artwork. Reported as unusable rather than accepted, so a merchant learns
	 * before a customer does.
	 */
	public const USABLE_FLOOR_BYTES = 1048576; // 1 MB.

	/**
	 * The largest file this host accepts, in bytes.
	 *
	 * Zero when the environment cannot say — a defensive value, since callers
	 * compare against it and a wrong non-zero number would authorise an upload
	 * the server then truncates.
	 */
	public static function host_max_bytes(): int {
		if ( ! function_exists( 'wp_max_upload_size' ) ) {
			return 0;
		}

		$max = wp_max_upload_size();

		/*
		 * `wp_max_upload_size()` returns an int on every supported version, but
		 * a filter can return anything: `upload_size_limit` is public. A
		 * non-numeric or negative value means "cannot determine", not "no
		 * limit".
		 */
		return is_numeric( $max ) && (int) $max > 0 ? (int) $max : 0;
	}

	/**
	 * Whether this host can carry uploads at all.
	 */
	public static function host_supports_uploads(): bool {
		return self::host_max_bytes() >= self::USABLE_FLOOR_BYTES;
	}

	/**
	 * The largest size a merchant may configure, in bytes.
	 *
	 * **The lower of what the merchant asked for and what the host allows.** A
	 * document written against a generous host and synced to a modest one must
	 * not authorise an upload that server will refuse — the same rule
	 * `Engine\SelectionResolver` applies to `max_length`, where a document
	 * claiming a larger limit is not trusted over the local ceiling.
	 *
	 * @param int $configured_bytes What the option's `max_size_mb` asks for, in bytes.
	 */
	public static function effective_max_bytes( int $configured_bytes ): int {
		$host = self::host_max_bytes();

		if ( 0 === $host ) {
			return 0;
		}

		if ( $configured_bytes <= 0 ) {
			return $host;
		}

		return min( $configured_bytes, $host );
	}

	/**
	 * Whether a file of this size may be accepted.
	 *
	 * @param int $size_bytes       The file's size.
	 * @param int $configured_bytes The option's configured maximum, in bytes.
	 */
	public static function accepts( int $size_bytes, int $configured_bytes ): bool {
		$max = self::effective_max_bytes( $configured_bytes );

		return $max > 0 && $size_bytes > 0 && $size_bytes <= $max;
	}

	/**
	 * The host limit as a whole number of megabytes, for display.
	 *
	 * Rounded **down**: telling a merchant "2 MB" when the host allows 2,097,151
	 * bytes is a message they can act on; rounding up invites them to configure
	 * a limit that fails.
	 */
	public static function host_max_mb(): int {
		return (int) floor( self::host_max_bytes() / 1048576 );
	}
}
