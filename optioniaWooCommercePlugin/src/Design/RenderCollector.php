<?php
/**
 * Fetching a finished print file and storing it on the merchant's own site.
 *
 * ## The decision this implements
 *
 * 🔴 **Decision 3: the print file lives on the merchant's WordPress**, not in
 * the cloud. Decision 3a chose how it crosses — the cloud holds the bytes
 * briefly, the plugin pulls them, and the buffer is released. This is the
 * plugin's half of that, and the step that finally makes a render `ready`.
 *
 * ⚠️ **Until this ran, every job stopped at `rendered`**: pixels existed in the
 * cloud and no merchant could fetch them. `countUncollected()` on the cloud
 * side has been watching for a transfer failure that could not happen yet,
 * because nothing collected.
 *
 * ## Why the bytes go in the guarded directory
 *
 * 🔴 **A print file is a customer's artwork.** `UploadStore` exists because a
 * probe showed `wp-content/uploads/` answers 200 to anyone who knows the path;
 * its directory segment comes from `wp_salt()` and is not derivable from
 * anything public. A render lands there for the same reason an upload does.
 *
 * 📌 **So `file_url` is a SIGNED ADMIN LINK, never a path into that
 * directory.** The cloud only ever reads `fileUrl` back as a status marker —
 * it never fetches it — so the link records *"the merchant holds this"*
 * without making the guarded directory reachable. Pointing it at the file
 * itself would undo the protection the directory exists for.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Design;

use Optionia\Api\Client;
use Optionia\Connection\StateMachine;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadStore;

defined( 'ABSPATH' ) || exit;

/**
 * Pulls rendered print files into the merchant's uploads.
 */
final class RenderCollector {

	/**
	 * Orders per run.
	 *
	 * 📌 **Ten, matching the requester and the order reporter.** A run holds a
	 * PHP request open on a merchant's shared cron.
	 */
	private const BATCH_SIZE = 10;

	/**
	 * The eight bytes every PNG begins with.
	 *
	 * 🔴 **Checked before anything is written.** A body that is not a PNG means
	 * something answered that was not the render route — a proxy error page, a
	 * login wall, a captive portal. Writing it would leave a file named `.png`
	 * that no print shop can open, and `collected` would then tell the cloud to
	 * release bytes that were never received.
	 */
	private const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";

	/**
	 * API client.
	 *
	 * @var Client
	 */
	private Client $client;

	/**
	 * Where files are written.
	 *
	 * @var UploadStore
	 */
	private UploadStore $store;

	/**
	 * Builds the signed link a merchant opens.
	 *
	 * @var UploadLink
	 */
	private UploadLink $links;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Constructor.
	 *
	 * @param Client      $client API client.
	 * @param UploadStore $store  Guarded upload directory.
	 * @param UploadLink  $links  Signed download links.
	 * @param Logger      $logger Logger.
	 */
	public function __construct( Client $client, UploadStore $store, UploadLink $links, Logger $logger ) {
		$this->client = $client;
		$this->store  = $store;
		$this->links  = $links;
		$this->logger = $logger;
	}

	/**
	 * Register the cron listener.
	 *
	 * ⚠️ **The same hook the requester drains on.** Asking and collecting are
	 * one pass: a render requested fifteen minutes ago is usually ready now, so
	 * a second schedule would add cron traffic to do half the job.
	 */
	public function register(): void {
		add_action( Keys::CRON_RENDER_FILES, array( $this, 'drain' ) );
	}

	/**
	 * Collect every print file the cloud has finished.
	 *
	 * @return int How many files were stored.
	 */
	public function drain(): int {
		if ( StateMachine::DISCONNECTED === StateMachine::current() ) {
			return 0;
		}

		$pending = $this->pending_orders();

		if ( array() === $pending ) {
			return 0;
		}

		$stored = 0;

		foreach ( $pending as $order_id ) {
			$outcome = $this->collect_for( $order_id );

			if ( null === $outcome ) {
				/*
				 * ⚠️ **Stop on the first retryable failure.** The cause is the
				 * same for every order — the cloud is down, or the credential
				 * is bad — so continuing would hand the circuit breaker nine
				 * more failures to prove it.
				 */
				break;
			}

			$stored += $outcome;
		}

		return $stored;
	}

	/**
	 * Orders carrying render ids that have not been collected yet.
	 *
	 * 📌 **Read from order meta, not from a queue.** The requester's queue is
	 * emptied the moment the cloud accepts, and a render takes longer than that
	 * — so the list of what to collect is "every order with an uncollected id",
	 * which the orders themselves already record.
	 *
	 * @return array<int, int>
	 */
	private function pending_orders(): array {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}

		$orders = wc_get_orders(
			array(
				'limit'      => self::BATCH_SIZE,
				'orderby'    => 'date',
				'order'      => 'ASC',
				'return'     => 'ids',

				/*
				 * 🔴 **Every order with render ids, NOT just ones with no files
				 * yet.** A first version also required `META_RENDER_FILES` to be
				 * absent, which excluded an order the moment its FIRST line was
				 * collected — so a second designed line on the same order would
				 * never be fetched, and its print file would simply never
				 * arrive. The per-line check in `collect_for()` is what decides
				 * what is outstanding; this query only has to find candidates.
				 *
				 * ⚠️ Found by a test written to kill a surviving mutant: the
				 * obvious version of that test put both meta keys on one order,
				 * which this query filtered out before the per-line guard was
				 * ever reached.
				 */
				'meta_query' => array(
					array(
						'key'     => Keys::META_RENDER_IDS,
						'compare' => 'EXISTS',
					),
				),
			)
		);

		if ( ! is_array( $orders ) ) {
			return array();
		}

		$ids = array();

		foreach ( $orders as $id ) {
			if ( is_numeric( $id ) && (int) $id > 0 ) {
				$ids[] = (int) $id;
			}
		}

		return $ids;
	}

	/**
	 * Collect every outstanding file on one order.
	 *
	 * @param int $order_id WooCommerce order id.
	 *
	 * @return int|null Files stored, or null on a retryable failure.
	 */
	private function collect_for( int $order_id ): ?int {
		$order = $this->order( $order_id );

		if ( null === $order ) {
			return 0;
		}

		$renders = $this->decode_map( $order, Keys::META_RENDER_IDS );
		$files   = $this->decode_map( $order, Keys::META_RENDER_FILES );
		$stored  = 0;

		foreach ( $renders as $item_id => $render_id ) {
			if ( isset( $files[ $item_id ] ) ) {
				continue;
			}

			$outcome = $this->fetch_and_store( $render_id );

			if ( null === $outcome ) {
				return null;
			}

			if ( '' === $outcome ) {
				/*
				 * 📌 **Not ready yet is the ordinary case**, not a failure. The
				 * cloud answers 404 until the worker has rasterised, and the
				 * next pass asks again.
				 */
				continue;
			}

			$files[ $item_id ] = $outcome;
			++$stored;

			$this->confirm( $render_id, $order_id );
		}

		if ( $stored > 0 ) {
			$this->store_files( $order, $files );
		}

		return $stored;
	}

	/**
	 * Fetch one render and write it to the guarded directory.
	 *
	 * @param string $render_id The cloud's render id.
	 *
	 * @return string|null Stored filename, '' when not ready, null when retryable.
	 */
	private function fetch_and_store( string $render_id ): ?string {
		$response = $this->client->get_binary( '/store/renders/' . rawurlencode( $render_id ) . '/file' );

		if ( ! $response->is_ok() ) {
			$status = $response->status();

			if ( 404 === $status ) {
				// Not rendered yet, or already collected. Ask again next pass.
				return '';
			}

			return ( 0 === $status || 429 === $status || $status >= 500 ) ? null : '';
		}

		$bytes = $response->bytes();

		/*
		 * 🔴 **Content-Length is compared before anything is written.** A
		 * truncated print file still looks like a file and prints as damage —
		 * worse than a missing one, because nobody investigates a file that
		 * exists.
		 */
		$promised = $response->header( 'content-length' );

		if ( is_string( $promised ) && ctype_digit( $promised ) && strlen( $bytes ) !== (int) $promised ) {
			$this->logger->warning(
				'A print file arrived short and was discarded.',
				array(
					'render'   => $render_id,
					'expected' => (int) $promised,
					'received' => strlen( $bytes ),
				)
			);

			return null;
		}

		if ( ! str_starts_with( $bytes, self::PNG_SIGNATURE ) ) {
			$this->logger->warning(
				'A print file was not a PNG and was discarded.',
				array( 'render' => $render_id )
			);

			return '';
		}

		$directory = $this->store->directory();

		if ( '' === $directory ) {
			// Refusing beats writing a customer's artwork somewhere unprotected.
			return null;
		}

		try {
			$name = $this->store->unique_filename( 'png' );
		} catch ( \Exception $e ) {
			// No entropy: a predictable name would let one customer guess another's file.
			return null;
		}

		if ( false === file_put_contents( $directory . '/' . $name, $bytes ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- binary write into the plugin's own guarded directory.
			$this->logger->warning( 'Could not write a print file.', array( 'render' => $render_id ) );

			return null;
		}

		return $name;
	}

	/**
	 * Tell the cloud the merchant holds the file, so the buffer is released.
	 *
	 * ⚠️ **A failure here is logged, not retried into a loop.** The file is
	 * already stored, so the merchant has what they need; an unconfirmed job
	 * shows up in the cloud's uncollected count, which is exactly the signal
	 * that is meant to be visible.
	 *
	 * @param string $render_id The cloud's render id.
	 * @param int    $order_id  The order the file belongs to.
	 */
	private function confirm( string $render_id, int $order_id ): void {
		$response = $this->client->post(
			'/store/renders/' . rawurlencode( $render_id ) . '/collected',
			array( 'file_url' => $this->links->url( $order_id ) )
		);

		if ( ! $response->is_ok() ) {
			$this->logger->warning(
				'Stored a print file but could not confirm collection.',
				array(
					'render' => $render_id,
					'status' => $response->status(),
				)
			);
		}
	}

	/**
	 * A JSON map on the order, keyed by line item id.
	 *
	 * @param object $order WooCommerce order.
	 * @param string $key   Meta key.
	 *
	 * @return array<int, string>
	 */
	private function decode_map( object $order, string $key ): array {
		if ( ! method_exists( $order, 'get_meta' ) ) {
			return array();
		}

		$stored = json_decode( (string) $order->get_meta( $key, true ), true );

		if ( ! is_array( $stored ) ) {
			return array();
		}

		$out = array();

		foreach ( $stored as $item_id => $value ) {
			if ( is_numeric( $item_id ) && is_scalar( $value ) && '' !== (string) $value ) {
				$out[ (int) $item_id ] = (string) $value;
			}
		}

		return $out;
	}

	/**
	 * Record where each line's print file was stored.
	 *
	 * @param object             $order WooCommerce order.
	 * @param array<int, string> $files Line item id to stored filename.
	 */
	private function store_files( object $order, array $files ): void {
		if ( ! method_exists( $order, 'update_meta_data' ) || ! method_exists( $order, 'save' ) ) {
			return;
		}

		$order->update_meta_data( Keys::META_RENDER_FILES, (string) wp_json_encode( $files ) );
		$order->save();
	}

	/**
	 * Load an order.
	 *
	 * @param int $order_id WooCommerce order id.
	 */
	private function order( int $order_id ): ?object {
		if ( ! function_exists( 'wc_get_order' ) ) {
			return null;
		}

		$order = wc_get_order( $order_id );

		return is_object( $order ) ? $order : null;
	}
}
