<?php
/**
 * Plugin bootstrap and service wiring.
 *
 * Reading this file should be enough to understand the plugin's shape: what
 * exists, what depends on what, and in which order things register. Principle 1
 * (layered, one-way dependencies) is visible in register_services() — nothing
 * in Engine\ receives a WordPress-aware collaborator.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia;

use Optionia\Activation\Migrator;
use Optionia\Activation\Scheduler;
use Optionia\Admin\Menu;
use Optionia\Admin\OrderFiles;
use Optionia\Admin\Notices;
use Optionia\Admin\ConnectionSection;
use Optionia\Admin\SchemaNotice;
use Optionia\Admin\UnpricedTypesNotice;
use Optionia\Admin\ReconnectNotice;
use Optionia\Admin\SettingsPage;
use Optionia\Admin\SystemStatus;
use Optionia\Api\Client;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Connection\Heartbeat;
use Optionia\Reporting\OrderPayload;
use Optionia\Reporting\OrderQueue;
use Optionia\Reporting\OrderReporter;
use Optionia\Connection\PushEndpoint;
use Optionia\Upload\UploadEndpoint;
use Optionia\Upload\UploadQuota;
use Optionia\Upload\UploadRepository;
use Optionia\Upload\UploadRetention;
use Optionia\Upload\MovesUploadedFiles;
use Optionia\Upload\UploadImage;
use Optionia\Upload\UploadMover;
use Optionia\Upload\UploadArchive;
use Optionia\Upload\UploadDownload;
use Optionia\Upload\UploadExpirer;
use Optionia\Upload\UploadLink;
use Optionia\Upload\UploadPromoter;
use Optionia\Upload\UploadRules;
use Optionia\Upload\UploadStore;
use Optionia\Upload\UploadTokenCheck;
use Optionia\Upload\UploadSweeper;
use Optionia\Connection\StateMachine;
use Optionia\Api\CircuitBreaker;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Repository;
use Optionia\Config\Synchroniser;
use Optionia\Frontend\Assets;
use Optionia\Frontend\Renderer;
use Optionia\Integration\AddToCartValidator;
use Optionia\Integration\CartItemData;
use Optionia\Integration\CartDisplay;
use Optionia\Integration\CartItemKey;
use Optionia\Integration\CartTotals;
use Optionia\Integration\CheckoutValidator;
use Optionia\Integration\OrderAgain;
use Optionia\Integration\OrderLineItem;
use Optionia\Frontend\Templates;
use Optionia\Support\Assert;
use Optionia\Support\Cron;
use Optionia\Support\Environment;
use Optionia\Support\Logger;
use Optionia\Support\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Singleton entry point.
 */
final class Plugin {

	/**
	 * The booted instance, or null before boot.
	 *
	 * @var Plugin|null
	 */
	private static ?Plugin $instance = null;

	/**
	 * Service container.
	 *
	 * @var Container
	 */
	private Container $container;

	/**
	 * Private: use boot().
	 */
	private function __construct() {
		$this->container = new Container();
	}

	/**
	 * Boot the plugin. Registered on `plugins_loaded`.
	 *
	 * Ordering matters and is deliberate:
	 * 1. Defer translation loading to `init` (WordPress 6.7 requirement).
	 * 2. Core services, so the logger exists before anything can fail.
	 * 3. Requirement check — bail early, having registered only the notice.
	 * 4. Everything else.
	 */
	public static function boot(): void {
		if ( null !== self::$instance ) {
			return;
		}

		$plugin = new self();

		$plugin->register_textdomain();
		$plugin->register_core_services();

		// Assertions need a logger before any other code can trip one.
		Assert::set_logger( $plugin->logger() );

		$environment = new Environment();
		$problems    = $environment->unmet_requirements();

		if ( array() !== $problems ) {
			// Requirements unmet: register the notice and stop. No WooCommerce
			// hooks are touched, so the site continues to work normally (M3.3).
			( new Notices( $problems, $environment ) )->register();

			$plugin->logger()->warning(
				'Optionia did not boot: unmet requirements.',
				array( 'problems' => wp_list_pluck( $problems, 'code' ) )
			);

			self::$instance = $plugin;

			return;
		}

		$plugin->register_services();
		$plugin->register_hooks();

		self::$instance = $plugin;

		/**
		 * Fires once Optionia has fully booted.
		 *
		 * Third-party code should hook here rather than `plugins_loaded`, as it
		 * guarantees requirements are satisfied and services are available.
		 *
		 * @param Container $container Service container.
		 */
		do_action( 'optionia_booted', $plugin->container );
	}

	/**
	 * The booted instance, or null when boot() has not run.
	 */
	public static function instance(): ?Plugin {
		return self::$instance;
	}

	/**
	 * Service container access, for tests and extensions.
	 */
	public function container(): Container {
		return $this->container;
	}

	/**
	 * Register translation loading.
	 *
	 * Deferred to `init`: WordPress 6.7 warns when a text domain is loaded on
	 * `plugins_loaded`, because translations are not ready that early. Strings
	 * are therefore built lazily at render time rather than at boot — see
	 * Support\Environment, which returns translatable messages that are only
	 * evaluated when a notice is actually displayed.
	 */
	private function register_textdomain(): void {
		add_action(
			'init',
			static function (): void {
				load_plugin_textdomain(
					'optionia',
					false,
					dirname( plugin_basename( OPTIONIA_PLUGIN_FILE ) ) . '/languages'
				);
			}
		);
	}

	/**
	 * Services required before the requirement check.
	 *
	 * Kept to the infrastructure layer only: settings, logging, environment.
	 * None of these touch WooCommerce, so they are safe to construct when
	 * WooCommerce is absent.
	 */
	private function register_core_services(): void {
		$this->container->set(
			Settings::class,
			static fn (): Settings => new Settings()
		);

		$this->container->set(
			Logger::class,
			static fn ( Container $c ): Logger => new Logger( $c->get( Settings::class ) )
		);

		$this->container->set(
			Environment::class,
			static fn (): Environment => new Environment()
		);
	}

	/**
	 * Services requiring a satisfied environment.
	 *
	 * Dependency direction is visible here and flows one way:
	 * infrastructure ← domain ← integration.
	 */
	private function register_services(): void {
		// --- Infrastructure -------------------------------------------------
		$this->container->set(
			CircuitBreaker::class,
			static fn ( Container $c ): CircuitBreaker => new CircuitBreaker( $c->get( Logger::class ) )
		);

		$this->container->set(
			ResponseValidator::class,
			static fn (): ResponseValidator => new ResponseValidator()
		);

		$this->container->set(
			Client::class,
			static fn ( Container $c ): Client => new Client(
				$c->get( Settings::class ),
				$c->get( Logger::class ),
				$c->get( CircuitBreaker::class ),
				$c->get( ResponseValidator::class )
			)
		);

		// The connection flow (M8.3). Both take the API client through
		// `PostsToCloud`, the seam that keeps `Client` final.
		$this->container->set(
			Handshake::class,
			static fn ( Container $c ): Handshake => new Handshake( $c->get( Client::class ) )
		);

		$this->container->set(
			Callback::class,
			static fn ( Container $c ): Callback => new Callback( $c->get( Client::class ) )
		);

		$this->container->set(
			ConnectionSection::class,
			static fn ( Container $c ): ConnectionSection => new ConnectionSection(
				$c->get( Handshake::class ),
				$c->get( Callback::class ),
				$c->get( CircuitBreaker::class ),
				$c->get( Synchroniser::class ),
				$c->get( Client::class )
			)
		);

		$this->container->set(
			Repository::class,
			static fn ( Container $c ): Repository => new Repository( $c->get( Logger::class ) )
		);

		$this->container->set(
			Synchroniser::class,
			static fn ( Container $c ): Synchroniser => new Synchroniser(
				$c->get( Client::class ),
				$c->get( Repository::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			PushEndpoint::class,
			static fn ( Container $c ): PushEndpoint => new PushEndpoint(
				$c->get( Synchroniser::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			UploadStore::class,
			static fn ( Container $c ): UploadStore => new UploadStore( $c->get( Logger::class ) )
		);

		$this->container->set(
			UploadRepository::class,
			static fn (): UploadRepository => new UploadRepository()
		);

		/*
		 * The quota is typed to `ReportsSessionUsage`, so it receives the
		 * repository through that seam rather than by concrete class -- it reads
		 * usage and must not be able to create, claim or delete an upload.
		 */
		$this->container->set(
			UploadQuota::class,
			static fn ( Container $c ): UploadQuota => new UploadQuota( $c->get( UploadRepository::class ) )
		);

		/*
		 * The merchant's per-option rules, read from the same cached document
		 * the renderer draws from — so the `accept` attribute a customer sees and
		 * the rule the server enforces cannot disagree.
		 */
		$this->container->set(
			UploadRules::class,
			static fn ( Container $c ): UploadRules => new UploadRules( $c->get( Repository::class ) )
		);

		$this->container->set(
			UploadImage::class,
			static fn ( Container $c ): UploadImage => new UploadImage( $c->get( Logger::class ) )
		);

		$this->container->set(
			MovesUploadedFiles::class,
			static fn ( Container $c ): MovesUploadedFiles => new UploadMover( $c->get( Logger::class ) )
		);

		$this->container->set(
			UploadPromoter::class,
			static fn ( Container $c ): UploadPromoter => new UploadPromoter(
				$c->get( UploadRepository::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			OrderFiles::class,
			static fn ( Container $c ): OrderFiles => new OrderFiles(
				$c->get( UploadRepository::class ),
				$c->get( UploadArchive::class ),
				$c->get( UploadLink::class )
			)
		);

		$this->container->set(
			UploadLink::class,
			static fn (): UploadLink => new UploadLink()
		);

		$this->container->set(
			UploadArchive::class,
			static fn ( Container $c ): UploadArchive => new UploadArchive(
				$c->get( UploadRepository::class ),
				$c->get( UploadStore::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			UploadDownload::class,
			static fn ( Container $c ): UploadDownload => new UploadDownload(
				$c->get( UploadRepository::class ),
				$c->get( UploadStore::class ),
				$c->get( UploadArchive::class ),
				$c->get( UploadLink::class ),
				$c->get( UploadImage::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			UploadRetention::class,
			static fn ( Container $c ): UploadRetention => new UploadRetention(
				$c->get( UploadRepository::class ),
				$c->get( UploadStore::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			UploadTokenCheck::class,
			static fn ( Container $c ): UploadTokenCheck => new UploadTokenCheck(
				$c->get( UploadRepository::class ),
				$c->get( UploadQuota::class )
			)
		);

		$this->container->set(
			UploadExpirer::class,
			static fn ( Container $c ): UploadExpirer => new UploadExpirer(
				$c->get( UploadRepository::class ),
				$c->get( UploadStore::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			UploadSweeper::class,
			static fn ( Container $c ): UploadSweeper => new UploadSweeper(
				$c->get( UploadStore::class ),
				$c->get( Logger::class ),
				$c->get( UploadExpirer::class )
			)
		);

		$this->container->set(
			UploadEndpoint::class,
			static fn ( Container $c ): UploadEndpoint => new UploadEndpoint(
				$c->get( UploadStore::class ),
				$c->get( UploadRepository::class ),
				$c->get( UploadQuota::class ),
				$c->get( UploadRules::class ),
				$c->get( UploadImage::class ),
				$c->get( MovesUploadedFiles::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			Cron::class,
			static fn ( Container $c ): Cron => new Cron(
				$c->get( Logger::class ),
				$c->get( Synchroniser::class )
			)
		);

		$this->container->set(
			Heartbeat::class,
			static fn ( Container $c ): Heartbeat => new Heartbeat(
				$c->get( Client::class ),
				$c->get( Repository::class ),
				$c->get( Logger::class ),
				$c->get( UploadRepository::class )
			)
		);

		// --- Order reporting (M12.7) ----------------------------------------
		$this->container->set(
			OrderQueue::class,
			static fn ( Container $c ): OrderQueue => new OrderQueue( $c->get( Logger::class ) )
		);

		$this->container->set(
			OrderPayload::class,
			static fn (): OrderPayload => new OrderPayload()
		);

		$this->container->set(
			OrderReporter::class,
			static fn ( Container $c ): OrderReporter => new OrderReporter(
				$c->get( Client::class ),
				$c->get( OrderQueue::class ),
				$c->get( OrderPayload::class ),
				$c->get( Logger::class )
			)
		);

		// --- Presentation ---------------------------------------------------
		$this->container->set(
			Templates::class,
			static fn ( Container $c ): Templates => new Templates( $c->get( Logger::class ) )
		);

		$this->container->set(
			Assets::class,
			static fn (): Assets => new Assets()
		);

		$this->container->set(
			Renderer::class,
			static fn ( Container $c ): Renderer => new Renderer(
				$c->get( Repository::class ),
				$c->get( Templates::class ),
				$c->get( Assets::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			AddToCartValidator::class,
			static fn ( Container $c ): AddToCartValidator => new AddToCartValidator(
				$c->get( Repository::class ),
				$c->get( Logger::class ),
				$c->get( UploadTokenCheck::class )
			)
		);

		$this->container->set(
			CartItemData::class,
			static fn ( Container $c ): CartItemData => new CartItemData(
				$c->get( Repository::class )
			)
		);

		$this->container->set(
			CartItemKey::class,
			static fn ( Container $c ): CartItemKey => new CartItemKey(
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			CartTotals::class,
			static fn ( Container $c ): CartTotals => new CartTotals(
				$c->get( Repository::class ),
				$c->get( Logger::class )
			)
		);

		$this->container->set(
			CheckoutValidator::class,
			static fn ( Container $c ): CheckoutValidator => new CheckoutValidator(
				$c->get( Repository::class ),
				$c->get( Logger::class ),
				$c->get( UploadTokenCheck::class )
			)
		);

		$this->container->set(
			OrderLineItem::class,
			static fn (): OrderLineItem => new OrderLineItem()
		);

		$this->container->set(
			CartDisplay::class,
			static fn ( Container $c ): CartDisplay => new CartDisplay(
				$c->get( Repository::class )
			)
		);

		$this->container->set(
			OrderAgain::class,
			static fn (): OrderAgain => new OrderAgain()
		);

		// --- Admin ----------------------------------------------------------
		$this->container->set(
			SystemStatus::class,
			static fn ( Container $c ): SystemStatus => new SystemStatus(
				$c->get( Environment::class ),
				$c->get( Repository::class ),
				$c->get( Settings::class ),
				$c->get( Cron::class ),
				$c->get( CircuitBreaker::class )
			)
		);

		$this->container->set(
			SettingsPage::class,
			static fn ( Container $c ): SettingsPage => new SettingsPage(
				$c->get( Settings::class ),
				$c->get( ConnectionSection::class )
			)
		);

		$this->container->set(
			Menu::class,
			static fn ( Container $c ): Menu => new Menu(
				$c->get( SystemStatus::class ),
				$c->get( SettingsPage::class )
			)
		);
	}

	/**
	 * Register WordPress hooks.
	 *
	 * Each subscriber owns its own hooks; this method only decides which
	 * subscribers are active, so the hook surface stays discoverable.
	 */
	private function register_hooks(): void {
		$this->container->get( Cron::class )->register();
		// Registered outside `is_admin()`: WP-Cron fires on front-end requests,
		// so an admin-only listener would leave the scheduled hook orphaned.
		$this->container->get( Heartbeat::class )->register();
		// Registered outside `is_admin()` for two reasons: the status hook fires
		// in the checkout request, which is a front-end one, and the drain runs
		// on cron. An admin-only registration would queue nothing and drain
		// nothing -- the feature would be silently absent in production.
		$this->container->get( OrderReporter::class )->register();
		// Registered outside `is_admin()`: a REST request is neither an admin
		// request nor a cron one, so an admin-only registration would leave the
		// route undeclared exactly when the cloud tries to use it.
		$this->container->get( PushEndpoint::class )->register();
		// Registered outside `is_admin()` for the same reason, one step further:
		// this route is reached by a *customer's browser* on the storefront, so
		// an admin-only registration would leave it undeclared for every real
		// caller and declared only for the one caller that never uses it.
		$this->container->get( UploadEndpoint::class )->register();
		// Registered outside `is_admin()`: cron fires on a customer's request, so
		// an admin-only registration would attach the sweep to nothing on the
		// requests that actually run it.
		$this->container->get( UploadSweeper::class )->register();
		// Registered outside `is_admin()`: checkout happens on the storefront and
		// through the Store API, so an admin-only registration would leave every
		// real order's files unclaimed.
		$this->container->get( UploadPromoter::class )->register();
		// Registered outside `is_admin()`: an order can be deleted by WP-CLI, a
		// scheduled cleanup, or the REST API, and an admin-only registration
		// would leak files on exactly the paths a merchant never watches.
		$this->container->get( UploadRetention::class )->register();
		$this->container->get( UploadDownload::class )->register();
		// Registered outside `is_admin()`, unlike the other admin screens: this
		// also adds a download link to the merchant's order email, and that email
		// is sent during checkout -- a storefront request, where an admin-only
		// registration would attach the hook to nothing.
		$this->container->get( OrderFiles::class )->register();
		$this->container->get( Assets::class )->register();
		$this->container->get( Renderer::class )->register();
		// Registered outside `is_admin()`: add-to-cart happens on the storefront
		// and over AJAX, and this is the AC4 boundary -- an admin-only
		// registration would leave every customer request unchecked.
		$this->container->get( AddToCartValidator::class )->register();
		// Registered outside `is_admin()` for the same reason as the validator:
		// the cart is a storefront and AJAX concern, and a line whose selections
		// were never attached is a line that can never be priced.
		$this->container->get( CartItemData::class )->register();
		// Registered beside the writer: the key filter exists so the fields the
		// writer adds do not split a cart line that should merge.
		$this->container->get( CartItemKey::class )->register();
		// One filter serves the classic cart template and the Store API, so the
		// block cart needs no separate integration (M12.2).
		$this->container->get( CartDisplay::class )->register();
		$this->container->get( CartTotals::class )->register();
		// The AC4 boundary at checkout: price is frozen, validity is not. A line
		// whose option no longer exists must not reach an order (M12.4).
		$this->container->get( CheckoutValidator::class )->register();
		// Registered outside `is_admin()`: checkout happens on the storefront and
		// over the Store API, and the hidden-key filter is read on the admin
		// order screen -- both surfaces need it (M12.5).
		$this->container->get( OrderLineItem::class )->register();
		// Reorder runs on a front-end GET with a nonce, so this is not admin-only
		// (M12.8). Selections only: a reorder reprices from current config.
		$this->container->get( OrderAgain::class )->register();

		// Self-heal deferred work on `init`, once translations and all plugins
		// are loaded. Two cases this covers that activation cannot:
		// - a plugin *update*, which replaces files without firing activation;
		// - a schedule cleared while the plugin was inactive but WooCommerce was
		// being toggled, leaving Optionia active with no scheduled sync.
		// The connection state machine listens for a revoked credential (M8.6).
		// Registered outside `is_admin()`: a storefront request that gets a 401
		// must record it too, or the state depends on who happened to visit.
		StateMachine::listen();

		add_action( 'init', array( $this, 'ensure_deferred_setup' ) );

		if ( is_admin() ) {
			$this->container->get( Menu::class )->register();
			$this->container->get( SettingsPage::class )->register();
			$this->container->get( ConnectionSection::class )->register();
			( new ReconnectNotice() )->register();
			( new SchemaNotice() )->register();
			( new UnpricedTypesNotice() )->register();
		}

		// Declares compatibility with High-Performance Order Storage. Without
		// this, WooCommerce shows the plugin as incompatible and merchants are
		// blocked from enabling HPOS.
		add_action( 'before_woocommerce_init', array( $this, 'declare_woocommerce_compatibility' ) );

		// WooCommerce deactivated while Optionia is active: notify rather than
		// fatal on the next request.
		add_action( 'deactivated_plugin', array( $this, 'on_plugin_deactivated' ), 10, 1 );
	}

	/**
	 * Run version upgrades and repair scheduled work.
	 *
	 * Deliberately cheap on the happy path — one option read and a string
	 * comparison for the upgrade check, one cron lookup for the schedule — since
	 * this runs on every request.
	 */
	public function ensure_deferred_setup(): void {
		( new Migrator( $this->logger() ) )->maybe_upgrade();

		Scheduler::schedule();
	}

	/**
	 * Declare feature compatibility with WooCommerce.
	 */
	public function declare_woocommerce_compatibility(): void {
		if ( ! class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			return;
		}

		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
			'custom_order_tables',
			OPTIONIA_PLUGIN_FILE,
			true
		);

		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
			'cart_checkout_blocks',
			OPTIONIA_PLUGIN_FILE,
			true
		);
	}

	/**
	 * React to WooCommerce being deactivated.
	 *
	 * Optionia stays active and serves its cached configuration; only the
	 * WooCommerce integration is inert. Deactivating ourselves would be a
	 * surprising side effect of a merchant troubleshooting something else.
	 *
	 * @param string $plugin Plugin file that was deactivated.
	 */
	public function on_plugin_deactivated( string $plugin ): void {
		if ( 'woocommerce/woocommerce.php' !== $plugin ) {
			return;
		}

		$this->logger()->warning( 'WooCommerce was deactivated; Optionia integration is inactive.' );
	}

	/**
	 * Logger shortcut.
	 */
	private function logger(): Logger {
		$logger = $this->container->get( Logger::class );
		assert( $logger instanceof Logger );

		return $logger;
	}
}
