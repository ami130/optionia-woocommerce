<?php
/**
 * Where a customer's browser sends a file (M15.2).
 *
 * ## Why this is a route at all, and not `$_FILES` on add-to-cart
 *
 * ✏️ **The first plan put the file on the add-to-cart POST**, reasoning that
 * WooCommerce's own nonce would protect it. **Measured, and it does not exist:**
 * the rendered add-to-cart form carries only `add-to-cart` and `quantity`, and
 * WooCommerce's `add_to_cart_action()` reads them under
 * `phpcs:ignore WordPress.Security.NonceVerification.Recommended` — nonce-free
 * by design, so product pages stay cacheable.
 *
 * So riding that request bought no security, while costing the customer a
 * progress bar and re-posting the entire form on a failed 20 MB upload. A
 * separate route costs nothing extra and can report progress.
 *
 * ## What actually guards it
 *
 * 🔴 **Not the nonce, and saying otherwise would be the dangerous part.**
 * Measured on the running site: for a logged-out visitor `wp_create_nonce()`
 * reduces to *action + tick*, so **every guest receives the identical value**
 * and it stays valid for 24 hours. An attacker loads one product page and
 * uploads for a day.
 *
 * The nonce is kept as a cheap first filter — it stops a script that never
 * loaded a page — and the real bound is `UploadQuota`, per WooCommerce session.
 * A `permission_callback` that looks like a security control and is not is worse
 * than none, because it stops the next reader asking the question.
 *
 * ⚠️ **This route stores bytes and nothing more.** Content validation — magic
 * bytes, SVG rejection, EXIF stripping, malware scanning — is M15.3, and lands
 * before a file option can be authored. Until then this is reachable only by a
 * document that names a `file` option, and none can be published yet.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Keys;
use Optionia\Support\Logger;
use WP_REST_Request;
use WP_REST_Response;

defined( 'ABSPATH' ) || exit;

/**
 * The storefront upload route.
 */
final class UploadEndpoint {

	/**
	 * The form field a browser posts the file under.
	 */
	public const FIELD = 'file';

	/**
	 * Protected storage.
	 *
	 * @var UploadStore
	 */
	private UploadStore $store;

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Per-session limits.
	 *
	 * @var UploadQuota
	 */
	private UploadQuota $quota;

	/**
	 * The merchant's rules for the option being uploaded to.
	 *
	 * @var UploadRules
	 */
	private UploadRules $rules;

	/**
	 * Dimension limits and metadata removal.
	 *
	 * @var UploadImage
	 */
	private UploadImage $images;

	/**
	 * Moves the uploaded file into protected storage.
	 *
	 * ⚠️ Behind an interface because `is_uploaded_file()` is true only for a file
	 * PHP itself received — so the guard it protects could not otherwise be
	 * tested, and a mutation removing it left the whole suite passing.
	 *
	 * @var MovesUploadedFiles
	 */
	private MovesUploadedFiles $mover;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Build the endpoint over its collaborators.
	 *
	 * @param UploadStore        $store   Protected storage.
	 * @param UploadRepository   $uploads Upload table.
	 * @param UploadQuota        $quota   Per-session limits.
	 * @param UploadRules        $rules   The merchant's per-option rules.
	 * @param UploadImage        $images  Dimension limits and metadata removal.
	 * @param MovesUploadedFiles $mover   Moves the file into storage.
	 * @param Logger             $logger  Logger.
	 */
	public function __construct(
		UploadStore $store,
		UploadRepository $uploads,
		UploadQuota $quota,
		UploadRules $rules,
		UploadImage $images,
		MovesUploadedFiles $mover,
		Logger $logger
	) {
		$this->store   = $store;
		$this->uploads = $uploads;
		$this->quota   = $quota;
		$this->rules   = $rules;
		$this->images  = $images;
		$this->mover   = $mover;
		$this->logger  = $logger;
	}

	/**
	 * Register the route.
	 */
	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_route' ) );
	}

	/**
	 * Declare the route with WordPress.
	 */
	public function register_route(): void {
		register_rest_route(
			Keys::REST_NAMESPACE,
			Keys::REST_ROUTE_UPLOAD,
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'handle' ),

				/**
				 * The nonce, and an honest account of what it is worth.
				 *
				 * ⚠️ **A filter, not a credential.** Every guest on the site
				 * holds the same value for 24 hours — measured, not assumed — so
				 * this refuses a request that never loaded a page and nothing
				 * more. `UploadQuota` is what bounds abuse.
				 *
				 * Checked here rather than in the handler so a refusal costs no
				 * disk work at all.
				 */
				'permission_callback' => array( $this, 'permitted' ),
			)
		);
	}

	/**
	 * Whether the request may proceed to the handler.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function permitted( WP_REST_Request $request ): bool {
		$nonce = (string) $request->get_header( 'X-WP-Nonce' );

		if ( '' === $nonce ) {
			$nonce = (string) $request->get_param( '_wpnonce' );
		}

		return '' !== $nonce && false !== wp_verify_nonce( $nonce, Keys::NONCE_UPLOAD );
	}

	/**
	 * Store an uploaded file and return its token.
	 *
	 * ⚠️ **Every refusal answers the same shape**, so a caller cannot learn from
	 * the response which limit it hit — quota, size, or a storage failure. A
	 * customer sees one clear message; an attacker learns nothing about where
	 * the ceilings are.
	 *
	 * @param WP_REST_Request $request Inbound request.
	 */
	public function handle( WP_REST_Request $request ): WP_REST_Response {
		$session = $this->quota->session_key();

		if ( '' === $session ) {
			/*
			 * No session means no per-visitor bound, and sharing one bucket
			 * between unidentifiable requests would make the quota global: one
			 * abuser would lock out every genuine customer.
			 */
			return $this->refused( 'no_session' );
		}

		$files = $request->get_file_params();
		$file  = is_array( $files ) && isset( $files[ self::FIELD ] ) ? $files[ self::FIELD ] : null;

		if ( ! is_array( $file ) || ! isset( $file['tmp_name'], $file['size'], $file['name'] ) ) {
			return $this->refused( 'no_file' );
		}

		if ( isset( $file['error'] ) && UPLOAD_ERR_OK !== (int) $file['error'] ) {
			/*
			 * `UPLOAD_ERR_INI_SIZE` is the host's own ceiling refusing the file
			 * before PHP ever saw it — the 2 MB case `UploadLimits` reports.
			 */
			return $this->refused( 'upload_error_' . (int) $file['error'] );
		}

		/*
		 * 🔴 **The option is looked up, not trusted.**
		 *
		 * `accept` in the markup is a browser hint and `data-optionia-max-mb` is
		 * a string an attacker edits — both vanish when a request is posted
		 * straight to this route. The merchant's rules bind here or nowhere,
		 * which is AC4 applied to a file: the browser sends identifiers, and the
		 * server decides what they mean.
		 */
		$option = $this->rules->find( (string) $request->get_param( 'option_id' ) );

		if ( null === $option ) {
			/*
			 * Either the id names nothing this store has, or it names an option
			 * that is not a file field. A radio cannot hold a file, so storing
			 * one against it would create bytes nothing will ever read.
			 */
			return $this->refused( 'unknown_option' );
		}

		$size = (int) $file['size'];

		/*
		 * The lower of the merchant's ceiling and the host's. A document written
		 * against a generous host must not authorise an upload a modest one
		 * truncates — the same rule the resolver applies to `max_length`.
		 */
		if ( ! UploadLimits::accepts( $size, $this->rules->max_bytes( $option ) ) ) {
			return $this->refused( 'too_large' );
		}

		/*
		 * ⚠️ The *claimed* extension, checked cheaply before any bytes move.
		 * Whether the contents agree with the claim is M15.3's question, and
		 * neither check is sufficient alone.
		 */
		if ( ! $this->rules->accepts_extension( $option, (string) pathinfo( (string) $file['name'], PATHINFO_EXTENSION ) ) ) {
			return $this->refused( 'type_not_accepted' );
		}

		if ( ! $this->quota->allows( $session, $size ) ) {
			return $this->refused( 'quota' );
		}

		$original = (string) $file['name'];

		/*
		 * 🔴 **The bytes must agree with the name, and this is the last check
		 * before anything is stored.**
		 *
		 * Everything above tested a *claim*: the extension the customer sent,
		 * against the rules the merchant configured. This is the first question
		 * about the file itself — and it is asked before `move()`, so a file that
		 * fails never reaches the merchant's disk at all.
		 *
		 * ⚠️ **A host that cannot verify refuses.** Without `fileinfo`,
		 * WordPress falls back to trusting the filename, so proceeding would
		 * store an unchecked file while appearing to have checked it (ADR-041
		 * Decision 2). `Support\Environment` warns the merchant at authoring
		 * time; this is the boundary that holds when they publish anyway.
		 */
		if ( ! UploadContent::can_verify() ) {
			return $this->refused( 'no_fileinfo' );
		}

		if ( ! UploadContent::matches_claim( (string) $file['tmp_name'], $original ) ) {
			return $this->refused( 'content_mismatch' );
		}

		/*
		 * 🔴 **Checked from the header, before anything decodes.**
		 *
		 * Measured: `getimagesize()` on a crafted 20000×20000 PNG reported the
		 * size for **536 bytes** of memory, where decoding the same image needs
		 * ~1.5 GB. On a 128 MB host even an ordinary 48 MP DSLR photo takes the
		 * request with it — so this is not only a bomb defence, and it has to
		 * happen before `consume_metadata()` decodes anything.
		 *
		 * ⚠️ A PDF passes: `getimagesize()` answers false for one, and a document
		 * is never decoded.
		 */
		if ( ! $this->images->within_pixel_budget( (string) $file['tmp_name'], $this->rules->max_megapixels( $option ) ) ) {
			return $this->refused( 'too_many_pixels' );
		}

		/*
		 * 🔴 **An image must decode, not merely start with the right bytes.**
		 *
		 * Measured against the real `finfo`: a file of nothing but a format
		 * signature and a script tag was accepted for `.gif`, `.png`, `.jpg`,
		 * `.tif` and `.pdf`. `finfo` reads the signature and stops, and
		 * `getimagesize()` reads the header and stops -- it reported
		 * 1634493810x1948791081 for the PNG rather than refusing it.
		 *
		 * ⚠️ **After the pixel budget, never before.** Decoding a crafted
		 * 20000x20000 PNG needs ~1.5 GB where reading its header needs 536
		 * bytes, so checking validity by decoding first would BE the bomb the
		 * budget prevents. The budget bounds the work; this verifies it.
		 *
		 * A document is not decoded: `decodes()` only judges files
		 * `dimensions()` recognises, and a PDF's structure is verified by its
		 * magic bytes in `UploadContent`.
		 */
		if ( $this->images->is_image( (string) $file['tmp_name'] )
			&& ! $this->images->decodes( (string) $file['tmp_name'] ) ) {
			return $this->refused( 'content_mismatch' );
		}

		$directory = $this->store->directory();

		if ( '' === $directory ) {
			/*
			 * 🔴 **Refusing beats storing a customer's file somewhere
			 * unprotected.** Measured by removing this branch: the destination
			 * becomes `'' . '/' . $stored`, so the endpoint asks the mover to
			 * write the file to the **filesystem root**. The test host's
			 * read-only root refused it; a host with a writable one would take
			 * the bytes outside the guarded directory, with no `.htaccess`
			 * beside them and no row to ever find them by.
			 */
			return $this->refused( 'no_storage' );
		}

		try {
			$stored = $this->store->unique_filename( (string) pathinfo( $original, PATHINFO_EXTENSION ) );
		} catch ( \Exception $e ) {
			// No entropy: a predictable name would let one customer guess another's file.
			return $this->refused( 'no_entropy' );
		}

		if ( ! $this->mover->move( (string) $file['tmp_name'], $directory . '/' . $stored ) ) {
			return $this->refused( 'not_stored' );
		}

		/*
		 * 🔴 **Metadata is consumed after storage, on the plugin's own copy.**
		 *
		 * Rewriting the *temporary* file would fight `move_uploaded_file()`, which
		 * verifies the path came from PHP — a rewritten temp file may no longer
		 * qualify. Doing it here means the bytes are already inside the guarded
		 * directory, where only this plugin can reach them.
		 *
		 * ⚠️ **A failure here is not a refusal.** The file is stored and safe; it
		 * simply still carries its EXIF. Discarding a customer's artwork over a
		 * privacy nicety would be the wrong trade, and the failure is logged
		 * rather than silent.
		 */
		$this->images->consume_metadata( $directory . '/' . $stored );

		/*
		 * 🔴 **Re-measured, because `consume_metadata()` rewrites the file.**
		 * Stripping EXIF re-encodes a JPEG in place at quality 90, and the result
		 * is a different length — measured at **-29.4%** on an 800×600 test image
		 * (197,329 bytes uploaded, 139,246 stored). Recording the *upload* size
		 * would leave the row disagreeing with the disk, which breaks two things:
		 * a `Content-Length` built from it promises bytes that do not exist and
		 * the browser hangs waiting, and `session_usage()` sums this column, so
		 * every photograph would over-report a merchant's storage by a third.
		 *
		 * ⚠️ **The ceilings above still use the upload size**, deliberately: the
		 * customer did send those bytes, and a limit that only counted what
		 * survived compression would let a 3× oversized file through whenever it
		 * happened to compress well.
		 */
		$stored_size = $this->size_on_disk( $directory . '/' . $stored, $size );

		$token = $this->uploads->create(
			array(
				'session_key'   => $session,
				'option_id'     => (string) $request->get_param( 'option_id' ),
				'stored_name'   => $stored,
				'original_name' => $original,
				'mime_type'     => isset( $file['type'] ) ? (string) $file['type'] : '',
				'size_bytes'    => $stored_size,
			)
		);

		if ( '' === $token ) {
			/*
			 * The row failed after the bytes landed. Remove the file rather than
			 * leaving an orphan nothing can find: cleanup reads the table, so a
			 * file with no row is invisible to it forever.
			 */
			wp_delete_file( $directory . '/' . $stored );

			return $this->refused( 'not_recorded' );
		}

		return new WP_REST_Response(
			array(
				'token' => $token,
				'name'  => $original,
				'size'  => $stored_size,
			),
			201
		);
	}

	/**
	 * What the stored file actually weighs.
	 *
	 * ⚠️ **Falls back to the upload size rather than to zero.** A `filesize()`
	 * that fails on an unusual host must not record a zero-byte row: the quota
	 * would stop counting that file entirely, which is the failure direction that
	 * lets a merchant's disk fill silently.
	 *
	 * @param string $path     Absolute path to the stored file.
	 * @param int    $fallback The upload size, used when the file cannot be read.
	 */
	private function size_on_disk( string $path, int $fallback ): int {
		clearstatcache( true, $path );

		$size = filesize( $path );

		return is_int( $size ) && $size > 0 ? $size : $fallback;
	}

	/**
	 * One refusal shape, whatever the reason.
	 *
	 * The reason is logged for the merchant's support, never returned: a caller
	 * that learns *which* ceiling it hit can map them.
	 *
	 * @param string $reason Why, for the log.
	 */
	private function refused( string $reason ): WP_REST_Response {
		$this->logger->debug( 'Refused an upload.', array( 'reason' => $reason ) );

		return new WP_REST_Response( array( 'stored' => false ), 422 );
	}
}
