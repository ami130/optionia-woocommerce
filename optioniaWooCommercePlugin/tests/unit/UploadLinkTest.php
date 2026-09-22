<?php
/**
 * The signed, expiring link that goes in an order email.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Keys;
use Optionia\Upload\UploadLink;
use PHPUnit\Framework\TestCase;

/**
 * `UploadLink` minting and checking emailed links.
 *
 * 🔴 **A nonce cannot do this job.** It is bound to the reader's user id and
 * session token, which is useless in an inbox opened tomorrow in another
 * browser — and for a *logged-out* reader `wp_create_nonce()` reduces to
 * action + tick, identical for everyone and valid 24 hours.
 *
 * @covers \Optionia\Upload\UploadLink
 */
final class UploadLinkTest extends TestCase {

	private function links(): UploadLink {
		return new UploadLink();
	}

	/**
	 * The query arguments of a freshly minted link.
	 *
	 * @param int $order_id The order.
	 * @return array<string, string>
	 */
	private function argsFor( int $order_id ): array {
		$query = (string) wp_parse_url( $this->links()->url( $order_id ), PHP_URL_QUERY );
		$args  = array();

		parse_str( $query, $args );

		return array_map( 'strval', $args );
	}

	/* --- minting --------------------------------------------------------- */

	/** A link names its order, its expiry, and carries a signature. */
	public function test_a_link_carries_an_order_an_expiry_and_a_signature(): void {
		$args = $this->argsFor( 64 );

		$this->assertSame( '64', $args[ Keys::ARG_DOWNLOAD_ORDER ] );
		$this->assertNotSame( '', $args[ Keys::ARG_DOWNLOAD_SIGNATURE ] );
		$this->assertGreaterThan( time(), (int) $args[ Keys::ARG_DOWNLOAD_EXPIRES ] );
	}

	/**
	 * Seven days: long enough for a weekend and a fulfilment backlog, short
	 * enough that a forwarded email stops working within a week.
	 */
	public function test_a_link_lasts_seven_days(): void {
		$args = $this->argsFor( 64 );

		$this->assertEqualsWithDelta(
			time() + UploadLink::LIFETIME,
			(int) $args[ Keys::ARG_DOWNLOAD_EXPIRES ],
			5
		);
		$this->assertSame( 604800, UploadLink::LIFETIME );
	}

	/** An unusable order id yields no link rather than a broken one. */
	public function test_an_unusable_order_yields_no_link(): void {
		$this->assertSame( '', $this->links()->url( 0 ) );
		$this->assertSame( '', $this->links()->url( -1 ) );
	}

	/* --- verifying ------------------------------------------------------- */

	/** A link this class minted verifies. */
	public function test_a_minted_link_verifies(): void {
		$args = $this->argsFor( 64 );

		$this->assertTrue(
			$this->links()->verify(
				64,
				(int) $args[ Keys::ARG_DOWNLOAD_EXPIRES ],
				$args[ Keys::ARG_DOWNLOAD_SIGNATURE ]
			)
		);
	}

	/**
	 * 🔴 **A link for one order cannot be replayed as another.**
	 *
	 * The order is part of the signed material, so editing it in the URL leaves
	 * a signature that no longer matches. Without this, one valid link would open
	 * every order in the store.
	 */
	public function test_a_link_cannot_be_replayed_for_another_order(): void {
		$args = $this->argsFor( 64 );

		$this->assertFalse(
			$this->links()->verify(
				65,
				(int) $args[ Keys::ARG_DOWNLOAD_EXPIRES ],
				$args[ Keys::ARG_DOWNLOAD_SIGNATURE ]
			)
		);
	}

	/**
	 * 🔴 **The deadline cannot be pushed out by editing the URL.**
	 *
	 * The expiry is signed, so a later timestamp simply fails to verify — which
	 * is why the signature is checked before the clock.
	 */
	public function test_the_expiry_cannot_be_extended(): void {
		$args = $this->argsFor( 64 );

		$this->assertFalse(
			$this->links()->verify(
				64,
				(int) $args[ Keys::ARG_DOWNLOAD_EXPIRES ] + 86400,
				$args[ Keys::ARG_DOWNLOAD_SIGNATURE ]
			)
		);
	}

	/**
	 * 🔴 **An expired link is refused even though its signature is genuine.**
	 *
	 * ⚠️ **The signature must be minted for the *same* past timestamp**, or the
	 * refusal proves nothing: an unmatched signature is rejected before the clock
	 * is ever consulted. Mutation caught exactly that — an earlier version of this
	 * test passed with the expiry check removed entirely, because it was really
	 * testing the signature again.
	 */
	public function test_an_expired_link_is_refused(): void {
		$past = time() - 60;

		// The signature an email sent a week ago would carry: valid, but stale.
		$signature = wp_hash( 'optionia-order-files|64|' . $past );

		$this->assertTrue(
			hash_equals( $signature, wp_hash( 'optionia-order-files|64|' . $past ) ),
			'The signature under test must itself be genuine.'
		);

		$this->assertFalse( $this->links()->verify( 64, $past, $signature ) );
	}

	/**
	 * A signature that was not minted here is refused.
	 *
	 * @dataProvider forgeries
	 *
	 * @param string $signature The offered signature.
	 */
	public function test_a_forged_signature_is_refused( string $signature ): void {
		$args = $this->argsFor( 64 );

		$this->assertFalse(
			$this->links()->verify( 64, (int) $args[ Keys::ARG_DOWNLOAD_EXPIRES ], $signature )
		);
	}

	/**
	 * Signatures nobody minted.
	 *
	 * @return array<string, array{0: string}>
	 */
	public static function forgeries(): array {
		return array(
			'empty'      => array( '' ),
			'nonsense'   => array( 'not-a-signature' ),
			'right size' => array( str_repeat( 'a', 32 ) ),
		);
	}

	/** An unusable order id never verifies, whatever is offered. */
	public function test_an_unusable_order_never_verifies(): void {
		$this->assertFalse( $this->links()->verify( 0, time() + 100, 'anything' ) );
	}
}
