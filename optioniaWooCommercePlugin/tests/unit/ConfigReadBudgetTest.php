<?php
/**
 * What rendering a product page costs (M9.2).
 *
 * The acceptance is specific: rendering options adds **zero** external HTTP
 * calls and **at most one** extra database read to a product page.
 *
 * This file asserts the **read budget**. The HTTP half belongs to
 * `FrontendRenderGuardTest`, which covers `Client::is_frontend_render()` — the
 * classification that decides whether a request is a customer-facing render.
 * An earlier version of this docblock claimed both halves were asserted here
 * while the HTTP half was tested nowhere at all, which is worse than a missing
 * test: it tells the next reader the guarantee is already covered.
 *
 * The read budget decays silently — a second `get_option` on a hot path looks
 * harmless in review and is invisible until a catalogue is real — which is why
 * it is counted rather than reasoned about.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Container;
use Optionia\Plugin;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * Reading configuration is cheap, and stays cheap.
 *
 * @covers \Optionia\Config\Repository
 */
final class ConfigReadBudgetTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 *
	 * ⚠️ **Every counter this file asserts on, not just the option one.**
	 * It reset options alone, so meta and term counts leaked between tests —
	 * harmless while one test wrote each, and wrong the moment two did.
	 * Measured when the term counter arrived: `has_term costs one read not two`
	 * saw **three** reads, two of them from the test before it.
	 *
	 * A budget test whose counters carry over is measuring the suite's order
	 * rather than the code's cost.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options']      = array();
		$GLOBALS['optionia_test_option_reads'] = array();
		$GLOBALS['optionia_test_meta']         = array();
		$GLOBALS['optionia_test_meta_reads']   = array();
		$GLOBALS['optionia_test_terms']        = array();
		$GLOBALS['optionia_test_term_reads']   = array();
	}

	/**
	 * A logger over real settings.
	 */
	private function logger(): Logger {
		return new Logger( new Settings() );
	}

	/**
	 * Seed a cached document and forget the reads that took.
	 */
	private function cache_a_document(): void {
		( new Repository( $this->logger() ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array( array( 'id' => 'set-a' ) ),
			),
			'W/"store-7"'
		);

		$GLOBALS['optionia_test_option_reads'] = array();
	}

	/**
	 * How many times an option was read.
	 *
	 * @param string $option Option name.
	 */
	private function reads( string $option ): int {
		return $GLOBALS['optionia_test_option_reads'][ $option ] ?? 0;
	}

	/**
	 * Rendering many products costs one read, not one per product.
	 *
	 * This is the M9.2 acceptance. A shop category page renders dozens of
	 * products from one request, and a repository that re-read the option each
	 * time would turn "≤1 extra DB read" into one per product — the difference
	 * between a fast page and a slow one, on the largest catalogues where it
	 * matters most.
	 */
	public function test_resolving_twenty_five_products_costs_one_index_read(): void {
		$this->cache_a_document();

		$repository = new Repository( $this->logger() );

		for ( $product = 1; $product <= 25; $product++ ) {
			$repository->sets_for_product( $product );
		}

		$this->assertSame(
			1,
			$this->reads( Keys::OPTION_PRODUCT_INDEX ),
			'25 products must not mean 25 index reads.'
		);
	}

	/**
	 * The index lives in an option, and the budget test can prove it.
	 *
	 * Post meta was the alternative considered for the index
	 * ([M10.1](../../../developePlan.md)), and until Stage 2 the harness could
	 * not see it at all: `get_post_meta` was undefined, so an index stored there
	 * would have satisfied the budget above while a shop page performed
	 * twenty-five meta reads. The stubs exist now, and this asserts the count
	 * the storage decision implies — **zero** — rather than trusting that a
	 * quantity nobody measures stayed at nothing.
	 */
	public function test_resolving_products_touches_no_post_meta(): void {
		$this->cache_a_document();

		$repository = new Repository( $this->logger() );

		for ( $product = 1; $product <= 25; $product++ ) {
			$repository->sets_for_product( $product );
		}

		$this->assertSame(
			array(),
			$GLOBALS['optionia_test_meta_reads'],
			'The index is an option; a meta read here means the storage moved without the budget following it.'
		);
	}

	/**
	 * The meta counter counts, so the assertion above means something.
	 *
	 * **Asserting a counter reads zero is exactly what a broken counter also
	 * reports.** Measured: deleting the increment from `get_post_meta` in the
	 * harness broke no test, because `optionia_test_meta_reads` stayed `array()`
	 * either way. The budget test could not tell "no meta was read" from
	 * "nothing counts meta reads" — a check inspecting nothing, inside the test
	 * written to prevent exactly that.
	 *
	 * So the counter is exercised directly here: read post meta on purpose,
	 * and require the count to move. If this ever stops failing when the
	 * increment is removed, the zero above has stopped being evidence.
	 */
	public function test_the_harness_counts_post_meta_reads(): void {
		update_post_meta( 20, 'optionia_probe', 'value' );

		get_post_meta( 20, 'optionia_probe', true );
		get_post_meta( 20, 'optionia_probe', true );

		$this->assertSame(
			2,
			$GLOBALS['optionia_test_meta_reads']['optionia_probe'] ?? 0,
			'The harness must count post meta reads, or the budget assertion is vacuous.'
		);
	}

	/**
	 * 🔴 **Resolving products touches no taxonomy, and nothing could see that
	 * before M19.0a.**
	 *
	 * The harness counted `get_option` and `get_post_meta` and stubbed **no term
	 * function at all** — so a `has_term()` call on the render path would have
	 * satisfied this whole file while querying. That is the same blind spot
	 * `test_resolving_products_touches_no_post_meta` records for meta, one
	 * dimension over, and it was open the entire time that test stood guard.
	 *
	 * ⚠️ **Asserted before ADR-068's taxonomy resolution is built, deliberately.**
	 * A counter added alongside the feature it measures is written by someone
	 * who already knows the answer. Today it reads zero because nothing reads
	 * terms; when M19.4 lands it will read whatever the design actually costs,
	 * and the number will be a measurement rather than a hope.
	 *
	 * ✏️ **M19.4 landed, and this still reads zero — for a reason worth
	 * stating.** A document with no taxonomy assignment carries no taxonomy
	 * target, so resolution has nothing to look up. That is the common case and
	 * it must stay free; `test_taxonomy_resolution_reads_one_taxonomy_per_page`
	 * below is the budget for the case that is not.
	 */
	public function test_resolving_products_touches_no_taxonomy(): void {
		$this->cache_a_document();

		$repository = new Repository( $this->logger() );

		for ( $product = 1; $product <= 25; $product++ ) {
			$repository->sets_for_product( $product );
		}

		$this->assertSame(
			array(),
			$GLOBALS['optionia_test_term_reads'],
			'A term read here means resolution moved without the budget following it.'
		);
	}

	/**
	 * The term counter counts, so the assertion above means something.
	 *
	 * 🔴 **Asserting a counter reads zero is exactly what a broken counter also
	 * reports.** The meta counter needed this proof after it was measured
	 * failing silently; the term counter gets it on the day it is written,
	 * rather than after the same lesson is learned twice.
	 */
	public function test_the_harness_counts_term_reads(): void {
		optionia_test_set_terms( 20, 'product_cat', array( 'shirts' ) );

		has_term( 'shirts', 'product_cat', 20 );
		has_term( 'hats', 'product_cat', 20 );

		$this->assertSame(
			2,
			$GLOBALS['optionia_test_term_reads']['product_cat'] ?? 0,
			'The harness must count term reads, or the budget assertion is vacuous.'
		);
	}

	/**
	 * ⚠️ **`has_term()` counts ONE read, not two.**
	 *
	 * It resolves through `get_the_terms`, as WordPress's own does through the
	 * term cache. Counting both would report two reads where a product page
	 * performs one — and a budget test that **overstates** is as useless as one
	 * that understates, because the next reader tunes against a number that was
	 * never real.
	 */
	public function test_has_term_costs_one_read_not_two(): void {
		optionia_test_set_terms( 20, 'product_cat', array( 'shirts' ) );

		has_term( 'shirts', 'product_cat', 20 );

		$this->assertSame( 1, $GLOBALS['optionia_test_term_reads']['product_cat'] ?? 0 );
	}

	/**
	 * A product with no terms reads `false`, the way WordPress answers.
	 *
	 * ⚠️ **Not an empty array.** `get_the_terms()` returns `false` for a post
	 * with none, and code written against a stub that returned `array()` would
	 * take a branch production never takes — a harness that is wrong in a
	 * comfortable direction.
	 */
	public function test_a_product_with_no_terms_reads_false(): void {
		$this->assertFalse( get_the_terms( 99, 'product_cat' ) );
		$this->assertFalse( has_term( 'shirts', 'product_cat', 99 ) );
	}

	/**
	 * Resolving products reads the index and nothing else.
	 *
	 * The storefront path must not pull the whole configuration document to
	 * answer "which sets apply to this product?" — that is what the index is
	 * for, and the document is the larger of the two.
	 */
	public function test_resolving_a_product_does_not_read_the_document(): void {
		$this->cache_a_document();

		( new Repository( $this->logger() ) )->sets_for_product( 20 );

		$this->assertSame( 0, $this->reads( Keys::OPTION_CONFIG ) );
	}

	public function test_many_product_reads_cost_one_option_read(): void {
		$this->cache_a_document();

		$repository = new Repository( $this->logger() );

		for ( $product = 0; $product < 25; $product++ ) {
			$this->assertNotNull( $repository->get() );
		}

		$this->assertSame(
			1,
			$this->reads( Keys::OPTION_CONFIG ),
			'25 products must not mean 25 reads.'
		);
	}

	/**
	 * The container hands out one repository, so the memoisation is shared.
	 *
	 * Per-instance memoisation is worth nothing if each hook builds its own
	 * repository: three subscribers reading configuration would be three reads.
	 * The guarantee is the pair — memoised *and* shared — so both are asserted
	 * together.
	 */
	public function test_the_container_shares_one_repository(): void {
		$class  = new ReflectionClass( Plugin::class );
		$plugin = $class->newInstanceWithoutConstructor();

		$property = $class->getProperty( 'container' );
		$property->setAccessible( true );
		$property->setValue( $plugin, new Container() );

		foreach ( array( 'register_core_services', 'register_services' ) as $name ) {
			$method = $class->getMethod( $name );
			$method->setAccessible( true );
			$method->invoke( $plugin );
		}

		$container = $property->getValue( $plugin );

		$this->assertInstanceOf( Container::class, $container );

		$this->assertSame(
			$container->get( Repository::class ),
			$container->get( Repository::class ),
			'A second instance would read the option again.'
		);
	}

	/**
	 * Reading configuration touches one option, not several.
	 *
	 * `Config\Repository` also stores metadata — version, etag, fetch time — in
	 * a second option. A storefront needs none of it, and a `get()` that pulled
	 * both would double the cost of the only call a renderer makes.
	 */
	public function test_reading_configuration_touches_only_the_document(): void {
		$this->cache_a_document();

		( new Repository( $this->logger() ) )->get();

		$this->assertSame( 1, $this->reads( Keys::OPTION_CONFIG ) );
		$this->assertSame(
			0,
			$this->reads( Keys::OPTION_CONFIG_META ),
			'Metadata is for System Status, not for rendering.'
		);
	}

	/**
	 * A store with nothing cached still costs one read.
	 *
	 * Null is the answer for "nothing is cached" and for "not read yet", so
	 * memoisation keyed on the value alone re-read the option every call —
	 * measured at ten reads for ten calls. On a fresh install rendering a
	 * category page that is one query per product, on exactly the shop that has
	 * nothing to show for them.
	 *
	 * The budget has to hold before the first sync as well as after.
	 */
	public function test_an_empty_cache_costs_one_read(): void {
		$repository = new Repository( $this->logger() );

		for ( $product = 0; $product < 10; $product++ ) {
			$this->assertNull( $repository->get() );
		}

		$this->assertSame(
			1,
			$this->reads( Keys::OPTION_CONFIG ),
			'A miss must be remembered as cheaply as a hit.'
		);
	}

	/**
	 * Clearing is visible immediately, without another read.
	 *
	 * The memoisation flag has to be reset by `clear()`, not only the value.
	 * Leaving it set means the instance answers from a cache it was told to
	 * discard — the one place where remembering a miss becomes remembering the
	 * wrong thing.
	 */
	public function test_clearing_is_visible_within_the_same_instance(): void {
		$repository = new Repository( $this->logger() );

		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array( array( 'id' => 'set-a' ) ),
			),
			'W/"store-7"'
		);

		$this->assertNotNull( $repository->get() );

		$repository->clear();

		$this->assertNull( $repository->get(), 'A cleared cache must not answer from memory.' );
	}

	/**
	 * Storing a document does not leave the next read stale.
	 *
	 * The memoisation flag is set by `store()` too, so a caller that writes and
	 * then reads within the same request sees what it wrote — without a further
	 * option read, and without returning the pre-write answer.
	 */
	public function test_a_write_is_visible_without_another_read(): void {
		$repository = new Repository( $this->logger() );

		$this->assertNull( $repository->get() );

		$repository->store(
			array(
				'schema_version' => 1,
				'config_version' => 9,
				'option_sets'    => array(),
			),
			'W/"store-9"'
		);

		$before = $this->reads( Keys::OPTION_CONFIG );

		$this->assertNotNull( $repository->get(), 'The write must be visible.' );
		$this->assertSame( $before, $this->reads( Keys::OPTION_CONFIG ), 'And must not cost a read.' );
	}

	/**
	 * The cost of taxonomy resolution, measured rather than hoped (M19.4).
	 *
	 * 🔴 **AC3 binds at ≤1 extra DB read per product page, and this is the
	 * guard on it.** `has_term()` reads a product's terms for one taxonomy and
	 * WordPress caches that per post — so the budget is **one read per
	 * taxonomy per page**, no matter how many assignments name it.
	 *
	 * ⚠️ **The counter counts calls, not queries, and the two genuinely
	 * differ.** Measured against a running site: ten `has_term()` calls after
	 * one `get_the_terms()` cost **0** database queries, and after the
	 * `WP_Query` a product page already runs, the first costs 0 too — WordPress
	 * primes term relationships with the post. So this asserts the **fan-out**:
	 * that resolution does not multiply *taxonomies* touched, which is the part
	 * a design change could silently break.
	 */
	public function test_taxonomy_resolution_reads_one_taxonomy_per_page(): void {
		( new Repository( $this->logger() ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-cat',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'category',
								'target_ref'  => 'hoodies',
								'priority'    => 0,
							),
						),
					),
				),
			),
			'W/"store-7"'
		);

		$GLOBALS['optionia_test_term_reads'] = array();

		$repository = new Repository( $this->logger() );

		$repository->sets_for_product( 20 );

		$this->assertSame(
			array( 'product_cat' ),
			array_keys( $GLOBALS['optionia_test_term_reads'] ),
			'only the taxonomy actually assigned is touched'
		);
		$this->assertSame(
			1,
			$GLOBALS['optionia_test_term_reads']['product_cat'],
			'one assignment, one lookup'
		);
	}

	/**
	 * ⚠️ **And the option budget still holds with taxonomy in play.** Resolution
	 * moved to render; if it had also moved the *index* read, AC3's headline
	 * number would have changed without anyone noticing.
	 */
	public function test_taxonomy_resolution_adds_no_option_reads(): void {
		( new Repository( $this->logger() ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-cat',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'category',
								'target_ref'  => 'hoodies',
								'priority'    => 0,
							),
						),
					),
				),
			),
			'W/"store-7"'
		);

		$GLOBALS['optionia_test_option_reads'] = array();

		$repository = new Repository( $this->logger() );

		for ( $product = 1; $product <= 25; $product++ ) {
			$repository->sets_for_product( $product );
		}

		$this->assertLessThanOrEqual(
			1,
			$GLOBALS['optionia_test_option_reads'][ Keys::OPTION_PRODUCT_INDEX ] ?? 0,
			'the index is read once per request, not once per product'
		);
	}
}
