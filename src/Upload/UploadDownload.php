<?php
/**
 * Streams a customer's uploaded file to the merchant (M15.5).
 *
 * ## Why this is a PHP endpoint and never a link
 *
 * 🔴 **The storage guards were measured to be unreliable.** `UploadStore` writes
 * an `.htaccess`, a `web.config` and an `index.php`, and on the development
 * server a probe file inside that directory still answered **200** — Nginx reads
 * neither of the first two and PHP's built-in server reads none of them. The real
 * defence is that the path carries two independent secrets: a salt-derived
 * directory and a random filename.
 *
 * That is why `UploadStore` states the rule this class implements: *"Retrieval
 * for the merchant goes through PHP (M15.5), never a direct link."* A URL
 * containing the real path would spend the directory secret permanently — one
 * leaked link would expose the naming of every file the store has ever taken.
 *
 * ## Attachment, never inline
 *
 * 🔴 **[ADR-041](../../../optioniaWooCommerceBackend/docs/DECISIONS.md) promises
 * the file reaches the merchant "as a download rather than something a browser
 * renders inline".** It says so immediately after recording that Phase 15 does
 * **not** sanitise PDFs, which can carry `/JS` and `/OpenAction`. Rendering a
 * customer-supplied PDF inline inside wp-admin would execute that content in the
 * merchant's authenticated session; `Content-Disposition: attachment` with
 * `X-Content-Type-Options: nosniff` is what keeps the promise.
 *
 * ## What the merchant is allowed to ask for
 *
 * ⚠️ **Capability first, then the nonce, then the file.** Capability first so an
 * unauthorised user is refused before anything reveals that the action exists —
 * the ordering `Admin\Request` already establishes. The nonce here is a real
 * control, unlike the storefront upload's: the weakness recorded in
 * `Support\Keys` applies to *logged-out* visitors, and a download is always an
 * authenticated admin request.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Serves one stored file to an authorised merchant.
 */
final class UploadDownload {

	/**
	 * How many bytes to push at a time.
	 *
	 * ⚠️ **Streamed rather than read whole.** A 2 GB print file read with
	 * `file_get_contents()` would exhaust `memory_limit` — measured at 512 MB on
	 * the development host — and fail exactly on the large artwork a print shop
	 * most needs.
	 */
	private const CHUNK = 8192;

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Protected storage.
	 *
	 * @var UploadStore
	 */
	private UploadStore $store;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Collects an order's files into one archive.
	 *
	 * @var UploadArchive
	 */
	private UploadArchive $archive;

	/**
	 * Mints and checks emailed links.
	 *
	 * @var UploadLink
	 */
	private UploadLink $links;

	/**
	 * Makes previews of stored images.
	 *
	 * @var UploadImage
	 */
	private UploadImage $images;

	/**
	 * Build over the table, storage, the archive builder and the logger.
	 *
	 * @param UploadRepository $uploads Upload table.
	 * @param UploadStore      $store   Protected storage.
	 * @param UploadArchive    $archive Archive builder.
	 * @param UploadLink       $links   Emailed-link signer.
	 * @param UploadImage      $images  Preview maker.
	 * @param Logger           $logger  Logger.
	 */
	public function __construct(
		UploadRepository $uploads,
		UploadStore $store,
		UploadArchive $archive,
		UploadLink $links,
		UploadImage $images,
		Logger $logger
	) {
		$this->uploads = $uploads;
		$this->store   = $store;
		$this->archive = $archive;
		$this->links   = $links;
		$this->images  = $images;
		$this->logger  = $logger;
	}

	/**
	 * Listen for a download request.
	 *
	 * `admin_init` rather than a route of its own: the request is authenticated
	 * admin traffic, and this is the pattern `Admin\ConnectionSection` already
	 * uses for its GET-triggered handlers.
	 */
	public function register(): void {
		add_action( 'admin_init', array( $this, 'maybe_download' ) );
	}

	/**
	 * Serve the requested file, if this request is asking for one.
	 */
	public function maybe_download(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the nonce is verified below, once the request is known to be ours.
		$wants_file = isset( $_GET[ Keys::ARG_DOWNLOAD_TOKEN ] );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- as above.
		$wants_order = isset( $_GET[ Keys::ARG_DOWNLOAD_ORDER ] );

		if ( ! $wants_file && ! $wants_order ) {
			return;
		}

		if ( ! current_user_can( Keys::CAP_MANAGE ) ) {
			/*
			 * Refused before the nonce is read, and before the token is looked
			 * up: a user without the capability learns nothing about whether the
			 * file exists.
			 */
			$this->refuse( __( 'You are not allowed to download this file.', 'optionia' ) );
		}

		/*
		 * 🔴 **The capability is checked above and is never waived.** A signature
		 * proves a link is one this site minted; it says nothing about who is
		 * holding it. An order email can be forwarded, archived, or read on a
		 * shared machine, so a signed link that skipped the capability would hand
		 * a customer's artwork to whoever opened the message.
		 *
		 * The signature replaces the **nonce**, not the login — it exists because
		 * a nonce cannot survive the trip through an inbox (see `UploadLink`).
		 */
		if ( ! $this->authorised( $wants_order, $wants_file ) ) {
			$this->refuse( __( 'This download link has expired. Please reload the order and try again.', 'optionia' ) );
		}

		if ( $wants_order ) {
			// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- verified above.
			$this->serve_order( absint( wp_unslash( $_GET[ Keys::ARG_DOWNLOAD_ORDER ] ) ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- verified above.
		$token = sanitize_text_field( wp_unslash( (string) $_GET[ Keys::ARG_DOWNLOAD_TOKEN ] ) );

		$this->serve( $token );
	}

	/**
	 * Whether this request proves it came from somewhere we minted.
	 *
	 * Two ways to prove it, for two places a link is rendered:
	 *
	 * - a **nonce**, for a link on the order screen, tied to the merchant's own
	 *   session — the strongest proof available there;
	 * - a **signature**, for a link in an order email, which is read later and
	 *   often in another browser where no nonce could still verify. It is minted
	 *   over an order, so it proves only that — never a claim to one named file.
	 *
	 * @param bool $wants_order Whether the request names an order.
	 * @param bool $wants_file  Whether the request also names a single file.
	 * @return bool
	 */
	private function authorised( bool $wants_order, bool $wants_file ): bool {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- this method is the verification.
		$nonce = isset( $_GET['_wpnonce'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['_wpnonce'] ) ) : '';

		if ( '' !== $nonce && false !== wp_verify_nonce( $nonce, Keys::NONCE_DOWNLOAD ) ) {
			return true;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the signature is the verification.
		$signature = isset( $_GET[ Keys::ARG_DOWNLOAD_SIGNATURE ] )
			? sanitize_text_field( wp_unslash( (string) $_GET[ Keys::ARG_DOWNLOAD_SIGNATURE ] ) )
			: '';

		if ( '' === $signature ) {
			return false;
		}

		/*
		 * 🔴 **A signature authorises an order's archive, and nothing else.**
		 *
		 * It is minted over an *order*, so it can only say "this order's files".
		 * The file argument is not part of the signed material and never could
		 * be — the link is minted before anyone knows which file will be asked
		 * for — so a request carrying one is asking for something this signature
		 * cannot speak for.
		 *
		 * ⚠️ **Both halves are load-bearing, and the second is the one that was
		 * missing.** Requiring the order alone still let a request name a file
		 * *alongside* it: `$wants_order` was true, the signature verified, and
		 * only the dispatch order decided which of the two the caller got.
		 * Measured — with the dispatch reordered, an emailed signature reached a
		 * named file. Refusing the combination is what makes the scope a property
		 * of the signature rather than of the code below it.
		 */
		if ( ! $wants_order || $wants_file ) {
			return false;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- as above.
		$order_id = isset( $_GET[ Keys::ARG_DOWNLOAD_ORDER ] ) ? absint( wp_unslash( $_GET[ Keys::ARG_DOWNLOAD_ORDER ] ) ) : 0;
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- as above.
		$expires = isset( $_GET[ Keys::ARG_DOWNLOAD_EXPIRES ] ) ? absint( wp_unslash( $_GET[ Keys::ARG_DOWNLOAD_EXPIRES ] ) ) : 0;

		return $this->links->verify( $order_id, $expires, $signature );
	}

	/**
	 * Stream every file an order carries, as one archive.
	 *
	 * ⚠️ **The caller names an order, never a list of files.** The tokens come
	 * from the order's own line items, so there is no way to assemble an archive
	 * of somebody else's artwork by guessing — which is what makes the capability
	 * check above a sufficient gate.
	 *
	 * @param int $order_id The order whose files are wanted.
	 */
	private function serve_order( int $order_id ): void {
		if ( 0 === $order_id || ! function_exists( 'wc_get_order' ) ) {
			$this->refuse( __( 'That order could not be found.', 'optionia' ) );
		}

		$order = wc_get_order( $order_id );

		if ( ! is_object( $order ) ) {
			$this->refuse( __( 'That order could not be found.', 'optionia' ) );
		}

		$path = $this->archive->build( $order );

		if ( '' === $path ) {
			/*
			 * No archive: the host has no `ZipArchive`, every row outlived its
			 * file, or the order carries none. Said plainly — the merchant is
			 * looking for artwork and needs to know why they are not getting it.
			 */
			$this->refuse( __( 'No stored files could be collected for this order.', 'optionia' ) );
		}

		$this->send(
			$path,
			array(
				'original_name' => sprintf(
					/* translators: %d: order number. */
					__( 'order-%d-files.zip', 'optionia' ),
					$order_id
				),
			),
			true
		);
	}

	/**
	 * Stream one file by token.
	 *
	 * @param string $token The file being asked for.
	 */
	private function serve( string $token ): void {
		if ( ! UploadTokens::is_token( $token ) ) {
			$this->refuse( __( 'That file could not be found.', 'optionia' ) );
		}

		/*
		 * ⚠️ **`find()`, not `find_for_session()`.** The merchant is not the
		 * visitor who uploaded the file, and that session is long gone. The
		 * capability check above is what authorises this read.
		 */
		$row = $this->uploads->find( $token );

		if ( null === $row ) {
			$this->refuse( __( 'That file could not be found.', 'optionia' ) );
		}

		$directory = $this->store->directory();
		$stored    = isset( $row['stored_name'] ) ? (string) $row['stored_name'] : '';
		$path      = $directory . '/' . $stored;

		if ( '' === $directory || '' === $stored || ! is_file( $path ) ) {
			/*
			 * The row outlived its file — an expiry or a sweep that ran between
			 * the order screen rendering and this click. Said plainly rather than
			 * as a generic failure, because the merchant needs to know the
			 * artwork is gone, not that the button is broken.
			 */
			$this->logger->warning(
				'A merchant asked for an uploaded file that is no longer on disk.',
				array( 'token' => substr( $token, 0, 8 ) )
			);

			$this->refuse( __( 'That file is no longer stored on this site.', 'optionia' ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- authorised() ran before this.
		if ( isset( $_GET[ Keys::ARG_DOWNLOAD_PREVIEW ] ) ) {
			$this->send_preview( $path );
		}

		$this->send( $path, $row );
	}

	/**
	 * Write a small preview of an image, and nothing else.
	 *
	 * 🔴 **The bytes sent are ours, not the customer's.** `UploadImage::thumbnail()`
	 * decodes the file to pixels and writes a fresh JPEG, so nothing that could
	 * be executed survives into the merchant's browser — which is what lets this
	 * render inline without breaking ADR-041's guarantee about *uploaded* files.
	 *
	 * ⚠️ **A file with no preview is refused, never fallen back to.** Sending the
	 * original when a thumbnail cannot be made would be exactly the inline
	 * rendering that guarantee forbids.
	 *
	 * @param string $path Absolute path to the stored file.
	 */
	private function send_preview( string $path ): void {
		$preview = $this->images->thumbnail( $path );

		if ( '' === $preview ) {
			$this->refuse( __( 'That file cannot be previewed.', 'optionia' ) );
		}

		nocache_headers();

		header( 'Content-Type: image/jpeg' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Content-Length: ' . strlen( $preview ) );

		while ( ob_get_level() > 0 ) {
			ob_end_clean();
		}

		echo $preview; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary image body, not markup.

		exit;
	}

	/**
	 * Write the headers and the bytes.
	 *
	 * @param string               $path      Absolute path to the file to send.
	 * @param array<string, mixed> $row       The upload row, or a name for an archive.
	 * @param bool                 $temporary Whether to delete the file once sent.
	 */
	private function send( string $path, array $row, bool $temporary = false ): void {
		/*
		 * 🔴 **Opened before a single header is written.** This used to fail
		 * *after* the headers, so an unreadable file answered with
		 * `Content-Type: application/octet-stream`, a `Content-Length`, and then
		 * a `wp_die()` HTML page as the body — a "download" that saved an error
		 * page under the customer's filename. Once a header is out there is no
		 * way back, so the last thing that can fail must happen first.
		 */
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPress.PHP.NoSilencedErrors.Discouraged -- streaming a large binary (WP_Filesystem reads whole files into memory), and an unreadable file returns false; that is the check.
		$handle = @fopen( $path, 'rb' );

		if ( false === $handle ) {
			$this->refuse( __( 'That file could not be read.', 'optionia' ) );
		}

		$name = isset( $row['original_name'] ) ? (string) $row['original_name'] : '';
		$name = '' === $name ? 'download' : $name;
		$size = $this->size_on_disk( $path );

		/*
		 * ⚠️ **The customer's own filename, sanitised at the boundary.** It is
		 * what makes a folder of downloads usable to a merchant, and it is
		 * customer-supplied text going into a header — `sanitize_file_name()`
		 * strips the separators and control characters that would let it forge a
		 * second header or escape the filename parameter.
		 */
		$name = sanitize_file_name( $name );

		nocache_headers();

		/*
		 * 🔴 **`application/octet-stream`, not the stored MIME type.** Serving a
		 * customer-supplied `image/svg+xml` or `application/pdf` invites the
		 * browser to render it; an opaque type plus `nosniff` plus `attachment`
		 * is three independent statements that this is a file to save. ADR-041
		 * requires the download, and none of the three alone is reliable across
		 * browsers.
		 */
		header( 'Content-Type: application/octet-stream' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );

		if ( $size > 0 ) {
			header( 'Content-Length: ' . $size );
		}

		$this->stream( $handle );

		if ( $temporary ) {
			/*
			 * ⚠️ **Removed after sending, not before.** An archive is built for
			 * one request and belongs to nobody afterwards; leaving it would put
			 * a copy of every file on the order in the store until the sweeper
			 * happened to reach it.
			 */
			wp_delete_file( $path );
		}

		exit;
	}

	/**
	 * The file's real length, read from the file itself.
	 *
	 * 🔴 **Never `size_bytes` from the row.** That column records what the
	 * *upload* weighed, and `UploadImage::consume_metadata()` rewrites a JPEG in
	 * place afterwards to strip its EXIF — measured at **-29.4%** on an
	 * 800×600 test image (197,329 bytes recorded, 139,246 on disk). A
	 * `Content-Length` from the row would promise bytes that do not exist, and
	 * the browser would hang waiting for them on every photograph a customer
	 * uploads.
	 *
	 * @param string $path Absolute path to the stored file.
	 */
	private function size_on_disk( string $path ): int {
		clearstatcache( true, $path );

		$size = filesize( $path );

		return is_int( $size ) && $size > 0 ? $size : 0;
	}

	/**
	 * Push the file to the client in chunks.
	 *
	 * ⚠️ **Takes an open handle rather than a path**, because opening is the
	 * step that can still fail and it must happen before any header is sent.
	 *
	 * @param resource $handle An open read handle on the stored file.
	 */
	private function stream( $handle ): void {
		// Any buffered output would corrupt the body and break the byte count.
		while ( ob_get_level() > 0 ) {
			ob_end_clean();
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_feof -- see fopen above.
		while ( ! feof( $handle ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread -- see fopen above.
			$chunk = fread( $handle, self::CHUNK );

			if ( false === $chunk ) {
				break;
			}

			echo $chunk; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary file body, not markup.

			flush();
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- see fopen above.
		fclose( $handle );
	}

	/**
	 * Stop the request with a message the merchant can act on.
	 *
	 * @param string $message What went wrong.
	 */
	private function refuse( string $message ): void {
		wp_die(
			esc_html( $message ),
			esc_html__( 'Download unavailable', 'optionia' ),
			array( 'response' => 403 )
		);
	}
}
