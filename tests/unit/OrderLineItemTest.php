<?php
/**
 * Order persistence (M12.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartItemPayload;
use Optionia\Engine\SelectionResolver;
use Optionia\Integration\OrderLineItem;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * What the customer bought must survive onto the order.
 *
 * Two tiers: human-readable pairs a merchant can fulfil from, and machine data
 * anything downstream can reason about. The visible tier is the whole of
 * M12.6b — merchants fulfil from a printed sheet or a job queue, not a screen,
 * and WooCommerce renders order item meta into all of those **if the key is
 * human-readable**.
 *
 * @covers \Optionia\Integration\OrderLineItem
 */
final class OrderLineItemTest extends TestCase {

	/**
	 * Product under test.
	 */
	private const PRODUCT_ID = 41;

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_filters'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['optionia_test_salt']    = 'test-salt';
		unset( $_POST[ Keys::FIELD_PREFIX ] );
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_filters'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$_POST                            = array();

		parent::tearDown();
	}

	// --- The visible tier ----------------------------------------------------

	/**
	 * **The option is written under its label, not its id.**
	 *
	 * WooCommerce renders order item meta keys verbatim into packing slips,
	 * emails and CSV exports. `Finish: Luxury` is a fulfilment instruction;
	 * `opt-a: lux` is a developer's slug on a workbench printout.
	 */
	public function test_options_are_written_under_their_labels(): void {
		$item = $this->attach_line();

		$this->assertSame( 'Luxury', $item->get_meta( 'Finish' ) );
		$this->assertNull( $item->get_meta( 'opt-a' ), 'An id must not appear where a label belongs.' );
	}

	/**
	 * Every selected option appears, not just the first.
	 */
	public function test_every_selected_option_is_written(): void {
		$item = $this->attach_line();

		$this->assertSame( 'Luxury', $item->get_meta( 'Finish' ) );
		$this->assertSame( 'Yes', $item->get_meta( 'Engraving' ) );
	}

	/**
	 * A long value is written whole.
	 *
	 * M12.6b names this: "a truncated engraving is a wrong product
	 * manufactured." Two hundred characters is a realistic engraving.
	 */
	public function test_a_long_value_is_not_truncated(): void {
		$long = str_repeat( 'A', 200 );

		$item = $this->attach_line( array( 'opt-a' => 'lux' ), $long );

		$this->assertSame( $long, $item->get_meta( 'Finish' ) );
		$this->assertSame( 200, strlen( (string) $item->get_meta( 'Finish' ) ) );
	}

	/**
	 * 🟡 **Customer text reaches the order as text, not as markup.**
	 *
	 * ✏️ **Narrows this phase's own DA1 finding**, which read *"neither consumer
	 * escapes … unsafe the moment a customer types the value"* and treated the
	 * order path as an XSS hole. Measured against the real WordPress:
	 * WooCommerce renders line-item meta through `wp_kses_post()`, which strips
	 * `onclick`, `onerror` and `javascript:` hrefs. **Script never executes**, so
	 * the security claim was overstated.
	 *
	 * What `wp_kses_post()` does *not* do is escape. `<b>Bob</b>` survives it and
	 * renders **bold** — a customer's literal characters silently becoming
	 * formatting on a packing slip. That is the real defect, and it is a
	 * correctness one.
	 *
	 * The fix is upstream and already built: `SelectionResolver::clean_text()`
	 * strips the markup before it is ever stored, so `add_meta_data()` receives
	 * text. This pins that the two halves actually meet — the resolver's output
	 * is what the order writes, with no second escaping to double-encode an
	 * ampersand a customer really typed.
	 */
	public function test_customer_markup_reaches_the_order_as_plain_text(): void {
		$typed = SelectionResolver::resolve(
			array(
				array(
					'id'     => 'set-1',
					'groups' => array(
						array(
							'id'      => 'group-a',
							'options' => array(
								array(
									'id'          => 'opt-a',
									'type'        => 'text_field',
									'label'       => 'Finish',
									'value_kind'  => 'text',
									'is_required' => false,
									'values'      => array(),
								),
							),
						),
					),
				),
			),
			array( 'opt-a' => '<b>Bob</b> & <script>alert(1)</script>Sons' )
		);

		$this->assertTrue( $typed->is_ok() );
		$cleaned = $typed->value()['labels']['opt-a']['value'];

		/*
		 * The line is built directly rather than through `line()`: that helper
		 * resolves against a stored *choice* config, so free text would be
		 * refused as an unknown value key. This is the payload a text option
		 * actually produces.
		 */
		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach(
			$item,
			'cart-key',
			array(
				'product_id'        => self::PRODUCT_ID,
				'quantity'          => 1,
				Keys::CART_ITEM_KEY => array(
					Keys::CART_ITEM_SELECTIONS => array( 'opt-a' => $cleaned ),
					Keys::CART_ITEM_LABELS     => array(
						'opt-a' => array(
							'option' => 'Finish',
							'value'  => $cleaned,
						),
					),
				),
			)
		);

		$meta = (string) $item->get_meta( 'Finish' );

		$this->assertSame( 'Bob & Sons', $meta, 'Markup gone, the ampersand the customer typed intact.' );
		$this->assertStringNotContainsString( '<', $meta );

		/*
		 * ⚠️ **Deliberately not asserted through a `wp_kses_post()` stub.**
		 *
		 * The claim worth making is *"WooCommerce's real renderer leaves this
		 * unchanged"*, and a stub would only assert what the stub does. This
		 * phase already shipped that mistake once: an `esc_url` stub weaker than
		 * core passed `javascript:` straight through and failed a correct test.
		 *
		 * Measured instead against the real `wp_kses_post()` on the live site —
		 * it strips `onclick`, `onerror` and `javascript:` hrefs, so nothing
		 * executes, but it *permits* `<b>`. That is exactly why the markup has
		 * to be gone before storage, which is what the assertions above pin.
		 */
	}

	/**
	 * With no snapshotted label, the id is used rather than nothing.
	 *
	 * A line written before labels existed still has to appear on the packing
	 * slip. An unhelpful key beats a missing option.
	 */
	public function test_a_line_without_labels_still_writes_something(): void {
		$line = $this->line();

		unset( $line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ] );

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertSame( 'lux', $item->get_meta( 'opt-a' ) );
	}

	// --- SKU suffixes (M16.8) ------------------------------------------------

	/**
	 * 🔴 A value's SKU suffix reaches the order, keyed and sorted.
	 *
	 * The field has been authorable in the dashboard, published in the document
	 * and documented in `CONFIG-CONTRACT.md` since Phase 5, and **read by no
	 * plugin code at all** — the same shape of silent gap `weight_delta_grams`
	 * had before M16.8. A merchant configures "Oak → -OAK", publishes, sells, and
	 * the warehouse gets nothing.
	 *
	 * Keyed by option id rather than pre-joined because a separator is a
	 * merchant's convention, and sorted because the resolver returns them in
	 * arrival order — two customers picking the same options in a different
	 * order must not get two different codes for one product.
	 */
	public function test_sku_suffixes_reach_the_order_line(): void {
		$item = $this->attach_line();

		$this->assertSame(
			array(
				'opt-a' => 'OAK',
				'opt-b' => 'ENG',
			),
			json_decode( (string) $item->get_meta( Keys::META_SKU_SUFFIX ), true )
		);
	}

	/**
	 * 🔴 The suffixes are ordered by option id, not by arrival.
	 *
	 * The resolver returns them in the order it walked the selections, which is
	 * the order the customer's form submitted them. Two customers choosing the
	 * same two options in a different order would otherwise get two different
	 * SKUs for an identical product — and a warehouse would treat them as two
	 * variants.
	 *
	 * Submitting `opt-b` first is what makes this observable: without it the
	 * arrival order already matches the sorted order, and deleting the `ksort()`
	 * passes. Measured — that is exactly what happened before this test existed.
	 */
	public function test_suffixes_are_ordered_by_option_id_not_arrival(): void {
		$line = $this->line(
			array(
				'opt-b' => 'yes',
				'opt-a' => 'lux',
			)
		);

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertSame(
			array( 'opt-a', 'opt-b' ),
			array_keys( (array) json_decode( (string) $item->get_meta( Keys::META_SKU_SUFFIX ), true ) ),
			'One configuration must produce one SKU, whatever order the form submitted.'
		);
	}

	/**
	 * A line carrying an unpriceable option still records its SKU suffixes.
	 *
	 * That line takes the **other** payload branch — the one that skips the price
	 * freeze, because freezing a zero for a type this build cannot charge would
	 * make a merchant's fix land on no existing cart. The suffix is not a price,
	 * so it must survive that branch: a warehouse still has to pick the right
	 * variant while the merchant sorts the pricing out.
	 *
	 * Two payload paths writing the same field is exactly where one gets
	 * forgotten, so both are asserted rather than the common one twice.
	 */
	public function test_an_unpriceable_line_still_records_its_suffixes(): void {
		$this->store_unpriceable_config();

		$_POST[ Keys::FIELD_PREFIX ] = array( 'opt-a' => 'lux' );
		$line                        = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );
		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertArrayNotHasKey(
			Keys::CART_ITEM_DELTAS,
			$line[ Keys::CART_ITEM_KEY ],
			'Precondition: this line must be on the freeze-skipped path.'
		);

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach(
			$item,
			'cart-key',
			array_merge(
				$line,
				array(
					'product_id' => self::PRODUCT_ID,
					'quantity'   => 1,
				)
			)
		);

		$this->assertSame(
			array( 'opt-a' => 'OAK' ),
			json_decode( (string) $item->get_meta( Keys::META_SKU_SUFFIX ), true )
		);
	}

	/**
	 * 🔴 A rule published after add-to-cart cannot leave its option on an order.
	 *
	 * **ADR-051 is explicit that this must be proven here rather than at the
	 * resolver:** *"the path is resolver → `cart_item_data` → session → order
	 * meta → fulfilment output, and Phase 12 found real defects at three of
	 * those hops."*
	 *
	 * ⚠️ **The two-step is the whole test, and a one-step version proves
	 * nothing.** A first attempt simply never submitted the hidden option — so
	 * it was absent from the order whether rules existed or not, and the test
	 * passed with rule evaluation **disabled entirely**. Measured; it
	 * distinguished *submitted* from *not submitted*, never *hidden* from *not
	 * hidden*.
	 *
	 * The case that actually exists: a customer answers both options while no
	 * rule applies, and the merchant publishes a hiding rule afterwards. The
	 * line is already frozen with the answer on it.
	 *
	 * 🔴 **`OrderLineItem` copies the frozen line and never re-resolves**, so
	 * nothing at this hop can strip the value. The guarantee is upstream:
	 * `CheckoutValidator` refuses the line, and it never becomes an order at
	 * all. This asserts that refusal — the thing that is actually true — rather
	 * than a stripping that does not happen.
	 */
	public function test_a_line_hidden_by_a_later_rule_cannot_reach_an_order(): void {
		// Step one: no rule yet, and the customer answers both options.
		$this->store_rule_config( false );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'yes',
			'opt-b' => 'engrave-me',
		);

		$line = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$this->assertSame(
			'engrave-me',
			$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ]['opt-b'] ?? null,
			'Precondition: the answer is frozen onto the line while no rule hides it.'
		);

		// Step two: the merchant publishes the rule. The frozen line no longer resolves.
		$this->store_rule_config( true );

		$result = SelectionResolver::resolve(
			( new Repository( new Logger( new Settings() ) ) )->option_sets_for_product( self::PRODUCT_ID ),
			$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ],
			0
		);

		$this->assertFalse(
			$result->is_ok(),
			'A frozen line carrying a now-hidden option must not resolve.'
		);
		$this->assertSame( SelectionResolver::ERROR_HIDDEN_BY_RULE, $result->get_errors()[0]['code'] );
		$this->assertSame( 'opt-b', $result->get_errors()[0]['field'] );
	}

	/**
	 * The control: the same frozen line resolves while no rule hides it.
	 *
	 * Without it, a resolver that refused every cart line would satisfy the test
	 * above — and "no order can ever be placed" is a worse defect than the one
	 * being guarded against.
	 */
	public function test_the_same_frozen_line_resolves_when_no_rule_hides_it(): void {
		$this->store_rule_config( false );

		$_POST[ Keys::FIELD_PREFIX ] = array(
			'opt-a' => 'yes',
			'opt-b' => 'engrave-me',
		);

		$line = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		$result = SelectionResolver::resolve(
			( new Repository( new Logger( new Settings() ) ) )->option_sets_for_product( self::PRODUCT_ID ),
			$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ],
			0
		);

		$this->assertTrue( $result->is_ok() );

		// And it reaches the order, which is what makes the refusal above meaningful.
		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach(
			$item,
			'cart-key',
			array_merge(
				$line,
				array(
					'product_id' => self::PRODUCT_ID,
					'quantity'   => 1,
				)
			)
		);

		$stored = json_decode( (string) $item->get_meta( Keys::META_SELECTIONS ), true );

		$this->assertSame( 'engrave-me', $stored['opt-b'] ?? null );
	}

	/**
	 * One trigger, one text option, and a rule hiding the text when the trigger
	 * is answered "yes".
	 */
	private function store_rule_config( bool $with_rule = true ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'config_version' => 7,
				'option_sets'    => array(
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
										'label'  => 'Engraving',
										'values' => array(
											array(
												'id'    => 'val-yes',
												'value_key' => 'yes',
												'label' => 'Yes',
											),
											array(
												'id'    => 'val-no',
												'value_key' => 'no',
												'label' => 'No',
											),
										),
									),
									array(
										'id'         => 'opt-b',
										'type'       => 'text_field',
										'value_kind' => 'text',
										'label'      => 'Engraving Text',
									),
								),
							),
						),
						'rules'       => ! $with_rule ? array() : array(
							array(
								'id'          => 'r-1',
								'target_type' => 'option',
								'target_id'   => 'opt-b',
								'action'      => 'hide',
								'match_type'  => 'all',
								'conditions'  => array(
									array(
										'option_id' => 'opt-a',
										'operator'  => 'equals',
										'value'     => 'yes',
									),
								),
								'sort_order'  => 10,
							),
						),
					),
				),
			),
			'W/"order-rules-' . ( $with_rule ? 'on' : 'off' ) . '"'
		);
	}

	/**
	 * A configuration whose single option this build cannot price.
	 *
	 * `tiered` has no evaluator in any phase — `per_char` and `percentage` are
	 * both charged since M16.1/M16.2, so using either would test the opposite of
	 * this method's name.
	 */
	private function store_unpriceable_config(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'config_version' => 7,
				'option_sets'    => array(
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
										'label'  => 'Finish',
										'values' => array(
											array(
												'value_key' => 'lux',
												'label' => 'Luxury',
												'sku_suffix' => 'OAK',
												'price_config' => array( 'type' => 'tiered' ),
											),
										),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"unpriceable"'
		);
	}

	/**
	 * The suffix key is hidden from the admin order screen.
	 *
	 * An underscore prefix is not enough there — see the class docblock — so a
	 * merchant would otherwise see a raw JSON blob beside the readable options.
	 */
	public function test_the_sku_suffix_key_is_hidden(): void {
		$this->assertContains( Keys::META_SKU_SUFFIX, OrderLineItem::hidden_keys() );
	}

	/**
	 * A line whose options carry no suffix writes no key at all.
	 *
	 * An empty JSON object on every order would be noise in the meta table and
	 * would make "has a suffix" indistinguishable from "was configured with an
	 * empty one".
	 */
	public function test_no_suffix_writes_no_key(): void {
		$line = $this->line();

		unset( $line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SKU_SUFFIXES ] );

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertSame( '', (string) $item->get_meta( Keys::META_SKU_SUFFIX ) );
	}

	// --- The machine tier ----------------------------------------------------

	/**
	 * Selections are written as machine data, under a hidden key.
	 */
	public function test_selections_are_written_as_machine_data(): void {
		$item = $this->attach_line();

		$this->assertSame(
			array(
				'opt-a' => 'lux',
				'opt-b' => 'yes',
			),
			json_decode( (string) $item->get_meta( Keys::META_SELECTIONS ), true )
		);
	}

	/**
	 * The config version and option-set id are recorded.
	 *
	 * Provenance: a support conversation about an order placed three publishes
	 * ago has nothing else to go on.
	 */
	public function test_provenance_is_recorded(): void {
		$item = $this->attach_line();

		$this->assertSame( 7, $item->get_meta( Keys::META_CONFIG_VERSION ) );
		$this->assertSame(
			array( 'set-1' ),
			json_decode( (string) $item->get_meta( Keys::META_OPTION_SET_ID ), true )
		);
	}

	/**
	 * **The price delta is written as a decimal string, not minor units.**
	 *
	 * Everything inside the plugin is integer minor units and stays that way.
	 * But this value is read by refund tooling, exports and people — an order
	 * screen showing `2000` against a 20.00 option invites exactly the wrong
	 * conclusion.
	 */
	public function test_the_price_delta_is_a_decimal_string(): void {
		$item = $this->attach_line();

		// 20.00 (Finish) + 5.00 (Engraving).
		$this->assertSame( '25.00', $item->get_meta( Keys::META_PRICE_DELTA ) );
	}

	/**
	 * **A freeze that did not apply is not recorded as if it had.**
	 *
	 * `CartTotals` prices from the frozen deltas when the signature verifies and
	 * from current configuration when it does not — a salt rotation, a site
	 * migration, a payload another plugin rewrote. This class reads the same
	 * `cart_item_data` from a different hook, so without repeating the check it
	 * copied the stale figures onto the order regardless.
	 *
	 * Measured before the guard existed: a line charged 179.00 recorded a
	 * `_optionia_price_delta` of 20.00 and `config_version` 7. **A refund
	 * calculated from that meta would have been wrong by 79.00** — a false number
	 * on a business record, in exactly the case the fallback was designed to
	 * survive gracefully.
	 */
	public function test_an_unverifiable_freeze_is_not_recorded(): void {
		$line = $this->line();

		// The site's salt changes — a migration, a clone, a routine rotation.
		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertNull( $item->get_meta( Keys::META_PRICE_DELTA ), 'A price nobody paid must not reach the order.' );
		$this->assertNull( $item->get_meta( Keys::META_CONFIG_VERSION ) );
	}

	/**
	 * **A signed but incomplete payload is not recorded either.**
	 *
	 * The case `frozen_deltas()` misses and `trusted_deltas()` catches: a
	 * signature proves who wrote a payload, not that its deltas cover the line's
	 * selections. This class used the weaker method until the Stage 0-7 audit —
	 * so the guard added in Stage 6 caught three of the four ways a payload can
	 * be untrustworthy, and this was the fourth.
	 *
	 * Measured before the fix: a two-option line whose payload held one delta was
	 * priced **live at 105.00** while the order recorded **20.00**. A refund from
	 * that meta would have been wrong.
	 */
	public function test_a_signed_but_incomplete_payload_is_not_recorded(): void {
		$line = $this->line();

		// Signed correctly, but describing only one of the line's two options.
		$selections = $line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ];
		$partial    = array( 'opt-a' => 2000 );

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ]    = $partial;
		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SIGNATURE ] = CartItemPayload::sign( $selections, $partial, 7 );

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertNull(
			$item->get_meta( Keys::META_PRICE_DELTA ),
			'A payload that does not describe the line must not price it on the order.'
		);
		$this->assertSame(
			'Luxury',
			$item->get_meta( 'Finish' ),
			'The line is still recorded — only the quoted price is unknown.'
		);
	}

	/**
	 * A tampered payload is not recorded either.
	 *
	 * The other route to the same fallback, and the one with an actor behind it.
	 */
	public function test_a_tampered_freeze_is_not_recorded(): void {
		$line = $this->line();

		$line[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_DELTAS ] = array( 'opt-a' => -5000 );

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertNull( $item->get_meta( Keys::META_PRICE_DELTA ) );
	}

	/**
	 * But the selections and labels are still recorded.
	 *
	 * The freeze failing is not a reason to lose the order's *contents*. A
	 * merchant still has to make the product, and a support conversation still
	 * needs to know what was ordered — only the quoted price is unknown.
	 */
	public function test_a_line_priced_live_still_records_what_was_ordered(): void {
		$line = $this->line();

		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$item = optionia_test_order_item();
		( new OrderLineItem() )->attach( $item, 'cart-key', $line );

		$this->assertSame( 'Luxury', $item->get_meta( 'Finish' ) );
		$this->assertSame(
			array(
				'opt-a' => 'lux',
				'opt-b' => 'yes',
			),
			json_decode( (string) $item->get_meta( Keys::META_SELECTIONS ), true )
		);
		$this->assertSame(
			array( 'set-1' ),
			json_decode( (string) $item->get_meta( Keys::META_OPTION_SET_ID ), true )
		);
	}

	// --- The two hiding mechanisms -------------------------------------------

	/**
	 * **Machine keys are registered with the admin hidden-key allow-list.**
	 *
	 * The underscore prefix governs *customer-facing* output only. Phase 4 found
	 * an underscore-prefixed key appearing on the admin order screen twice —
	 * once read-only and once as an **editable input** a merchant could change.
	 * The admin screen uses `OrderItemMetaUtil::get_hidden_keys()`, an explicit
	 * allow-list, so both mechanisms are required.
	 */
	public function test_machine_keys_are_hidden_from_the_admin_screen(): void {
		$hidden = ( new OrderLineItem() )->hide_machine_keys( array( '_qty', '_tax_class' ) );

		foreach ( OrderLineItem::hidden_keys() as $key ) {
			$this->assertContains( $key, $hidden, $key . ' would appear as an editable admin input.' );
		}
	}

	/**
	 * **A merchant cannot edit or delete the machine keys from the order screen.**
	 *
	 * Recorded 2026-09-01 in Stage 8, while verifying M12.8's "admin order editing
	 * with option data intact". WooCommerce 11.0.0 added
	 * `OrderItemMetaUtil::get_reserved_keys()`, which is **derived from the hidden
	 * keys**, and `wc_save_order_items()` skips every reserved key on save
	 * (`includes/admin/wc-admin-functions.php:366` and `:439`):
	 *
	 * ```php
	 * // Skip reserved keys, which cannot be added or edited as custom meta.
	 * if ( in_array( $meta_key, $reserved_meta_keys, true ) ) {
	 *     continue;
	 * }
	 * ```
	 *
	 * So the one registration buys two properties, not one: the keys are hidden
	 * from the screen **and** immutable through it. A merchant editing an order
	 * cannot silently change the delta a line was charged, or delete the selections
	 * an order was fulfilled from.
	 *
	 * This models core's loop rather than trusting it, so the test fails if the
	 * registration is dropped — the property is inherited, and an inherited
	 * property is exactly the kind that disappears without anyone noticing.
	 */
	public function test_machine_keys_cannot_be_edited_from_the_order_screen(): void {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_PRICE_DELTA, '20.00', true );
		$item->add_meta_data( 'Finish', 'Luxury', true );

		// A merchant edits both rows and submits.
		$this->save_order_item_meta(
			$item,
			array(
				Keys::META_PRICE_DELTA => '0.00',
				'Finish'               => 'Standard',
			)
		);

		$this->assertSame(
			'20.00',
			$item->get_meta( Keys::META_PRICE_DELTA ),
			'A merchant could rewrite the recorded price delta from the order screen.'
		);

		// The control: an ordinary row is editable, so the guard is the hidden
		// list and not the double refusing every write.
		$this->assertSame( 'Standard', $item->get_meta( 'Finish' ) );
	}

	/**
	 * A merchant cannot delete the machine keys either.
	 *
	 * `wc_save_order_items()` deletes a row when its key and value are both
	 * blanked, and the same `continue` skips reserved keys before it gets there.
	 */
	public function test_machine_keys_cannot_be_deleted_from_the_order_screen(): void {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, '{"opt-a":"lux"}', true );

		$this->save_order_item_meta( $item, array( Keys::META_SELECTIONS => '' ) );

		$this->assertSame( '{"opt-a":"lux"}', $item->get_meta( Keys::META_SELECTIONS ) );
	}

	/**
	 * WooCommerce 11's order-item save loop, over the reserved-key list.
	 *
	 * Models `wc_save_order_items()` (`includes/admin/wc-admin-functions.php:365`)
	 * closely enough that the `continue` is the thing under test:
	 *
	 * ```php
	 * $reserved_meta_keys = OrderItemMetaUtil::get_reserved_keys( $item );
	 * // Skip reserved keys, which cannot be added or edited as custom meta.
	 * if ( in_array( $meta_key, $reserved_meta_keys, true ) ) {
	 *     continue;
	 * }
	 * ```
	 *
	 * `get_reserved_keys()` is the hidden keys plus the item's own internal ones,
	 * so it is fed by the very filter `OrderLineItem::register()` attaches — which
	 * is why this fails when that registration is dropped.
	 *
	 * @param object                $item      The order line item.
	 * @param array<string, string> $submitted Meta the merchant submitted.
	 */
	private function save_order_item_meta( object $item, array $submitted ): void {
		// The registration under test: without it the filter adds nothing.
		( new OrderLineItem() )->register();

		$reserved = array_merge(
			apply_filters( 'woocommerce_hidden_order_itemmeta', array( '_qty', '_tax_class' ) ),
			array( '_product_id', '_variation_id' )
		);

		foreach ( $submitted as $meta_key => $meta_value ) {
			if ( in_array( $meta_key, $reserved, true ) ) {
				continue;
			}

			if ( '' === $meta_value ) {
				$item->delete_meta_data( $meta_key );

				continue;
			}

			$item->update_meta_data( $meta_key, $meta_value );
		}
	}

	/**
	 * Other plugins' hidden keys are preserved.
	 *
	 * The filter is shared; replacing the list rather than adding to it would
	 * expose every key WooCommerce and every other plugin hides.
	 */
	public function test_other_plugins_hidden_keys_survive(): void {
		$hidden = ( new OrderLineItem() )->hide_machine_keys( array( '_qty', '_someone_elses_key' ) );

		$this->assertContains( '_qty', $hidden );
		$this->assertContains( '_someone_elses_key', $hidden );
	}

	/**
	 * A non-array from another badly-behaved filter does not break the list.
	 */
	public function test_a_non_array_filter_value_is_tolerated(): void {
		$this->assertSame( OrderLineItem::hidden_keys(), ( new OrderLineItem() )->hide_machine_keys( null ) );
	}

	/**
	 * Every machine key written is also a hidden key.
	 *
	 * The pairing that actually matters: a key written but not registered is one
	 * a merchant can edit on the order screen.
	 */
	public function test_every_machine_key_written_is_registered_as_hidden(): void {
		$item = $this->attach_line();

		foreach ( array_keys( $item->meta ) as $key ) {
			if ( 0 !== strpos( (string) $key, '_' ) ) {
				continue;
			}

			$this->assertContains( $key, OrderLineItem::hidden_keys() );
		}
	}

	// --- M12.6 / M12.6b: what each surface shows -----------------------------

	/**
	 * **Only the human-readable pairs reach customer-facing output.**
	 *
	 * `wc_display_item_meta()` renders order item meta into order emails
	 * (`templates/emails/email-order-items.php`, including the plain-text
	 * variant) and the customer's order page
	 * (`templates/order/order-details-item.php`). It calls
	 * `get_formatted_meta_data()`, whose `$hideprefix` defaults to `_`.
	 *
	 * So M12.6b's surfaces are satisfied by the key *naming*, not by separate
	 * rendering code — provided exactly the right keys are on each side of the
	 * line. This asserts that split, because a machine key that lost its
	 * underscore would appear on a customer's invoice as a JSON blob.
	 */
	public function test_only_readable_pairs_are_customer_facing(): void {
		$item = $this->attach_line();

		$visible = array_filter(
			array_keys( $item->meta ),
			static fn ( string $key ): bool => 0 !== strpos( $key, '_' )
		);

		sort( $visible );

		$this->assertSame(
			array( 'Engraving', 'Finish' ),
			array_values( $visible ),
			'A machine key without its underscore would print on a customer invoice.'
		);
	}

	/**
	 * Every machine key is underscore-prefixed.
	 *
	 * The other half of the same guarantee: a machine key that *gained* a
	 * readable name would still be hidden from print, but would show on the admin
	 * screen as an editable field.
	 */
	public function test_every_machine_key_is_underscore_prefixed(): void {
		foreach ( OrderLineItem::hidden_keys() as $key ) {
			$this->assertStringStartsWith( '_', $key );
		}
	}

	// --- Registration and boundaries -----------------------------------------

	/**
	 * Both hooks are registered.
	 */
	public function test_registers_the_order_hook_and_the_hidden_key_filter(): void {
		( new OrderLineItem() )->register();

		$this->assertCount( 1, $GLOBALS['optionia_test_actions'][ OrderLineItem::HOOK ] ?? array() );
		$this->assertCount( 1, $GLOBALS['optionia_test_filters']['woocommerce_hidden_order_itemmeta'] ?? array() );
	}

	/**
	 * A line with no Optionia data is left alone.
	 *
	 * The hook fires for every line in every order, most of which have nothing
	 * to do with this plugin.
	 */
	public function test_a_line_without_optionia_data_is_untouched(): void {
		$item = optionia_test_order_item();

		( new OrderLineItem() )->attach( $item, 'cart-key', array( 'quantity' => 1 ) );

		$this->assertSame( array(), $item->meta );
	}

	/**
	 * Malformed input neither writes nor errors.
	 *
	 * @dataProvider provide_malformed_values
	 *
	 * @param mixed $values Whatever the hook handed over.
	 */
	public function test_malformed_input_is_tolerated( $values ): void {
		$item = optionia_test_order_item();

		( new OrderLineItem() )->attach( $item, 'cart-key', $values );

		$this->assertSame( array(), $item->meta );
	}

	/**
	 * Shapes a cart item might arrive in.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_malformed_values(): array {
		return array(
			'null'               => array( null ),
			'a string'           => array( 'garbage' ),
			'optionia not array' => array( array( Keys::CART_ITEM_KEY => 'garbage' ) ),
			'no selections'      => array( array( Keys::CART_ITEM_KEY => array() ) ),
			'empty selections'   => array( array( Keys::CART_ITEM_KEY => array( Keys::CART_ITEM_SELECTIONS => array() ) ) ),
		);
	}

	/**
	 * An item that cannot take meta is ignored rather than fatal.
	 */
	public function test_an_item_without_add_meta_data_is_ignored(): void {
		$this->expectNotToPerformAssertions();

		( new OrderLineItem() )->attach( new \stdClass(), 'cart-key', $this->line() );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * Build a cart line and run it through the order hook.
	 *
	 * @param array<string, string> $selections Option id to value key.
	 * @param string                $lux_label  The `lux` value's label.
	 * @return object The order item double.
	 */
	private function attach_line( array $selections = array(), string $lux_label = 'Luxury' ): object {
		$item = optionia_test_order_item();

		( new OrderLineItem() )->attach( $item, 'cart-key', $this->line( $selections, $lux_label ) );

		return $item;
	}

	/**
	 * A cart line written by the real writer, so the shape is production's.
	 *
	 * @param array<string, string> $selections Option id to value key.
	 * @param string                $lux_label  The `lux` value's label.
	 * @return array<string, mixed>
	 */
	private function line( array $selections = array(), string $lux_label = 'Luxury' ): array {
		$this->store_config( $lux_label );

		$_POST[ Keys::FIELD_PREFIX ] = array() === $selections
			? array(
				'opt-a' => 'lux',
				'opt-b' => 'yes',
			)
			: $selections;

		$line = ( new CartItemData( new Repository( new Logger( new Settings() ) ) ) )
			->attach( array(), self::PRODUCT_ID, 0, 1 );

		unset( $_POST[ Keys::FIELD_PREFIX ] );

		return array_merge(
			$line,
			array(
				'product_id' => self::PRODUCT_ID,
				'quantity'   => 1,
			)
		);
	}

	/**
	 * Store a two-option configuration.
	 *
	 * @param string $lux_label The `lux` value's label.
	 */
	private function store_config( string $lux_label ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'config_version' => 7,
				'option_sets'    => array(
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
										'label'  => 'Finish',
										'values' => array(
											array(
												'value_key' => 'lux',
												'label' => $lux_label,
												'sku_suffix' => 'OAK',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 2000,
												),
											),
										),
									),
									array(
										'id'     => 'opt-b',
										'type'   => 'radio',
										'label'  => 'Engraving',
										'values' => array(
											array(
												'value_key' => 'yes',
												'label' => 'Yes',
												'sku_suffix' => 'ENG',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 500,
												),
											),
										),
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"' . md5( $lux_label ) . '"'
		);
	}
}
