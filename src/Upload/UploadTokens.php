<?php
/**
 * What an upload token looks like, and where to find them.
 *
 * ## Why this exists
 *
 * 🔴 **The same regular expression appeared in five classes.** `UploadDownload`,
 * `UploadExpirer`, `UploadPromoter`, `UploadRetention` and `UploadTokenCheck` each
 * carried their own `/^[0-9a-f]{64}$/`, and M15.5 was about to add a sixth. Five
 * copies of a security-relevant pattern is five places to keep in step: widen one
 * to accept uppercase and the others silently disagree about what a token is.
 *
 * ⚠️ **`Engine\SelectionResolver` keeps its own copy, deliberately.** `Engine/` is
 * a pure port that must run against shared fixtures with no WordPress, so it
 * cannot depend on this namespace. That duplication is a constraint of the
 * architecture rather than an oversight — and it is one copy, not five.
 *
 * ## Where the tokens live
 *
 * A file's token is stored as an ordinary scalar selection: nothing in the
 * payload marks it as a file, because the resolver treats a file option's value
 * like any other. The token's *shape* is what distinguishes it from a colour
 * swatch's `red` — 64 hex characters from `random_bytes(32)`, which no
 * merchant-authored value key resembles.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Upload;

use Optionia\Support\Keys;

defined( 'ABSPATH' ) || exit;

/**
 * Recognises upload tokens and reads them out of an order line.
 */
final class UploadTokens {

	/**
	 * The one definition of a token's shape.
	 *
	 * 64 lowercase hex characters — `bin2hex( random_bytes( 32 ) )`. Lowercase
	 * only, because that is what `bin2hex()` produces; accepting uppercase would
	 * let two spellings of one token exist, and only one of them matches a row.
	 *
	 * 🔴 **`\A` and `\z`, never `^` and `$`.** PHP's `$` also matches *before* a
	 * trailing newline, so `/^[0-9a-f]{64}$/` accepted `"aaa…a\n"` — measured.
	 * That value is then looked up verbatim: `WHERE token = 'aaa…a\n'` finds
	 * **zero rows** against a real database, so a customer whose posted value
	 * picked up a newline was told to upload a file that was already there, and
	 * could not complete the purchase. `\z` matches only the true end.
	 */
	private const PATTERN = '/\A[0-9a-f]{64}\z/';

	/**
	 * Whether a value is shaped like an upload token.
	 *
	 * @param mixed $value Any selection value.
	 */
	public static function is_token( $value ): bool {
		if ( ! is_scalar( $value ) ) {
			return false;
		}

		return 1 === preg_match( self::PATTERN, (string) $value );
	}

	/**
	 * The tokens in a selection map, keyed by the option that carries each.
	 *
	 * ⚠️ **Keyed, because a caller that must name the offending option needs to
	 * know which one it was.** `Integration\CheckoutValidator` says *"the file
	 * uploaded for Artwork is no longer available"*, and a flat list could not
	 * tell the customer which of two file options to re-upload.
	 *
	 * @param mixed $selections A selection map, or anything that is not one.
	 * @return array<string, string> Option id to token.
	 */
	public static function in_selections( $selections ): array {
		if ( ! is_array( $selections ) ) {
			return array();
		}

		$tokens = array();

		foreach ( $selections as $option_id => $value ) {
			/*
			 * ⚠️ **A multi-select answer is a list and holds no token.**
			 *
			 * `is_token()` tests a 64-character hex string, so an array is
			 * false and a `cardinality: many` option is skipped. That was true
			 * by coercion before M18.2 and is true by *design* after it:
			 * `SelectionResolver::MANY_CAPABLE_TYPES` holds `checkbox` alone,
			 * so `file_input` can never declare `many` — one option, one token,
			 * which is the shape every upload path reads.
			 *
			 * 📌 **If M18.3 or later ever grants `many` to a file type, this is
			 * one of the places that must change**, along with
			 * `UploadPromoter`, `UploadTokenCheck` and the `unusable()` report.
			 * Recorded here because the coupling is otherwise invisible.
			 */
			if ( self::is_token( $value ) ) {
				$tokens[ (string) $option_id ] = (string) $value;
			}
		}

		return $tokens;
	}

	/**
	 * The tokens one order line refers to, keyed by option id.
	 *
	 * Written by `Integration\OrderLineItem` as a JSON object under
	 * `Keys::META_SELECTIONS`. Anything else — a line from before this plugin, a
	 * value another plugin overwrote, malformed JSON — yields nothing, and the
	 * caller treats the line as carrying no files rather than guessing.
	 *
	 * @param mixed $item An order line item.
	 * @return array<string, string> Option id to token.
	 */
	public static function in_item( $item ): array {
		if ( ! is_object( $item ) || ! method_exists( $item, 'get_meta' ) ) {
			return array();
		}

		$raw = $item->get_meta( Keys::META_SELECTIONS );

		if ( ! is_string( $raw ) || '' === $raw ) {
			return array();
		}

		return self::in_selections( json_decode( $raw, true ) );
	}

	/**
	 * Every token an order refers to, across all its lines.
	 *
	 * @param mixed $order An order.
	 * @return array<int, string> Tokens, each once.
	 */
	public static function in_order( $order ): array {
		if ( ! is_object( $order ) || ! method_exists( $order, 'get_items' ) ) {
			return array();
		}

		$items  = $order->get_items();
		$tokens = array();

		foreach ( is_array( $items ) ? $items : array() as $item ) {
			foreach ( self::in_item( $item ) as $token ) {
				$tokens[] = $token;
			}
		}

		return array_values( array_unique( $tokens ) );
	}
}
