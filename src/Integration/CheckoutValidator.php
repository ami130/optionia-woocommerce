<?php
/**
 * Blocks checkout when a cart line references an option that no longer exists
 * (M12.4).
 *
 * 🔴 **Phase 4 proved what happens without this.** An option was deleted from
 * the configuration while it sat in a customer's cart, and checkout completed:
 *
 * ```text
 * Order #32   HTTP 200   status: processing
 * Total:      $100.00
 * Meta:       "Finish: Luxury"        <- option no longer exists
 * ```
 *
 * The merchant was paid for something they could no longer make, and nothing
 * anywhere said so.
 *
 * ## Price is frozen; validity is not
 *
 * These are deliberately different, and the distinction is the whole milestone:
 *
 * | Situation | Policy |
 * |---|---|
 * | Option **price** changed since add-to-cart | Honour the quote (`Integration\CartTotals`) |
 * | Option **deleted**, disabled or invalid | **Block checkout**, here |
 *
 * Freezing a price is customer-fair. Freezing *validity* sells phantom products.
 *
 * ## Why a notice, and not a return value or an exception
 *
 * `woocommerce_check_cart_items` is a plain action -- it has no return value and
 * cannot itself refuse anything. The blocking contract is a **notice**
 * (WC 11.0.1, `includes/class-wc-checkout.php:1409`):
 *
 * ```php
 * if ( empty( $posted_data['woocommerce_checkout_update_totals'] ) && 0 === wc_notice_count( 'error' ) ) {
 *     $order_id = $this->create_order( $posted_data );
 * ```
 *
 * One error notice and no order is created. On the Store API the same notice is
 * converted by `NoticeHandler::convert_notices_to_wp_errors()` into a **409
 * `InvalidCartException`** -- so one mechanism blocks both worlds, and a thrown
 * exception would escape that conversion and surface as a 500 instead of an
 * error the customer can act on.
 *
 * The notice must also be raised **during** the hook. The Store API saves the
 * session's notices before the action and restores them after
 * (`src/StoreApi/Utilities/CartController.php:506-529`), so a notice raised
 * anywhere else -- during `calculate_totals()`, say -- is discarded on that path.
 * That is why `CartTotals` logs the same condition and does not try to block
 * with it.
 *
 * ## Four call sites, and two of them are page views
 *
 * ```text
 * includes/class-wc-checkout.php:355                        checkout submission
 * includes/shortcodes/class-wc-shortcode-cart.php:93        cart page view
 * includes/shortcodes/class-wc-shortcode-checkout.php:349   checkout page view
 * src/StoreApi/Utilities/CartController.php:525             block cart / checkout
 * ```
 *
 * The page-view sites are why this must be idempotent: a customer sitting on the
 * cart page can trigger the hook repeatedly, and three copies of the same
 * message is a worse experience than the problem it describes. Core also unhooks
 * its own validators before firing on the Store API path, so nothing here may
 * assume core's checks have run.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Integration;

use Optionia\Support\StoreClock;
use Optionia\Config\Repository;
use Optionia\Engine\SelectionResolver;
use Optionia\Support\Keys;
use Optionia\Support\Logger;
use Optionia\Upload\UploadTokenCheck;

defined( 'ABSPATH' ) || exit;

/**
 * Re-validates every cart line against the current configuration.
 */
final class CheckoutValidator {

	/**
	 * The action every checkout and cart surface fires.
	 */
	public const HOOK = 'woocommerce_check_cart_items';

	/**
	 * The surfaces that fire it, and what each one is.
	 *
	 * Recorded for the same reason `AddToCartValidator::CALL_SITES` is: the count
	 * has been wrong five times in this project, always by searching one
	 * directory less than WooCommerce has. Two of these are page *views* rather
	 * than submissions, which is what makes idempotence a requirement rather than
	 * a nicety.
	 *
	 * @var array<string, string>
	 */
	private const CALL_SITES = array(
		'checkout_submission' => 'includes/class-wc-checkout.php:355',
		'cart_page_view'      => 'includes/shortcodes/class-wc-shortcode-cart.php:93',
		'checkout_page_view'  => 'includes/shortcodes/class-wc-shortcode-checkout.php:349',
		'store_api_cart'      => 'src/StoreApi/Utilities/CartController.php:525',
	);

	/**
	 * Configuration cache.
	 *
	 * @var Repository
	 */
	private Repository $config;

	/**
	 * Logger.
	 *
	 * @var Logger
	 */
	private Logger $logger;

	/**
	 * Lines already reported during this request.
	 *
	 * The hook fires from four surfaces and two of them are page views, so one
	 * request can trigger it several times. Keyed by cart item key so a customer
	 * with two broken lines still hears about both.
	 *
	 * @var array<string, bool>
	 */
	private array $reported = array();

	/**
	 * Error code: a file option's token names no file this visitor may use.
	 *
	 * ⚠️ **Not a resolver code.** `Engine/` is pure and cannot reach the
	 * database, so it validates the token's shape and nothing more — and a
	 * purged token still has a valid shape.
	 */
	public const ERROR_FILE_MISSING = 'file_missing';

	/**
	 * Verifies file tokens, or null where uploads are not in play.
	 *
	 * @var UploadTokenCheck|null
	 */
	private ?UploadTokenCheck $files;

	/**
	 * Build over the configuration cache.
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
	 * Register the re-validation hook.
	 *
	 * One registration covers all four surfaces, because they all fire the same
	 * action.
	 */
	public function register(): void {
		add_action( self::HOOK, array( $this, 'validate' ) );
	}

	/**
	 * How many surfaces fire this hook.
	 *
	 * Exposed so a test can assert the count without reaching into a private
	 * constant, and so the number lives in one place.
	 */
	public static function call_site_count(): int {
		return count( self::CALL_SITES );
	}

	/**
	 * The surfaces that fire this hook, and where each one is.
	 *
	 * @return array<string, string>
	 */
	public static function call_sites(): array {
		return self::CALL_SITES;
	}

	/**
	 * Re-validate every line in the cart.
	 *
	 * @param mixed $cart The cart, when a caller supplies one. WooCommerce's own
	 *                    call sites pass nothing, so it falls back to `WC()->cart`.
	 */
	public function validate( $cart = null ): void {
		$cart = $this->cart( $cart );

		if ( null === $cart ) {
			return;
		}

		foreach ( $cart->get_cart() as $key => $item ) {
			$this->validate_line( (string) $key, is_array( $item ) ? $item : array() );
		}
	}

	/**
	 * The cart to validate.
	 *
	 * @param mixed $cart A cart, or null.
	 * @return object|null
	 */
	private function cart( $cart ): ?object {
		if ( is_object( $cart ) && method_exists( $cart, 'get_cart' ) ) {
			return $cart;
		}

		if ( ! function_exists( 'WC' ) ) {
			return null;
		}

		$woocommerce = WC();

		if ( ! is_object( $woocommerce ) || ! isset( $woocommerce->cart ) || ! is_object( $woocommerce->cart ) ) {
			return null;
		}

		return method_exists( $woocommerce->cart, 'get_cart' ) ? $woocommerce->cart : null;
	}

	/**
	 * Re-validate one line, and refuse checkout if it no longer resolves.
	 *
	 * @param string               $key  Cart item key.
	 * @param array<string, mixed> $item Cart item.
	 */
	private function validate_line( string $key, array $item ): void {
		$selections = $item[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_SELECTIONS ] ?? null;

		if ( ! is_array( $selections ) || array() === $selections ) {
			return;
		}

		$product_id  = isset( $item['product_id'] ) && is_numeric( $item['product_id'] ) ? (int) $item['product_id'] : 0;
		$option_sets = $this->config->option_sets_for_product( $product_id );

		/*
		 * No configuration for this product any more -- the merchant unassigned
		 * the set, or the plugin was disconnected. The line still claims options,
		 * so it is exactly as unsellable as a deleted option, and refusing here
		 * beats shipping something nobody can describe.
		 */
		$result = SelectionResolver::resolve( $option_sets, $selections, 0, StoreClock::today() );

		if ( ! $result->is_ok() ) {
			$this->refuse( $key, $product_id, $item, $result->get_errors(), $option_sets );

			return;
		}

		/*
		 * 🔴 **A file can expire while the line sits in the cart.**
		 *
		 * `UploadTokenCheck` runs at add-to-cart, but nothing re-runs it, and
		 * `ORPHAN_TTL` counts from the *upload*, not from that moment. The 72-hour
		 * TTL is deliberately longer than WooCommerce's 48-hour guest cart — but a
		 * logged-in customer's cart lives in `_woocommerce_persistent_cart_*` user
		 * meta and does not expire on that schedule at all, so it can outlive the
		 * file by weeks.
		 *
		 * Without this, `UploadExpirer` deletes the file — the order-meta guard
		 * cannot save it, because a cart is not an order — and checkout then
		 * completes with `claim()` reporting nothing to claim. The merchant
		 * receives an order with no artwork, which is precisely what this class
		 * exists to prevent for a deleted option.
		 */
		if ( null === $this->files ) {
			return;
		}

		$unusable = $this->files->unusable( $selections );

		if ( array() === $unusable ) {
			return;
		}

		$errors = array();

		foreach ( $unusable as $option_id ) {
			$errors[] = array(
				'code'   => self::ERROR_FILE_MISSING,
				'field'  => $option_id,
				'params' => array(),
			);
		}

		$this->refuse( $key, $product_id, $item, $errors, $option_sets );
	}

	/**
	 * Raise the notice that stops the order being created.
	 *
	 * @param string                           $key        Cart item key.
	 * @param int                              $product_id The line's product.
	 * @param array<string, mixed>             $item       Cart item.
	 * @param array<int, array<string, mixed>> $errors      The resolver's errors.
	 * @param array<int, array<string, mixed>> $option_sets The product's current option sets.
	 */
	private function refuse( string $key, int $product_id, array $item, array $errors, array $option_sets ): void {
		if ( isset( $this->reported[ $key ] ) ) {
			return;
		}

		$this->reported[ $key ] = true;

		$this->logger->warning(
			'Blocked checkout: a cart line references an option that is no longer valid.',
			array(
				'product_id' => $product_id,
				'error'      => isset( $errors[0]['code'] ) ? (string) $errors[0]['code'] : null,
			)
		);

		if ( ! function_exists( 'wc_add_notice' ) ) {
			return;
		}

		wc_add_notice( $this->message( $item, $errors, $option_sets ), 'error' );
	}

	/**
	 * A message naming **only** the options that actually failed.
	 *
	 * Two things this deliberately does not do, both of which it used to.
	 *
	 * **It does not name every option on the line.** An earlier version iterated
	 * all snapshotted labels, so a line with a broken `Finish` and a working
	 * `Engraving` produced *"Finish, Engraving is no longer available"* — telling
	 * the customer something false about an option that was fine, and sending
	 * them looking for a problem that did not exist. Every resolver error carries
	 * the option id in its `field`, so the failing options are known exactly.
	 *
	 * **It does not describe every failure as a removal.** A merchant *adding* a
	 * required option to a product already in someone's cart is a resolution
	 * failure too, and calling that "no longer available" is the opposite of what
	 * happened. `required` gets its own wording.
	 *
	 * Labels come from `Keys::CART_ITEM_LABELS`, snapshotted at add-to-cart,
	 * because a deleted option's name is gone from the configuration — that is
	 * what deleted means — and an option id like `opt-a` is a merchant's slug
	 * rather than customer-facing text.
	 *
	 * @param array<string, mixed>             $item   Cart item.
	 * @param array<int, array<string, mixed>> $errors      The resolver's errors.
	 * @param array<int, array<string, mixed>> $option_sets The product's current option sets.
	 */
	private function message( array $item, array $errors, array $option_sets ): string {
		$labels  = $item[ Keys::CART_ITEM_KEY ][ Keys::CART_ITEM_LABELS ] ?? null;
		$labels  = is_array( $labels ) ? $labels : array();
		$missing = array();
		$invalid = array();
		$files   = array();
		$hidden  = array();

		foreach ( $errors as $error ) {
			$field = isset( $error['field'] ) && is_scalar( $error['field'] ) ? (string) $error['field'] : '';

			if ( '' === $field ) {
				continue;
			}

			$name = $this->name_for( $field, $labels, $option_sets );

			if ( SelectionResolver::ERROR_REQUIRED === ( $error['code'] ?? '' ) ) {
				$missing[] = $name;

				continue;
			}

			if ( self::ERROR_FILE_MISSING === ( $error['code'] ?? '' ) ) {
				$files[] = $name;

				continue;
			}

			/*
			 * 🔴 **"No longer available" is the wrong sentence for this.** The
			 * option IS available — the customer's *other* answers took it off
			 * the page, which happens when a merchant publishes a rule while the
			 * line sits in the cart. Telling them to remove the product is the
			 * one instruction that does not fix it: the fix is to change the
			 * answer that hid this one, and only re-choosing on the product page
			 * can do that.
			 *
			 * Found by M17.8's audit, which measured the generic wording landing
			 * on a rule-hidden option.
			 */
			if ( SelectionResolver::ERROR_HIDDEN_BY_RULE === ( $error['code'] ?? '' ) ) {
				$hidden[] = $name;

				continue;
			}

			$invalid[] = $name;
		}

		/*
		 * 🔴 **A rule-hidden option is not an unavailable one.** The generic
		 * wording says the option is gone and asks the customer to remove the
		 * product, and both halves are wrong: the option exists, their **other**
		 * answers took it off the page, and removing the line is the one action
		 * that does not fix it. Only re-choosing on the product page can change
		 * the answer that hid this one.
		 *
		 * Named before the general wording for the same reason the file case is:
		 * a line whose only problem is this deserves the message that says what
		 * to do about it.
		 */
		if ( array() !== $hidden && array() === $invalid && array() === $missing && array() === $files ) {
			return sprintf(
				/* translators: %s: comma-separated option names, e.g. "Engraving". */
				__(
					'Sorry, "%s" no longer applies to one of the products in your cart because of the other options chosen. Please review that product before checking out.',
					'optionia'
				),
				$this->join( $hidden )
			);
		}

		// Anything left unnamed above is described by the general wording.
		$invalid = array_merge( $invalid, $hidden );

		/*
		 * 🔴 **A lost file is not an unavailable option.** The generic wording
		 * says the option is no longer available and asks the customer to remove
		 * the product — but the option is fine, their upload expired, and
		 * removing the line is the one thing that does not fix it.
		 */
		if ( array() !== $files && array() === $invalid && array() === $missing ) {
			return sprintf(
				/* translators: %s: comma-separated option names, e.g. "Artwork". */
				__(
					'Sorry, the file uploaded for "%s" is no longer available. Please upload it again before checking out.',
					'optionia'
				),
				$this->join( $files )
			);
		}

		// Any other combination falls through to the wording below, which is
		// deliberately general: several different failures on one line cannot be
		// described precisely without listing them all.
		$invalid = array_merge( $invalid, $files );

		if ( array() === $invalid && array() !== $missing ) {
			return sprintf(
				/* translators: %s: comma-separated option names, e.g. "Gift Wrap". */
				__(
					'Sorry, "%s" must now be chosen for one of the products in your cart. Please update it before checking out.',
					'optionia'
				),
				$this->join( $missing )
			);
		}

		if ( array() === $invalid ) {
			return __(
				'Sorry, one of the products in your cart uses an option that is no longer available. Please remove it and choose again.',
				'optionia'
			);
		}

		return sprintf(
			/* translators: %s: comma-separated option names, e.g. "Finish". */
			__(
				'Sorry, "%s" is no longer available on one of the products in your cart. Please remove it and choose again.',
				'optionia'
			),
			$this->join( $invalid )
		);
	}

	/**
	 * The customer-facing name for one option id.
	 *
	 * Three sources, in order, and the order is the point — the two failure modes
	 * need opposite ones:
	 *
	 * 1. **The snapshot**, for an option the merchant *deleted*. Its name is gone
	 *    from the configuration; that is what deleted means.
	 * 2. **The live configuration**, for an option the merchant *added* as
	 *    required. It never existed when this line was written, so the snapshot
	 *    cannot hold it — but it is in the document right now.
	 * 3. **The option id**, so a message always names something. A slug like
	 *    `opt-a` is unhelpful, but it beats naming nothing at all.
	 *
	 * @param string                           $option_id   The failing option.
	 * @param array<string, mixed>             $labels      Snapshotted labels.
	 * @param array<int, array<string, mixed>> $option_sets The product's current option sets.
	 */
	private function name_for( string $option_id, array $labels, array $option_sets ): string {
		$label = $labels[ $option_id ] ?? null;

		if ( is_array( $label ) && isset( $label['option'] ) && is_scalar( $label['option'] ) && '' !== (string) $label['option'] ) {
			return (string) $label['option'];
		}

		$live = $this->live_label( $option_id, $option_sets );

		return '' !== $live ? $live : $option_id;
	}

	/**
	 * An option's label from the configuration as it stands now.
	 *
	 * @param string                           $option_id   The option to name.
	 * @param array<int, array<string, mixed>> $option_sets The product's current option sets.
	 * @return string The label, or an empty string when the option is not there.
	 */
	private function live_label( string $option_id, array $option_sets ): string {
		foreach ( $option_sets as $set ) {
			foreach ( (array) ( $set['groups'] ?? array() ) as $group ) {
				foreach ( (array) ( $group['options'] ?? array() ) as $option ) {
					if ( ! is_array( $option ) || (string) ( $option['id'] ?? '' ) !== $option_id ) {
						continue;
					}

					return isset( $option['label'] ) && is_scalar( $option['label'] ) ? (string) $option['label'] : '';
				}
			}
		}

		return '';
	}

	/**
	 * Join names for display, de-duplicated and sanitised.
	 *
	 * De-duplicated defensively. Measured: it is currently unreachable, because
	 * `SelectionResolver::already_reported()` emits at most one error per field --
	 * an option whose value is gone *and* which is now required produces one
	 * error, not two. Kept because that is the resolver's invariant rather than
	 * this class's, and a message naming the same option twice would read like
	 * two separate problems.
	 *
	 * @param array<int, string> $names Option names.
	 */
	private function join( array $names ): string {
		return implode( ', ', array_map( 'sanitize_text_field', array_values( array_unique( $names ) ) ) );
	}
}
