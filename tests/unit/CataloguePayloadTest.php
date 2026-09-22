<?php
/**
 * Reading the catalogue into the cloud's wire shape (M19.1).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Catalogue\CataloguePayload;
use PHPUnit\Framework\TestCase;

/**
 * Reading the catalogue into the wire shape.
 *
 * @covers \Optionia\Catalogue\CataloguePayload
 */
final class CataloguePayloadTest extends TestCase {

	/**
	 * Subject.
	 *
	 * @var CataloguePayload
	 */
	private CataloguePayload $payload;

	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_products']    = array();
		$GLOBALS['optionia_test_terms']       = array();
		$GLOBALS['optionia_test_attachments'] = array();
		$GLOBALS['optionia_test_decimals']    = 2;

		$this->payload = new CataloguePayload();
	}

	/**
	 * A product with the fields a catalogue row needs.
	 *
	 * @param int    $id    Product id.
	 * @param string $price Price as WooCommerce stores it.
	 */
	private function product( int $id, string $price = '19.99' ): object {
		$product            = optionia_test_product( $id, 'simple', $price );
		$product->name      = "Product {$id}";
		$product->sku       = "SKU-{$id}";
		$product->status    = 'publish';
		$product->permalink = "https://example.test/product-{$id}/";

		return $product;
	}

	public function test_a_product_reaches_the_wire_shape(): void {
		$this->product( 10 );

		$page = $this->payload->page( 0, 10 );

		$this->assertSame( 1, $page['total'] );
		$this->assertSame( '10', $page['products'][0]['external_id'] );
		$this->assertSame( 'Product 10', $page['products'][0]['name'] );
		$this->assertSame( 'SKU-10', $page['products'][0]['sku'] );
		$this->assertSame( 'simple', $page['products'][0]['type'] );
		$this->assertSame( 'publish', $page['products'][0]['status'] );
	}

	/**
	 * 🔴 **`external_id` is a string, though WooCommerce's id is an integer.**
	 * An assignment's `targetRef` is a varchar and the plugin compares the two;
	 * an integer here would put the conversion somewhere other than the
	 * comparison, which is how `20` and `"20"` stop matching.
	 */
	public function test_the_external_id_is_a_string(): void {
		$this->product( 20 );

		$this->assertIsString( $this->payload->page( 0, 10 )['products'][0]['external_id'] );
	}

	/**
	 * 🔴 **Money through `Money`, never a cast.** `get_price()` is a decimal
	 * string, and `(float) '19.99' * 100` is `1998.9999…`.
	 */
	public function test_the_price_is_exact_minor_units(): void {
		$this->product( 10, '19.99' );

		$this->assertSame( 1999, $this->payload->page( 0, 10 )['products'][0]['price_minor'] );
	}

	/**
	 * ⚠️ Null is meaningful: a variable product has no single price, and the
	 * picker prints an em dash. Zero would show a free product.
	 */
	public function test_an_empty_price_is_null_not_zero(): void {
		$this->product( 10, '' );

		$this->assertNull( $this->payload->page( 0, 10 )['products'][0]['price_minor'] );
	}

	public function test_an_unparseable_price_is_null(): void {
		$this->product( 10, 'not a price' );

		$this->assertNull( $this->payload->page( 0, 10 )['products'][0]['price_minor'] );
	}

	// --- Ordering ------------------------------------------------------------

	/**
	 * 🔴 **The guarantee the whole walk rests on.** Under WooCommerce's default
	 * `date DESC`, a product created mid-walk lands at the **front** and shifts
	 * every later page by one — silently skipping a product per insert, over a
	 * walk that takes 4.2 days for a 100k catalogue. Ordered by id ascending, a
	 * new product is appended *past* the cursor.
	 */
	public function test_products_are_ordered_by_id_ascending(): void {
		$this->product( 30 );
		$this->product( 10 );
		$this->product( 20 );

		$ids = array_column( $this->payload->page( 0, 10 )['products'], 'external_id' );

		$this->assertSame( array( '10', '20', '30' ), $ids );
	}

	public function test_a_later_page_continues_where_the_first_ended(): void {
		foreach ( array( 10, 20, 30, 40 ) as $id ) {
			$this->product( $id );
		}

		$first  = array_column( $this->payload->page( 0, 2 )['products'], 'external_id' );
		$second = array_column( $this->payload->page( 2, 2 )['products'], 'external_id' );

		$this->assertSame( array( '10', '20' ), $first );
		$this->assertSame( array( '30', '40' ), $second );
	}

	/**
	 * A product added mid-walk sorts after the cursor, so the next page is
	 * unaffected — the property id-ascending ordering buys.
	 */
	public function test_a_product_added_mid_walk_does_not_shift_the_next_page(): void {
		foreach ( array( 10, 20, 30, 40 ) as $id ) {
			$this->product( $id );
		}

		$this->payload->page( 0, 2 );

		/* A merchant adds a product: WooCommerce gives it a higher id. */
		$this->product( 99 );

		$this->assertSame(
			array( '30', '40' ),
			array_column( $this->payload->page( 2, 2 )['products'], 'external_id' )
		);
	}

	public function test_the_total_counts_the_whole_catalogue_not_the_page(): void {
		foreach ( array( 10, 20, 30, 40 ) as $id ) {
			$this->product( $id );
		}

		$page = $this->payload->page( 0, 2 );

		$this->assertCount( 2, $page['products'] );
		$this->assertSame( 4, $page['total'] );
	}

	// --- Taxonomies ----------------------------------------------------------

	public function test_category_and_tag_slugs_are_carried(): void {
		$this->product( 10 );
		optionia_test_set_terms( 10, 'product_cat', array( 'apparel', 'winter' ) );
		optionia_test_set_terms( 10, 'product_tag', array( 'bestseller' ) );

		$entry = $this->payload->page( 0, 10 )['products'][0];

		$this->assertSame( array( 'apparel', 'winter' ), $entry['categories'] );
		$this->assertSame( array( 'bestseller' ), $entry['tags'] );
	}

	/**
	 * 🔴 **Null, not `array()`.** The API stores this in a `json` column where
	 * SQL NULL and an empty JSON array are different values, and a reader cannot
	 * tell "no categories" from "not synced" if both arrive as `[]`.
	 */
	public function test_a_product_with_no_terms_sends_null_not_an_empty_list(): void {
		$this->product( 10 );

		$entry = $this->payload->page( 0, 10 )['products'][0];

		$this->assertNull( $entry['categories'] );
		$this->assertNull( $entry['tags'] );
	}

	/**
	 * 🔴 **The empty-list path, which a surviving mutant found untested.** A
	 * product *with* terms whose slugs are all unusable reaches the end of the
	 * loop with nothing collected — a different route to the same null than
	 * "no terms at all", and the only one that exercises the final guard.
	 * Without this, replacing that guard with a bare `return $slugs;` left every
	 * test green while `[]` went on the wire in place of SQL NULL.
	 */
	public function test_terms_that_are_all_blank_send_null_not_an_empty_list(): void {
		$this->product( 10 );
		optionia_test_set_terms( 10, 'product_cat', array( '   ', '' ) );

		$this->assertNull( $this->payload->page( 0, 10 )['products'][0]['categories'] );
	}

	/**
	 * The API's own `@ArrayMaxSize(50)`. Sending more would fail the whole batch
	 * on a validator rather than costing one product its completeness.
	 */
	public function test_terms_are_capped_at_the_api_limit(): void {
		$this->product( 10 );
		optionia_test_set_terms( 10, 'product_cat', array_map( static fn( int $n ): string => "cat-{$n}", range( 1, 80 ) ) );

		$this->assertCount( 50, $this->payload->page( 0, 10 )['products'][0]['categories'] );
	}

	// --- Optional fields -----------------------------------------------------

	/**
	 * ⚠️ WooCommerce answers `''` for an unset SKU; the column is nullable, and
	 * an empty string there means "the merchant set it to nothing".
	 */
	public function test_an_unset_sku_is_null_not_an_empty_string(): void {
		$product      = $this->product( 10 );
		$product->sku = '';

		$this->assertNull( $this->payload->page( 0, 10 )['products'][0]['sku'] );
	}

	public function test_an_image_url_is_carried_when_the_product_has_one(): void {
		$product                                  = $this->product( 10 );
		$product->image_id                        = 77;
		$GLOBALS['optionia_test_attachments'][77] = 'https://example.test/hoodie.jpg';

		$this->assertSame(
			'https://example.test/hoodie.jpg',
			$this->payload->page( 0, 10 )['products'][0]['image_url']
		);
	}

	/** An attachment WordPress cannot resolve answers `false`, not a URL. */
	public function test_a_missing_attachment_yields_null(): void {
		$product           = $this->product( 10 );
		$product->image_id = 404;

		$this->assertNull( $this->payload->page( 0, 10 )['products'][0]['image_url'] );
	}

	public function test_a_product_with_no_image_yields_null(): void {
		$this->product( 10 );

		$this->assertNull( $this->payload->page( 0, 10 )['products'][0]['image_url'] );
	}

	// --- Field lengths -------------------------------------------------------

	/**
	 * 🔴 **Truncated here, or the API refuses the batch.** `@Length(1, 255)` on
	 * the name rejects a longer one, and one over-long product would cost 249
	 * good ones their write.
	 */
	public function test_an_over_long_name_is_truncated_to_the_column(): void {
		$product       = $this->product( 10 );
		$product->name = str_repeat( 'x', 400 );

		$this->assertSame( 255, strlen( $this->payload->page( 0, 10 )['products'][0]['name'] ) );
	}

	/**
	 * 🔴 **The defect an audit found: emoji count double where the API counts.**
	 *
	 * `@Length(1, 255)` in `class-validator` measures a JavaScript string's
	 * `.length` — **UTF-16 code units** — and every astral-plane character is
	 * two. 255 emoji is `mb_strlen() === 255` but `.length === 510`, so the old
	 * `mb_substr()` truncation produced a name the API **rejected**, failing the
	 * whole 250-product batch and stalling the cursor on it for ever.
	 *
	 * Asserted in the API's own units, not PHP's — the measure that decides
	 * whether the request succeeds.
	 */
	public function test_an_emoji_name_is_truncated_to_the_api_length_not_php_length(): void {
		$product       = $this->product( 10 );
		$product->name = str_repeat( '👕', 300 );

		$name = $this->payload->page( 0, 10 )['products'][0]['name'];

		$this->assertLessThanOrEqual( 255, $this->utf16_length( $name ) );
		$this->assertGreaterThan( 0, $this->utf16_length( $name ) );
	}

	/** A surrogate pair split in half is invalid UTF-8 that `wp_json_encode` refuses. */
	public function test_truncation_never_splits_a_character(): void {
		$product       = $this->product( 10 );
		$product->name = str_repeat( '👕', 300 );

		$name = $this->payload->page( 0, 10 )['products'][0]['name'];

		$this->assertTrue( mb_check_encoding( $name, 'UTF-8' ) );
		$this->assertIsString( wp_json_encode( array( 'name' => $name ) ) );
	}

	/** A mixed string budgets each character by its own width, not an average. */
	public function test_a_mixed_name_fits_the_api_budget(): void {
		$product       = $this->product( 10 );
		$product->name = str_repeat( 'a👕', 200 );

		$this->assertLessThanOrEqual(
			255,
			$this->utf16_length( $this->payload->page( 0, 10 )['products'][0]['name'] )
		);
	}

	/** Accented Latin and common CJK are one unit each — they must not truncate early. */
	public function test_accented_and_cjk_names_keep_their_full_length(): void {
		$product       = $this->product( 10 );
		$product->name = str_repeat( 'é', 255 );

		$this->assertSame( 255, $this->utf16_length( $this->payload->page( 0, 10 )['products'][0]['name'] ) );

		$product->name = str_repeat( '日', 255 );

		$this->assertSame( 255, $this->utf16_length( $this->payload->page( 0, 10 )['products'][0]['name'] ) );
	}

	/**
	 * A string's length as JavaScript would measure it.
	 *
	 * This is the number `class-validator` compares against, so it is the number
	 * a test about field lengths must assert on.
	 *
	 * @param string $value The value.
	 */
	private function utf16_length( string $value ): int {
		$length     = 0;
		$characters = preg_split( '//u', $value, -1, PREG_SPLIT_NO_EMPTY );

		if ( ! is_array( $characters ) ) {
			return 0;
		}

		foreach ( $characters as $character ) {
			$code_point = mb_ord( $character, 'UTF-8' );
			$length    += ( false !== $code_point && $code_point > 0xFFFF ) ? 2 : 1;
		}

		return $length;
	}

	/**
	 * ⚠️ **Required fields are never empty on the wire.** `@Length(1, …)`
	 * refuses an empty string, so a product WooCommerce has not finished writing
	 * would fail the whole batch rather than arrive imperfectly.
	 */
	public function test_a_product_with_no_name_still_sends_a_usable_row(): void {
		$product       = $this->product( 10 );
		$product->name = '';

		$this->assertSame( '(no name)', $this->payload->page( 0, 10 )['products'][0]['name'] );
	}

	// --- Statuses ------------------------------------------------------------

	/**
	 * 📌 **Every status, deliberately.** A merchant assigns options to a product
	 * *before* publishing it, and the picker's "draft — not visible on your
	 * storefront" is only possible if the row exists.
	 */
	public function test_a_draft_product_is_still_mirrored(): void {
		$product         = $this->product( 10 );
		$product->status = 'draft';

		$page = $this->payload->page( 0, 10 );

		/*
		 * ⚠️ Asserted before indexing, so narrowing the status filter fails as a
		 * missing product rather than erroring on a missing array key. An audit
		 * found the harness ignored `status` entirely — this test passed while
		 * proving nothing, and the stub now honours it.
		 */
		$this->assertCount( 1, $page['products'], 'a draft product must still be mirrored' );
		$this->assertSame( '10', $page['products'][0]['external_id'] );
		$this->assertSame( 'draft', $page['products'][0]['status'] );
	}

	/** Pending and private are mirrored for the same reason a draft is. */
	public function test_pending_and_private_products_are_mirrored(): void {
		$pending         = $this->product( 10 );
		$pending->status = 'pending';
		$private         = $this->product( 20 );
		$private->status = 'private';

		$this->assertCount( 2, $this->payload->page( 0, 10 )['products'] );
	}

	public function test_an_empty_catalogue_yields_an_empty_page(): void {
		$page = $this->payload->page( 0, 10 );

		$this->assertSame( array(), $page['products'] );
		$this->assertSame( 0, $page['total'] );
	}
}
