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
	 * Renders the cloud gave up on during this pass, render id to reason.
	 *
	 * 📌 **Held for the pass rather than returned**, because `fetch_and_store`
	 * already answers three things — a filename, "not ready", and "retryable" —
	 * and a fourth return shape would make every caller re-read it.
	 *
	 * @var array<string, string>
	 */
	private array $failures = array();

	/**
	 * Renders that arrived incomplete during this pass, render id to reason.
	 *
	 * @var array<string, string>
	 */
	private array $partials = array();

	/**
	 * Renders already asked about during this pass.
	 *
	 * ⚠️ **One order may carry the same render id on two lines** — a retry
	 * that resolved to the existing job — and asking twice for one answer is
	 * waste against a bounded allowance.
	 *
	 * @var array<string, bool>
	 */
	private array $asked = array();

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

		$renders  = $this->decode_map( $order, Keys::META_RENDER_IDS );
		$files    = $this->decode_map( $order, Keys::META_RENDER_FILES );
		$failures = $this->decode_map( $order, Keys::META_RENDER_FAILURES );
		$stored   = 0;

		$this->failures = array();
		$this->partials = array();
		$this->asked    = array();

		foreach ( $renders as $item_id => $render_id ) {
			if ( isset( $files[ $item_id ] ) ) {
				continue;
			}

			/*
			 * 🔴 **A line the cloud gave up on is never asked about again.**
			 * The cloud answers 404 for a dead job for ever, so without this
			 * the collector would re-ask on every cron pass — which is exactly
			 * what it did before M26e.6.
			 */
			if ( isset( $failures[ $item_id ] ) ) {
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

			/*
			 * ⚠️ **A file that arrived may still be missing a layer** (F173).
			 * The cloud renders what it can rather than failing the job, so
			 * the reason is asked for once — here, where the file is known to
			 * exist — and shown beside a download that works.
			 */
			$this->note_if_partial( $render_id );

			$this->confirm( $render_id, $order_id );
		}

		foreach ( $renders as $item_id => $render_id ) {
			if ( isset( $this->failures[ $render_id ] ) ) {
				$failures[ $item_id ] = $this->failures[ $render_id ];
			}
		}

		if ( $stored > 0 ) {
			$this->store_files( $order, $files );
		}

		/*
		 * ⚠️ **Written whether or not a file was stored.** An order whose only
		 * designed line failed stores nothing, and that is precisely the order
		 * a merchant most needs flagged — M26e.6's *"order flagged for manual
		 * attention"*.
		 */
		if ( array() !== $this->failures ) {
			$this->store_map( $order, Keys::META_RENDER_FAILURES, $failures );
		}

		if ( array() !== $this->partials ) {
			$partials = $this->decode_map( $order, Keys::META_RENDER_PARTIAL );

			foreach ( $renders as $item_id => $render_id ) {
				if ( isset( $this->partials[ $render_id ] ) ) {
					$partials[ $item_id ] = $this->partials[ $render_id ];
				}
			}

			$this->store_map( $order, Keys::META_RENDER_PARTIAL, $partials );
		}

		return $stored;
	}

	/**
	 * Fetch one render and write it to the guarded directory.
	 *
	 * @param string $render_id The cloud's render id.
	 *
	 * @return string|null Stored filename, '' when not ready, null when retryable.
	 *                     A permanent failure is recorded via `$this->failures`.
	 */
	private function fetch_and_store( string $render_id ): ?string {
		$response = $this->client->get_binary( '/store/renders/' . rawurlencode( $render_id ) . '/file' );

		if ( ! $response->is_ok() ) {
			$status = $response->status();

			if ( 404 === $status ) {
				/*
				 * 🔴 **A 404 means one of two opposite things**, and guessing
				 * cost a merchant their print file. The cloud answers it while
				 * a job is still rasterising AND after it has been given up on
				 * — so treating every 404 as "ask again next pass" retried a
				 * dead render on every cron run for ever, and nothing ever
				 * told the merchant. Asking which is the whole of M26e.6's
				 * second row.
				 */
				return $this->outcome_of( $render_id );
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
	 * Record why a delivered file is incomplete, when it is (F173).
	 *
	 * 📌 **Asked only for a file that ARRIVED.** A render that failed is
	 * handled by `outcome_of`; this is the quieter case — the print file is
	 * usable and one layer is missing from it.
	 *
	 * @param string $render_id The cloud's render id.
	 */
	private function note_if_partial( string $render_id ): void {
		$response = $this->client->get( '/store/renders/' . rawurlencode( $render_id ) );

		if ( ! $response->is_ok() ) {
			return;
		}

		$data   = $response->data();
		$reason = isset( $data['lastError'] ) && is_scalar( $data['lastError'] ) ? (string) $data['lastError'] : '';

		if ( '' === $reason ) {
			return;
		}

		$this->partials[ $render_id ] = $reason;

		$this->logger->warning(
			'A print file arrived incomplete.',
			array(
				'render' => $render_id,
				'reason' => $reason,
			)
		);
	}

	/**
	 * Ask what became of a render the file route would not serve.
	 *
	 * 🔴 **`failed` is the answer that matters.** The cloud gives up after
	 * `MAX_RENDER_ATTEMPTS` and keeps the source design; the plugin must stop
	 * asking and tell the merchant, which is M26e.6's second row. Everything
	 * else means "not yet", and the next pass asks again.
	 *
	 * ⚠️ **A status this build does not recognise is treated as "not yet".**
	 * A newer cloud adding a state must not make an older plugin abandon a
	 * render it would have collected.
	 *
	 * @param string $render_id The cloud's render id.
	 *
	 * @return string '' when the next pass should ask again.
	 */
	private function outcome_of( string $render_id ): string {
		/*
		 * 📌 **Asked at most once per render, per pass — and only for a line
		 * that has been waiting.** A fresh request 404s for the seconds before
		 * the worker claims it, and asking then would double this pass's cloud
		 * calls to learn "preparing", which the next pass learns for free.
		 *
		 * ⚠️ **The cost is real but small, and stated rather than guessed**:
		 * ten orders a pass, four passes an hour, against a 600/hour ceiling —
		 * so at most 40 extra calls, roughly 7%. The alternative is a dead
		 * render retried for ever, which is what this replaced.
		 */
		if ( isset( $this->asked[ $render_id ] ) ) {
			return '';
		}

		$this->asked[ $render_id ] = true;

		$response = $this->client->get( '/store/renders/' . rawurlencode( $render_id ) );

		if ( ! $response->is_ok() ) {
			/*
			 * 📌 **An unanswerable status question is not a failure.** The
			 * render may be fine and the connection momentarily not; the file
			 * route will be asked again next pass either way.
			 */
			return '';
		}

		$data   = $response->data();
		$status = isset( $data['status'] ) && is_scalar( $data['status'] ) ? (string) $data['status'] : '';

		if ( 'failed' !== $status ) {
			return '';
		}

		$reason = isset( $data['lastError'] ) && is_scalar( $data['lastError'] ) && '' !== (string) $data['lastError']
			? (string) $data['lastError']
			: __( 'The cloud could not render this design.', 'optionia' );

		$this->failures[ $render_id ] = $reason;

		$this->logger->warning(
			'A render was given up on by the cloud.',
			array(
				'render' => $render_id,
				'reason' => $reason,
			)
		);

		return '';
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
		$this->store_map( $order, Keys::META_RENDER_FILES, $files );
	}

	/**
	 * Write one line-keyed map onto the order.
	 *
	 * @param object             $order WooCommerce order.
	 * @param string             $key   Meta key.
	 * @param array<int, string> $map   Line item id to value.
	 */
	private function store_map( object $order, string $key, array $map ): void {
		if ( ! method_exists( $order, 'update_meta_data' ) || ! method_exists( $order, 'save' ) ) {
			return;
		}

		$order->update_meta_data( $key, (string) wp_json_encode( $map ) );
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
