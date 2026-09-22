<?php
/**
 * Engine\Result tests.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\Result;
use PHPUnit\Framework\TestCase;

final class ResultTest extends TestCase {

	public function test_ok_carries_a_value(): void {
		$result = Result::ok( 'payload' );
		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 'payload', $result->value() );
		$this->assertSame( array(), $result->get_errors() );
	}

	public function test_error_carries_a_code_and_field(): void {
		$result = Result::error( 'too_long', 'engraving', array( 'max' => 20 ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( 'too_long', $result->first_error_code() );
		$this->assertSame( 'engraving', $result->get_errors()[0]['field'] );
		$this->assertSame( 20, $result->get_errors()[0]['params']['max'] );
	}

	public function test_error_value_falls_back(): void {
		$this->assertSame( 'fallback', Result::error( 'nope' )->value( 'fallback' ) );
	}

	public function test_merge_collects_every_error(): void {
		$merged = Result::merge(
			Result::ok(),
			Result::error( 'required', 'size' ),
			Result::error( 'too_long', 'engraving' )
		);

		$this->assertFalse( $merged->is_ok() );
		$this->assertCount( 2, $merged->get_errors() );
	}

	public function test_merge_of_successes_is_success(): void {
		$this->assertTrue( Result::merge( Result::ok(), Result::ok() )->is_ok() );
	}
}
