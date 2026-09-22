<?php
/**
 * Style tokens are re-validated at the point they become CSS (M21c.4).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Frontend\OptionView;
use PHPUnit\Framework\TestCase;

/**
 * 🔴 **The API validates on the way in; this validates on the way out.**
 *
 * M21c.4 is marked *"non-negotiable, and it applies even if D6 chose
 * template-overrides-only"* for one reason: the plugin renders a config
 * document **fetched from the cloud**, so every style value is untrusted input
 * at the point of emission. A document can be stale, hand-edited in the options
 * table, replayed from a cache written before a schema tightened, or served by
 * something that is not the API.
 *
 * @covers \Optionia\Frontend\OptionView::styles
 */
final class OptionStylesTest extends TestCase {

	/**
	 * One option carrying a display block.
	 *
	 * @param array<string, mixed> $display The display config.
	 * @return array<string, mixed>
	 */
	private function option( array $display ): array {
		return array( 'display' => $display );
	}

	/**
	 * The four tokens, all valid, all emitted.
	 */
	public function test_the_four_tokens_are_emitted(): void {
		$css = OptionView::styles(
			$this->option(
				array(
					'accent_color'  => '#3858e9',
					'border_radius' => 4,
					'spacing'       => 12,
					'swatch_px'     => 48,
				)
			)
		);

		$this->assertStringContainsString( '--optionia-accent: #3858e9', $css );
		$this->assertStringContainsString( '--optionia-radius: 4px', $css );
		$this->assertStringContainsString( '--optionia-gap: 12px', $css );
		$this->assertStringContainsString( '--optionia-swatch: 48px', $css );
	}

	/**
	 * 🔴 **The injection case, and the reason this milestone exists.**
	 *
	 * An accent colour that closes its declaration and opens another must not
	 * reach the page. Every one of these is a string a config document could
	 * carry if it were written by anything other than the API.
	 *
	 * @dataProvider hostileColours
	 * @param string $hostile A colour that must never be emitted.
	 */
	public function test_a_hostile_colour_is_never_emitted( string $hostile ): void {
		$css = OptionView::styles( $this->option( array( 'accent_color' => $hostile ) ) );

		$this->assertSame( '', $css );
	}

	/**
	 * Colours that are not six hex digits.
	 *
	 * @return array<string, array{string}>
	 */
	public static function hostileColours(): array {
		return array(
			'declaration break' => array( '#3858e9; background: url(//evil)' ),
			'quote break'       => array( '#3858e9"' ),
			'expression'        => array( 'var(--x)' ),
			'url'               => array( 'url(//evil)' ),
			'named'             => array( 'red' ),
			'rgb function'      => array( 'rgb(255,0,0)' ),
			'shorthand'         => array( '#f00' ),
			'not hex'           => array( '#gggggg' ),
			'empty'             => array( '' ),
			'comment escape'    => array( '#3858e9 */ body{display:none}/*' ),
			'newline'           => array( "#3858e9\n; color: red" ),
		);
	}

	/**
	 * ⚠️ **A number out of range is dropped, not clamped.**
	 *
	 * Clamping invents a value the merchant did not author; M9.6's posture is
	 * that an option whose styles cannot be validated renders with **defaults**,
	 * and the theme's own default is the one already in the stylesheet.
	 */
	public function test_an_out_of_range_number_is_dropped(): void {
		foreach ( array(
			array( 'border_radius', -1 ),
			array( 'border_radius', 25 ),
			array( 'spacing', -1 ),
			array( 'spacing', 49 ),
			array( 'swatch_px', 15 ),
			array( 'swatch_px', 129 ),
		) as $case ) {
			list( $key, $value ) = $case;

			$this->assertSame(
				'',
				OptionView::styles( $this->option( array( $key => $value ) ) ),
				"$key of $value must not be emitted"
			);
		}
	}

	/**
	 * ⚠️ **A float pixel is not a pixel count**, and `4.5px` renders.
	 */
	public function test_a_fractional_value_is_dropped(): void {
		$this->assertSame(
			'',
			OptionView::styles( $this->option( array( 'border_radius' => 4.5 ) ) )
		);
	}

	/**
	 * ⚠️ **A number arriving as a string is still not a number.**
	 *
	 * `"4"` is what a form sends when nobody coerced it, and `"4; color: red"`
	 * is what it sends when somebody meant harm. `is_int` refuses both, where
	 * `is_numeric` would accept the first and open the question of the second.
	 */
	public function test_a_numeric_string_is_dropped(): void {
		$this->assertSame(
			'',
			OptionView::styles( $this->option( array( 'border_radius' => '4' ) ) )
		);

		$this->assertSame(
			'',
			OptionView::styles( $this->option( array( 'spacing' => '4; color: red' ) ) )
		);
	}

	/**
	 * 🔴 **One bad token does not cost the others.**
	 *
	 * A document with a hostile colour and three sound numbers must still style
	 * the option — dropping everything over one bad value would make a stale
	 * document look like a styling bug.
	 */
	public function test_a_bad_token_does_not_drop_the_good_ones(): void {
		$css = OptionView::styles(
			$this->option(
				array(
					'accent_color'  => 'red; background: url(//evil)',
					'border_radius' => 4,
					'spacing'       => 12,
				)
			)
		);

		$this->assertStringNotContainsString( 'evil', $css );
		$this->assertStringNotContainsString( 'red', $css );
		$this->assertStringContainsString( '--optionia-radius: 4px', $css );
		$this->assertStringContainsString( '--optionia-gap: 12px', $css );
	}

	/**
	 * An option with no display block styles nothing.
	 */
	public function test_an_unstyled_option_emits_nothing(): void {
		$this->assertSame( '', OptionView::styles( array() ) );
		$this->assertSame( '', OptionView::styles( $this->option( array() ) ) );
	}

	/**
	 * ⚠️ **A non-array `display` must not fatal.** A hand-edited options row can
	 * hold a string where an object belongs.
	 */
	public function test_a_malformed_display_block_is_ignored(): void {
		$this->assertSame( '', OptionView::styles( array( 'display' => 'nonsense' ) ) );
		$this->assertSame( '', OptionView::styles( array( 'display' => 42 ) ) );
	}

	/**
	 * 🔴 **No `!important`, ever** (ADR-112). Merchant CSS must be able to win.
	 */
	public function test_no_important_is_emitted(): void {
		$css = OptionView::styles(
			$this->option(
				array(
					'accent_color'  => '#3858e9',
					'border_radius' => 4,
				)
			)
		);

		$this->assertStringNotContainsString( '!important', $css );
	}

	/**
	 * ⚠️ **Everything emitted is a custom property.** A malformed value can then
	 * at worst define a variable nothing reads, where `color: <merchant data>`
	 * would put it in a property the browser acts on.
	 */
	public function test_only_custom_properties_are_emitted(): void {
		$css = OptionView::styles(
			$this->option(
				array(
					'accent_color'  => '#3858e9',
					'border_radius' => 4,
					'spacing'       => 12,
					'swatch_px'     => 48,
				)
			)
		);

		foreach ( array_filter( array_map( 'trim', explode( ';', $css ) ) ) as $declaration ) {
			$this->assertStringStartsWith( '--optionia-', $declaration );
		}
	}
}
