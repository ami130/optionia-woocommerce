/**
 * The conditional-rule evaluator, in the browser (M17.9).
 *
 * ## Why a third implementation exists
 *
 * 🔴 **Two evaluators already decide this, and neither can decide it here.**
 * `Engine\RuleEvaluator` (PHP) settles what a customer may submit;
 * `common/rules/rule-evaluator.ts` settles what a merchant may publish. Both run
 * on a server. What a *page* shows has to be decided on the page — AC3 forbids
 * the storefront read path reaching Optionia, so asking is not an option.
 *
 * ⚠️ **A third implementation is a third chance to disagree**, and 16d is what
 * that costs: two languages differing at a boundary, found late. Three things
 * hold this one in line:
 *
 * 1. It is held to the **same `rule-fixtures.json`** the other two execute —
 *    the same file, byte-identical across repositories and hash-pinned.
 * 2. The shared specification was **already written in JavaScript's idiom**.
 *    `as_string()` spells a boolean `'true'`/`'false'` — JavaScript's spelling,
 *    which PHP had to be bent to produce — and the numeric pattern is plain
 *    ASCII, identical in both. This port is the least likely of the three to
 *    drift, because the others were written towards it.
 * 3. It mirrors the PHP structure function for function, so a reader comparing
 *    them can see a difference rather than having to derive one.
 *
 * ## What it does NOT do
 *
 * 🔴 **It never prices anything.** `set_price` is evaluated for nothing here and
 * `action_value` is not even sent to the page — AC4 makes price
 * server-authoritative, and a second source of truth for an amount is how a
 * storefront comes to show a total the server disagrees with. Show and hide,
 * and nothing else.
 *
 * It is also **not a validator**. A hidden option is refused server-side by
 * `SelectionResolver` whatever this file does; this decides what a customer
 * *sees*, so that they are not offered a field the server would then refuse.
 */

/*
 * ⚠️ **A classic script, not an ES module, and that is a deployment decision.**
 *
 * `frontend.js` is an IIFE loaded with a plain `<script>` tag. Making either
 * file a module would change how WordPress emits that tag and how every theme
 * and page builder orders it — a load-order regression across thousands of
 * merchant sites, to save a namespace. So this publishes `window.optioniaRules`
 * (the evaluator) the same way the runtime publishes nothing at all, and the
 * tests read the file exactly as the browser does.
 */
( function ( global ) {
	'use strict';

	/** Passes before evaluation refuses. MUST equal `RuleEvaluator::MAX_PASSES`. */
		var MAX_PASSES = 10;
	
	/**
	 * A value as the string both languages agree on.
	 *
	 * 🔴 **`String(true)` is `'true'`, and PHP's `(string) true` is `'1'`.** The
	 * shared fixture pins *this* spelling, and the PHP side implements it
	 * explicitly. Written out rather than left to `String()` so the agreement is
	 * visible at the place it is made.
	 *
	 * @param {*} value Any scalar.
	 * @return {string}
	 */
	function asString( value ) {
		if ( true === value ) {
			return 'true';
		}
	
		if ( false === value ) {
			return 'false';
		}
	
		if ( null === value || undefined === value ) {
			return '';
		}
	
		return 'object' === typeof value ? '' : String( value );
	}
	
	/**
	 * Whether two scalars are the same answer.
	 *
	 * Same-type values compare directly; different types compare as strings, which
	 * is what lets a merchant's `equals: 5` match a form's `"5"`.
	 *
	 * @param {*} answer  The customer's answer.
	 * @param {*} operand The merchant's operand.
	 * @return {boolean}
	 */
	function sameScalar( answer, operand ) {
		if ( typeof answer === typeof operand ) {
			return answer === operand;
		}
	
		return asString( answer ) === asString( operand );
	}
	
	/**
	 * A value as a finite number, or null.
	 *
	 * ⚠️ **Not `Number()`.** `Number('0x10')` is 16, `Number('')` is 0 and
	 * `Number(' 12 ')` is 12 — so a blank answer would satisfy `less_than: 5`. The
	 * pattern is the same one `RuleEvaluator::numeric_value()` uses, character for
	 * character; it was chosen because both languages honour it identically.
	 *
	 * @param {*} value Any scalar.
	 * @return {?number}
	 */
	function numericValue( value ) {
		if ( 'number' === typeof value ) {
			return Number.isFinite( value ) ? value : null;
		}
	
		if ( 'string' !== typeof value ) {
			return null;
		}
	
		var trimmed = value.trim();
	
		if ( ! /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test( trimmed ) ) {
			return null;
		}
	
		var parsed = parseFloat( trimmed );
	
		return Number.isFinite( parsed ) ? parsed : null;
	}
	
	/**
	 * Compare two values as numbers, or answer false.
	 *
	 * @param {*}        answer  The customer's answer.
	 * @param {*}        operand The merchant's operand.
	 * @param {Function} compare Receives two numbers.
	 * @return {boolean}
	 */
	function compareNumeric( answer, operand, compare ) {
		var left = numericValue( answer );
		var right = numericValue( operand );
	
		if ( null === left || null === right ) {
			return false;
		}
	
		return compare( left, right );
	}
	
	/**
	 * Whether the answer appears in the merchant's list.
	 *
	 * @param {*} answer  The customer's answer.
	 * @param {*} operand The merchant's list.
	 * @return {boolean}
	 */
	function inList( answer, operand ) {
		if ( ! Array.isArray( operand ) ) {
			return false;
		}
	
		var i;
	
		for ( i = 0; i < operand.length; i++ ) {
			if ( sameScalar( answer, operand[ i ] ) ) {
				return true;
			}
		}
	
		return false;
	}
	
	/**
	 * Whether one condition holds against the answers so far.
	 *
	 * ⚠️ **An unknown operator is false, never fatal.** The document is input rather
	 * than authority (AC4), and a plugin build older than an operator reaching it
	 * must render the product rather than refuse it.
	 *
	 * @param {Object} condition One published condition.
	 * @param {Object} answers   Answers keyed by option id.
	 * @return {boolean}
	 */
	function conditionHolds( condition, answers ) {
		if ( ! condition || 'object' !== typeof condition ) {
			return false;
		}
	
		var optionId = 'string' === typeof condition.option_id ? condition.option_id : '';
		var operator = 'string' === typeof condition.operator ? condition.operator : '';
	
		var answer = Object.prototype.hasOwnProperty.call( answers, optionId ) ? answers[ optionId ] : null;
		var supplied = null !== answer && undefined !== answer && '' !== answer;
		var operand = Object.prototype.hasOwnProperty.call( condition, 'value' ) ? condition.value : null;
	
		switch ( operator ) {
			case 'is_empty':
				return ! supplied;
	
			case 'is_not_empty':
				return supplied;
	
			case 'equals':
				return supplied && sameScalar( answer, operand );
	
			case 'not_equals':
				/*
				 * ⚠️ **An unanswered option does NOT satisfy `not_equals`.**
				 * "Colour is not red" asks about a colour that was chosen; treating
				 * a blank as a match would fire the rule on a form the customer has
				 * not begun.
				 */
				return supplied && ! sameScalar( answer, operand );
	
			case 'contains':
				return supplied && 'string' === typeof operand
					&& asString( answer ).indexOf( operand ) !== -1;
	
			case 'greater_than':
				return compareNumeric( answer, operand, function ( a, b ) {
					return a > b;
				} );
	
			case 'less_than':
				return compareNumeric( answer, operand, function ( a, b ) {
					return a < b;
				} );
	
			case 'in':
				return supplied && inList( answer, operand );
	
			case 'not_in':
				return supplied && ! inList( answer, operand );
	
			default:
				return false;
		}
	}
	
	/**
	 * Whether a rule's conditions are satisfied, under its own connective.
	 *
	 * ⚠️ **A rule with no conditions never fires.** The authoring schema refuses
	 * one, so this is reachable only from a document written before that check — and
	 * a rule that always fires is not a conditional rule at all. `false` leaves the
	 * page as the merchant would see it without the rule.
	 *
	 * @param {Object} rule    One published rule.
	 * @param {Object} answers Answers keyed by option id.
	 * @return {boolean}
	 */
	function ruleFires( rule, answers ) {
		var conditions = rule && Array.isArray( rule.conditions ) ? rule.conditions : [];
	
		if ( 0 === conditions.length ) {
			return false;
		}
	
		var any = 'any' === ( rule.match_type || 'all' );
		var i;
	
		for ( i = 0; i < conditions.length; i++ ) {
			var holds = conditionHolds( conditions[ i ], answers );
	
			if ( any && holds ) {
				return true;
			}
	
			if ( ! any && ! holds ) {
				return false;
			}
		}
	
		return ! any;
	}
	
	/**
	 * Collect what every firing rule decides, one pass.
	 *
	 * @param {Array}  rules         Published rules.
	 * @param {Object} answers       Answers keyed by option id.
	 * @param {Object} alreadyHidden Targets hidden by an earlier pass.
	 * @return {Object} Target id -> state.
	 */
	function resolvePass( rules, answers, alreadyHidden ) {
		var states = {};
		var i;
	
		function seed( targetId ) {
			if ( ! Object.prototype.hasOwnProperty.call( states, targetId ) ) {
				states[ targetId ] = { hidden: false, required: null };
			}
	
			return states[ targetId ];
		}
	
		for ( i = 0; i < rules.length; i++ ) {
			var rule = rules[ i ];
	
			if ( ! rule || ! ruleFires( rule, answers ) ) {
				continue;
			}
	
			var targetId = 'string' === typeof rule.target_id ? rule.target_id : '';
			var state = seed( targetId );
	
			switch ( rule.action ) {
				case 'hide':
					state.hidden = true;
					break;
	
				case 'require':
					state.required = true;
					break;
	
				case 'unrequire':
					// `require` wins, for the same reason `hide` does.
					state.required = true === state.required ? true : false;
					break;
	
				default:
					/*
					 * `set_price` reaches this switch and does nothing,
					 * deliberately: pricing is the server's (AC4), and the
					 * amount is not even sent to the page.
					 *
					 * An action a newer build authored lands here too, and is
					 * ignored rather than fatal — which is also what a stored
					 * `set_default` row now does, since ADR-055 withdrew that
					 * action. A rule whose action nothing recognises changes
					 * nothing, in all three languages.
					 */
					break;
			}
		}
	
		/*
		 * 🔴 A target hidden by an earlier pass stays hidden, even when the rule that
		 * hid it no longer fires — because what stopped it firing was the hide itself
		 * clearing the answer its condition read. This is what makes the fixed point
		 * monotone, and therefore what makes it terminate.
		 */
		Object.keys( alreadyHidden ).forEach( function ( targetId ) {
			seed( targetId ).hidden = true;
		} );
	
		return states;
	}
	
	/** Whether two answer maps are the same. */
	function sameAnswers( a, b ) {
		var keysA = Object.keys( a );
		var keysB = Object.keys( b );
	
		if ( keysA.length !== keysB.length ) {
			return false;
		}
	
		return keysA.every( function ( key ) {
			return Object.prototype.hasOwnProperty.call( b, key ) && a[ key ] === b[ key ];
		} );
	}
	
	/**
	 * Evaluate every rule to a fixed point.
	 *
	 * Mirrors `RuleEvaluator::evaluate()`: answers are rebuilt from the originals
	 * each pass and only `hidden` carries between them, so the outcome cannot depend
	 * on the order rules were visited (M17.2).
	 *
	 * 🔴 **Reaching the cap refuses** (ADR-050). The page then shows every option,
	 * which is the safe direction: the server refuses what it must, and a customer
	 * sees a form rather than a blank product. Returning the state reached would be
	 * a field wrongly shown or hidden, which is worse than showing all of them.
	 *
	 * @param {Array}  rules         Published rules.
	 * @param {Object} answers       Answers keyed by option id.
	 * @param {Object} optionsUnder  Target id -> the option ids whose answers it clears.
	 * @return {{states: Object, passes: number, refused: ?string}}
	 */
	function evaluate( rules, answers, optionsUnder ) {
		var hidden = {};
		var current = Object.assign( {}, answers );
		var pass;
	
		for ( pass = 1; pass <= MAX_PASSES; pass++ ) {
			var states = resolvePass( rules, current, hidden );
	
			Object.keys( states ).forEach( function ( targetId ) {
				if ( states[ targetId ].hidden ) {
					hidden[ targetId ] = true;
				}
			} );
	
			var next = Object.assign( {}, answers );
	
			Object.keys( hidden ).forEach( function ( targetId ) {
				( optionsUnder[ targetId ] || [] ).forEach( function ( optionId ) {
					delete next[ optionId ];
				} );
			} );
	
			if ( sameAnswers( next, current ) ) {
				return { states: states, passes: pass, refused: null };
			}
	
			current = next;
		}
	
		return {
			states: {},
			passes: MAX_PASSES,
			refused: 'Rules did not settle within the pass limit.',
		};
	}

	/*
	 * The evaluator's public surface. Named `optioniaRuleEngine` rather than
	 * `optioniaRules`, which `Assets::publish_rules()` already uses for the
	 * **data** — one is the rules, the other is what reads them.
	 */
	global.optioniaRuleEngine = {
		MAX_PASSES: MAX_PASSES,
		conditionHolds: conditionHolds,
		ruleFires: ruleFires,
		evaluate: evaluate,
	};
}( typeof window !== 'undefined' ? window : globalThis ) );
