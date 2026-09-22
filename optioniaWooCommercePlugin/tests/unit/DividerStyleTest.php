<?php
/**
 * A divider's style is re-validated where it becomes a class (M21c.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Frontend\OptionView;
use PHPUnit\Framework\TestCase;

/**
 * 🔴 **The second of two layers** (ADR-113). The API validates what a merchant
 * may author; this refuses to emit what a document should not carry — and a
 * document can be stale, hand-edited, or served by something that is not the API.
 *
 * @covers \Optionia\Frontend\OptionView::divider_style
 */
final class DividerStyleTest extends TestCase {

	/**
	 * The three styles ADR-113 chose.
	 *
	 * @dataProvider supportedStyles
	 * @param string $style One supported style.
	 */
	public function test_a_supported_style_is_kept( string $style ): void {
		$this->assertSame(
			$style,
			OptionView::divider_style( array( 'display' => array( 'style' => $style ) ) )
		);
	}

	/**
	 * The three styles ADR-113 chose.
	 *
	 * @return array<string, array{string}>
	 */
	public static function supportedStyles(): array {
		return array(
			'solid'  => array( 'solid' ),
			'dashed' => array( 'dashed' ),
			'dotted' => array( 'dotted' ),
		);
	}

	/**
	 * ⚠️ **The styles ADR-113 declined**, plus the ones `optionia-app`
	 * synthesizes. None may reach a class attribute.
	 *
	 * @dataProvider refusedStyles
	 * @param mixed $style A style that must fall back.
	 */
	public function test_an_unsupported_style_falls_back_to_solid( $style ): void {
		$this->assertSame(
			'solid',
			OptionView::divider_style( array( 'display' => array( 'style' => $style ) ) )
		);
	}

	/**
	 * Styles ADR-113 declined, and values no document should carry.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function refusedStyles(): array {
		return array(
			'double'      => array( 'double' ),
			'groove'      => array( 'groove' ),
			'ridge'       => array( 'ridge' ),
			'wave'        => array( 'wave' ),
			'class break' => array( 'solid" onload="alert(1)' ),
			'empty'       => array( '' ),
			'an array'    => array( array( 'dashed' ) ),
			'a number'    => array( 3 ),
			'a bool'      => array( true ),
			'uppercase'   => array( 'DASHED' ),
			'with spaces' => array( ' dashed ' ),
		);
	}

	/**
	 * A divider carrying no display at all is `solid` — the value the base CSS
	 * rule already draws, so an old document renders exactly as it always did.
	 */
	public function test_an_unconfigured_divider_is_solid(): void {
		$this->assertSame( 'solid', OptionView::divider_style( array() ) );
		$this->assertSame( 'solid', OptionView::divider_style( array( 'display' => array() ) ) );
	}

	/**
	 * ⚠️ **A malformed `display` must not fatal.** A hand-edited options row can
	 * hold a string where an object belongs.
	 */
	public function test_a_malformed_display_block_is_ignored(): void {
		$this->assertSame( 'solid', OptionView::divider_style( array( 'display' => 'nonsense' ) ) );
		$this->assertSame( 'solid', OptionView::divider_style( array( 'display' => 42 ) ) );
	}
}
