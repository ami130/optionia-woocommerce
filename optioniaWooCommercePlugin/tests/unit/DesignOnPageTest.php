<?php
/**
 * The storefront carries a value's artwork onto the page (M26e.1, stage A).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Config\Repository;
use Optionia\Frontend\Assets;
use Optionia\Frontend\OptionView;
use Optionia\Frontend\Renderer;
use Optionia\Frontend\Templates;
use Optionia\Support\Logger;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;

// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- `$product` is WooCommerce's global, which the storefront renderer reads.

/**
 * A design on a published value reaches the rendered markup.
 *
 * 🔴 **The document has carried `design` since M26d.4 and no template read
 * it.** `check-option-type-parity.sh` reported *0 of 4 design carrier(s)*: the
 * artwork arrived on every page and nothing looked at it, so a customer could
 * not tell a designed swatch from a plain one. That is the gap this closes.
 *
 * ⚠️ **Carried as data, not fetched.** AC3 forbids a network call during a
 * page render, and a swatch grid is clicked far more often than it is loaded —
 * so the design travels with the markup and the runtime draws it without a
 * round trip.
 *
 * @covers \Optionia\Frontend\OptionView
 */
final class DesignOnPageTest extends TestCase {

	/** Artwork a merchant composed in the Design Lab. */
	private const DESIGN = array(
		'layers' => array(
			array(
				'name'    => 'crest',
				'src'     => 'https://cdn.example/crest.png',
				'natW'    => 400,
				'natH'    => 400,
				'pos'     => array(
					'xPct' => 0.5,
					'yPct' => 0.4,
					'wPct' => 0.6,
					'hPct' => 0.6,
				),
				'rot'     => 0,
				'style'   => array(),
				'visible' => true,
			),
		),
	);

	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_product'] = null;
	}

	/**
	 * Cache a document with one design-carrying swatch on product 20.
	 *
	 * @param string $presentation Which carrying type to publish.
	 */
	private function cache( string $presentation ): void {
		( new Repository( new Logger( new Settings() ) ) )->store(
			array(
				'schema_version' => 1,
				'config_version' => 9,
				'option_sets'    => array(
					array(
						'id'          => 'set-d',
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
								'id'      => 'grp-d',
								'label'   => 'Artwork',
								'options' => array(
									array(
										'id'          => 'opt-d',
										'key'         => 'engraving',
										'label'       => 'Engraving',

										/*
										 * ⚠️ **`type`, which is what the plugin
										 * reads.** The published document names
										 * a presentation `type`; a fixture using
										 * `presentation` rendered NOTHING, and
										 * the test failed on an empty page
										 * rather than on a missing attribute.
										 */
										'type'        => $presentation,
										'is_required' => false,
										'values'      => array(
											array(
												'id'    => 'val-plain',
												'value_key' => 'plain',
												'label' => 'Plain',
												'color_hex' => '#ffffff',
												'image_url' => 'https://cdn.example/plain.png',
											),
											array(
												'id'     => 'val-crest',
												'value_key' => 'crest',
												'label'  => 'Crest',
												'color_hex' => '#1d4ed8',
												'image_url' => 'https://cdn.example/crest.png',
												'design' => self::DESIGN,
											),
										),
									),
								),
							),
						),
					),
				),
			),
			'etag-d'
		);
	}

	/** Render the storefront for product 20. */
	private function markup(): string {
		$GLOBALS['product'] = optionia_test_product( 20, 'simple' );
		$logger             = new Logger( new Settings() );

		ob_start();
		( new Renderer( new Repository( $logger ), new Templates( $logger ), new Assets(), $logger ) )->render();

		return (string) ob_get_clean();
	}

	/**
	 * A designed value emits its artwork as data.
	 *
	 * @dataProvider carrying_swatches
	 *
	 * @param string $presentation A DesignCarrier.VALUE type.
	 */
	public function test_a_designed_value_carries_its_artwork( string $presentation ): void {
		$this->cache( $presentation );

		$markup = $this->markup();

		$this->assertStringContainsString( 'data-optionia-design=', $markup );
		$this->assertStringContainsString( 'crest.png', $markup );
	}

	/**
	 * ⚠️ **An undesigned value emits NO attribute**, rather than an empty one.
	 * The runtime would otherwise have to tell `data-optionia-design=""` from a
	 * real but empty design, and every plain swatch would carry dead weight.
	 *
	 * @dataProvider carrying_swatches
	 *
	 * @param string $presentation A DesignCarrier.VALUE type.
	 */
	public function test_an_undesigned_value_carries_nothing( string $presentation ): void {
		$this->cache( $presentation );

		$markup = $this->markup();

		$this->assertStringNotContainsString( 'data-optionia-design=""', $markup );
		$this->assertSame( 1, substr_count( $markup, 'data-optionia-design=' ) );
	}

	/**
	 * The DesignCarrier.VALUE presentations.
	 *
	 * @return array<string, string[]>
	 */
	public static function carrying_swatches(): array {
		return array(
			'colour swatch' => array( 'color_swatch' ),
			'image swatch'  => array( 'image_swatch' ),
		);
	}

	/**
	 * 🔴 **A `<` inside merchant JSON must not end the attribute early.**
	 * `esc_attr` escapes quotes and ampersands; the `JSON_HEX_*` flags close
	 * the remaining hole, so a design naming a layer `<script>` cannot break
	 * out of the attribute when a lenient parser reads it.
	 */
	public function test_markup_in_a_design_cannot_escape_the_attribute(): void {
		$attr = OptionView::design_attr(
			array( 'design' => array( 'layers' => array( array( 'name' => '</div><script>x' ) ) ) )
		);

		$this->assertStringNotContainsString( '<', $attr );
		$this->assertStringNotContainsString( '>', $attr );
	}

	/** Nothing to draw means no attribute at all. */
	public function test_an_empty_design_yields_no_attribute(): void {
		$this->assertSame( '', OptionView::design_attr( array( 'design' => array() ) ) );
		$this->assertSame( '', OptionView::design_attr( array() ) );
	}
}
