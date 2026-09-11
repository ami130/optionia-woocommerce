/**
 * Optionia storefront runtime.
 *
 * Vanilla ES6, no jQuery (M10.3). WooCommerce already loads its own copy, and
 * adding a second dependency to every storefront to save a few characters is
 * not a trade worth making.
 *
 * ## What this does, and what it must never do
 *
 * It shows a running estimate as options are chosen. The server recomputes the
 * real price at add-to-cart (AC4), so nothing here is authoritative and nothing
 * here is trusted: a customer with the console open can make this display any
 * number they like, and it changes what they are charged not at all.
 *
 * Required-field enforcement is deliberately absent. Every required input
 * already carries the `required` attribute and sits inside the form that
 * submits, so the browser blocks the submit, moves focus to the offending field
 * and explains itself — before this script has parsed, and more accessibly than
 * a re-implementation. See M10.7.
 */

( function () {
	'use strict';

	/**
	 * Only `fixed` prices are added up here.
	 *
	 * The other four types — `percentage`, `per_unit`, `per_char`, `tiered` —
	 * each need a decision `docs/PRICING-SPEC.md` has not made: what a
	 * percentage applies to, how it rounds, where a quantity comes from, how a
	 * character is counted. A storefront guessing at any of those would show a
	 * total the server disagrees with, which is worse than showing none.
	 *
	 * The markup carries `data-optionia-price-type` on every priced value, so a
	 * value this cannot total is distinguishable from one that adds nothing.
	 */
	var PRICEABLE = 'fixed';

	var settings = window.optioniaSettings || {};
	var currency = settings.currency || {};

	/**
	 * Format minor units the way this store writes money.
	 *
	 * @param {number} minor Amount in integer minor units.
	 * @return {string} Formatted amount.
	 */
	function formatMoney( minor ) {
		var decimals = typeof currency.decimals === 'number' ? currency.decimals : 2;
		var divisor = Math.pow( 10, decimals );
		var fixed = ( minor / divisor ).toFixed( decimals );
		var parts = fixed.split( '.' );

		parts[ 0 ] = parts[ 0 ].replace( /\B(?=(\d{3})+(?!\d))/g, currency.thousand || ',' );

		var amount = parts.join( currency.decimal || '.' );
		var format = currency.format || '%1$s%2$s';

		return format
			.replace( '%1$s', currency.symbol || '' )
			.replace( '%2$s', amount );
	}

	/**
	 * The elements carrying a price for what is currently chosen.
	 *
	 * 🔴 **This was `'[data-optionia="value"]:checked'`, and it silently missed
	 * every dropdown.** `data-optionia="value"` marks the *control* — for a radio
	 * that is the input itself, but for a `<select>` it is the select, and a
	 * `<select>` is never `:checked`. The prices sit on its `<option>` children.
	 * So the estimate for a dropdown summed an empty list and reported £0 rather
	 * than the chosen value's price. No JS tests existed to catch it.
	 *
	 * Three control shapes, one rule — *the element that holds the price for
	 * what the customer picked*:
	 *
	 * - radio / checkbox: the input, when `:checked`
	 * - dropdown: the **selected `<option>`**, not the select
	 * - text: nothing here. A text option has no per-value price; `per_char` is
	 *   priced server-side and deliberately not previewed (see `PRICEABLE`).
	 *
	 * @param {Element} root The options container.
	 * @return {Array<Element>} Elements that may carry price attributes.
	 */
	function pricedControls( root ) {
		var found = [];
		var i;

		// Inputs that carry their own price: radio, checkbox.
		var checked = root.querySelectorAll( 'input[data-optionia="value"]:checked' );

		for ( i = 0; i < checked.length; i++ ) {
			found.push( checked[ i ] );
		}

		/*
		 * A `<select>`'s price lives on the chosen `<option>`. `selectedOptions`
		 * is not in older browsers this plugin still supports, so the option is
		 * read by index — `selectedIndex` is -1 when nothing is chosen, which the
		 * bounds check below treats as "no price", not as an error.
		 *
		 * ✏️ **`index >= 0` is redundant, and kept deliberately.** Measured:
		 * `options[-1]` is already `undefined`, so the `&&` short-circuits
		 * without it and a mutant removing it cannot be killed. It stays because
		 * it states the intent — that -1 is an expected value, not an accident —
		 * and the cost is one comparison. Recorded so the next reader knows it
		 * was measured rather than assumed necessary.
		 */
		var selects = root.querySelectorAll( 'select[data-optionia="value"]' );

		for ( i = 0; i < selects.length; i++ ) {
			var index = selects[ i ].selectedIndex;

			if ( index >= 0 && selects[ i ].options[ index ] ) {
				found.push( selects[ i ].options[ index ] );
			}
		}

		return found;
	}

	/**
	 * The customer's answers, keyed by option id, as the evaluator reads them.
	 *
	 * 🔴 **Shaped exactly like the server's `$selections`**, because the same
	 * rules are evaluated against both and a different shape is a different
	 * answer. One scalar per option: an unchecked box and an untouched field are
	 * both **absent**, not empty strings, so `is_empty` means the same thing
	 * here as it does in `SelectionResolver`.
	 *
	 * @param {Element} root The options container.
	 * @return {Object} Option id -> the customer's answer.
	 */
	function answersIn( root ) {
		var answers = {};
		var options = root.querySelectorAll( '[data-optionia-option]' );
		var i;

		for ( i = 0; i < options.length; i++ ) {
			var option = options[ i ];
			var id = option.getAttribute( 'data-optionia-option' );

			if ( ! id ) {
				continue;
			}

			/*
			 * 🔴 **The option element may BE the control, not contain one.**
			 *
			 * Every visible type wraps its controls in a `<div
			 * data-optionia-option>`, so `querySelector` finds them. A hidden
			 * field has nothing to show and carries the attribute on the input
			 * itself — as `file_input` does — and a descendant search over it
			 * finds nothing at all. Measured: the runtime read no answer for a
			 * hidden field, so a rule on it fired on the server and not on the
			 * page.
			 */
			if ( option.matches( '[data-optionia="value"]' ) ) {
				if ( '' !== option.value ) {
					answers[ id ] = option.value;
				}

				continue;
			}

			var checked = option.querySelector( 'input[type="radio"][data-optionia="value"]:checked, input[type="checkbox"][data-optionia="value"]:checked' );

			if ( checked ) {
				answers[ id ] = checked.value;

				continue;
			}

			var select = option.querySelector( 'select[data-optionia="value"]' );

			if ( select ) {
				if ( '' !== select.value ) {
					answers[ id ] = select.value;
				}

				continue;
			}

			/*
			 * A typed field: text, number, date, range, quantity. Its value is
			 * the answer, and a blank one is left absent rather than stored as
			 * `''` — see the note above on what `is_empty` has to mean.
			 *
			 * 🔴 **Radios and checkboxes are excluded explicitly, and must be.**
			 * A radio carries its `value` attribute whether or not it is chosen,
			 * so a bare `input[data-optionia="value"]` matches an *unchecked*
			 * one and reads the answer the customer did not give. Measured: an
			 * untouched form hid an option, because `opt-a` read `"yes"` from a
			 * radio nobody had selected. The `:checked` branch above is the only
			 * one entitled to answer for those two types.
			 */
			var typed = option.querySelector(
				'input[data-optionia="value"]:not([type="radio"]):not([type="checkbox"]), textarea[data-optionia="value"]'
			);

			/*
			 * ⚠️ **A range is ALWAYS answered, and that is deliberate.**
			 *
			 * An `<input type="range">` has no empty state: a browser clamps a
			 * blank `value` to the midpoint of `min`/`max` and submits that
			 * whether or not the customer touched the slider. Measured on the
			 * real template — `min=10 max=50` reports **30** on first paint.
			 *
			 * So `is_empty` can never hold for a range, and a rule reading one
			 * fires from the moment the page loads. That is the **agreeing**
			 * behaviour: the server receives the same 30 and decides the same
			 * way. Treating it as absent here would be the divergence, not the
			 * fix — recorded by the 17-9 audit so the next reader does not
			 * "correct" it into one.
			 */

			if ( typed && '' !== typed.value ) {
				answers[ id ] = typed.value;
			}
		}

		return answers;
	}

	/**
	 * Which options each rule target controls, built from the page itself.
	 *
	 * Mirrors `SelectionResolver::index_containment()`, and the asymmetry is the
	 * same one: a **group** controls every option inside it, an **option**
	 * controls itself, and a **value** controls **nothing** — hiding one choice
	 * of five removes a choice, not the question. Mapping a value to its option
	 * here would clear the answer of a customer who picked a different value,
	 * which is the defect M17.8's audit found on the server.
	 *
	 * @param {Element} root The options container.
	 * @return {Object} Target id -> the option ids whose answers it clears.
	 */
	function containmentIn( root ) {
		var under = {};
		var groups = root.querySelectorAll( '[data-optionia-group]' );
		var i;
		var j;

		for ( i = 0; i < groups.length; i++ ) {
			var groupId = groups[ i ].getAttribute( 'data-optionia-group' );
			var inGroup = groups[ i ].querySelectorAll( '[data-optionia-option]' );

			if ( groupId ) {
				under[ groupId ] = [];
			}

			for ( j = 0; j < inGroup.length; j++ ) {
				var optionId = inGroup[ j ].getAttribute( 'data-optionia-option' );

				if ( ! optionId ) {
					continue;
				}

				if ( groupId ) {
					under[ groupId ].push( optionId );
				}

				under[ optionId ] = [ optionId ];
			}
		}

		// A value target clears nothing, and is registered so it is still known.
		var values = root.querySelectorAll( '[data-optionia-value]' );

		for ( i = 0; i < values.length; i++ ) {
			var valueId = values[ i ].getAttribute( 'data-optionia-value' );

			if ( valueId ) {
				under[ valueId ] = [];
			}
		}

		return under;
	}

	/**
	 * The rules this block was given, or an empty list.
	 *
	 * `Assets::publish_rules()` pushes one entry per product, because a page may
	 * render several. Matching on the product id is what keeps one product's
	 * rules off another's controls.
	 *
	 * @param {Element} root The options container.
	 * @return {Array} The rules for this product.
	 */
	function rulesFor( root ) {
		var published = window.optioniaRules;

		if ( ! Array.isArray( published ) ) {
			return [];
		}

		var productId = root.getAttribute( 'data-optionia-product' );
		var found = [];
		var i;

		for ( i = 0; i < published.length; i++ ) {
			var entry = published[ i ];

			if ( entry && String( entry.productId ) === String( productId ) && Array.isArray( entry.rules ) ) {
				found = found.concat( entry.rules );
			}
		}

		return found;
	}

	/**
	 * Show or hide controls according to the rules (M17.9).
	 *
	 * 🔴 **Hiding clears what was typed, and that is ADR-051.** A hidden option
	 * is not charged, not stored and **not restored** — so the field comes back
	 * empty if a rule re-shows it. Restoring would mean the page holds a value
	 * the customer cannot see, cannot edit and did not re-confirm, and then
	 * charges for it the moment a rule flips. Exactly one state exists: what is
	 * on the screen.
	 *
	 * ⚠️ **`hidden`, not `display: none` in a style attribute.** The property
	 * removes the element from the accessibility tree as well as the layout, so
	 * a screen reader does not announce a field a sighted customer cannot see.
	 * A CSS-only hide leaves it focusable and readable.
	 *
	 * 🔴 **A refusal shows everything.** If the rules do not settle (ADR-050),
	 * the page is left with every control visible rather than in whatever state
	 * the last pass reached. The server refuses what it must; a customer seeing
	 * a form they can act on beats a blank product they cannot.
	 *
	 * @param {Element} root The options container.
	 */
	function applyRules( root ) {
		var engine = window.optioniaRuleEngine;
		var rules = rulesFor( root );

		if ( ! engine || 0 === rules.length ) {
			return;
		}

		var outcome = engine.evaluate( rules, answersIn( root ), containmentIn( root ) );

		if ( null !== outcome.refused ) {
			revealAll( root );

			return;
		}

		var states = outcome.states;

		revealAll( root );

		var hiddenBefore = countHidden( root );

		Object.keys( states ).forEach( function ( targetId ) {
			if ( ! states[ targetId ].hidden ) {
				return;
			}

			var targets = root.querySelectorAll(
				'[data-optionia-group="' + cssEscape( targetId ) + '"],' +
				'[data-optionia-option="' + cssEscape( targetId ) + '"],' +
				'[data-optionia-value="' + cssEscape( targetId ) + '"]'
			);
			var i;

			for ( i = 0; i < targets.length; i++ ) {
				hideTarget( targets[ i ] );
			}
		} );

		announceRules( root, hiddenBefore, countHidden( root ) );
	}

	/**
	 * How many things a rule currently hides in this block.
	 *
	 * Counted from the DOM rather than from the evaluator's states, because a
	 * target may cover several controls — a group hides every option inside it —
	 * and what a customer notices is how many *things went away*.
	 *
	 * @param {Element} root The options container.
	 * @return {number}
	 */
	function countHidden( root ) {
		return root.querySelectorAll( '[data-optionia-hidden]' ).length;
	}

	/**
	 * Say what a rule did, for a customer who cannot see it happen (M17.5).
	 *
	 * 🔴 **Silence is indistinguishable from nothing having happened.** A rule
	 * rearranges the form under someone using a screen reader, and until this
	 * there was no announcement at all — `announce()` exists but writes to an
	 * upload's status element and is not reusable here.
	 *
	 * ⚠️ **Says nothing when nothing changed**, which is most `change` events. A
	 * live region rewritten with the same text on every keystroke is one a screen
	 * reader either repeats or learns to ignore.
	 *
	 * @param {Element} root   The options container.
	 * @param {number}  before How many controls were hidden before this pass.
	 * @param {number}  after  How many are hidden now.
	 */
	function announceRules( root, before, after ) {
		if ( before === after ) {
			return;
		}

		var status = root.querySelector( '[data-optionia="rule-status"]' );
		var strings = ( window.optioniaSettings || {} ).rules;

		if ( ! status || ! strings ) {
			return;
		}

		status.textContent = after > before ? strings.hidden : strings.shown;
	}

	/**
	 * Undo every rule-driven hide, so each pass starts from the authored page.
	 *
	 * Recomputed rather than diffed: a rule that stops firing must put its
	 * target back, and tracking what to undo is a second source of truth for a
	 * fact the evaluator already answers completely.
	 *
	 * @param {Element} root The options container.
	 */
	function revealAll( root ) {
		var hiddenNow = root.querySelectorAll( '[data-optionia-hidden]' );
		var i;

		for ( i = 0; i < hiddenNow.length; i++ ) {
			hiddenNow[ i ].removeAttribute( 'data-optionia-hidden' );
			hiddenNow[ i ].hidden = false;

			if ( 'OPTION' === hiddenNow[ i ].tagName ) {
				hiddenNow[ i ].disabled = false;
			}
		}

		/*
		 * Re-enable only the controls a rule disabled — never one the merchant
		 * disabled, and never one an upload has in flight. The attribute is the
		 * record of what this runtime did, and removing it as we go keeps that
		 * record true.
		 */
		var disabled = root.querySelectorAll( '[data-optionia-rule-disabled]' );

		for ( i = 0; i < disabled.length; i++ ) {
			disabled[ i ].removeAttribute( 'data-optionia-rule-disabled' );
			disabled[ i ].disabled = false;
		}
	}

	/**
	 * Hide one element and clear whatever it holds.
	 *
	 * ⚠️ **A hidden `<option>` is disabled, not just hidden.** `hidden` on an
	 * option is honoured inconsistently across browsers, and a hidden-but-enabled
	 * option is still selectable by keyboard — which would let a customer choose
	 * a value the server then refuses. Disabling is what every browser honours.
	 *
	 * @param {Element} element The element to hide.
	 */
	function hideTarget( element ) {
		element.setAttribute( 'data-optionia-hidden', '' );

		if ( 'OPTION' === element.tagName ) {
			element.disabled = true;

			if ( element.selected ) {
				element.selected = false;
			}

			return;
		}

		/*
		 * 🔴 **Focus is moved out before the element is hidden, not after.**
		 *
		 * Measured before this: a customer typing in a field when a rule hides
		 * it kept focus on an element that was then `hidden` **and** `disabled` —
		 * an invisible tab stop, and a screen reader with nothing to announce.
		 * M17.5 asks to *"keep focus management sane"*, and until this there was
		 * no focus code at all, only comments about it.
		 *
		 * ⚠️ **Ordered deliberately.** Blurring after `hidden = true` moves focus
		 * to `<body>`, which loses the customer's place entirely; moving it to
		 * the options block first keeps them where they were working. The block
		 * takes focus programmatically only — `tabindex="-1"` — so this adds no
		 * tab stop of its own.
		 */
		moveFocusOut( element );

		element.hidden = true;
		clearWithin( element );
	}

	/**
	 * Move focus out of an element about to be hidden.
	 *
	 * Does nothing when focus is elsewhere, which is the common case: a rule
	 * usually fires because the customer answered a *different* option, and
	 * stealing focus from the control they just used would be its own defect.
	 *
	 * @param {Element} element The element about to be hidden.
	 */
	function moveFocusOut( element ) {
		var active = element.ownerDocument.activeElement;

		if ( ! active || ! element.contains( active ) ) {
			return;
		}

		var block = element.closest( '[data-optionia="options"]' );

		if ( ! block ) {
			active.blur();

			return;
		}

		/*
		 * `-1` rather than `0`: the block is a destination for focus, never a
		 * stop on the way through the form. A customer tabbing past the options
		 * should reach the next control, not this container.
		 */
		if ( ! block.hasAttribute( 'tabindex' ) ) {
			block.setAttribute( 'tabindex', '-1' );
		}

		block.focus();
	}

	/**
	 * Empty every control inside a hidden element (ADR-051: not restored).
	 *
	 * @param {Element} element The element being hidden.
	 */
	function clearWithin( element ) {
		var controls = element.querySelectorAll( 'input[data-optionia="value"], select[data-optionia="value"], textarea[data-optionia="value"]' );
		var i;

		for ( i = 0; i < controls.length; i++ ) {
			var control = controls[ i ];

			/*
			 * 🔴 **A hidden field is never cleared and never disabled.** Its
			 * value comes from the merchant's configuration, not the customer —
			 * a batch code, a fulfilment route — and the server substitutes that
			 * same `default_value` whatever arrives (`rule_answers()`). Clearing
			 * it here would drop merchant data from the order for a rule that
			 * has nothing to do with it, and disabling it would stop the field
			 * submitting at all.
			 *
			 * It is also not a control the customer can see being hidden, so
			 * there is nothing to keep consistent with the page.
			 */
			if ( 'hidden' === control.type ) {
				continue;
			}

			if ( 'radio' === control.type || 'checkbox' === control.type ) {
				control.checked = false;
			} else {
				control.value = '';
			}

			/*
			 * 🔴 **Disabled, not merely emptied — and this is what makes the
			 * page and the server agree.**
			 *
			 * A cleared text field still submits, as `name=""`. The server reads
			 * that as *a value supplied for a rule-hidden option* and refuses
			 * the line with `hidden_by_rule` — so a customer who followed the UI
			 * exactly could not add to cart. Measured: `opt-b=''` is **REFUSED**
			 * where an absent `opt-b` is accepted.
			 *
			 * A disabled control submits **nothing at all**, which is the state
			 * the resolver calls "legitimately absent". Radios and checkboxes
			 * never had the problem — an unchecked input does not submit — but
			 * they are disabled too, so every hidden control behaves one way
			 * rather than two.
			 *
			 * ⚠️ **Marked with an attribute, so `revealAll()` only re-enables
			 * what THIS disabled.** A merchant's own `disabled` control, or one
			 * an upload puts in flight, must stay disabled when a rule stops
			 * firing.
			 */
			if ( ! control.disabled ) {
				control.setAttribute( 'data-optionia-rule-disabled', '' );
				control.disabled = true;
			}
		}
	}

	/**
	 * Escape an id for use inside an attribute selector.
	 *
	 * Ids are UUIDs from the cloud, so this cannot matter today — but AC4 makes
	 * the document input rather than authority, and a forged id containing a
	 * quote would otherwise break out of the selector.
	 *
	 * @param {string} value The id.
	 * @return {string}
	 */
	function cssEscape( value ) {
		return String( value ).replace( /["\\]/g, '\\$&' );
	}

	/**
	 * Total the currently selected values within one options block.
	 *
	 * Returns null when any selected value carries a price this cannot compute,
	 * so the caller can hide the estimate rather than show a wrong one. A
	 * partial total is the failure mode worth avoiding: it looks right.
	 *
	 * @param {Element} root The options container.
	 * @return {?number} Total in minor units, or null.
	 */
	function selectedTotal( root ) {
		/*
		 * 🔴 **A `set_price` rule makes this estimate unknowable, so it refuses.**
		 *
		 * The amount a rule sets never reaches the page — `action_value` is
		 * deliberately withheld, because a price on the storefront is a second
		 * source of truth for a number AC4 makes server-authoritative. So the
		 * browser can see *that* a rule sets a price and never *what* it sets.
		 *
		 * Measured by the 17-11 exit audit: a value authored at 5.00 with a rule
		 * setting 25.00 showed **+£5.00** on the page while the server charged
		 * **£25.00**. The disclaimer beneath — *"the final price is confirmed at
		 * checkout"* — softens that and does not make the number less wrong.
		 *
		 * ⚠️ **Refused for the whole block, not just the affected option.** A
		 * rule may target a group, and a partial total is the failure mode worth
		 * avoiding: it looks right. This is the same line `PRICEABLE` already
		 * draws for `percentage`, `per_char`, `per_unit` and `tiered` — the
		 * estimate shows nothing rather than something it cannot stand behind.
		 */
		if ( setsAPrice( root ) ) {
			return null;
		}

		var chosen = pricedControls( root );
		var total = 0;
		var i;

		for ( i = 0; i < chosen.length; i++ ) {
			var type = chosen[ i ].getAttribute( 'data-optionia-price-type' );

			if ( ! type ) {
				continue;
			}

			if ( type !== PRICEABLE ) {
				return null;
			}

			total += parseInt( chosen[ i ].getAttribute( 'data-optionia-price' ), 10 ) || 0;
		}

		return total;
	}

	/**
	 * Whether any rule on this product sets a price.
	 *
	 * Asked of the rules the page was given rather than of the current answers,
	 * and deliberately: whether a rule *fires* depends on what the customer has
	 * chosen so far, so an estimate that appeared and vanished as they answered
	 * would be worse than one that never appeared. A product whose merchant
	 * prices through rules shows no running estimate at all.
	 *
	 * @param {Element} root The options container.
	 * @return {boolean}
	 */
	function setsAPrice( root ) {
		var rules = rulesFor( root );
		var i;

		for ( i = 0; i < rules.length; i++ ) {
			if ( 'set_price' === rules[ i ].action ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Count characters the way the server counts them.
	 *
	 * 🔴 **Not `text.length`.** That is UTF-16 code units: `"café"` with a
	 * combining accent is 5, and a family emoji is 11. The server counts
	 * **grapheme clusters** via `Engine\Text::measure()` — one flag is one
	 * character because it is one mark in the engraved material.
	 *
	 * This is the whole reason M11.1a exists as one shared function. In
	 * `optionia-app` the counter and the price were written separately, so
	 * `"AB CD"` is charged as five characters while the counter beside the field
	 * shows four — live there today. Not a pricing bug: display and server agree
	 * with each other. A **credibility** bug, on engraving.
	 *
	 * `Intl.Segmenter` is the browser's own grapheme segmentation and matches
	 * PHP's `grapheme_strlen()` — verified across twelve cases including
	 * combining marks, ZWJ families, flags and skin-tone modifiers. Where it is
	 * missing (older Safari), the fallback counts **code points** via the string
	 * iterator: still wrong for a ZWJ family, but far closer than `.length`, and
	 * it over-counts rather than under-counts — so a customer is warned early
	 * rather than refused by surprise at submit.
	 *
	 * @param {string} text The customer's input.
	 * @return {number} Characters, as the server counts them.
	 */
	function measure( text ) {
		// Outer whitespace is trimmed before counting, exactly as
		// `Engine\Text::normalise()` does: it engraves nothing visible, and no
		// customer intends to pay for it. Inner spaces are kept — the space
		// between two names is cut into the material.
		var trimmed = String( text ).replace( /^[\s\u00A0\uFEFF]+|[\s\u00A0\uFEFF]+$/g, '' );

		if ( '' === trimmed ) {
			return 0;
		}

		if ( 'undefined' !== typeof Intl && Intl.Segmenter ) {
			var segmenter = new Intl.Segmenter( undefined, { granularity: 'grapheme' } );
			var count = 0;
			var iterator = segmenter.segment( trimmed )[ Symbol.iterator ]();
			var step = iterator.next();

			while ( ! step.done ) {
				count++;
				step = iterator.next();
			}

			return count;
		}

		// Code points, not code units: `Array.from` iterates by code point.
		return Array.from( trimmed ).length;
	}

	/**
	 * Update the `12/20` beside one text field.
	 *
	 * M14.4b makes the counter **required** wherever a limit exists, because
	 * *"silently rejecting the 21st character of an engraving is a support ticket
	 * and often an abandoned cart"*.
	 *
	 * @param {Element} input The text input.
	 */
	function refreshCounter( input ) {
		var option = input.closest( '[data-optionia="option"]' );

		if ( ! option ) {
			return;
		}

		var used = option.querySelector( '[data-optionia="counter-used"]' );

		if ( ! used ) {
			return;
		}

		var count = measure( input.value );
		var max = parseInt( input.getAttribute( 'data-optionia-max' ), 10 );

		used.textContent = String( count );

		/*
		 * Flagged when over, though `maxlength` normally prevents it: the
		 * attribute counts UTF-16 code units while this counts graphemes, so an
		 * emoji the browser lets through can still exceed the real limit. The
		 * server refuses it either way (AC4); the customer should see why before
		 * they submit.
		 */
		/*
		 * ✏️ **`! isNaN( max )` is redundant, and kept for the same reason.**
		 * `count > NaN` is already `false`, so a mutant dropping it cannot be
		 * killed. It states that a missing limit is expected — a text option
		 * without `max_length` is the common case, not a broken one.
		 */
		var over = ! isNaN( max ) && count > max;

		option.classList.toggle( 'optionia-option--over-limit', over );
	}

	/**
	 * Update the number shown beside a slider.
	 *
	 * 🔴 **A slider without a readout is a control a customer cannot answer
	 * precisely.** The browser shows nothing of its own, so *"how many
	 * centimetres did I choose?"* has no answer — and on a size or a depth that
	 * is the whole question.
	 *
	 * The template renders the starting value server-side, so this is a live
	 * update rather than the only source: correct before any script runs, and
	 * correct as the customer drags.
	 *
	 * @param {Element} input The range input.
	 */
	function refreshRange( input ) {
		var option = input.closest( '[data-optionia="option"]' );

		if ( ! option ) {
			return;
		}

		var output = option.querySelector( '[data-optionia="range-value"]' );

		if ( output ) {
			output.textContent = input.value;
		}
	}

	/**
	 * Show or hide the estimate for one options block.
	 *
	 * @param {Element} root The options container.
	 */
	function refresh( root ) {
		var output = root.querySelector( '[data-optionia="estimate"]' );

		if ( ! output ) {
			return;
		}

		var total = selectedTotal( root );

		if ( null === total || 0 === total ) {
			// Nothing to add: no estimate rather than "+0.00", which reads as a
			// broken calculation rather than an absent one.
			output.hidden = true;
			output.textContent = '';

			return;
		}

		output.hidden = false;
		output.textContent = '+' + formatMoney( total );
	}

	/**
	 * Bind one options block.
	 *
	 * @param {Element} root The options container.
	 */
	function bind( root ) {
		if ( root.hasAttribute( 'data-optionia-bound' ) ) {
			/*
			 * Nothing re-runs `init()` today, so this cannot fire yet.
			 *
			 * It is kept because the thing that will re-run it is already
			 * scheduled: `found_variation` and `reset_data` (see the note above
			 * `init`), and a page builder that injects a product block after
			 * load. Binding twice would double every handler, and a doubled
			 * `change` listener does not look broken — it just totals wrong.
			 *
			 * Stated as future-proofing rather than as protection against
			 * something happening now, because a guard justified by a scenario
			 * that cannot occur is one the next reader is right to delete.
			 */
			return;
		}

		root.setAttribute( 'data-optionia-bound', '' );

		bindUploads( root );

		root.addEventListener( 'change', function ( event ) {
			if ( event.target && event.target.matches( '[data-optionia="value"]' ) ) {
				/*
				 * Rules first, then the estimate: hiding an option clears its
				 * answer (ADR-051), so a total computed before that would
				 * include a value the customer can no longer see.
				 */
				applyRules( root );
				refresh( root );
			}
		} );

		/*
		 * `input`, not `change`: a counter that updates only when the field
		 * loses focus is a counter the customer never sees move, which is the
		 * same as not having one.
		 */
		root.addEventListener( 'input', function ( event ) {
			if ( ! event.target ) {
				return;
			}

			/*
			 * A range fires `input` on every pixel of a drag, so its readout is
			 * updated here rather than on `change` — which fires only when the
			 * customer lets go, by which point they have already read a stale
			 * number and decided.
			 */
			if ( event.target.matches( '[data-optionia-range]' ) ) {
				refreshRange( event.target );
			}

			if ( event.target.matches( 'input[data-optionia="value"]' ) ) {
				refreshCounter( event.target );
			}

			/*
			 * A typed answer can satisfy a condition too — "engraving is not
			 * empty" must take effect as the customer types, not when the field
			 * loses focus. `change` covers the chosen types above.
			 */
			if ( event.target.matches( '[data-optionia="value"]' ) ) {
				applyRules( root );
			}
		} );

		/*
		 * Applied before the first `refresh()`, so a page whose defaults already
		 * satisfy a rule paints correctly rather than flashing the full form and
		 * then collapsing it.
		 */
		applyRules( root );

		refresh( root );

		// Correct on first paint for a pre-filled default, without waiting for
		// the customer to type.
		var counted = root.querySelectorAll( 'input[data-optionia-max]' );

		for ( var c = 0; c < counted.length; c++ ) {
			refreshCounter( counted[ c ] );
		}

		var ranges = root.querySelectorAll( '[data-optionia-range]' );

		for ( var g = 0; g < ranges.length; g++ ) {
			refreshRange( ranges[ g ] );
		}
	}

	/**
	 * How many uploads are in flight, across the whole page.
	 *
	 * 🔴 **This counter exists because of a race with add-to-cart.** A customer
	 * who clicks *Add to cart* while a 30 MB upload is still going has no token
	 * yet, so the option posts empty and the server reports a missing required
	 * value — a validation error for a file they *did* choose, which reads as the
	 * site losing their work.
	 *
	 * Page-wide rather than per-option: one form can carry several file options,
	 * and any one of them still uploading is a reason to wait.
	 */
	var inFlight = 0;

	/**
	 * Wording for an upload state.
	 *
	 * ⚠️ Falls back to English rather than to an empty string: a status that says
	 * nothing is worse than one in the wrong language.
	 *
	 * @param {string} key Which message.
	 * @return {string}
	 */
	function uploadText( key ) {
		var supplied = settings.uploadText || {};
		var fallback = {
			uploading: 'Uploading',
			uploaded: 'Uploaded:',
			failed: 'That file could not be uploaded. Please try another.',
			waiting: 'Please wait for the upload to finish.'
		};

		return supplied[ key ] || fallback[ key ];
	}

	/**
	 * Announce an upload's state to the customer and to a screen reader.
	 *
	 * @param {Element} option The option block.
	 * @param {string}  text   What to say. An empty string clears it.
	 */
	function announce( option, text ) {
		var status = option.querySelector( '[data-optionia="upload-status"]' );

		if ( status ) {
			status.textContent = text;
		}
	}

	/**
	 * Upload one chosen file and write the returned token into the option.
	 *
	 * ## Why XMLHttpRequest rather than fetch
	 *
	 * ⚠️ **`fetch` cannot report upload progress.** It has no equivalent of
	 * `upload.onprogress`, and a 30 MB artwork file with no progress bar is
	 * indistinguishable from a frozen page — which is the whole reason ADR-040
	 * chose an asynchronous upload over riding the add-to-cart POST.
	 *
	 * ## What is sent, and what comes back
	 *
	 * The file and the option's id, with the nonce in `X-WP-Nonce`. What returns
	 * is an opaque **token** — never a path, never a filename — and that is the
	 * only thing the hidden field ever holds. AC4's rule applied to a file.
	 *
	 * @param {Element} option The option block.
	 * @param {File}    file   The chosen file.
	 * @param {Object}  config The upload settings from the server.
	 */
	function upload( option, file, config ) {
		var token = option.querySelector( '[data-optionia="value"]' );
		var request;
		var payload;

		if ( ! token ) {
			return;
		}

		/*
		 * Clear any previous token before starting.
		 *
		 * A customer replacing one file with another must not be able to submit
		 * the *old* token while the new upload is in flight — that would attach
		 * artwork they deliberately replaced.
		 */
		token.value = '';

		request = new XMLHttpRequest();
		inFlight += 1;
		announce( option, uploadText( 'uploading' ) );

		request.open( 'POST', config.url, true );
		request.setRequestHeader( 'X-WP-Nonce', config.nonce );

		request.upload.onprogress = function ( event ) {
			if ( event.lengthComputable && event.total > 0 ) {
				announce(
					option,
					uploadText( 'uploading' ) + ' ' + Math.round( ( event.loaded / event.total ) * 100 ) + '%'
				);
			}
		};

		request.onload = function () {
			var body = null;

			inFlight -= 1;

			try {
				body = JSON.parse( request.responseText );
			} catch ( error ) {
				body = null;
			}

			if ( 201 === request.status && body && body.token ) {
				token.value = body.token;
				announce( option, uploadText( 'uploaded' ) + ' ' + ( body.name || '' ) );

				return;
			}

			/*
			 * Every server refusal answers the same shape on purpose, so the
			 * runtime cannot tell a quota refusal from a size refusal — and
			 * neither can an attacker mapping the ceilings.
			 */
			announce( option, uploadText( 'failed' ) );
		};

		/*
		 * A dropped connection, not a refusal.
		 *
		 * `onload` never fires for a network error, so without this the counter
		 * would never come back down and the form would stay blocked forever on
		 * a flaky connection — turning a slow upload into an unusable checkout.
		 */
		request.onerror = function () {
			inFlight -= 1;
			announce( option, uploadText( 'failed' ) );
		};

		request.onabort = function () {
			inFlight -= 1;
			announce( option, '' );
		};

		payload = new FormData();
		payload.append( 'file', file );
		payload.append( 'option_id', option.getAttribute( 'data-optionia-option' ) || '' );

		request.send( payload );
	}

	/**
	 * The largest file this option will accept, in bytes.
	 *
	 * The lower of the host's ceiling and the merchant's configured limit — a
	 * document written against a generous host must not authorise an upload a
	 * modest one truncates. Zero means "no limit known", and nothing is refused
	 * here: the server still checks.
	 *
	 * @param {Element} option The option block.
	 * @param {Object}  config The upload settings from the server.
	 * @return {number}
	 */
	function ceilingFor( option, config ) {
		var host = config.maxBytes || 0;
		var perOption = parseInt( option.getAttribute( 'data-optionia-max-mb' ) || '0', 10 );
		var configured;

		if ( ! perOption || perOption <= 0 ) {
			return host;
		}

		configured = perOption * 1048576;

		return host > 0 ? Math.min( host, configured ) : configured;
	}

	/**
	 * Bind file inputs, and hold back a submit while one is uploading.
	 *
	 * @param {Element} root The options block.
	 */
	function bindUploads( root ) {
		var config = settings.upload || null;
		var form;

		if ( ! config || ! config.url ) {
			/*
			 * No upload configuration means the server did not provide it — an
			 * older cached page, or a build without file options. The file input
			 * stays inert rather than posting somewhere invented.
			 */
			return;
		}

		root.addEventListener( 'change', function ( event ) {
			var option;
			var file;
			var cleared;
			var ceiling;

			if ( ! event.target || ! event.target.matches( '[data-optionia="file"]' ) ) {
				return;
			}

			option = event.target.closest( '[data-optionia-upload]' );

			if ( ! option ) {
				return;
			}

			file = event.target.files && event.target.files[ 0 ];

			if ( ! file ) {
				// The customer cleared the picker: drop the token with it.
				cleared = option.querySelector( '[data-optionia="value"]' );

				if ( cleared ) {
					cleared.value = '';
				}

				announce( option, '' );

				return;
			}

			/*
			 * Refuse an oversized file before spending the customer's bandwidth
			 * on it. The server re-checks regardless — a client-side limit is a
			 * courtesy, never a boundary.
			 */
			ceiling = ceilingFor( option, config );

			if ( ceiling > 0 && file.size > ceiling ) {
				announce( option, uploadText( 'failed' ) );

				return;
			}

			upload( option, file, config );
		} );

		form = root.closest( 'form' );

		if ( ! form ) {
			return;
		}

		/*
		 * 🔴 **Hold the form while anything is uploading.**
		 *
		 * Bound in the **capture** phase so it runs before WooCommerce's own
		 * submit handling: a `preventDefault` after the cart request has already
		 * started stops nothing.
		 */
		form.addEventListener(
			'submit',
			function ( event ) {
				var pending;

				if ( inFlight <= 0 ) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();

				pending = root.querySelector( '[data-optionia-upload]' );

				if ( pending ) {
					announce( pending, uploadText( 'waiting' ) );
				}
			},
			true
		);
	}

	/**
	 * Bind every options block on the page.
	 *
	 * ## Why WooCommerce's variation events are not wired yet
	 *
	 * M10.5's strategy names `found_variation` and `reset_data` — "to
	 * re-evaluate rules and recompute price". Neither is listened to here, and
	 * that is deliberate rather than missed.
	 *
	 * The estimate is an options **delta**, not a product total: it sums the
	 * `fixed` prices of the selected values, and none of those change when a
	 * customer picks a different size. There is nothing to recompute, so a
	 * listener would re-run the same arithmetic on the same inputs.
	 *
	 * ✏️ **Phase 17 landed, and the listeners are still not needed.** This note
	 * used to say *"show/hide rules re-evaluate against the chosen variation —
	 * that is Phase 17; whichever lands first adds the listeners"*. Checked when
	 * the phase closed, rather than assumed:
	 *
	 * - A condition reads an **Optionia option id**, never a WooCommerce
	 *   variation attribute, so no rule can depend on which variation is chosen.
	 * - `option_sets_for_product()` is keyed by the **parent** product, so every
	 *   variation of one product has the same rules.
	 * - Percentage pricing shows no estimate at all — `selectedTotal()` returns
	 *   null for anything but `fixed` — so nothing to recompute there either.
	 *
	 * ⚠️ **What would change it**: a condition that can read a variation
	 * attribute, or an estimate that knows a variation's base price. The first is
	 * unscheduled; the second is Phase 21's server-quoted preview. The guard in
	 * `bind` stays ready for whichever arrives.
	 */
	function init() {
		var blocks = document.querySelectorAll( '[data-optionia="options"]' );
		var i;

		for ( i = 0; i < blocks.length; i++ ) {
			bind( blocks[ i ] );
		}
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', init );
	} else {
		init();
	}
} )();
