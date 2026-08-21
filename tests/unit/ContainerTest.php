<?php
/**
 * Service container tests.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Container;
use Optionia\Exceptions\InvariantViolation;
use PHPUnit\Framework\TestCase;

final class ContainerTest extends TestCase {

	public function test_resolves_a_registered_service(): void {
		$container = new Container();
		$container->set( 'thing', static fn (): \stdClass => new \stdClass() );

		$this->assertInstanceOf( \stdClass::class, $container->get( 'thing' ) );
	}

	public function test_constructs_once_and_caches(): void {
		$container = new Container();
		$calls     = 0;

		$container->set(
			'thing',
			static function () use ( &$calls ): \stdClass {
				++$calls;

				return new \stdClass();
			}
		);

		$first  = $container->get( 'thing' );
		$second = $container->get( 'thing' );

		$this->assertSame( $first, $second, 'the same instance is returned' );
		$this->assertSame( 1, $calls, 'the factory runs only once' );
	}

	public function test_lazy_until_requested(): void {
		$container = new Container();
		$built     = false;

		$container->set(
			'thing',
			static function () use ( &$built ): \stdClass {
				$built = true;

				return new \stdClass();
			}
		);

		$this->assertFalse( $built, 'registration does not construct' );
		$container->get( 'thing' );
		$this->assertTrue( $built );
	}

	public function test_unregistered_service_throws(): void {
		$this->expectException( InvariantViolation::class );
		( new Container() )->get( 'missing' );
	}

	public function test_factory_returning_a_non_object_throws(): void {
		$container = new Container();
		$container->set( 'bad', static fn () => 'not an object' );

		$this->expectException( InvariantViolation::class );
		$container->get( 'bad' );
	}

	/**
	 * Without cycle detection this recurses until the stack is exhausted,
	 * producing a fatal error that names no service.
	 */
	public function test_direct_cycle_is_reported(): void {
		$container = new Container();
		$container->set( 'a', static fn ( Container $c ): object => $c->get( 'a' ) );

		$this->expectException( InvariantViolation::class );
		$this->expectExceptionMessageMatches( '/Circular service dependency/' );
		$container->get( 'a' );
	}

	public function test_indirect_cycle_names_the_full_path(): void {
		$container = new Container();
		$container->set( 'a', static fn ( Container $c ): object => $c->get( 'b' ) );
		$container->set( 'b', static fn ( Container $c ): object => $c->get( 'c' ) );
		$container->set( 'c', static fn ( Container $c ): object => $c->get( 'a' ) );

		$this->expectException( InvariantViolation::class );
		$this->expectExceptionMessageMatches( '/a -> b -> c -> a/' );
		$container->get( 'a' );
	}

	public function test_resolution_state_resets_after_a_failure(): void {
		$container = new Container();
		$container->set( 'a', static fn ( Container $c ): object => $c->get( 'a' ) );
		$container->set( 'ok', static fn (): \stdClass => new \stdClass() );

		try {
			$container->get( 'a' );
		} catch ( InvariantViolation $e ) {
			unset( $e );
		}

		// A failed resolution must not poison later, unrelated ones.
		$this->assertInstanceOf( \stdClass::class, $container->get( 'ok' ) );
	}

	public function test_has_reports_registration(): void {
		$container = new Container();
		$this->assertFalse( $container->has( 'thing' ) );

		$container->set( 'thing', static fn (): \stdClass => new \stdClass() );
		$this->assertTrue( $container->has( 'thing' ) );
	}
}
