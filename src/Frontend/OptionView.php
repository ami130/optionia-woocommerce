<?php
/**
 * View helpers shared by every option template.
 *
 * ## Why this exists
 *
 * The six templates in `templates/options/` each computed their own
 * `aria-describedby`, and each associated **only** `description` — so
 * `help_text`, which the API publishes on every option, rendered nowhere at all.
 * M14.4b requires it: *"`help_text` and `tooltip` must be associated via
 * `aria-describedby`"*, and M29.7b makes that accessibility rather than polish.
 *
 * Fixing it in six places would have meant six chances to get a
 * space-separated id list subtly wrong, and a seventh template would inherit
 * whichever copy it was pasted from. So the rule is written once.
 *
 * ⚠️ **Presentation only.** Nothing here escapes for output — templates escape
 * at the point of use, which is the convention `Templates::output()` documents
 * and the one PHPCS enforces.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Frontend;

defined( 'ABSPATH' ) || exit;

/**
 * Presentation helpers for option templates.
 */
final class OptionView {

	/**
	 * The guidance blocks an option carries, in the order they are rendered.
	 *
	 * `description` first, then `help_text`: a description says *what the option
	 * is* and help text says *how to answer it*, so a screen reader announcing
	 * them in that order matches the sighted reading order down the page.
	 *
	 * Each entry is `array{ id: string, text: string, class: string }`. An
	 * absent or blank field contributes nothing — an empty `<p>` with an id
	 * would be announced as a pause with no content.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @return array<int, array{id: string, text: string, class: string}>
	 */
	public static function guidance( array $option ): array {
		$id     = isset( $option['id'] ) ? (string) $option['id'] : '';
		$blocks = array();

		if ( '' === $id ) {
			return $blocks;
		}

		$fields = array(
			'description' => array( 'optionia-desc-', 'optionia-option__description' ),
			'help_text'   => array( 'optionia-help-', 'optionia-option__help' ),

			/*
			 * ⚠️ **A tooltip is announced, not hovered.** M29.7b is explicit: a
			 * tooltip reachable only by hover is invisible to a large group of
			 * customers. Including it here means a screen reader reads it with
			 * the control, and a `title` attribute — which is hover-only and
			 * inconsistently announced — is never used.
			 */
			'tooltip'     => array( 'optionia-tip-', 'optionia-option__tooltip' ),
		);

		foreach ( $fields as $field => $parts ) {
			/*
			 * ⚠️ **The tooltip lives in `display`, the others on the option.**
			 *
			 * `description` and `help_text` are columns; a tooltip is display
			 * configuration (M14.4b). Reading it from the wrong place would have
			 * meant it silently never rendered — which is how `help_text` itself
			 * went unrendered across all six templates until Stage 3c.
			 */
			$source = 'tooltip' === $field
				? ( isset( $option['display'] ) && is_array( $option['display'] ) ? $option['display'] : array() )
				: $option;

			$text = isset( $source[ $field ] ) && is_scalar( $source[ $field ] )
				? trim( (string) $source[ $field ] )
				: '';

			if ( '' === $text ) {
				continue;
			}

			$blocks[] = array(
				'id'    => $parts[0] . $id,
				'text'  => $text,
				'class' => $parts[1],
			);
		}

		return $blocks;
	}

	/**
	 * An option's display configuration, with every value already validated.
	 *
	 * 🔴 **Read once, here, rather than in every template.** Each setting is
	 * a small decision — is `columns` an integer, is `swatch_size` one of three
	 * words — and one copy of that reasoning per template is one chance per
	 * template to disagree. A template asks for the answer, not for the raw
	 * array. Written as "fourteen" until 2026-09-10, when there were fifteen:
	 * the argument does not depend on the number, so it no longer states one.
	 *
	 * Every unrecognised or malformed value falls back to the default rather
	 * than being rendered: a `swatch_size` of `"enormous"` must not reach a class
	 * attribute, and `columns: 99` must not produce a grid nobody can read.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @return array{columns: int, swatch_size: string, price_display: string,
	 *               collapsed: bool, tooltip: string}
	 */
	public static function display( array $option ): array {
		$config = isset( $option['display'] ) && is_array( $option['display'] ) ? $option['display'] : array();

		$columns = isset( $config['columns'] ) && is_int( $config['columns'] )
			&& $config['columns'] >= 1 && $config['columns'] <= 6
				? $config['columns']
				: 1;

		$size = isset( $config['swatch_size'] ) && is_scalar( $config['swatch_size'] )
			? (string) $config['swatch_size']
			: '';

		if ( ! in_array( $size, array( 'small', 'medium', 'large' ), true ) ) {
			$size = 'medium';
		}

		$price = isset( $config['price_display'] ) && is_scalar( $config['price_display'] )
			? (string) $config['price_display']
			: '';

		if ( ! in_array( $price, array( 'delta', 'total', 'hidden' ), true ) ) {
			// `delta` is the default because it is the honest framing: an option
			// adds to a price the customer has already seen.
			$price = 'delta';
		}

		$tooltip = isset( $config['tooltip'] ) && is_scalar( $config['tooltip'] )
			? trim( (string) $config['tooltip'] )
			: '';

		return array(
			'columns'       => $columns,
			'swatch_size'   => $size,
			'price_display' => $price,
			'collapsed'     => ! empty( $config['collapsed_by_default'] ),
			'tooltip'       => $tooltip,
		);
	}

	/**
	 * An option's style tokens, as a `style` attribute or `''` (M21c.2/M21c.4).
	 *
	 * 🔴 **Re-validated here even though the API already validated on the way
	 * in.** M21c.4 is *"non-negotiable"* for one reason: the plugin renders a
	 * config document **fetched from the cloud**, so every value is untrusted
	 * input at the point it becomes CSS. A document can be stale, hand-edited in
	 * the options table, replayed from a cache written before a schema
	 * tightened, or served by something that is not the API. The backend check
	 * rejects a bad value; this one refuses to *emit* one, and neither makes
	 * the other redundant.
	 *
	 * ⚠️ **Fail to nothing, never to a guess.** M9.6's posture: an option whose
	 * styles cannot be validated renders with defaults and the option set still
	 * renders. A rejected token is omitted from the attribute rather than
	 * replaced — a wrong colour is worse than the theme's own.
	 *
	 * ⚠️ **Custom properties, not declarations.** Everything emitted is
	 * `--optionia-*`, so a malformed value can at worst define a variable
	 * nothing reads. `accent_color` written straight into `color:` would put
	 * merchant data in a property the browser acts on.
	 *
	 * 🔴 **No `!important`** (ADR-112): merchant CSS must always be able to win.
	 *
	 * ⚠️ **Templates still wrap this in `esc_attr()`, though a mutation removing
	 * it survives.** Everything emitted is hex digits, integers and `--optionia-`
	 * names, so escaping is a no-op on any string this method can return — the
	 * mutant is equivalent. It stays because the escaping is what makes that
	 * true *at the template*, where a future edit might interpolate something
	 * this method did not produce.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @return string A `style` attribute value, escaped again by the caller.
	 */
	public static function styles( array $option ): string {
		/*
		 * ⚠️ **`is_array` rather than a cast, though a mutation of it survives.**
		 * `(array) 'nonsense'` is `array( 0 => 'nonsense' )`, which carries none
		 * of the named keys below, so nothing would be emitted either way — the
		 * mutant is equivalent, and that is a property of the code rather than a
		 * gap in the tests. It is spelled out because the next reader should not
		 * have to rediscover why a surviving mutation is the right answer here.
		 */
		$config = isset( $option['display'] ) && is_array( $option['display'] ) ? $option['display'] : array();

		$out = array();

		/*
		 * Six hex digits, and nothing else. The same pattern `color_swatch.php`
		 * has always used for a merchant colour, and the same one the API
		 * enforces — three spellings of one rule is how they come to disagree.
		 *
		 * ⚠️ **Shorthand is refused on purpose.** `#f00` is valid CSS, but it is
		 * a second spelling of a value the authoring layer cannot produce, so
		 * accepting it here would mean the plugin renders something the
		 * dashboard would reject.
		 */
		$accent = isset( $config['accent_color'] ) && is_string( $config['accent_color'] )
			? $config['accent_color']
			: '';

		if ( 1 === preg_match( '/^#[0-9a-fA-F]{6}$/', $accent ) ) {
			$out[] = '--optionia-accent: ' . $accent;
		}

		/*
		 * Integers within the authored range. `is_int` rather than `is_numeric`:
		 * `"4"` and `4.5` both reach a stylesheet as something that renders, and
		 * a float pixel is not a pixel count.
		 */
		foreach ( array(
			'border_radius' => array( 'radius', 0, 24 ),
			'spacing'       => array( 'gap', 0, 48 ),
			'swatch_px'     => array( 'swatch', 16, 128 ),
		) as $key => $spec ) {
			list( $name, $min, $max ) = $spec;

			if ( ! isset( $config[ $key ] ) || ! is_int( $config[ $key ] ) ) {
				continue;
			}

			$value = $config[ $key ];

			if ( $value < $min || $value > $max ) {
				continue;
			}

			$out[] = '--optionia-' . $name . ': ' . $value . 'px';
		}

		return array() === $out ? '' : implode( '; ', $out ) . ';';
	}

	/**
	 * A divider's style, re-validated at the point it becomes a class (M21c.5).
	 *
	 * 🔴 **Re-validated even though the API validated on the way in**, for the
	 * same reason `styles()` is: the plugin renders a config document **fetched
	 * from the cloud**, which can be stale, hand-edited in the options table,
	 * replayed from a cache written before a schema tightened, or served by
	 * something that is not the API. The backend rejects a bad value; this
	 * refuses to emit one.
	 *
	 * ⚠️ **An allowlist, not a sanitiser.** The three styles are the three
	 * `border-style` keywords ADR-113 chose, and anything else falls back to
	 * `solid` rather than reaching a class attribute — the same stance
	 * `display()` takes on `swatch_size`.
	 *
	 * @param array<string, mixed> $item One published presentational item.
	 * @return string One of `solid`, `dashed`, `dotted`.
	 */
	public static function divider_style( array $item ): string {
		$config = isset( $item['display'] ) && is_array( $item['display'] ) ? $item['display'] : array();

		$style = isset( $config['style'] ) && is_scalar( $config['style'] )
			? (string) $config['style']
			: '';

		/*
		 * ⚠️ **`true` for strict, though a mutation to loose comparison
		 * survives.** The `(string)` cast above means only strings reach here,
		 * and loose and strict agree on every string — measured across `0`,
		 * `'0'`, `true`, `3`, `''` and `'solid '`. The mutant is equivalent,
		 * which is a property of the cast rather than a gap in the tests. Strict
		 * stays because the cast is what makes it moot, and a later edit that
		 * removed the cast would need it.
		 */
		return in_array( $style, array( 'solid', 'dashed', 'dotted' ), true ) ? $style : 'solid';
	}

	/**
	 * The price to print beside one choice, or `''` for none.
	 *
	 * 🔴 **The first per-choice price this plugin shows.** Until M18.6b, prices
	 * reached the page only as `data-optionia-price` attributes for the running
	 * estimate — no template rendered one. `price_display` was normalised in
	 * `display()` above and read by nothing, which is the state ADR-064 kept it
	 * out of withdrawal to fix.
	 *
	 * ⚠️ **`total` renders as `delta`** (ADR-065). A total is `base + option`,
	 * and no option template has the base price — but the blocker is not
	 * plumbing. `frontend.js` listens to **no** WooCommerce variation events,
	 * deliberately, because *"the estimate is an options delta, not a product
	 * total… none of those change when a customer picks a different size."* A
	 * printed total would be stale the moment a customer picks a size, which is
	 * a wrong price beside a control. Phase 21's server-quoted preview owns it.
	 *
	 * 🔴 **Only `fixed` is priced**, matching `PRICEABLE` in the runtime. A
	 * `percentage` or `per_unit` value prints nothing rather than a guess: *"a
	 * storefront guessing… would show a total the server disagrees with, which
	 * is worse than showing none."*
	 *
	 * ⚠️ **A zero prints nothing.** `+0.00` beside a free choice reads as a
	 * mistake — the same reasoning `CartDisplay::with_price()` records for a
	 * cart line.
	 *
	 * @param array<string, mixed> $value   One published value.
	 * @param string               $display The option's `price_display`.
	 * @return string A formatted price, or `''`.
	 */
	public static function value_price( array $value, string $display ): string {
		if ( 'hidden' === $display ) {
			return '';
		}

		/*
		 * ⚠️ **Named `$price`, not `$config`, and the name is load-bearing.**
		 * `bin/check-wire-keys.sh` scans this file for `$config['…']` to learn
		 * which *validation and display* rules the plugin reads, and reports any
		 * the API never publishes. A price config read through that name made
		 * the gate report `amount_minor` and `type` as unpublished rules —
		 * a true statement about the wrong contract.
		 */
		$price = isset( $value['price_config'] ) && is_array( $value['price_config'] )
			? $value['price_config']
			: array();

		$type = isset( $price['type'] ) ? (string) $price['type'] : '';

		if ( 'fixed' !== $type || ! isset( $price['amount_minor'] ) || ! is_int( $price['amount_minor'] ) ) {
			return '';
		}

		$minor = (int) $price['amount_minor'];

		if ( 0 === $minor ) {
			return '';
		}

		$amount = self::money( abs( $minor ) );

		return $minor > 0 ? '+' . $amount : '-' . $amount;
	}

	/**
	 * Minor units as this store writes money.
	 *
	 * 🔴 **Formatted the way `frontend.js` formats the estimate**, field for
	 * field — the same `decimals`, separators and `woocommerce_price_format`
	 * pattern that `Assets::currency_settings()` publishes to it. A price
	 * printed here and a total summed there that disagreed about a separator
	 * would read as two different currencies on one page.
	 *
	 * ⚠️ **Not `wc_price()`**, which wraps its output in markup and applies
	 * `woocommerce_price_format` plus filters a theme may have changed. The
	 * estimate cannot call those from JavaScript, so matching them here would
	 * be matching something the other half cannot see.
	 *
	 * 📌 **Public since M21b.3, because the cart needs the same answer.**
	 * `CartDisplay` printed `Money::to_decimal_string()` — a **wire** format,
	 * *"suitable for handing back to WooCommerce"* — so a breakdown read
	 * `100.00` beside a storefront label reading `£100.00`. One plugin, one
	 * customer, two different-looking prices. Sharing this rather than copying
	 * it means a store's separators cannot be right on one surface and wrong on
	 * the other.
	 *
	 * @param int $minor Amount in integer minor units, non-negative.
	 */
	public static function money( int $minor ): string {
		$decimals = function_exists( 'wc_get_price_decimals' ) ? (int) wc_get_price_decimals() : 2;
		$decimal  = function_exists( 'wc_get_price_decimal_separator' ) ? (string) wc_get_price_decimal_separator() : '.';
		$thousand = function_exists( 'wc_get_price_thousand_separator' ) ? (string) wc_get_price_thousand_separator() : ',';
		$symbol   = function_exists( 'get_woocommerce_currency_symbol' ) ? (string) get_woocommerce_currency_symbol() : '';
		$format   = function_exists( 'get_woocommerce_price_format' ) ? (string) get_woocommerce_price_format() : '%1$s%2$s';

		$amount = number_format( $minor / ( 10 ** $decimals ), $decimals, $decimal, $thousand );

		return str_replace( array( '%1$s', '%2$s' ), array( $symbol, $amount ), $format );
	}

	/**
	 * The `aria-describedby` value for an option's control, or `''`.
	 *
	 * A **space-separated list**, which is what the attribute takes: an option
	 * with both a description and help text must announce both, and returning
	 * only the first is the bug this helper exists to make impossible.
	 *
	 * Empty string when there is nothing to describe, so a caller can test it
	 * rather than emit `aria-describedby=""` — which points at no element and is
	 * worse than the attribute's absence.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	public static function described_by( array $option ): string {
		$ids = array();

		foreach ( self::guidance( $option ) as $block ) {
			$ids[] = $block['id'];
		}

		return implode( ' ', $ids );
	}
}
