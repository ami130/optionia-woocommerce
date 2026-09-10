<?php
/**
 * The product index: what it resolves, and what it deliberately does not.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\ProductIndex;
use Optionia\Config\Repository;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Resolution, modes, and the deferral count.
 *
 * @covers \Optionia\Config\ProductIndex
 * @covers \Optionia\Config\Repository
 */
final class ProductIndexTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options']      = array();
		$GLOBALS['optionia_test_option_reads'] = array();
		$GLOBALS['optionia_test_meta']         = array();
		$GLOBALS['optionia_test_meta_reads']   = array();
	}

	/**
	 * A repository over real settings.
	 */
	private function repository(): Repository {
		return new Repository( new Logger( new Settings() ) );
	}

	/**
	 * A document with the given sets.
	 *
	 * @param array<int, array<string, mixed>> $sets Option sets.
	 * @return array<string, mixed>
	 */
	private function document( array $sets ): array {
		return array(
			'schema_version' => 1,
			'config_version' => 7,
			'option_sets'    => $sets,
		);
	}

	/**
	 * One set, one assignment.
	 *
	 * @param string               $id         Set id.
	 * @param array<string, mixed> ...$assignments Assignments.
	 * @return array<string, mixed>
	 */
	private function set( string $id, array ...$assignments ): array {
		return array(
			'id'          => $id,
			'assignments' => $assignments,
			'groups'      => array(),
			'rules'       => array(),
		);
	}

	/**
	 * A manual assignment, with the string ref the cloud actually sends.
	 *
	 * @param string $ref      Product ref.
	 * @param int    $priority Priority.
	 * @return array<string, mixed>
	 */
	private function manual( string $ref, int $priority = 0 ): array {
		return array(
			'mode'        => 'manual',
			'target_type' => 'product',
			'target_ref'  => $ref,
			'priority'    => $priority,
		);
	}

	/**
	 * An `all` assignment: no target, by definition.
	 *
	 * @return array<string, mixed>
	 */
	private function all(): array {
		return array(
			'mode'        => 'all',
			'target_type' => null,
			'target_ref'  => null,
			'priority'    => 0,
		);
	}

	/**
	 * A manual assignment resolves to its product and nothing else.
	 */
	public function test_a_manual_assignment_resolves_only_its_product(): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-a', $this->manual( '20' ) ) ) )
		);

		$this->assertSame( array( 'set-a' ), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( array(), ProductIndex::for_product( $index, 23 ) );
	}

	/**
	 * **The type trap.** The cloud sends a string; WordPress hands us an int.
	 *
	 * `target_ref` is `varchar(64)`, so a manual assignment arrives as `"20"`,
	 * while `get_the_ID()` returns the int `20`. PHP rescues numeric-string
	 * *array keys* on its own — but not `in_array( 20, array( '20' ), true )`,
	 * which is `false`, and strict comparison is this codebase's norm. This is
	 * the test that fails if the normalising is ever removed.
	 */
	public function test_a_string_ref_resolves_against_an_int_product_id(): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-a', $this->manual( '20' ) ) ) )
		);

		$this->assertSame(
			array( 'set-a' ),
			ProductIndex::for_product( $index, 20 ),
			'A string target_ref must resolve against an integer product id.'
		);
	}

	/**
	 * A ref PHP would **not** normalise on its own still resolves.
	 *
	 * The canonical case above is not enough on its own: PHP coerces a
	 * numeric-string array key to int by itself, so `"20"` works whether or not
	 * anything casts it, and a test using only that ref passes against code with
	 * the cast removed. Measured — that mutation survived.
	 *
	 * These are the refs the coercion does not reach. `"020"` stays the string
	 * `'020'` as a key, `" 20"` stays `' 20'`, and a lookup by the int `20`
	 * finds neither. `varchar(64)` on the cloud accepts all of them, and nothing
	 * upstream promises a canonical form today, so the normalising happens once,
	 * where the index is built.
	 *
	 * @dataProvider provide_non_canonical_refs
	 *
	 * @param string $ref A product ref that is numeric but not canonical.
	 */
	public function test_a_non_canonical_ref_still_resolves( string $ref ): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-a', $this->manual( $ref ) ) ) )
		);

		$this->assertSame(
			array( 'set-a' ),
			ProductIndex::for_product( $index, 20 ),
			sprintf( "Ref '%s' must resolve to product 20.", $ref )
		);
	}

	/**
	 * Numeric refs PHP's own key coercion does not normalise.
	 *
	 * @return array<string, array<int, string>>
	 */
	public static function provide_non_canonical_refs(): array {
		return array(
			'zero padded'    => array( '020' ),
			'leading space'  => array( ' 20' ),
			'trailing space' => array( '20 ' ),
		);
	}

	/**
	 * `all` applies to every product, including ones the index never names.
	 *
	 * An index keyed by product cannot hold "every product" as a key, which is
	 * the whole reason `mode` exists on the assignment shape.
	 */
	public function test_an_all_assignment_applies_to_every_product(): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-everywhere', $this->all() ) ) )
		);

		$this->assertSame( array( 'set-everywhere' ), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( array( 'set-everywhere' ), ProductIndex::for_product( $index, 999 ) );
		$this->assertSame( 0, ProductIndex::entry_count( $index ), 'all must not create per-product keys.' );
	}

	/**
	 * A product matching both an `all` and a `manual` set receives both.
	 */
	public function test_all_and_manual_combine_for_one_product(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set( 'set-all', $this->all() ),
					$this->set( 'set-manual', $this->manual( '20' ) ),
				)
			)
		);

		$this->assertSame( array( 'set-all', 'set-manual' ), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( array( 'set-all' ), ProductIndex::for_product( $index, 23 ) );
	}

	/**
	 * Conditional assignments are skipped and counted, not silently dropped.
	 *
	 * The handover signal to M19.4: a merchant can see that something was
	 * deferred rather than wondering why a set does not appear.
	 */
	public function test_conditional_assignments_are_skipped_and_counted(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set(
						'set-conditional',
						array(
							'mode'        => 'conditional',
							'target_type' => 'category',
							'target_ref'  => 'hoodies',
							'priority'    => 0,
						)
					),
				)
			)
		);

		$this->assertSame( array(), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( 1, ProductIndex::skipped_count( $index ) );
	}

	/**
	 * A non-product target is skipped too, even in manual mode.
	 *
	 * `category`, `tag`, `attribute` and `price_range` resolve against
	 * WordPress-side data the document does not carry.
	 */
	public function test_a_non_product_target_is_skipped(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set(
						'set-category',
						array(
							'mode'        => 'manual',
							'target_type' => 'category',
							'target_ref'  => 'hoodies',
							'priority'    => 0,
						)
					),
				)
			)
		);

		$this->assertSame( 0, ProductIndex::entry_count( $index ) );
		$this->assertSame( 1, ProductIndex::skipped_count( $index ) );
	}

	/**
	 * A ref that is not a product id is refused rather than indexed wrong.
	 *
	 * `(int) 'sku-abc'` is `0`, and every other non-numeric ref is also `0`, so
	 * indexing them would collide unrelated products under one key.
	 */
	public function test_a_non_numeric_ref_is_refused(): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-a', $this->manual( 'sku-abc' ) ) ) )
		);

		$this->assertSame( 0, ProductIndex::entry_count( $index ) );
		$this->assertSame( 1, ProductIndex::skipped_count( $index ) );
		$this->assertSame( array(), ProductIndex::for_product( $index, 0 ) );
	}

	/**
	 * Two sets assigned to the same product both resolve, without duplicates.
	 */
	public function test_two_sets_on_one_product_both_resolve(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set( 'set-a', $this->manual( '20' ) ),
					$this->set( 'set-b', $this->manual( '20' ) ),
				)
			)
		);

		$this->assertSame( array( 'set-a', 'set-b' ), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( 1, ProductIndex::entry_count( $index ) );
	}

	/**
	 * The same set assigned twice to one product appears once.
	 *
	 * **The database permits this.** `option_set_assignments` has no unique
	 * constraint — `ix_assignments_set_mode` and `ix_assignments_target` are both
	 * non-unique — so two identical `(optionSetId, target_type, target_ref)` rows
	 * are legal, and M13.6's picker or M19.5's bulk tools could write them.
	 *
	 * A duplicate here becomes the same option block rendered twice on one
	 * product page in Stage 4 — the M10.2 defect Phase 4 observed, arriving
	 * *before* the idempotence guard that exists to prevent it, because that
	 * guard trusts the list it is handed to be unique.
	 */
	public function test_a_set_assigned_twice_to_one_product_appears_once(): void {
		$index = ProductIndex::build(
			$this->document(
				array( $this->set( 'set-a', $this->manual( '20' ), $this->manual( '20' ) ) )
			)
		);

		$this->assertSame( array( 'set-a' ), ProductIndex::for_product( $index, 20 ) );

		/**
		 * Asserted on the **stored** index too, not only on what resolution
		 * returns.
		 *
		 * `for_product()` deduplicates again on the way out, so a test reading
		 * only its result passes even when the index holds
		 * `array( 'set-a', 'set-a' )` — measured, that mutation survived. The
		 * stored array is what `entry_count()` reports and what any later reader
		 * consumes, so it has to be right at rest rather than merely tidy on the
		 * way past.
		 */
		$this->assertSame(
			array( 'set-a' => 0 ),
			$index['products'][20],
			'The stored index must hold the set once, not rely on resolution to hide a duplicate.'
		);
	}

	/**
	 * A set carrying two `all` assignments applies once, not twice.
	 *
	 * Same reachability as above, one mode over: nothing stops a set holding two
	 * `all` rows, and without the deduplication every product in the store would
	 * resolve that set twice.
	 */
	public function test_a_set_with_two_all_assignments_applies_once(): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-all', $this->all(), $this->all() ) ) )
		);

		$this->assertSame( array( 'set-all' => 0 ), $index['all'] );
		$this->assertSame( array( 'set-all' ), ProductIndex::for_product( $index, 20 ) );
	}

	/**
	 * A set that is both `all` and manually assigned resolves once.
	 *
	 * The overlap the two lists make possible: `all` puts the set in front of
	 * every product, and a manual row names one of them explicitly. A merchant
	 * doing both — assigning broadly, then pinning a product — is ordinary, not
	 * a mistake, and must not double the set on that one page.
	 */
	public function test_a_set_both_all_and_manual_resolves_once(): void {
		$index = ProductIndex::build(
			$this->document( array( $this->set( 'set-a', $this->all(), $this->manual( '20' ) ) ) )
		);

		$this->assertSame( array( 'set-a' ), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( array( 'set-a' ), ProductIndex::for_product( $index, 23 ) );
	}

	/**
	 * A malformed assignment cannot silently claim an unrelated product.
	 *
	 * `target_ref` is typed `varchar(64)` on the cloud, but the document reaching
	 * a storefront is JSON, and nothing between here and there proves the field
	 * is a scalar. Without the type guard `(int) array( 'nested' )` is **1**, so
	 * a broken assignment would attach its option set to **product 1** — a real
	 * product belonging to the merchant, chosen by accident.
	 *
	 * Measured: with the guard removed the index built cleanly, with no warning
	 * and no error, as `{"products":{"1":["set-a"]}}`. A wrong answer, not a
	 * crash, which is the kind that survives to production.
	 */
	public function test_a_non_scalar_ref_cannot_claim_product_one(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set(
						'set-a',
						array(
							'mode'        => 'manual',
							'target_type' => 'product',
							'target_ref'  => array( 'nested' ),
							'priority'    => 0,
						)
					),
				)
			)
		);

		$this->assertSame( array(), ProductIndex::for_product( $index, 1 ), 'Product 1 must not inherit a broken assignment.' );
		$this->assertSame( 0, ProductIndex::entry_count( $index ) );
		$this->assertSame( 1, ProductIndex::skipped_count( $index ) );
	}

	/**
	 * A set with no usable id is skipped rather than indexed as null.
	 *
	 * Measured with the guard removed: a set missing `id` emitted
	 * `Warning: Undefined array key "id"` — on a storefront page — and produced
	 * `{"20":[null]}`; a set whose `id` was an array produced `{"20":[["x"]]}`.
	 * Both are values a reader would carry into a template.
	 *
	 * @dataProvider provide_unusable_set_ids
	 *
	 * @param array<string, mixed> $set A set whose id cannot be used.
	 */
	public function test_a_set_without_a_usable_id_is_skipped( array $set ): void {
		$index = ProductIndex::build( $this->document( array( $set ) ) );

		$this->assertSame( array(), ProductIndex::for_product( $index, 20 ) );
		$this->assertSame( 0, ProductIndex::entry_count( $index ) );
	}

	/**
	 * Sets whose id cannot be used as an option set identifier.
	 *
	 * @return array<string, array<int, array<string, mixed>>>
	 */
	public static function provide_unusable_set_ids(): array {
		$assignment = array(
			'mode'        => 'manual',
			'target_type' => 'product',
			'target_ref'  => '20',
			'priority'    => 0,
		);

		return array(
			'no id at all'        => array( array( 'assignments' => array( $assignment ) ) ),
			'id is array'         => array(
				array(
					'id'          => array( 'x' ),
					'assignments' => array( $assignment ),
				),
			),
			'id is int'           => array(
				array(
					'id'          => 7,
					'assignments' => array( $assignment ),
				),
			),
			'set is not an array' => array( array() ),
		);
	}

	/**
	 * Resolution follows `priority`, not the order sets appear in the document.
	 *
	 * **This was wrong until the Stage 2 audit.** The document orders sets by
	 * `createdAt`, and priority only sorts assignments *within* one set's query,
	 * so a set created first resolved first whatever the merchant chose:
	 * measured, priority 30 came back ahead of priority 10.
	 *
	 * `option_set_assignments.priority` describes itself as "resolution order
	 * when a product matches **several sets**" — precisely the case document
	 * order got wrong. The set created first is deliberately given the *higher*
	 * number here, so document order and priority order disagree and only a real
	 * sort can produce the expected answer.
	 */
	public function test_resolution_follows_priority_not_document_order(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set( 'created-first', $this->manual( '20', 30 ) ),
					$this->set( 'created-later', $this->manual( '20', 10 ) ),
				)
			)
		);

		$this->assertSame(
			array( 'created-later', 'created-first' ),
			ProductIndex::for_product( $index, 20 ),
			'Priority 10 must resolve before priority 30, whatever order the sets arrived in.'
		);
	}

	/**
	 * An `all` set and a manual set interleave by priority, not by kind.
	 *
	 * Storing the two in separate lists makes it tempting to concatenate them —
	 * every `all` set, then every manual one. That is a rule nobody chose: a
	 * merchant who gives a manual assignment priority 1 and a store-wide set
	 * priority 50 has said which comes first, and the shape of the index should
	 * not overrule them.
	 */
	public function test_all_and_manual_interleave_by_priority(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set(
						'store-wide',
						array(
							'mode'        => 'all',
							'target_type' => null,
							'target_ref'  => null,
							'priority'    => 50,
						)
					),
					$this->set( 'pinned', $this->manual( '20', 1 ) ),
				)
			)
		);

		$this->assertSame(
			array( 'pinned', 'store-wide' ),
			ProductIndex::for_product( $index, 20 ),
			'A manual assignment at priority 1 must precede a store-wide set at 50.'
		);
	}

	/**
	 * A set that is both `all` and manually assigned uses the manual priority.
	 *
	 * Naming a product explicitly is the more specific statement, so its
	 * priority is the one the merchant meant for that product — the store-wide
	 * number still governs every other page.
	 *
	 * The earlier overlap test gave both assignments the same priority, so it
	 * could not tell which side won: measured, a mutation making the `all`
	 * priority win survived it. Different numbers on the two sides, and a second
	 * set to sort against, are what make the answer observable.
	 */
	public function test_a_manual_priority_overrides_an_all_priority(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set(
						'both',
						array(
							'mode'        => 'all',
							'target_type' => null,
							'target_ref'  => null,
							'priority'    => 50,
						),
						$this->manual( '20', 1 )
					),
					$this->set( 'middle', $this->manual( '20', 25 ) ),
				)
			)
		);

		$this->assertSame(
			array( 'both', 'middle' ),
			ProductIndex::for_product( $index, 20 ),
			'On product 20 the manual priority of 1 must place `both` first, not its store-wide 50.'
		);

		$this->assertSame(
			array( 'both' ),
			ProductIndex::for_product( $index, 999 ),
			'Elsewhere the store-wide assignment still applies.'
		);
	}

	/**
	 * Equal priorities resolve deterministically, by set id.
	 *
	 * Two builds of unchanged configuration must produce the same order — the
	 * same guarantee the cloud makes about the document itself. Without a
	 * tie-break, sets sharing a priority would come back in whatever order the
	 * index happened to be built in, and that order follows document order,
	 * which is what this milestone just stopped trusting.
	 */
	public function test_equal_priorities_break_their_tie_by_set_id(): void {
		$index = ProductIndex::build(
			$this->document(
				array(
					$this->set( 'zebra', $this->manual( '20', 5 ) ),
					$this->set( 'alpha', $this->manual( '20', 5 ) ),
				)
			)
		);

		$this->assertSame(
			array( 'alpha', 'zebra' ),
			ProductIndex::for_product( $index, 20 ),
			'Equal priorities must fall back to a stable, content-derived order.'
		);
	}

	/**
	 * Storing a document writes the index, and the repository reads it back.
	 */
	public function test_storing_a_document_builds_the_index(): void {
		$this->repository()->store(
			$this->document( array( $this->set( 'set-a', $this->manual( '20' ) ) ) ),
			'W/"store-7"'
		);

		$this->assertSame( array( 'set-a' ), $this->repository()->sets_for_product( 20 ) );
		$this->assertSame( 1, $this->repository()->index_entry_count() );
	}

	/**
	 * The index is written **after** the document.
	 *
	 * Options are not transactional, so a failure between the two writes leaves
	 * a stale index rather than one naming sets that are no longer present.
	 */
	public function test_the_index_is_written_after_the_document(): void {
		$order = array();

		$GLOBALS['optionia_test_write_order'] = &$order;

		$this->repository()->store(
			$this->document( array( $this->set( 'set-a', $this->manual( '20' ) ) ) ),
			'W/"store-7"'
		);

		$options = array_keys( $GLOBALS['optionia_test_options'] );

		$this->assertLessThan(
			array_search( Keys::OPTION_PRODUCT_INDEX, $options, true ),
			array_search( Keys::OPTION_CONFIG, $options, true ),
			'The document must be written before the index.'
		);
	}

	/**
	 * Clearing the cache clears the index with it.
	 */
	public function test_clearing_removes_the_index(): void {
		$repository = $this->repository();

		$repository->store(
			$this->document( array( $this->set( 'set-a', $this->manual( '20' ) ) ) ),
			'W/"store-7"'
		);
		$repository->clear();

		$this->assertSame( array(), $this->repository()->sets_for_product( 20 ) );
	}

	/**
	 * A store with no configuration resolves nothing, and does not warn.
	 */
	public function test_an_unconfigured_store_resolves_nothing(): void {
		$this->assertSame( array(), $this->repository()->sets_for_product( 20 ) );
		$this->assertSame( 0, $this->repository()->index_entry_count() );
	}
}
