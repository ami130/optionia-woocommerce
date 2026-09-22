<?php
/**
 * Reads the store's catalogue into the cloud's wire shape (M19.1).
 *
 * ## The store pushes; the cloud never pulls
 *
 * ADR-067: the cloud holds no WooCommerce credentials and AC8 forbids it
 * holding any -- *"every plugin installation is treated as potentially
 * hostile"*. A pull would mean a per-tenant pool of WooCommerce read-write
 * keys, the exact reversal of that trust direction. So the catalogue is read
 * here, in-process, with no credentials at all.
 *
 * ## Ordered by id ascending, and that is load-bearing
 *
 * 🔴 The walk is a **cursor over an offset**, and the backend's own
 * `ProductsRepository` records why offsets are dangerous: *"`OFFSET` re-counts
 * every skipped row on each page and shifts under concurrent writes"*. A 100k
 * catalogue takes **4.2 days** at 250 products per quarter-hour, which is a
 * long time for a merchant to add a product.
 *
 * Under WooCommerce's default ordering (`date DESC`) a new product lands at the
 * **front** and shifts every later page by one, so each insert silently skips a
 * product. Ordered by **id ascending**, a new product gets a higher id and is
 * appended *past* the cursor, never moving a row already walked.
 *
 * ⚠️ **Deletions still shift, and that is deferred on purpose.** Removing a
 * product moves later rows *down*, so a walk can skip at most one product per
 * deletion. `wc_get_products()` exposes no keyset (`WHERE id > ?`), so this is
 * the ceiling available here -- and M19.3's reconciliation is the designed
 * repair, not an oversight.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Catalogue;

use Optionia\Support\Money;

defined( 'ABSPATH' ) || exit;

/**
 * Builds one batch of the catalogue push.
 */
final class CataloguePayload {

	/**
	 * Taxonomies the cloud mirrors, and the wire key each becomes.
	 *
	 * 📌 **Slugs, not names or ids.** ADR-068 resolves a taxonomy assignment in
	 * the **plugin**, against the terms WordPress holds; the cloud stores these
	 * so a picker can eventually name them, not so it can resolve them. A slug
	 * is what `has_term()` takes, so it is what an assignment must carry.
	 */
	private const TAXONOMIES = array(
		'product_cat' => 'categories',
		'product_tag' => 'tags',
	);

	/**
	 * The most terms carried for one taxonomy on one product.
	 *
	 * Matches the API's own `@ArrayMaxSize(50)`. Sending more would fail the
	 * whole batch on a validator rather than one product, so the surplus is
	 * dropped here where the cost is one product's completeness.
	 */
	private const MAX_TERMS = 50;

	/**
	 * One page of products, in the wire shape, with the catalogue total.
	 *
	 * @param int $offset How many products the walk has already covered.
	 * @param int $limit  How many to read now.
	 * @return array{products: array<int, array<string, mixed>>, total: int}
	 */
	public function page( int $offset, int $limit ): array {
		if ( ! function_exists( 'wc_get_products' ) ) {
			// WooCommerce inactive: nothing to push, and not an error to report.
			return array(
				'products' => array(),
				'total'    => 0,
			);
		}

		$result = wc_get_products(
			array(
				'limit'    => max( 1, $limit ),
				'offset'   => max( 0, $offset ),
				'orderby'  => 'ID',
				'order'    => 'ASC',
				'paginate' => true,

				/*
				 * Every status, deliberately. A draft or private product still
				 * needs a mirror row: a merchant assigns options to a product
				 * *before* publishing it, and the picker showing "draft -- not
				 * visible on your storefront" is only possible if the row exists.
				 */
				'status'   => array( 'publish', 'draft', 'pending', 'private' ),
			)
		);

		if ( ! is_object( $result ) || ! isset( $result->products ) || ! is_array( $result->products ) ) {
			return array(
				'products' => array(),
				'total'    => 0,
			);
		}

		$products = array();

		foreach ( $result->products as $product ) {
			$entry = $this->entry( $product );

			if ( array() !== $entry ) {
				$products[] = $entry;
			}
		}

		return array(
			'products' => $products,
			'total'    => isset( $result->total ) ? max( 0, (int) $result->total ) : 0,
		);
	}

	/**
	 * Named products, in the wire shape (M19.2).
	 *
	 * The incremental counterpart to `page()`: the queue holds ids, and this
	 * turns the ones that still exist into entries the ingest accepts.
	 *
	 * ⚠️ **A missing product is silently omitted, not an error.** Between a
	 * merchant's edit and the next drain the product may have been deleted --
	 * the queue would then hold an id `wc_get_product()` answers `false` for.
	 * The removal is queued separately by `ProductWatcher`, so dropping it here
	 * leaves the right end state rather than failing a whole drain over a race.
	 *
	 * @param array<int, int> $product_ids WooCommerce product ids.
	 * @return array<int, array<string, mixed>>
	 */
	public function for_ids( array $product_ids ): array {
		if ( ! function_exists( 'wc_get_product' ) ) {
			return array();
		}

		$entries = array();

		foreach ( $product_ids as $product_id ) {
			$product = wc_get_product( (int) $product_id );

			if ( ! is_object( $product ) ) {
				continue;
			}

			$entry = $this->entry( $product );

			if ( array() !== $entry ) {
				$entries[] = $entry;
			}
		}

		return $entries;
	}

	/**
	 * One product, in the wire shape.
	 *
	 * Returns an empty array for anything that cannot be identified: a product
	 * with no usable id has nothing an assignment could target, so sending it
	 * would fail the batch for a row that could never be resolved anyway.
	 *
	 * @param mixed $product A WooCommerce product.
	 * @return array<string, mixed>
	 */
	private function entry( $product ): array {
		if ( ! is_object( $product ) || ! method_exists( $product, 'get_id' ) ) {
			return array();
		}

		$id = (int) $product->get_id();

		if ( $id <= 0 ) {
			return array();
		}

		$entry = array(
			'external_id' => (string) $id,
			'name'        => $this->text( $product, 'get_name', 255 ),
			'type'        => $this->text( $product, 'get_type', 20 ),
			'status'      => $this->text( $product, 'get_status', 20 ),
		);

		/*
		 * ⚠️ Required fields are never empty on the wire. `@Length(1, …)` on the
		 * API refuses an empty string, so a product WooCommerce has not finished
		 * writing would fail the whole batch. A placeholder is honest here: the
		 * row exists, and the name is the one thing a later sync will correct.
		 */
		if ( '' === $entry['name'] ) {
			$entry['name'] = '(no name)';
		}

		if ( '' === $entry['type'] ) {
			$entry['type'] = 'simple';
		}

		if ( '' === $entry['status'] ) {
			$entry['status'] = 'publish';
		}

		$entry['sku']         = $this->optional_text( $product, 'get_sku', 100 );
		$entry['permalink']   = $this->optional_text( $product, 'get_permalink', 500 );
		$entry['image_url']   = $this->image_url( $product );
		$entry['price_minor'] = $this->price_minor( $product );

		foreach ( self::TAXONOMIES as $taxonomy => $key ) {
			$entry[ $key ] = $this->terms( $id, $taxonomy );
		}

		$entry['external_updated_at'] = $this->modified_at( $product );

		return $entry;
	}

	/**
	 * The price in minor units, or null.
	 *
	 * 🔴 **`Money`, never a cast.** `get_price()` returns a **decimal string**,
	 * and `(float) '19.99' * 100` is `1998.9999…` -- the class of defect
	 * `check-architecture.sh` bans floats near money to prevent.
	 * `try_from_decimal()` answers null for anything unparseable, which is
	 * exactly the contract `price_minor` carries on the wire.
	 *
	 * ⚠️ **Null is meaningful.** A variable product genuinely has no single
	 * price, and the picker prints an em dash for it. Defaulting to 0 would show
	 * a free product where the merchant has a price range.
	 *
	 * @param mixed $product A WooCommerce product.
	 */
	private function price_minor( $product ): ?int {
		if ( ! method_exists( $product, 'get_price' ) ) {
			return null;
		}

		$price = $product->get_price();

		if ( ! is_string( $price ) && ! is_numeric( $price ) ) {
			return null;
		}

		if ( '' === (string) $price ) {
			return null;
		}

		$money = Money::try_from_decimal( $price );

		return null === $money ? null : $money->minor();
	}

	/**
	 * A product's term slugs for one taxonomy.
	 *
	 * @param int    $product_id Product id.
	 * @param string $taxonomy   Taxonomy name.
	 * @return array<int, string>|null
	 */
	private function terms( int $product_id, string $taxonomy ): ?array {
		if ( ! function_exists( 'get_the_terms' ) ) {
			return null;
		}

		$terms = get_the_terms( $product_id, $taxonomy );

		if ( ! is_array( $terms ) ) {
			// `false` for none, `WP_Error` for an unregistered taxonomy.
			return null;
		}

		$slugs = array();

		foreach ( $terms as $term ) {
			if ( ! is_object( $term ) || ! isset( $term->slug ) || ! is_string( $term->slug ) ) {
				continue;
			}

			$slug = $this->truncate( $term->slug, 200 );

			if ( '' !== $slug ) {
				$slugs[] = $slug;
			}

			if ( count( $slugs ) >= self::MAX_TERMS ) {
				break;
			}
		}

		/*
		 * An empty list is null, not `array()`. The API stores this in a `json`
		 * column where SQL NULL and an empty JSON array are different values,
		 * and a reader cannot tell "no categories" from "not synced" if both
		 * arrive as `[]`.
		 */
		return array() === $slugs ? null : $slugs;
	}

	/**
	 * The product's main image URL, or null.
	 *
	 * @param mixed $product A WooCommerce product.
	 */
	private function image_url( $product ): ?string {
		if ( ! method_exists( $product, 'get_image_id' ) || ! function_exists( 'wp_get_attachment_image_url' ) ) {
			return null;
		}

		$image_id = (int) $product->get_image_id();

		if ( $image_id <= 0 ) {
			return null;
		}

		$url = wp_get_attachment_image_url( $image_id, 'thumbnail' );

		if ( ! is_string( $url ) || '' === $url ) {
			return null;
		}

		return $this->truncate( $url, 500 );
	}

	/**
	 * When the product last changed upstream, in ISO-8601, or null.
	 *
	 * Carried so M19.3's reconciliation can tell a stale mirror row from a
	 * current one without re-reading the whole catalogue.
	 *
	 * @param mixed $product A WooCommerce product.
	 */
	private function modified_at( $product ): ?string {
		if ( ! method_exists( $product, 'get_date_modified' ) ) {
			return null;
		}

		$modified = $product->get_date_modified();

		if ( ! is_object( $modified ) || ! method_exists( $modified, 'date' ) ) {
			return null;
		}

		$formatted = $modified->date( 'c' );

		return is_string( $formatted ) && '' !== $formatted ? $formatted : null;
	}

	/**
	 * A required string field, truncated to its column length.
	 *
	 * @param mixed  $product A WooCommerce product.
	 * @param string $method  Getter name.
	 * @param int    $length  Maximum length.
	 */
	private function text( $product, string $method, int $length ): string {
		if ( ! method_exists( $product, $method ) ) {
			return '';
		}

		$value = $product->{$method}();

		return is_string( $value ) || is_numeric( $value ) ? $this->truncate( (string) $value, $length ) : '';
	}

	/**
	 * An optional string field: null rather than an empty string.
	 *
	 * ⚠️ WooCommerce answers `''` for an unset SKU, and the wire wants null --
	 * `@Length(0, 100)` accepts both, but an empty string stored in a nullable
	 * column means "the merchant set it to nothing", which is a different fact.
	 *
	 * @param mixed  $product A WooCommerce product.
	 * @param string $method  Getter name.
	 * @param int    $length  Maximum length.
	 */
	private function optional_text( $product, string $method, int $length ): ?string {
		$value = $this->text( $product, $method, $length );

		return '' === $value ? null : $value;
	}

	/**
	 * Cut a string to a length the API will accept.
	 *
	 * 🔴 **Measured in UTF-16 code units, not characters — and an audit found
	 * this wrong.** An earlier version used `mb_substr()` and its docblock
	 * claimed *"the API counts characters too"*. It does not: `@Length(1, 255)`
	 * in `class-validator` measures a JavaScript string's `.length`, which
	 * counts **UTF-16 code units**, and every astral-plane character — emoji,
	 * rare CJK — counts as **two**.
	 *
	 * Measured: 255 emoji is `mb_strlen() === 255` and `.length === 510`. So a
	 * name truncated the old way passed here and was **rejected there**, and
	 * because a batch is all-or-nothing, one emoji product name cost **249 good
	 * products their write** — and the cursor never advanced past it.
	 *
	 * ⚠️ **MySQL would have accepted it**: `varchar(255)` counts characters. The
	 * rejection is the validator's alone, which is why the fix belongs here
	 * rather than in the schema.
	 *
	 * Cuts on whole characters, never between a surrogate pair's halves: a split
	 * one is invalid UTF-8 that `wp_json_encode()` refuses outright, failing the
	 * batch a different way.
	 *
	 * @param string $value  The value.
	 * @param int    $length Maximum length in UTF-16 code units.
	 */
	private function truncate( string $value, int $length ): string {
		$trimmed = trim( $value );

		if ( '' === $trimmed || $length <= 0 ) {
			return '';
		}

		$characters = preg_split( '//u', $trimmed, -1, PREG_SPLIT_NO_EMPTY );

		if ( ! is_array( $characters ) ) {
			/*
			 * `preg_split` fails on invalid UTF-8. Such a value cannot be JSON
			 * encoded either, so an empty string is the honest answer: the
			 * caller substitutes a placeholder for a required field, and an
			 * optional one becomes null.
			 */
			return '';
		}

		$out  = '';
		$used = 0;

		foreach ( $characters as $character ) {
			$width = $this->utf16_width( $character );

			if ( $used + $width > $length ) {
				break;
			}

			$out  .= $character;
			$used += $width;
		}

		return $out;
	}

	/**
	 * How many UTF-16 code units one character occupies: 1, or 2 above U+FFFF.
	 *
	 * @param string $character A single UTF-8 character.
	 */
	private function utf16_width( string $character ): int {
		if ( ! function_exists( 'mb_ord' ) ) {
			/*
			 * Without `mbstring`, assume the worst. Over-counting truncates
			 * sooner than necessary; under-counting sends a value the API
			 * rejects, and a shorter name is better than a failed batch.
			 */
			return strlen( $character ) > 3 ? 2 : 1;
		}

		$code_point = mb_ord( $character, 'UTF-8' );

		return ( false !== $code_point && $code_point > 0xFFFF ) ? 2 : 1;
	}
}
