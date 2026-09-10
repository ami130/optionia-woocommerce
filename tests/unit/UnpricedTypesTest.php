<?php
/**
 * Options this build cannot price are reported, not silently free.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\UnpricedTypesNotice;
use Optionia\Config\Repository;
use Optionia\Engine\SelectionResolver;
use Optionia\Integration\CartTotals;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * The silent-undercharge guard.
 *
 * The cloud publishes five price types; this build prices `fixed`. An option of
 * any other type contributes nothing to the line total — right arithmetic,
 * wrong money, and before this existed nothing said so: a 50% surcharge on an
 * 80.00 product charged 80.00 and the merchant lost 40.00 a unit in silence.
 *
 * @covers \Optionia\Admin\UnpricedTypesNotice
 * @covers \Optionia\Config\Repository
 * @covers \Optionia\Engine\SelectionResolver
 */
final class UnpricedTypesTest extends TestCase {

	/**
	 * Product under test.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_filters'] = array();

		delete_option( Keys::OPTION_UNPRICED_TYPES );
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_filters'] = array();

		delete_option( Keys::OPTION_UNPRICED_TYPES );

		parent::tearDown();
	}

	// --- Recording -----------------------------------------------------------

	/**
	 * A document using an unimplemented price type is recorded.
	 *
	 * @dataProvider provide_unpriced_types
	 *
	 * @param string $type A price type the cloud publishes and this build cannot price.
	 */
	public function test_records_an_unpriceable_price_type( string $type ): void {
		$this->store( $type );

		$entry = Repository::unpriced_types();

		$this->assertIsArray( $entry );
		$this->assertSame( array( $type ), $entry['price_types'] );
		$this->assertSame( SelectionResolver::PRICED_TYPES, $entry['implemented'] );
	}

	/**
	 * Every price type the cloud's schema publishes that this build cannot price.
	 *
	 * The schema list is written out because it lives in `pricing.schema.ts` in
	 * the other repository, so a type added there without an evaluator here shows
	 * up as an untested row rather than as a silent undercharge.
	 *
	 * What is SUBTRACTED is read from the evaluator rather than written out.
	 * M16.1 is why: this provider named `percentage` as unpriceable, and when the
	 * evaluator learned to charge it, the row kept passing for a while by
	 * asserting the notice still fired. A hand-maintained list of what is *not*
	 * implemented has to be edited every time something is, and the edit that
	 * gets forgotten is the one that leaves a correct charge reported as an
	 * undercharge.
	 *
	 * ⚠️ **Since M16.3 there are no unpriceable published types left**, so the
	 * derived rows are empty and the synthetic one below is what exercises the
	 * mechanism. That is not a placeholder: a published document can carry a type
	 * this build has never heard of -- a cloud deployed ahead of a plugin update
	 * is the ordinary case -- and the notice has to fire for it. A suite deleted
	 * when the list emptied would have taken that guarantee with it.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_unpriced_types(): array {
		$published = array( 'fixed', 'percentage', 'per_unit', 'per_char', 'tiered' );
		$cases     = array();

		foreach ( $published as $type ) {
			if ( ! in_array( $type, SelectionResolver::PRICED_TYPES, true ) ) {
				$cases[ $type ] = array( $type );
			}
		}

		/*
		 * A type from a cloud this build has not caught up with.
		 *
		 * Named so it cannot collide with a real one, and deliberately not added
		 * to the published list above -- that list mirrors `pricing.schema.ts`
		 * and must stay honest about what the cloud actually publishes.
		 */
		$cases['a type this build has never heard of'] = array( 'from_a_newer_cloud' );

		return $cases;
	}

	/**
	 * The provider is not empty, and the schema list still covers the evaluator.
	 *
	 * A provider that derives its rows can derive zero of them, and an empty
	 * data provider is a passing suite in PHPUnit 9. It can also drift the other
	 * way: a type the evaluator prices that this list never mentions means the
	 * schema copy above has gone stale, and the next unimplemented type added
	 * there would go untested.
	 */
	public function test_the_unpriced_provider_is_neither_empty_nor_stale(): void {
		$this->assertNotEmpty(
			self::provide_unpriced_types(),
			'The provider must always hold the synthetic row, whatever the evaluator implements.'
		);

		$published = array( 'fixed', 'percentage', 'per_unit', 'per_char', 'tiered' );

		foreach ( SelectionResolver::PRICED_TYPES as $priced ) {
			$this->assertContains(
				$priced,
				$published,
				'The evaluator prices a type this suite\'s copy of the schema does not list.'
			);
		}
	}

	/**
	 * A document with only fixed pricing records nothing.
	 */
	public function test_records_nothing_when_everything_is_priceable(): void {
		$this->store( 'fixed' );

		$this->assertNull( Repository::unpriced_types() );
	}

	/**
	 * A later clean document clears an earlier record.
	 *
	 * The flag describes the present, not a history — a merchant who removes the
	 * unsupported options should stop being told about them.
	 */
	public function test_a_clean_document_clears_an_earlier_record(): void {
		$this->store( 'tiered' );
		$this->assertNotNull( Repository::unpriced_types() );

		$this->store( 'fixed' );
		$this->assertNull( Repository::unpriced_types() );
	}

	/**
	 * Several unpriceable types are all recorded, deduplicated and sorted.
	 *
	 * The document also carries a `percentage`, which M16.1 charges: it must be
	 * absent from the record. Mixing a priced type into the same document is the
	 * only way this suite distinguishes "recorded everything unpriceable" from
	 * "recorded everything".
	 */
	public function test_records_every_distinct_type_once(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			$this->document( array( 'per_unit', 'tiered', 'tiered', 'fixed', 'percentage' ) ),
			'W/"multi"'
		);

		$this->assertSame(
			array( 'per_unit', 'tiered' ),
			Repository::unpriced_types()['price_types']
		);
	}

	// --- Surfacing -----------------------------------------------------------

	/**
	 * The notice shows exactly when there is something to say.
	 */
	public function test_the_notice_shows_only_when_something_is_unpriced(): void {
		$this->store( 'fixed' );
		$this->assertFalse( UnpricedTypesNotice::is_showing() );

		$this->store( 'tiered' );
		$this->assertTrue( UnpricedTypesNotice::is_showing() );
	}

	// --- The resolver's own report -------------------------------------------

	/**
	 * The resolver reports the type it could not price.
	 *
	 * Reported alongside a successful result, not as an error: the line is
	 * priceable, just not fully, and refusing it would take the storefront down.
	 */
	public function test_the_resolver_reports_the_type_it_could_not_price(): void {
		$result = SelectionResolver::resolve( $this->sets( 'tiered' ), array( 'opt-a' => 'v' ), 8000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'tiered' ), $result->value()['unpriced'] );
		$this->assertSame( 8000, $result->value()['total_minor'], 'An unpriceable option adds nothing.' );
	}

	/**
	 * A fully priceable selection reports nothing.
	 */
	public function test_a_priceable_selection_reports_nothing(): void {
		$result = SelectionResolver::resolve( $this->sets( 'fixed' ), array( 'opt-a' => 'v' ), 8000 );

		$this->assertSame( array(), $result->value()['unpriced'] );
		$this->assertSame( 8500, $result->value()['total_minor'] );
	}

	/**
	 * 🔴 The notice names the types it cannot charge, and claims nothing else.
	 *
	 * The message read *"This version can only price fixed-amount options"* and
	 * went on saying it after M16.1 taught the build to charge percentages. A
	 * merchant reading it about a `tiered` option was told something false about
	 * their percentages in the same sentence.
	 *
	 * No test asserted the text, which is why it drifted: `is_showing()` was
	 * covered, the stored entry was covered, and the words a merchant actually
	 * reads were not. So this renders the notice and reads it.
	 *
	 * The assertion is deliberately negative as well as positive. Requiring the
	 * unpriced type to appear catches a broken message; forbidding a claim about
	 * what IS priced is what stops the sentence growing a second list to drift.
	 */
	public function test_the_notice_names_what_is_unpriced_and_claims_nothing_more(): void {
		$this->store( 'tiered' );

		ob_start();
		( new UnpricedTypesNotice() )->render();
		$html = (string) ob_get_clean();

		$this->assertStringContainsString( 'tiered', $html, 'The notice must name the type going uncharged.' );

		$this->assertStringNotContainsString(
			'only price fixed',
			$html,
			'The notice must not claim this build prices only fixed amounts -- it also prices percentages.'
		);

		/*
		 * Only the types that are chargeable **wherever they appear** may be
		 * forbidden from the notice.
		 *
		 * `per_char` is deliberately excluded from this check: it is charged on
		 * an option and NOT on a value, so a misplaced one is legitimately named
		 * here. Asserting it never appears -- which this loop did over the flat
		 * `PRICED_TYPES` -- would contradict the scanner and forbid a true
		 * warning.
		 */
		foreach ( SelectionResolver::VALUE_PRICED_TYPES as $priced ) {
			$this->assertStringNotContainsString(
				$priced,
				$html,
				sprintf( 'The notice names `%s`, which this build charges on a value -- it should list only what it cannot.', $priced )
			);
		}
	}

	// --- The two constants must agree ----------------------------------------

	/**
	 * `Repository` and `SelectionResolver` agree on what "priceable" means.
	 *
	 * The cache scanner decides what to WARN about and the evaluator decides what
	 * to COMPUTE, and the two disagreeing is a defect in either direction: a type
	 * warned about but priced trains merchants to ignore the notice, and a type
	 * priced at zero without a warning is the silent undercharge the whole
	 * mechanism exists to prevent.
	 *
	 * 🔴 **Asked per POSITION since M16.2.** The question is not "does this build
	 * charge the type" but "does it charge it **here**": `PRICING-SPEC.md` §2
	 * prices `per_char` on an option and every other type on a value.
	 *
	 * Measured with one flat list: a `per_char` on a **value** was treated as
	 * priced at publish time -- no notice -- while the evaluator reported it as
	 * unpriced at runtime. Both halves individually defensible, and together a
	 * merchant undercharged with nothing saying so.
	 *
	 * Asserted as BEHAVIOUR rather than by comparing constants, because
	 * `Repository` reads the evaluator's own lists -- comparing them would compare
	 * a value to itself and pass unconditionally.
	 */
	public function test_the_cache_and_the_evaluator_agree_on_what_is_priceable(): void {
		$types = array( 'fixed', 'percentage', 'per_unit', 'per_char', 'tiered' );

		foreach ( $types as $type ) {
			$this->store( $type );

			$this->assertSame(
				in_array( $type, SelectionResolver::VALUE_PRICED_TYPES, true ),
				null === Repository::unpriced_types(),
				sprintf( '`%s` on a VALUE: the cache and the evaluator disagree.', $type )
			);
		}

		foreach ( $types as $type ) {
			$this->store_option_pricing( $type );

			$this->assertSame(
				in_array( $type, SelectionResolver::OPTION_PRICED_TYPES, true ),
				null === Repository::unpriced_types(),
				sprintf( '`%s` on an OPTION: the cache and the evaluator disagree.', $type )
			);
		}
	}

	/**
	 * Store a document whose single text option carries option-level pricing.
	 *
	 * The scanner never looked at this half of a document at all before M16.2,
	 * so an unimplemented type there was silent however wrong it was.
	 *
	 * @param string $type Price type.
	 */
	private function store_option_pricing( string $type ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-1',
						'assignments' => array(
							array(
								'mode'        => 'all',
								'target_type' => 'product',
								'target_ref'  => '',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'options' => array(
									array(
										'id'         => 'opt-t',
										'type'       => 'text_field',
										'value_kind' => 'text',
										'pricing'    => array(
											'type'         => $type,
											'amount_minor' => 50,
										),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"opt-' . $type . '"'
		);
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Store a document whose single option uses the given price type.
	 *
	 * @param string $type Price type.
	 */
	private function store( string $type ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			$this->document( array( $type ) ),
			'W/"' . $type . '"'
		);
	}

	/**
	 * A document with one option per given price type.
	 *
	 * @param array<string> $types Price types.
	 * @return array<string, mixed>
	 */
	private function document( array $types ): array {
		$values = array();

		foreach ( $types as $i => $type ) {
			$values[] = array(
				'value_key'    => 'v' . $i,
				'price_config' => 'fixed' === $type
					? array(
						'type'         => 'fixed',
						'amount_minor' => 500,
					)
					: array(
						'type'         => $type,
						'basis_points' => 5000,
					),
			);
		}

		return array(
			'option_sets' => array(
				array(
					'id'          => 'set-1',
					'assignments' => array(
						array(
							'mode'        => 'manual',
							'target_type' => 'product',
							'target_ref'  => (string) self::PRODUCT_ID,
							'priority'    => 0,
						),
					),
					'groups'      => array(
						array(
							'id'      => 'group-a',
							'options' => array(
								array(
									'id'     => 'opt-a',
									'type'   => 'radio',
									'values' => $values,
								),
							),
						),
					),
					'rules'       => array(),
				),
			),
		);
	}

	/**
	 * Option sets holding one value of the given price type, keyed `v`.
	 *
	 * @param string $type Price type.
	 * @return array<int, array<string, mixed>>
	 */
	private function sets( string $type ): array {
		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array(
								'id'     => 'opt-a',
								'type'   => 'radio',
								'values' => array(
									array(
										'value_key'    => 'v',
										'price_config' => 'fixed' === $type
											? array(
												'type' => 'fixed',
												'amount_minor' => 500,
											)
											: array(
												'type' => $type,
												'basis_points' => 5000,
											),
									),
								),
							),
						),
					),
				),
			),
		);
	}
}
