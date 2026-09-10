<?php
/**
 * The one thing a quota needs to know about stored uploads.
 *
 * `Upload\UploadRepository` is `final` — deliberately, so nobody subclasses
 * database behaviour — which also means it cannot be doubled. `UploadQuota`
 * depends on this instead, for the same reason `Config\Synchroniser` depends on
 * `Api\FetchesFromCloud`: a seam narrow enough to describe what the caller
 * needs, and wide enough to stand in for.
 *
 * The narrowness matters here too. A quota **reads**; it must not be able to
 * create, claim or delete an upload, and a test proving it refuses one file past
 * the ceiling has to be able to say what the session already holds without
 * touching a database.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

defined( 'ABSPATH' ) || exit;

/**
 * What one session currently holds.
 */
interface ReportsSessionUsage {

	/**
	 * Files and bytes a session holds that no order has claimed.
	 *
	 * @param string $session_key The visitor's session.
	 * @return array{count: int, bytes: int}
	 */
	public function session_usage( string $session_key ): array;
}
