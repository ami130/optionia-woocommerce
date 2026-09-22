<?php
/**
 * The shared label reader (M18.2).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\OptionLabel;
use PHPUnit\Framework\TestCase;

/**
 * One reading of a stored label, for the three consumers that show them.
 *
 * 🔴 **The defect this class removes reached the merchant's order record.**
 * `CartDisplay`, `OrderLineItem` and `CheckoutValidator` each read
 * `$label['option']` directly, which is `null` when the label is a *list* — so
 * a multi-select line rendered the raw option id and the word `"Array"`.
 * Measured, with a PHP notice, into packing slips and CSV exports.
 *
 * @covers \Optionia\Support\OptionLabel
 */
final class OptionLabelTest extends TestCase {

	/** The `cardinality: one` shape: a single pair. */
	private const ONE = array(
		'option' => 'Finish',
		'value'  => 'Luxury',
	);

	/** The `cardinality: many` shape: a list of pairs. */
	private const MANY = array(
		array(
			'option' => 'Extras',
			'value'  => 'Red',
		),
		array(
			'option' => 'Extras',
			'value'  => 'Blue',
		),
	);

	/**
	 * A single label reads exactly as it did before multi-select existed.
	 *
	 * ⚠️ **The regression guard for every existing cart and order.** This shape
	 * is what every line in every store carries today.
	 */
	public function test_a_single_label_reads_its_option_and_value(): void {
		$this->assertSame( 'Finish', OptionLabel::name( self::ONE, 'opt-a' ) );
		$this->assertSame( 'Luxury', OptionLabel::value( self::ONE, 'lux' ) );
	}

	/**
	 * 🔴 **Every chosen value appears, joined.**
	 *
	 * A multi-select showing only its first value is the shape M11.5 exists to
	 * prevent: a customer reading a total they cannot account for.
	 */
	public function test_a_list_joins_every_chosen_value(): void {
		$this->assertSame( 'Extras', OptionLabel::name( self::MANY, 'opt-a' ) );
		$this->assertSame(
			'Red, Blue',
			OptionLabel::value( self::MANY, array( 'red', 'blue' ) )
		);
	}

	/**
	 * 🔴 **"Array" never appears, in either position.**
	 *
	 * The measured defect, asserted directly rather than through a consumer:
	 * `name='opt-a'  value='Array'`, with `Warning: Array to string conversion`.
	 */
	public function test_an_array_never_coerces_into_the_output(): void {
		$this->assertStringNotContainsString(
			'Array',
			OptionLabel::name( self::MANY, 'opt-a' )
		);
		$this->assertStringNotContainsString(
			'Array',
			OptionLabel::value( self::MANY, array( 'red', 'blue' ) )
		);
	}

	/**
	 * ⚠️ A list is told from a single pair by `option`, not by `is_array()`.
	 *
	 * Both shapes *are* arrays, so testing for an array answers the wrong
	 * question — and a reader that did would treat `{option, value}` as a list
	 * of two unrelated entries.
	 */
	public function test_a_single_pair_is_not_mistaken_for_a_list(): void {
		$this->assertSame( 'Luxury', OptionLabel::value( self::ONE, 'lux' ) );
	}

	/**
	 * A missing name falls back to what the caller supplies — the option id.
	 */
	public function test_a_missing_name_falls_back(): void {
		$this->assertSame( 'opt-a', OptionLabel::name( array(), 'opt-a' ) );
		$this->assertSame( 'opt-a', OptionLabel::name( null, 'opt-a' ) );
		$this->assertSame(
			'opt-a',
			OptionLabel::name( array( 'option' => '' ), 'opt-a' )
		);
	}

	/**
	 * 🔴 **One unlabelled value falls back on its own, not for the whole option.**
	 *
	 * A value that stored no label must not erase its siblings from the line.
	 */
	public function test_one_unlabelled_value_does_not_erase_the_others(): void {
		$label = array(
			array(
				'option' => 'Extras',
				'value'  => 'Red',
			),
			array( 'option' => 'Extras' ),
		);

		$this->assertSame(
			'Red, blue',
			OptionLabel::value( $label, array( 'red', 'blue' ) )
		);
	}

	/**
	 * With nothing stored at all, the raw selection is shown.
	 *
	 * A line from before labels were recorded, or one another plugin emptied.
	 */
	public function test_no_stored_label_shows_the_raw_selection(): void {
		$this->assertSame( 'lux', OptionLabel::value( null, 'lux' ) );
		$this->assertSame( 'red, blue', OptionLabel::value( array(), array( 'red', 'blue' ) ) );
	}

	/**
	 * 🔴 **An array inside a single pair's `value` is joined, not dropped.**
	 *
	 * ⚠️ **A third shape, and the existing `CartDisplay` suite caught it when
	 * this class first replaced its reader.** `{option, value: ['Red','Large']}`
	 * is not what this plugin writes, but another plugin filtering the payload
	 * can produce it — and the **block cart discards a whole row** whose value
	 * is not scalar, so the customer would lose the line rather than see a
	 * clumsy one.
	 *
	 * The guard existed in `CartDisplay::text()` before M18.2 and moved here
	 * with the rest of the reading; without this test it would have been lost
	 * for the two consumers that never had it.
	 */
	public function test_an_array_inside_a_single_value_is_joined(): void {
		$label = array(
			'option' => 'Finish',
			'value'  => array( 'Red', 'Large' ),
		);

		$value = OptionLabel::value( $label, 'lux' );

		$this->assertIsScalar( $value );
		$this->assertSame( 'Red, Large', $value );
	}

	/**
	 * 🔴 **A non-scalar in the raw selection is dropped, never coerced.**
	 *
	 * The hostile shape: no stored label, and a nested array in the selection.
	 * A reader that cast it would print `"Array"` — the exact defect, reached by
	 * the fallback path rather than the label path.
	 */
	public function test_a_nested_array_in_the_fallback_is_dropped(): void {
		$value = OptionLabel::value( null, array( 'red', array( 'nested' ) ) );

		$this->assertSame( 'red', $value );
		$this->assertStringNotContainsString( 'Array', $value );
	}
}
