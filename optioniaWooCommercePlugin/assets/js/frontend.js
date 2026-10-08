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
	 * ✏️ **M26e.4 added a second caller and, briefly, a second copy.** The
	 * preview host is found by `[data-optionia-preview-for="…"]`, and a
	 * `CSS.escape`-based duplicate of this function was declared further down
	 * the same scope — silently overriding this one for the whole file,
	 * including the rules engine that had used it since M17. Both were measured
	 * in a real browser and agreed on every input tried (`.`, space, `"`, `\`),
	 * so nothing broke; the duplicate was deleted rather than kept, because the
	 * next edit to it would have changed rule matching with nothing to notice.
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

				/*
				 * 📌 **After the rules, for the reason above**: a hidden
				 * option's answer is cleared, and a preview composed before
				 * that would draw artwork the customer can no longer choose.
				 */
				schedulePreview( root );
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

				/*
				 * ⚠️ **Typed text redraws too**, because an engraving option
				 * carries one design whose sample the customer's words replace
				 * — so the preview is wrong until they are read. Debounced, so
				 * a sentence costs one request rather than one per keystroke.
				 */
				schedulePreview( root );
			}
		} );

		/*
		 * Applied before the first `refresh()`, so a page whose defaults already
		 * satisfy a rule paints correctly rather than flashing the full form and
		 * then collapsing it.
		 */
		applyRules( root );

		refresh( root );

		/*
		 * 📌 **Drawn on first paint**, so a designed value that is the default
		 * shows its artwork without the customer touching anything — and a
		 * product with no designs still makes no request, because
		 * `composeScene` answers null.
		 */
		schedulePreview( root );

		/*
		 * 🔴 **The theme can take the preview away, and nothing told us.**
		 * Measured on a real page: a variation change replaces the gallery's
		 * image element *and its wrapper*, which destroys the host the preview
		 * lives in. The customer's design vanished and never came back,
		 * because `drawPreview` only runs on a change inside the options
		 * block and a variation swap fires nothing there.
		 */
		watchGallery( root );

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

		/*
		 * 🔴 **The route's own nonce, in a field WordPress does not claim.**
		 * `X-WP-Nonce` above carries `wp_rest`, which
		 * `rest_cookie_check_errors()` validates before any permission
		 * callback runs — a custom action sent there was refused 403 and the
		 * customer's file never arrived.
		 */
		payload.append( 'check', config.check || '' );

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
	/**
	 * Tell the site which options this customer saw (M25.1).
	 *
	 * ## Why a beacon, and why on visibilitychange
	 *
	 * 🔴 **`sendBeacon` is the only transport that survives the page going
	 * away.** A `fetch` issued while the customer is leaving is cancelled by the
	 * browser; a synchronous request would hold up the navigation they asked
	 * for. `sendBeacon` hands the payload to the browser and returns immediately,
	 * and the browser delivers it whether or not the page is still there.
	 *
	 * 🔴 **`visibilitychange`, NOT `unload`.** Safari has never fired `unload`
	 * reliably and mobile browsers freeze pages rather than unloading them, so
	 * an `unload` beacon silently loses most mobile traffic — which is most
	 * traffic. `hidden` fires on tab switch, app switch and close alike.
	 *
	 * ⚠️ **Sent once.** `visibilitychange` fires every time the customer
	 * switches tabs, and a beacon per switch would count one view several times.
	 *
	 * 📌 **The day comes from the SERVER, in the store's timezone.** A customer
	 * in another country would otherwise file their view under their own date,
	 * and a merchant comparing today against yesterday would be comparing
	 * whichever halves their visitors were in.
	 */
	function reportViews() {
		var settings = window.optioniaSettings && window.optioniaSettings.views;

		if ( ! settings || ! settings.url || ! settings.day || ! navigator.sendBeacon ) {
			return;
		}

		var sent = false;

		function send() {
			if ( sent ) {
				return;
			}

			sent = true;

			/*
			 * Grouped by set, because a page may show options from several and
			 * the cloud keys counts by set — attributing one set's views to
			 * another would be worse than not counting them.
			 */
			var bySet = {};
			var groups = document.querySelectorAll( '[data-optionia-group]' );
			var i;
			var j;

			for ( i = 0; i < groups.length; i++ ) {
				var setId = groups[ i ].getAttribute( 'data-optionia-set' );

				if ( ! setId ) {
					// A document older than set ids. Skipping is better than
					// inventing a set to file the count under.
					continue;
				}

				var options = groups[ i ].querySelectorAll( '[data-optionia-option]' );

				for ( j = 0; j < options.length; j++ ) {
					var key = options[ j ].getAttribute( 'data-optionia-option' );

					if ( ! key ) {
						continue;
					}

					if ( ! bySet[ setId ] ) {
						bySet[ setId ] = [];
					}

					if ( bySet[ setId ].indexOf( key ) === -1 ) {
						bySet[ setId ].push( key );
					}
				}
			}

			for ( var set in bySet ) {
				if ( ! Object.prototype.hasOwnProperty.call( bySet, set ) ) {
					continue;
				}

				/*
				 * ⚠️ **A Blob with an explicit type**, because `sendBeacon` with
				 * a plain string sends `text/plain` and the REST API would
				 * refuse to parse it as JSON.
				 */
				try {
					navigator.sendBeacon(
						/*
						 * 🔴 **`_wpnonce` carries `wp_rest`, which WordPress
						 * claims.** It reads that parameter FIRST and validates
						 * it against `wp_rest` before any permission callback —
						 * so a custom action here was refused 403 and every view
						 * went uncounted. The route's own nonce rides in the
						 * body as `check`, which WordPress does not touch.
						 */
						settings.url + '?_wpnonce=' + encodeURIComponent( settings.nonce || '' ),
						new Blob(
							[
								JSON.stringify( {
									set: set,
									options: bySet[ set ],
									day: settings.day,
									check: settings.check
								} )
							],
							{ type: 'application/json' }
						)
					);
				} catch ( error ) {
					/*
					 * 🔴 **A failed beacon must never affect the storefront.**
					 * Analytics is the least important thing on this page, and a
					 * throw here would break the runtime that shows a customer
					 * their price.
					 */
					return;
				}
			}
		}

		document.addEventListener( 'visibilitychange', function () {
			if ( 'hidden' === document.visibilityState ) {
				send();
			}
		} );
	}

	/*
	 * ---------------------------------------------------------------------
	 * The design preview (M26e.1, stage B)
	 * ---------------------------------------------------------------------
	 *
	 * 🔴 **The cloud draws it, this only asks and injects.** The preview, the
	 * storefront overlay and the print file all come out of `buildScene` and
	 * `sceneToSvgString` in `shared/design/`. Resolving the geometry here
	 * would be a second implementation of the same maths, and the moment it
	 * drifted a customer would approve one picture and the merchant print
	 * another — which has already shipped once as a blank print file.
	 *
	 * 📌 **Through WordPress, never the cloud directly.** The cloud's preview
	 * route is authenticated by the store token, which must stay on the
	 * server.
	 */
	var preview = settings.preview || {};

	/** How long after the last change before asking. */
	var PREVIEW_DEBOUNCE_MS = 250;

	/** The canvas a preview is drawn at. Square, matching the print request. */
	var PREVIEW_CANVAS = 800;

	/**
	 * Per-block preview state, keyed by the options root itself.
	 *
	 * 🔴 **One page can carry several options blocks.** A grouped product, a
	 * bundle, or two shortcodes on one page each render their own root — and
	 * until M26e.4 the debounce timer and the staleness token were single
	 * module-level variables shared by all of them. Measured on a real page by
	 * cloning the block: the second block cancelled the first's pending draw,
	 * invalidated its in-flight response, and both wrote into the SAME host.
	 *
	 * ⚠️ **A `WeakMap`, so a removed block's state is collectable.** A block
	 * theme that re-renders the options area would otherwise leak one entry per
	 * render.
	 */
	/*
	 * 🔴 **No fallback, deliberately.** An earlier version returned one shared
	 * record when `WeakMap` was absent — which silently reinstates the very bug
	 * this map exists to fix: every block sharing one timer and one token, so
	 * the second cancels the first's draw and overwrites its artwork.
	 *
	 * 📌 **It was also unreachable.** The preview needs `fetch` (`drawPreview`
	 * returns early without it) and the redraw needs `MutationObserver`, both
	 * strictly newer than `WeakMap` — no browser can draw a preview and lack
	 * this. A fallback nothing can reach, which breaks the thing it guards, is
	 * worse than no fallback: it reads as safety while removing it.
	 */
	var previewState = new WeakMap();

	/** The preview bookkeeping for one options block. */
	function stateFor( root ) {
		var state = previewState.get( root );

		if ( ! state ) {
			state = { timer: null, token: 0 };
			previewState.set( root, state );
		}

		return state;
	}

	/**
	 * Read a design off an element, or null when it carries none.
	 *
	 * ⚠️ **Malformed JSON is not an error worth showing.** A design that
	 * cannot be parsed means a document this build does not understand, and a
	 * customer must still be able to buy — M26e.6's first rule.
	 */
	function designOf( element ) {
		if ( ! element ) {
			return null;
		}

		var raw = element.getAttribute( 'data-optionia-design' );

		if ( ! raw ) {
			return null;
		}

		try {
			var parsed = JSON.parse( raw );

			return parsed && 'object' === typeof parsed ? parsed : null;
		} catch ( error ) {
			return null;
		}
	}

	/**
	 * The scene the customer's current choices compose.
	 *
	 * 🔴 **The same shape `Engine\SceneComposer` builds**, because the cloud
	 * resolves both through one function. Groups are per designed VALUE and
	 * only the chosen one is visible; a text option carries one design and the
	 * typed value replaces its sample.
	 */
	function composeScene( root ) {
		var groups = [];
		var texts = [];
		var options = root.querySelectorAll( '[data-optionia-option]' );

		for ( var i = 0; i < options.length; i++ ) {
			var option = options[ i ];
			var optionId = option.getAttribute( 'data-optionia-option' ) || '';

			if ( ! optionId || option.hasAttribute( 'data-optionia-hidden' ) ) {
				continue;
			}

			/*
			 * A text option carries its design on the OPTION, and what the
			 * customer typed is the value — the distinction SceneComposer
			 * makes between `textOptions` and groups.
			 */
			var optionDesign = designOf( option );

			if ( optionDesign ) {
				var field = option.querySelector( 'input[type="text"], textarea' );
				var typed = field && field.value ? String( field.value ) : '';

				if ( typed ) {
					texts.push( { key: optionId, design: optionDesign, value: typed } );
				}

				continue;
			}

			var values = option.querySelectorAll( '[data-optionia-design]' );

			for ( var v = 0; v < values.length; v++ ) {
				var input = values[ v ];
				var design = designOf( input );

				if ( ! design ) {
					continue;
				}

				groups.push( {
					key: optionId + ':' + ( input.value || String( v ) ),
					layers: design.layers || [],
					visible: !! input.checked
				} );
			}
		}

		if ( ! groups.length && ! texts.length ) {
			return null;
		}

		/*
		 * ⚠️ **Nothing visible draws nothing.** Asking the cloud to render a
		 * scene whose every group is hidden spends a request from a bounded
		 * allowance to produce a blank document.
		 */
		var anyVisible = texts.length > 0;

		for ( var g = 0; g < groups.length; g++ ) {
			if ( groups[ g ].visible && groups[ g ].layers.length ) {
				anyVisible = true;
			}
		}

		if ( ! anyVisible ) {
			return null;
		}

		var scene = {
			width: PREVIEW_CANVAS,
			height: PREVIEW_CANVAS,
			groups: groups
		};

		if ( texts.length ) {
			scene.textOptions = texts;
		}

		return scene;
	}

	/*
	 * ---------------------------------------------------------------------
	 * Finding the product's own image (M26e.2)
	 * ---------------------------------------------------------------------
	 *
	 * 🔴 **A design on the wrong product is worse than no preview**, which is
	 * M26e.2's own words and the reason every branch here fails CLOSED.
	 *
	 * 📌 **Measured on a stock Storefront product page, not assumed.** FIVE
	 * images on `/product/spider-man/` carry a product thumbnail class: one real
	 * and four impostors — three "you may also like" tiles and one prev/next
	 * pagination thumbnail.
	 *
	 * 🔴 **All five sit INSIDE the viewed product's own `post-14` element.**
	 * This was the trap: scoping to the `post-<id>` wrapper looks like an
	 * identity check and filters nothing, because WooCommerce nests
	 * `section.related > ul.products > li.post-27` and
	 * `nav.storefront-product-pagination` within the wrapper. A wrapper-scoped
	 * largest-image rule agrees with the right answer only while the real image
	 * happens to be the biggest — it is a coincidence, not a test.
	 *
	 * ⚠️ **So attribution is structural.** The wrapper narrows the search; an
	 * image is then rejected when it sits in a related/upsell/pagination
	 * container, under a nested `post-<id>` belonging to another product, or
	 * under a link that leaves for another page. What survives is the gallery's.
	 */

	/**
	 * The image this block's design should be drawn over, or null.
	 *
	 * 🔴 **Null is a correct and common answer.** A theme that does not use
	 * WooCommerce's conventions, a product with no image, a page whose markup
	 * this cannot read with confidence — each gets no overlay rather than the
	 * wrong one.
	 */
	function productImage( root ) {
		var productId = root.getAttribute( 'data-optionia-product' ) || '';

		if ( ! productId ) {
			return null;
		}

		/*
		 * ⚠️ **`closest`, so the wrapper must CONTAIN the options root.** A
		 * `querySelector` for the same class would match a related product's
		 * wrapper elsewhere on the page.
		 */
		var wrapper = root.closest( '.post-' + productId );

		if ( ! wrapper ) {
			return null;
		}

		/*
		 * 🔴 **The wrapper is NOT a filter — measured on a real page.** On
		 * Storefront, `post-14` contains the related products and the prev/next
		 * pagination *inside itself*, so all five of the page's product images
		 * are within it. Scoping to the wrapper and taking the largest image is
		 * therefore a largest-on-page rule in disguise: it agrees with the right
		 * answer only while the real image happens to be the biggest.
		 */
		var images = wrapper.querySelectorAll( 'img' );
		var best = null;
		var bestArea = 0;

		for ( var i = 0; i < images.length; i++ ) {
			var image = images[ i ];

			if ( foreignImage( image, wrapper, productId ) ) {
				continue;
			}

			/*
			 * ⚠️ **Measured, not assumed, and a zero-sized image is skipped.**
			 * A gallery's hidden slides and a lazy placeholder both report no
			 * area, and overlaying one puts the design where nobody sees it.
			 */
			var rect = image.getBoundingClientRect();
			var area = rect.width * rect.height;

			if ( area > bestArea ) {
				best = image;
				bestArea = area;
			}
		}

		/*
		 * ✏️ **Equivalent mutant: `return best;` behaves identically.**
		 * `bestArea` starts at 0 and the comparison above is strict, so a
		 * zero-area image is never assigned to `best` — whenever `bestArea` is
		 * 0, `best` is still null. Verified by mutation: replacing this with
		 * `return best;` leaves all 12 unit tests and all 5 browser tests
		 * green, and no test can be written that distinguishes them.
		 *
		 * Kept as written because it states the postcondition the caller relies
		 * on — "no drawable image means null" — where the loop only implies it.
		 */
		return bestArea > 0 ? best : null;
	}

	/**
	 * Containers that hold OTHER products' images inside this product's wrapper.
	 *
	 * 📌 **Every one of these was observed on a stock Storefront page**, nested
	 * within the viewed product's own `post-<id>` element.
	 */
	var FOREIGN_CONTAINERS = [
		'.related',
		'.up-sells',
		'.cross-sells',
		'.upsells',
		'.storefront-product-pagination',
		'.product-pagination',
		'nav'
	].join( ',' );

	/**
	 * Whether an image belongs to some product other than the one being viewed.
	 *
	 * 🔴 **Fails closed.** An image this cannot positively attribute to the
	 * viewed product is foreign. Costing a preview on an unusual theme is a
	 * smaller harm than drawing a customer's design on a product they did not
	 * buy, which is M26e.2's founding rule.
	 */
	function foreignImage( image, wrapper, productId ) {
		/*
		 * 🔴 **Related products, upsells and prev/next links nest INSIDE the
		 * product wrapper.** This is the check the wrapper scope was wrongly
		 * assumed to perform.
		 */
		if ( image.closest( FOREIGN_CONTAINERS ) ) {
			return true;
		}

		/*
		 * ⚠️ **A nested `post-<id>` that is not ours settles it.** Loop items
		 * carry their own `post-<id>`; if the nearest one belongs to another
		 * product, so does the image.
		 */
		var owner = image.closest( '[class*="post-"]' );

		if ( owner && owner !== wrapper ) {
			var owned = ( owner.className || '' ).toString().match( /\bpost-(\d+)\b/ );

			if ( owned && owned[ 1 ] !== productId ) {
				return true;
			}
		}

		/*
		 * ⚠️ **A link out of the product page is foreign.** A gallery lightbox
		 * points at the full-size IMAGE file, which is ours; a link to another
		 * page is not.
		 */
		var link = image.closest( 'a[href]' );

		if ( ! link ) {
			return false;
		}

		var href = link.getAttribute( 'href' ) || '';

		if ( ! href || 0 === href.indexOf( '#' ) ) {
			return false;
		}

		return ! /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i.test( href );
	}

	/**
	 * The key that ties a preview host to the block that owns it.
	 *
	 * 📌 **The product id where there is one.** Two blocks for the same product
	 * on one page would then share a host, which is correct: they describe the
	 * same picture. Blocks with no id fall back to their index, so they stay
	 * separate rather than silently merging.
	 */
	function hostKey( root ) {
		var productId = root.getAttribute( 'data-optionia-product' ) || '';

		if ( productId ) {
			return productId;
		}

		var blocks = root.ownerDocument.querySelectorAll( '[data-optionia="options"]' );

		for ( var i = 0; i < blocks.length; i++ ) {
			if ( blocks[ i ] === root ) {
				return 'block-' + i;
			}
		}

		return 'block';
	}

	/** This block's own preview host, or null. */
	function ownHost( root ) {
		return root.ownerDocument.querySelector(
			'[data-optionia-preview-for="' + cssEscape( hostKey( root ) ) + '"]'
		);
	}

	/**
	 * Where the preview is drawn — over the product image — or null.
	 *
	 * 🔴 **Null when the product image cannot be identified**, and the caller
	 * then draws nothing. Falling back to "somewhere inside the options block"
	 * would always produce a visible preview, which is precisely the failure
	 * M26e.2 forbids: a design shown against the wrong picture reads as a
	 * promise about a product the customer is not buying.
	 */
	function previewHost( root ) {
		var image = productImage( root );

		if ( ! image ) {
			return null;
		}

		/*
		 * 🔴 **The host belongs to THIS block, not to the document.** The
		 * preview is mounted in the theme's gallery, which is shared, so a
		 * document-wide `querySelector` returns whichever host happens to be
		 * first — and with two options blocks on a page they overwrite each
		 * other's artwork. Measured by cloning the block on a real page: two
		 * blocks, one host.
		 *
		 * ⚠️ **Re-anchored if the image moved.** A gallery swap or a variation
		 * change replaces the image element, and a host still parented to the
		 * old one would float over nothing.
		 */
		var existing = ownHost( root );

		if ( existing && existing.parentNode === image.parentNode ) {
			return existing;
		}

		if ( existing && existing.parentNode ) {
			existing.parentNode.removeChild( existing );
		}

		var host = document.createElement( 'div' );

		host.className = 'optionia-preview';
		host.setAttribute( 'data-optionia-preview', '' );
		/*
		 * Stamped with the block's own id, so each block finds its own host and
		 * never another's. Falls back to the root's position among the blocks
		 * when a product id is missing, which keeps two unidentified blocks
		 * apart rather than merging them.
		 */
		host.setAttribute( 'data-optionia-preview-for', hostKey( root ) );
		/*
		 * 📌 **Decorative to assistive technology.** The preview repeats
		 * choices the customer has already made through labelled controls, so
		 * announcing it would be noise — and it carries no information a
		 * screen-reader user can act on.
		 */
		host.setAttribute( 'aria-hidden', 'true' );

		/*
		 * 🔴 **The image's own parent is the frame.** WooCommerce's gallery
		 * wraps each image in a positioned figure, so overlaying there tracks
		 * the image through the theme's own responsive sizing instead of this
		 * plugin guessing coordinates.
		 */
		var frame = image.parentNode;

		/*
		 * ✏️ **Equivalent mutant: deleting this changes nothing.** `image` comes
		 * from `wrapper.querySelectorAll( 'img' )`, so it is by construction a
		 * descendant of the wrapper and always has a parent. Verified by
		 * mutation — removing the guard leaves all 200 unit tests and all 5
		 * browser tests green, and no test can be written that reaches it
		 * without calling `previewHost` with something `productImage` would
		 * never return.
		 *
		 * Kept because it states the precondition `positionOver` relies on,
		 * which the call above only implies.
		 */
		if ( ! frame ) {
			return null;
		}

		positionOver( host, image, frame );
		frame.appendChild( host );
		trackSize( root, host, image, frame );

		return host;
	}

	/**
	 * Keep the overlay on the image as the image changes size.
	 *
	 * 🔴 **The box is read once, and the theme keeps moving.** Measured: with
	 * the image resized from 1254px to 500px the overlay stayed at 1254px, so
	 * the customer's design spilled far outside the product. A zoom plugin, a
	 * lazily-loaded font reflowing the column, a CSS transition and a
	 * responsive breakpoint all do exactly this.
	 *
	 * ⚠️ **One observer per block**, replaced rather than stacked, for the same
	 * reason the gallery observer is.
	 */
	function trackSize( root, host, image, frame ) {
		if ( 'undefined' === typeof ResizeObserver ) {
			return;
		}

		var state = stateFor( root );

		if ( state.sizer ) {
			state.sizer.disconnect();
			state.sizer = null;
		}

		var sizer = new ResizeObserver( function () {
			/*
			 * Re-read from the live elements rather than trusting the values
			 * captured when the host was built — by the time this fires the
			 * image may have been replaced as well as resized.
			 */
			if ( ! host.parentNode || ! image.parentNode ) {
				return;
			}

			positionOver( host, image, frame );
		} );

		sizer.observe( image );
		state.sizer = sizer;
	}

	/**
	 * Lay the preview over an image without disturbing the theme's layout.
	 *
	 * ⚠️ **Nothing the theme owns is restyled except a static `position`.** An
	 * absolutely positioned child needs a positioned ancestor; if the frame is
	 * `static` it is promoted to `relative`, which does not move it. Any other
	 * value the theme chose is left exactly as it is.
	 */
	function positionOver( host, image, frame ) {
		var view = frame.ownerDocument.defaultView;
		var framePosition = view ? view.getComputedStyle( frame ).position : '';

		if ( 'static' === framePosition ) {
			frame.style.position = 'relative';
		}

		host.style.position = 'absolute';
		host.style.left = image.offsetLeft + 'px';
		host.style.top = image.offsetTop + 'px';
		host.style.width = image.offsetWidth + 'px';
		host.style.height = image.offsetHeight + 'px';
		/*
		 * 📌 **Clicks pass through to the gallery.** The lightbox and zoom
		 * belong to the theme, and an overlay that swallowed their clicks would
		 * break a feature the merchant already had.
		 */
		host.style.pointerEvents = 'none';
	}

	/**
	 * Ask the cloud for the current scene and draw it.
	 *
	 * ⚠️ **A stale answer is discarded.** Clicking three swatches quickly
	 * starts three requests, and they may land out of order; only the newest
	 * token is allowed to paint.
	 */
	function drawPreview( root ) {
		if ( ! preview.url || ! preview.nonce || ! preview.check || 'undefined' === typeof fetch ) {
			return;
		}

		var scene = composeScene( root );

		if ( ! scene ) {
			/*
			 * ⚠️ **Searched from the document, not the options root.** The host
			 * is mounted in the theme's gallery, so a root-scoped query would
			 * never find it and a stale design would stay on screen after the
			 * customer cleared their choices.
			 */
			var stale = ownHost( root );

			if ( stale ) {
				stale.innerHTML = '';
			}

			return;
		}

		var state = stateFor( root );

		state.token += 1;

		var token = state.token;

		fetch( preview.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': preview.nonce
			},
			body: JSON.stringify( {
				scene: scene,
				width: PREVIEW_CANVAS,
				height: PREVIEW_CANVAS,
				/*
				 * The route's own nonce. `X-WP-Nonce` carries `wp_rest`,
				 * which WordPress reserves; this travels in the body so its
				 * header check does not claim it.
				 */
				check: preview.check
			} )
		} )
			.then( function ( response ) {
				return response.ok && 204 !== response.status ? response.text() : '';
			} )
			.then( function ( body ) {
				/*
				 * 🔴 **WordPress JSON-encodes the payload whatever the
				 * Content-Type says.** `WP_REST_Response` serialises its data
				 * through the JSON formatter, so an SVG arrives as a QUOTED
				 * STRING with escaped slashes — `"<svg \/>"` — and a check for
				 * a leading `<svg` rejects every real preview.
				 *
				 * ⚠️ **Measured against the live site, not reasoned about.**
				 * The route answered 200 with `image/svg+xml` and a body whose
				 * first byte was `"`. Parsing is what turns that back into the
				 * document the cloud rendered.
				 */
				var svg = body;

				if ( body && '"' === body.charAt( 0 ) ) {
					try {
						svg = JSON.parse( body );
					} catch ( error ) {
						svg = '';
					}
				}
				/*
				 * 🔴 **Only the newest request paints**, and only an SVG. A
				 * body that is not one means something else answered — a login
				 * wall, a proxy page — and injecting it would put foreign
				 * markup inside the product page.
				 */
				if ( token !== state.token || ! svg || 0 !== svg.indexOf( '<svg' ) ) {
					return;
				}

				var host = previewHost( root );

				/*
				 * 🔴 **No identifiable product image means no overlay.** The
				 * SVG is simply dropped — drawing it anywhere else would put
				 * the customer's design over the wrong picture.
				 */
				if ( ! host ) {
					return;
				}

				host.innerHTML = svg;
			} )
			.catch( function () {
				/*
				 * Never blocks a sale (M26e.6). A preview that does not arrive
				 * leaves the customer exactly where they were.
				 */
			} );
	}

	/** Redraw after the customer stops changing things. */
	function schedulePreview( root ) {
		var state = stateFor( root );

		if ( state.timer ) {
			clearTimeout( state.timer );
		}

		state.timer = setTimeout( function () {
			drawPreview( root );
		}, PREVIEW_DEBOUNCE_MS );
	}

	/**
	 * Redraw when the theme replaces the product image.
	 *
	 * 📌 **The DOM is watched rather than the theme's events.** WooCommerce
	 * emits `show_variation`, Storefront's gallery emits its own, a block theme
	 * emits neither, and each is a private contract that can change. What every
	 * one of them must do is swap the image element — so that is what is
	 * observed, and the same code covers variations, gallery clicks and themes
	 * nobody here has seen.
	 *
	 * ⚠️ **Does nothing where there is no gallery.** A theme this cannot find
	 * an image in never had a preview to lose.
	 */
	function watchGallery( root ) {
		/*
		 * ✏️ **Unkilled by mutation, and deliberately kept.** Every engine the
		 * tests run on has `MutationObserver`, so no test can reach this — but
		 * unlike the frame guard below it is not logically unreachable: it is a
		 * feature test for a browser nobody here has. Without it such a browser
		 * throws on the line after, taking the whole runtime down and with it
		 * the option fields a customer needs to buy. The redraw is the feature
		 * that degrades; the form is not.
		 */
		if ( 'undefined' === typeof MutationObserver ) {
			return;
		}

		var state = stateFor( root );

		/*
		 * 🔴 **One observer per block, replaced rather than added to.**
		 * `watchForGallery` calls back into this function once a gallery
		 * appears, and a gallery that comes and goes would otherwise bind a
		 * second, third, fourth observer — each one running `productImage()`
		 * over every image in the gallery on every mutation. A block theme
		 * that re-renders the options area makes that unbounded.
		 */
		if ( state.observer ) {
			state.observer.disconnect();
			state.observer = null;
		}

		var image = productImage( root );

		/*
		 * 🔴 **No image yet is not "no gallery ever".** Measured: with the
		 * gallery hidden at first paint the watcher used to return here, so
		 * when the gallery arrived a moment later NOTHING was observing and no
		 * preview was ever drawn — the customer saw an empty product unless
		 * they happened to touch an option again. A lazy-loading or
		 * slider-driven gallery is exactly this shape, so the document is
		 * watched until an image exists.
		 */
		if ( ! image ) {
			watchForGallery( root );

			return;
		}

		/*
		 * The gallery as a whole, not the image's own parent: a swap replaces
		 * that parent, and an observer bound to a removed node stops seeing
		 * anything.
		 */
		/*
		 * ✏️ **The `||` branch is unkilled by mutation.** Both WooCommerce
		 * classes are present on every theme tested, so `closest` always
		 * answers — but a theme that renames its gallery wrapper would
		 * otherwise observe nothing and lose the redraw entirely. Falling back
		 * to the image's own parent still catches a swap of the image itself,
		 * which is the common case.
		 */
		var gallery = image.closest( '.woocommerce-product-gallery, .images' ) || image.parentNode;

		if ( ! gallery ) {
			return;
		}

		var observer = new MutationObserver( function () {
			/*
			 * 🔴 **Only when the preview is actually gone or misplaced.**
			 * Redrawing on every mutation would fire on the plugin's OWN
			 * insertion of the host and loop forever.
			 */
			var host = ownHost( root );
			var current = productImage( root );

			if ( ! current ) {
				return;
			}

			if ( host && host.parentNode === current.parentNode ) {
				return;
			}

			schedulePreview( root );
		} );

		observer.observe( gallery, { childList: true, subtree: true } );

		/* Held so a later call can disconnect it rather than stack another. */
		state.observer = observer;
	}

	/**
	 * Wait for a gallery that is not on the page yet.
	 *
	 * ⚠️ **Stops as soon as it finds one.** A document-wide observer is the
	 * blunt instrument here, so it disconnects the moment the real gallery
	 * watcher can take over — it exists to bridge a gap, not to run for the
	 * life of the page.
	 */
	function watchForGallery( root ) {
		var body = root.ownerDocument.body;

		/*
		 * ✏️ **Unkilled: a document holding an options block always has a
		 * body.** Kept because `init()` may be called from `DOMContentLoaded`
		 * on a document still being written, and `observe( null )` throws —
		 * which would take the runtime down rather than skip a redraw.
		 */
		if ( ! body ) {
			return;
		}

		var state = stateFor( root );

		/* Same rule as the gallery observer: one per block, never stacked. */
		if ( state.waiting ) {
			state.waiting.disconnect();
			state.waiting = null;
		}

		var waiting = new MutationObserver( function () {
			if ( ! productImage( root ) ) {
				return;
			}

			waiting.disconnect();
			state.waiting = null;

			/*
			 * Bind the real watcher to the gallery that has now arrived, then
			 * draw — the customer has touched nothing, so nothing else will.
			 */
			watchGallery( root );
			schedulePreview( root );
		} );

		waiting.observe( body, { childList: true, subtree: true, attributes: true, attributeFilter: [ 'style', 'class' ] } );

		state.waiting = waiting;
	}

	function init() {
		var blocks = document.querySelectorAll( '[data-optionia="options"]' );
		var i;

		for ( i = 0; i < blocks.length; i++ ) {
			bind( blocks[ i ] );
		}

		/*
		 * 📌 **After binding, and never blocking it.** `reportViews` only
		 * registers a listener — nothing is sent until the customer leaves — so
		 * a page with options is interactive exactly as soon as it was before.
		 */
		reportViews();
	}

	/*
	 * 📌 **A deliberately narrow window onto the image finder.** M26e.2's rule
	 * can only be proven against a REAL theme's markup, and a browser test
	 * cannot reach into a closure. Re-implementing the algorithm in the test
	 * would assert the test's idea of the code rather than the code — the trap
	 * that let a blank print file pass 1,333 tests on this project.
	 *
	 * ⚠️ **Read-only, and nothing depends on it.** Only a pure query is
	 * exposed: it mutates nothing, so the page behaves identically whether or
	 * not anything reads it.
	 */
	/*
	 * 🔴 **Not on a real storefront.** `SCRIPT_DEBUG` is false on every
	 * production install, so a shop never carries this surface; a developer
	 * running the browser suite does. Re-verified with the flag off: the
	 * surface is absent, the preview still draws, one host, no errors.
	 *
	 * ⚠️ **It has grown, and growth is the thing to watch.** It began as one
	 * read-only query and is now four, two of which mutate the page and bind
	 * observers. Each addition was the cheapest way to test something — and
	 * "cheapest way to test something" is how a test hook becomes an API.
	 *
	 * 📌 **The rule: nothing joins this unless a test needs it AND the defect
	 * it covers is invisible from outside.** That is what earned the last
	 * three their place:
	 *
	 *   productImage   the finder itself — 12 browser refs, 5 unit
	 *   previewHost    host ownership per block; reachable only through
	 *                  `drawPreview`, which needs settings, a scene and the
	 *                  network before it runs — 11 unit refs
	 *   watchGallery   observer lifecycle: one per block, replaced not
	 *                  stacked. A browser test can see the preview come back;
	 *                  it cannot see whether a second observer was added — 6
	 *                  unit refs
	 *   stateFor       the per-block record those assertions read — 5 refs
	 *
	 * ✏️ **Anything that can be tested WITHOUT being exposed must be.** The
	 * unit suite loads this file into jsdom and drives it through the DOM; the
	 * closure is only opened where that genuinely cannot reach.
	 */
	if ( settings.debug ) {
		window.optioniaTest = {
			productImage: productImage,

			/*
			 * 📌 **Exposed so the host-ownership rule can be tested.** Each
			 * block must find its OWN host: the preview is mounted in the
			 * theme's shared gallery, so a document-wide lookup hands two
			 * blocks the same element and they overwrite each other's artwork.
			 * That rule lives in `previewHost`, and `drawPreview` — its only
			 * other caller — needs preview settings, a scene and the network
			 * before it is reached.
			 */
			previewHost: previewHost,

			/*
			 * 📌 **The watchers, so their lifecycle can be tested.** Each binds
			 * a `MutationObserver` and must replace rather than stack it — a
			 * gallery that comes and goes would otherwise leave one observer
			 * per appearance, each scanning every image on every mutation.
			 * Nothing about that is visible from outside without a handle.
			 */
			watchGallery: watchGallery,
			stateFor: stateFor
		};
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', init );
	} else {
		init();
	}
} )();
