<?php
/**
 * Server-side enforcement at add-to-cart (M11.5).
 *
 * This is the security boundary for AC4 -- price is server-authoritative,
 * always. Everything the browser sends is a *selection key*; every amount is
 * looked up in the cached configuration. A request carrying `price`, `delta` or
 * `amount_minor` is not filtered, because nothing ever reads it.
 *
 * ## Five call sites, five registrations
 *
 * `woocommerce_add_to_cart_validation` is applied from five places in
 * WooCommerce 11.0.1, with three different arities:
 *
 * | Site | Args | Path |
 * |------|------|------|
 * | `class-wc-form-handler.php:981`  | 3 | simple product |
 * | `class-wc-form-handler.php:1013` | 3 | order-again; **second arg is an array** |
 * | `class-wc-form-handler.php:1063` | 5 | variable product |
 * | `class-wc-cart-session.php:615`  | 6 | **reorder**; sixth arg is `$cart_item_data` |
 * | `class-wc-ajax.php:520`          | 3 | shop-loop AJAX button |
 *
 * The milestone originally recorded three sites and instructed a five-argument
 * registration. Both were wrong, and the second wrongly in a way that loses
 * data: at five arguments the reorder site's `$cart_item_data` is discarded, and
 * on that path it is the **only** place the selection exists.
 *
 * ## One registration, at the maximum arity
 *
 * `accepted_args` is a property of the **registration**, not of the call site --
 * and WordPress runs every registration at every site. Registering five times,
 * once per site, therefore does not give each site its own arity: it runs the
 * callback five times on every add-to-cart, and the three registrations made at
 * three arguments never receive `$cart_item_data` even when the reorder site
 * supplies it. Measured: with five registrations, a valid reorder was refused,
 * because three of the five invocations saw no selection and voted no.
 *
 * `WP_Hook::apply_filters()` slices the arguments to `accepted_args` and passes
 * everything available when `accepted_args >= $num_args`:
 *
 * ```php
 * } elseif ( $the_['accepted_args'] >= $num_args ) {
 *     $value = call_user_func_array( $the_['function'], $args );   // no padding
 * ```
 *
 * So a single registration at **six** receives three arguments from a
 * three-argument site and six from the reorder site, with PHP's parameter
 * defaults filling the remainder. That is why every parameter after `$passed`
 * has a default -- not as defensive decoration, but because the same callback is
 * genuinely invoked with three, five and six arguments.
 *
 * ## Why an optionless AJAX add-to-cart refuses instead of validating
 *
 * `WC_AJAX::add_to_cart()` reads only `$_POST['product_id']` and `quantity`, and
 * calls `WC()->cart->add_to_cart()` with **no `cart_item_data` argument at all**.
 * `WC_Product_Simple` declares `supports[] = 'ajax_add_to_cart'`, and Phase 10
 * renders options on simple products -- so a shop-archive button would add an
 * optioned product with no selections attached and nothing for a validator to
 * inspect. Approving that is not validation, it is a bypass with a checkmark, so
 * it is refused and the customer is sent to the product page.
 *
 * **The test is "AJAX *and* no selection", not "AJAX".** Keying on
 * `wp_doing_ajax()` alone refused valid carts: it is true for every
 * `admin-ajax.php` request, and `WC_Form_Handler::add_to_cart_action()` runs on
 * `wp_loaded`, which fires during AJAX too -- so a theme submitting the ordinary
 * product form over AJAX was refused with the customer's full selection sitting
 * in `$_POST`. See `is_optionless_ajax_add_to_cart()` for why the branch is
 * narrowed rather than deleted.
 *
 * ## What this class does NOT do
 *
 * It decides, and does not persist. `Integration\CartItemData` attaches the
 * validated selection to the cart item, and `Integration\CartTotals` prices it.
 * Three classes rather than one because they run on three different hooks, and
 * because a filter that both judged and wrote would make the outcome depend on
 * which of WooCommerce's five validation call sites happened to fire.
 *
 * The selection is resolved twice — once here to decide, once in `CartItemData`
 * to attach. Passing state between the two through a property would make the
 * result depend on invocation order; re-resolving against the same cached config
 * is cheap and cannot disagree with itself.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\BasePrice;
use Optionia\Support\StoreClock;
use Optionia\Config\Repository;
use Optionia\Engine\Result;
use Optionia\Engine\SelectionResolver;
use Optionia\Support\Logger;
use Optionia\Support\Money;
use Optionia\Upload\UploadTokenCheck;

defined( 'ABSPATH' ) || exit;

/**
 * Validates every add-to-cart attempt against the cached configuration.
 */
final class AddToCartValidator {

	/**
	 * The filter every call site applies.
	 */
	public const HOOK = 'woocommerce_add_to_cart_validation';

	/**
	 * The call sites this validator must cover, and what each supplies.
	 *
	 * Documentation with teeth rather than a registration table: the single
	 * registration below takes `max()` of these, and a test asserts that the
	 * highest is six. Recording all five keeps the reason for that six visible,
	 * and gives `bin/check-architecture.sh` something to count -- a WooCommerce
	 * release that adds a sixth site should fail a gate, not go unnoticed.
	 *
	 * @var array<string, int>
	 */
	private const CALL_SITES = array(
		'form_handler_simple'   => 3,
		'form_handler_reorder'  => 3,
		'form_handler_variable' => 5,
		'cart_session_reorder'  => 6,
		'ajax_add_to_cart'      => 3,
		'store_api_cart'        => 6,
	);

	/**
	 * How far above the widest known call site to register.
	 *
	 * **Deliberately more than any site supplies, and it costs nothing.**
	 * `WP_Hook::apply_filters()` passes every available argument when
	 * `accepted_args >= $num_args` and pads nothing, so a three-argument site
	 * still delivers three. Measured across sites supplying 2, 4, 5 and 7
	 * arguments: the declared parameters fill exactly as they would at the
	 * matching arity.
	 *
	 * What it buys is the one thing a static gate cannot give. `CALL_SITES` is a
	 * record of what WooCommerce did when someone last looked, and that number
	 * has been wrong four times -- two, three, five, now six -- every time
	 * because a search covered one directory less than WooCommerce has. No check
	 * that reads our own map can notice a site nobody has found yet.
	 *
	 * `WP_Hook` caps delivery at `accepted_args`, so registering *at* the known
	 * maximum makes a seventh argument invisible by construction. Registering
	 * above it means `func_num_args()` sees the extra, and `validate()` says so.
	 *
	 * Do not "tidy" this back down to `max( CALL_SITES )`. The headroom is the
	 * mechanism, not an accident.
	 */
	private const ARITY_HEADROOM = 2;

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Error code: a file option's token names no file this visitor may use.
	 *
	 * ⚠️ **Raised here rather than by the resolver.** `Engine/` is pure and
	 * cannot reach the database, so it can only check the token's shape — which
	 * a purged token still satisfies.
	 */
	public const ERROR_FILE_MISSING = 'file_missing';

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Verifies file tokens, or null where uploads are not in play.
	 *
	 * @var UploadTokenCheck|null
	 */
	private ?UploadTokenCheck $files;

	/**
	 * Build a validator over the configuration cache.
	 *
	 * @param Repository            $config Configuration cache.
	 * @param Logger                $logger Logger.
	 * @param UploadTokenCheck|null $files  Verifies file tokens; optional so the
	 *                                      validator can be exercised without
	 *                                      the upload subsystem.
	 */
	public function __construct( Repository $config, Logger $logger, ?UploadTokenCheck $files = null ) {
		$this->config = $config;
		$this->logger = $logger;
		$this->files  = $files;
	}

	/**
	 * Register once, at the widest arity any call site uses.
	 *
	 * Derived from `CALL_SITES` rather than written as a literal `6`, so a newly
	 * discovered call site is covered by editing the map that documents it.
	 */
	public function register(): void {
		add_filter( self::HOOK, array( $this, 'validate' ), 10, self::registered_arity() );
	}

	/**
	 * The arity this validator registers at: the widest known site, plus headroom.
	 *
	 * See `ARITY_HEADROOM` for why it is not simply `max( CALL_SITES )`.
	 */
	public static function registered_arity(): int {
		return self::max_accepted_args() + self::ARITY_HEADROOM;
	}

	/**
	 * The widest argument count any known call site supplies.
	 */
	public static function max_accepted_args(): int {
		return max( self::CALL_SITES );
	}

	/**
	 * How many call sites this validator covers.
	 *
	 * Exposed so a test can assert the count without reaching into a private
	 * constant, and so the number lives in exactly one place.
	 */
	public static function call_site_count(): int {
		return count( self::CALL_SITES );
	}

	/**
	 * The arity each call site is registered at.
	 *
	 * @return array<string, int>
	 */
	public static function call_sites(): array {
		return self::CALL_SITES;
	}

	/**
	 * Validate one add-to-cart attempt.
	 *
	 * Every parameter after `$passed` has a default, because the same callback
	 * is invoked with three, five and six arguments.
	 *
	 * @param bool                      $passed          Whether validation has passed so far.
	 * @param mixed                     $product_or_item Product id, or the order-again `$item` array.
	 * @param mixed                     $quantity        Quantity; unused, WooCommerce validates it.
	 * @param int|null                  $variation_id    Variation id, on the five- and six-argument sites.
	 * @param array<string, mixed>|null $variations      Chosen variation attributes; unused here.
	 * @param array<string, mixed>|null $cart_item_data  Reorder payload, on the six-argument site only.
	 * @return bool Whether the item may be added.
	 */
	public function validate(
		$passed,
		$product_or_item = null,
		$quantity = null,
		$variation_id = null,
		$variations = null,
		$cart_item_data = null
	): bool {
		unset( $quantity, $variations );

		$this->warn_about_unknown_call_site( func_num_args() );

		/*
		 * Another plugin has already refused. Optionia does not overturn that,
		 * and re-running resolution would risk replacing a specific message with
		 * a generic one.
		 */
		if ( true !== $passed ) {
			return (bool) $passed;
		}

		$request = AddToCartRequest::from_filter(
			$product_or_item,
			is_numeric( $variation_id ) ? (int) $variation_id : null,
			is_array( $cart_item_data ) ? $cart_item_data : null,
			$this->source( $cart_item_data )
		);

		if ( 0 === $request->product_id() ) {
			return true;
		}

		$option_sets = $this->config->option_sets_for_product( $request->product_id() );

		/*
		 * No options on this product: nothing to enforce, and refusing would
		 * break every ordinary product in the store.
		 */
		if ( array() === $option_sets ) {
			return true;
		}

		if ( $this->is_optionless_ajax_add_to_cart( $cart_item_data, $request ) ) {
			return $this->refuse_ajax( $request );
		}

		$result = SelectionResolver::resolve(
			$option_sets,
			$request->selections(),
			$this->base_price_minor( $request ),
			StoreClock::today()
		);

		if ( $result->is_ok() ) {
			/*
			 * 🔴 **The resolver checked the token's shape, not its existence.**
			 * `Engine/` is pure and cannot reach the database, so a crafted
			 * 64-character string satisfies it — and so does a token whose file
			 * has since been released, which is exactly what `OrderAgain`
			 * replays when a customer reorders old artwork.
			 *
			 * ADR-040 puts that check here, once: refusing the line is what
			 * makes a purged file *fail loudly* rather than reaching a merchant
			 * as an order with artwork that does not exist.
			 */

			/*
			 * 🔴 **The resolver's own output, not the raw request.** The resolver
			 * canonicalises a file value — trimming it, among other things — and
			 * that canonical form is what `Integration\CartItemData` puts in the
			 * cart and what every later stage looks up. Checking the raw request
			 * meant checking a different string from the one that would be
			 * stored: a posted value carrying a trailing newline resolved
			 * cleanly, was looked up verbatim, matched **no row**, and the
			 * customer was told to re-upload a file that was already there.
			 */
			$resolved = $result->value()['resolved'] ?? array();

			if ( null !== $this->files && ! $this->files->passes( is_array( $resolved ) ? $resolved : array() ) ) {
				return $this->refuse(
					$request,
					Result::error( self::ERROR_FILE_MISSING, null, array() )
				);
			}

			return true;
		}

		return $this->refuse( $request, $result );
	}

	/**
	 * The product's own price, in minor units.
	 *
	 * Read from WooCommerce, never from the request. `WC_Product::get_price()`
	 * returns a decimal **string** (`"10.50"`), which is precisely the shape
	 * that Stage 5's audit found silently truncating to `10` under an `int`
	 * type hint -- so `Support\BasePrice` parses it rather than coercing it.
	 *
	 * Delegated since M16.1. This method held the only copy that resolved a
	 * **variation** id before its parent, and when `CartItemData` and
	 * `CartDisplay` needed the same lookup, a second and third copy would each
	 * have been a fresh chance to omit that rule -- on the path that freezes a
	 * price into an order. A parent variable product commonly has no price of
	 * its own, so the omission charges a percentage of nothing.
	 *
	 * @param AddToCartRequest $request The normalised attempt.
	 */
	private function base_price_minor( AddToCartRequest $request ): int {
		return BasePrice::minor( $request->product_id(), $request->variation_id() );
	}

	/**
	 * Warn when a call site supplies more arguments than any we know about.
	 *
	 * The only detector of a **new** WooCommerce call site that this plugin can
	 * have. `CALL_SITES` records what someone found when they last looked, and
	 * that number has been wrong four times running -- so a check that reads our
	 * own map confirms our bookkeeping, never WooCommerce's behaviour.
	 *
	 * Arriving with more arguments than the widest site we recorded means either
	 * a site we have never seen, or an existing one that grew. Both are reasons
	 * to look: the extra argument may carry a selection, as
	 * `$cart_item_data` does on the reorder and Store API sites, and a
	 * validator that ignores it validates less than it appears to.
	 *
	 * Warn rather than refuse. An unrecognised argument is not evidence of an
	 * attack, and failing a customer's add-to-cart over our own stale
	 * documentation would be the wrong trade -- the extra arguments are ignored
	 * safely, and everything we do know how to check still runs.
	 *
	 * @param int $received Argument count including `$passed`.
	 */
	private function warn_about_unknown_call_site( int $received ): void {
		$known = self::max_accepted_args();

		if ( $received <= $known ) {
			return;
		}

		$this->logger->warning(
			'An add-to-cart call site supplied more arguments than any recorded one.',
			array(
				'received'   => $received,
				'known_max'  => $known,
				'call_sites' => array_keys( self::CALL_SITES ),
			)
		);
	}

	/**
	 * Whether this is an AJAX add-to-cart that carries no selection at all.
	 *
	 * `WC_AJAX::add_to_cart()` reads only `product_id` and `quantity` and calls
	 * `WC()->cart->add_to_cart()` with **no `cart_item_data`**, so an optioned
	 * product added from the shop loop would arrive with nothing attached.
	 * Approving that is not validation, it is a bypass with a checkmark -- hence
	 * the refusal.
	 *
	 * ## Why `wp_doing_ajax()` alone is the wrong test
	 *
	 * It was the whole test, and it refused valid carts. `wp_doing_ajax()` is
	 * true for **every** `admin-ajax.php` request, and
	 * `WC_Form_Handler::add_to_cart_action()` is hooked to `wp_loaded`, which
	 * fires on AJAX requests too. So a theme that submits the ordinary product
	 * form over AJAX -- a common pattern for quick-add and off-canvas carts --
	 * was refused even though the customer's full, valid selection was sitting in
	 * `$_POST`. Measured: `AJAX + valid selection present -> REFUSED`.
	 *
	 * The failure was closed rather than dangerous -- nothing was mispriced --
	 * but the symptom a merchant sees is "add to cart does nothing", with no
	 * message and no obvious cause.
	 *
	 * ## Why the resolver alone cannot replace this
	 *
	 * The obvious fix is to delete this branch and let resolution decide. That
	 * reopens the original hole, and only in one case:
	 *
	 * | selection | required option | resolver alone |
	 * |-----------|-----------------|----------------|
	 * | empty     | yes             | refuses correctly |
	 * | present   | either          | validates correctly |
	 * | **empty** | **no**          | **accepts -- an optionless line, silently** |
	 *
	 * A product whose options are all optional would be added from the shop loop
	 * with none of them, which is exactly what this branch exists to stop.
	 *
	 * So the test is narrowed, not removed: refuse when the request is AJAX
	 * **and** no selection arrived. That is precisely the shape
	 * `WC_AJAX::add_to_cart()` produces and cannot be the shape a theme's form
	 * post produces, because a form post carries its fields.
	 *
	 * @param mixed            $cart_item_data The sixth argument, when the site supplies one.
	 * @param AddToCartRequest $request        The normalised attempt.
	 */
	private function is_optionless_ajax_add_to_cart( $cart_item_data, AddToCartRequest $request ): bool {
		if ( is_array( $cart_item_data ) ) {
			return false;
		}

		if ( array() !== $request->selections() ) {
			return false;
		}

		return function_exists( 'wp_doing_ajax' ) && wp_doing_ajax();
	}

	/**
	 * Refuse an AJAX add-to-cart for a product that has options.
	 *
	 * @param AddToCartRequest $request The normalised attempt.
	 * @return bool Always false.
	 */
	private function refuse_ajax( AddToCartRequest $request ): bool {
		$this->logger->info(
			'Refused an AJAX add-to-cart for a product with options.',
			array(
				'product_id' => $request->product_id(),
				'source'     => $request->source(),
			)
		);

		$this->notice(
			__( 'This product has options that must be chosen. Please open the product page to add it to your cart.', 'optionia' )
		);

		return false;
	}

	/**
	 * Refuse an attempt whose selections did not resolve.
	 *
	 * @param AddToCartRequest $request The normalised attempt.
	 * @param Result           $result  The failed resolution.
	 * @return bool Always false.
	 */
	private function refuse( AddToCartRequest $request, Result $result ): bool {
		$this->logger->info(
			'Refused an add-to-cart whose selections did not validate.',
			array(
				'product_id' => $request->product_id(),
				'source'     => $request->source(),
				'error'      => $result->first_error_code(),
			)
		);

		foreach ( $result->get_errors() as $error ) {
			$this->notice( $this->message_for( (string) ( $error['code'] ?? '' ) ) );
		}

		return false;
	}

	/**
	 * A customer-facing message for an error code.
	 *
	 * Deliberately unspecific about *why* a key was rejected. A message naming
	 * the option ids a product does or does not have would answer, for anyone
	 * who asked, what another tenant's configuration looks like.
	 *
	 * @param string $code Error code from the resolver.
	 */
	private function message_for( string $code ): string {
		if ( self::ERROR_FILE_MISSING === $code ) {
			/*
			 * 🔴 **Names the remedy, because the customer can act on it.** The
			 * commonest cause is a reorder whose artwork has since been
			 * released, and "please review your options" would send them looking
			 * at a field that appears filled in. ADR-040 asks this to fail
			 * loudly: a reorder that says "upload it again" is better than a
			 * reprint that arrives blank.
			 */
			return __( 'Please upload your file again before adding this product to your cart.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_REQUIRED === $code ) {
			return __( 'Please choose all required options before adding this product to your cart.', 'optionia' );
		}

		/*
		 * 🔴 **A length error must not read as "unavailable".**
		 *
		 * The generic message says the *selection* is not available and asks the
		 * customer to review the options. For someone who typed a long engraving
		 * that is both wrong and unactionable: nothing is unavailable, and
		 * reviewing the options will not tell them the text was too long.
		 *
		 * Still deliberately unspecific about the *limit*. The counter beside the
		 * field already shows it, and a message naming numbers the page does not
		 * would be a second source of truth to keep in step.
		 */

		/*
		 * The content rules, each naming what to change.
		 *
		 * ⚠️ **None of them repeats the rule itself.** A pattern is a regex the
		 * customer cannot read, a charset name means nothing to them, and echoing
		 * a forbidden word back at the person who typed it is not an improvement.
		 * The field's own help text is where a merchant explains what they want.
		 */
		if ( SelectionResolver::ERROR_PATTERN === $code ) {
			return __( 'That text is not in the format this option needs. Please check it and try again.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_CHARSET === $code ) {
			return __( 'That text uses characters this option does not accept. Please try again.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_FORBIDDEN_WORD === $code ) {
			return __( 'That text cannot be used on this product. Please enter something else.', 'optionia' );
		}

		/*
		 * The numeric failures each name a different remedy.
		 *
		 * A customer told "that selection is not available" for a quantity of
		 * 3.5 would have no idea the field wanted whole numbers. Deliberately
		 * unspecific about the *bound* — the input already carries `min`, `max`
		 * and `step`, and a message repeating them is a second source of truth
		 * to keep in step.
		 */
		if ( SelectionResolver::ERROR_NOT_A_NUMBER === $code ) {
			return __( 'Please enter a number for this option.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_OUT_OF_RANGE === $code ) {
			return __( 'That number is outside the range this option allows. Please choose another.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_BAD_STEP === $code ) {
			return __( 'That number is not one this option accepts. Please check the allowed steps.', 'optionia' );
		}

		/*
		 * A different instruction from `too_long`, because a different action
		 * fixes it — and emphatically not the `required` message, which would
		 * send a customer looking for a field they already filled.
		 */
		if ( SelectionResolver::ERROR_TOO_SHORT === $code ) {
			return __( 'Your text is shorter than this option allows. Please add a little more and try again.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_TOO_LONG === $code ) {
			return __( 'Your text is longer than this option allows. Please shorten it and try again.', 'optionia' );
		}

		/*
		 * 🔴 **Two counts, two messages, because two different actions fix
		 * them.** "Choose more" and "choose fewer" are opposite instructions,
		 * and the generic *"that selection is not available"* would tell a
		 * customer who ticked three boxes to go looking for something
		 * unavailable rather than to untick one.
		 *
		 * ⚠️ **Still not naming the number.** The form shows the limit beside
		 * the option, and a message repeating it is a second source of truth to
		 * keep in step — the same reasoning the length messages record.
		 */
		if ( SelectionResolver::ERROR_TOO_FEW === $code ) {
			return __( 'Please choose more options for this product before adding it to your cart.', 'optionia' );
		}

		if ( SelectionResolver::ERROR_TOO_MANY === $code ) {
			return __( 'You have chosen more options than this product allows. Please remove some and try again.', 'optionia' );
		}

		/*
		 * A different message, because a different action fixes it. The customer
		 * cannot shorten "the" field — every field was individually acceptable
		 * and the request as a whole was not, so the instruction has to be about
		 * the total.
		 */
		if ( SelectionResolver::ERROR_TOO_MUCH_TEXT === $code ) {
			return __( 'There is too much text on this product in total. Please shorten your entries and try again.', 'optionia' );
		}

		return __( 'Sorry, that selection is not available. Please review the options and try again.', 'optionia' );
	}

	/**
	 * Show a customer-facing notice, if WooCommerce is there to show it.
	 *
	 * @param string $message Already-translated message.
	 */
	private function notice( string $message ): void {
		if ( function_exists( 'wc_add_notice' ) ) {
			wc_add_notice( $message, 'error' );
		}
	}

	/**
	 * Which call site this invocation most likely came from, for logging.
	 *
	 * Best-effort: three of the five sites are indistinguishable from their
	 * arguments alone. Used only in log context, never in a decision -- the
	 * decisions above key on the data present, not on a guessed origin.
	 *
	 * @param mixed $cart_item_data The sixth argument, when the site supplies one.
	 */
	private function source( $cart_item_data ): string {
		if ( is_array( $cart_item_data ) ) {
			return 'cart_session_reorder';
		}

		if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
			return 'ajax_add_to_cart';
		}

		return 'form_handler';
	}
}
