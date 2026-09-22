<?php
/**
 * Money value object tests.
 *
 * These are the cases that break float-based money: repeating decimals,
 * rounding boundaries, and currencies that are not two decimal places.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Money;
use PHPUnit\Framework\TestCase;

final class MoneyTest extends TestCase {

	public function test_parses_decimal_string_without_float_error(): void {
		$this->assertSame( 1999, Money::from_decimal( '19.99' )->minor() );
		$this->assertSame( 10, Money::from_decimal( '0.10' )->minor() );
		$this->assertSame( 1, Money::from_decimal( '0.01' )->minor() );
	}

	public function test_round_trips_to_decimal_string(): void {
		$this->assertSame( '19.99', Money::from_decimal( '19.99' )->to_decimal_string() );
		$this->assertSame( '0.05', Money::from_minor( 5 )->to_decimal_string() );
		$this->assertSame( '100.00', Money::from_minor( 10000 )->to_decimal_string() );
	}

	public function test_addition_and_subtraction(): void {
		$sum = Money::from_minor( 1000 )->plus( Money::from_minor( 500 ) );
		$this->assertSame( '15.00', $sum->to_decimal_string() );

		$diff = Money::from_minor( 1000 )->minus( Money::from_minor( 1500 ) );
		$this->assertSame( '-5.00', $diff->to_decimal_string() );
		$this->assertTrue( $diff->is_negative() );
	}

	public function test_multiplication_by_quantity(): void {
		$this->assertSame( 3000, Money::from_minor( 1000 )->times( 3 )->minor() );
		$this->assertSame( 0, Money::from_minor( 1000 )->times( 0 )->minor() );
	}

	public function test_percentage_rounds_half_up(): void {
		// 10% of 100.00 = 10.00 exactly.
		$this->assertSame( 1000, Money::from_minor( 10000 )->percentage( 1000 )->minor() );

		// 50% of 0.01 = 0.005, which must round up to 0.01 rather than down to 0.
		$this->assertSame( 1, Money::from_minor( 1 )->percentage( 5000 )->minor() );

		// 33.33% of 10.00 = 3.333 -> 3.33.
		$this->assertSame( 333, Money::from_minor( 1000 )->percentage( 3333 )->minor() );
	}

	public function test_percentage_rounds_symmetrically_for_negatives(): void {
		$this->assertSame( -1, Money::from_minor( -1 )->percentage( 5000 )->minor() );
	}

	public function test_zero_decimal_currency(): void {
		$jpy = Money::from_decimal( '500', 0 );
		$this->assertSame( 500, $jpy->minor() );
		$this->assertSame( '500', $jpy->to_decimal_string() );
	}

	public function test_three_decimal_currency(): void {
		$kwd = Money::from_decimal( '1.234', 3 );
		$this->assertSame( 1234, $kwd->minor() );
		$this->assertSame( '1.234', $kwd->to_decimal_string() );
	}

	public function test_rejects_mixing_scales(): void {
		$this->expectException( \InvalidArgumentException::class );
		Money::from_decimal( '1.00', 2 )->plus( Money::from_decimal( '1', 0 ) );
	}

	/**
	 * The whole reason from_decimal() is strict. Each of these previously
	 * produced a plausible-looking wrong number instead of an error.
	 *
	 * @dataProvider malformed_amounts
	 * @param mixed $amount Malformed input.
	 */
	public function test_rejects_malformed_input( $amount ): void {
		$this->assertNull( Money::try_from_decimal( $amount, 2 ) );
	}

	public function malformed_amounts(): array {
		return array(
			'european comma'      => array( '19,99' ),
			'thousands separator' => array( '1,999.00' ),
			'scientific notation' => array( '1e3' ),
			'letters'             => array( 'abc' ),
			'empty string'        => array( '' ),
			'whitespace only'     => array( '   ' ),
			'currency symbol'     => array( '$19.99' ),
			'two dots'            => array( '1.2.3' ),
			'trailing garbage'    => array( '19.99abc' ),
			'null'                => array( null ),
			'array'               => array( array() ),
			'bool'                => array( true ),
			// Built at runtime: a literal '0x10' trips a PHPCS sniff about
			// inconsistent hex-string behaviour across PHP versions.
			'hex'                 => array( sprintf( '0x%d', 10 ) ),
			'internal space'      => array( '1 9.99' ),
		);
	}

	public function test_from_decimal_throws_on_malformed_input(): void {
		$this->expectException( \InvalidArgumentException::class );
		Money::from_decimal( '19,99', 2 );
	}

	public function test_accepts_valid_forms(): void {
		$this->assertSame( 1999, Money::from_decimal( ' 19.99 ', 2 )->minor(), 'surrounding whitespace' );
		$this->assertSame( 1999, Money::from_decimal( '+19.99', 2 )->minor(), 'explicit plus' );
		$this->assertSame( 50, Money::from_decimal( '.5', 2 )->minor(), 'leading dot' );
		$this->assertSame( 1900, Money::from_decimal( '19.', 2 )->minor(), 'trailing dot' );
		$this->assertSame( 850, Money::from_decimal( '08.50', 2 )->minor(), 'leading zero, not octal' );
		$this->assertSame( 2000, Money::from_decimal( 20, 2 )->minor(), 'integer input' );
	}

	public function test_rounds_half_up_when_parsing_excess_precision(): void {
		$this->assertSame( 2000, Money::from_decimal( '19.999', 2 )->minor() );
		$this->assertSame( 1, Money::from_decimal( '0.005', 2 )->minor() );
		$this->assertSame( 299, Money::from_decimal( '2.994', 2 )->minor() );
		$this->assertSame( 101, Money::from_decimal( '1.006', 2 )->minor() );
	}

	public function test_rejects_values_beyond_integer_range(): void {
		$this->assertNull( Money::try_from_decimal( '999999999999999999999.99', 2 ) );
	}

	public function test_arithmetic_overflow_throws(): void {
		$this->expectException( \RangeException::class );
		Money::from_minor( PHP_INT_MAX )->times( 2 );
	}

	public function test_addition_overflow_throws(): void {
		$this->expectException( \RangeException::class );
		Money::from_minor( PHP_INT_MAX )->plus( Money::from_minor( PHP_INT_MAX ) );
	}

	public function test_negative_zero_is_not_negative(): void {
		$money = Money::from_decimal( '-0.00', 2 );
		$this->assertSame( 0, $money->minor() );
		$this->assertFalse( $money->is_negative() );
		$this->assertSame( '0.00', $money->to_decimal_string() );
	}

	public function test_zero_and_equality(): void {
		$this->assertTrue( Money::zero()->is_zero() );
		$this->assertTrue( Money::from_minor( 100 )->equals( Money::from_minor( 100 ) ) );
		$this->assertFalse( Money::from_minor( 100 )->equals( Money::from_minor( 101 ) ) );
	}
}
