<?php
/**
 * The order report body (M12.7).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Reporting\OrderPayload;
use Optionia\Support\Keys;
use PHPUnit\Framework\TestCase;

/**
 * What the cloud is told about an order, and what it is deliberately not told.
 *
 * @covers \Optionia\Reporting\OrderPayload
 */
final class OrderPayloadTest extends TestCase {

	/**
	 * Reset harness state.
	 */
	protected function setUp(): void {
		parent::setUp();

		$GLOBALS['optionia_test_orders']  = array();
		$GLOBALS['optionia_test_options'] = array();
	}

	/**
	 * An order line carrying one selection.
	 *
	 * @param string      $option_id  The option's id.
	 * @param string      $value_key  The chosen value's key, '' for free text.
	 * @param string      $delta      The line's recorded delta, as a decimal string.
	 * @param string|null $label      The option's display label.
	 * @param string|null $shown      The value the customer saw.
	 */
	private function line(
		string $option_id = 'finish',
		string $value_key = 'lux',
		string $delta = '99.00',
		?string $label = 'Finish',
		?string $shown = 'lux'
	): object {
		$item = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, wp_json_encode( array( $option_id => $value_key ) ), true );
		$item->add_meta_data( Keys::META_PRICE_DELTA, $delta, true );
		$item->add_meta_data( Keys::META_CONFIG_VERSION, '7', true );

		if ( null !== $label && null !== $shown ) {
			$item->add_meta_data( $label, $shown, true );
		}

		return $item;
	}

	// --- The shape the API requires ------------------------------------------

	/** Every field the endpoint validates is present and correct. */
	public function test_builds_the_documented_shape(): void {
		$order          = optionia_test_order( 1042, '179.00', 'GBP' );
		$order->items[] = $this->line();

		$body = ( new OrderPayload() )->build( $order );

		$this->assertSame( '1042', $body['external_order_id'] );
		$this->assertSame( 17900, $body['order_total_minor'] );
		$this->assertSame( 'GBP', $body['currency'] );
		$this->assertSame( 9900, $body['option_revenue_minor'] );
		$this->assertSame( '2026-08-30T10:00:00+00:00', $body['occurred_at'] );
		$this->assertCount( 1, $body['selections'] );
	}

	/**
	 * The total is converted without a float landing short.
	 *
	 * `(int) ( 17.9 * 100 )` is 1789, not 1790 — the class of bug that made
	 * Phase 11's pricing wrong, so the conversion rounds rather than casts.
	 *
	 * @dataProvider provide_totals
	 *
	 * @param string $total    What WooCommerce returns.
	 * @param int    $expected Minor units.
	 */
	public function test_converts_totals_exactly( string $total, int $expected ): void {
		$order = optionia_test_order( 1, $total );

		$this->assertSame( $expected, ( new OrderPayload() )->build( $order )['order_total_minor'] );
	}

	/**
	 * Totals that break a naive cast.
	 *
	 * @return array<string, array{string, int}>
	 */
	public static function provide_totals(): array {
		return array(
			'the classic' => array( '17.90', 1790 ),
			'one decimal' => array( '17.9', 1790 ),
			'whole'       => array( '80.00', 8000 ),
			'third'       => array( '0.29', 29 ),
			'large'       => array( '99999.99', 9999999 ),
			'zero'        => array( '0.00', 0 ),
		);
	}

	/** The currency is upper-cased. */
	public function test_upper_cases_the_currency(): void {
		$order = optionia_test_order( 1, '10.00', 'gbp' );

		$this->assertSame( 'GBP', ( new OrderPayload() )->build( $order )['currency'] );
	}

	// --- The privacy rule ----------------------------------------------------

	/**
	 * 🔒 **A fixed choice reports its label; free text reports null.**
	 *
	 * The decision recorded in M12.7: an option's value may be an engraving
	 * message, a gift note or a customer's name, and Phase 25 asks how many
	 * customers bought engraving and what it earned — not what they wrote.
	 *
	 * A value key exists only where the merchant defined a choice, so its
	 * presence is the test. This is the assertion that keeps ADR-014's erase
	 * path a safeguard rather than a routine obligation.
	 */
	public function test_free_text_is_never_sent(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'engraving', '', '15.00', 'Engraving', 'For Sarah, with love' );

		$selection = ( new OrderPayload() )->build( $order )['selections'][0];

		$this->assertSame( 'engraving', $selection['option_key'] );
		$this->assertNull( $selection['value_label'], 'The customer\'s own words must not leave the store.' );
		$this->assertSame( 1500, $selection['price_delta_minor'], 'The revenue is still reported.' );
	}

	/**
	 * 🔴 **A free-text option sends `null` for its value key, never `''`.**
	 *
	 * Found 2026-09-01 by posting a real payload at the live endpoint. The API
	 * validates `value_key` at 1–64 characters, so an empty string is a 400 for
	 * the **whole order** — and `Reporting\OrderReporter` treats a 400 as
	 * permanent, so every engraving order would have been dropped in silence.
	 *
	 * Neither suite could see it: each proved its own half of a contract the two
	 * only meet across a network. This asserts the exact shape the API accepts.
	 */
	public function test_a_free_text_value_key_is_null_not_empty(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'engraving', '', '15.00', 'Engraving', 'For Sarah' );

		$selection = ( new OrderPayload() )->build( $order )['selections'][0];

		$this->assertNull( $selection['value_key'], 'An empty string is a 400 for the whole order.' );
	}

	/**
	 * Every string the API bounds at 1 character is null or non-empty.
	 *
	 * The general form of the bug above, so a future field cannot repeat it.
	 */
	public function test_no_bounded_string_is_ever_empty(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'engraving', '', '15.00', 'Engraving', 'text' );
		$order->items[] = $this->line();

		$body = ( new OrderPayload() )->build( $order );

		$this->assertNotSame( '', $body['external_order_id'] );
		$this->assertSame( 3, strlen( $body['currency'] ) );

		foreach ( $body['selections'] as $selection ) {
			$this->assertNotSame( '', $selection['option_key'] );
			$this->assertNotSame( '', $selection['option_label'] );
			$this->assertNotSame( '', $selection['value_key'] );
			$this->assertNotSame( '', $selection['value_label'] );
		}
	}

	/** A merchant-defined choice is not personal data, and is sent. */
	public function test_a_fixed_choice_is_sent(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line();

		$selection = ( new OrderPayload() )->build( $order )['selections'][0];

		$this->assertSame( 'lux', $selection['value_key'] );
		$this->assertSame( 'lux', $selection['value_label'] );
	}

	// --- Truncation, and why it exists ---------------------------------------

	/**
	 * **Over-long strings are cut before sending, not rejected by the API.**
	 *
	 * `forbidNonWhitelisted` makes an over-long field a 400 for the *whole*
	 * request, and it would fail identically on every retry — so one long label
	 * would hold that order in the queue forever. The same trap took the
	 * heartbeat, where distribution PHP versions exceed its 20-character cap.
	 */
	public function test_truncates_an_over_long_label(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'finish', 'lux', '10.00', str_repeat( 'x', 250 ), 'lux' );

		$selection = ( new OrderPayload() )->build( $order )['selections'][0];

		$this->assertSame( 200, strlen( $selection['option_label'] ) );
	}

	/**
	 * Truncation does not split a multibyte character.
	 *
	 * A label cut mid-character is invalid UTF-8, and `wp_json_encode()` returns
	 * `false` for it — turning a too-long label into a report with no body.
	 */
	public function test_truncation_preserves_valid_utf8(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'finish', 'lux', '10.00', str_repeat( 'é', 250 ), 'lux' );

		$body = ( new OrderPayload() )->build( $order );

		$this->assertNotFalse(
			wp_json_encode( $body ),
			'A label cut mid-character would make the whole report unencodable.'
		);
	}

	/** The selections cap matches the API's, so a huge order still reports. */
	public function test_caps_the_number_of_selections(): void {
		$order = optionia_test_order( 1 );

		for ( $i = 0; $i < 250; $i++ ) {
			$order->items[] = $this->line( 'opt-' . $i, 'v', '1.00', 'Option', 'v' );
		}

		$body = ( new OrderPayload() )->build( $order );

		$this->assertCount( 200, $body['selections'] );
		$this->assertSame( '1042', ( new OrderPayload() )->build( optionia_test_order( 1042 ) )['external_order_id'] );
	}

	// --- Revenue -------------------------------------------------------------

	/** Option revenue is the sum across lines. */
	public function test_sums_option_revenue_across_lines(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'finish', 'lux', '99.00' );
		$order->items[] = $this->line( 'size', 'xl', '20.00', 'Size', 'xl' );

		$this->assertSame( 11900, ( new OrderPayload() )->build( $order )['option_revenue_minor'] );
	}

	/** A discount option reduces the reported revenue. */
	public function test_a_negative_delta_reduces_revenue(): void {
		$order          = optionia_test_order( 1 );
		$order->items[] = $this->line( 'bundle', 'yes', '-5.00', 'Bundle', 'yes' );

		$this->assertSame( -500, ( new OrderPayload() )->build( $order )['option_revenue_minor'] );
	}

	// --- Boundaries ----------------------------------------------------------

	/** An order with no options is still reportable revenue. */
	public function test_an_order_with_no_options_still_reports(): void {
		$order = optionia_test_order( 1, '80.00' );

		$body = ( new OrderPayload() )->build( $order );

		$this->assertSame( array(), $body['selections'] );
		$this->assertSame( 8000, $body['order_total_minor'] );
		$this->assertSame( 0, $body['option_revenue_minor'] );
	}

	/** A line with malformed selections is skipped, not fatal. */
	public function test_malformed_selections_are_skipped(): void {
		$order = optionia_test_order( 1 );
		$item  = optionia_test_order_item();
		$item->add_meta_data( Keys::META_SELECTIONS, '{"broken":', true );
		$order->items[] = $item;

		$this->assertSame( array(), ( new OrderPayload() )->build( $order )['selections'] );
	}

	/** An object that is not an order yields nothing. */
	public function test_a_non_order_yields_null(): void {
		$this->assertNull( ( new OrderPayload() )->build( new \stdClass() ) );
	}

	/** An order with no id cannot be reported. */
	public function test_an_order_without_an_id_yields_null(): void {
		$this->assertNull( ( new OrderPayload() )->build( optionia_test_order( 0 ) ) );
	}
}
