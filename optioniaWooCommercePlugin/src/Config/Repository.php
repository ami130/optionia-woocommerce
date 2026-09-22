<?php
/**
 * Reads and writes the cached configuration document.
 *
 * Principle 2: the only place that touches Keys::OPTION_CONFIG. Call sites ask
 * this class for configuration rather than reaching for get_option(), so the
 * storage strategy can change without touching the callers.
 *
 * AC3 lives here: the storefront reads from this cache and never from the
 * network, so it keeps working when the API is unreachable.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Config;

use Optionia\Engine\SelectionResolver;
use Optionia\Support\Keys;
use Optionia\Support\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Local configuration cache.
 */
final class Repository {

	/**
	 * Highest config schema version this plugin build understands.
	 *
	 * A document declaring a higher version is refused rather than partially
	 * rendered — see M9.5. Rendering a document we only half understand risks
	 * charging a customer the wrong amount.
	 */
	public const SUPPORTED_SCHEMA_VERSION = 1;

	/**
	 * The price types this plugin version can charge.
	 *
	 * Read from `Engine\SelectionResolver` rather than restated, because a
	 * restatement is what M16.1 found here: this constant said `fixed` while the
	 * evaluator had grown `percentage`, so the admin notice would have called a
	 * correctly charged option unpriceable -- training merchants to ignore a
	 * warning that is right the next time.
	 *
	 * The evaluator is the authority because it is the code that actually
	 * charges. A warning derived from anything else is a second opinion about
	 * what the first one does.
	 *
	 * @var array<string>
	 */
	private const PRICED_TYPES = SelectionResolver::PRICED_TYPES;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * In-request cache of the decoded document.
	 *
	 * @var array<string, mixed>|null
	 */
	private ?array $cache = null;

	/**
	 * Whether the option has been read this request.
	 *
	 * Separate from `$cache` because null is a legitimate cached answer — an
	 * unconfigured store — and cannot double as "not yet loaded".
	 *
	 * @var bool
	 */
	private bool $loaded = false;

	/**
	 * Memoised product index.
	 *
	 * @var array<string, mixed>|null
	 */
	private ?array $index = null;

	/**
	 * Whether the index has been read this request.
	 *
	 * Separate from `$index` being null for the same reason `$loaded` is
	 * separate from `$cache`: null means both "no index stored" and "not looked
	 * yet", and conflating them turns a shop page rendering twenty-five products
	 * into twenty-five reads of a miss.
	 *
	 * @var bool
	 */
	private bool $index_loaded = false;

	/**
	 * Constructor.
	 *
	 * @param Logger $logger Logger.
	 */
	public function __construct( Logger $logger ) {
		$this->logger = $logger;
	}

	/**
	 * The cached configuration document, or null when nothing is cached.
	 *
	 * @return array<string, mixed>|null
	 */
	public function get(): ?array {
		/**
		 * `$loaded` rather than `null !== $this->cache`.
		 *
		 * Null is the answer for "nothing is cached" *and* for "not read yet",
		 * so a store with no configuration re-read the option on every call —
		 * measured at ten reads for ten calls. On a fresh install rendering a
		 * category page that is one query per product, on exactly the shop that
		 * has nothing to show for them.
		 *
		 * The flag separates the two questions, so a miss is remembered as
		 * cheaply as a hit. M9.2's budget is "≤1 extra DB read per product
		 * page", and it has to hold before the first sync as well as after.
		 */
		if ( $this->loaded ) {
			return $this->cache;
		}

		$stored = get_option( Keys::OPTION_CONFIG, null );

		$this->loaded = true;
		$this->cache  = is_array( $stored ) && array() !== $stored ? $stored : null;

		return $this->cache;
	}

	/**
	 * Whether a usable configuration is cached.
	 */
	public function has_config(): bool {
		return null !== $this->get();
	}

	/**
	 * Store a configuration document.
	 *
	 * Refuses documents declaring an unsupported schema version, keeping the
	 * previous good copy instead. A merchant on an old plugin build continues
	 * selling with their last known-good configuration rather than losing
	 * options entirely.
	 *
	 * @param array<string, mixed> $document Configuration document.
	 * @param string|null          $etag     ETag for conditional requests.
	 */
	public function store( array $document, ?string $etag = null ): bool {
		/**
		 * A body that is not a configuration document replaces nothing.
		 *
		 * `option_sets` is the one key every document carries — an empty array
		 * when a merchant has published nothing, but always present. Its absence
		 * means this is not a document at all.
		 *
		 * The case that makes this urgent: a `304 Not Modified` carries **no
		 * body**, and `Api\Response::is_ok()` is true for one. A synchroniser
		 * written the obvious way —
		 *
		 *     if ( $response->is_ok() ) { $repository->store( $response->data() ); }
		 *
		 * — would hand this an empty array every time nothing had changed, and
		 * the storefront would lose its configuration on the most ordinary path
		 * there is. Measured before this guard existed: a cached document at
		 * version 7 became `has_config = false`, version 0.
		 *
		 * Refusing here rather than only in the caller is deliberate. AC3
		 * promises the storefront keeps serving its cached copy, and a promise
		 * that depends on every future caller getting one conditional right is
		 * not a promise.
		 */
		if ( ! isset( $document['option_sets'] ) ) {
			$this->logger->warning(
				'Refused a body with no option_sets; keeping the previous configuration.',
				array( 'keys' => implode( ',', array_keys( $document ) ) )
			);

			return false;
		}

		$schema_version = isset( $document['schema_version'] ) ? (int) $document['schema_version'] : 0;

		if ( $schema_version > self::SUPPORTED_SCHEMA_VERSION ) {
			$this->logger->warning(
				'Refused a configuration document with an unsupported schema version; keeping the previous copy.',
				array(
					'document_schema' => $schema_version,
					'supported'       => self::SUPPORTED_SCHEMA_VERSION,
				)
			);

			/**
			 * Remembered, because the refusal is otherwise invisible (M9.5).
			 *
			 * Keeping the previous copy is the right behaviour — a shop keeps
			 * selling rather than losing its options — and it is exactly what
			 * makes this silent: the storefront works, the heartbeat arrives,
			 * the credential is fine, and the merchant is quietly running
			 * configuration older than the cloud holds.
			 *
			 * Recording it is what lets the settings screen say "update the
			 * plugin" and the heartbeat tell the cloud the same.
			 */
			update_option(
				Keys::OPTION_SCHEMA_REFUSED,
				array(
					'at'              => time(),
					'document_schema' => $schema_version,
					'supported'       => self::SUPPORTED_SCHEMA_VERSION,
				),
				false
			);

			return false;
		}

		/**
		 * An accepted document clears any earlier refusal.
		 *
		 * A merchant who updates their plugin should stop being told to. The
		 * flag describes the present, not a history — the log holds the history.
		 */
		if ( false !== get_option( Keys::OPTION_SCHEMA_REFUSED, false ) ) {
			delete_option( Keys::OPTION_SCHEMA_REFUSED );
		}

		$this->record_unpriced_types( $document );

		// Autoload off: the document can be large and is not needed on most
		// requests, so loading it into every page's option cache is waste.
		update_option( Keys::OPTION_CONFIG, $document, false );

		update_option(
			Keys::OPTION_CONFIG_META,
			array(
				'config_version' => isset( $document['config_version'] ) ? (int) $document['config_version'] : 0,
				'schema_version' => $schema_version,
				'fetched_at'     => time(),
				'etag'           => $etag,
			),
			false
		);

		/**
		 * The index is written **after** the document, deliberately.
		 *
		 * WordPress options are not transactional, so these two writes cannot be
		 * atomic. Ordered this way, a failure between them leaves a *stale*
		 * index — one naming sets the previous document had — rather than an
		 * index pointing at configuration that is not there. A stale index
		 * resolves to sets the reader then fails to find, which is recoverable;
		 * the reverse is a lookup into nothing.
		 */
		update_option( Keys::OPTION_PRODUCT_INDEX, ProductIndex::build( $document ), false );

		$this->cache        = $document;
		$this->loaded       = true;
		$this->index        = null;
		$this->index_loaded = false;

		$this->logger->info(
			'Stored configuration document.',
			array( 'config_version' => isset( $document['config_version'] ) ? (int) $document['config_version'] : 0 )
		);

		return true;
	}

	/**
	 * The document shape this build last refused, or null if none.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function refused_schema(): ?array {
		$entry = get_option( Keys::OPTION_SCHEMA_REFUSED, null );

		return is_array( $entry ) ? $entry : null;
	}

	/**
	 * Price types in the stored configuration this version cannot price.
	 *
	 * Null when everything in the document is priceable. Read by the admin
	 * notice and by System Status, so the two cannot disagree about whether this
	 * shop is undercharging.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function unpriced_types(): ?array {
		$entry = get_option( Keys::OPTION_UNPRICED_TYPES, null );

		return is_array( $entry ) ? $entry : null;
	}

	/**
	 * Cache metadata: config_version, schema_version, fetched_at, etag.
	 *
	 * @return array<string, mixed>
	 */
	public function meta(): array {
		$stored = get_option( Keys::OPTION_CONFIG_META, array() );

		return is_array( $stored ) ? $stored : array();
	}

	/**
	 * Version of the cached configuration, or 0 when nothing is cached.
	 */
	public function config_version(): int {
		$meta = $this->meta();

		return isset( $meta['config_version'] ) ? (int) $meta['config_version'] : 0;
	}

	/**
	 * ETag of the cached configuration, for conditional requests.
	 */
	public function etag(): ?string {
		$meta = $this->meta();

		return isset( $meta['etag'] ) && is_string( $meta['etag'] ) ? $meta['etag'] : null;
	}

	/**
	 * Unix timestamp of the last successful fetch, or null.
	 */
	public function fetched_at(): ?int {
		$meta = $this->meta();

		return isset( $meta['fetched_at'] ) ? (int) $meta['fetched_at'] : null;
	}

	/**
	 * Approximate size of the cached document in bytes, for System Status.
	 */
	public function size_bytes(): int {
		$encoded = wp_json_encode( $this->get() ?? array() );

		return false === $encoded ? 0 : strlen( $encoded );
	}

	/**
	 * Option set ids applying to one product.
	 *
	 * The storefront's entry point: one memoised read of the index, then an
	 * array lookup per product. M9.2's acceptance — "≤1 extra DB read per
	 * product page" — is this method, and `ConfigReadBudgetTest` measures it.
	 *
	 * @param int $product_id WooCommerce product id.
	 * @return array<int, string>
	 */
	public function sets_for_product( int $product_id ): array {
		return ProductIndex::for_product( $this->index(), $product_id );
	}

	/**
	 * The published option sets applying to one product, in resolution order.
	 *
	 * What a renderer actually needs: `sets_for_product()` answers *which* sets
	 * apply, and this answers *what they contain*, in the order
	 * `Config\ProductIndex` resolved them by assignment priority.
	 *
	 * The document is walked once and keyed, rather than searched per set. A
	 * linear search costs under a millisecond even at five hundred sets — it is
	 * not a performance problem — but keying is the honest shape for "look this
	 * up", and it stops a shop page's cost depending on where in the document a
	 * merchant's sets happen to sit.
	 *
	 * Lives here, on the class that already owns the cache, so it stays inside
	 * the AC3 gate's coverage: `bin/check-architecture.sh` inspects every file
	 * that calls `sets_for_product()`, and a lookup written elsewhere would be a
	 * render-path file the gate had to be told about.
	 *
	 * @param int $product_id WooCommerce product id.
	 * @return array<int, array<string, mixed>>
	 */
	public function option_sets_for_product( int $product_id ): array {
		$wanted = $this->sets_for_product( $product_id );

		if ( array() === $wanted ) {
			return array();
		}

		$document = $this->get();

		if ( null === $document || ! isset( $document['option_sets'] ) || ! is_array( $document['option_sets'] ) ) {
			return array();
		}

		$by_id = array();

		foreach ( $document['option_sets'] as $set ) {
			if ( is_array( $set ) && isset( $set['id'] ) && is_string( $set['id'] ) ) {
				$by_id[ $set['id'] ] = $set;
			}
		}

		$resolved = array();

		foreach ( $wanted as $set_id ) {
			/*
			 * A set the index names but the document does not hold is skipped,
			 * not fatal. The two are written together by `store()`, so they
			 * disagree only if a write failed between them -- and the index is
			 * written second precisely so that failure leaves a *stale* index
			 * rather than one pointing at nothing. Skipping keeps the rest of
			 * the product's options rendering.
			 */
			if ( isset( $by_id[ $set_id ] ) ) {
				$resolved[] = $by_id[ $set_id ];
			}
		}

		return $resolved;
	}

	/**
	 * How many products the index names.
	 */
	public function index_entry_count(): int {
		return ProductIndex::entry_count( $this->index() );
	}

	/**
	 * How many assignments the index could not resolve.
	 */
	public function index_skipped_count(): int {
		return ProductIndex::skipped_count( $this->index() );
	}

	/**
	 * The stored index, read at most once per request.
	 *
	 * @return array<string, mixed>
	 */
	private function index(): array {
		if ( $this->index_loaded ) {
			return $this->index ?? array();
		}

		$stored = get_option( Keys::OPTION_PRODUCT_INDEX, null );

		$this->index_loaded = true;
		$this->index        = is_array( $stored ) ? $stored : array();

		return $this->index;
	}

	/**
	 * Delete the cached configuration.
	 *
	 * Used by disconnect and uninstall. Note that this stops options rendering,
	 * so it is never called as part of ordinary error handling.
	 */
	public function clear(): void {
		delete_option( Keys::OPTION_CONFIG );
		delete_option( Keys::OPTION_CONFIG_META );
		delete_option( Keys::OPTION_PRODUCT_INDEX );

		$this->cache        = null;
		$this->loaded       = false;
		$this->index        = null;
		$this->index_loaded = false;
	}

	/**
	 * Record a price config's type when this build cannot charge it here.
	 *
	 * @param mixed         $price   A `price_config` or `pricing` block, or anything else.
	 * @param array<string> $priced  The types chargeable in this position.
	 * @param array<string> $found   Collects unchargeable types, deduplicated.
	 */
	private static function collect_unpriced( $price, array $priced, array &$found ): void {
		if ( ! is_array( $price ) || ! is_scalar( $price['type'] ?? null ) ) {
			return;
		}

		$type = (string) $price['type'];

		if ( '' === $type || in_array( $type, $priced, true ) || in_array( $type, $found, true ) ) {
			return;
		}

		$found[] = $type;
	}

	/**
	 * Record any price type in this document that this version cannot price.
	 *
	 * The cloud's schema publishes five price types -- `fixed`, `percentage`,
	 * `per_unit`, `per_char`, `tiered` -- and this phase's evaluator implements
	 * `fixed`. An option of any other type contributes **nothing** to the line
	 * total. That is the right arithmetic: guessing at an unimplemented type
	 * would be worse, and refusing the document would take a working storefront
	 * down on a publish it could otherwise mostly honour.
	 *
	 * It is also indistinguishable from a free option. Measured before this
	 * existed: a 50% surcharge configured on an 80.00 product charged 80.00, the
	 * merchant lost 40.00 a unit, and nothing anywhere said so -- no log, no
	 * notice, no failing test. Correct by scope and still a silent undercharge.
	 *
	 * Scanned once here, at store time, rather than on every price calculation:
	 * the document changes rarely and the cart is priced constantly.
	 *
	 * @param array<string, mixed> $document The accepted configuration document.
	 */
	private function record_unpriced_types( array $document ): void {
		$found = array();

		foreach ( (array) ( $document['option_sets'] ?? array() ) as $set ) {
			foreach ( (array) ( $set['groups'] ?? array() ) as $group ) {
				foreach ( (array) ( $group['options'] ?? array() ) as $option ) {
					if ( ! is_array( $option ) ) {
						continue;
					}

					/*
					 * 🔴 **Option-level pricing is scanned too, and against a
					 * different list.**
					 *
					 * This loop walked values only, and compared every type it
					 * found against one flat list of what the build can charge.
					 * Both halves were wrong once `per_char` arrived:
					 *
					 * - a `per_char` on a **value** was treated as priced, so the
					 *   merchant got no notice -- while the evaluator reported it
					 *   as unpriced at runtime. Two answers to one question.
					 * - an option-level `pricing` block was never looked at at
					 *   all, so an unimplemented type there was silent.
					 *
					 * `PRICING-SPEC.md` §2 states which types belong where, so
					 * "can this build charge the type" and "can it charge it
					 * **here**" are different questions and get different lists.
					 */
					self::collect_unpriced(
						$option['pricing'] ?? null,
						SelectionResolver::OPTION_PRICED_TYPES,
						$found
					);

					foreach ( (array) ( $option['values'] ?? array() ) as $value ) {
						self::collect_unpriced(
							is_array( $value ) ? ( $value['price_config'] ?? null ) : null,
							SelectionResolver::VALUE_PRICED_TYPES,
							$found
						);
					}
				}
			}
		}

		/**
		 * A document with nothing unpriceable clears any earlier record.
		 *
		 * A merchant who removes the unsupported options, or updates the plugin,
		 * should stop being told about them. The flag describes the present; the
		 * log holds the history. Same lifecycle as `OPTION_SCHEMA_REFUSED`.
		 */
		if ( array() === $found ) {
			if ( false !== get_option( Keys::OPTION_UNPRICED_TYPES, false ) ) {
				delete_option( Keys::OPTION_UNPRICED_TYPES );
			}

			return;
		}

		sort( $found );

		$this->logger->warning(
			'The published configuration uses price types this version cannot price.',
			array(
				'price_types' => $found,
				'implemented' => self::PRICED_TYPES,
			)
		);

		update_option(
			Keys::OPTION_UNPRICED_TYPES,
			array(
				'at'          => time(),
				'price_types' => $found,
				'implemented' => self::PRICED_TYPES,
			),
			false
		);
	}
}
