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

	public function test_zero_and_equality(): void {
		$this->assertTrue( Money::zero()->is_zero() );
		$this->assertTrue( Money::from_minor( 100 )->equals( Money::from_minor( 100 ) ) );
		$this->assertFalse( Money::from_minor( 100 )->equals( Money::from_minor( 101 ) ) );
	}
}
