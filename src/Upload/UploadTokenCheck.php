<?php
/**
 * Verifies a file token once, at add-to-cart (M15.4, Stage 4d).
 *
 * ## Why this exists at all
 *
 * 🔴 **A file option could not be bought.** `Engine\SelectionResolver` had no
 * branch for a `file` kind, so an uploaded token fell through to the merchant's
 * value set — which a file option does not have — and every attempt was refused
 * with `unknown_value`. The upload subsystem was complete and correct while the
 * customer still could not add the product to their cart.
 *
 * The resolver now accepts the token, but only its **shape**: `Engine/` is a pure
 * port that runs against shared fixtures with no WordPress and no database, so it
 * cannot ask whether a row exists. That question is this class's whole job.
 *
 * ## Where the check belongs, and why only here
 *
 * ADR-040 settles it: token verification runs **once at add-to-cart**, never in
 * `Engine/` and not five times along the path. Once the line is in the cart the
 * token is part of its identity — `Integration\CartItemKey` hashes the payload —
 * so a token that was real when the line was created stays the line's own.
 *
 * ## Order-again is the case this was built for
 *
 * 🔴 **A reordered line replays a token that may no longer exist.**
 * `Integration\OrderAgain` copies a past order's selections verbatim, and
 * `UploadExpirer` releases abandoned files after 72 hours — so a customer
 * reordering last month's artwork replays a token whose file is gone.
 *
 * ADR-040 requires that to **fail loudly**: *"a reprint that arrives blank is
 * worse than a reorder that says 'please upload your artwork again.'"* Refusing
 * the line is what makes it loud. Accepting it would put an order in front of a
 * merchant with artwork that does not exist, and nothing downstream would notice
 * until print.
 *
 * ⚠️ **Bound to the session, like every other read of an upload.**
 * `UploadRepository::find_for_session()` puts the session in the `WHERE` clause,
 * so one visitor cannot attach another's file by guessing a token. That is the
 * same rule `Upload\UploadEndpoint` follows, and the reason a *claimed* token
 * fails here too: a file already on an order is not a file this cart may take.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

defined( 'ABSPATH' ) || exit;

/**
 * Answers whether a cart line's file tokens are real and this visitor's.
 */
final class UploadTokenCheck {

	/**
	 * The upload table.
	 *
	 * @var UploadRepository
	 */
	private UploadRepository $uploads;

	/**
	 * Per-session context, for the current visitor's session key.
	 *
	 * @var UploadQuota
	 */
	private UploadQuota $quota;

	/**
	 * Build the check over the table and the session.
	 *
	 * @param UploadRepository $uploads Upload table.
	 * @param UploadQuota      $quota   Session context.
	 */
	public function __construct( UploadRepository $uploads, UploadQuota $quota ) {
		$this->uploads = $uploads;
		$this->quota   = $quota;
	}

	/**
	 * The current visitor's session key, or an empty string.
	 *
	 * Kept here so the validator asks one collaborator rather than two, while
	 * `passes()` stays free of `WC()` and therefore testable.
	 */
	public function session_key(): string {
		return $this->quota->session_key();
	}

	/**
	 * Whether every file token in a selection set is usable by this visitor.
	 *
	 * ⚠️ **Only values that look like tokens are checked.** The resolver has
	 * already refused a file option whose value is not token-shaped, and a
	 * selection map carries every other option's value alongside — a colour
	 * swatch's `red` is not a token and must not be looked up as one.
	 *
	 * ⚠️ **The session is passed in, not read here.** `UploadQuota::session_key()`
	 * reaches into `WC()`, and a check that did the same could not be exercised
	 * without a WooCommerce session — the caller already knows which visitor it
	 * is acting for, and saying so explicitly is what makes this testable at all.
	 *
	 * @param array<string, mixed> $selections Option id to value.
	 * @param string|null          $session    The visitor's session key, or null
	 *                                         to resolve it only if needed.
	 * @return bool True when nothing needs refusing.
	 */
	public function passes( array $selections, ?string $session = null ): bool {
		return array() === $this->unusable( $selections, $session );
	}

	/**
	 * The option ids whose file token cannot be used.
	 *
	 * ⚠️ **Reported per option, not as one boolean.** `Integration\CheckoutValidator`
	 * names the offending option in the notice it shows, and a line with two
	 * file options would otherwise tell the customer to re-upload without
	 * saying which.
	 *
	 * ⚠️ **The session is resolved *after* the tokens are found, never before.**
	 * `UploadQuota::session_key()` is not a pure read — it calls
	 * `set_customer_session_cookie()` when no session exists, which is right for
	 * the upload endpoint and wrong as a side effect of viewing a cart. Passing
	 * it in as an argument evaluated it eagerly, so every cart and checkout view
	 * on a store with **no file options at all** touched the WooCommerce session
	 * for nothing. A caller may still supply one, which is what keeps this
	 * testable without a WooCommerce session.
	 *
	 * @param array<string, mixed> $selections Option id to value.
	 * @param string|null          $session    The visitor's session key, or null
	 *                                         to resolve it only if needed.
	 * @return array<int, string> Offending option ids, empty when all are fine.
	 */
	public function unusable( array $selections, ?string $session = null ): array {
		$tokens = UploadTokens::in_selections( $selections );

		if ( array() === $tokens ) {
			// Nothing to verify, so the session is never touched.
			return array();
		}

		$session = null === $session ? $this->session_key() : $session;

		/*
		 * ⚠️ **No separate empty-session guard here, deliberately.**
		 * `find_for_session()` puts the session in the `WHERE` clause and returns
		 * null for an empty one *before* it touches the database — so a guard in
		 * this class would refuse the same requests, issue the same zero
		 * queries, and be indistinguishable from its absence. Proven by
		 * mutation: disabling one left every assertion green, twice, including a
		 * test written specifically to catch it.
		 *
		 * Two guards enforcing one rule where neither is observable is not
		 * defence in depth; it is a second place to keep in step. The rule lives
		 * with the query that depends on it.
		 */

		$bad = array();

		foreach ( $tokens as $option_id => $token ) {
			$row = $this->uploads->find_for_session( $token, $session );

			if ( null === $row ) {
				$bad[] = $option_id;

				continue;
			}

			/*
			 * 🔴 **A claimed file belongs to an order already.** Re-ordering
			 * replays its token, and `UploadRepository::claim()` refuses to move
			 * a row between orders — so accepting the line here would create an
			 * order whose artwork silently belongs to a different one.
			 */
			if ( isset( $row['order_id'] ) && null !== $row['order_id'] && '' !== $row['order_id'] ) {
				$bad[] = $option_id;
			}
		}

		return $bad;
	}
}
