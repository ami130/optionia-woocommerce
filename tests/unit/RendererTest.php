<?php
/**
 * What renders on a product page, and what deliberately does not.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Frontend\Assets;
use Optionia\Frontend\Renderer;
use Optionia\Frontend\Templates;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

/**
 * Per-type dispatch, idempotence, and the products that get nothing.
 *
 * @covers \Optionia\Frontend\Renderer
 */
// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- `$product`
// is WordPress's own global, not one this plugin defines. `Frontend\Renderer`
// reads it because that is what WooCommerce's templates hold at the hooks it
// registers on, and those hooks pass no arguments.
final class RendererTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
		$GLOBALS['product']               = null;
	}

	/**
	 * A renderer over real collaborators.
	 */
	private function renderer(): Renderer {
		$logger = new Logger( new Settings() );

		return new Renderer( new Repository( $logger ), new Templates( $logger ), new Assets(), $logger );
	}

	/**
	 * Cache a document assigning one radio option to product 20.
	 */
	private function cache_options(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'          => 'opt-a',
										'key'         => 'placement',
										'type'        => 'radio',
										'label'       => 'Print placement',
										'is_required' => true,
										'values'      => array(
											array(
												'value_key' => 'front',
												'label' => 'Front',
												'is_default' => true,
											),
											array(
												'value_key' => 'back',
												'label' => 'Back',
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
			'W/"store-7"'
		);
	}

	/**
	 * Render for a product of the given type, returning the echoed markup.
	 */
	private function render_for( int $id, string $type ): string {
		$GLOBALS['product'] = optionia_test_product( $id, $type );

		ob_start();
		$this->renderer()->render();

		return (string) ob_get_clean();
	}

	/**
	 * A simple product with an assigned option set renders it.
	 */
	public function test_a_simple_product_renders_its_options(): void {
		$this->cache_options();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'optionia-options', $markup );
		$this->assertStringContainsString( 'Print placement', $markup );
		$this->assertStringContainsString( 'name="optionia[opt-a]"', $markup );
	}

	/**
	 * A variable product renders too — it is the segment this phase targets.
	 */
	public function test_a_variable_product_renders_its_options(): void {
		$this->cache_options();

		$this->assertStringContainsString( 'optionia-options', $this->render_for( 20, 'variable' ) );
	}

	/**
	 * **An external product renders nothing.**
	 *
	 * A live code path, not a theoretical one: `external.php` fires
	 * `woocommerce_before_add_to_cart_button` at line 23 exactly as the other
	 * templates do, so without naming the supported types Optionia would draw
	 * options on a product whose button links offsite and can never be added to
	 * a cart.
	 */
	public function test_an_external_product_renders_nothing(): void {
		$this->cache_options();

		$this->assertSame( '', $this->render_for( 20, 'external' ) );
	}

	/**
	 * **A grouped product renders nothing, on structure rather than scope.**
	 *
	 * In `grouped.php` the button hook fires at line 136 — *after* the children
	 * loop at 43–127 — so options would appear once at the foot of the table
	 * with nothing tying them to a child, and each child is its own cart line. A
	 * block that cannot map to a line item is worse than no block.
	 */
	public function test_a_grouped_product_renders_nothing(): void {
		$this->cache_options();

		$this->assertSame( '', $this->render_for( 20, 'grouped' ) );
	}

	/**
	 * **Rendering twice for one product prints one block.**
	 *
	 * Both hooks are registered, and on a variable product both fire: Phase 4
	 * measured exactly this and saw two option blocks. Per-type dispatch is what
	 * makes the *right* hook draw; this guard is what makes a second arrival —
	 * from a theme, a page builder, or the variation form's own button hook —
	 * change nothing.
	 */
	public function test_a_second_render_for_the_same_product_prints_nothing(): void {
		$this->cache_options();

		$GLOBALS['product'] = optionia_test_product( 20, 'variable' );

		$renderer = $this->renderer();

		ob_start();
		$renderer->render();
		$first = (string) ob_get_clean();

		ob_start();
		$renderer->render();
		$second = (string) ob_get_clean();

		$this->assertNotSame( '', $first, 'The first render must produce markup.' );
		$this->assertSame( '', $second, 'The second render for one product must produce nothing.' );
	}

	/**
	 * A different product on the same request still renders.
	 *
	 * The guard is per product, not per request: a shop page draws many
	 * products, and one having rendered must not silence the rest.
	 */
	public function test_a_different_product_still_renders(): void {
		$this->cache_options();

		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'all',
								'target_type' => null,
								'target_ref'  => null,
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'     => 'opt-a',
										'type'   => 'radio',
										'label'  => 'Placement',
										'values' => array(
											array(
												'value_key' => 'front',
												'label' => 'Front',
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
			'W/"store-7"'
		);

		$renderer = $this->renderer();

		$GLOBALS['product'] = optionia_test_product( 20, 'simple' );
		ob_start();
		$renderer->render();
		ob_end_clean();

		$GLOBALS['product'] = optionia_test_product( 23, 'simple' );
		ob_start();
		$renderer->render();

		$this->assertNotSame( '', (string) ob_get_clean(), 'A second product must render its own options.' );
	}

	/**
	 * A product with no assigned options renders nothing at all.
	 *
	 * Not an empty wrapper: a product nobody configured must look exactly as it
	 * did before this plugin was installed.
	 */
	public function test_a_product_with_no_options_renders_nothing(): void {
		$this->cache_options();

		$this->assertSame( '', $this->render_for( 99, 'simple' ) );
	}

	/**
	 * An unconfigured store renders nothing and does not warn.
	 */
	public function test_an_unconfigured_store_renders_nothing(): void {
		$this->assertSame( '', $this->render_for( 20, 'simple' ) );
	}

	/**
	 * A required option is marked for sighted and screen-reader users alike.
	 *
	 * M10.2 asks for "correct labels/required markers/descriptions" and
	 * "accessible (labels bound, fieldset/legend for groups, ARIA for required
	 * and errors)". The markup did all of that from the first commit; nothing
	 * asserted any of it, so removing the required marker broke no test —
	 * measured during the Stage 4 audit.
	 *
	 * The asterisk is `aria-hidden` because a screen reader announcing "star"
	 * says nothing useful, and the visually-hidden "(required)" carries the same
	 * meaning to someone who cannot see it. Both are needed: either alone leaves
	 * one group of customers guessing.
	 */
	public function test_a_required_option_is_marked_for_every_reader(): void {
		$this->cache_options();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'aria-required="true"', $markup );
		$this->assertStringContainsString( 'aria-hidden="true"', $markup );
		$this->assertStringContainsString( 'screen-reader-text', $markup );
		$this->assertStringContainsString( '(required)', $markup );
		$this->assertStringContainsString( 'required', $markup );
	}

	/**
	 * Every radio is bound to its own label, and the group to its legend.
	 *
	 * `for=` is the difference between a clickable label and a radio that only
	 * answers a precise click on the button itself — and for a screen reader, it
	 * is what gives the input a name at all. The `<legend>` names the *question*
	 * a set of radios asks, which a `<label>` on one input cannot do.
	 *
	 * Asserted by pairing: the `for` attribute must name an id that the markup
	 * actually defines, so renaming one side alone fails here rather than
	 * producing a page where nothing is clickable.
	 */
	public function test_each_input_is_bound_to_a_label(): void {
		$this->cache_options();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression( '/<legend[^>]*>/', $markup );
		$this->assertMatchesRegularExpression( '/<fieldset[^>]*>/', $markup );

		$this->assertSame(
			1,
			preg_match( '/for="([^"]+)"/', $markup, $for ),
			'A radio must carry a for= binding.'
		);

		$this->assertStringContainsString(
			'id="' . $for[1] . '"',
			$markup,
			'The for= attribute must name an id the markup defines.'
		);
	}

	/**
	 * A value marked default arrives pre-selected.
	 *
	 * A merchant setting a default has made a choice on the customer's behalf,
	 * and a form that ignores it changes what gets ordered — quietly, because
	 * nothing looks broken. The fixture's `front` value is the default and
	 * `back` is not, so the assertion distinguishes "the default is checked"
	 * from "something is checked".
	 */
	public function test_a_default_value_is_preselected(): void {
		$this->cache_options();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression(
			'/value="front"[^>]*checked/',
			$markup,
			'The default value must render checked.'
		);

		$this->assertDoesNotMatchRegularExpression(
			'/value="back"[^>]*checked/',
			$markup,
			'A non-default value must not render checked.'
		);
	}

	/**
	 * A description is announced with the option it describes.
	 *
	 * `aria-describedby` has to point at an id the page defines; a dangling
	 * reference announces nothing and looks identical in the markup.
	 */
	public function test_a_description_is_associated_with_its_option(): void {
		// Its own fixture: the shared one carries no description, so asserting
		// against it would have tested the fixture rather than the template.
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'          => 'opt-a',
										'type'        => 'radio',
										'label'       => 'Print placement',
										'description' => 'Where the design is printed.',
										'values'      => array(
											array(
												'value_key' => 'front',
												'label' => 'Front',
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
			'W/"store-7"'
		);

		$markup = $this->render_for( 20, 'simple' );

		if ( 1 !== preg_match( '/aria-describedby="([^"]+)"/', $markup, $describes ) ) {
			$this->fail( 'An option with a description must carry aria-describedby.' );
		}

		$this->assertStringContainsString(
			'id="' . $describes[1] . '"',
			$markup,
			'aria-describedby must name an id the markup defines.'
		);
	}

	/**
	 * Hostile configuration cannot inject markup into a product page.
	 *
	 * **A storefront renders text the merchant did not write.** Labels and
	 * descriptions come from the cloud, so a compromised account, a bug in the
	 * builder, or a future import would put whatever it liked in front of every
	 * customer. Escaping is the only thing between that and script execution.
	 *
	 * This test could not exist until the Stage 4 audit: the harness stubbed
	 * `esc_html()` and `esc_attr()` as identity functions, so escaped and raw
	 * output were byte-identical and removing every escape call left the whole
	 * suite green. PHPCS caught an unescaped `echo` — the right layer for a rule
	 * about how output is written — but nothing could assert what the page
	 * actually contained.
	 *
	 * The payloads below break out of three different contexts: element text,
	 * a double-quoted attribute, and an attribute that would become an event
	 * handler.
	 */
	public function test_hostile_labels_cannot_inject_markup(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => '<script>alert(1)</script>',
								'options' => array(
									array(
										'id'          => 'opt-a',
										'type'        => 'radio',
										'label'       => '<img src=x onerror=alert(2)>',
										'description' => '"><script>alert(3)</script>',
										'is_required' => true,
										'values'      => array(
											array(
												'value_key' => 'v" onmouseover="alert(4)',
												'label' => '<b>bold</b>',
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
			'W/"store-7"'
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertNotSame( '', $markup, 'The page must still render; escaping is not refusal.' );

		/*
		 * Asserted on the characters that *make* markup, not on the words inside
		 * a payload.
		 *
		 * A first version of this test failed on `onerror=` and it was not a
		 * vulnerability: the output was `&lt;img src=x onerror=alert(2)&gt;`,
		 * which is inert text — the angle brackets are what would have turned it
		 * into an element. Asserting on the substring measured the payload's
		 * vocabulary rather than whether a browser could parse it, which would
		 * have made the test fail on safe output and pass on a payload that
		 * avoided those words.
		 */
		foreach ( array( '<script', '<img', '<b>' ) as $tag ) {
			$this->assertStringNotContainsString(
				$tag,
				$markup,
				sprintf( 'A parseable %s> element reached the page.', $tag )
			);
		}

		// An attribute-breaking quote must not survive into an attribute either:
		// `value="v" onmouseover="alert(4)"` would be a live handler.
		$this->assertStringNotContainsString( '" onmouseover=', $markup );

		// The text is still shown, escaped — not silently dropped.
		$this->assertStringContainsString( '&lt;script&gt;alert(1)&lt;/script&gt;', $markup );
	}

	/**
	 * A `fixed` price reaches the markup, so the runtime can total it.
	 *
	 * The estimate is arithmetic on what the DOM carries. Before Stage 5 the
	 * markup held only the value key, so there was nothing to add up — the
	 * cloud sends `price_config` and the template simply did not render it.
	 */
	public function test_a_fixed_price_is_rendered_onto_the_input(): void {
		$this->cache_priced_options();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'data-optionia-price-type="fixed"', $markup );
		$this->assertStringContainsString( 'data-optionia-price="1000"', $markup );
	}

	/**
	 * A price this storefront cannot compute carries its type and no amount.
	 *
	 * `percentage`, `per_unit`, `per_char` and `tiered` each need a decision
	 * `docs/PRICING-SPEC.md` has not made — what a percentage applies to, how it
	 * rounds, where a quantity comes from. Emitting an amount the runtime would
	 * add up means showing a total the server then disagrees with.
	 *
	 * The **type** is still emitted, which is what lets the runtime tell "adds
	 * nothing" from "cannot be priced here", and hide the estimate rather than
	 * show a partial one.
	 */
	public function test_a_non_fixed_price_emits_its_type_but_no_amount(): void {
		$this->cache_priced_options( 'percentage', 15 );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'data-optionia-price-type="percentage"', $markup );
		$this->assertStringNotContainsString( 'data-optionia-price="', $markup );
	}

	/**
	 * The estimate element is present, hidden, and announced politely.
	 */
	public function test_the_estimate_element_is_rendered_hidden(): void {
		$this->cache_priced_options();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'data-optionia="estimate"', $markup );
		$this->assertStringContainsString( 'aria-live="polite"', $markup );
		$this->assertStringContainsString( 'hidden', $markup );
	}

	/**
	 * The page says the total is an estimate without relying on JavaScript.
	 *
	 * AC4 makes the server authoritative. A customer with scripting disabled, or
	 * reading before the bundle parses, must not be shown a number this page
	 * cannot promise — so the caveat is markup, not a string in the runtime.
	 */
	public function test_the_estimate_is_labelled_in_markup_not_only_in_script(): void {
		$this->cache_priced_options();

		$this->assertStringContainsString(
			'final price is confirmed at checkout',
			$this->render_for( 20, 'simple' )
		);
	}

	/**
	 * Currency settings reach the runtime.
	 *
	 * WooCommerce localises these for its **cart and checkout** scripts, not for
	 * a product page, so a runtime formatting a total there has no symbol and no
	 * separators unless the plugin hands them over.
	 */
	public function test_currency_settings_are_passed_to_the_runtime(): void {
		$this->cache_priced_options();

		$assets   = new Assets();
		$logger   = new Logger( new Settings() );
		$renderer = new Renderer( new Repository( $logger ), new Templates( $logger ), $assets, $logger );

		$GLOBALS['product'] = optionia_test_product( 20, 'simple' );

		ob_start();
		$renderer->render();
		ob_end_clean();

		$localized = $GLOBALS['optionia_test_localized']['optionia-frontend']['optioniaSettings'] ?? array();

		$this->assertArrayHasKey( 'currency', $localized );

		foreach ( array( 'symbol', 'decimals', 'decimal', 'thousand', 'format' ) as $key ) {
			$this->assertArrayHasKey( $key, $localized['currency'], $key . ' must reach the runtime.' );
		}
	}

	/**
	 * Cache one priced radio value on product 20.
	 *
	 * @param string $type  Price type.
	 * @param int    $minor Amount in minor units.
	 */
	private function cache_priced_options( string $type = 'fixed', int $minor = 1000 ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'     => 'opt-a',
										'type'   => 'radio',
										'label'  => 'Print placement',
										'values' => array(
											array(
												'value_key' => 'front',
												'label' => 'Front',
												'price_config' => array(
													'type' => $type,
													'amount_minor' => $minor,
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
			'W/"store-7"'
		);
	}

	/**
	 * Both hooks are registered, so the correct one fires per type.
	 */
	public function test_it_registers_both_per_type_hooks(): void {
		$this->renderer()->register();

		$this->assertArrayHasKey( 'woocommerce_before_add_to_cart_button', $GLOBALS['optionia_test_actions'] );
		$this->assertArrayHasKey( 'woocommerce_after_variations_table', $GLOBALS['optionia_test_actions'] );
	}

	/**
	 * Assets load only when something is actually rendered.
	 */
	public function test_assets_are_not_enqueued_without_options(): void {
		$assets   = new Assets();
		$logger   = new Logger( new Settings() );
		$renderer = new Renderer( new Repository( $logger ), new Templates( $logger ), $assets, $logger );

		$GLOBALS['product'] = optionia_test_product( 99, 'simple' );

		ob_start();
		$renderer->render();
		ob_end_clean();

		$this->assertFalse( $assets->frontend_enqueued(), 'A product with no options must not load the bundle.' );
	}

	/**
	 * Cache a document whose single option is a **dropdown**.
	 *
	 * 🔴 Phase 14 added `dropdown` with **no template test at all** — radio's
	 * template was covered by three suites and the new one by none. The gap was
	 * measured, not assumed: nothing in `tests/` referenced `dropdown`.
	 *
	 * @param bool $required     Whether the option must be answered.
	 * @param bool $with_default Whether a value is pre-selected.
	 */
	private function cache_dropdown( bool $required, bool $with_default ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'          => 'opt-d',
										'key'         => 'finish',
										'type'        => 'dropdown',
										'label'       => 'Finish',
										'is_required' => $required,
										'values'      => array(
											array(
												'value_key' => 'lux',
												'label' => 'Luxury',
												'is_default' => $with_default,
											),
											array(
												'value_key' => 'std',
												'label' => 'Standard',
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
			'W/"store-7"'
		);
	}

	/** A dropdown renders as one `<select>` carrying every value. */
	public function test_a_dropdown_renders_a_select_with_its_values(): void {
		$this->cache_dropdown( false, false );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'optionia-option--dropdown', $markup );
		$this->assertMatchesRegularExpression( '/<select[^>]*>/', $markup );
		$this->assertStringContainsString( 'value="lux"', $markup );
		$this->assertStringContainsString( 'value="std"', $markup );
	}

	/**
	 * 🔴 **A required dropdown must not arrive already answered.**
	 *
	 * A `<select>` selects its first option when none is marked, so without a
	 * placeholder a required dropdown is pre-answered — and a customer who never
	 * looked at it is charged for a choice they did not make. The placeholder
	 * carries an empty value, so `required` has something to refuse.
	 *
	 * This is the one branch of the template that changes what a merchant is paid,
	 * and it had no coverage: the canonical E2E ran with `is_required: false` and
	 * no default, so it exercised the placeholder and never the required case.
	 */
	public function test_a_dropdown_without_a_default_offers_an_empty_placeholder(): void {
		$this->cache_dropdown( true, false );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression(
			'/<option value=""[^>]*>/',
			$markup,
			'A required dropdown with no default must offer an empty choice.'
		);

		$this->assertMatchesRegularExpression(
			'/<select[^>]*\srequired/',
			$markup,
			'The control itself carries required, not a wrapping fieldset.'
		);
	}

	/**
	 * And **no** placeholder when the merchant has chosen a default.
	 *
	 * The empty option exists to represent "nothing chosen yet". A default *is* a
	 * choice, so offering an empty one beside it would let a customer un-answer a
	 * required question — the opposite of what the placeholder is for.
	 */
	public function test_a_dropdown_with_a_default_offers_no_placeholder(): void {
		$this->cache_dropdown( true, true );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertDoesNotMatchRegularExpression( '/<option value=""[^>]*>/', $markup );
		$this->assertMatchesRegularExpression( '/<option[^>]*selected/', $markup );
	}

	/**
	 * The label binds to the control, and there is no fieldset.
	 *
	 * A `<select>` is **one** control, so `<label for>` names it directly. Radio
	 * needs `<fieldset><legend>` because several inputs form one question; using
	 * a fieldset here would announce the question twice to a screen reader.
	 */
	public function test_a_dropdown_binds_its_label_to_the_control(): void {
		$this->cache_dropdown( false, false );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertSame(
			1,
			preg_match( '/<label[^>]*for="([^"]+)"/', $markup, $for ),
			'A dropdown must bind its label to the select.'
		);

		$this->assertStringContainsString( 'id="' . $for[1] . '"', $markup );

		/*
		 * ⚠️ **One fieldset, not none.** The *group* is a fieldset — that is
		 * correct and shared by every type, since a group is a set of related
		 * questions. What a dropdown must not add is a *second* one around the
		 * control itself, which would announce its question twice.
		 *
		 * An earlier version of this asserted no fieldset at all and failed
		 * against correct markup.
		 */
		$this->assertSame(
			1,
			substr_count( $markup, '<fieldset' ),
			'A dropdown adds no fieldset of its own; only the group has one.'
		);
	}

	/** Prices ride on the option, exactly as they ride on a radio input. */
	public function test_a_dropdown_carries_its_prices(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'     => 'opt-d',
										'key'    => 'finish',
										'type'   => 'dropdown',
										'label'  => 'Finish',
										'values' => array(
											array(
												'value_key' => 'lux',
												'label' => 'Luxury',
												'price_config' => array(
													'type' => 'fixed',
													'amount_minor' => 1050,
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
			'W/"store-7"'
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'data-optionia-price="1050"', $markup );
		$this->assertStringContainsString( 'data-optionia-price-type="fixed"', $markup );
	}

	/**
	 * Cache one option of any type, with optional per-value extras.
	 *
	 * Generalised from `cache_dropdown` rather than copied three more times:
	 * Stage 2a adds three types that differ only in `type` and in which value
	 * field their template reads, and three near-identical fixtures would drift
	 * the way the two type lists did.
	 *
	 * @param string               $type          Presentation to render.
	 * @param array<string, mixed> $extras        Extra keys merged into the first value.
	 * @param array<string, mixed> $option_extras Extra keys merged into the option itself,
	 *                                            for option-level fields like `cardinality`.
	 */
	private function cache_typed( string $type, array $extras = array(), array $option_extras = array() ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array_merge(
										array(
											'id'          => 'opt-t',
											'key'         => 'finish',
											'type'        => $type,
											'label'       => 'Finish',
											'is_required' => true,
											'values'      => array(
												array_merge(
													array(
														'value_key' => 'lux',
														'label'     => 'Luxury',
													),
													$extras
												),
												array(
													'value_key' => 'std',
													'label' => 'Standard',
												),
											),
										),
										$option_extras
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);
	}

	/**
	 * A text option's config: **no values at all**, which is the point.
	 *
	 * `cache_typed()` always attaches two values, because every type before this
	 * one had them. A text field is defined by having none, so a helper that
	 * quietly supplied some would test the opposite of the thing at risk.
	 *
	 * @param array<string, mixed> $extras Extra option fields (placeholder, etc).
	 */
	private function cache_text( array $extras = array() ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array_merge(
										array(
											'id'          => 'opt-t',
											'key'         => 'engraving',
											'type'        => 'text_field',
											'value_kind'  => 'text',
											'cardinality' => 'none',
											'label'       => 'Engraving',
											'is_required' => true,
											'values'      => array(),
										),
										$extras
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);
	}

	/**
	 * 🔴 **A text option renders even though it has no values.**
	 *
	 * Every choice template opens with
	 * `if ( '' === $id || array() === $values ) { return; }`, and copying that
	 * idiom into `text_field.php` would render **nothing at all** — a published
	 * option silently absent from the product page.
	 *
	 * The guard there is id-only for exactly this reason, and this is the test
	 * that fails if someone "tidies" it back into line with its siblings.
	 */
	public function test_a_text_option_renders_without_any_values(): void {
		$this->cache_text();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'optionia-option--text', $markup );
		$this->assertStringContainsString( 'type="text"', $markup );
		$this->assertStringContainsString( 'Engraving', $markup );
	}

	/**
	 * The input is bound to its label, and marked required for every reader.
	 *
	 * A `<label for>` rather than a fieldset: a text field is one control, so its
	 * label belongs to it directly — the same reasoning `dropdown.php` records.
	 */
	public function test_a_text_option_is_labelled_and_marked_required(): void {
		$this->cache_text();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression(
			'/<label[^>]*for="(optionia-[^"]+)"/',
			$markup
		);

		preg_match( '/<label[^>]*for="(optionia-[^"]+)"/', $markup, $m );
		$this->assertStringContainsString( 'id="' . $m[1] . '"', $markup, 'The label must name an id the markup defines.' );

		$this->assertStringContainsString( 'aria-required="true"', $markup );
		$this->assertStringContainsString( '(required)', $markup );
	}

	/**
	 * ⚠️ **No price attribute on a text field.**
	 *
	 * A choice carries `data-optionia-price` on the element the customer picks,
	 * and the storefront estimate sums them. Text prices `per_char`, computed
	 * server-side from `Engine\Text::measure()` — a client-side count that
	 * disagreed with the server's is the M14.4b credibility bug this project
	 * exists to avoid, so the preview stays silent rather than guessing.
	 */
	public function test_a_text_option_carries_no_price_attribute(): void {
		$this->cache_text();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'data-optionia-price', $markup );
	}

	/**
	 * A placeholder and a default reach the input, escaped.
	 */
	public function test_a_text_option_renders_its_placeholder_and_default(): void {
		$this->cache_text(
			array(
				'placeholder'   => 'e.g. Happy Birthday',
				'default_value' => 'Mum & Dad',
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'placeholder="e.g. Happy Birthday"', $markup );
		$this->assertStringContainsString( 'value="Mum &amp; Dad"', $markup );
	}

	/**
	 * A textarea's config: a text option drawn as several lines.
	 *
	 * @param array<string, mixed> $extras Extra option fields.
	 */
	private function cache_textarea( array $extras = array() ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array_merge(
										array(
											'id'          => 'opt-a',
											'key'         => 'address',
											'type'        => 'textarea',
											'value_kind'  => 'text',
											'cardinality' => 'none',
											'label'       => 'Delivery address',
											'is_required' => true,
											'values'      => array(),
										),
										$extras
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);
	}

	/**
	 * A number option's config.
	 *
	 * @param array<string, mixed> $validation Numeric rules.
	 */
	private function cache_number( array $validation = array() ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'          => 'opt-a',
										'key'         => 'quantity',
										'type'        => 'number_field',
										'value_kind'  => 'number',
										'cardinality' => 'none',
										'label'       => 'Quantity',
										'is_required' => true,
										'values'      => array(),
										'validation'  => $validation,
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);
	}

	/**
	 * A slider or quantity option's config.
	 *
	 * @param string               $type       `range` or `quantity`.
	 * @param array<string, mixed> $validation Numeric rules.
	 */
	private function cache_numeric_type( string $type, array $validation = array() ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 7,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'          => 'opt-a',
										'key'         => 'measure',
										'type'        => $type,
										'value_kind'  => 'number',
										'cardinality' => 'none',
										'label'       => 'Size',
										'is_required' => false,
										'values'      => array(),
										'validation'  => $validation,
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-7"'
		);
	}

	/**
	 * 🔴 **A slider without a readout is a control nobody can answer precisely.**
	 *
	 * The browser shows nothing of its own, so *"how many centimetres did I
	 * choose?"* has no answer. The `<output>` is server-rendered so it is right
	 * before any script runs, and updated live as the customer drags.
	 */
	public function test_a_range_renders_a_slider_with_a_readout(): void {
		$this->cache_numeric_type(
			'range',
			array(
				'min'  => 10,
				'max'  => 50,
				'step' => 5,
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'type="range"', $markup );
		$this->assertStringContainsString( 'optionia-option--range', $markup );
		$this->assertStringContainsString( 'data-optionia="range-value"', $markup );
		$this->assertStringContainsString( 'min="10"', $markup );
		$this->assertStringContainsString( 'max="50"', $markup );
		$this->assertStringContainsString( 'step="5"', $markup );
	}

	/**
	 * The readout starts at the minimum when nothing is defaulted.
	 *
	 * A slider's thumb sits at the minimum with no value set, so a readout
	 * showing anything else would disagree with the control beside it.
	 */
	public function test_a_range_readout_starts_at_the_minimum(): void {
		$this->cache_numeric_type(
			'range',
			array(
				'min' => 10,
				'max' => 50,
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression( '/data-optionia="range-value"[^>]*>10</', $markup );
	}

	/**
	 * 🔴 **The range marker is a *separate* attribute, not a second
	 * `data-optionia` value.**
	 *
	 * The input already carries `data-optionia="value"` — the runtime's
	 * selection contract. Writing `data-optionia="range"` beside it produced
	 * **two attributes of the same name on one element**, and a browser keeps
	 * only the first: the marker was silently dropped and the readout never
	 * updated.
	 *
	 * Caught by a JavaScript test, not by reading the template.
	 */
	public function test_a_range_marks_itself_without_clobbering_the_value_role(): void {
		$this->cache_numeric_type(
			'range',
			array(
				'min' => 10,
				'max' => 50,
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'data-optionia="value"', $markup );
		$this->assertStringContainsString( 'data-optionia-range=', $markup );
		$this->assertStringNotContainsString( 'data-optionia="range"', $markup );
	}

	/**
	 * A quantity renders as a number with a step of 1 by default.
	 *
	 * ⚠️ **Where `number_field` leaves `step` unset.** A quantity of 2.5 is
	 * almost never meant; a measurement often is.
	 */
	public function test_a_quantity_steps_by_one_by_default(): void {
		$this->cache_numeric_type( 'quantity' );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'type="number"', $markup );
		$this->assertStringContainsString( 'optionia-option--quantity', $markup );
		$this->assertStringContainsString( 'step="1"', $markup );
	}

	/** An explicit step still wins: the merchant said what they meant. */
	public function test_a_quantity_honours_an_explicit_step(): void {
		$this->cache_numeric_type( 'quantity', array( 'step' => 5 ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'step="5"', $markup );
		$this->assertStringNotContainsString( 'step="1"', $markup );
	}

	/**
	 * 🔴 **`type="number"`, for the mobile keyboard.**
	 *
	 * A numeric input shows a number pad — the difference between typing a
	 * quantity easily and hunting for digits behind a symbol key.
	 */
	public function test_a_number_option_renders_a_numeric_input(): void {
		$this->cache_number();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'type="number"', $markup );
		$this->assertStringContainsString( 'optionia-option--number', $markup );
		$this->assertStringNotContainsString( 'type="text"', $markup );
	}

	/**
	 * The bounds reach the browser as `min`, `max` and `step`.
	 *
	 * ⚠️ **A courtesy, not enforcement.** `SelectionResolver` re-validates every
	 * one of these server-side (AC4); a request that skips the page is still
	 * refused. These stop a mistake early rather than deciding anything.
	 */
	public function test_a_number_option_publishes_its_bounds(): void {
		$this->cache_number(
			array(
				'min'  => 5,
				'max'  => 100,
				'step' => 5,
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'min="5"', $markup );
		$this->assertStringContainsString( 'max="100"', $markup );
		$this->assertStringContainsString( 'step="5"', $markup );
	}

	/**
	 * `integer_only` becomes `step="1"`, because HTML has no `integer`.
	 */
	public function test_integer_only_renders_as_a_step_of_one(): void {
		$this->cache_number( array( 'integer_only' => true ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'step="1"', $markup );
	}

	/** An explicit step wins over `integer_only`: the merchant meant the finer rule. */
	public function test_an_explicit_step_wins_over_integer_only(): void {
		$this->cache_number(
			array(
				'integer_only' => true,
				'step'         => 0.5,
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'step="0.5"', $markup );
		$this->assertStringNotContainsString( 'step="1"', $markup );
	}

	/** A number field carries no character counter: counting digits helps nobody. */
	public function test_a_number_option_renders_no_counter(): void {
		$this->cache_number( array( 'max' => 100 ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'data-optionia="counter"', $markup );
		$this->assertStringNotContainsString( 'maxlength', $markup );
	}

	/**
	 * 🔴 **A textarea is a `<textarea>`, not a taller text input.**
	 *
	 * The element matters beyond appearance: it is what lets a customer type a
	 * newline at all, and the resolver keeps those breaks for this type. An
	 * `<input>` here would make the multiline handling unreachable.
	 */
	public function test_a_textarea_renders_a_textarea_element(): void {
		$this->cache_textarea();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression( '/<textarea[^>]*>/', $markup );
		$this->assertStringContainsString( 'optionia-option--textarea', $markup );
		$this->assertStringContainsString( 'rows="4"', $markup );
		$this->assertStringNotContainsString( 'type="text"', $markup );
	}

	/**
	 * 🔴 **The default goes between the tags, not into a `value` attribute.**
	 *
	 * A `<textarea>` has no `value` attribute — its content is the element's
	 * text. Putting the default in an attribute would render nothing useful, and
	 * escaping it with `esc_attr` would show `&#10;` where a newline belongs.
	 * `esc_textarea` is what WordPress provides for exactly this.
	 */
	public function test_a_textarea_default_is_rendered_as_content(): void {
		$this->cache_textarea( array( 'default_value' => "12 High Street\nLondon" ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression( '/<textarea[^>]*>12 High Street\nLondon<\/textarea>/', $markup );
		$this->assertStringNotContainsString( 'value="12 High Street', $markup );
	}

	/** A textarea carries no price attribute, for the same reason a text field does not. */
	public function test_a_textarea_carries_no_price_attribute(): void {
		$this->cache_textarea();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'data-optionia-price', $markup );
	}

	/** A limit reaches the textarea and its counter, exactly as it does a text field. */
	public function test_a_textarea_honours_a_character_limit(): void {
		$this->cache_textarea(
			array(
				'validation' => array( 'max_length' => 200 ),
				'display'    => array( 'character_counter' => true ),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'maxlength="200"', $markup );
		$this->assertStringContainsString( 'data-optionia="counter"', $markup );
	}

	/**
	 * 🔴 **A limit renders a counter, and the counter is announced.**
	 *
	 * M14.4b makes `character_counter` **required** wherever `max_length` is
	 * set: *"Silently rejecting the 21st character of an engraving is a support
	 * ticket and often an abandoned cart."*
	 *
	 * Three things have to be true together, and asserting fewer would pass
	 * while the customer still met the limit only by being refused: the count is
	 * visible, `maxlength` stops the keystroke, and `aria-describedby` names the
	 * counter so a screen reader hears it too.
	 */
	public function test_a_character_limit_renders_an_announced_counter(): void {
		$this->cache_text(
			array(
				'validation' => array( 'max_length' => 20 ),
				'display'    => array( 'character_counter' => true ),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'maxlength="20"', $markup );
		$this->assertStringContainsString( 'data-optionia="counter"', $markup );
		$this->assertStringContainsString( 'aria-live="polite"', $markup );

		preg_match( '/aria-describedby="([^"]+)"/', $markup, $m );
		$this->assertNotEmpty( $m, 'The counter must be announced, not only drawn.' );
		$this->assertStringContainsString( 'optionia-count-', $m[1] );
	}

	/**
	 * The initial count is rendered server-side, and counts graphemes.
	 *
	 * A counter that starts at `0/20` beside a pre-filled default is wrong on
	 * first paint — before any script runs. `Text::measure()` produces it, so the
	 * first number the customer sees is the one the server would enforce.
	 */
	public function test_the_counter_starts_at_the_default_length(): void {
		$this->cache_text(
			array(
				'default_value' => 'Mum',
				'validation'    => array( 'max_length' => 20 ),
				'display'       => array( 'character_counter' => true ),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertMatchesRegularExpression(
			'/data-optionia="counter-used">3</',
			$markup,
			'A three-character default must render as 3, not 0.'
		);
		$this->assertMatchesRegularExpression( '/data-optionia="counter-max">20</', $markup );
	}

	/**
	 * ⚠️ **No limit, no counter — and no `maxlength` either.**
	 *
	 * A counter reading `4/` with nothing after the slash is worse than none, and
	 * a `maxlength` with no number would refuse nothing while looking as if it
	 * refused something.
	 */
	public function test_no_limit_renders_no_counter(): void {
		$this->cache_text();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'data-optionia="counter"', $markup );
		$this->assertStringNotContainsString( 'maxlength', $markup );
	}

	/**
	 * 🔴 **A limit with the counter flag off still gets `maxlength`.**
	 *
	 * The dashboard derives the flag from the limit so the two cannot disagree,
	 * but a document published by an older dashboard may carry one without the
	 * other. The limit is the merchant's rule and is honoured regardless; the
	 * counter is the affordance, and its absence must not silently drop the
	 * constraint.
	 */
	public function test_a_limit_without_the_flag_still_constrains_the_field(): void {
		$this->cache_text( array( 'validation' => array( 'max_length' => 20 ) ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'maxlength="20"', $markup );
		$this->assertStringNotContainsString( 'data-optionia="counter"', $markup );
	}

	/**
	 * A malformed limit renders neither, matching the resolver.
	 *
	 * `SelectionResolver::max_length()` treats anything that is not a positive
	 * integer as no limit, because a rule that cannot be read must not refuse
	 * every answer. The template has to agree, or the page would show a
	 * constraint the server does not enforce.
	 */
	public function test_a_malformed_limit_renders_no_constraint(): void {
		$this->cache_text( array( 'validation' => array( 'max_length' => '20' ) ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'maxlength', $markup );
		$this->assertStringNotContainsString( 'data-optionia="counter"', $markup );
	}

	/**
	 * 🔴 **A tooltip is announced, not hovered.**
	 *
	 * M29.7b is explicit: a tooltip reachable only by hover is invisible to a
	 * large group of customers. So it joins `aria-describedby` alongside the
	 * description and help text, and a `title` attribute — hover-only and
	 * inconsistently announced — is never used.
	 *
	 * ⚠️ It also lives in `display`, not on the option like the other two.
	 * Reading it from the wrong place would have meant it silently never
	 * rendered, which is exactly how `help_text` went missing across six
	 * templates until Stage 3c.
	 */
	public function test_a_tooltip_is_announced_rather_than_hovered(): void {
		$this->cache_text( array( 'display' => array( 'tooltip' => 'Cut into the lid.' ) ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'Cut into the lid.', $markup );
		$this->assertStringContainsString( 'optionia-option__tooltip', $markup );
		$this->assertStringNotContainsString( 'title="Cut into the lid."', $markup );

		preg_match( '/aria-describedby="([^"]+)"/', $markup, $m );
		$this->assertNotEmpty( $m, 'A tooltip must be announced with its control.' );
		$this->assertStringContainsString( 'optionia-tip-', $m[1] );
	}

	/**
	 * ⚠️ **`swatch_grid` is not a type — it is these two settings.**
	 *
	 * M14.3 lists it as a separate presentation, but a grid of swatches is
	 * `image_swatch` with `columns` and a size. Registering a type for it would
	 * duplicate display configuration that already exists, and give merchants
	 * two ways to describe one thing.
	 */
	public function test_a_swatch_grid_is_columns_and_a_size(): void {
		$this->cache_typed(
			'image_swatch',
			array( 'image_url' => 'https://optionia.local/a.png' )
		);

		$markup = $this->render_for( 20, 'simple' );

		// Defaults when the merchant configures nothing.
		$this->assertStringContainsString( 'optionia-option--cols-1', $markup );
		$this->assertStringContainsString( 'optionia-option--swatch-medium', $markup );
	}

	/**
	 * A malformed display setting falls back rather than reaching a class.
	 *
	 * `columns: 99` must not produce a grid nobody can read, and a
	 * `swatch_size` of `"enormous"` must not reach an attribute — the same
	 * stance every malformed rule in the resolver takes.
	 */
	public function test_malformed_display_config_falls_back(): void {
		$this->cache_text(
			array(
				'display' => array(
					'columns'     => 99,
					'swatch_size' => 'enormous',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'optionia-option--cols-1', $markup );
		$this->assertStringNotContainsString( 'cols-99', $markup );
		$this->assertStringNotContainsString( 'enormous', $markup );
	}

	/** A collapsed section is marked so a theme can fold it. */
	public function test_a_collapsed_option_is_marked(): void {
		$this->cache_text( array( 'display' => array( 'collapsed_by_default' => true ) ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'optionia-option--collapsed', $markup );
	}

	/**
	 * 🔴 **`help_text` is published by the API and used to render nowhere.**
	 *
	 * A distinct column from `description` — the API publishes both on every
	 * option — and all six templates associated only the first. M14.4b requires
	 * it (*"`help_text` and `tooltip` must be associated via
	 * `aria-describedby`"*) and M29.7b makes that accessibility: guidance a
	 * screen reader never announces is guidance that does not exist for the
	 * customers most likely to need it.
	 *
	 * Both ids must appear in the attribute, space-separated. Asserting the text
	 * alone would pass while the association was still missing, which is the
	 * failure this test is for.
	 */
	public function test_help_text_is_rendered_and_associated(): void {
		$this->cache_text(
			array(
				'description' => 'Cut into the lid.',
				'help_text'   => 'Max 20 characters.',
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'Max 20 characters.', $markup, 'help_text must reach the page.' );
		$this->assertStringContainsString( 'Cut into the lid.', $markup );

		preg_match( '/aria-describedby="([^"]+)"/', $markup, $m );
		$this->assertNotEmpty( $m, 'The control must point at its guidance.' );

		$ids = preg_split( '/\s+/', trim( $m[1] ) );
		$this->assertCount( 2, $ids, 'Both a description and help text must be announced, not just the first.' );

		foreach ( $ids as $id ) {
			$this->assertStringContainsString( 'id="' . $id . '"', $markup, "describedby names {$id}, which must exist." );
		}
	}

	/**
	 * With help text only, the attribute names exactly one id.
	 *
	 * The pairing matters as much as the presence: an option with one guidance
	 * block must not emit a dangling id for the block it does not have.
	 */
	public function test_help_text_alone_is_associated(): void {
		$this->cache_text( array( 'help_text' => 'Capitals only.' ) );

		$markup = $this->render_for( 20, 'simple' );

		preg_match( '/aria-describedby="([^"]+)"/', $markup, $m );
		$this->assertNotEmpty( $m );
		$this->assertCount( 1, preg_split( '/\s+/', trim( $m[1] ) ) );
		$this->assertStringContainsString( 'id="' . $m[1] . '"', $markup );
		$this->assertStringContainsString( 'Capitals only.', $markup );
	}

	/**
	 * With neither, the attribute is absent rather than empty.
	 *
	 * `aria-describedby=""` points at no element, and a screen reader treating it
	 * as a description of nothing is worse than the attribute not being there.
	 */
	public function test_no_guidance_emits_no_describedby(): void {
		$this->cache_text();

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'aria-describedby', $markup );
	}

	/**
	 * Every choice type renders its values and binds each input to a label.
	 *
	 * 🔴 **Written before the templates, not after.** `dropdown` shipped with no
	 * template test and needed one added in an audit; these three are covered as
	 * they land. The shared assertions live here so a fourth type gets them by
	 * adding one row.
	 *
	 * @param string $type  Presentation under test.
	 * @param string $class The wrapper class it must carry.
	 */
	public function test_choice_types_render_their_values(): void {
		foreach (
			array(
				'checkbox'     => 'optionia-option--checkbox',
				'color_swatch' => 'optionia-option--color-swatch',
				'image_swatch' => 'optionia-option--image-swatch',
			) as $type => $class
		) {
			$this->cache_typed( $type );

			$markup = $this->render_for( 20, 'simple' );

			$this->assertStringContainsString( $class, $markup, $type . ' must carry its wrapper class.' );
			$this->assertStringContainsString( 'value="lux"', $markup, $type . ' must render its values.' );
			$this->assertStringContainsString( 'value="std"', $markup, $type . ' must render every value.' );

			$this->assertSame(
				1,
				preg_match( '/for="([^"]+)"/', $markup, $for ),
				$type . ' must bind a label to an input.'
			);

			$this->assertStringContainsString( 'id="' . $for[1] . '"', $markup );
		}
	}

	/**
	 * 🔴 **A checkbox at `cardinality: one` submits a scalar.**
	 *
	 * Every input shares one `name` with no `[]` suffix, because
	 * `Engine\SelectionResolver` answers `ERROR_NOT_SCALAR` for an array at
	 * this cardinality — a `name="…[]"` here would post something the resolver
	 * refuses at add-to-cart, after the merchant had already published it.
	 *
	 * ⚠️ **M18.1 added the array path, and it did NOT change this case.**
	 * `checkbox.php` branches on `cardinality`, and `one` is still the default
	 * and still the only shape this build sells — see the fence below.
	 */
	public function test_a_checkbox_group_posts_a_scalar(): void {
		$this->cache_typed( 'checkbox' );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'type="checkbox"', $markup );
		$this->assertStringNotContainsString( '[]"', $markup, 'A [ONE] checkbox must not post an array.' );
	}

	/**
	 * 🔴 **A `many` checkbox renders, and its inputs post an array.**
	 *
	 * ⚠️ **This asserted the opposite until M18.3.** ADR-060 had the renderer
	 * skip a multi-select while the cart could not carry one, on the same
	 * reasoning the unknown-type case uses: a control a customer can fill in and
	 * the server will refuse is worse than no control. The cart carries one now.
	 *
	 * 🔴 **The `[]` suffix is the whole point.** Without it every box shares one
	 * field name and PHP keeps only the last — a customer ticking two boxes is
	 * charged for one, with nothing failing. Measured before M18.1.
	 */
	public function test_a_multi_select_option_renders_array_inputs(): void {
		$this->cache_typed( 'checkbox', array(), array( 'cardinality' => 'many' ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'type="checkbox"', $markup );
		$this->assertStringContainsString( 'value="lux"', $markup );
		$this->assertStringContainsString( '[]"', $markup, 'A [MANY] checkbox must post an array.' );
	}

	/**
	 * ⚠️ The control: a single-value checkbox posts a scalar, not an array.
	 *
	 * The two cardinalities must produce different markup, or the `[]` suffix
	 * above proves nothing.
	 */
	public function test_a_single_value_checkbox_still_renders(): void {
		$this->cache_typed( 'checkbox', array(), array( 'cardinality' => 'one' ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'type="checkbox"', $markup );
		$this->assertStringContainsString( 'value="lux"', $markup );
	}

	/** A colour swatch paints a valid hex and keeps the label beside it. */
	public function test_a_colour_swatch_paints_a_valid_hex(): void {
		$this->cache_typed( 'color_swatch', array( 'color_hex' => '#ff0000' ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'background-color: #ff0000', $markup );
		$this->assertStringContainsString( 'aria-hidden="true"', $markup );

		/* Colour is never the only signal — the label always renders. */
		$this->assertStringContainsString( 'Luxury', $markup );
	}

	/**
	 * 🔴 **And refuses anything that is not a hex triple.**
	 *
	 * The colour reaches a `style` attribute, where `esc_attr` alone would
	 * happily emit `red; background-image:url(...)` as a value. A merchant's
	 * stored colour is input, and a pattern match refuses it rather than trusting
	 * the escape to mean more than it does.
	 */
	public function test_a_colour_swatch_refuses_a_malformed_colour(): void {
		$this->cache_typed( 'color_swatch', array( 'color_hex' => 'red; background-image:url(x)' ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'background-image', $markup );
		$this->assertStringNotContainsString( 'optionia-value__swatch', $markup );

		/* The choice still renders — a bad colour loses its chip, not its option. */
		$this->assertStringContainsString( 'value="lux"', $markup );
	}

	/** An image swatch renders a thumbnail with an empty alt and lazy loading. */
	public function test_an_image_swatch_renders_a_thumbnail(): void {
		$this->cache_typed( 'image_swatch', array( 'image_url' => 'https://example.test/lux.png' ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( 'https://example.test/lux.png', $markup );
		$this->assertStringContainsString( 'alt=""', $markup );
		$this->assertStringContainsString( 'loading="lazy"', $markup );
		$this->assertStringContainsString( 'Luxury', $markup );
	}

	/**
	 * 🔴 **A `javascript:` URL never reaches `src`.**
	 *
	 * `esc_url` strips non-http schemes, and an empty result means no image is
	 * drawn at all. Asserted because a merchant-supplied URL landing in `src` is
	 * the one place this template touches a script-execution boundary.
	 */
	public function test_an_image_swatch_refuses_a_dangerous_url(): void {
		$this->cache_typed( 'image_swatch', array( 'image_url' => 'javascript:alert(1)' ) );

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'javascript:', $markup );
		$this->assertStringNotContainsString( '<img', $markup );
		$this->assertStringContainsString( 'value="lux"', $markup );
	}

	/**
	 * Cache a document whose group holds both options and presentational items.
	 *
	 * `sort_order` deliberately interleaves them: the heading at 10 sits above
	 * the option at 20, and the divider at 30 below it. Concatenating the two
	 * lists in either order would fail this.
	 *
	 * @param array<int, array<string, mixed>> $items   Presentational items.
	 * @param int                              $opt_sort Where the option sits.
	 */
	private function cache_with_items( array $items, int $opt_sort = 20 ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 8,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'         => 'opt-a',
										'key'        => 'placement',
										'type'       => 'radio',
										'label'      => 'Print placement',
										'sort_order' => $opt_sort,
										'values'     => array(
											array(
												'value_key' => 'front',
												'label' => 'Front',
												'is_default' => true,
											),
										),
									),
								),
								'items'   => $items,
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-8"'
		);
	}

	/**
	 * 🔴 **Items and options interleave by `sort_order`.**
	 *
	 * The whole point of a heading is to sit above the right control. W2 left
	 * the plugin with no reader for `items` at all; this asserts the ordering
	 * the merchant authored survives to the page, rather than all headings
	 * collecting at one end.
	 */
	public function test_items_and_options_render_in_the_merchants_order(): void {
		$this->cache_with_items(
			array(
				array(
					'kind'       => 'heading',
					'content'    => 'Personalise',
					'sort_order' => 10,
				),
				array(
					'kind'       => 'divider',
					'content'    => '',
					'sort_order' => 30,
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$heading = strpos( $markup, 'Personalise' );
		$option  = strpos( $markup, 'Print placement' );
		$divider = strpos( $markup, 'optionia-item--divider' );

		$this->assertNotFalse( $heading );
		$this->assertNotFalse( $option );
		$this->assertNotFalse( $divider );
		$this->assertLessThan( $option, $heading, 'The heading must render above the option.' );
		$this->assertLessThan( $divider, $option, 'The divider must render below the option.' );
	}

	/**
	 * An item ordered after the option renders after it.
	 *
	 * The mirror of the test above: without it, a renderer that always drew
	 * items first would pass that one by accident.
	 */
	public function test_an_item_ordered_last_renders_last(): void {
		$this->cache_with_items(
			array(
				array(
					'kind'       => 'heading',
					'content'    => 'Afterword',
					'sort_order' => 99,
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertGreaterThan( strpos( $markup, 'Print placement' ), strpos( $markup, 'Afterword' ) );
	}

	/**
	 * 🔴 **A paragraph's content is escaped, never rendered as markup.**
	 *
	 * `paragraph` is the safe kind by definition. M5.4c puts markup behind
	 * `rich_text`, which is sanitizer-gated; letting tags through here would
	 * quietly make this the unsanitised path onto a public storefront.
	 */
	public function test_a_paragraph_escapes_merchant_markup(): void {
		$this->cache_with_items(
			array(
				array(
					'kind'       => 'paragraph',
					'content'    => '<script>alert(1)</script>',
					'sort_order' => 10,
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( '<script>', $markup );
		$this->assertStringContainsString( '&lt;script&gt;', $markup );
	}

	/**
	 * 🔴 **`rich_text` has no template, so it renders nothing.**
	 *
	 * The authoring API refuses the kind today, so a document carrying one came
	 * from a future build. Having no template is the correct outcome, not a gap:
	 * rendering merchant-authored markup without the sanitizer M5.4c requires is
	 * the one mistake this feature must not make. If a `rich_text.php` is ever
	 * added, this test must fail loudly and be replaced by sanitizer tests.
	 */
	public function test_rich_text_renders_nothing_without_its_sanitizer(): void {
		$this->cache_with_items(
			array(
				array(
					'kind'       => 'rich_text',
					'content'    => '<img src=x onerror=alert(1)>',
					'sort_order' => 10,
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( 'onerror', $markup );
		$this->assertStringNotContainsString( '<img', $markup );
		// The rest of the group still renders: one unknown kind is not fatal.
		$this->assertStringContainsString( 'Print placement', $markup );
	}

	/**
	 * A group holding only items still renders.
	 *
	 * The renderer used to drop any group with no options. A merchant who wrote
	 * a group of pure explanatory copy would have seen nothing, with no error.
	 */
	public function test_a_group_of_only_items_still_renders(): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 9,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Notes',
								'options' => array(),
								'items'   => array(
									array(
										'kind'       => 'paragraph',
										'content'    => 'Ships in 3 days.',
										'sort_order' => 10,
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-9"'
		);

		$this->assertStringContainsString( 'Ships in 3 days.', $this->render_for( 20, 'simple' ) );
	}

	/**
	 * An item with no `sort_order` sorts to the end, not the front.
	 *
	 * Defaulting a missing order to `0` would hoist malformed or older entries
	 * above everything the merchant did order.
	 */
	public function test_an_item_without_a_sort_order_renders_last(): void {
		$this->cache_with_items(
			array(
				array(
					'kind'    => 'heading',
					'content' => 'Unordered',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertGreaterThan( strpos( $markup, 'Print placement' ), strpos( $markup, 'Unordered' ) );
	}

	/**
	 * Cache a dropdown whose values carry `group_label`.
	 *
	 * @param array<int, array<string, mixed>> $values Values, in document order.
	 */
	private function cache_grouped_dropdown( array $values ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 11,
				'option_sets'    => array(
					array(
						'id'          => 'set-a',
						'assignments' => array(
							array(
								'mode'        => 'manual',
								'target_type' => 'product',
								'target_ref'  => '20',
								'priority'    => 0,
							),
						),
						'groups'      => array(
							array(
								'id'      => 'group-a',
								'label'   => 'Customization',
								'options' => array(
									array(
										'id'     => 'opt-d',
										'key'    => 'size',
										'type'   => 'dropdown',
										'label'  => 'Size',
										'values' => $values,
									),
								),
							),
						),
						'rules'       => array(),
					),
				),
			),
			'W/"store-11"'
		);
	}

	/**
	 * Values sharing a label render inside one `<optgroup>`.
	 *
	 * M14.3's last entry, built as a rendering detail of `dropdown` rather than a
	 * second type: same axes, same values, same pricing, different drawing.
	 */
	public function test_a_dropdown_groups_values_sharing_a_label(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key'   => 's',
					'label'       => 'Small',
					'group_label' => 'Standard',
				),
				array(
					'value_key'   => 'm',
					'label'       => 'Medium',
					'group_label' => 'Standard',
				),
				array(
					'value_key'   => 'xl',
					'label'       => 'Extra large',
					'group_label' => 'Plus',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringContainsString( '<optgroup label="Standard">', $markup );
		$this->assertStringContainsString( '<optgroup label="Plus">', $markup );
		$this->assertSame( 2, substr_count( $markup, '<optgroup' ) );
		$this->assertSame( 2, substr_count( $markup, '</optgroup>' ) );
	}

	/**
	 * A value with no `group_label` renders as a plain `<option>`.
	 *
	 * The normal case, and the one that must not regress: every dropdown that
	 * existed before grouping has no labels at all.
	 */
	public function test_an_ungrouped_dropdown_renders_no_optgroup(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key' => 's',
					'label'     => 'Small',
				),
				array(
					'value_key' => 'm',
					'label'     => 'Medium',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( '<optgroup', $markup );
		$this->assertStringContainsString( 'value="s"', $markup );
		$this->assertStringContainsString( 'value="m"', $markup );
	}

	/**
	 * A group open at the end of the list is closed.
	 *
	 * 🔴 Without the close after the loop the `<select>` would contain an
	 * unterminated `<optgroup>` — which browsers repair silently, so it would
	 * never look broken while still being invalid markup.
	 */
	public function test_a_trailing_group_is_closed(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key' => 'a',
					'label'     => 'Plain',
				),
				array(
					'value_key'   => 'b',
					'label'       => 'Grouped',
					'group_label' => 'Last',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertSame(
			substr_count( $markup, '<optgroup' ),
			substr_count( $markup, '</optgroup>' )
		);
		$this->assertStringContainsString( '</optgroup>', $markup );
	}

	/**
	 * Ungrouped values between two groups end the first one.
	 *
	 * `<optgroup>` cannot nest, so a value with no label must close whatever is
	 * open rather than fall inside it.
	 */
	public function test_an_ungrouped_value_closes_the_open_group(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key'   => 'a',
					'label'       => 'A',
					'group_label' => 'First',
				),
				array(
					'value_key' => 'b',
					'label'     => 'B',
				),
				array(
					'value_key'   => 'c',
					'label'       => 'C',
					'group_label' => 'Second',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		// The plain option must sit outside both groups.
		$this->assertMatchesRegularExpression(
			'~</optgroup>.*value="b".*<optgroup~s',
			$markup
		);
	}

	/**
	 * ⚠️ **Two runs of the same label render as two groups, deliberately.**
	 *
	 * The merchant's `sort_order` is authoritative. Regrouping non-contiguous
	 * values would move values they deliberately placed — and `<optgroup>` cannot
	 * nest or resume, so there is nowhere to put the second run anyway.
	 */
	public function test_a_repeated_label_after_a_gap_opens_a_second_group(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key'   => 'a',
					'label'       => 'A',
					'group_label' => 'Sizes',
				),
				array(
					'value_key'   => 'b',
					'label'       => 'B',
					'group_label' => 'Other',
				),
				array(
					'value_key'   => 'c',
					'label'       => 'C',
					'group_label' => 'Sizes',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertSame( 3, substr_count( $markup, '<optgroup' ) );
		$this->assertSame( 2, substr_count( $markup, '<optgroup label="Sizes">' ) );
	}

	/**
	 * A blank label is treated as no group.
	 *
	 * An empty `<optgroup label="">` renders as an unlabelled indent in every
	 * browser, which reads as a rendering fault rather than a merchant's choice.
	 */
	public function test_a_whitespace_group_label_renders_no_optgroup(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key'   => 'a',
					'label'       => 'A',
					'group_label' => '   ',
				),
			)
		);

		$this->assertStringNotContainsString( '<optgroup', $this->render_for( 20, 'simple' ) );
	}

	/**
	 * 🔴 A group label reaches an attribute, so it must be escaped.
	 *
	 * Merchant-authored text in `label="..."` is the one place this template
	 * touches an attribute boundary with grouping.
	 */
	public function test_a_group_label_is_escaped(): void {
		$this->cache_grouped_dropdown(
			array(
				array(
					'value_key'   => 'a',
					'label'       => 'A',
					'group_label' => '"><script>alert(1)</script>',
				),
			)
		);

		$markup = $this->render_for( 20, 'simple' );

		$this->assertStringNotContainsString( '<script>', $markup );
		$this->assertStringContainsString( '&lt;script&gt;', $markup );
	}
}
