<?php
/**
 * The price shown beside one choice (M18.6b).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Frontend\OptionView;
use PHPUnit\Framework\TestCase;

/**
 * What `price_display` finally does.
 *
 * 🔴 **It was normalised and read by nothing.** `OptionView::display()` gave it
 * a validated value and a documented default from Phase 14 onward, and no
 * template ever looked at it — the state ADR-064 kept it *out* of withdrawal to
 * fix, on the grounds that the distance between carried and consumed was work
 * rather than a question.
 *
 * @covers \Optionia\Frontend\OptionView
 */
final class OptionValuePriceTest extends TestCase {

	/**
	 * A value with a fixed price of the given minor units.
	 *
	 * @param int    $minor Amount in minor units.
	 * @param string $type  The price type.
	 * @return array<string, mixed>
	 */
	private static function value( int $minor, string $type = 'fixed' ): array {
		return array(
			'value_key'    => 'lux',
			'label'        => 'Luxury',
			'price_config' => array(
				'type'         => $type,
				'amount_minor' => $minor,
			),
		);
	}

	/**
	 * 🔴 **`delta` prints the option's own contribution, signed.**
	 *
	 * The first per-choice price this plugin shows: until M18.6b a price reached
	 * the page only as `data-optionia-price` for the running estimate.
	 */
	public function test_a_delta_prints_a_signed_amount(): void {
		$this->assertSame( '+£10.00', OptionView::value_price( self::value( 1000 ), 'delta' ) );
	}

	/**
	 * ⚠️ **A discount shows its own sign**, rather than a `+` on a negative
	 * number. The same shape `CartDisplay::with_price()` uses on a cart line.
	 */
	public function test_a_discount_prints_a_minus(): void {
		$this->assertSame( '-£5.00', OptionView::value_price( self::value( -500 ), 'delta' ) );
	}

	/**
	 * 🔴 **`hidden` prints nothing, for every amount.**
	 *
	 * A merchant who says "show no prices" gets none. The `data-optionia-price`
	 * attribute stays, because the running estimate is a separate surface with
	 * its own opt-out — removing it here would silently disable that too.
	 */
	public function test_hidden_prints_nothing(): void {
		$this->assertSame( '', OptionView::value_price( self::value( 1000 ), 'hidden' ) );
		$this->assertSame( '', OptionView::value_price( self::value( -500 ), 'hidden' ) );
	}

	/**
	 * 🔴 **`total` renders as `delta` until Phase 21** (ADR-065).
	 *
	 * A total is `base + option`, and no option template has the base price —
	 * but the blocker is not plumbing. `frontend.js` listens to **no**
	 * WooCommerce variation events, deliberately, because the estimate is an
	 * options *delta* and nothing it sums changes with the chosen variation. A
	 * printed total would be stale the moment a customer picks a size.
	 *
	 * ⚠️ **The dashboard does not offer `total`**, so a merchant cannot select
	 * a framing that silently behaves like another — the guard ADR-063 uses for
	 * `stepped`.
	 */
	public function test_total_falls_back_to_delta(): void {
		$this->assertSame(
			OptionView::value_price( self::value( 1000 ), 'delta' ),
			OptionView::value_price( self::value( 1000 ), 'total' )
		);
	}

	/**
	 * ⚠️ **A free choice prints nothing.** `+0.00` beside it reads as a mistake
	 * — the reasoning `CartDisplay::with_price()` already records.
	 */
	public function test_a_zero_prints_nothing(): void {
		$this->assertSame( '', OptionView::value_price( self::value( 0 ), 'delta' ) );
	}

	/**
	 * 🔴 **Only `fixed` is priced**, matching `PRICEABLE` in the runtime.
	 *
	 * `percentage`, `per_unit`, `per_char` and `tiered` each need a decision
	 * `PRICING-SPEC.md` has not made — what a percentage applies to, how it
	 * rounds, where a quantity comes from. *"A storefront guessing at any of
	 * those would show a total the server disagrees with, which is worse than
	 * showing none."*
	 */
	public function test_an_unpriceable_type_prints_nothing(): void {
		foreach ( array( 'percentage', 'per_unit', 'per_char', 'tiered' ) as $type ) {
			$this->assertSame(
				'',
				OptionView::value_price( self::value( 1000, $type ), 'delta' ),
				$type . ' must not be guessed at.'
			);
		}
	}

	/**
	 * A value with no price config at all prints nothing rather than fataling.
	 *
	 * The document is input, not authority (AC4).
	 */
	public function test_a_value_with_no_price_prints_nothing(): void {
		$this->assertSame( '', OptionView::value_price( array( 'value_key' => 'x' ), 'delta' ) );
		$this->assertSame(
			'',
			OptionView::value_price( array( 'price_config' => 'nonsense' ), 'delta' )
		);
	}

	/**
	 * 🔴 **A non-integer amount prints nothing.**
	 *
	 * `Support\Money` exists because money is never a float. An amount arriving
	 * as `"10.00"` or `10.0` is a document this build cannot trust, and printing
	 * a number derived from it would be the first float in a price path.
	 */
	public function test_a_non_integer_amount_prints_nothing(): void {
		$value = array(
			'price_config' => array(
				'type'         => 'fixed',
				'amount_minor' => '1000',
			),
		);

		$this->assertSame( '', OptionView::value_price( $value, 'delta' ) );
	}
}
