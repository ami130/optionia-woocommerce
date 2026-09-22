<?php
/**
 * `product_id → applicable option sets`, built when configuration is stored (M10.1).
 *
 * ## Why an index rather than a scan
 *
 * A shop page renders dozens of products in one request. Answering "which option
 * sets apply to this product?" by walking every set's assignments would be
 * `O(products × sets × assignments)` per page, on the largest catalogues — the
 * ones where it matters most. Building the map once, when the document is
 * written, turns each lookup into an array read.
 *
 * ## Why it is built at write time
 *
 * Inside `Repository::store()`, so it cannot drift from the document it indexes.
 * An index rebuilt on read would be a second source of truth about the same
 * bytes; an index built on a schedule would lag. Written together, the only way
 * they disagree is a failure between the two `update_option()` calls — which is
 * why the document is written first, so a partial failure leaves a *stale* index
 * rather than one naming sets no longer present.
 *
 * ## What it does not cover
 *
 * `all` and `manual` only. A write-time index cannot express `conditional`:
 * its condition tree is evaluated against product state, and the `category`,
 * `tag`, `attribute` and `price_range` targets resolve against WordPress data
 * the configuration document does not carry. Those are M19.4's, and the count of
 * what was skipped is recorded so the gap is visible in the admin rather than
 * silently missing.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Config;

defined( 'ABSPATH' ) || exit;

/**
 * Builds and reads the product index.
 */
final class ProductIndex {

	/**
	 * Assignment modes this index can resolve.
	 *
	 * Named rather than inferred: a mode absent from here is *skipped and
	 * counted*, not silently dropped, so a mode added to the contract later
	 * shows up in the admin as deferred rather than vanishing.
	 */
	private const MODE_ALL    = 'all';
	private const MODE_MANUAL = 'manual';

	/**
	 * Assignment target types that resolve against WordPress taxonomy.
	 *
	 * Mapped to the taxonomy `has_term()` takes, because the wire vocabulary and
	 * WordPress's are different spellings of the same thing -- and the mapping
	 * belongs in one place rather than at each call site.
	 */
	private const TAXONOMIES = array(
		'category' => 'product_cat',
		'tag'      => 'product_tag',
	);

	/**
	 * Build the index from a configuration document.
	 *
	 * Returns the structure written to `OPTION_PRODUCT_INDEX`:
	 *
	 * ```
	 * array(
	 *   'products' => array( 20 => array( 'set-a' ), 23 => array( 'set-a', 'set-b' ) ),
	 *   'all'      => array( 'set-c' ),
	 *   'terms'    => array( array( 'set_id' => 'set-d', 'taxonomy' => 'product_cat',
	 *                              'slug' => 'shirts', 'priority' => 0 ) ),
	 *   'skipped'  => 1,
	 * )
	 * ```
	 *
	 * `all` is a list, not keys. An index keyed by product cannot hold "every
	 * product in the store", which is the whole reason `mode` exists on the
	 * assignment shape — without it a reader cannot tell "applies to everything"
	 * from "applies to nothing".
	 *
	 * @param array<string, mixed> $document Configuration document.
	 * `terms` holds taxonomy **targets**, not expanded products: the index stays
	 * assignment-scaled, and `for_product()` resolves them against the live
	 * product at render (ADR-068).
	 *
	 * @return array{products: array<int, array<int, string>>, all: array<int, string>, terms: array<int, array<string, mixed>>, skipped: int}
	 */
	public static function build( array $document ): array {
		$products = array();
		$all      = array();
		$terms    = array();
		$skipped  = 0;

		$sets = isset( $document['option_sets'] ) && is_array( $document['option_sets'] )
			? $document['option_sets']
			: array();

		foreach ( $sets as $set ) {
			if ( ! is_array( $set ) || ! isset( $set['id'] ) || ! is_string( $set['id'] ) ) {
				continue;
			}

			$set_id      = $set['id'];
			$assignments = isset( $set['assignments'] ) && is_array( $set['assignments'] )
				? $set['assignments']
				: array();

			foreach ( $assignments as $assignment ) {
				if ( ! is_array( $assignment ) ) {
					++$skipped;
					continue;
				}

				$mode = isset( $assignment['mode'] ) && is_string( $assignment['mode'] )
					? $assignment['mode']
					: '';

				if ( self::MODE_ALL === $mode ) {
					if ( ! isset( $all[ $set_id ] ) ) {
						$all[ $set_id ] = isset( $assignment['priority'] ) ? (int) $assignment['priority'] : 0;
					}

					continue;
				}

				if ( self::MODE_MANUAL !== $mode ) {
					// `conditional` needs a condition tree that does not exist
					// (ADR-069, ADR-076). Counted so the deferral stays visible.
					++$skipped;
					continue;
				}

				$target_type = isset( $assignment['target_type'] ) && is_string( $assignment['target_type'] )
					? $assignment['target_type']
					: '';

				/**
				 * Taxonomy targets are **carried, not expanded** (ADR-068).
				 *
				 * 🔴 Expanding `category:shirts` into product ids here would
				 * make this index scale with the **catalogue** rather than with
				 * assignments — inverting the size premise its own docblock
				 * claims, silently, because there is no cap on it. A store with
				 * 100k products and one category rule would carry 100k entries
				 * for a single assignment.
				 *
				 * So the target travels as a target, and `for_product()`
				 * resolves it against the live product at render. That is also
				 * the only way it can be **correct**: a product added to the
				 * category tomorrow must match, and a write-time index is stale
				 * by construction for exactly that case.
				 */
				if ( isset( self::TAXONOMIES[ $target_type ] ) ) {
					$ref = $assignment['target_ref'] ?? null;

					if ( ! is_string( $ref ) || '' === $ref ) {
						++$skipped;
						continue;
					}

					$terms[] = array(
						'set_id'   => $set_id,
						'taxonomy' => self::TAXONOMIES[ $target_type ],
						'slug'     => $ref,
						'priority' => isset( $assignment['priority'] ) ? (int) $assignment['priority'] : 0,
					);

					continue;
				}

				if ( 'product' !== $target_type ) {
					// `attribute` and `price_range` have no interpreter: their
					// format was never defined (ADR-076). Counted, not guessed.
					++$skipped;
					continue;
				}

				$ref = $assignment['target_ref'] ?? null;

				if ( ! is_string( $ref ) && ! is_int( $ref ) ) {
					++$skipped;
					continue;
				}

				/**
				 * Cast to int, deliberately.
				 *
				 * `target_ref` is `varchar(64)` on the cloud, so a manual
				 * assignment arrives as the string `"20"` while `get_the_ID()`
				 * returns the int `20`. PHP coerces numeric-string *array keys*
				 * to int on its own, so this cast is belt-and-braces for the key
				 * — but it also normalises the value before `in_array()` ever
				 * sees it, and `in_array( 20, array( '20' ), true )` is `false`.
				 * Strict comparison is this codebase's norm, so the normalising
				 * happens once, here, rather than at every reader.
				 */
				$product_id = (int) $ref;
				$priority   = isset( $assignment['priority'] ) ? (int) $assignment['priority'] : 0;

				if ( $product_id <= 0 ) {
					// A non-numeric ref would cast to 0 and collide with every
					// other non-numeric ref. Refused rather than indexed wrong.
					++$skipped;
					continue;
				}

				if ( ! isset( $products[ $product_id ] ) ) {
					$products[ $product_id ] = array();
				}

				if ( ! isset( $products[ $product_id ][ $set_id ] ) ) {
					/**
					 * Keyed by set id, valued by priority.
					 *
					 * The key deduplicates **structurally** — `$products[20]['set-a']`
					 * can exist only once — and the value carries what
					 * `for_product()` sorts by. A plain list could do neither
					 * without a second pass.
					 *
					 * So the `isset()` is not what removes duplicates; the array
					 * shape is. What it decides is *which priority survives* when
					 * one set reaches one product twice with different numbers:
					 * the first, and the assignments arrive already sorted
					 * ascending, so the first is the strongest claim the merchant
					 * made. Removing the guard changes nothing observable today —
					 * a duplicate carries the same priority by construction — so
					 * it is a stated intent rather than an enforced one, kept
					 * because a later writer could break that ordering.
					 */
					$products[ $product_id ][ $set_id ] = $priority;
				}
			}
		}

		return array(
			'products' => $products,
			'all'      => $all,
			'terms'    => $terms,
			'skipped'  => $skipped,
		);
	}

	/**
	 * Taxonomy assignments this product matches.
	 *
	 * 📌 **At most one `get_the_terms()` per taxonomy, whatever the assignment
	 * count.** `has_term()` reads a product's terms for the taxonomy named, and
	 * WordPress caches that per post — so ten category rules cost the same as
	 * one. Measured against a running site: after the `WP_Query` a product page
	 * already runs, both taxonomies cost **zero** database queries, because
	 * term relationships are primed with the post.
	 *
	 * ⚠️ That priming is what makes AC3's *"≤1 extra DB read per product page"*
	 * satisfiable, and `ConfigReadBudgetTest` is the guard on it.
	 *
	 * @param array<string, mixed> $index      A built index.
	 * @param int                  $product_id WooCommerce product id.
	 * @return array<string, int> Set id to priority.
	 */
	private static function matching_terms( array $index, int $product_id ): array {
		$terms = isset( $index['terms'] ) && is_array( $index['terms'] ) ? $index['terms'] : array();

		if ( array() === $terms || ! function_exists( 'has_term' ) ) {
			return array();
		}

		$matched = array();

		foreach ( $terms as $target ) {
			if ( ! is_array( $target ) || ! isset( $target['set_id'], $target['taxonomy'], $target['slug'] ) ) {
				continue;
			}

			$set_id = $target['set_id'];

			/*
			 * Already matched by a higher-priority rule for the same set: a set
			 * assigned to two of a product's categories applies once, and the
			 * first match is enough to say so.
			 */
			if ( isset( $matched[ $set_id ] ) ) {
				continue;
			}

			if ( has_term( (string) $target['slug'], (string) $target['taxonomy'], $product_id ) ) {
				$matched[ $set_id ] = isset( $target['priority'] ) ? (int) $target['priority'] : 0;
			}
		}

		return $matched;
	}

	/**
	 * Option set ids applying to one product, in resolution order.
	 *
	 * **Sorted by assignment `priority`, ascending**, with the set id breaking
	 * ties so two renders of unchanged configuration produce the same order.
	 *
	 * This was document order until the Stage 2 audit, and document order is not
	 * priority order. The cloud sorts assignments by `priority` *within* its
	 * query, then groups them per set, and orders the sets themselves by
	 * `createdAt` — so a set created first resolved first regardless of what the
	 * merchant set. Measured: priority 30 resolved ahead of priority 10.
	 *
	 * `option_set_assignments.priority` documents itself as "resolution order
	 * when a product matches **several sets**", which is exactly the case
	 * document order got wrong, and [M19.4](../../../developePlan.md) inherits
	 * the same rule for the targets it resolves. Sorting here rather than
	 * trusting the arrival order makes the guarantee this plugin's own.
	 *
	 * @param array<string, mixed> $index      A built index.
	 * @param int                  $product_id WooCommerce product id.
	 * @return array<int, string>
	 */
	public static function for_product( array $index, int $product_id ): array {
		$all = isset( $index['all'] ) && is_array( $index['all'] ) ? $index['all'] : array();

		$own = isset( $index['products'][ $product_id ] ) && is_array( $index['products'][ $product_id ] )
			? $index['products'][ $product_id ]
			: array();

		/**
		 * Merged before sorting, so a set that is both `all` and manually
		 * assigned appears once.
		 *
		 * The manual entry wins the collision: naming a product explicitly is
		 * the more specific statement, so its priority is the one the merchant
		 * meant for that product.
		 */
		$merged = $all;

		/**
		 * Taxonomy sits between `all` and a named product (ADR-076).
		 *
		 * 🔴 **Precedence is `all` < taxonomy < product**, and it is stated
		 * rather than assumed. With two tiers the rule was obvious — naming a
		 * product is more specific than "everything". With three it stops being
		 * obvious, and a merchant whose category rule silently beat their
		 * product rule would have no way to see why.
		 *
		 * ⚠️ **Resolved here, at render, against the live product** — never
		 * expanded into the index. A product added to the category tomorrow must
		 * match, and a write-time index is stale by construction for exactly
		 * that case.
		 */
		foreach ( self::matching_terms( $index, $product_id ) as $set_id => $priority ) {
			$merged[ $set_id ] = $priority;
		}

		foreach ( $own as $set_id => $priority ) {
			$merged[ $set_id ] = $priority;
		}

		// `asort` preserves keys and is stable in PHP 8, so equal priorities
		// keep their relative order; the key sort below makes that order
		// deterministic rather than dependent on insertion.
		ksort( $merged );
		asort( $merged );

		return array_keys( $merged );
	}

	/**
	 * How many products the index names.
	 *
	 * Reported in `Admin\SystemStatus`. A count of an index that does not exist
	 * reads identically whether it is empty or absent, which is why M9.7 moved
	 * this row here rather than shipping it before the index existed.
	 *
	 * @param array<string, mixed> $index A built index.
	 */
	public static function entry_count( array $index ): int {
		return isset( $index['products'] ) && is_array( $index['products'] )
			? count( $index['products'] )
			: 0;
	}

	/**
	 * How many assignments this index could not resolve.
	 *
	 * ✏️ **Taxonomy stopped counting here at M19.6.** `category` and `tag`
	 * targets resolve (ADR-076), so what remains is `conditional`, `attribute`
	 * and `price_range` -- the three whose interpreters do not exist yet. A
	 * merchant can still see that something was deferred rather than wondering
	 * why a set does not appear.
	 *
	 * @param array<string, mixed> $index A built index.
	 */
	public static function skipped_count( array $index ): int {
		return isset( $index['skipped'] ) ? (int) $index['skipped'] : 0;
	}
}
