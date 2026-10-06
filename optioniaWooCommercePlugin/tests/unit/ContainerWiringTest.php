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
use Optionia\Admin\Menu;
use Optionia\Admin\OrderFiles;
use Optionia\Admin\SettingsPage;
use Optionia\Analytics\ViewCollector;
use Optionia\Analytics\ViewEndpoint;
use Optionia\Analytics\ViewReporter;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Synchroniser;
use Optionia\Connection\PushEndpoint;
use Optionia\Integration\AddToCartValidator;
use Optionia\Integration\CartDisplay;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartItemKey;
use Optionia\Integration\CartTotals;
use Optionia\Integration\CheckoutValidator;
use Optionia\Integration\OrderAgain;
use Optionia\Integration\OrderLineItem;
use Optionia\Reporting\OrderPayload;
use Optionia\Reporting\OrderQueue;
use Optionia\Reporting\OrderReporter;
use Optionia\Support\Environment;
use Optionia\Upload\MovesUploadedFiles;
use Optionia\Upload\UploadArchive;
use Optionia\Upload\UploadDownload;
use Optionia\Upload\UploadExpirer;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadRetention;
use Optionia\Upload\UploadTokenCheck;
use Optionia\Design\LineScene;
use Optionia\Design\PreviewEndpoint;
use Optionia\Design\RenderCollector;
use Optionia\Design\RenderRequester;
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
			'handshake'             => array( Handshake::class ),
			'callback'              => array( Callback::class ),
			'heartbeat'             => array( Heartbeat::class ),
			'connection screen'     => array( ConnectionSection::class ),
			'system status'         => array( SystemStatus::class ),
			'api client'            => array( Client::class ),
			'circuit breaker'       => array( CircuitBreaker::class ),
			'config cache'          => array( Repository::class ),
			'cron'                  => array( Cron::class ),
			'settings'              => array( Settings::class ),
			'logger'                => array( Logger::class ),
			'catalogue cursor'      => array( CatalogueCursor::class ),
			'catalogue payload'     => array( CataloguePayload::class ),
			'catalogue pusher'      => array( CataloguePusher::class ),
			'product queue'         => array( ProductQueue::class ),
			'product watcher'       => array( ProductWatcher::class ),
			'queue drainer'         => array( QueueDrainer::class ),
			'reconciler'            => array( CatalogueReconciler::class ),
			'templates'             => array( Templates::class ),
			'assets'                => array( Assets::class ),
			'renderer'              => array( Renderer::class ),

			/*
			 * The upload chain (M15.2).
			 *
			 * ⚠️ **`UploadEndpoint` takes five collaborators**, and a constructor
			 * that grows is exactly where a container binding falls behind. This
			 * list is hand-maintained, so a service added to `Plugin` and not to
			 * here resolves only when a real request reaches it — a customer's
			 * upload is the wrong place to discover a missing argument.
			 */
			'upload store'          => array( UploadStore::class ),
			'upload repository'     => array( UploadRepository::class ),
			'upload quota'          => array( UploadQuota::class ),
			'upload rules'          => array( UploadRules::class ),
			'upload images'         => array( UploadImage::class ),
			'upload endpoint'       => array( UploadEndpoint::class ),
			'upload sweeper'        => array( UploadSweeper::class ),
			'upload promoter'       => array( UploadPromoter::class ),

			/*
			 * Print files (M26e.4). `RenderRequester` takes four collaborators
			 * and one of them is constructed inline with a constant from
			 * another namespace — the binding that shipped with `Keys`
			 * unimported and fataled the whole site on boot.
			 */
			'line scene'            => array( LineScene::class ),
			'render requester'      => array( RenderRequester::class ),
			'render collector'      => array( RenderCollector::class ),
			'preview endpoint'      => array( PreviewEndpoint::class ),

			/*
			 * 🔴 **Twenty-eight services the list had never resolved**, found
			 * the moment the drift check below was written — the whole
			 * cart/checkout path, order reporting, the admin screens and half
			 * the upload chain. Each was a binding that would only be exercised
			 * when a real request reached it, which is how `Keys` unimported in
			 * one of them fataled the site on boot with every test green.
			 */
			'admin menu'            => array( Menu::class ),
			'order files'           => array( OrderFiles::class ),
			'settings page'         => array( SettingsPage::class ),
			'view collector'        => array( ViewCollector::class ),
			'view endpoint'         => array( ViewEndpoint::class ),
			'view reporter'         => array( ViewReporter::class ),
			'response validator'    => array( ResponseValidator::class ),
			'config synchroniser'   => array( Synchroniser::class ),
			'push endpoint'         => array( PushEndpoint::class ),
			'add-to-cart validator' => array( AddToCartValidator::class ),
			'cart display'          => array( CartDisplay::class ),
			'cart item data'        => array( CartItemData::class ),
			'cart item key'         => array( CartItemKey::class ),
			'cart totals'           => array( CartTotals::class ),
			'checkout validator'    => array( CheckoutValidator::class ),
			'order again'           => array( OrderAgain::class ),
			'order line item'       => array( OrderLineItem::class ),
			'order payload'         => array( OrderPayload::class ),
			'order queue'           => array( OrderQueue::class ),
			'order reporter'        => array( OrderReporter::class ),
			'environment'           => array( Environment::class ),
			'upload mover'          => array( MovesUploadedFiles::class ),
			'upload archive'        => array( UploadArchive::class ),
			'upload download'       => array( UploadDownload::class ),
			'upload expirer'        => array( UploadExpirer::class ),
			'upload link'           => array( UploadLink::class ),
			'upload retention'      => array( UploadRetention::class ),
			'upload token check'    => array( UploadTokenCheck::class ),
		);
	}

	/**
	 * The list above names every service `Plugin` registers.
	 *
	 * 🔴 **The hand-maintained list has now fallen behind TWICE**, and the
	 * second time took the site down. Phase 10 added `Frontend\Renderer`
	 * without extending it — recorded in the docblock above — and M26e.4 added
	 * `LineScene` and `RenderRequester` the same way. Both times every test
	 * stayed green while a binding went unexercised.
	 *
	 * ⚠️ **A list is still the right shape for the resolution test**, for the
	 * reason stated above: resolving every registered id would pass trivially.
	 * But nothing was checking that the list KEPT UP, so this reads the ids
	 * `Plugin` actually registers and fails when one is missing here. The list
	 * stays hand-written; forgetting to extend it no longer stays silent.
	 */
	public function test_the_list_above_names_every_registered_service(): void {
		$registered = array();

		/*
		 * 📌 **Read by reflection rather than by widening `Container`.** An
		 * `ids()` method would exist solely for this assertion, and production
		 * API added for a test is API a future reader has to judge.
		 */
		$container  = $this->booted_container();
		$reflection = new \ReflectionProperty( $container, 'factories' );
		$reflection->setAccessible( true );

		foreach ( array_keys( (array) $reflection->getValue( $container ) ) as $id ) {
			$registered[ (string) $id ] = true;
		}

		$named = array();

		foreach ( $this->registered_services() as $row ) {
			$named[ $row[0] ] = true;
		}

		$missing = array_values( array_diff( array_keys( $registered ), array_keys( $named ) ) );

		sort( $missing );

		$this->assertSame(
			array(),
			$missing,
			"Plugin registers service(s) this test does not resolve:\n  " . implode( "\n  ", $missing )
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
