<?php
/**
 * Composing a render scene from what a customer chose (M26e.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SceneComposer;
use PHPUnit\Framework\TestCase;

/**
 * `Engine\SceneComposer` turns selections into a scene, and nothing into null.
 *
 * @covers \Optionia\Engine\SceneComposer
 */
final class SceneComposerTest extends TestCase {

	/**
	 * One published set with a designed option.
	 *
	 * @param array<string, mixed> $value_overrides Extra keys on the designed value.
	 *
	 * @return array<int, mixed>
	 */
	private function sets( array $value_overrides = array() ): array {
		return array(
			array(
				'id'     => 'set1',
				'groups' => array(
					array(
						'options' => array(
							array(
								'id'     => 'opt1',
								'values' => array(
									array(
										'value_key' => 'none',
										'label'     => 'None',
									),
									array_merge(
										array(
											'value_key' => 'crest',
											'label'     => 'Crest',
											'design'    => array(
												'layers' => array(
													array(
														'id'   => 'l1',
														'kind' => 'image',
													),
												),
											),
										),
										$value_overrides
									),
								),
							),
						),
					),
				),
			),
		);
	}

	public function test_a_chosen_design_becomes_a_visible_group(): void {
		$scene = SceneComposer::compose( $this->sets(), array( 'opt1' => 'crest' ), 800, 600 );

		$this->assertNotNull( $scene );
		$this->assertSame( 800, $scene['width'] );
		$this->assertSame( 600, $scene['height'] );
		$this->assertCount( 1, $scene['groups'] );
		$this->assertTrue( $scene['groups'][0]['visible'] );
		$this->assertSame( 'opt1:crest', $scene['groups'][0]['key'] );
	}

	/**
	 * 🔴 **The layers are copied through untouched.** M26e.1's rule is that no
	 * geometry is computed in PHP; `shared/design/` resolves them, and it does
	 * so for the preview and the print file alike. Transforming them here is
	 * how those two pictures drift apart.
	 */
	public function test_it_copies_the_layers_without_touching_them(): void {
		$scene = SceneComposer::compose( $this->sets(), array( 'opt1' => 'crest' ), 800, 600 );

		$this->assertSame(
			array(
				array(
					'id'   => 'l1',
					'kind' => 'image',
				),
			),
			$scene['groups'][0]['layers']
		);
	}

	/**
	 * ⚠️ **"Nothing to draw" and "draw nothing" are different answers.** A line
	 * with no artwork must produce no render request: the cloud would accept
	 * one, the worker would rasterise a blank canvas, and a merchant would be
	 * handed an empty print file for an ordinary product.
	 */
	public function test_a_line_with_no_designs_composes_nothing(): void {
		$sets = array(
			array(
				'groups' => array(
					array(
						'options' => array(
							array(
								'id'     => 'opt1',
								'values' => array( array( 'value_key' => 'a' ) ),
							),
						),
					),
				),
			),
		);

		$this->assertNull( SceneComposer::compose( $sets, array( 'opt1' => 'a' ), 800, 600 ) );
	}

	/**
	 * 🔴 **Picking the undesigned choice of a designed option is an ordinary
	 * purchase.** "No engraving" on an engravable mug composes every group as
	 * hidden, which draws nothing — so there is nothing to render.
	 */
	public function test_choosing_an_undesigned_value_composes_nothing(): void {
		$this->assertNull(
			SceneComposer::compose( $this->sets(), array( 'opt1' => 'none' ), 800, 600 )
		);
	}

	public function test_an_unselected_option_is_ignored(): void {
		$this->assertNull( SceneComposer::compose( $this->sets(), array(), 800, 600 ) );
	}

	/**
	 * ⚠️ **`design: {}` is not a design.** It reaches here from a value whose
	 * artwork was cleared, and treating it as present emits a group with no
	 * layers — a render of nothing, charged as a render.
	 */
	public function test_an_empty_design_is_not_a_design(): void {
		$sets = $this->sets( array( 'design' => array() ) );

		$this->assertNull( SceneComposer::compose( $sets, array( 'opt1' => 'crest' ), 800, 600 ) );
	}

	/**
	 * ⚠️ **The emptiness check must DECIDE, not be shadowed.** The assertion
	 * above passed with that check removed: an empty design yields empty
	 * layers, so the all-hidden guard rejected the scene anyway and the test
	 * proved nothing about emptiness. Here a second value IS designed and
	 * chosen, so the scene survives — and the cleared value must not appear in
	 * it as a group with nothing to draw.
	 */
	public function test_an_empty_design_contributes_no_group(): void {
		$sets = $this->sets( array( 'design' => array() ) );

		$sets[0]['groups'][0]['options'][0]['values'][] = array(
			'value_key' => 'star',
			'design'    => array( 'layers' => array( array( 'id' => 'l2' ) ) ),
		);

		$scene = SceneComposer::compose( $sets, array( 'opt1' => 'star' ), 800, 600 );

		$this->assertNotNull( $scene );
		$this->assertSame( array( 'opt1:star' ), array_column( $scene['groups'], 'key' ) );
	}

	/**
	 * 📌 **Every designed value becomes a group; only the chosen is visible.**
	 * This is what lets a storefront overlay toggle on a click without
	 * re-fetching the scene, and the print path takes the same scene so what is
	 * rasterised is what was previewed.
	 */
	public function test_unchosen_designs_are_present_but_hidden(): void {
		$sets = $this->sets();

		$sets[0]['groups'][0]['options'][0]['values'][] = array(
			'value_key' => 'star',
			'design'    => array( 'layers' => array( array( 'id' => 'l2' ) ) ),
		);

		$scene = SceneComposer::compose( $sets, array( 'opt1' => 'crest' ), 800, 600 );

		$this->assertCount( 2, $scene['groups'] );

		$visible = array_column( $scene['groups'], 'visible', 'key' );

		$this->assertTrue( $visible['opt1:crest'] );
		$this->assertFalse( $visible['opt1:star'] );
	}

	/** A multi-select sends every chosen key, and each designed one draws. */
	public function test_a_multi_select_shows_every_chosen_design(): void {
		$sets = $this->sets();

		$sets[0]['groups'][0]['options'][0]['values'][] = array(
			'value_key' => 'star',
			'design'    => array( 'layers' => array( array( 'id' => 'l2' ) ) ),
		);

		$scene = SceneComposer::compose(
			$sets,
			array( 'opt1' => array( 'crest', 'star' ) ),
			800,
			600
		);

		$visible = array_column( $scene['groups'], 'visible', 'key' );

		$this->assertTrue( $visible['opt1:crest'] );
		$this->assertTrue( $visible['opt1:star'] );
	}

	/**
	 * 🔴 **A text option carries ONE design and the customer's typing replaces
	 * its sample text.** The selection is the text itself, not a value key.
	 */
	public function test_a_text_option_carries_what_the_customer_typed(): void {
		$sets = array(
			array(
				'groups' => array(
					array(
						'options' => array(
							array(
								'id'     => 'opt2',
								'design' => array(
									'layers'     => array(),
									'fontFamily' => 'Inter',
								),
								'values' => array(),
							),
						),
					),
				),
			),
		);

		$scene = SceneComposer::compose( $sets, array( 'opt2' => 'Hello' ), 800, 600 );

		$this->assertNotNull( $scene );
		$this->assertSame( 'opt2', $scene['textOptions'][0]['key'] );
		$this->assertSame( 'Hello', $scene['textOptions'][0]['value'] );
	}

	/**
	 * 📌 **Decision 5: the canvas a design was composed on travels with it**, so
	 * the cloud letterboxes a square design on a tall product rather than
	 * stretching it down the page.
	 */
	public function test_it_carries_the_authoring_canvas(): void {
		$sets = $this->sets(
			array(
				'design' => array(
					'layers'    => array( array( 'id' => 'l1' ) ),
					'authoring' => array(
						'width'  => 500,
						'height' => 500,
					),
				),
			)
		);

		$scene = SceneComposer::compose( $sets, array( 'opt1' => 'crest' ), 800, 600 );

		$this->assertSame(
			array(
				'width'  => 500,
				'height' => 500,
			),
			$scene['authoring']
		);
	}

	/** A design with no recorded canvas omits the key, as buildScene expects. */
	public function test_it_omits_authoring_when_the_design_records_none(): void {
		$scene = SceneComposer::compose( $this->sets(), array( 'opt1' => 'crest' ), 800, 600 );

		$this->assertArrayNotHasKey( 'authoring', $scene );
	}

	/**
	 * A canvas with no area composes nothing.
	 *
	 * @dataProvider degenerate_canvases
	 *
	 * @param int $width  Canvas width.
	 * @param int $height Canvas height.
	 */
	public function test_it_refuses_a_degenerate_canvas( int $width, int $height ): void {
		$this->assertNull(
			SceneComposer::compose( $this->sets(), array( 'opt1' => 'crest' ), $width, $height )
		);
	}

	/**
	 * Canvases that cannot hold a scene.
	 *
	 * @return array<string, array{int, int}>
	 */
	public static function degenerate_canvases(): array {
		return array(
			'zero width'     => array( 0, 600 ),
			'zero height'    => array( 800, 0 ),
			'negative width' => array( -800, 600 ),
		);
	}
}
