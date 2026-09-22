<?php
/**
 * Every registered service can actually be built.
 *
 * The container resolves by closure, so a wrong class name, a missing
 * dependency or a changed constructor signature is a *runtime* error on a real
 * WordPress request -- and invisible to every gate here. The reachability check
 * is textual: it sees the class named in `Plugin.php` and is satisfied. No test
 * booted the container, so nothing executed those closures.
 *
 * That gap is how `[8k]` shipped three classes nothing could reach. This is the
 * check that would have caught it: not "is the class mentioned" but "does it
 * come out of the container when asked".
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Admin\ConnectionSection;
use Optionia\Admin\SystemStatus;
use Optionia\Api\CircuitBreaker;
use Optionia\Api\Client;
use Optionia\Catalogue\CatalogueCursor;
use Optionia\Catalogue\CataloguePayload;
use Optionia\Catalogue\CatalogueReconciler;
use Optionia\Catalogue\CataloguePusher;
use Optionia\Catalogue\ProductQueue;
use Optionia\Catalogue\ProductWatcher;
use Optionia\Catalogue\QueueDrainer;
use Optionia\Config\Repository;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\Heartbeat;
use Optionia\Container;
use Optionia\Plugin;
use Optionia\Support\Cron;
use Optionia\Support\Logger;
use Optionia\Frontend\Assets;
use Optionia\Frontend\Renderer;
use Optionia\Upload\UploadEndpoint;
use Optionia\Upload\UploadImage;
use Optionia\Upload\UploadPromoter;
use Optionia\Upload\UploadQuota;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadRules;
use Optionia\Upload\UploadStore;
use Optionia\Upload\UploadSweeper;
use Optionia\Frontend\Templates;
use Optionia\Support\Settings;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * The wiring holds when exercised, not merely when read.
 *
 * @covers \Optionia\Plugin
 * @covers \Optionia\Container
 */
final class ContainerWiringTest extends TestCase {

	/**
	 * Reset stubs between tests.
	 */
	protected function setUp(): void {
		$GLOBALS['optionia_test_options'] = array();
		$GLOBALS['optionia_test_actions'] = array();
	}

	/**
	 * A container with every service registered, as `boot()` leaves it.
	 *
	 * Both registration methods run: core services first, since the rest
	 * depend on `Settings` and `Logger`. Calling only the second returns
	 * "service not registered" for everything, which looks like a wiring bug
	 * and is not one.
	 */
	private function booted_container(): Container {
		$class  = new ReflectionClass( Plugin::class );
		$plugin = $class->newInstanceWithoutConstructor();

		$property = $class->getProperty( 'container' );
		$property->setAccessible( true );
		$property->setValue( $plugin, new Container() );

		foreach ( array( 'register_core_services', 'register_services' ) as $name ) {
			$method = $class->getMethod( $name );
			$method->setAccessible( true );
			$method->invoke( $plugin );
		}

		return $property->getValue( $plugin );
	}

	/**
	 * Every registered service resolves to an object of the right type.
	 *
	 * @dataProvider registered_services
	 *
	 * @param string $service Fully-qualified service name.
	 */
	public function test_every_registered_service_resolves( string $service ): void {
		$resolved = $this->booted_container()->get( $service );

		$this->assertInstanceOf( $service, $resolved );
	}

	/**
	 * Every service the plugin registers, whatever phase added it.
	 *
	 * Named for the connection flow when Phase 8 wrote it, and Phase 10 added
	 * `Frontend\Renderer` without extending it — so the storefront's entry point
	 * could have failed to resolve and this suite would have stayed green. That
	 * is precisely the bug this test exists to catch, missed because the list
	 * described a phase rather than the container.
	 *
	 * A list is still the right shape: resolving *every* registered id would
	 * pass trivially by construction. But it is a list of what the plugin wires,
	 * not of what one phase happened to need.
	 *
	 * @return array<string, string[]>
	 */
	public function registered_services(): array {
		return array(
			'handshake'         => array( Handshake::class ),
			'callback'          => array( Callback::class ),
			'heartbeat'         => array( Heartbeat::class ),
			'connection screen' => array( ConnectionSection::class ),
			'system status'     => array( SystemStatus::class ),
			'api client'        => array( Client::class ),
			'circuit breaker'   => array( CircuitBreaker::class ),
			'config cache'      => array( Repository::class ),
			'cron'              => array( Cron::class ),
			'settings'          => array( Settings::class ),
			'logger'            => array( Logger::class ),
			'catalogue cursor'  => array( CatalogueCursor::class ),
			'catalogue payload' => array( CataloguePayload::class ),
			'catalogue pusher'  => array( CataloguePusher::class ),
			'product queue'     => array( ProductQueue::class ),
			'product watcher'   => array( ProductWatcher::class ),
			'queue drainer'     => array( QueueDrainer::class ),
			'reconciler'        => array( CatalogueReconciler::class ),
			'templates'         => array( Templates::class ),
			'assets'            => array( Assets::class ),
			'renderer'          => array( Renderer::class ),

			/*
			 * The upload chain (M15.2).
			 *
			 * ⚠️ **`UploadEndpoint` takes five collaborators**, and a constructor
			 * that grows is exactly where a container binding falls behind. This
			 * list is hand-maintained, so a service added to `Plugin` and not to
			 * here resolves only when a real request reaches it — a customer's
			 * upload is the wrong place to discover a missing argument.
			 */
			'upload store'      => array( UploadStore::class ),
			'upload repository' => array( UploadRepository::class ),
			'upload quota'      => array( UploadQuota::class ),
			'upload rules'      => array( UploadRules::class ),
			'upload images'     => array( UploadImage::class ),
			'upload endpoint'   => array( UploadEndpoint::class ),
			'upload sweeper'    => array( UploadSweeper::class ),
			'upload promoter'   => array( UploadPromoter::class ),
		);
	}

	/**
	 * Resolving twice returns the same instance.
	 *
	 * `StateMachine` reads and writes one option; two `Heartbeat` instances
	 * would each register the cron listener, and the daily ping would fire
	 * twice.
	 */
	public function test_services_are_shared_not_rebuilt(): void {
		$container = $this->booted_container();

		$this->assertSame(
			$container->get( Heartbeat::class ),
			$container->get( Heartbeat::class )
		);
	}

	/**
	 * An unregistered service fails loudly.
	 *
	 * Without this the tests above would pass against a container that returned
	 * null for everything.
	 */
	public function test_unknown_service_is_refused(): void {
		$this->expectException( \Throwable::class );

		$this->booted_container()->get( 'Optionia\\Nonexistent\\Service' );
	}
}
