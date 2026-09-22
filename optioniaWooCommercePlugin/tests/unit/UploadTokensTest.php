<?php
/**
 * The one definition of what an upload token looks like.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Support\Keys;
use Optionia\Upload\UploadTokens;
use PHPUnit\Framework\TestCase;

/**
 * `UploadTokens` recognising tokens and reading them out of an order.
 *
 * 🔴 **The same expression lived in five classes.** `UploadDownload`,
 * `UploadExpirer`, `UploadPromoter`, `UploadRetention` and `UploadTokenCheck`
 * each carried their own `/^[0-9a-f]{64}$/`, and M15.5 was about to add a sixth.
 * Five copies of a security-relevant pattern is five places to keep in step:
 * widen one to accept uppercase and the others silently disagree about what a
 * token is.
 *
 * @covers \Optionia\Upload\UploadTokens
 */
final class UploadTokensTest extends TestCase {

	/**
	 * A value is a token only if it has the exact shape one is written in.
	 *
	 * @dataProvider tokens
	 *
	 * @param mixed $value    A candidate value.
	 * @param bool  $expected Whether it is a token.
	 */
	public function test_it_recognises_a_token( $value, bool $expected ): void {
		$this->assertSame( $expected, UploadTokens::is_token( $value ) );
	}

	/**
	 * What is and is not a token.
	 *
	 * ⚠️ **Uppercase is not a token.** `bin2hex()` produces lowercase, so
	 * accepting uppercase would let two spellings of one token exist while only
	 * one of them matches a row.
	 *
	 * @return array<string, array{0: mixed, 1: bool}>
	 */
	public static function tokens(): array {
		return array(
			'a real token' => array( str_repeat( 'a', 64 ), true ),
			'mixed hex'    => array( str_repeat( '0f', 32 ), true ),
			'uppercase'    => array( str_repeat( 'A', 64 ), false ),
			'too short'    => array( str_repeat( 'a', 63 ), false ),
			'too long'     => array( str_repeat( 'a', 65 ), false ),
			'not hex'      => array( str_repeat( 'z', 64 ), false ),
			'a value key'  => array( 'lux', false ),
			'empty'        => array( '', false ),
			'an array'     => array( array( 'a' ), false ),
			'null'         => array( null, false ),
			'a path'       => array( '../../../wp-config.php', false ),

			/*
			 * 🔴 **PHP's `$` also matches before a trailing newline**, so the
			 * anchored-looking `/^…$/` accepted this. The value is then looked up
			 * verbatim and matches **no row** — measured against a real database —
			 * so a customer whose posted value picked up a newline was told to
			 * re-upload a file that was already there, and could not buy.
			 */
			'newline'      => array( str_repeat( 'a', 64 ) . "\n", false ),
			'CRLF'         => array( str_repeat( 'a', 64 ) . "\r\n", false ),
			'leading LF'   => array( "\n" . str_repeat( 'a', 64 ), false ),
			'trailing sp'  => array( str_repeat( 'a', 64 ) . ' ', false ),
		);
	}

	/**
	 * ⚠️ **Keyed by option, because a caller must be able to name the one that
	 * failed.** `CheckoutValidator` says which file to re-upload.
	 */
	public function test_it_keys_tokens_by_the_option_that_carries_them(): void {
		$found = UploadTokens::in_selections(
			array(
				'opt-c' => 'red',
				'opt-f' => str_repeat( 'a', 64 ),
			)
		);

		$this->assertSame( array( 'opt-f' => str_repeat( 'a', 64 ) ), $found );
	}

	/** Anything that is not a selection map yields nothing. */
	/**
	 * 🔴 **A multi-select answer carries no token and is skipped.**
	 *
	 * ⚠️ **Safe by DESIGN after M18.2, not by coercion.**
	 * `SelectionResolver::MANY_CAPABLE_TYPES` holds `checkbox` alone, so
	 * `file_input` can never declare `cardinality: many` — one option, one
	 * token, which is the shape every upload path reads.
	 *
	 * Asserted anyway, because the coupling is invisible: if a later stage ever
	 * grants `many` to a file type, this test is where that shows up rather
	 * than in a customer's missing artwork.
	 */
	public function test_a_list_answer_carries_no_token(): void {
		$token = str_repeat( 'a', 64 );

		$this->assertSame(
			array( 'opt-f' => $token ),
			UploadTokens::in_selections(
				array(
					'opt-f' => $token,
					'opt-m' => array( 'red', 'blue' ),
				)
			)
		);
	}

	public function test_a_non_map_yields_nothing(): void {
		$this->assertSame( array(), UploadTokens::in_selections( 'not a map' ) );
		$this->assertSame( array(), UploadTokens::in_selections( null ) );
	}

	/** Tokens are read from a line's recorded selections. */
	public function test_it_reads_tokens_from_an_order_line(): void {
		$item = optionia_test_order_item();
		$item->add_meta_data(
			Keys::META_SELECTIONS,
			(string) wp_json_encode( array( 'opt-f' => str_repeat( 'b', 64 ) ) ),
			true
		);

		$this->assertSame( array( 'opt-f' => str_repeat( 'b', 64 ) ), UploadTokens::in_item( $item ) );
	}

	/**
	 * ⚠️ **Malformed meta yields nothing rather than a guess.** A line from
	 * before this plugin, or a value another plugin overwrote, is not a file.
	 */
	public function test_malformed_meta_yields_nothing(): void {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, 'not json', true );

		$this->assertSame( array(), UploadTokens::in_item( $item ) );
		$this->assertSame( array(), UploadTokens::in_item( optionia_test_order_item() ) );
		$this->assertSame( array(), UploadTokens::in_item( null ) );
	}

	/** An order reports each of its tokens once, across every line. */
	public function test_an_order_reports_each_token_once(): void {
		$one = optionia_test_order_item();
		$one->add_meta_data(
			Keys::META_SELECTIONS,
			(string) wp_json_encode( array( 'opt-f' => str_repeat( 'a', 64 ) ) ),
			true
		);

		$two = optionia_test_order_item();
		$two->add_meta_data(
			Keys::META_SELECTIONS,
			(string) wp_json_encode(
				array(
					'opt-f' => str_repeat( 'a', 64 ),
					'opt-g' => str_repeat( 'b', 64 ),
				)
			),
			true
		);

		$order        = optionia_test_order( 64 );
		$order->items = array( $one, $two );

		$this->assertSame(
			array( str_repeat( 'a', 64 ), str_repeat( 'b', 64 ) ),
			UploadTokens::in_order( $order )
		);
	}

	/** An order that cannot be read yields nothing. */
	public function test_a_missing_order_yields_nothing(): void {
		$this->assertSame( array(), UploadTokens::in_order( null ) );
	}
}
