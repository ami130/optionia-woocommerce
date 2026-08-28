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
use Optionia\Admin\Notices;
use Optionia\Admin\ConnectionSection;
use Optionia\Admin\SettingsPage;
use Optionia\Admin\SystemStatus;
use Optionia\Api\Client;
use Optionia\Connection\Callback;
use Optionia\Connection\Handshake;
use Optionia\Api\CircuitBreaker;
use Optionia\Api\ResponseValidator;
use Optionia\Config\Repository;
use Optionia\Frontend\Assets;
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
				$c->get( Callback::class )
			)
		);

		$this->container->set(
			Repository::class,
			static fn ( Container $c ): Repository => new Repository( $c->get( Logger::class ) )
		);

		$this->container->set(
			Cron::class,
			static fn ( Container $c ): Cron => new Cron( $c->get( Logger::class ) )
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
		$this->container->get( Assets::class )->register();

		// Self-heal deferred work on `init`, once translations and all plugins
		// are loaded. Two cases this covers that activation cannot:
		// - a plugin *update*, which replaces files without firing activation;
		// - a schedule cleared while the plugin was inactive but WooCommerce was
		// being toggled, leaving Optionia active with no scheduled sync.
		add_action( 'init', array( $this, 'ensure_deferred_setup' ) );

		if ( is_admin() ) {
			$this->container->get( Menu::class )->register();
			$this->container->get( SettingsPage::class )->register();
			$this->container->get( ConnectionSection::class )->register();
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
