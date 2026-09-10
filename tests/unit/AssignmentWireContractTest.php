<?php
/**
 * The assignment shape, as the cloud actually sends it (Phase 10 Stage 1).
 *
 * ## Why this test exists
 *
 * Phase 8 shipped a connection flow that could not connect, and both suites were
 * green throughout: the cloud asserted `body.data.authorize_url` while every
 * plugin fixture was flat. Two internally consistent halves that disagreed, and
 * neither could catch it alone.
 *
 * Assignments arrived with the same blind spot. Before Stage 1 no plugin fixture
 * carried a populated `assignments` array, and `Config\Repository::store()`
 * validates only `option_sets` and `schema_version` — so a document whose
 * assignments were `camelCase`, or carried internal columns, would be **cached
 * without complaint** and surface in Stage 2 as an index that silently resolves
 * nothing.
 *
 * The JSON below is not written by hand. It was captured from the real
 * `GET /v1/store/config` response in `config-delivery.e2e-spec.ts`
 * ("carries an all and a manual assignment on the set they belong to"), so if
 * the cloud's shape moves, this fixture is wrong in the same direction and these
 * assertions fail.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * The cloud's assignment payload, read by the plugin that must consume it.
 *
 * @covers \Optionia\Config\Repository
 */
final class AssignmentWireContractTest extends TestCase {

	/**
	 * Captured verbatim from the cloud's e2e suite.
	 *
	 * One `all` assignment (no target — it applies to every product) and one
	 * `manual` naming a product, which is the pair M10.1 must tell apart.
	 *
	 * ⚠️ **This is a copy, and nothing compares it back to the cloud.** Measured
	 * 2026-08-31: changing the captured `priority` from `5` to `99` — the shape
	 * the backend would send after an ordering change — leaves this suite
	 * reporting `OK`. No gate reads this constant and the backend does not know
	 * it exists, so the plugin cannot tell a current value from a stale one.
	 *
	 * Capturing real bytes is still right; a hand-written fixture would be a
	 * guess, and the Phase 8 envelope defect was two internally consistent halves
	 * that disagreed. What is missing is the part that notices when the capture
	 * goes out of date.
	 *
	 * ✅ **Closed by Phase 11 Stage 1.** The bytes moved out of this constant and
	 * into `tests/fixtures/shared/assignment-wire.json`, which
	 * `bin/check-shared-fixtures.sh` hashes in **both** repositories. A capture
	 * that goes stale now fails the build rather than passing quietly, and the
	 * fixture is read from disk below so the gate guards a file this test
	 * actually uses — a hashed file nobody reads is a hash, not a contract.
	 */
	private const WIRE_FIXTURE = __DIR__ . '/../fixtures/shared/assignment-wire.json';

	/**
	 * The captured assignments, read from the shared fixture.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function wire(): array {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local test fixture, not a URL; `wp_remote_get` would be absurd here.
		$raw = file_get_contents( self::WIRE_FIXTURE );

		if ( false === $raw ) {
			$this->fail( 'The shared wire fixture is missing: ' . self::WIRE_FIXTURE );
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) || ! isset( $decoded['assignments'] ) || ! is_array( $decoded['assignments'] ) ) {
			$this->fail( 'The shared wire fixture does not hold an assignments array.' );
		}

		return $decoded['assignments'];
	}

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
	}

	/**
	 * A repository over real settings.
	 */
	private function repository(): Repository {
		return new Repository( new Logger( new Settings() ) );
	}

	/**
	 * Cache a document carrying the real assignment payload.
	 */
	private function store_wire_document(): bool {
		return $this->repository()->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => $this->wire(),
						'groups'      => array(),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);
	}

	/**
	 * The document the cloud sends is accepted and survives a round trip.
	 */
	public function test_a_document_with_assignments_is_cached_intact(): void {
		$this->assertTrue( $this->store_wire_document(), 'The wire document must be accepted.' );

		$cached = $this->repository()->get();

		$this->assertNotNull( $cached );
		$this->assertSame(
			$this->wire(),
			$cached['option_sets'][0]['assignments'],
			'Assignments must survive the cache byte for byte.'
		);
	}

	/**
	 * Every field M10.1 resolves against is present, under the name it expects.
	 *
	 * The entity behind this is `camelCase` (`targetType`, `targetRef`) and the
	 * contract is `snake_case`. Nothing on either side would fail if that mapping
	 * were wrong — the document would simply cache and resolve to nothing.
	 */
	public function test_each_assignment_carries_the_four_contract_fields(): void {
		$this->store_wire_document();

		foreach ( $this->repository()->get()['option_sets'][0]['assignments'] as $assignment ) {
			$this->assertSame(
				array( 'mode', 'priority', 'target_ref', 'target_type' ),
				$this->sorted_keys( $assignment ),
				'An assignment must carry exactly the four documented fields.'
			);
		}
	}

	/**
	 * `all` is distinguishable from `manual`, which is the whole point of `mode`.
	 *
	 * An `all` assignment has no target, so a reader given only `target_type` and
	 * `target_ref` cannot tell "applies to every product" from "applies to
	 * nothing" — and M10.1's index, which is keyed by product, cannot hold "every
	 * product" as a key. It has to read `mode`.
	 */
	public function test_an_all_assignment_is_distinguishable_from_a_manual_one(): void {
		$this->store_wire_document();

		$assignments = $this->repository()->get()['option_sets'][0]['assignments'];

		$this->assertSame( 'all', $assignments[0]['mode'] );
		$this->assertNull( $assignments[0]['target_type'] );
		$this->assertNull( $assignments[0]['target_ref'] );

		$this->assertSame( 'manual', $assignments[1]['mode'] );
		$this->assertSame( 'product', $assignments[1]['target_type'] );
		$this->assertSame( '20', $assignments[1]['target_ref'] );
	}

	/**
	 * No internal column reaches the plugin.
	 *
	 * `matchRules` is the conditional condition tree and `optionSetId` is a cloud
	 * primary key; neither means anything to a storefront. They are absent
	 * because the cloud maps field by field rather than spreading the entity, and
	 * this asserts that from the reading end.
	 */
	public function test_no_internal_column_arrives(): void {
		$this->store_wire_document();

		foreach ( $this->repository()->get()['option_sets'][0]['assignments'] as $assignment ) {
			foreach ( array( 'id', 'optionSetId', 'matchRules', 'targetType', 'targetRef' ) as $internal ) {
				$this->assertArrayNotHasKey(
					$internal,
					$assignment,
					"'$internal' is internal to the cloud and must never reach a storefront."
				);
			}
		}
	}

	/**
	 * The captured bytes resolve through the index, not merely into the cache.
	 *
	 * **The two halves of this stage never met until now.** `ProductIndexTest`
	 * builds assignments by hand, and everything above proves only that the real
	 * payload *stores* — so the index was never driven by the shape the cloud
	 * actually sends.
	 *
	 * Measured what that cost: renaming `target_ref` to `productRef` on the wire
	 * left the index empty and every option set applying to **nothing**, while
	 * both test files stayed green. One used its own shape; the other checked
	 * the fields existed without ever indexing them. The `skipped` count was the
	 * only signal, visible in the admin and failing no test.
	 *
	 * That is the [Stage 1a](../../../developePlan.md) failure exactly: two
	 * internally consistent halves that disagree. This closes it by carrying the
	 * captured bytes all the way to a resolved product.
	 */
	public function test_the_captured_payload_resolves_through_the_index(): void {
		$this->store_wire_document();

		$repository = $this->repository();

		// The manual assignment names product 20; the `all` assignment applies
		// to every product. Both belong to `set-a`, so it must resolve **once**.
		$this->assertSame(
			array( 'set-a' ),
			$repository->sets_for_product( 20 ),
			'The real payload must resolve the set it names, exactly once.'
		);

		$this->assertSame(
			array( 'set-a' ),
			$repository->sets_for_product( 999 ),
			'The `all` assignment must reach a product the payload never names.'
		);

		$this->assertSame( 1, $repository->index_entry_count() );
		$this->assertSame(
			0,
			$repository->index_skipped_count(),
			'Nothing in the real payload should be unresolvable; a count here means the shape moved.'
		);
	}

	/**
	 * Sorted keys of one assignment.
	 *
	 * @param array<string, mixed> $assignment One assignment.
	 * @return array<int, string>
	 */
	private function sorted_keys( array $assignment ): array {
		$keys = array_keys( $assignment );
		sort( $keys );

		return $keys;
	}
}
