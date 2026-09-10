<?php
/**
 * Shows a merchant the files a customer uploaded, on the order screen (M15.5).
 *
 * ## The fulfilment path
 *
 * 🔴 **Until this existed a merchant could not reach the artwork at all.** The
 * file is stored under a salt-derived directory with a random name, and
 * `Integration\OrderLineItem` hides `_optionia_selections` from the item meta
 * list — correctly, because a raw 64-character token means nothing to anyone. So
 * the order screen showed that options were chosen and gave no way to get the
 * file those options produced.
 *
 * ## What the link carries, and what it does not
 *
 * ⚠️ **The token, never a path.** `Upload\UploadStore` records why: the storage
 * guards were measured to be unreliable — a stored file fetched by its full path
 * answers 200 on this host — so the real defence is that the path holds two
 * independent secrets. A link exposing it would spend the directory secret
 * permanently, for every file the store has ever taken.
 *
 * The nonce is a real control here, unlike the storefront upload's: the weakness
 * `Support\Keys` records applies to *logged-out* visitors, and this link is only
 * ever rendered for an authenticated merchant.
 *
 * ## Where the name comes from
 *
 * The customer's **original** filename, which the upload row keeps alongside the
 * random stored one. `art-final-v3.pdf` is what lets a merchant tell two
 * attachments apart; the stored name is deliberately meaningless.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Admin;

use Optionia\Support\Keys;
use Optionia\Upload\UploadArchive;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadTokens;

defined( 'ABSPATH' ) || exit;

/**
 * Renders download links under each order line that carries a file.
 */
final class OrderFiles {

	/**
	 * The hook WooCommerce fires inside each line item's cell.
	 *
	 * Fired once per line after the meta list, with the item in hand —
	 * `html-order-item.php:60`. One view serves both order-storage modes, so this
	 * needs no HPOS branch, as `Integration\OrderLineItem` already records.
	 */
	public const HOOK = 'woocommerce_after_order_itemmeta';

	/**
	 * The hook that renders the order's own action buttons.
	 *
	 * Order-level rather than per-line, and it receives the order itself —
	 * `html-order-items.php:328`.
	 */
	public const BUTTON_HOOK = 'woocommerce_order_item_add_action_buttons';

	/**
	 * The hook that lets a plugin add content to an order email.
	 *
	 * Fired once per email with `$sent_to_admin`, which is what makes
	 * "merchant only" enforceable at the source — `email-order-details.php:209`.
	 */
	public const EMAIL_HOOK = 'woocommerce_email_after_order_table';

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Collects an order's files into one archive.
	 *
	 * @var UploadArchive
	 */
	private UploadArchive $archive;

	/**
	 * Rows already looked up this request, keyed by token.
	 *
	 * @var array<string, array<string, mixed>|null>
	 */
	private array $rows = array();

	/**
	 * Mints the signed links an order email carries.
	 *
	 * @var UploadLink
	 */
	private UploadLink $links;

	/**
	 * Build over the upload table.
	 *
	 * @param UploadRepository $uploads Upload table.
	 * @param UploadArchive    $archive Archive builder.
	 * @param UploadLink       $links   Emailed-link signer.
	 */
	public function __construct( UploadRepository $uploads, UploadArchive $archive, UploadLink $links ) {
		$this->uploads = $uploads;
		$this->archive = $archive;
		$this->links   = $links;
	}

	/**
	 * Register the order-screen listener.
	 */
	public function register(): void {
		add_action( self::HOOK, array( $this, 'render' ), 10, 2 );
		add_action( self::BUTTON_HOOK, array( $this, 'render_bulk' ) );
		add_action( self::EMAIL_HOOK, array( $this, 'render_email' ), 10, 4 );
	}

	/**
	 * Add a download link to the merchant's order email.
	 *
	 * 🔴 **`$sent_to_admin` decides, not a recipient list.** WooCommerce passes
	 * it to this hook precisely so a template can tell the merchant's copy from
	 * the customer's, and reading it here means the link cannot leak into a
	 * customer email by a configuration mistake. The customer already has the
	 * file they uploaded; every additional inbox holding a working link is
	 * another way it escapes.
	 *
	 * ⚠️ **Plain text gets the bare URL.** A plain-text email rendered with an
	 * anchor tag shows the merchant the markup instead of the link.
	 *
	 * @param mixed $order         The order the email is about.
	 * @param mixed $sent_to_admin Whether this copy goes to the merchant.
	 * @param mixed $plain_text    Whether this copy is plain text.
	 * @param mixed $email         The email being sent; unused.
	 */
	public function render_email( $order = null, $sent_to_admin = false, $plain_text = false, $email = null ): void {
		unset( $email );

		if ( true !== $sent_to_admin ) {
			return;
		}

		if ( ! is_object( $order ) || ! method_exists( $order, 'get_id' ) ) {
			return;
		}

		if ( $this->stored_count( $order ) < 1 ) {
			return;
		}

		$url = $this->links->url( (int) $order->get_id() );

		if ( '' === $url ) {
			return;
		}

		if ( true === $plain_text ) {
			/*
			 * ⚠️ **Single-quoted, with the newlines concatenated.** In a
			 * double-quoted string PHP reads `%1$s` as the variable `$s` and
			 * interpolates it away — which is exactly what happened here, and
			 * what the plain-text test caught.
			 */
			printf(
				'%1$s' . "\n" . '%2$s' . "\n",
				esc_html__( 'Download the uploaded files for this order:', 'optionia' ),
				esc_url_raw( $url )
			);

			return;
		}

		printf(
			'<p><a href="%1$s">%2$s</a></p>',
			esc_url( $url ),
			esc_html__( 'Download the uploaded files for this order', 'optionia' )
		);
	}

	/**
	 * Offer the whole order's files as one archive.
	 *
	 * ⚠️ **Only when there is more than one file.** A button that downloads a
	 * single file as a zip is worse than the link already beside it, and a button
	 * for an order with no files is noise on every order in the store.
	 *
	 * @param mixed $order The order being edited.
	 */
	public function render_bulk( $order = null ): void {
		if ( ! current_user_can( Keys::CAP_MANAGE ) || ! UploadArchive::is_available() ) {
			/*
			 * 🔴 **No button rather than a broken one.** `ZipArchive` ships with
			 * PHP but is a compile-time extension a host can omit, and offering
			 * an action that cannot work is worse than not offering it — the
			 * per-file links still work either way.
			 */
			return;
		}

		if ( ! is_object( $order ) || ! method_exists( $order, 'get_id' ) ) {
			return;
		}

		if ( $this->stored_count( $order ) < 2 ) {
			return;
		}

		$url = wp_nonce_url(
			add_query_arg(
				Keys::ARG_DOWNLOAD_ORDER,
				(int) $order->get_id(),
				admin_url( 'admin.php' )
			),
			Keys::NONCE_DOWNLOAD
		);

		printf(
			'<a href="%1$s" class="button" rel="nofollow">%2$s</a>',
			esc_url( $url ),
			esc_html__( 'Download all files', 'optionia' )
		);
	}

	/**
	 * Draw the download links for one order line.
	 *
	 * @param mixed $item_id The line item's id; unused.
	 * @param mixed $item    The line item.
	 */
	public function render( $item_id = null, $item = null ): void {
		unset( $item_id );

		if ( ! current_user_can( Keys::CAP_MANAGE ) ) {
			/*
			 * The screen itself is already gated, but a link rendered for someone
			 * who cannot use it is a link that invites a support ticket — and the
			 * capability is the same one `Upload\UploadDownload` enforces, so
			 * checking here keeps the two in step.
			 */
			return;
		}

		$tokens = UploadTokens::in_item( $item );

		if ( array() === $tokens ) {
			return;
		}

		/*
		 * ⚠️ **WooCommerce's own `display_meta` table, not markup of our own.**
		 * That class already carries the styling this needs on the order screen —
		 * `margin:.5em 0 0`, a smaller face, the muted grey the meta list uses —
		 * and it is loaded by WooCommerce, on a screen where Optionia's admin
		 * stylesheet is not enqueued at all (`Frontend\Assets` limits that to
		 * Optionia's own pages). Shipping classes of our own here would have
		 * rendered unstyled, and widening the enqueue would load a stylesheet on
		 * someone else's screen to style four lines.
		 *
		 * Sitting directly under the meta list it visually continues, in the same
		 * shape, is also simply what a merchant expects.
		 */
		echo '<table cellspacing="0" class="display_meta">';

		/*
		 * 🔴 **Reported per file, not only when every one is missing.**
		 *
		 * Listing just the files that survived meant a line holding two, where
		 * one had been released, showed a single link and **no sign the other
		 * ever existed** — a merchant sees one file and has no way to know they
		 * should have two. That is the same silent-loss failure ADR-040 exists to
		 * prevent, arriving through a different door: a reprint that arrives
		 * short is no better than one that arrives blank.
		 */
		foreach ( $tokens as $token ) {
			$row = $this->row( (string) $token );

			if ( null === $row ) {
				printf(
					'<tr><th>%1$s</th><td>%2$s</td></tr>',
					esc_html__( 'Uploaded file', 'optionia' ),
					esc_html__( 'No longer stored on this site.', 'optionia' )
				);

				continue;
			}

			$this->link( (string) $token, $row );
		}

		echo '</table>';
	}

	/**
	 * How many of an order's files are still stored.
	 *
	 * ⚠️ **Counted through this class's own cache, not by asking the archive.**
	 * Asking `UploadArchive` would issue its own lookups, and the order
	 * screen renders every line *before* the button row — WooCommerce includes
	 * `html-order-item.php` at line 80 and fires the button hook at 328 — so
	 * every row is already in hand by the time this runs. Asking again would
	 * double the queries to answer a question already answered.
	 *
	 * @param mixed $order The order being edited.
	 */
	private function stored_count( $order ): int {
		$stored = 0;

		foreach ( UploadTokens::in_order( $order ) as $token ) {
			if ( null !== $this->row( (string) $token ) ) {
				++$stored;
			}
		}

		return $stored;
	}

	/**
	 * One upload row, looked up at most once per request.
	 *
	 * ⚠️ **Cached because the order screen asks the same questions twice.**
	 * `render()` runs per line and `render_bulk()` counts the whole order, so an
	 * order with N files cost 2N lookups before this — and a third consumer on
	 * the same screen would make it 3N. Each is an indexed point lookup, so the
	 * cost was small; repeating it for no reason is still waste, and the cache
	 * lives for one request so it cannot go stale.
	 *
	 * @param string $token The file's token.
	 * @return array<string, mixed>|null
	 */
	private function row( string $token ): ?array {
		if ( ! array_key_exists( $token, $this->rows ) ) {
			$this->rows[ $token ] = $this->uploads->find( $token );
		}

		return $this->rows[ $token ];
	}

	/**
	 * One download link.
	 *
	 * @param string               $token The file's token.
	 * @param array<string, mixed> $row   The upload row.
	 */
	private function link( string $token, array $row ): void {
		$name = isset( $row['original_name'] ) ? (string) $row['original_name'] : '';
		$name = '' === $name ? __( 'Uploaded file', 'optionia' ) : $name;

		$url = wp_nonce_url(
			add_query_arg(
				Keys::ARG_DOWNLOAD_TOKEN,
				$token,
				admin_url( 'admin.php' )
			),
			Keys::NONCE_DOWNLOAD
		);

		printf(
			'<tr><th>%1$s</th><td>%2$s<a href="%3$s" rel="nofollow">%4$s</a> (%5$s)</td></tr>',
			esc_html__( 'Uploaded file', 'optionia' ),
			// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- markup built in preview(), where its one dynamic value passes through esc_url().
			$this->preview( $token, $row ),
			esc_url( $url ),
			esc_html( $name ),
			esc_html( size_format( (int) ( $row['size_bytes'] ?? 0 ) ) )
		);
	}

	/**
	 * A thumbnail for an image, or nothing.
	 *
	 * 🔴 **The picture is a JPEG this plugin authored, not the customer's file.**
	 * `UploadImage::thumbnail()` decodes to pixels and re-encodes, so nothing
	 * executable survives — which is what lets a preview render inline without
	 * breaking ADR-041's guarantee that an *uploaded* file always arrives as a
	 * download.
	 *
	 * ⚠️ **`mime_type` is the browser's claim, and that is fine here.** It only
	 * decides whether to *try*: the endpoint re-derives the truth from the bytes
	 * and refuses anything it cannot preview, so a lying claim costs an empty
	 * image rather than an inline render of something else.
	 *
	 * @param string               $token The file's token.
	 * @param array<string, mixed> $row   The upload row.
	 */
	private function preview( string $token, array $row ): string {
		$mime = isset( $row['mime_type'] ) ? (string) $row['mime_type'] : '';

		if ( 0 !== strpos( $mime, 'image/' ) ) {
			return '';
		}

		$url = wp_nonce_url(
			add_query_arg(
				array(
					Keys::ARG_DOWNLOAD_TOKEN   => $token,
					Keys::ARG_DOWNLOAD_PREVIEW => 1,
				),
				admin_url( 'admin.php' )
			),
			Keys::NONCE_DOWNLOAD
		);

		return sprintf(
			'<img src="%1$s" alt="" width="48" style="vertical-align:middle;margin-right:.5em" /> ',
			esc_url( $url )
		);
	}
}
