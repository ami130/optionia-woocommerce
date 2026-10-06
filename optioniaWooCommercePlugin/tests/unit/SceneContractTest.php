<?php
/**
 * The scene shape the cloud's renderer consumes (M26e.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SceneComposer;
use PHPUnit\Framework\TestCase;

/**
 * `Engine\SceneComposer` still produces what `buildScene()` consumes.
 *
 * 🔴 **This contract lived in two languages with no mechanical link, and it
 * broke.** The plugin composes `groups` of `layers` in FRACTIONS plus
 * `textOptions`; `buildScene()` in `shared/design/` resolves that to the
 * `images`/`texts` the serializer draws. Both the render worker and
 * `POST /store/preview` skipped that resolution step, so every real designed
 * order threw and dead-lettered — while 1,333 backend e2e tests passed,
 * because every fixture had been written in the RESOLVED shape.
 *
 * ⚠️ **A fixture that cannot represent what production sends cannot test
 * production.** `scene-contract.json` is captured from this composer by
 * running it, and the backend asserts the same bytes render. A field renamed
 * on either side now fails here rather than in a merchant's order.
 *
 * @covers \Optionia\Engine\SceneComposer
 */
final class SceneContractTest extends TestCase {

	/**
	 * The shared fixture, byte-identical in three repositories.
	 *
	 * @return array<string, mixed>
	 */
	private function fixture(): array {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- reading a local fixture, not a remote URL.
		$raw = file_get_contents( __DIR__ . '/../fixtures/shared/scene-contract.json' );

		$this->assertIsString( $raw, 'the shared scene fixture is unreadable' );

		$decoded = json_decode( (string) $raw, true );

		$this->assertIsArray( $decoded, 'the shared scene fixture is not valid JSON' );

		return $decoded;
	}

	/** The published config the fixture was captured from. */
	private function sets(): array {
		return array(
			array(
				'id'     => 'set1',
				'groups' => array(
					array(
						'options' => array(
							array(
								'id'           => 'opt-badge',
								'presentation' => 'image_swatch',
								'values'       => array(
									array(
										'value_key' => 'none',
										'label'     => 'None',
									),
									array(
										'value_key' => 'crest',
										'label'     => 'Crest',
										'design'    => array(
											'layers'    => array(
												array(
													'name' => 'crest',
													'src'  => 'https://cdn.example/crest.png',
													'natW' => 400,
													'natH' => 400,
													'pos'  => array(
														'xPct' => 0.5,
														'yPct' => 0.4,
														'wPct' => 0.6,
														'hPct' => 0.6,
													),
													'rot'  => 0,
													'style' => array(),
													'visible' => true,
												),
											),
											'authoring' => array(
												'width'  => 400,
												'height' => 400,
											),
										),
									),
								),
							),
							array(
								'id'           => 'opt-engraving',
								'presentation' => 'text_field',
								'design'       => array(
									'text'    => 'Your text',
									'font'    => 'Inter',
									'sizePct' => 0.08,
									'bold'    => false,
									'italic'  => false,
									'align'   => 'center',
									'color'   => '#111111',
									'pos'     => array(
										'xPct' => 0.5,
										'yPct' => 0.8,
										'wPct' => 0.9,
									),
									'rot'     => 0,
									'curve'   => 0,
								),
								'values'       => array(),
							),
						),
					),
				),
			),
		);
	}

	/**
	 * 🔴 **The composer still emits exactly the captured bytes.**
	 *
	 * Compared as decoded structures rather than as a string, because PHP's
	 * JSON encoder is free to change whitespace between versions and that is
	 * not the contract. The KEYS and VALUES are.
	 */
	public function test_the_composer_still_produces_the_shared_fixture(): void {
		$composed = SceneComposer::compose(
			$this->sets(),
			array(
				'opt-badge'     => 'crest',
				'opt-engraving' => 'Omi Hasan',
			),
			2000,
			2000
		);

		$this->assertSame( $this->fixture()['scene'], $composed );
	}

	/**
	 * ⚠️ **The field names `buildScene()` reads, asserted by name.**
	 *
	 * The equality above would catch a rename too, but it fails as a wall of
	 * diff. These name the four things the TypeScript side destructures, so a
	 * rename says WHICH key moved.
	 */
	public function test_it_carries_the_keys_the_renderer_destructures(): void {
		$scene = $this->fixture()['scene'];

		$this->assertArrayHasKey( 'width', $scene );
		$this->assertArrayHasKey( 'height', $scene );
		$this->assertArrayHasKey( 'groups', $scene );
		$this->assertArrayHasKey( 'textOptions', $scene );
		$this->assertArrayHasKey( 'layers', $scene['groups'][0] );
		$this->assertArrayHasKey( 'visible', $scene['groups'][0] );
		$this->assertArrayHasKey( 'pos', $scene['groups'][0]['layers'][0] );
		$this->assertArrayHasKey( 'design', $scene['textOptions'][0] );
		$this->assertArrayHasKey( 'value', $scene['textOptions'][0] );
	}

	/**
	 * 📌 **Fractions, never pixels.** M26e.1 forbids geometry in PHP, and the
	 * resolution happens once in `shared/design/`. A `pos` carrying absolute
	 * numbers would mean the plugin had started computing layout.
	 */
	public function test_layer_geometry_is_fractions(): void {
		$pos = $this->fixture()['scene']['groups'][0]['layers'][0]['pos'];

		foreach ( array( 'xPct', 'yPct', 'wPct', 'hPct' ) as $key ) {
			$this->assertLessThanOrEqual( 1.0, $pos[ $key ], "$key must be a fraction" );
			$this->assertGreaterThanOrEqual( 0.0, $pos[ $key ], "$key must be a fraction" );
		}
	}
}
