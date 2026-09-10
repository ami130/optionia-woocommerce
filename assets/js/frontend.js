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
		} );

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
	 * Two things make it necessary, and both are scheduled. Percentage pricing
	 * needs the *variation's* base price, which changes on every switch — that
	 * waits on `docs/PRICING-SPEC.md` (M11.1). Show/hide rules re-evaluate
	 * against the chosen variation — that is Phase 17. Whichever lands first
	 * adds the listeners, and the guard in `bind` is already there for it.
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
