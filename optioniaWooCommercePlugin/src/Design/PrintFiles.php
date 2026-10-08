<?php
/**
 * Shows a merchant the print file an order line produced (M26e.5).
 *
 * ## The gap this closes
 *
 * 🔴 **The file reached the merchant's disk and nothing showed it to them.**
 * `Design\RenderCollector` writes `META_RENDER_FILES` and, until this existed,
 * **nothing read it** — a customer bought, the cloud rendered, the plugin
 * downloaded the artwork into a guarded directory, and the order screen gave no
 * sign it was there. The whole pipeline produced something no one could reach,
 * which is the same shape `Admin\OrderFiles` was written to fix for uploads.
 *
 * ## What the link carries, and what it does not
 *
 * ⚠️ **A line item id, never a path or a stored name.** `Upload\UploadStore`
 * records why: its storage guards were measured to be unreliable — a file
 * fetched by its full path answers 200 on that host — so the real defence is
 * that the path holds two independent secrets. A link exposing the stored name
 * would spend one of them permanently, for every file the store has ever taken.
 *
 * 📌 **The nonce is a real control here**, unlike the storefront's. The
 * weakness `Support\Keys` records applies to logged-out visitors; this link is
 * only ever rendered for an authenticated merchant, so the nonce is tied to
 * their user id and session.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Design;

use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Upload\UploadStore;

defined( 'ABSPATH' ) || exit;

/**
 * Renders print-file links, and serves the file behind them.
 */
final class PrintFiles {

	/** Where WooCommerce lets a plugin add rows under one line item's meta. */
	public const HOOK = 'woocommerce_after_order_itemmeta';

	/** Bytes per read when streaming. */
	private const CHUNK = 262144;

	/**
	 * Where files are stored.
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
	 * Constructor.
	 *
	 * @param UploadStore $store  Guarded upload directory.
	 * @param Logger      $logger Logger.
	 */
	public function __construct( UploadStore $store, Logger $logger ) {
		$this->store  = $store;
		$this->logger = $logger;
	}

	/**
	 * Register the order-screen and download listeners.
	 */
	public function register(): void {
		add_action( self::HOOK, array( $this, 'render' ), 20, 2 );
		add_action( 'admin_init', array( $this, 'maybe_download' ) );
	}

	/**
	 * Show the print file for one order line.
	 *
	 * @param mixed $item_id Line item id.
	 * @param mixed $item    Line item.
	 */
	public function render( $item_id = null, $item = null ): void {
		unset( $item );

		if ( ! current_user_can( Keys::CAP_MANAGE ) ) {
			/*
			 * The screen is already gated, but a link rendered for someone who
			 * cannot use it invites a support ticket — and this is the same
			 * capability the download enforces, so checking here keeps the two
			 * in step.
			 */
			return;
		}

		$line_id = is_numeric( $item_id ) ? (int) $item_id : 0;

		if ( $line_id <= 0 ) {
			return;
		}

		$order = $this->order_of( $line_id );

		if ( null === $order ) {
			return;
		}

		$files    = $this->files_of( $order );
		$failures = $this->map_of( $order, Keys::META_RENDER_FAILURES );
		$partials = $this->map_of( $order, Keys::META_RENDER_PARTIAL );

		$has_file    = isset( $files[ $line_id ] );
		$has_failure = isset( $failures[ $line_id ] );

		if ( ! $has_file && ! $has_failure ) {
			return;
		}

		echo '<table cellspacing="0" class="display_meta">';

		/*
		 * 🔴 **A render the cloud gave up on is said plainly** (M26e.6). Until
		 * this, a permanently failed render showed NOTHING on the order — the
		 * collector retried it on every cron pass for ever and the merchant
		 * had no way to know a print file was never coming.
		 *
		 * ⚠️ **The reason is shown, not just the fact.** *"Something went
		 * wrong"* is a support ticket; *"the stored scene could not be
		 * serialized"* is something a merchant or this project can act on.
		 */
		if ( $has_failure ) {
			printf(
				'<tr><th>%1$s</th><td>%2$s<br><small>%3$s</small></td></tr>',
				esc_html__( 'Print file', 'optionia' ),
				esc_html__( 'Could not be generated. The design is kept, so it can be re-rendered.', 'optionia' ),
				esc_html( (string) $failures[ $line_id ] )
			);

			echo '</table>';

			return;
		}

		$path = $this->path_for( (string) $files[ $line_id ] );

		/*
		 * 🔴 **A missing file is REPORTED, not omitted.** A line whose artwork
		 * was swept or never arrived would otherwise look identical to one that
		 * never had any — and a reprint that arrives short is no better than
		 * one that arrives blank. `Admin\OrderFiles` records the same reasoning
		 * for uploads.
		 */
		if ( '' === $path ) {
			printf(
				'<tr><th>%1$s</th><td>%2$s</td></tr>',
				esc_html__( 'Print file', 'optionia' ),
				esc_html__( 'No longer stored on this site.', 'optionia' )
			);
		} else {
			printf(
				'<tr><th>%1$s</th><td><a href="%2$s">%3$s</a></td></tr>',
				esc_html__( 'Print file', 'optionia' ),
				esc_url( $this->link( (int) $order->get_id(), $line_id ) ),
				esc_html__( 'Download', 'optionia' )
			);

			/*
			 * ⚠️ **A file that arrived may still be missing a layer** (F173),
			 * and the download is offered anyway: a print file missing one
			 * badge beats no file at all. What must not happen is the merchant
			 * discovering it at the press.
			 */
			if ( isset( $partials[ $line_id ] ) ) {
				printf(
					'<tr><th>%1$s</th><td>%2$s<br><small>%3$s</small></td></tr>',
					esc_html__( 'Incomplete', 'optionia' ),
					esc_html__( 'One or more layers could not be drawn.', 'optionia' ),
					esc_html( (string) $partials[ $line_id ] )
				);
			}
		}

		echo '</table>';
	}

	/**
	 * Serve a print file, when this request is asking for one.
	 */
	public function maybe_download(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the nonce is verified below, once the request is known to be ours.
		if ( ! isset( $_GET[ Keys::ARG_PRINT_LINE ], $_GET[ Keys::ARG_PRINT_ORDER ] ) ) {
			return;
		}

		/*
		 * ⚠️ **Capability before the nonce, and before anything is looked up.**
		 * A failed nonce tells a caller the argument was recognised; refusing
		 * on capability first keeps an unauthenticated probe from learning
		 * anything at all.
		 */
		if ( ! current_user_can( Keys::CAP_MANAGE ) ) {
			$this->refuse( __( 'You do not have permission to download this file.', 'optionia' ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- verified on the next line.
		$nonce = isset( $_GET['_wpnonce'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['_wpnonce'] ) ) : '';

		if ( false === wp_verify_nonce( $nonce, Keys::NONCE_DOWNLOAD ) ) {
			$this->refuse( __( 'That link has expired. Reload the order and try again.', 'optionia' ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- verified above.
		$order_id = (int) sanitize_text_field( wp_unslash( (string) $_GET[ Keys::ARG_PRINT_ORDER ] ) );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- verified above.
		$line_id = (int) sanitize_text_field( wp_unslash( (string) $_GET[ Keys::ARG_PRINT_LINE ] ) );

		$order = $this->order( $order_id );

		if ( null === $order ) {
			$this->refuse( __( 'That order could not be found.', 'optionia' ) );
		}

		$files = $this->files_of( $order );

		if ( ! isset( $files[ $line_id ] ) ) {
			$this->refuse( __( 'That line has no print file.', 'optionia' ) );
		}

		$path = $this->path_for( (string) $files[ $line_id ] );

		if ( '' === $path ) {
			/*
			 * The order outlived its file — a sweep between the screen
			 * rendering and this click. Said plainly, because the merchant
			 * needs to know the artwork is gone rather than that the button is
			 * broken.
			 */
			$this->logger->warning(
				'A merchant asked for a print file that is no longer on disk.',
				array(
					'order' => $order_id,
					'line'  => $line_id,
				)
			);

			$this->refuse( __( 'That file is no longer stored on this site.', 'optionia' ) );
		}

		$this->send( $path, $order_id, $line_id );
	}

	/**
	 * The signed order-screen link for one line's print file.
	 *
	 * @param int $order_id Order id.
	 * @param int $line_id  Line item id.
	 */
	private function link( int $order_id, int $line_id ): string {
		return add_query_arg(
			array(
				Keys::ARG_PRINT_ORDER => $order_id,
				Keys::ARG_PRINT_LINE  => $line_id,
				'_wpnonce'            => wp_create_nonce( Keys::NONCE_DOWNLOAD ),
			),
			admin_url( 'admin.php' )
		);
	}

	/**
	 * Print files recorded on an order, keyed by line item id.
	 *
	 * @param object $order WooCommerce order.
	 *
	 * @return array<int, string>
	 */
	private function files_of( object $order ): array {
		return $this->map_of( $order, Keys::META_RENDER_FILES );
	}

	/**
	 * One line-keyed map from the order, or an empty one.
	 *
	 * @param object $order WooCommerce order.
	 * @param string $key   Meta key.
	 *
	 * @return array<int, string>
	 */
	private function map_of( object $order, string $key ): array {
		if ( ! method_exists( $order, 'get_meta' ) ) {
			return array();
		}

		$stored = json_decode( (string) $order->get_meta( $key, true ), true );

		if ( ! is_array( $stored ) ) {
			return array();
		}

		$out = array();

		foreach ( $stored as $line => $name ) {
			if ( is_numeric( $line ) && is_scalar( $name ) && '' !== (string) $name ) {
				$out[ (int) $line ] = (string) $name;
			}
		}

		return $out;
	}

	/**
	 * The absolute path of a stored print file, or '' when it is not there.
	 *
	 * 🔴 **The name is confined to the guarded directory.** It is read back
	 * from order meta, which only this plugin writes — but a traversal segment
	 * reaching here would read any file the web user can, so the basename is
	 * taken rather than trusted.
	 *
	 * ⚠️ **`$safe !== $name` is an acknowledged EQUIVALENT MUTANT**, and
	 * recorded rather than tested around. Removing it leaves every test passing
	 * because `basename()` has already stripped the traversal — `../../etc/hosts`
	 * becomes `hosts`, which is not in this directory, so `is_file()` refuses
	 * it anyway. The comparison stays because it refuses the *attempt* rather
	 * than relying on the stripped name happening to miss: a file named
	 * `hosts` inside the guarded directory would otherwise be served to a
	 * caller who asked for `/etc/hosts`.
	 *
	 * @param string $name Stored filename.
	 */
	private function path_for( string $name ): string {
		$safe = basename( $name );

		if ( '' === $safe || $safe !== $name ) {
			return '';
		}

		$directory = $this->store->directory();

		if ( '' === $directory ) {
			return '';
		}

		$path = $directory . '/' . $safe;

		return is_file( $path ) ? $path : '';
	}

	/**
	 * Stream one print file.
	 *
	 * 🔴 **Opened before a single header is written.** `Upload\UploadDownload`
	 * records what the other order costs: an unreadable file answered with a
	 * `Content-Type`, a `Content-Length` and then an error page under the
	 * customer's filename. Once a header is out there is no taking it back.
	 *
	 * @param string $path     Absolute path.
	 * @param int    $order_id Order id, for the filename.
	 * @param int    $line_id  Line item id, for the filename.
	 */
	private function send( string $path, int $order_id, int $line_id ): void {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPress.PHP.NoSilencedErrors.Discouraged -- streaming a binary; an unreadable file returns false, which is the check.
		$handle = @fopen( $path, 'rb' );

		if ( false === $handle ) {
			$this->refuse( __( 'That file could not be read.', 'optionia' ) );
		}

		/*
		 * 📌 **A name a merchant can file**, rather than the random stored one.
		 * The order and line are what a fulfiller matches against a packing
		 * slip; the stored name is deliberately meaningless.
		 */
		$name = sanitize_file_name( sprintf( 'order-%d-line-%d-print.png', $order_id, $line_id ) );
		$size = $this->size_on_disk( $path );

		nocache_headers();

		header( 'Content-Type: image/png' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );

		if ( $size > 0 ) {
			header( 'Content-Length: ' . $size );
		}

		while ( ! feof( $handle ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread -- see fopen above.
			$chunk = fread( $handle, self::CHUNK );

			if ( false === $chunk ) {
				break;
			}

			echo $chunk; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary file content.

			flush();
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- see fopen above.
		fclose( $handle );

		exit;
	}

	/**
	 * A file's size, or 0 when it cannot be read.
	 *
	 * @param string $path Absolute path.
	 */
	private function size_on_disk( string $path ): int {
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- false is the answer when the size is unknown.
		$size = @filesize( $path );

		return is_int( $size ) && $size > 0 ? $size : 0;
	}

	/**
	 * The order a line item belongs to.
	 *
	 * @param int $line_id Line item id.
	 */
	private function order_of( int $line_id ): ?object {
		if ( ! function_exists( 'wc_get_order_id_by_order_item_id' ) ) {
			return null;
		}

		$order_id = (int) wc_get_order_id_by_order_item_id( $line_id );

		return $order_id > 0 ? $this->order( $order_id ) : null;
	}

	/**
	 * Load an order.
	 *
	 * @param int $order_id Order id.
	 */
	private function order( int $order_id ): ?object {
		if ( $order_id <= 0 || ! function_exists( 'wc_get_order' ) ) {
			return null;
		}

		$order = wc_get_order( $order_id );

		return is_object( $order ) ? $order : null;
	}

	/**
	 * Stop with a message a merchant can act on.
	 *
	 * @param string $message What went wrong.
	 */
	private function refuse( string $message ): void {
		wp_die(
			esc_html( $message ),
			esc_html__( 'Print file', 'optionia' ),
			array( 'response' => 403 )
		);
	}
}
