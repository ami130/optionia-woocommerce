<?php
/**
 * Turns a WooCommerce order into the facts the cloud records (M12.7).
 *
 * ## What this deliberately does not send
 *
 * 🔒 **Free text never leaves the merchant's server.** An option's stored value
 * may be an engraving message, a gift note or a customer's name, and Phase 25
 * asks *how many customers bought engraving and what it earned* — not what they
 * wrote. So a selection reports its keys and the option's label, and sends
 * `null` for the value label whenever the value is free text rather than one of
 * the merchant's fixed choices.
 *
 * The distinction is available without guessing: `Keys::META_SELECTIONS` holds
 * `option id => value key`, and a value key exists only where the merchant
 * defined a choice. A free-text option has no key, so there is nothing to send.
 *
 * That keeps [ADR-014]'s hard-erase obligation a safeguard rather than a routine
 * one, and means a subject-access request is answered by the merchant's own
 * order records, which is where the data already was.
 *
 * ## Why every string is truncated before sending
 *
 * The API validates `option_label` at 200 characters and rejects an over-long
 * field with a `400` for the **whole** request. An order carrying one long label
 * would therefore never report at all — and it would fail identically on every
 * retry, so the queue would hold it forever.
 *
 * This is not hypothetical: the same trap took `Connection\Heartbeat`, where
 * distribution PHP versions like `8.1.2-1ubuntu2.14+deb.sury.org+1` exceed the
 * 20-character cap and would have silenced the most common hosting stack in
 * WooCommerce.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Reporting;

use Optionia\Support\Keys;
use Optionia\Support\Money;
use Optionia\Support\OptionLabel;

defined( 'ABSPATH' ) || exit;

/**
 * Builds the order-report body.
 */
final class OrderPayload {

	/**
	 * Field bounds, mirroring the API's validation exactly.
	 *
	 * Named rather than inlined so the mirroring is visible: a change on either
	 * side that is not made on the other is a silently unreportable order.
	 */
	private const MAX_ORDER_ID     = 64;
	private const MAX_OPTION_KEY   = 64;
	private const MAX_OPTION_LABEL = 200;
	private const MAX_VALUE_KEY    = 64;
	private const MAX_VALUE_LABEL  = 500;

	/**
	 * The most selections one report may carry, matching the API's cap.
	 */
	private const MAX_SELECTIONS = 200;

	/**
	 * The largest amount either language can hold exactly.
	 *
	 * `2^53 - 1`, JavaScript's limit rather than PHP's: the backend refuses
	 * beyond it, so refusing here means the pair fails identically instead of
	 * one truncating what the other accepted.
	 */
	private const MAX_MINOR = 9007199254740991;

	/**
	 * Build the report body for an order.
	 *
	 * @param object $order A `WC_Order`.
	 * @return array<string, mixed>|null Null when the order cannot be reported.
	 */
	public function build( object $order ): ?array {
		if ( ! method_exists( $order, 'get_id' ) || ! method_exists( $order, 'get_items' ) ) {
			return null;
		}

		$order_id = (string) $order->get_id();

		if ( '' === $order_id || '0' === $order_id ) {
			return null;
		}

		$selections = $this->selections( $order );

		return array(
			'external_order_id'    => $this->clamp( $order_id, self::MAX_ORDER_ID ),
			'order_total_minor'    => $this->minor( $order, 'get_total' ),
			'currency'             => $this->currency( $order ),
			'option_revenue_minor' => $this->option_revenue( $selections ),
			'occurred_at'          => $this->occurred_at( $order ),
			'selections'           => $selections,
		);
	}

	/**
	 * Every option selected across the order's lines.
	 *
	 * @param object $order A `WC_Order`.
	 * @return array<int, array<string, mixed>>
	 */
	private function selections( object $order ): array {
		$items = $order->get_items();

		if ( ! is_array( $items ) ) {
			return array();
		}

		$selections = array();

		foreach ( $items as $item ) {
			if ( ! is_object( $item ) || ! method_exists( $item, 'get_meta' ) ) {
				continue;
			}

			foreach ( $this->line_selections( $item ) as $selection ) {
				if ( count( $selections ) >= self::MAX_SELECTIONS ) {
					/*
					 * The cap is the API's. Sending more would earn a 400 for
					 * the whole order, so a truncated report is strictly better
					 * than none -- the event and its revenue are still recorded.
					 */
					return $selections;
				}

				$selections[] = $selection;
			}
		}

		return $selections;
	}

	/**
	 * One line's selections.
	 *
	 * @param object $item An order line item.
	 * @return array<int, array<string, mixed>>
	 */
	private function line_selections( object $item ): array {
		$raw = $item->get_meta( Keys::META_SELECTIONS );

		if ( ! is_string( $raw ) || '' === $raw ) {
			return array();
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) ) {
			return array();
		}

		$config_version = $item->get_meta( Keys::META_CONFIG_VERSION );
		$config_version = is_numeric( $config_version ) ? max( 0, (int) $config_version ) : 0;

		$out = array();

		foreach ( $decoded as $option_id => $value_key ) {
			if ( ! is_scalar( $option_id ) ) {
				continue;
			}

			/*
			 * 🔴 **A multi-select answer is a LIST, and dropping it lost the
			 * merchant's numbers.**
			 *
			 * This read `! is_scalar( $value_key ) → continue`, so an option at
			 * `cardinality: many` vanished from the report entirely. Measured:
			 * an order carrying `{"opt-a":"lux","opt-m":["red","blue"]}` was
			 * reported as `["opt-a"]` alone.
			 *
			 * ⚠️ **And when the multi-select was the line's ONLY option, the
			 * line's revenue went with it.** `attribute_delta()` puts the whole
			 * line's delta on `$selections[0]`, so a line with no rows at all
			 * reports **nothing** — not a mis-attributed amount, a missing one.
			 *
			 * 📌 **Analytics was one of the nine consumers M18.2 named.** Eight
			 * were carried; this one was missed, and `OrderPayloadTest` had no
			 * multi-select case to catch it — the sixth occurrence in this
			 * phase of a consumer that expected a scalar.
			 *
			 * 🔴 **One row per OPTION, not per value**, matching every other
			 * consumer: the cart line, the order meta and `labels` all name an
			 * option once and carry its values within. The visible meta the
			 * labels are matched against is already one joined string —
			 * `"Red, Blue"` — so a row per value would have nothing to match.
			 */
			$value_key = is_array( $value_key )
				? implode( OptionLabel::JOIN, array_filter( $value_key, 'is_scalar' ) )
				: $value_key;

			if ( ! is_scalar( $value_key ) ) {
				continue;
			}

			$labels = $this->labels_for( $item, (string) $option_id, (string) $value_key );

			/*
			 * `null`, not `''`, for a free-text option.
			 *
			 * 🔴 The API validates `value_key` at 1-64 characters and rejects an
			 * empty string with a 400 for the *whole* order -- which this class
			 * treats as permanent, so every engraving order would have been
			 * silently dropped. Found 2026-09-01 by posting a real payload at
			 * the live endpoint; both test suites passed without noticing,
			 * because each only ever saw its own side of the contract.
			 */
			$key = $this->clamp( (string) $value_key, self::MAX_VALUE_KEY );

			$out[] = array(
				'option_key'        => $this->clamp( (string) $option_id, self::MAX_OPTION_KEY ),
				'option_label'      => $this->clamp( $labels['option'], self::MAX_OPTION_LABEL ),
				'value_key'         => '' === $key ? null : $key,
				'value_label'       => $labels['value'],
				'price_delta_minor' => 0,
				'config_version'    => $config_version,
			);
		}

		return $this->attribute_delta( $out, $item );
	}

	/**
	 * A displayed value with its price suffix removed.
	 *
	 * `OrderLineItem::with_price()` appends ` (+£20.00)` or ` (-£20.00)` to the
	 * value a customer saw. This reverses that for **matching only** — the
	 * displayed string itself is never rewritten, because it is the merchant's
	 * permanent record of what was ordered and what it cost.
	 *
	 * ⚠️ **Anchored to the end and to the `(+…)`/`(-…)` shape `with_price()`
	 * writes**, which narrows but does not eliminate the overlap: a customer's
	 * own value ending in `(+something)` is stripped too.
	 *
	 * ✅ **That is harmless, and only because this is used for matching alone.**
	 * The stripped string is never stored or displayed — a false strip can only
	 * make the comparison *miss*, which leaves the option name as its id, the
	 * same graceful degradation as an unmatched row. Measured before relying on
	 * it: an unanchored pattern passes the same tests, so the anchor is
	 * belt-and-braces rather than the thing that makes this safe.
	 *
	 * @param string $value The value as displayed on the order.
	 */
	private static function without_price( string $value ): string {
		return (string) preg_replace( '/ \([+-][^()]*\)$/u', '', $value );
	}

	/**
	 * The human labels for one selection, with free text withheld.
	 *
	 * The visible order meta is keyed by the option's **label** and holds the
	 * value the customer saw, which for a fixed choice is `Luxury` and for a
	 * text option is whatever they typed. Only the first is sent.
	 *
	 * @param object $item      An order line item.
	 * @param string $option_id The option's id.
	 * @param string $value_key The stored value key.
	 * @return array{option: string, value: string|null}
	 */
	private function labels_for( object $item, string $option_id, string $value_key ): array {
		$option_label = $option_id;
		$value_label  = null;

		if ( method_exists( $item, 'get_formatted_meta_data' ) ) {
			$visible = $item->get_formatted_meta_data( '' );

			if ( is_array( $visible ) ) {
				foreach ( $visible as $meta ) {
					if ( ! is_object( $meta ) || ! isset( $meta->value, $meta->key ) ) {
						continue;
					}

					/*
					 * Matched on the value the customer saw, **with any price
					 * suffix removed first**.
					 *
					 * 🔴 **A labelled choice never matches here**, and that is by
					 * design: its displayed value is `Luxury` where its key is
					 * `lux`, so the option name stays the id. This only ever
					 * recovers a name for an **unlabelled** choice, where
					 * `OptionLabel::value()` falls back to the key itself.
					 *
					 * ✏️ **M21b.4 broke exactly that one working case.** The
					 * order row gained its price — `lux` became
					 * `lux (+£20.00)` — so the equality failed and reporting
					 * degraded `Finish` to the raw `opt-a`. Nothing caught it:
					 * no test covered an unlabelled **priced** choice.
					 *
					 * ⚠️ **The suffix is stripped rather than rebuilt.**
					 * Reconstructing `' (' . money . ')'` here would be a second
					 * copy of `with_price()`'s format, and the two would drift
					 * the first time either changed.
					 */
					if ( self::without_price( (string) $meta->value ) === $value_key ) {
						$option_label = (string) $meta->key;
					}
				}
			}
		}

		/*
		 * 🔒 The privacy rule, and the whole reason this method exists.
		 *
		 * A value key is only ever written for a choice the merchant defined,
		 * so its presence is the test for "this is not the customer's own
		 * words". Free text reaches here with an empty key and reports null.
		 */
		if ( '' !== $value_key ) {
			$value_label = $this->clamp( $value_key, self::MAX_VALUE_LABEL );
		}

		return array(
			'option' => $option_label,
			'value'  => $value_label,
		);
	}

	/**
	 * Attribute the line's recorded delta across its selections.
	 *
	 * The order records one delta per **line**, not per option, because that is
	 * what the customer was charged. Splitting it evenly would invent precision
	 * the record does not have, so the whole amount is attributed to the first
	 * selection and the rest report zero: the line's total is then right, which
	 * is the number Phase 25 sums.
	 *
	 * @param array<int, array<string, mixed>> $selections The line's selections.
	 * @param object                           $item       An order line item.
	 * @return array<int, array<string, mixed>>
	 */
	private function attribute_delta( array $selections, object $item ): array {
		if ( array() === $selections ) {
			return $selections;
		}

		$delta = $item->get_meta( Keys::META_PRICE_DELTA );

		if ( ! is_scalar( $delta ) ) {
			return $selections;
		}

		/*
		 * Through `Support\Money`, not a float multiplication (Principle 5).
		 * The delta is a decimal string on the order, and `(int) ( 17.9 * 100 )`
		 * is 1789 -- the conversion scales the digits instead of the float.
		 */
		$money = Money::try_from_decimal( (string) $delta, 2 );

		if ( null === $money ) {
			return $selections;
		}

		$minor = $money->minor();

		if ( abs( $minor ) > self::MAX_MINOR ) {
			return $selections;
		}

		$selections[0]['price_delta_minor'] = $minor;

		return $selections;
	}

	/**
	 * What the options contributed across the order.
	 *
	 * @param array<int, array<string, mixed>> $selections Every selection.
	 */
	private function option_revenue( array $selections ): int {
		$total = 0;

		foreach ( $selections as $selection ) {
			$total += (int) $selection['price_delta_minor'];
		}

		return $total;
	}

	/**
	 * An order amount in integer minor units.
	 *
	 * @param object $order  A `WC_Order`.
	 * @param string $getter The accessor to read.
	 */
	private function minor( object $order, string $getter ): int {
		if ( ! method_exists( $order, $getter ) ) {
			return 0;
		}

		$value = $order->{$getter}();

		if ( ! is_scalar( $value ) ) {
			return 0;
		}

		/*
		 * `WC_Order::get_total()` returns a decimal string, and it goes through
		 * `Support\Money` for the reason Principle 5 exists: `(int) ( 17.9 *
		 * 100 )` is 1789. Two decimals rather than the store's setting, because
		 * the API reads minor units as hundredths regardless of how the shop
		 * displays them.
		 */
		$money = Money::try_from_decimal( (string) $value, 2 );

		if ( null === $money ) {
			return 0;
		}

		return max( 0, min( $money->minor(), self::MAX_MINOR ) );
	}

	/**
	 * The order's currency, as three upper-case characters.
	 *
	 * @param object $order A `WC_Order`.
	 */
	private function currency( object $order ): string {
		$currency = method_exists( $order, 'get_currency' ) ? $order->get_currency() : '';
		$currency = is_string( $currency ) ? strtoupper( trim( $currency ) ) : '';

		/*
		 * The API requires exactly three characters. An order with no currency
		 * -- possible on a partially-built order -- would otherwise fail
		 * validation forever, so the store's own setting stands in.
		 */
		if ( 3 !== strlen( $currency ) ) {
			$fallback = function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '';
			$currency = is_string( $fallback ) ? strtoupper( trim( $fallback ) ) : '';
		}

		return 3 === strlen( $currency ) ? $currency : 'USD';
	}

	/**
	 * When the order was placed, in ISO-8601.
	 *
	 * The store's clock, sent rather than left to arrival time: a queued report
	 * can arrive hours late after an outage, and analytics that dated it on
	 * arrival would misattribute a whole day's revenue after every incident.
	 *
	 * @param object $order A `WC_Order`.
	 */
	private function occurred_at( object $order ): string {
		if ( method_exists( $order, 'get_date_created' ) ) {
			$created = $order->get_date_created();

			if ( is_object( $created ) && method_exists( $created, 'date' ) ) {
				return (string) $created->date( 'c' );
			}
		}

		return gmdate( 'c' );
	}

	/**
	 * Cut a string to the API's bound, without splitting a character.
	 *
	 * `mb_substr` rather than `substr`: a label ending mid-multibyte-character
	 * is invalid UTF-8, and `wp_json_encode()` returns `false` for it — turning
	 * a too-long label into a report with no body at all.
	 *
	 * @param string $value  The string.
	 * @param int    $length The bound.
	 */
	private function clamp( string $value, int $length ): string {
		if ( function_exists( 'mb_substr' ) ) {
			return mb_substr( $value, 0, $length );
		}

		return substr( $value, 0, $length );
	}
}
