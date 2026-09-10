<?php
/**
 * The frozen payload's integrity (M12.1, FINDING 1d).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Integration\CartItemPayload;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * A stored price is a price something else could have written.
 *
 * `cart_item_data` is not browser-writable — verified in WC 11.0.1:
 * `WC_AJAX::add_to_cart()` never reads it, the form handler never fills it from
 * `$_POST`, and the Store API hardcodes `'cart_item_data' => []`. WooCommerce
 * sessions are server-side, so a customer cannot edit what is stored either.
 *
 * But **another plugin** can write it through `woocommerce_add_cart_item_data`,
 * and that is the actor Stage 7b named when it found `base_price_minor`
 * forgeable: a price another plugin can set is not server-authoritative.
 *
 * The difference this time is that the value genuinely must be stored — the
 * configuration that produced it is overwritten on publish, so the delta cannot
 * be recomputed. Signing is what makes a value checkable without the data that
 * produced it.
 *
 * @covers \Optionia\Integration\CartItemPayload
 */
final class CartItemPayloadTest extends TestCase {

	/**
	 * Reset the salt.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_salt'] = 'test-salt';
	}

	/**
	 * Leave no state behind.
	 */
	protected function tearDown(): void {
		$GLOBALS['optionia_test_salt'] = 'test-salt';

		parent::tearDown();
	}

	/**
	 * A genuine payload yields its frozen deltas.
	 */
	public function test_a_genuine_payload_yields_its_frozen_deltas(): void {
		$this->assertSame(
			array( 'opt-a' => 2000 ),
			CartItemPayload::frozen_deltas( $this->line( array( 'opt-a' => 'lux' ), array( 'opt-a' => 2000 ), 7 ) )
		);
	}

	/**
	 * **A tampered payload falls back to the live price, rather than being honoured.**
	 *
	 * Each case changes one field and leaves the signature alone — which is what
	 * a plugin writing `cart_item_data` directly would produce. `null` means "no
	 * usable freeze", and the caller prices from current configuration.
	 *
	 * The forged *lower* delta is the case that matters: it is well inside the
	 * schema's range, so no amount of bounds-checking would catch it. That is why
	 * this is a signature and not a clamp.
	 *
	 * @dataProvider provide_tampered_payloads
	 *
	 * @param array<string, mixed> $line A cart line with one field altered.
	 */
	public function test_a_tampered_payload_is_refused( array $line ): void {
		$this->assertNull( CartItemPayload::frozen_deltas( $line ) );
	}

	/**
	 * One field altered per case, signature untouched.
	 *
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function provide_tampered_payloads(): array {
		$genuine = self::payload( array( 'opt-a' => 'lux' ), array( 'opt-a' => 2000 ), 7 );

		$cheaper                                   = $genuine;
		$cheaper[ Keys::CART_ITEM_DELTAS ]         = array( 'opt-a' => -5000 );
		$version                                   = $genuine;
		$version[ Keys::CART_ITEM_CONFIG_VERSION ] = 99;
		$swapped                                   = $genuine;
		$swapped[ Keys::CART_ITEM_SELECTIONS ]     = array( 'opt-a' => 'prem' );
		$unsigned                                  = $genuine;
		unset( $unsigned[ Keys::CART_ITEM_SIGNATURE ] );
		$blank                              = $genuine;
		$blank[ Keys::CART_ITEM_SIGNATURE ] = '';

		return array(
			'delta forged lower' => array( array( Keys::CART_ITEM_KEY => $cheaper ) ),
			'version forged'     => array( array( Keys::CART_ITEM_KEY => $version ) ),
			'selection swapped'  => array( array( Keys::CART_ITEM_KEY => $swapped ) ),
			'signature removed'  => array( array( Keys::CART_ITEM_KEY => $unsigned ) ),
			'signature blanked'  => array( array( Keys::CART_ITEM_KEY => $blank ) ),
			'no optionia key'    => array( array( 'gift' => 'yes' ) ),
			'optionia not array' => array( array( Keys::CART_ITEM_KEY => 'garbage' ) ),
		);
	}

	/**
	 * A correctly signed but non-integer delta is still refused.
	 *
	 * The signature proves *who wrote* the payload, not that its contents are
	 * sane. A float delta would reach `Pricing::sum_deltas()`, which refuses
	 * non-integers outright — so it must be caught here, where the fallback to
	 * live pricing is a graceful answer rather than an exception on a cart page.
	 *
	 * Signed deliberately, because a tampered signature is rejected one step
	 * earlier: without signing this case, the `is_int()` guard is unreachable and
	 * removing it changes nothing that any test observes.
	 */
	public function test_a_signed_non_integer_delta_is_refused(): void {
		$selections = array( 'opt-a' => 'lux' );
		$deltas     = array( 'opt-a' => 20.5 );

		$line = array(
			Keys::CART_ITEM_KEY => array(
				Keys::CART_ITEM_SELECTIONS     => $selections,
				Keys::CART_ITEM_CONFIG_VERSION => 7,
				Keys::CART_ITEM_DELTAS         => $deltas,
				Keys::CART_ITEM_SIGNATURE      => CartItemPayload::sign( $selections, $deltas, 7 ),
			),
		);

		$this->assertNull( CartItemPayload::frozen_deltas( $line ) );
	}

	/**
	 * **A salt rotation degrades the freeze; it does not empty the cart.**
	 *
	 * Rotating salts is a routine security action. Refusing every line whose
	 * signature no longer verifies would clear every cart in the store the moment
	 * an owner did it — so an unverifiable freeze is simply not a freeze, and the
	 * line is priced from current configuration instead.
	 *
	 * That is also why tampering gains nothing: the best a forger achieves is
	 * today's price, which they could have had by adding the item today.
	 */
	public function test_a_salt_rotation_degrades_to_the_live_price(): void {
		$line = $this->line( array( 'opt-a' => 'lux' ), array( 'opt-a' => 2000 ), 7 );

		$this->assertNotNull( CartItemPayload::frozen_deltas( $line ) );

		$GLOBALS['optionia_test_salt'] = 'rotated-by-the-site-owner';

		$this->assertNull( CartItemPayload::frozen_deltas( $line ) );
	}

	/**
	 * Signing is stable under key order.
	 *
	 * Two customers choosing the same options in a different order must sign
	 * identically, for the same reason they must produce the same cart key — and
	 * `CartItemData` sorts before storing, so a signature that depended on order
	 * would verify on write and fail on read.
	 */
	public function test_signing_is_stable_under_key_order(): void {
		$this->assertSame(
			CartItemPayload::sign(
				array(
					'b' => '2',
					'a' => '1',
				),
				array(
					'b' => 20,
					'a' => 10,
				),
				7
			),
			CartItemPayload::sign(
				array(
					'a' => '1',
					'b' => '2',
				),
				array(
					'a' => 10,
					'b' => 20,
				),
				7
			)
		);
	}

	/**
	 * Different content signs differently.
	 *
	 * Asserted so the test above cannot pass by the signature being constant.
	 */
	public function test_different_content_signs_differently(): void {
		$this->assertNotSame(
			CartItemPayload::sign( array( 'a' => '1' ), array( 'a' => 10 ), 7 ),
			CartItemPayload::sign( array( 'a' => '1' ), array( 'a' => 11 ), 7 )
		);
	}

	/**
	 * Pruning leaves a foreign payload untouched.
	 */
	public function test_pruning_leaves_a_foreign_payload_untouched(): void {
		$foreign = array( 'gift_wrap' => 'yes' );

		$this->assertSame( $foreign, CartItemPayload::prune( $foreign ) );
	}

	/**
	 * Pruning preserves other plugins' data alongside ours.
	 */
	public function test_pruning_preserves_other_plugins_data(): void {
		$mixed = array(
			Keys::CART_ITEM_KEY => self::payload( array( 'a' => '1' ), array( 'a' => 10 ), 7 ),
			'gift_wrap'         => 'yes',
		);

		$pruned = CartItemPayload::prune( $mixed );

		$this->assertSame( 'yes', $pruned['gift_wrap'] );
		$this->assertSame( array( Keys::CART_ITEM_SELECTIONS ), array_keys( $pruned[ Keys::CART_ITEM_KEY ] ) );
	}

	// --- Helpers -------------------------------------------------------------

	/**
	 * A whole cart line carrying a signed payload.
	 *
	 * @param array<string, string> $selections Option id to value key.
	 * @param array<string, int>    $deltas     Option id to minor units.
	 * @param int                   $version    Config version.
	 * @return array<string, mixed>
	 */
	private function line( array $selections, array $deltas, int $version ): array {
		return array( Keys::CART_ITEM_KEY => self::payload( $selections, $deltas, $version ) );
	}

	/**
	 * A signed Optionia payload.
	 *
	 * @param array<string, string> $selections Option id to value key.
	 * @param array<string, int>    $deltas     Option id to minor units.
	 * @param int                   $version    Config version.
	 * @return array<string, mixed>
	 */
	private static function payload( array $selections, array $deltas, int $version ): array {
		return array(
			Keys::CART_ITEM_SELECTIONS     => $selections,
			Keys::CART_ITEM_CONFIG_VERSION => $version,
			Keys::CART_ITEM_DELTAS         => $deltas,
			Keys::CART_ITEM_SIGNATURE      => CartItemPayload::sign( $selections, $deltas, $version ),
		);
	}
}
