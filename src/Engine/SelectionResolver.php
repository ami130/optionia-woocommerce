<?php
/**
 * Selections resolved against the cached config (M11.5).
 *
 * This is the outer half of M11.2's
 * `(config, selections, base_price, quantity) -> price_delta + breakdown`.
 * Stage 5 built the inner half -- `Pricing::sum_deltas()` over a base and a list
 * of deltas -- and deliberately stopped there, because turning `config` and
 * `selections` into that list *is* M11.5's subject: "accept only selection keys;
 * reject unknown option or value keys; reject options not applicable to this
 * product; enforce required; recompute price from cached config".
 *
 * ## Rules run before validation, and the order is load-bearing
 *
 * ✏️ **Since M17.8.** `resolve()` evaluates the set's conditional rules before
 * it looks at a single selection, because whether a submitted value is legal
 * *depends on* the rule outcome — an option a rule hid must refuse the value
 * posted for it, and cannot simultaneously be missing-and-required.
 *
 * The evaluator is fed the selections **as posted**, never a partial result.
 * `AddToCartValidator` resolves to decide legality and `CartItemData::attach()`
 * re-resolves rather than carrying state across filters, deliberately, so the
 * outcome cannot depend on filter order — and that only holds if both runs get
 * the same input. ADR-051 records why.
 *
 * ## The one rule this class exists to enforce
 *
 * **Nothing price-like in the request is read.** The browser sends option ids
 * and value keys; every amount comes from the cached configuration, looked up by
 * those keys. A POST body carrying `price`, `delta`, `amount_minor` or anything
 * else is not sanitised or rejected -- it is simply never consulted, which is a
 * stronger guarantee than blocking a list of field names somebody has to keep
 * current. That is AC4.
 *
 * ## Why rejection is per-option and collected
 *
 * A customer who mistypes one field should be told which one. Returning on the
 * first failure would report a single error for a form with several problems and
 * hide the rest until the next attempt, so errors accumulate and the `Result`
 * carries them all with their field keys.
 *
 * ## Scope
 *
 * `fixed` and `percentage` pricing, plus structural validation. The remaining
 * per-type rules -- `min_length`, `max_length`, `per_char`, `per_unit`, `tiered`
 * -- arrive with the types that need them across the rest of Phase 16, and
 * `measure()` is already built and waiting for them (M11.1a).
 *
 * A type this build cannot price contributes nothing AND is recorded in
 * `unpriced`, so the admin is told rather than the merchant silently
 * undercharged. See `delta_for()`.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Engine;

defined( 'ABSPATH' ) || exit;

/**
 * Resolves raw selections into validated price deltas.
 */
final class SelectionResolver {

	/**
	 * Error code: a selection names an option this product does not have.
	 */
	public const ERROR_UNKNOWN_OPTION = 'unknown_option';

	/**
	 * Error code: a selection names a value the option does not offer.
	 */
	public const ERROR_UNKNOWN_VALUE = 'unknown_value';

	/**
	 * Error code: a required option was not chosen.
	 */
	public const ERROR_REQUIRED = 'required';

	/**
	 * Error code: a scalar was expected and something else arrived.
	 */
	public const ERROR_NOT_SCALAR = 'not_scalar';

	/**
	 * Error code: the resolved deltas could not be priced.
	 */
	public const ERROR_UNPRICEABLE = 'unpriceable';

	/**
	 * The option types that may legitimately take several answers.
	 *
	 * 🔴 **Mirrors the backend's type registry, which is the authority.** There,
	 * each type declares `cardinality: [ONE]` or `[NONE]`, and a payload naming
	 * anything else is refused at authoring time. **No type declares `MANY`
	 * yet** — M18.3 is the stage that grants it, and `checkbox` is the type it
	 * grants it to.
	 *
	 * ⚠️ **The plugin needs its own copy because AC4 makes the published
	 * document input, not authority.** A crafted payload or a document from a
	 * cloud that got this wrong reaches the resolver without passing the
	 * registry, and `Renderer` only draws `[]` inputs for `checkbox` — so any
	 * other type at `many` is an answer no form on the storefront could have
	 * produced.
	 *
	 * Measured before this list existed: a `radio` at `many` accepted **Small
	 * and Large on one line** and charged for both.
	 *
	 * 📌 **Kept in step with `type-registry.ts` by hand, not by a gate.** A
	 * cross-repo gate would be better; it is not written because the list has
	 * one entry and M18.3 is the next thing to touch it. If it grows past two,
	 * gate it.
	 */
	private const MANY_CAPABLE_TYPES = array( 'checkbox' );

	/**
	 * The longest text accepted when the merchant sets no limit.
	 *
	 * 🔴 **An unconfigured option must not mean unbounded input.** Measured: a
	 * **one-megabyte** engraving was accepted and stored — into cart session
	 * storage and then order meta — because `max_length` is optional and nothing
	 * else capped it. Not a CPU attack (it resolved in 5ms); a storage one, and
	 * it lands on a merchant who simply never opened the field.
	 *
	 * 5000 matches the ceiling the API's own schema puts on `maxLength`, so no
	 * configuration a merchant can express is affected by this. It is a backstop
	 * for the *absence* of configuration, not a second limit competing with the
	 * merchant's.
	 */
	private const ABSOLUTE_MAX_LENGTH = 5000;

	/**
	 * The most **text** one add-to-cart may carry, in bytes, across all options.
	 *
	 * 🔴 **`ABSOLUTE_MAX_LENGTH` alone does not bound a request.** It is per
	 * option and counted in *graphemes*, and neither of those is what storage
	 * costs. Two measurements:
	 *
	 * - **50 text options x 5000 characters = 244 KB** accepted in one request.
	 *   `optionsPerGroup` is 200, so the ceiling is nearer a megabyte per cart
	 *   line.
	 * - **5000 family emoji = 88 KB**, entirely within a 5000-*character* limit.
	 *   A grapheme is one engraved mark and may be 18 bytes, so "5000
	 *   characters" is not a size.
	 *
	 * Both are legitimate configurations rather than attacks — which is why a
	 * budget is the right shape: it bounds what a *cart session and order meta*
	 * must hold without telling a merchant their engraving field is too long.
	 *
	 * 64 KB is well above any real product. A signage order with ten text fields
	 * of 200 characters is 2 KB; the worst honest case measured here is a single
	 * 5000-grapheme emoji field at 88 KB, which is already implausible as an
	 * engraving.
	 */
	private const MAX_TEXT_BYTES = 65536;

	/**
	 * The largest **quantity** a `per_unit` price will charge for.
	 *
	 * 🔴 **The counterpart to `ABSOLUTE_MAX_LENGTH`, and it was missing.** A text
	 * answer is capped at 5000 graphemes whether or not a merchant configured a
	 * limit, so `per_char` cannot be driven arbitrarily high. A **number** answer
	 * had no equivalent: `min` and `max` are optional and the API bounds neither,
	 * unlike `maxLength` which it caps at 5000.
	 *
	 * Measured at 2.00 per unit with no `max` configured: a customer typing
	 * `9999999999999` added a line worth **20,000,000,000,078.00**. Arithmetically
	 * correct, and not a total any merchant meant to be reachable.
	 *
	 * A backstop for the *absence* of configuration, not a second limit competing
	 * with the merchant's -- the same shape and the same reasoning as
	 * `ABSOLUTE_MAX_LENGTH`. One million units is far above any real order: a
	 * signage shop selling by the centimetre reaches 10,000 on a hundred-metre
	 * run, and a merchant who genuinely needs more sets a `max` and is believed,
	 * because a configured maximum is checked before this.
	 *
	 * ⚠️ **Not a silent zero.** Over this, the quantity is reported as unpriced
	 * exactly as an uncomputable one is, so the notice fires and the price freeze
	 * is skipped. A ceiling that quietly made an option free would be the defect
	 * this constant exists to prevent.
	 */
	private const ABSOLUTE_MAX_QUANTITY = 1000000;

	/**
	 * Error code: the request's text exceeds `MAX_TEXT_BYTES` in total.
	 *
	 * Distinct from `ERROR_TOO_LONG`, which names *one option* exceeding a limit
	 * the merchant set. This one is about the request as a whole, and a customer
	 * cannot fix it by shortening a single field — so it must not claim they can.
	 */
	public const ERROR_TOO_MUCH_TEXT = 'too_much_text';

	/**
	 * Error code: a number option received something that is not a number.
	 */
	public const ERROR_NOT_A_NUMBER = 'not_a_number';

	/**
	 * Error code: a number fell outside the option's `min` or `max`.
	 *
	 * One code for both ends, with the bound in `params`. A customer who is out
	 * of range needs to know *which* bound and *what* it is; whether that is a
	 * floor or a ceiling is carried by the parameter, not by a second constant.
	 */
	public const ERROR_OUT_OF_RANGE = 'out_of_range';

	/**
	 * Error code: a number is not a multiple of the option's `step`.
	 */
	public const ERROR_BAD_STEP = 'bad_step';

	/**
	 * Error code: a date option received something that is not a date.
	 */
	public const ERROR_NOT_A_DATE = 'not_a_date';

	/**
	 * Error code: a date fell outside `min_date` / `max_date`, or outside the
	 * window `lead_time_days` and `max_advance_days` describe.
	 */
	public const ERROR_DATE_OUT_OF_RANGE = 'date_out_of_range';

	/**
	 * Error code: a date the merchant has blacked out, or a weekday they do not
	 * accept.
	 */
	public const ERROR_DATE_UNAVAILABLE = 'date_unavailable';

	/**
	 * Error code: text did not match the option's `pattern`.
	 */
	public const ERROR_PATTERN = 'pattern_mismatch';

	/**
	 * Error code: text used characters `allowed_charset` forbids.
	 */
	public const ERROR_CHARSET = 'charset';

	/**
	 * Error code: text contained one of the merchant's `forbidden_words`.
	 */
	public const ERROR_FORBIDDEN_WORD = 'forbidden_word';

	/**
	 * The longest merchant-authored regex accepted.
	 *
	 * 🔴 **A pattern is the one rule a merchant writes as *code*.** M14.4 calls
	 * it a security boundary: it runs on every add-to-cart, and a pathological
	 * one is a denial-of-service vector.
	 *
	 * Length is the cheapest of the three defences (the others are refusing to
	 * treat a backtrack bailout as a mismatch, and rejecting at publish). 200
	 * characters is far beyond any real validation — a UK postcode is 40 — and
	 * far below what it takes to build something interesting.
	 */
	private const MAX_PATTERN_LENGTH = 200;

	/**
	 * Error code: text fell short of the option's `min_length`.
	 *
	 * Distinct from `ERROR_REQUIRED`, which means *nothing was answered*. A
	 * customer who typed "Hi" into a field demanding five characters answered it
	 * — they just have to say more, and a message about a missing option would
	 * send them looking for a field they already filled.
	 */
	public const ERROR_TOO_SHORT = 'too_short';

	/**
	 * Error code: text exceeded the option's `max_length`.
	 *
	 * A refusal, never a truncation. `clean_text()` records why: silently cutting
	 * an engraving charges a customer for text they can see on the page and will
	 * not receive in the material, and they find out when the parcel arrives.
	 */
	public const ERROR_TOO_LONG = 'too_long';

	/**
	 * Error code: a selection names an option a rule has hidden.
	 *
	 * 🔴 **A third state, between "known" and "unknown".** `ERROR_UNKNOWN_OPTION`
	 * means the product does not have that option at all; this means it has it
	 * and the customer's *other* answers took it off the page. Reported
	 * separately because they need different messages — "that isn't an option
	 * here" would be a lie, and the customer's fix is to change the answer that
	 * hid it, not this one.
	 *
	 * ⚠️ **Refused, not ignored.** M17.4 requires that submitting a value for a
	 * rule-hidden option *fails validation*, and the reason is the same one that
	 * makes unknown ids an error rather than a shrug: a payload that is quietly
	 * dropped was still a payload somebody sent, and "it had no effect on the
	 * price" is a weaker guarantee than "it was refused". A hidden option that
	 * silently accepted a forged value would also be a way to reach a price the
	 * page never offered.
	 */
	public const ERROR_HIDDEN_BY_RULE = 'hidden_by_rule';

	/**
	 * Error code: the rules did not settle, so nothing could be resolved.
	 *
	 * ADR-050: reaching the evaluator's pass cap **refuses**. The alternative —
	 * proceeding with whatever the last pass happened to produce — makes the
	 * price depend on where the loop was cut, which is the one thing a
	 * customer-facing total must never do.
	 *
	 * Publish-time cycle detection (17-3) should make this unreachable through
	 * the dashboard. It is enforced here anyway, because AC4 makes the document
	 * input rather than authority: a document from an older cloud, or a newer
	 * one, is still a document this build has to survive.
	 */
	public const ERROR_RULES_UNSETTLED = 'rules_unsettled';

	/**
	 * Reported in `unpriced` when two rules set different prices on one target.
	 *
	 * Not an error code: the line still resolves and the authored price still
	 * applies to everything else. It is the same signal `per_char` on a
	 * non-typed option produces — *"this build could not price part of this
	 * configuration, and here is what"* — so a merchant is told rather than a
	 * customer charged an amount nobody chose.
	 */
	public const UNPRICED_RULE_CONFLICT = 'rule_price_conflict';

	/**
	 * A rule target naming one value, as the cloud's `RuleTargetType` spells it.
	 *
	 * ✏️ **`option` and `group` were constants here too, and are gone.** Once
	 * `index_containment()` mapped a value to no options, nothing needed to ask
	 * *"is this target an option or a group?"* — the map answers it structurally,
	 * and reading the type as well was a second mechanism for one fact. Removing
	 * it changed no test; removing the map broke two.
	 *
	 * This one survives because `hidden_values()` asks the opposite question, and
	 * the map cannot answer it: a value target maps to nothing precisely so it
	 * clears no answer, which is also why it cannot be recognised from the map.
	 */
	private const TARGET_VALUE = 'value';

	/**
	 * A flat amount in minor units, added per chosen value.
	 *
	 * The cloud's schema publishes five price types -- `fixed`, `percentage`,
	 * `per_unit`, `per_char`, `tiered`. Phase 11 implemented `fixed`; M16.1 added
	 * `percentage`. The remaining three are still recorded as unpriced.
	 *
	 * Named as constants so each comparison reads as a deliberate scope boundary
	 * rather than a string literal somebody might widen without noticing what
	 * else must change.
	 */
	private const PRICE_TYPE_FIXED = 'fixed';

	/**
	 * A percentage of the product's own base price. See M16.1.
	 */
	private const PRICE_TYPE_PERCENTAGE = 'percentage';

	/**
	 * An amount per character typed, beyond an allowance. See M16.2.
	 *
	 * The only type `PRICING-SPEC.md` defines at the **option** level: a text
	 * field has no values, so there is no value row to carry a price.
	 */
	private const PRICE_TYPE_PER_CHAR = 'per_char';

	/**
	 * An amount per unit of a quantity the customer supplied. See M16.2.
	 *
	 * Option-level like `per_char`, and for the same reason: the number types
	 * have no values, so there is no value row to carry a `price_config`.
	 */
	private const PRICE_TYPE_PER_UNIT = 'per_unit';

	/**
	 * An amount per unit, chosen by the bracket the quantity falls in. See M16.3.
	 *
	 * `per_unit` with the amount looked up rather than fixed, so it lives where
	 * `per_unit` does: on the options that produce a quantity.
	 */
	private const PRICE_TYPE_TIERED = 'tiered';

	/**
	 * Every price type `delta_for()` charges, for callers that must report it.
	 *
	 * Three places used to state this independently -- this evaluator, the cache
	 * scanner's warning, and the cart logger's `implemented` field -- and M16.1
	 * had to edit all three. Two of them were plain string literals, so widening
	 * the evaluator alone would have left the admin notice calling a correctly
	 * charged percentage unpriceable.
	 *
	 * Public because those callers are outside `Engine\`, and constant rather
	 * than derived because the dispatch is a series of `if`s, not a table -- a
	 * getter reading the branches back would be the same duplication with more
	 * indirection. `UnpricedTypesTest` asserts the branches and this list agree.
	 *
	 * @var array<string>
	 */
	public const PRICED_TYPES = array(
		self::PRICE_TYPE_FIXED,
		self::PRICE_TYPE_PERCENTAGE,
		self::PRICE_TYPE_PER_CHAR,
		self::PRICE_TYPE_PER_UNIT,
		self::PRICE_TYPE_TIERED,
	);

	/**
	 * The price types this build charges on a **value**.
	 *
	 * `PRICING-SPEC.md` §2: a value's `price_config` may be `fixed`,
	 * `percentage`, `per_unit` or `tiered`. `per_char` is defined at the option
	 * level only, and `delta_for()` does not implement it -- so a `per_char` on a
	 * value contributes nothing and is reported.
	 *
	 * Separate from `PRICED_TYPES` because "does this build charge the type" and
	 * "does this build charge it **here**" are different questions, and
	 * `Config\Repository`'s cache scanner asks the second one. Measured with only
	 * the flat list: a `per_char` on a value was treated as priced at publish
	 * time -- no notice -- and reported as unpriced at runtime. Two answers to
	 * one question, which is exactly what the scanner exists to prevent.
	 *
	 * @var array<string>
	 */
	public const VALUE_PRICED_TYPES = array( self::PRICE_TYPE_FIXED, self::PRICE_TYPE_PERCENTAGE );

	/**
	 * The price types this build charges on an **option**.
	 *
	 * The complement of `VALUE_PRICED_TYPES`. `per_char` is the only type
	 * `PRICING-SPEC.md` defines at the option level, because a text field has no
	 * values to carry a `price_config`.
	 *
	 * @var array<string>
	 */
	public const OPTION_PRICED_TYPES = array(
		self::PRICE_TYPE_PER_CHAR,
		self::PRICE_TYPE_PER_UNIT,
		self::PRICE_TYPE_TIERED,
	);

	/**
	 * Resolve selections against a product's option sets.
	 *
	 * @param array<int, array<string, mixed>> $option_sets Sets assigned to this product.
	 * @param array<string, mixed>             $selections  Raw, untrusted selections keyed by option id.
	 * @param int                              $base_minor  The product's own price, in minor units.
	 * @param ?string                          $today       Today in the **store's** timezone as
	 *                                                      `Y-m-d`, or null.
	 *
	 * 🔴 **The engine has no clock, and this is why.** `lead_time_days` and
	 * `max_advance_days` are relative to *today*, and "today" is a question about
	 * the merchant's timezone that a pure function cannot answer — a workshop in
	 * Auckland and one in Los Angeles disagree for twenty-one hours a day.
	 *
	 * Passed in rather than read here, so the engine stays deterministic and
	 * testable, and so the answer comes from `wp_date()` — WordPress already
	 * knows the store's timezone, and publishing a second copy in the config
	 * document would be a copy that can drift.
	 *
	 * ⚠️ **Null means the two relative rules do not apply.** Not "today is
	 * epoch": a caller with no clock must not silently refuse every date a
	 * merchant's lead time would have allowed. The four absolute rules —
	 * `min_date`, `max_date`, `blackout_dates`, `allowed_weekdays` — need no
	 * clock and always apply.
	 *
	 * @return Result Ok with `array{deltas, resolved, total_minor, unpriced, labels, set_ids}`,
	 *                where `deltas` is keyed by option id and summed across that
	 *                option's chosen values (ADR-061), or errors.
	 */
	public static function resolve(
		array $option_sets,
		array $selections,
		int $base_minor = 0,
		?string $today = null
	): Result {
		$options = self::index_options( $option_sets );
		$errors  = array();
		$deltas  = array();
		$chosen  = array();

		/*
		 * 🔴 **Rules are evaluated BEFORE a single selection is validated, and
		 * the order is the whole point of this stage.**
		 *
		 * Whether a submitted value is legal *depends on* the rule outcome: an
		 * option a rule has hidden must refuse the value the customer posted for
		 * it, and an option a rule has hidden cannot be missing-and-required.
		 * Validating first and consulting rules afterwards would mean deciding
		 * legality against a page that no longer exists.
		 *
		 * ⚠️ **Evaluated from the selections as posted**, not from what survives
		 * validation. A condition reading an answer that later fails its own
		 * validation still fired on the page the customer saw, and the two runs
		 * of this resolver (`AddToCartValidator`, then `CartItemData::attach()`)
		 * must agree — so the input to the evaluator has to be the request, which
		 * is identical across both, rather than a partial result, which is not.
		 * ADR-051 records why that matters.
		 */
		$rules       = self::index_rules( $option_sets );
		$containment = self::index_containment( $option_sets );
		$evaluation  = RuleEvaluator::evaluate( $rules, self::rule_answers( $options, $selections ), $containment );

		if ( null !== $evaluation['refused'] ) {
			return Result::error( self::ERROR_RULES_UNSETTLED );
		}

		$rule_hidden  = self::hidden_options( $evaluation['states'], $containment );
		$hidden_value = self::hidden_values( $rules, $evaluation['states'] );

		/*
		 * Grams a selection adds to the line, summed the same way deltas are
		 * (M16.8). Only a *chosen value* can carry one — a typed engraving or an
		 * uploaded file has no weight of its own — so this accumulates in the
		 * choice branch alone.
		 */
		$weight_grams = 0;
		$sku_suffixes = array();
		$unpriced     = array();
		$labels       = array();
		$set_ids      = array();

		// Bytes of customer-supplied text accepted so far, across every option.
		$text_bytes = 0;

		/*
		 * Selections are walked first, so an option id the product does not have
		 * is reported rather than ignored. Ignoring unknown keys would let a
		 * request carry another product's options -- or another tenant's --
		 * without complaint, and "it had no effect on the price" is not the same
		 * guarantee as "it was refused".
		 */
		foreach ( $selections as $option_id => $raw_value ) {
			$option_id = (string) $option_id;

			if ( ! isset( $options[ $option_id ] ) ) {
				$errors[] = array(
					'code'   => self::ERROR_UNKNOWN_OPTION,
					'field'  => $option_id,
					'params' => array(),
				);

				continue;
			}

			/*
			 * 🔴 **Checked immediately after "does this option exist", because
			 * it is the same question one step further on.** The product has the
			 * option; the customer's other answers took it off the page. M17.4
			 * requires this to fail validation rather than be dropped — see
			 * `ERROR_HIDDEN_BY_RULE` for why a silent drop is the weaker
			 * guarantee.
			 *
			 * Before the per-type branches, so a forged value for a hidden
			 * option is refused for being hidden rather than for failing a
			 * pattern it should never have been measured against.
			 */
			if ( isset( $rule_hidden[ $option_id ] ) ) {
				$errors[] = array(
					'code'   => self::ERROR_HIDDEN_BY_RULE,
					'field'  => $option_id,
					'params' => array(),
				);

				continue;
			}

			/*
			 * An array where a scalar belongs is a probe, not a typo: it is the
			 * shape that makes a naive `(string)` cast emit a notice and coerce
			 * to "Array". Phase 4 confirmed WooCommerce repels it; this refuses
			 * it explicitly rather than relying on that.
			 *
			 * 🔴 **A multi-select posts an array, and only a multi-select may.**
			 *
			 * `cardinality: many` is the merchant's declaration that this option
			 * takes several answers, and `checkbox.php` names its inputs `[]`
			 * only for that case. An array arriving for any other option is the
			 * probe this gate was written for, and is still refused.
			 *
			 * ⚠️ **Normalised to a list here, once**, so every branch below reads
			 * one shape. The alternative — each branch asking "array or scalar?"
			 * — is the same question answered in six places, which is how two of
			 * them come to answer it differently.
			 */
			$is_many = self::takes_many( $options[ $option_id ] );

			if ( $is_many && is_array( $raw_value ) ) {
				$chosen_keys = array_values( $raw_value );
			} elseif ( is_scalar( $raw_value ) ) {
				$chosen_keys = array( $raw_value );
			} else {
				$errors[] = array(
					'code'   => self::ERROR_NOT_SCALAR,
					'field'  => $option_id,
					'params' => array(),
				);

				continue;
			}

			/*
			 * 🔴 **Every entry must itself be a scalar.** `[['nested']]` is the
			 * same probe one level down, and an array reaching `(string)` below
			 * emits a notice and coerces to "Array" — which would then be looked
			 * up as a value key and reported as merely unknown.
			 */
			foreach ( $chosen_keys as $chosen_key ) {
				if ( ! is_scalar( $chosen_key ) ) {
					$errors[] = array(
						'code'   => self::ERROR_NOT_SCALAR,
						'field'  => $option_id,
						'params' => array(),
					);

					continue 2;
				}
			}

			/*
			 * ⚠️ **An empty array is an unanswered option, not an error.**
			 * A multi-select with nothing ticked posts nothing at all in a
			 * browser; an empty array is what a script or a stale payload sends,
			 * and treating it as absent is what makes the two agree. The required
			 * pass then reports it if the merchant demanded an answer.
			 */
			if ( array() === $chosen_keys ) {
				continue;
			}

			/*
			 * 🔴 **Duplicates collapse, and the first occurrence wins.**
			 *
			 * `[red, red]` is one choice sent twice — a double-submit or a forged
			 * payload — and charging for it twice is the shape a customer
			 * disputes. `array_unique` over the *string* forms, because `'1'` and
			 * `1` are the same answer to a form.
			 */
			$seen         = array();
			$deduplicated = array();

			foreach ( $chosen_keys as $chosen_key ) {
				$as_string = (string) $chosen_key;

				if ( isset( $seen[ $as_string ] ) ) {
					continue;
				}

				$seen[ $as_string ] = true;
				$deduplicated[]     = $chosen_key;
			}

			$chosen_keys = $deduplicated;
			$raw_value   = $chosen_keys[0];

			/*
			 * 🔴 **Text is the first value a *customer* supplies, and that
			 * changes what "trusted" means downstream.**
			 *
			 * Every value before this one had to match a `value_key` the merchant
			 * authored, so `AddToCartRequest`'s comment -- *"nothing here is
			 * trusted"* -- was made true by this lookup: an unknown value was
			 * refused, and only merchant-authored labels ever reached a cart or
			 * an order. A text option has no value set, so that guarantee is
			 * gone the moment one is registered.
			 *
			 * Sanitised **here**, where the type is known, rather than in
			 * `AddToCartRequest` -- which deliberately only settles *where* to
			 * look and cannot tell a typed engraving from a chosen key.
			 *
			 * ⚠️ **Not `sanitize_text_field()`.** `bin/check-architecture.sh`
			 * forbids WordPress calls in `src/Engine/` — the engine is a port of
			 * TypeScript logic that must run against shared fixtures with no
			 * WordPress bootstrap, and one call breaks that. `clean_text()`
			 * reimplements the part that matters, in plain PHP the TS side can
			 * mirror.
			 *
			 * It is not a substitute for escaping at output, which `CartDisplay`
			 * and `OrderLineItem` now also do: this stops the value being
			 * *stored* dangerous, and that stops it being *rendered* dangerous
			 * if it ever is.
			 */
			if ( self::is_hidden( $options[ $option_id ] ) ) {
				/*
				 * 🔴 **What the customer posted is discarded entirely.**
				 *
				 * A hidden field is hidden from the *page*, not from the
				 * customer: anyone with developer tools can post whatever they
				 * like. Measured before this branch existed — a naive
				 * implementation stored `FORGED-BY-CUSTOMER` over the merchant's
				 * own `campaign-a`.
				 *
				 * The merchant's `default_value` is the whole point of the type:
				 * a batch code, a fulfilment route, a campaign tag — data *about*
				 * the order rather than a choice within it. Reading anything from
				 * the request would make it exactly as trustworthy as a URL
				 * parameter.
				 *
				 * ⚠️ Sanitised anyway. The value is merchant-authored and reaches
				 * a cart row and an order line, and `clean_text()` is what every
				 * other stored string goes through.
				 */
				$configured = self::clean_text(
					(string) ( $options[ $option_id ]['default_value'] ?? '' )
				);

				if ( '' === $configured ) {
					// A hidden field with nothing configured contributes nothing,
					// rather than an empty line on the order.
					continue;
				}

				$labels[ $option_id ] = array(
					'option' => self::option_label( $options[ $option_id ] ),
					'value'  => $configured,
				);

				$set_id = (string) ( $options[ $option_id ]['__set_id'] ?? '' );

				if ( '' !== $set_id && ! in_array( $set_id, $set_ids, true ) ) {
					$set_ids[] = $set_id;
				}

				$chosen[ $option_id ] = $configured;

				/*
				 * 🔴 **One entry per accepted option, always.**
				 *
				 * `CartItemPayload::trusted_deltas()` refuses the whole freeze
				 * when any resolved option has no delta, so an option that
				 * records nothing here discards the freeze for the entire line
				 * and makes it price live.
				 *
				 * Measured when only the value branch recorded a delta: a plain
				 * gift-message field beside a 5.00 option quoted 85.00, the
				 * merchant republished at 50.00, and the customer was charged
				 * **130.00** -- M12.4's price freeze silently defeated by a free
				 * text field.
				 *
				 * ⚠️ **The mechanism changed at M18.2; the obligation did not.**
				 * `deltas` used to be a positional list that `CartItemData`
				 * paired against `resolved` by index, so a missing entry
				 * *misaligned* every later option. ADR-061 keyed it by option id
				 * instead, which removes the misalignment -- but a missing entry
				 * still costs the line its freeze.
				 *
				 * Zero because these options price at the OPTION level, and this
				 * build charges that only for the types in `PRICED_TYPES`; what it
				 * cannot charge, `option_delta()` records for the merchant. A
				 * delta is recorded either way, because every accepted option
				 * must appear in the map and an absent entry is not a zero.
				 */
				$deltas[ $option_id ] = self::option_delta(
					$options[ $option_id ],
					$chosen[ $option_id ],
					$unpriced,
					self::set_price_for( $options[ $option_id ], $evaluation['states'], $option_id, '', $unpriced )
				);

				continue;
			}

			if ( self::is_file( $options[ $option_id ] ) ) {
				/*
				 * 🔴 **Without this branch a file option could not be bought at
				 * all.** A `file` kind matched none of the type branches, so the
				 * token fell through to the merchant's value set — which a file
				 * option does not have — and every upload was refused with
				 * `unknown_value`. The upload subsystem was complete and correct
				 * and the customer still could not add the product to the cart.
				 *
				 * ⚠️ **Shape only, never existence.** ADR-040 puts token
				 * verification at add-to-cart, once, and never in `Engine/`:
				 * this class is a pure port that runs against shared fixtures
				 * with no WordPress and no database, and asking whether a row
				 * exists would need both. What is checkable here is that the
				 * value is a token *shape* rather than something a customer
				 * typed, and that is what stops an arbitrary string being
				 * recorded as artwork.
				 */
				$candidate = trim( (string) $raw_value );

				if ( '' === $candidate ) {
					// "Not answered", as an empty text field is. The required
					// check below catches it when the merchant demands a file.
					continue;
				}

				/*
				 * ⚠️ **`\A`/`\z`, not `^`/`$`.** PHP's `$` matches before a
				 * trailing newline, so the anchored-looking form accepts one —
				 * and `Upload\UploadTokens` documents what that cost. The value
				 * is trimmed above, so this is belt and braces; the two
				 * definitions of a token must agree regardless.
				 */
				if ( 1 !== preg_match( '/\A[0-9a-f]{64}\z/', $candidate ) ) {
					$errors[] = array(
						'code'   => self::ERROR_UNKNOWN_VALUE,
						'field'  => $option_id,
						'params' => array(),
					);

					continue;
				}

				$labels[ $option_id ] = array(
					'option' => self::option_label( $options[ $option_id ] ),
					'value'  => $candidate,
				);

				$set_id = (string) ( $options[ $option_id ]['__set_id'] ?? '' );

				if ( '' !== $set_id && ! in_array( $set_id, $set_ids, true ) ) {
					$set_ids[] = $set_id;
				}

				$chosen[ $option_id ] = $candidate;

				/*
				 * 🔴 **One entry per accepted option, always.**
				 *
				 * `CartItemPayload::trusted_deltas()` refuses the whole freeze
				 * when any resolved option has no delta, so an option that
				 * records nothing here discards the freeze for the entire line
				 * and makes it price live.
				 *
				 * Measured when only the value branch recorded a delta: a plain
				 * gift-message field beside a 5.00 option quoted 85.00, the
				 * merchant republished at 50.00, and the customer was charged
				 * **130.00** -- M12.4's price freeze silently defeated by a free
				 * text field.
				 *
				 * ⚠️ **The mechanism changed at M18.2; the obligation did not.**
				 * `deltas` used to be a positional list that `CartItemData`
				 * paired against `resolved` by index, so a missing entry
				 * *misaligned* every later option. ADR-061 keyed it by option id
				 * instead, which removes the misalignment -- but a missing entry
				 * still costs the line its freeze.
				 *
				 * Zero because these options price at the OPTION level, and this
				 * build charges that only for the types in `PRICED_TYPES`; what it
				 * cannot charge, `option_delta()` records for the merchant. A
				 * delta is recorded either way, because every accepted option
				 * must appear in the map and an absent entry is not a zero.
				 */
				$deltas[ $option_id ] = self::option_delta(
					$options[ $option_id ],
					$chosen[ $option_id ],
					$unpriced,
					self::set_price_for( $options[ $option_id ], $evaluation['states'], $option_id, '', $unpriced )
				);

				continue;
			}

			if ( self::is_free_text( $options[ $option_id ] ) ) {
				$text = self::clean_text( (string) $raw_value, self::is_multiline( $options[ $option_id ] ) );

				if ( '' === $text ) {
					/*
					 * An empty string is "not answered", not "answered with
					 * nothing" -- a required text option must fail the same way
					 * an unselected radio does, and an optional one contributes
					 * no line rather than an empty one.
					 */
					continue;
				}

				/*
				 * 🔴 **Measured after sanitising, and refused rather than cut.**
				 *
				 * `Text::measure()` is the one normative count (M11.1a) — the
				 * same function behind the customer's counter and, in M16.1,
				 * `per_char` pricing. Counting anything else here is how
				 * `optionia-app` came to charge five characters for what its
				 * counter showed as four.
				 *
				 * **After** `clean_text()`, because that is the string actually
				 * stored: measuring what the customer typed would refuse an
				 * answer whose stored form fits, on the strength of markup that
				 * was removed.
				 *
				 * ⚠️ `max_length` is enforced **here and in the browser both** —
				 * `maxlength` on the input is a courtesy that stops the 21st
				 * keystroke, and this is the truth (AC4). A request that skips
				 * the page entirely still has to be refused.
				 */

				/*
				 * `min_length` first, and measured on the same sanitised string.
				 *
				 * An engraving with a minimum is a workshop saying "this is not
				 * worth setting up for one letter". The customer is over the
				 * line, not missing a field, so `ERROR_REQUIRED` would be the
				 * wrong thing to tell them.
				 *
				 * Checked **before** `max_length`: a value cannot be both, and
				 * reporting the shortfall is more actionable when a merchant has
				 * set a narrow window.
				 */
				$minimum = self::min_length( $options[ $option_id ] );

				if ( $minimum > 0 && Text::measure( $text ) < $minimum ) {
					$errors[] = array(
						'code'   => self::ERROR_TOO_SHORT,
						'field'  => $option_id,
						'params' => array(
							'min'    => $minimum,
							'actual' => Text::measure( $text ),
						),
					);

					continue;
				}

				$limit = self::max_length( $options[ $option_id ] );

				if ( Text::measure( $text ) > $limit ) {
					$errors[] = array(
						'code'   => self::ERROR_TOO_LONG,
						'field'  => $option_id,
						'params' => array(
							'max'    => $limit,
							'actual' => Text::measure( $text ),
						),
					);

					continue;
				}

				$rule = self::text_rule_violation( $options[ $option_id ], $text );

				if ( null !== $rule ) {
					$errors[] = array(
						'code'   => $rule['code'],
						'field'  => $option_id,
						'params' => $rule['params'],
					);

					continue;
				}

				/*
				 * The per-request budget, checked after the per-option limit.
				 *
				 * Order matters: a customer who overran *their own* field should
				 * be told that, not handed a whole-request error they cannot act
				 * on. This only fires when every individual field was acceptable
				 * and the total still is not.
				 */
				$text_bytes += strlen( $text );

				if ( $text_bytes > self::MAX_TEXT_BYTES ) {
					$errors[] = array(
						'code'   => self::ERROR_TOO_MUCH_TEXT,
						'field'  => $option_id,
						'params' => array( 'max_bytes' => self::MAX_TEXT_BYTES ),
					);

					continue;
				}

				$labels[ $option_id ] = array(
					'option' => self::option_label( $options[ $option_id ] ),
					'value'  => $text,
				);

				$set_id = (string) ( $options[ $option_id ]['__set_id'] ?? '' );

				if ( '' !== $set_id && ! in_array( $set_id, $set_ids, true ) ) {
					$set_ids[] = $set_id;
				}

				$chosen[ $option_id ] = $text;

				/*
				 * 🔴 **One entry per accepted option, always.**
				 *
				 * `CartItemPayload::trusted_deltas()` refuses the whole freeze
				 * when any resolved option has no delta, so an option that
				 * records nothing here discards the freeze for the entire line
				 * and makes it price live.
				 *
				 * Measured when only the value branch recorded a delta: a plain
				 * gift-message field beside a 5.00 option quoted 85.00, the
				 * merchant republished at 50.00, and the customer was charged
				 * **130.00** -- M12.4's price freeze silently defeated by a free
				 * text field.
				 *
				 * ⚠️ **The mechanism changed at M18.2; the obligation did not.**
				 * `deltas` used to be a positional list that `CartItemData`
				 * paired against `resolved` by index, so a missing entry
				 * *misaligned* every later option. ADR-061 keyed it by option id
				 * instead, which removes the misalignment -- but a missing entry
				 * still costs the line its freeze.
				 *
				 * Zero because these options price at the OPTION level, and this
				 * build charges that only for the types in `PRICED_TYPES`; what it
				 * cannot charge, `option_delta()` records for the merchant. A
				 * delta is recorded either way, because every accepted option
				 * must appear in the map and an absent entry is not a zero.
				 */
				$deltas[ $option_id ] = self::option_delta(
					$options[ $option_id ],
					$chosen[ $option_id ],
					$unpriced,
					self::set_price_for( $options[ $option_id ], $evaluation['states'], $option_id, '', $unpriced )
				);

				/*
				 * 🔴 **Option-level pricing has to be reported, even though this
				 * phase cannot charge it.**
				 *
				 * The value branch below runs every selection through
				 * `delta_for()`, which records any type it cannot price into
				 * `$unpriced` — a list `CartTotals` warns on and
				 * `UnpricedTypesNotice` shows the merchant. That mechanism exists
				 * because a 50% surcharge once charged nothing and told no one,
				 * losing 40.00 per unit in silence.
				 *
				 * Text reaches none of it. `delta_for()` takes a *value*, and a
				 * text option prices at the **option** level (`per_char`) with no
				 * value row to carry it — so without this, a merchant could
				 * configure `per_char`, publish, and sell engraving for free with
				 * nothing anywhere saying so. Strictly worse than the case the
				 * safety net was built for, because that at least appeared in the
				 * notice.
				 *
				 * `per_char` arithmetic itself is **M16.2's**, not this phase's:
				 * `PRICING-SPEC.md` §2 assigns it there, and Phase 16 depends on
				 * Phase 14 delivering the types that use it. Reporting is what
				 * Phase 14 owes, and it is what makes the gap visible instead of
				 * silent.
				 */

				continue;
			}

			if ( self::is_date( $options[ $option_id ] ) ) {
				/*
				 * 🔴 **A date is stored as `Y-m-d`, never as the customer typed it.**
				 *
				 * `<input type="date">` posts ISO already, but a reorder payload
				 * or a hand-made request need not — and `05/09/2026` is the fifth
				 * of September in London and the ninth of May in New York. One
				 * canonical form is the only way a workshop reads the same day
				 * the customer picked.
				 */
				$raw_date = trim( (string) $raw_value );

				if ( '' === $raw_date ) {
					continue;
				}

				$date = self::parse_date( $raw_date, $options[ $option_id ] );

				if ( null === $date ) {
					$errors[] = array(
						'code'   => self::ERROR_NOT_A_DATE,
						'field'  => $option_id,
						'params' => array(),
					);

					continue;
				}

				$violation = self::date_violation( $options[ $option_id ], $date, $today );

				if ( null !== $violation ) {
					$errors[] = array(
						'code'   => $violation['code'],
						'field'  => $option_id,
						'params' => $violation['params'],
					);

					continue;
				}

				$labels[ $option_id ] = array(
					'option' => self::option_label( $options[ $option_id ] ),
					'value'  => $date,
				);

				$set_id = (string) ( $options[ $option_id ]['__set_id'] ?? '' );

				if ( '' !== $set_id && ! in_array( $set_id, $set_ids, true ) ) {
					$set_ids[] = $set_id;
				}

				$chosen[ $option_id ] = $date;

				/*
				 * 🔴 **One entry per accepted option, always.**
				 *
				 * `CartItemPayload::trusted_deltas()` refuses the whole freeze
				 * when any resolved option has no delta, so an option that
				 * records nothing here discards the freeze for the entire line
				 * and makes it price live.
				 *
				 * Measured when only the value branch recorded a delta: a plain
				 * gift-message field beside a 5.00 option quoted 85.00, the
				 * merchant republished at 50.00, and the customer was charged
				 * **130.00** -- M12.4's price freeze silently defeated by a free
				 * text field.
				 *
				 * ⚠️ **The mechanism changed at M18.2; the obligation did not.**
				 * `deltas` used to be a positional list that `CartItemData`
				 * paired against `resolved` by index, so a missing entry
				 * *misaligned* every later option. ADR-061 keyed it by option id
				 * instead, which removes the misalignment -- but a missing entry
				 * still costs the line its freeze.
				 *
				 * Zero because these options price at the OPTION level, and this
				 * build charges that only for the types in `PRICED_TYPES`; what it
				 * cannot charge, `option_delta()` records for the merchant. A
				 * delta is recorded either way, because every accepted option
				 * must appear in the map and an absent entry is not a zero.
				 */
				$deltas[ $option_id ] = self::option_delta(
					$options[ $option_id ],
					$chosen[ $option_id ],
					$unpriced,
					self::set_price_for( $options[ $option_id ], $evaluation['states'], $option_id, '', $unpriced )
				);

				continue;
			}

			if ( self::is_number( $options[ $option_id ] ) ) {
				/*
				 * 🔴 **A number is not a short piece of text.**
				 *
				 * It has an ordering, so `min` and `max` mean something
				 * `min_length` cannot express, and `"007"`, `"7"` and `"7.0"` are
				 * the same quantity written three ways. Storing the customer's
				 * spelling would put three different strings on three otherwise
				 * identical orders and break `CartItemKey`'s grouping.
				 *
				 * So the value is parsed, validated, and stored **canonically**.
				 */
				$raw_number = trim( (string) $raw_value );

				if ( '' === $raw_number ) {
					// "Not answered", exactly as an empty text field is. The
					// required check below catches it when it matters.
					continue;
				}

				$number = self::parse_number( $raw_number );

				if ( null === $number ) {
					$errors[] = array(
						'code'   => self::ERROR_NOT_A_NUMBER,
						'field'  => $option_id,
						'params' => array(),
					);

					continue;
				}

				$violation = self::number_violation( $options[ $option_id ], $number );

				if ( null !== $violation ) {
					$errors[] = array(
						'code'   => $violation['code'],
						'field'  => $option_id,
						'params' => $violation['params'],
					);

					continue;
				}

				$canonical = self::format_number( $number );

				$labels[ $option_id ] = array(
					'option' => self::option_label( $options[ $option_id ] ),
					'value'  => $canonical,
				);

				$set_id = (string) ( $options[ $option_id ]['__set_id'] ?? '' );

				if ( '' !== $set_id && ! in_array( $set_id, $set_ids, true ) ) {
					$set_ids[] = $set_id;
				}

				$chosen[ $option_id ] = $canonical;

				/*
				 * 🔴 **One entry per accepted option, always.**
				 *
				 * `CartItemPayload::trusted_deltas()` refuses the whole freeze
				 * when any resolved option has no delta, so an option that
				 * records nothing here discards the freeze for the entire line
				 * and makes it price live.
				 *
				 * Measured when only the value branch recorded a delta: a plain
				 * gift-message field beside a 5.00 option quoted 85.00, the
				 * merchant republished at 50.00, and the customer was charged
				 * **130.00** -- M12.4's price freeze silently defeated by a free
				 * text field.
				 *
				 * ⚠️ **The mechanism changed at M18.2; the obligation did not.**
				 * `deltas` used to be a positional list that `CartItemData`
				 * paired against `resolved` by index, so a missing entry
				 * *misaligned* every later option. ADR-061 keyed it by option id
				 * instead, which removes the misalignment -- but a missing entry
				 * still costs the line its freeze.
				 *
				 * Zero because these options price at the OPTION level, and this
				 * build charges that only for the types in `PRICED_TYPES`; what it
				 * cannot charge, `option_delta()` records for the merchant. A
				 * delta is recorded either way, because every accepted option
				 * must appear in the map and an absent entry is not a zero.
				 */
				$deltas[ $option_id ] = self::option_delta(
					$options[ $option_id ],
					$chosen[ $option_id ],
					$unpriced,
					self::set_price_for( $options[ $option_id ], $evaluation['states'], $option_id, '', $unpriced )
				);

				// Same reporting obligation as text: `per_unit` prices at the
				// option level and this phase cannot charge it.

				continue;
			}

			$values = self::index_values( $options[ $option_id ] );

			/*
			 * 🔴 **Every chosen key is validated before ANY is priced.**
			 *
			 * A multi-select carrying one good key and one bad one must be
			 * refused whole, not half-accepted — a line that priced `red` and
			 * silently dropped `blue` is the shape M11.5 exists to prevent, and
			 * the customer would see a total they cannot account for.
			 */
			$unknown = false;

			foreach ( $chosen_keys as $chosen_key ) {
				if ( ! isset( $values[ (string) $chosen_key ] ) ) {
					$unknown = true;

					break;
				}
			}

			if ( $unknown ) {
				$errors[] = array(
					'code'   => self::ERROR_UNKNOWN_VALUE,
					'field'  => $option_id,
					'params' => array(),
				);

				continue;
			}

			/*
			 * 🔴 **Sorted into the MERCHANT'S order, not the customer's.**
			 *
			 * WooCommerce derives a cart line's key by hashing `cart_item_data`,
			 * so two customers reaching the same visible configuration must
			 * produce byte-identical payloads. Measured before this:
			 * `["red","blue"]` and `["blue","red"]` hash differently, so ticking
			 * the same two boxes in a different order split one product into two
			 * cart lines.
			 *
			 * ⚠️ **`ksort()` in `CartItemData` does not cover this.** That sorts
			 * option *ids* — the outer map — and says nothing about the values
			 * within one option. Normalised here instead, because this is where
			 * the order originates; fixing it two hops downstream would leave
			 * `resolved` and the order meta disagreeing with the cart key.
			 *
			 * The merchant's authored order is the meaningful one — `index_values`
			 * preserves it as key order — so a line reads the way the form does
			 * rather than the way a customer happened to click.
			 */
			if ( $is_many && count( $chosen_keys ) > 1 ) {
				$authored    = array_keys( $values );
				$chosen_keys = array_values(
					array_filter(
						$authored,
						static function ( $key ) use ( $chosen_keys ): bool {
							return in_array( (string) $key, array_map( 'strval', $chosen_keys ), true );
						}
					)
				);

				$raw_value = $chosen_keys[0];
			}

			$value_key = (string) $raw_value;

			if ( ! isset( $values[ $value_key ] ) ) {
				$errors[] = array(
					'code'   => self::ERROR_UNKNOWN_VALUE,
					'field'  => $option_id,
					'params' => array(),
				);

				continue;
			}

			/*
			 * 🔴 **A rule-hidden value is a value the option no longer offers.**
			 * Refused as `ERROR_HIDDEN_BY_RULE` rather than `ERROR_UNKNOWN_VALUE`
			 * for the same reason the option-level check is separate: the key is
			 * real and the merchant authored it, and telling a customer their
			 * choice does not exist would send them looking for a typo they did
			 * not make.
			 *
			 * ⚠️ **Keyed by the value's `id`, not its `value_key`.** A rule
			 * targets an id, and `value_key` is unique only within one option —
			 * matching on it would let a rule hiding `large` in one option hide
			 * `large` in every other. The published value carries an `id` from
			 * M17.8 for exactly this lookup.
			 *
			 * ⚠️ **Checked for EVERY chosen value, not just the first.** A
			 * multi-select may carry a rule-hidden value in any position, and a
			 * guard reading `$chosen_keys[0]` would accept a payload whose
			 * second entry names a choice the customer's own answers removed.
			 */
			$hit_hidden = false;

			foreach ( $chosen_keys as $chosen_key ) {
				$candidate    = $values[ (string) $chosen_key ];
				$candidate_id = isset( $candidate['id'] ) && is_scalar( $candidate['id'] )
					? (string) $candidate['id']
					: '';

				if ( '' !== $candidate_id && isset( $hidden_value[ $candidate_id ] ) ) {
					$hit_hidden = true;

					break;
				}
			}

			if ( $hit_hidden ) {
				$errors[] = array(
					'code'   => self::ERROR_HIDDEN_BY_RULE,
					'field'  => $option_id,
					'params' => array(),
				);

				continue;
			}

			/*
			 * 🔴 **`deltas`, `labels` and `sku_suffixes` all key on the option.**
			 *
			 * They did not always agree. Until M18.2 `deltas` was a positional
			 * list — one entry per chosen *value* — which `CartItemData` paired
			 * against `resolved` by index. A multi-select made that pairing
			 * unsatisfiable, and 16c's defect turned on exactly that mismatch.
			 * ADR-061 keyed it, so all three now answer the same question the
			 * same way.
			 *
			 * ⚠️ **Several values become several entries *within* one option,
			 * never several options.** The cart line, the order meta and the
			 * fulfilment output each name an option once.
			 */
			$chosen_labels   = array();
			$chosen_suffixes = array();

			/*
			 * 🔴 **One entry per OPTION, summed across its chosen values.**
			 *
			 * ADR-061. A multi-select contributes several prices to a single
			 * cart row, and every consumer wants that row's total: `CartTotals`
			 * sums them, `CartDisplay` renders one row per option with one price
			 * beside it, `OrderLineItem` writes one meta entry per option. None
			 * asks what the second chosen value cost.
			 *
			 * ⚠️ **A summed int, not a per-value list, and the trust gate is
			 * why.** `CartItemPayload::frozen_deltas()` requires `is_int()` for
			 * every entry. Measured: `{"opt-a":300}` passes; `{"opt-a":[100,200]}`
			 * returns null — and a null freeze means **the line prices live**,
			 * which is the defect this stage exists to close.
			 */
			$option_total = 0;

			foreach ( $chosen_keys as $chosen_key ) {
				$key   = (string) $chosen_key;
				$value = $values[ $key ];

				/*
				 * ADR-049: a `set_price` rule **replaces** the value's own price
				 * rather than adding to it — see `set_price_for()` for why
				 * adding was rejected, and for the option-level case it refuses.
				 *
				 * Asked per value, because a rule may target one value of a
				 * multi-select and must not reprice its siblings.
				 */
				$ruled = self::set_price_for(
					$options[ $option_id ],
					$evaluation['states'],
					$option_id,
					isset( $value['id'] ) && is_scalar( $value['id'] ) ? (string) $value['id'] : '',
					$unpriced
				);

				if ( false !== $ruled ) {
					// A refused rule price contributes nothing; see `set_price_for()`.
					$option_total += null === $ruled
						? self::delta_for( $value, $base_minor, $unpriced )
						: $ruled;
				}

				$weight_grams += self::weight_for( $value );
				$suffix        = self::sku_suffix_for( $value );

				if ( '' !== $suffix ) {
					$chosen_suffixes[] = $suffix;
				}

				$chosen_labels[] = self::labels_for( $options[ $option_id ], $value );
			}

			if ( array() !== $chosen_suffixes ) {
				/*
				 * ⚠️ **Joined, not listed.** A SKU suffix is one string per
				 * option by the time it reaches an order line, and the caller
				 * concatenates them — see the note on `sku_suffixes` in the
				 * return. Several values give one suffix built from all of them,
				 * in the order the merchant authored the values.
				 */
				$sku_suffixes[ $option_id ] = implode( '', $chosen_suffixes );
			}

			/*
			 * The option's whole contribution, recorded once.
			 *
			 * ⚠️ **Assigned even when it is zero.** A free choice still has to
			 * appear in the map: `CartItemPayload::trusted_deltas()` refuses the
			 * entire freeze when any resolved option is missing a delta, so an
			 * omitted zero would discard the freeze for the *whole line* and
			 * price it live. An absent entry is not a zero.
			 */
			$deltas[ $option_id ] = $option_total;

			/*
			 * One label at `one`, a list at `many`. The cart and order renderers
			 * name an option once and print what was chosen for it, so the shape
			 * follows what they display rather than what the loop produced.
			 */
			$labels[ $option_id ] = $is_many ? $chosen_labels : $chosen_labels[0];
			$set_id               = (string) ( $options[ $option_id ]['__set_id'] ?? '' );

			if ( '' !== $set_id && ! in_array( $set_id, $set_ids, true ) ) {
				$set_ids[] = $set_id;
			}

			$chosen[ $option_id ] = $is_many ? array_map( 'strval', $chosen_keys ) : $value_key;
		}

		/*
		 * Required options are checked after resolution, against what was
		 * actually accepted -- not against what arrived. A selection that named a
		 * required option but failed on its value has already produced an error;
		 * counting it as "present" here would replace a precise message with a
		 * vaguer one, and counting it twice would report the same field twice.
		 */
		foreach ( $options as $option_id => $option ) {
			/*
			 * 🔴 **A hidden option is never required.** Requiring an answer to a
			 * question the customer cannot see is an unbuyable product: the form
			 * refuses, and the field it names is not on the page to fill in.
			 *
			 * Skipped before `is_required` is even read, because a rule can make
			 * an option required *and* another rule hide it — ADR-052 resolves
			 * that pair in one direction only, and this is it. Hidden wins,
			 * because the alternative is a dead end for the customer.
			 */
			if ( isset( $rule_hidden[ $option_id ] ) ) {
				continue;
			}

			/*
			 * 🔴 **A rule's answer replaces the merchant's, in both directions.**
			 * `is_required` is the authoring-time answer; `require` and
			 * `unrequire` are the runtime ones, and a rule that fired knows
			 * something the author did not — which other answers the customer
			 * gave.
			 *
			 * ⚠️ **`unrequire` must be able to lift an authored `is_required`,
			 * or it is an action that does nothing.** ADR-052 settles
			 * `require` against `unrequire` — restrictive wins, and the
			 * evaluator has already applied that — but it is silent on
			 * rule-versus-authoring. Read as: an option nobody wrote a rule
			 * about keeps the merchant's answer (`null`, the common case), and
			 * one a rule *did* fire on takes the rule's, because the merchant
			 * authored that rule too.
			 *
			 * 📌 Recorded as an open question for 17-11 rather than settled
			 * here: if the phase's exit audit disagrees, this line is where it
			 * changes.
			 */
			$ruled = $evaluation['states'][ $option_id ]['required'] ?? null;

			$required = null === $ruled ? ! empty( $option['is_required'] ) : $ruled;

			if ( ! $required || isset( $chosen[ $option_id ] ) ) {
				continue;
			}

			if ( self::already_reported( $errors, $option_id ) ) {
				continue;
			}

			$errors[] = array(
				'code'   => self::ERROR_REQUIRED,
				'field'  => $option_id,
				'params' => array(),
			);
		}

		if ( array() !== $errors ) {
			return Result::errors( $errors );
		}

		/*
		 * "Recompute price from cached config" -- M11.5's last clause, and the
		 * one that makes this the AC4 boundary rather than a form validator.
		 * Every amount in `$deltas` came from the cached configuration, keyed by
		 * a value the customer chose; nothing price-like in the request was read
		 * on the way here. `Pricing::sum_deltas()` applies the shared floor and
		 * the shared safe range, so the storefront and the cloud agree on the
		 * number by construction rather than by coincidence.
		 */
		try {
			$total = Pricing::sum_deltas( $base_minor, $deltas );
		} catch ( \InvalidArgumentException | \RangeException $e ) {
			unset( $e );

			/*
			 * Unreachable through the UI: the schema caps one amount at 1e9 and
			 * a set at 20,000 options, three orders of magnitude under the
			 * bound. Refused rather than trusted anyway, because "unreachable"
			 * is a property of today's schema and this is a security boundary.
			 */
			return Result::error( self::ERROR_UNPRICEABLE );
		}

		sort( $unpriced );

		return Result::ok(
			array(
				'deltas'             => $deltas,
				'resolved'           => $chosen,
				'total_minor'        => $total,
				'unpriced'           => $unpriced,
				'labels'             => $labels,
				'set_ids'            => $set_ids,

				/*
				 * 🔴 **Per unit, never multiplied by quantity.** WooCommerce's
				 * `WC_Cart::get_cart_contents_weight()` does
				 * `get_weight() * $values['quantity']` — the same shape as
				 * `WC_Cart_Totals` does for price — so a line of three
				 * "+8000g" tables must report `base + 8000`, not `base + 24000`.
				 * `bin/check-architecture.sh` scans the whole of `src/` for
				 * quantity arithmetic, so this is enforced rather than merely
				 * intended.
				 */
				'weight_delta_grams' => $weight_grams,

				/*
				 * Keyed by option id and NOT concatenated here.
				 *
				 * A separator is a presentation decision -- `-OAK-LG` or
				 * `_OAK_LG` -- and this file is a pure function shared with a
				 * TypeScript twin, held to fixtures. Joining here would bake one
				 * merchant's convention into the evaluator; the caller that
				 * writes the order line decides.
				 *
				 * Insertion order is the order the resolver walked the selections,
				 * which the caller sorts. An unstable order would make one
				 * configuration produce two different SKUs.
				 */
				'sku_suffixes'       => $sku_suffixes,
			)
		);
	}

	/**
	 * Every option this product has, keyed by option id.
	 *
	 * @param array<int, array<string, mixed>> $option_sets Sets assigned to this product.
	 * @return array<string, array<string, mixed>>
	 */
	private static function index_options( array $option_sets ): array {
		$options = array();

		foreach ( $option_sets as $set ) {
			$set_id = isset( $set['id'] ) && is_scalar( $set['id'] ) ? (string) $set['id'] : '';

			foreach ( (array) ( $set['groups'] ?? array() ) as $group ) {
				foreach ( (array) ( $group['options'] ?? array() ) as $option ) {
					if ( ! is_array( $option ) || ! isset( $option['id'] ) || ! is_scalar( $option['id'] ) ) {
						continue;
					}

					/*
					 * The set id is carried on the option, because it is the option
					 * that gets looked up later and the set it came from is not
					 * otherwise recoverable. M12.5 persists it to the order so a
					 * merchant -- or a support conversation -- can trace a line back
					 * to the set that produced it after the configuration has moved on.
					 */
					$option['__set_id'] = $set_id;

					$options[ (string) $option['id'] ] = $option;
				}
			}
		}

		return $options;
	}

	/**
	 * The amount a `set_price` rule sets for this selection, or null.
	 *
	 * ADR-049, in two halves.
	 *
	 * **Against a value-level price it replaces**, and the delta becomes the
	 * rule's amount outright. Adding was rejected there: a merchant writing
	 * *"set price to 5.00"* means the price **is** 5.00, and under `percentage`
	 * the additive reading produces a number they cannot predict without knowing
	 * the base. Replacement is also the only reading that is idempotent, which
	 * is what lets two rules setting the same amount agree — and what keeps the
	 * outcome independent of rule order (ADR-052).
	 *
	 * 🔴 **Against an option-level price it refuses**, returning null and
	 * recording the type as unpriced. `per_char`, `per_unit` and `tiered` hold a
	 * *function of the customer's input* — a rate, a bracket table — not an
	 * amount, so a flat `set_price` does not override a number, it overrides a
	 * function with a constant and charges the same for a 3-character engraving
	 * as for a 300-character one. The cloud refuses the combination at publish;
	 * this reports it, because AC4 makes the document input rather than
	 * authority and a stale cache can still deliver one.
	 *
	 * ⚠️ **Reported as unpriced, not silently dropped.** The admin notice names
	 * it, so the merchant learns from their own dashboard rather than from a
	 * customer's invoice. This mirrors `option_delta()`'s treatment of `per_char`
	 * on a non-typed option rather than inventing a second pattern.
	 *
	 * Both the option and the chosen value are consulted, because a rule may
	 * target either — and a rule targeting the option sets the price for
	 * whichever value the customer picked.
	 *
	 * ⚠️ **Three answers, not two.** `null` means no rule set a price and the
	 * authored one applies; an `int` is the amount a rule set; `false` means a
	 * rule set one this build refuses to honour, and the authored price must
	 * NOT be used in its place.
	 *
	 * @param array<string, mixed>                $option    The option, from the cached config.
	 * @param array<string, array<string, mixed>> $states    Target id -> resolved state.
	 * @param string                              $option_id The option's id.
	 * @param string                              $value_id  The chosen value's id, or ''.
	 * @param array<int, string>                  $unpriced  Collected, by reference.
	 * @return int|false|null Amount, refusal, or "no rule spoke".
	 */
	private static function set_price_for(
		array $option,
		array $states,
		string $option_id,
		string $value_id,
		array &$unpriced
	) {
		/*
		 * A cancelled `set_price` is reported, never silently replaced by the
		 * authored price. Two rules disagreeing about an amount is a
		 * configuration this build cannot price — the same category as
		 * `per_char` on a non-typed option — so the admin notice names it.
		 */
		if ( ! empty( $states[ $option_id ]['price_conflict'] )
			|| ( '' !== $value_id && ! empty( $states[ $value_id ]['price_conflict'] ) ) ) {
			if ( ! in_array( self::UNPRICED_RULE_CONFLICT, $unpriced, true ) ) {
				$unpriced[] = self::UNPRICED_RULE_CONFLICT;
			}

			/*
			 * 🔴 **`false`, not `null`** — the two answers are different and the
			 * caller must not confuse them. `null` means *"no rule spoke, use
			 * the authored price"*; `false` means *"a rule spoke and this build
			 * refuses to price it"*, and falling back to the authored amount
			 * there would charge a price the merchant's own rules overrode.
			 *
			 * Measured: while this returned `null`, a cancelled conflict billed
			 * the authored 250 on a line whose rules had set 500 and 700 — the
			 * merchant told nothing, the customer charged an amount no rule
			 * chose.
			 */
			return false;
		}

		$amount = $states[ $option_id ]['price_minor'] ?? null;

		/*
		 * The value's own rule wins over one targeting the whole option: it is
		 * the more specific statement, the same way a value's `price_config`
		 * is more specific than the option's `pricing`.
		 */
		if ( '' !== $value_id && isset( $states[ $value_id ]['price_minor'] ) ) {
			$amount = $states[ $value_id ]['price_minor'];
		}

		if ( ! is_int( $amount ) ) {
			return null;
		}

		$pricing = $option['pricing'] ?? null;
		$type    = is_array( $pricing ) && is_scalar( $pricing['type'] ?? null ) ? (string) $pricing['type'] : '';

		if ( in_array( $type, self::OPTION_PRICED_TYPES, true ) ) {
			if ( ! in_array( $type, $unpriced, true ) ) {
				$unpriced[] = $type;
			}

			/*
			 * Refused, not absent: the option prices itself with a function of
			 * the customer's input, and `option_delta()` still applies it. The
			 * `set_price` is what is discarded, so the caller falls back to the
			 * authored pricing here — which is why this is `null` and the
			 * conflict above is `false`.
			 */
			return null;
		}

		return $amount;
	}

	/**
	 * The answers rules are evaluated against, which are not quite the selections.
	 *
	 * 🔴 **A hidden field's value comes from the merchant, never the request.**
	 *
	 * `is_hidden()` marks the one type whose value the *configuration* supplies:
	 * a batch code, a fulfilment route, a campaign tag. The pricing branch below
	 * already discards what the customer posted for one and substitutes
	 * `default_value` — measured in Phase 14, where a naive implementation stored
	 * `FORGED-BY-CUSTOMER` over the merchant's own `campaign-a`.
	 *
	 * Rule evaluation ran **before** that substitution and so read the raw
	 * request, which meant a customer could post any value they liked for a
	 * hidden field and steer which options the server treated as hidden.
	 * Measured by the 17-9 audit: posting `opt-h=FORGED` fired a rule whose
	 * condition read `FORGED`, and the line was refused. It failed closed, so it
	 * bought nobody a cheaper price — but a customer was deciding an input the
	 * whole type exists to keep out of their hands.
	 *
	 * ⚠️ **It also made the two ends disagree.** The storefront runtime cannot
	 * see a hidden field at all — the template renders a bare `<input>` with no
	 * option wrapper — so the browser evaluated the same rule against *nothing*
	 * while the server evaluated it against a forged string. Same rule, same
	 * page, two answers. Substituting here settles both halves at once: the
	 * server now reads exactly what the merchant configured, and the browser
	 * reading nothing is the one remaining gap, closed separately by publishing
	 * the default to the page.
	 *
	 * @param array<string, array<string, mixed>> $options    Every option, keyed by id.
	 * @param array<string, mixed>                $selections The raw request.
	 * @return array<string, mixed>
	 */
	private static function rule_answers( array $options, array $selections ): array {
		$answers = $selections;

		foreach ( $options as $option_id => $option ) {
			if ( ! self::is_hidden( $option ) ) {
				continue;
			}

			$configured = self::clean_text( (string) ( $option['default_value'] ?? '' ) );

			if ( '' === $configured ) {
				/*
				 * Nothing configured is nothing answered — and the customer's
				 * posted value is still discarded, which is the point.
				 */
				unset( $answers[ $option_id ] );

				continue;
			}

			$answers[ $option_id ] = $configured;
		}

		return $answers;
	}

	/**
	 * Every rule across this product's sets, in document order.
	 *
	 * Flattened because rules live on a **set** and a product may match several,
	 * while the evaluator takes one list — a rule in set A whose condition reads
	 * an option in set B is a document this build has to survive, and separate
	 * evaluations per set could not settle it.
	 *
	 * ⚠️ **`sort_order` is deliberately not consulted**, here or anywhere.
	 * ADR-052: the conflict rules are total — `hide` beats `show`, `require`
	 * beats `unrequire`, and a later `set_price` replaces an earlier one — so
	 * ordering the list cannot change the outcome. M17.4a proved the alternative
	 * the hard way: while `sort_order` decided prices, two rules of 500 and 700
	 * produced order-dependent totals, in both languages identically.
	 *
	 * @param array<int, array<string, mixed>> $option_sets Sets assigned to this product.
	 * @return array<int, array<string, mixed>>
	 */
	private static function index_rules( array $option_sets ): array {
		$rules = array();

		foreach ( $option_sets as $set ) {
			foreach ( (array) ( $set['rules'] ?? array() ) as $rule ) {
				if ( is_array( $rule ) ) {
					$rules[] = $rule;
				}
			}
		}

		return $rules;
	}

	/**
	 * The option ids a rule has hidden, as a set keyed by option id.
	 *
	 * The evaluator answers in terms of **targets**; everything downstream of it
	 * here asks about **options** — is this answer allowed, is this required
	 * check owed, does this delta belong on the line. This translates once, so
	 * no caller has to know that a group id and an option id are different kinds
	 * of key.
	 *
	 * 🔴 **`$containment` is the only thing that decides this, and that is
	 * deliberate.** A value target maps to no options there — hiding one colour
	 * of five removes a *choice*, not the question — so a hidden value
	 * contributes nothing here without needing to be filtered out by type.
	 *
	 * ✏️ **This method used to read `target_type` as well**, back when
	 * `index_containment()` mapped a value to its owning option. Fixing that map
	 * (M17.8's audit) made the type check dead: removing it changed no test,
	 * while removing the *map* fix broke two. Two mechanisms for one fact is the
	 * shape that let two mutants survive in 17-4 — each hid the other's absence —
	 * so the redundant half went and the load-bearing one stayed.
	 *
	 * A hidden value is handled where values are looked up instead — as a value
	 * the option no longer offers. See `hidden_values()`.
	 *
	 * @param array<string, array<string, mixed>> $states      Target id -> resolved state.
	 * @param array<string, array<int, string>>   $containment Target id -> the options under it.
	 * @return array<string, bool>
	 */
	private static function hidden_options( array $states, array $containment ): array {
		$hidden = array();

		foreach ( $states as $target_id => $state ) {
			if ( empty( $state['hidden'] ) ) {
				continue;
			}

			foreach ( $containment[ (string) $target_id ] ?? array() as $option_id ) {
				$hidden[ $option_id ] = true;
			}
		}

		return $hidden;
	}

	/**
	 * The value keys a rule has hidden, as a set keyed by value id.
	 *
	 * The other half of `hidden_options()`: a `value` target removes one choice
	 * from an option that remains on the page. Kept separate because the two
	 * answer different questions and are consulted at different points — this
	 * one where a chosen key is looked up, that one where an option is skipped
	 * entirely.
	 *
	 * @param array<int, array<string, mixed>>    $rules  Every rule, flattened.
	 * @param array<string, array<string, mixed>> $states Target id -> resolved state.
	 * @return array<string, bool>
	 */
	private static function hidden_values( array $rules, array $states ): array {
		$hidden = array();

		foreach ( $rules as $rule ) {
			$target_id   = isset( $rule['target_id'] ) && is_scalar( $rule['target_id'] ) ? (string) $rule['target_id'] : '';
			$target_type = isset( $rule['target_type'] ) && is_scalar( $rule['target_type'] ) ? (string) $rule['target_type'] : '';

			if ( self::TARGET_VALUE !== $target_type || empty( $states[ $target_id ]['hidden'] ) ) {
				continue;
			}

			$hidden[ $target_id ] = true;
		}

		return $hidden;
	}

	/**
	 * Which options each rule target controls, keyed by target id.
	 *
	 * 🔴 **A rule names a target, but hiding acts on options.** `target_type` is
	 * `option | group | value`, and only an option holds an answer — so before
	 * the evaluator can clear what a hidden branch collected, something has to
	 * answer *"if this target goes away, which answers go with it?"*.
	 *
	 * Three containments, and they are not symmetrical:
	 *
	 * - a **group** controls every option inside it;
	 * - an **option** controls itself, because hiding it clears its own answer;
	 * - a **value** controls the option that owns it, because a value is not
	 *   separately answerable — the option it belongs to is.
	 *
	 * ⚠️ **A value maps to its option, and that is deliberately lossy.** Hiding
	 * one value of a five-value radio does not clear the answer unless the
	 * answer *was* that value, and this index cannot express the difference. The
	 * caller checks the chosen key; this only says where to look. Recording it
	 * here because the map reads like a containment and is really a lookup.
	 *
	 * Built from the same walk as `index_options()` rather than derived from it,
	 * because that one flattens groups away — the set id survives on the option
	 * and the group id does not.
	 *
	 * @param array<int, array<string, mixed>> $option_sets Sets assigned to this product.
	 * @return array<string, array<int, string>>
	 */
	private static function index_containment( array $option_sets ): array {
		$under = array();

		foreach ( $option_sets as $set ) {
			foreach ( (array) ( $set['groups'] ?? array() ) as $group ) {
				$group_id = isset( $group['id'] ) && is_scalar( $group['id'] ) ? (string) $group['id'] : '';

				foreach ( (array) ( $group['options'] ?? array() ) as $option ) {
					if ( ! is_array( $option ) || ! isset( $option['id'] ) || ! is_scalar( $option['id'] ) ) {
						continue;
					}

					$option_id = (string) $option['id'];

					if ( '' !== $group_id ) {
						$under[ $group_id ][] = $option_id;
					}

					$under[ $option_id ][] = $option_id;

					foreach ( (array) ( $option['values'] ?? array() ) as $value ) {
						if ( ! is_array( $value ) || ! isset( $value['id'] ) || ! is_scalar( $value['id'] ) ) {
							continue;
						}

						/*
						 * 🔴 **A value maps to NO option, deliberately.**
						 *
						 * ✏️ **Mapped to its owning option until M17.8's audit.**
						 * That reads like the containment this index is named
						 * for, but the question it answers is narrower: *whose
						 * answer disappears when this target is hidden?* Hiding
						 * one colour of five removes a **choice** — the question
						 * stays on the page and the answer stays valid.
						 *
						 * Measured with the old mapping: hiding `val-extra`
						 * deleted the answer of a customer who had chosen
						 * `plain`, and an unrelated rule reading *"opt-b is
						 * empty"* then fired, hiding a third option nothing was
						 * meant to touch. `hidden_options()` filters value
						 * targets correctly one layer up — which is exactly why
						 * this went unseen: the corruption happened underneath
						 * the filter.
						 *
						 * Registered with an empty list rather than omitted, so
						 * a value id is still a target the evaluator knows.
						 *
						 * ⚠️ **The cloud's `optionsUnder` keeps the value →
						 * option edge, and is right to.** Its cycle detector
						 * asks what a target can *reach* — `set_default` writes
						 * the owning option's answer — which is a broader
						 * question than *"whose answer disappears?"*. Two
						 * questions, two maps; conflating them is what produced
						 * the defect above.
						 */
						$under[ (string) $value['id'] ] = array();
					}
				}
			}
		}

		return $under;
	}

	/**
	 * An option's values, keyed by value key.
	 *
	 * @param array<string, mixed> $option One option.
	 * @return array<string, array<string, mixed>>
	 */
	private static function index_values( array $option ): array {
		$values = array();

		foreach ( (array) ( $option['values'] ?? array() ) as $value ) {
			if ( ! is_array( $value ) || ! isset( $value['value_key'] ) || ! is_scalar( $value['value_key'] ) ) {
				continue;
			}

			$values[ (string) $value['value_key'] ] = $value;
		}

		return $values;
	}

	/**
	 * The human-readable names for a chosen option and value.
	 *
	 * Returned so a caller can **snapshot** them. The configuration is
	 * overwritten on publish, so once a merchant deletes or renames an option the
	 * text a customer saw exists nowhere else -- and
	 * [M12.4](#m124--checkout-integrity) has to block checkout with "a clear,
	 * actionable message", while M12.8 requires "a message naming the option, not
	 * a generic validation error". Neither is possible from an option id, which
	 * is a merchant-chosen slug rather than customer-facing text.
	 *
	 * Falls back to the id when a label is missing, so the caller always has
	 * *something* to name. A blank name would turn an actionable message back
	 * into a generic one.
	 *
	 * @param array<string, mixed> $option The option, from the cached config.
	 * @param array<string, mixed> $value  The chosen value.
	 * @return array{option: string, value: string}
	 */
	private static function labels_for( array $option, array $value ): array {
		$option_label = isset( $option['label'] ) && is_scalar( $option['label'] ) ? (string) $option['label'] : '';
		$value_label  = isset( $value['label'] ) && is_scalar( $value['label'] ) ? (string) $value['label'] : '';

		return array(
			'option' => '' !== $option_label ? $option_label : (string) ( $option['id'] ?? '' ),
			'value'  => '' !== $value_label ? $value_label : (string) ( $value['value_key'] ?? '' ),
		);
	}

	/**
	 * Whether this option accepts several answers.
	 *
	 * 🔴 **Read from `cardinality`, which the cloud publishes and the plugin had
	 * never consulted.** M14.1 makes `one | many` a first-class axis, independent
	 * of how an option is drawn — so a `checkbox` is a yes/no toggle at `one` and
	 * a multi-select at `many`, and nothing else in the document says which.
	 *
	 * ⚠️ **Anything unrecognised is `one`**, which is the safe direction: a
	 * document from a newer cloud naming a cardinality this build does not know
	 * gets the single-value path, where every downstream structure already works.
	 * Treating an unknown as `many` would hand an array to nine consumers that
	 * expect a scalar.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function takes_many( array $option ): bool {
		$cardinality = isset( $option['cardinality'] ) && is_scalar( $option['cardinality'] )
			? (string) $option['cardinality']
			: '';

		if ( 'many' !== $cardinality ) {
			return false;
		}

		/*
		 * 🔴 **The TYPE must also be able to take several answers.**
		 *
		 * `cardinality` alone is not enough. Measured before this guard: a
		 * `radio` declaring `many` accepted **Small and Large on one line** and
		 * charged for both — one shirt in two sizes. `dropdown`, `date_picker`
		 * and `file_input` behaved the same way, and a `file_input` at `many`
		 * additionally bypasses every upload-token path, which reads one token
		 * per option.
		 *
		 * ⚠️ **Unreachable through the dashboard *today*, and that is not the
		 * same as safe.** The backend registry currently allows `MANY` for no
		 * type at all, so this needs a crafted payload or a mis-published
		 * document — but AC4 makes the document *input*, not authority, and
		 * **M18.3 is the stage that adds `MANY` to the registry**. The guard
		 * lands first so that stage cannot open the hole by being correct about
		 * one type.
		 *
		 * 🔴 **A whitelist, not a blacklist.** A type this build does not
		 * recognise takes the single-value path, which is where every
		 * downstream structure already works — the same safe direction the
		 * unknown-cardinality case above takes. Adding a type here is a
		 * decision somebody has to write down.
		 */
		return in_array( self::presentation_of( $option ), self::MANY_CAPABLE_TYPES, true );
	}

	/**
	 * An option's presentation type, or an empty string when it names none.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function presentation_of( array $option ): string {
		return isset( $option['type'] ) && is_scalar( $option['type'] ) ? (string) $option['type'] : '';
	}

	/**
	 * Whether this option's value is an uploaded file's token.
	 *
	 * ⚠️ **A file is neither chosen nor typed.** It has no merchant-authored
	 * value set to look the value up in, and unlike text the customer does not
	 * supply the value at all — `Upload\UploadEndpoint` does, as the token for
	 * bytes it has already stored and verified.
	 *
	 * Absent or unrecognised counts as **not** a file, the same safe direction
	 * every sibling takes: an unknown kind falls through to the lookup and is
	 * refused.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function is_file( array $option ): bool {
		$kind = isset( $option['value_kind'] ) && is_scalar( $option['value_kind'] )
			? (string) $option['value_kind']
			: '';

		return 'file' === $kind;
	}

	/**
	 * Whether this option's value is typed rather than chosen.
	 *
	 * Reads `value_kind` from the published document, which has carried it since
	 * Phase 7's serializer — so this needed no contract change and no
	 * `schema_version` bump. A `choice` option looks its value up in the set the
	 * merchant authored; a `text` option has no set to look in.
	 *
	 * Absent or unrecognised counts as **not** text, which is the safe
	 * direction: an unknown kind falls back to the lookup and is refused, rather
	 * than accepting arbitrary input for an option nobody meant to be free.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function is_free_text( array $option ): bool {
		$kind = isset( $option['value_kind'] ) && is_scalar( $option['value_kind'] )
			? (string) $option['value_kind']
			: '';

		return 'text' === $kind;
	}

	/**
	 * Whether this option's value comes from configuration rather than the customer.
	 *
	 * ⚠️ **Keyed on presentation, not `value_kind`.** A hidden field is `text`
	 * like `text_field` and `textarea`; what differs is *who supplies the value*,
	 * which no axis expresses.
	 *
	 * An unrecognised type is not hidden — the safe direction, since treating a
	 * normal field as hidden would silently discard everything a customer typed.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function is_hidden( array $option ): bool {
		$type = isset( $option['type'] ) && is_scalar( $option['type'] ) ? (string) $option['type'] : '';

		return 'hidden' === $type;
	}

	/**
	 * Whether this option produces a date, a time, or both.
	 *
	 * Reads `value_kind`, so `date_picker`, `time_picker` and `datetime_picker`
	 * share one branch — they differ in *precision*, which `date_format()`
	 * settles from the presentation.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function is_date( array $option ): bool {
		$kind = isset( $option['value_kind'] ) && is_scalar( $option['value_kind'] )
			? (string) $option['value_kind']
			: '';

		return 'date' === $kind;
	}

	/**
	 * The storage format for this option's precision.
	 *
	 * ⚠️ **Keyed on presentation, like `is_multiline()`.** `value_kind` is `date`
	 * for all three, and the difference between them is exactly what a stored
	 * value looks like: a wedding date has no time, a delivery slot has no date,
	 * and an appointment needs both.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function date_format( array $option ): string {
		$type = isset( $option['type'] ) && is_scalar( $option['type'] ) ? (string) $option['type'] : '';

		if ( 'time_picker' === $type ) {
			return 'H:i';
		}

		if ( 'datetime_picker' === $type ) {
			return 'Y-m-d\TH:i';
		}

		return 'Y-m-d';
	}

	/**
	 * Parse a customer-supplied date into its canonical form, or null.
	 *
	 * 🔴 **Strict parsing, not `strtotime()`.** That function accepts `"next
	 * tuesday"`, `"+3 days"` and `"0000-00-00"`, and silently rolls `2026-02-30`
	 * forward to the second of March — a customer would be delivered on a day
	 * they never chose.
	 *
	 * `DateTimeImmutable::createFromFormat` with a leading `!` (reset unparsed
	 * fields) plus an explicit round-trip check refuses all of those: a value is
	 * accepted only when re-formatting it reproduces the input exactly.
	 *
	 * UTC throughout. A date has no timezone of its own — the third of March is
	 * the third of March — and attaching one here would shift it by a day for
	 * half the world.
	 *
	 * @param string               $raw    Trimmed customer input.
	 * @param array<string, mixed> $option One published option.
	 * @return string|null Canonical value, or null when it is not a date.
	 */
	private static function parse_date( string $raw, array $option ): ?string {
		$format = self::date_format( $option );
		$parsed = \DateTimeImmutable::createFromFormat( '!' . $format, $raw, new \DateTimeZone( 'UTC' ) );

		if ( false === $parsed ) {
			return null;
		}

		/*
		 * The round trip is what catches an overflow. `createFromFormat` accepts
		 * `2026-02-30` and answers the second of March; re-formatting gives
		 * `2026-03-02`, which is not what arrived, so it is refused.
		 */
		if ( $parsed->format( $format ) !== $raw ) {
			return null;
		}

		return $raw;
	}

	/**
	 * The first date rule this value breaks, or null.
	 *
	 * Order is deliberate: **absolute bounds first, then availability, then the
	 * relative window.** A customer outside the merchant's season should be told
	 * that before being told about a lead time inside a season they cannot use.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @param string               $value  The canonical date.
	 * @param ?string              $today  Today in the store's timezone, or null.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function date_violation( array $option, string $value, ?string $today ): ?array {
		$validation = $option['validation'] ?? null;

		if ( ! is_array( $validation ) ) {
			return null;
		}

		// A time-only value has no calendar day, so the calendar rules cannot
		// apply to it — only `min_date` / `max_date`, which compare as strings.
		$day = substr( $value, 0, 10 );

		$min = isset( $validation['min_date'] ) && is_scalar( $validation['min_date'] )
			? (string) $validation['min_date']
			: '';
		$max = isset( $validation['max_date'] ) && is_scalar( $validation['max_date'] )
			? (string) $validation['max_date']
			: '';

		/*
		 * String comparison, and it is exact rather than lucky: ISO 8601 orders
		 * lexicographically by construction, which is the property the format was
		 * designed for.
		 */
		if ( '' !== $min && $value < $min ) {
			return array(
				'code'   => self::ERROR_DATE_OUT_OF_RANGE,
				'params' => array( 'min' => $min ),
			);
		}

		if ( '' !== $max && $value > $max ) {
			return array(
				'code'   => self::ERROR_DATE_OUT_OF_RANGE,
				'params' => array( 'max' => $max ),
			);
		}

		$blackout = $validation['blackout_dates'] ?? null;

		if ( is_array( $blackout ) ) {
			foreach ( $blackout as $closed ) {
				if ( is_scalar( $closed ) && $day === (string) $closed ) {
					return array(
						'code'   => self::ERROR_DATE_UNAVAILABLE,
						'params' => array( 'reason' => 'blackout' ),
					);
				}
			}
		}

		$weekdays = $validation['allowed_weekdays'] ?? null;

		if ( is_array( $weekdays ) && array() !== $weekdays && 10 === strlen( $day ) ) {
			$parsed = \DateTimeImmutable::createFromFormat( '!Y-m-d', $day, new \DateTimeZone( 'UTC' ) );

			if ( false !== $parsed ) {
				// ISO-8601 weekday: 1 is Monday, 7 is Sunday. Chosen over PHP's
				// `w` (0 = Sunday) because a merchant configuring "weekdays" is
				// far likelier to mean Monday-first.
				$weekday = (int) $parsed->format( 'N' );
				$allowed = array();

				foreach ( $weekdays as $entry ) {
					if ( is_int( $entry ) || ( is_string( $entry ) && ctype_digit( $entry ) ) ) {
						$allowed[] = (int) $entry;
					}
				}

				if ( array() !== $allowed && ! in_array( $weekday, $allowed, true ) ) {
					return array(
						'code'   => self::ERROR_DATE_UNAVAILABLE,
						'params' => array( 'reason' => 'weekday' ),
					);
				}
			}
		}

		return self::relative_date_violation( $validation, $day, $today );
	}

	/**
	 * The relative window: `lead_time_days` and `max_advance_days`.
	 *
	 * ⚠️ **Both are skipped when `$today` is null**, and that is the safe
	 * direction: a caller with no clock must not refuse every date a merchant's
	 * lead time would have allowed. The absolute rules above still apply.
	 *
	 * @param array<string, mixed> $validation The option's rules.
	 * @param string               $day        The chosen day as `Y-m-d`.
	 * @param ?string              $today      Today in the store's timezone.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function relative_date_violation( array $validation, string $day, ?string $today ): ?array {
		if ( null === $today || 10 !== strlen( $day ) ) {
			return null;
		}

		$zone   = new \DateTimeZone( 'UTC' );
		$start  = \DateTimeImmutable::createFromFormat( '!Y-m-d', $today, $zone );
		$picked = \DateTimeImmutable::createFromFormat( '!Y-m-d', $day, $zone );

		if ( false === $start || false === $picked ) {
			return null;
		}

		$lead = isset( $validation['lead_time_days'] ) && is_int( $validation['lead_time_days'] )
			&& $validation['lead_time_days'] >= 0
				? $validation['lead_time_days']
				: null;

		if ( null !== $lead ) {
			$earliest = $start->modify( '+' . $lead . ' days' );

			if ( $picked < $earliest ) {
				return array(
					'code'   => self::ERROR_DATE_OUT_OF_RANGE,
					'params' => array( 'earliest' => $earliest->format( 'Y-m-d' ) ),
				);
			}
		}

		$advance = isset( $validation['max_advance_days'] ) && is_int( $validation['max_advance_days'] )
			&& $validation['max_advance_days'] >= 0
				? $validation['max_advance_days']
				: null;

		if ( null !== $advance ) {
			$latest = $start->modify( '+' . $advance . ' days' );

			if ( $picked > $latest ) {
				return array(
					'code'   => self::ERROR_DATE_OUT_OF_RANGE,
					'params' => array( 'latest' => $latest->format( 'Y-m-d' ) ),
				);
			}
		}

		return null;
	}

	/**
	 * Whether this option produces a number.
	 *
	 * Reads `value_kind`, not `type` — `number_field` and a future `range` both
	 * produce numbers and differ only in how they draw. An unknown kind is not a
	 * number, which is the safe direction: a typo in the document must not open
	 * an option to arithmetic it was never meant to accept.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function is_number( array $option ): bool {
		$kind = isset( $option['value_kind'] ) && is_scalar( $option['value_kind'] )
			? (string) $option['value_kind']
			: '';

		return 'number' === $kind;
	}

	/**
	 * Parse a customer-supplied number, or null when it is not one.
	 *
	 * ⚠️ **Deliberately stricter than `is_numeric()`**, which accepts `"1e3"`,
	 * `" 12"`, `"0x1A"` on some versions, and `"12 "`. A customer typing an
	 * engraving quantity does not mean scientific notation, and `Money`'s
	 * docblock records the same trap: `'1e3'` silently became 100000.
	 *
	 * Accepts an optional sign, digits, and at most one decimal part. Nothing
	 * else — no thousands separators, because `1,234` means one-point-two-three-four
	 * in half of Europe and this cannot know which.
	 *
	 * @param string $raw Trimmed customer input.
	 * @return float|null The value, or null when it is not a number.
	 */
	private static function parse_number( string $raw ) {
		if ( 1 !== preg_match( '/^[+-]?\d+(\.\d+)?$/', $raw ) ) {
			return null;
		}

		return (float) $raw;
	}

	/**
	 * Canonical storage form for a number.
	 *
	 * `"007"`, `"7"` and `"7.0"` are one quantity written three ways. Storing the
	 * customer's spelling would put three different strings on three otherwise
	 * identical orders — and `CartItemKey` hashes the payload, so it would also
	 * stop them grouping into one cart line.
	 *
	 * A whole number renders without a decimal point; a fractional one keeps up
	 * to six places with trailing zeros removed, which is well beyond any
	 * quantity a storefront asks for and short of float noise.
	 *
	 * @param float $value Parsed number.
	 */
	private static function format_number( float $value ): string {
		if ( floor( $value ) === $value && abs( $value ) < 1e15 ) {
			return (string) (int) $value;
		}

		$formatted = rtrim( rtrim( number_format( $value, 6, '.', '' ), '0' ), '.' );

		return '' === $formatted ? '0' : $formatted;
	}

	/**
	 * The first `min` / `max` / `step` rule this number breaks, or null.
	 *
	 * Returns one violation rather than all of them: a customer fixing a number
	 * changes one value, and three simultaneous messages about the same field
	 * read as three problems when there is one.
	 *
	 * A malformed rule is **no rule**, matching how `max_length` treats one — a
	 * constraint that cannot be read must not refuse every answer.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @param float                $value  The parsed number.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function number_violation( array $option, float $value ): ?array {
		$validation = $option['validation'] ?? null;

		if ( ! is_array( $validation ) ) {
			return null;
		}

		$min = isset( $validation['min'] ) && is_numeric( $validation['min'] )
			? (float) $validation['min']
			: null;
		$max = isset( $validation['max'] ) && is_numeric( $validation['max'] )
			? (float) $validation['max']
			: null;

		if ( null !== $min && $value < $min ) {
			return array(
				'code'   => self::ERROR_OUT_OF_RANGE,
				'params' => array(
					'min'    => $min,
					'actual' => $value,
				),
			);
		}

		if ( null !== $max && $value > $max ) {
			return array(
				'code'   => self::ERROR_OUT_OF_RANGE,
				'params' => array(
					'max'    => $max,
					'actual' => $value,
				),
			);
		}

		if ( ! empty( $validation['integer_only'] ) && floor( $value ) !== $value ) {
			return array(
				'code'   => self::ERROR_BAD_STEP,
				'params' => array( 'step' => 1 ),
			);
		}

		$step = isset( $validation['step'] ) && is_numeric( $validation['step'] ) && (float) $validation['step'] > 0
			? (float) $validation['step']
			: null;

		if ( null !== $step ) {
			/*
			 * ⚠️ **Compared in integer space, because floats do not divide
			 * cleanly.** `0.3 / 0.1` is `2.9999999999999996`, so a naive
			 * `fmod()` refuses a value that is exactly on the step. Scaling both
			 * to integers by the step's own precision avoids the question.
			 *
			 * The offset is measured from `min` when there is one: a range
			 * starting at 5 with a step of 10 accepts 5, 15, 25 — not 10 and 20.
			 */
			$base = null !== $min ? $min : 0.0;

			/*
			 * ⚠️ **The scale comes from the *value* as well as the step.**
			 *
			 * Scaling by the step's precision alone rounds the value onto the
			 * step instead of testing it: measured, `0.35` with a step of `0.1`
			 * scaled to `round(3.5) = 4`, divided cleanly, and was **accepted**
			 * — the exact failure this integer comparison exists to prevent,
			 * reintroduced by the rounding meant to avoid it.
			 *
			 * Taking the larger precision keeps a value finer than the step
			 * distinguishable: `0.35` scales to `35` against a step of `10`, and
			 * `35 % 10` is 5.
			 */
			$places = max(
				self::decimal_places( $step ),
				self::decimal_places( abs( $value - $base ) )
			);
			$factor = (int) pow( 10, $places );

			$offset = (int) round( ( $value - $base ) * $factor );
			$scaled = (int) round( $step * $factor );

			if ( 0 !== $scaled && 0 !== $offset % $scaled ) {
				return array(
					'code'   => self::ERROR_BAD_STEP,
					'params' => array(
						'step' => $step,
						'from' => $base,
					),
				);
			}
		}

		return null;
	}

	/**
	 * How many decimal places a number carries, capped at six.
	 *
	 * The cap matches `format_number()`: a value finer than that is beyond what a
	 * storefront quantity means and inside float noise.
	 *
	 * @param float $number A number to measure.
	 */
	private static function decimal_places( float $number ): int {
		$text = rtrim( number_format( $number, 6, '.', '' ), '0' );
		$dot  = strpos( $text, '.' );

		return false === $dot ? 0 : strlen( $text ) - $dot - 1;
	}

	/**
	 * Whether this option's line breaks are content rather than noise.
	 *
	 * ⚠️ **Keyed on presentation, and that is deliberate** — the one place in
	 * this class that reads `type` for anything but pricing. `value_kind` cannot
	 * answer it: `text_field` and `textarea` are both `text`, and the difference
	 * between them is exactly whether a newline survives.
	 *
	 * An unrecognised type is **not** multiline, which is the safe direction: a
	 * stray newline folded into a space is a cosmetic loss, while one stored
	 * into a single-line cart row is a broken display.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function is_multiline( array $option ): bool {
		$type = isset( $option['type'] ) && is_scalar( $option['type'] ) ? (string) $option['type'] : '';

		return 'textarea' === $type;
	}

	/**
	 * Make a customer-typed string safe to store.
	 *
	 * 🔴 **The first customer-supplied value in the system.** Every value before
	 * text had to match a merchant-authored `value_key`, which is what made
	 * `AddToCartRequest`'s *"nothing here is trusted"* survivable — the lookup
	 * refused anything else. A text option removes that, so this is where the
	 * boundary moves to.
	 *
	 * Removes, in order: anything that looks like markup, null bytes and control
	 * characters, then collapses runs of whitespace and trims. Written in plain
	 * PHP rather than calling `sanitize_text_field()` because
	 * `bin/check-architecture.sh` keeps this directory WordPress-free.
	 *
	 * ⚠️ **Length is not enforced here.** `max_length` is a per-option rule with
	 * a merchant-facing error message, and silently truncating an engraving is
	 * worse than refusing it — the customer would be charged for text they can
	 * see and would not receive. That belongs with the validation catalogue.
	 *
	 * @param string $raw       What the customer typed.
	 * @param bool   $multiline Whether line breaks are content (`textarea`) or
	 *                          noise (`text_field`).
	 */
	private static function clean_text( string $raw, bool $multiline = false ): string {
		/*
		 * ⚠️ **`wp_strip_all_tags()`'s behaviour, reimplemented rather than
		 * called.** PHPCS rightly prefers the WordPress function — it drops the
		 * *contents* of `<script>` and `<style>`, not merely their tags, so
		 * `<script>alert(1)</script>` leaves nothing rather than `alert(1)`. The
		 * engine cannot call it (`bin/check-architecture.sh` keeps this directory
		 * WordPress-free), so the same two steps are done here in plain PHP.
		 *
		 * ✏️ **Tags second, though the order turns out not to matter.**
		 *
		 * An earlier comment here claimed stripping control characters first
		 * would *assemble* `<scr\0ipt>` into a tag. Measured across three
		 * embedded-null and control-character placements: `strip_tags()` handles
		 * all of them identically either way, and a mutation swapping the order
		 * **survived** the test written to catch it.
		 *
		 * The order is kept — narrowing before broadening is the safer habit when
		 * a future maintainer swaps `strip_tags()` for something weaker — but the
		 * reasoning is recorded as *unproven* rather than left as a hazard that
		 * does not exist.
		 */
		$text = preg_replace( '@<(script|style)[^>]*?>.*?</\\1>@si', '', $raw );
		$text = strip_tags( is_string( $text ) ? $text : '' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.strip_tags_strip_tags -- see above.

		$text = preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text );
		$text = is_string( $text ) ? $text : '';

		/*
		 * 🔴 **Line breaks collapse; inner spaces do not.**
		 *
		 * This was `\s+` → `' '`, which also collapsed *runs of spaces*, and that
		 * silently disagreed with `Text::normalise()` — the normative measurement
		 * (M11.1a), which deliberately preserves inner whitespace because *"the
		 * space between the names is cut into the material"*.
		 *
		 * Measured, the disagreement charged for characters that were never
		 * stored: `"AB  CD"` was saved as `AB CD` (5 graphemes) while
		 * `Text::measure()` on the customer's input answered **6**. That is the
		 * M14.4b credibility bug — the counter and the price disagreeing —
		 * reappearing from the opposite side, and `per_char` pricing on a text
		 * option would have shipped it.
		 *
		 * So only the characters that are *structure* are folded — tabs, vertical
		 * space — leaving runs of ordinary spaces exactly as the customer typed
		 * them.
		 *
		 * ✏️ **Newlines depend on the type, which is why `$multiline` exists.**
		 *
		 * An engraving is one line: a customer who pastes an address into a
		 * single-line field means one line of text, and storing the break would
		 * put a literal newline on a cart row. A `textarea` is the opposite —
		 * measured before this parameter existed, *"12 High Street / London /
		 * SW1A 1AA"* was stored as one run-on line, which is wrong on a shipping
		 * label and wrong in a workshop's notes.
		 */
		$breaks = $multiline
			? '/[\t\x{000B}\x{000C}]+/u'
			: '/[\r\n\t\x{000B}\x{000C}\x{0085}\x{2028}\x{2029}]+/u';

		$text = preg_replace( $breaks, ' ', $text );
		$text = is_string( $text ) ? $text : '';

		if ( $multiline ) {
			/*
			 * Normalise the *kind* of break without removing it.
			 *
			 * `\r\n` and a bare `\r` both become `\n`, so what is stored does not
			 * depend on which operating system the customer typed on. Runs of
			 * three or more blank lines collapse to two: a paragraph gap is
			 * meaningful, forty of them are a paste accident.
			 */
			$text = preg_replace( '/\r\n?|[\x{0085}\x{2028}\x{2029}]/u', "\n", $text );
			$text = is_string( $text ) ? $text : '';
			$text = preg_replace( '/\n{3,}/u', "\n\n", $text );
			$text = is_string( $text ) ? $text : '';
		}

		/*
		 * Trimming is `Text::normalise()`'s job, not a second `trim()`.
		 *
		 * It strips the Unicode blanks a bare `trim()` misses (NBSP, BOM), and —
		 * more to the point — it is the function `measure()` runs before
		 * counting. Calling it here is what makes "what is stored" and "what is
		 * counted" the same string by construction rather than by coincidence.
		 */
		return Text::normalise( $text );
	}

	/**
	 * An option's label, or its id when the label is missing.
	 *
	 * Extracted from `labels_for()` so the text branch can name an option
	 * without a value row to pair it with.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function option_label( array $option ): string {
		$label = isset( $option['label'] ) && is_scalar( $option['label'] ) ? (string) $option['label'] : '';

		return '' !== $label ? $label : (string) ( $option['id'] ?? '' );
	}

	/**
	 * Grams this chosen value adds to the line (M16.8).
	 *
	 * 🔴 **Shipping is quoted on weight, so a missing gram is the merchant's
	 * money.** A "Heavy oak" option that adds eight kilos and is not counted
	 * means WooCommerce quotes the carrier rate for the base product and the
	 * merchant absorbs the difference — with no error anywhere, because nothing
	 * failed. The field has been published to the document since Phase 5 and read
	 * by nothing until now.
	 *
	 * ⚠️ **Per unit.** `WC_Cart::get_cart_contents_weight()` multiplies by
	 * quantity itself, exactly as `WC_Cart_Totals` does for price, so this must
	 * never do it too.
	 *
	 * ⚠️ **Negative is allowed, and deliberately.** A "flat-pack" option
	 * genuinely weighs less than the assembled product. The floor is applied
	 * where the total is used, not here, for the same reason a discount is not
	 * clamped per delta: turning −2000g into 0 silently would price shipping on a
	 * weight the merchant did not configure.
	 *
	 * @param array<string, mixed> $value One published value.
	 */
	private static function weight_for( array $value ): int {
		$grams = $value['weight_delta_grams'] ?? null;

		return is_int( $grams ) ? $grams : 0;
	}

	/**
	 * A chosen value's SKU suffix, or an empty string.
	 *
	 * 🔴 **Never applied through `WC_Product::set_sku()`.** That method calls
	 * `wc_product_has_unique_sku()` and **throws `WC_Data_Exception`** on a
	 * duplicate — and two cart lines of one product with the same option produce
	 * identical SKUs, so the duplicate is the normal case rather than the odd
	 * one. An uncaught throw on `woocommerce_before_calculate_totals` takes the
	 * cart page down, which is worse than the silent gap it would be fixing;
	 * verified in WooCommerce 11.0.1 at `abstract-wc-product.php:866`. It also
	 * runs a database query **per cart line**, on a hook that fires nine times
	 * per request.
	 *
	 * So the suffix is recorded on the **order line** instead, where fulfilment
	 * reads it. See `Integration\OrderLineItem`.
	 *
	 * Trimmed, and empty means absent: a merchant who cleared the field has no
	 * suffix, and a whitespace-only one would produce `TABLE- -LG`.
	 *
	 * @param array<string, mixed> $value One value from the cached config.
	 */
	private static function sku_suffix_for( array $value ): string {
		$suffix = $value['sku_suffix'] ?? null;

		return is_string( $suffix ) ? trim( $suffix ) : '';
	}

	/**
	 * The price delta a chosen value contributes, in minor units.
	 *
	 * Read from the cached configuration and nowhere else. A value with no
	 * `price_config`, or one whose type this phase does not implement, adds
	 * nothing -- it does not fail, because a merchant may legitimately offer a
	 * free choice, and because Phase 16's types must not make Phase 11 reject
	 * configurations it simply cannot price yet.
	 *
	 * `$base_minor` is the product's own price, and it is the base for EVERY
	 * percentage in the selection -- never a running total. Two 50% options on an
	 * 80.00 product add 40.00 each, not 40.00 and 60.00. Compounding would make
	 * the total depend on option order, which the schema does not define and the
	 * customer cannot see.
	 *
	 * @param array<string, mixed> $value      One value from the cached config.
	 * @param int                  $base_minor The product's own price, in minor units.
	 * @param array<string>        $unpriced   Collects price types this build cannot price.
	 * @return int Minor units, possibly negative.
	 */
	private static function delta_for( array $value, int $base_minor, array &$unpriced ): int {
		$price = $value['price_config'] ?? null;

		if ( ! is_array( $price ) ) {
			return 0;
		}

		$type = is_scalar( $price['type'] ?? null ) ? (string) $price['type'] : '';

		if ( self::PRICE_TYPE_PERCENTAGE === $type ) {
			$points = $price['basis_points'] ?? null;

			/*
			 * A percentage with no rate is not an error and not 100%.
			 *
			 * `?? 0` on a missing key would be the same expression as `?? 0` on a
			 * rate of zero, and those are different situations: a merchant who
			 * configured `{type: percentage}` and no rate has a broken publish,
			 * while one who configured `0` meant free. Neither should charge, so
			 * both return 0 -- but the malformed one is recorded as unpriced, so
			 * the admin notice names it. Same reasoning as the unknown-type branch
			 * below: 0 is correct arithmetic and an ambiguous signal, so the
			 * signal is sent separately.
			 */
			if ( ! is_int( $points ) ) {
				if ( ! in_array( $type, $unpriced, true ) ) {
					$unpriced[] = $type;
				}

				return 0;
			}

			/*
			 * 🔴 **`percentage_of()` throws; `fixed` never could.**
			 *
			 * `Pricing::percentage_of()` raises `RangeException` when the base,
			 * the rate, or their product leaves the shared safe range -- and the
			 * only try/catch in this method wraps `Pricing::sum_deltas()`, far
			 * below. So the exception escaped `resolve()` entirely, into
			 * `woocommerce_before_calculate_totals`, where an uncaught throw
			 * fatals cart AND checkout.
			 *
			 * Measured: `basis_points = 100000` -- the cloud's own maximum, a
			 * legal publish -- on a base of 90,071,992,548 minor units. The base
			 * comes from WooCommerce, not from the cloud, and is bounded only by
			 * `PHP_INT_MAX`, so the schema cap does not prevent this.
			 *
			 * Recorded as unpriced rather than returning a guess, which is
			 * exactly what an over-range `fixed` amount already does: it reaches
			 * `sum_deltas()`, throws there, and is caught into
			 * `ERROR_UNPRICEABLE`. Two price types must not disagree about what
			 * an impossible number means.
			 */
			try {
				return Pricing::percentage_of( $base_minor, $points );
			} catch ( \InvalidArgumentException | \RangeException $e ) {
				unset( $e );

				if ( ! in_array( $type, $unpriced, true ) ) {
					$unpriced[] = $type;
				}

				return 0;
			}
		}

		if ( self::PRICE_TYPE_FIXED !== $type ) {
			/*
			 * Recorded, not merely skipped.
			 *
			 * Returning 0 is the right arithmetic: a type this build cannot
			 * price must not be guessed at, and rejecting the whole selection
			 * would take a storefront down on a bad publish. But 0 is also
			 * indistinguishable from "this option is free", and the cloud's
			 * schema publishes five price types -- fixed, percentage, per_unit,
			 * per_char, tiered -- while this build implements those in
			 * `PRICED_TYPES`.
			 *
			 * Measured: a 50% surcharge configured on an 80.00 product charged
			 * 80.00, and the merchant lost 40.00 per unit with nothing anywhere
			 * saying so. The arithmetic was correct by this phase's scope and
			 * the outcome was still a silent undercharge, so the type is named
			 * here and the callers report it.
			 */
			if ( '' !== $type && ! in_array( $type, $unpriced, true ) ) {
				$unpriced[] = $type;
			}

			return 0;
		}

		$amount = $price['amount_minor'] ?? 0;

		return is_int( $amount ) ? $amount : 0;
	}

	/**
	 * The delta a `tiered` price contributes for one answer.
	 *
	 * ```text
	 * delta = round(max(0, quantity) * amount_minor(of the matching tier))
	 * ```
	 *
	 * ## `tiered` IS `per_unit`, with the amount looked up rather than fixed
	 *
	 * So this resolves the bracket and hands the result to `per_unit_delta()`
	 * rather than repeating its arithmetic. Every guard that method carries --
	 * the strict number parse, the zero floor, the absolute quantity ceiling, the
	 * overflow catch and the `unpriced` reporting -- applies here unchanged and
	 * from one place. Duplicating them would be five more chances for the two
	 * types to disagree about the same customer input.
	 *
	 * ## The bracket is chosen by `min_quantity` alone
	 *
	 * The authoring schema guarantees the set is contiguous from 1 and ends
	 * open-ended, so the last tier whose `min_quantity` does not exceed the
	 * quantity is the same one `max_quantity` would select -- for every **whole**
	 * number.
	 *
	 * 🔴 **It differs for a fractional quantity, which is the reason for the
	 * rule.** With tiers `1-9` and `10+`, a quantity of `9.5` satisfies neither
	 * `<= 9` nor `>= 10`, so matching on both bounds leaves it unpriced -- a
	 * customer paying nothing for 9.5 metres of rope. Selecting by
	 * `min_quantity` puts it in `1-9`, which is what a merchant reading "under
	 * ten metres" means.
	 *
	 * ## An uncovered quantity is reported, never charged at a nearby rate
	 *
	 * The schema refuses a set that does not cover every quantity from 1, so a
	 * document reaching here with one predates that rule or did not come from the
	 * dashboard. Guessing the nearest bracket would charge a rate the merchant
	 * did not configure for that quantity; charging zero would make the option
	 * free. `PRICING-SPEC.md` §2's rule applies -- contributes nothing and says
	 * so.
	 *
	 * @param array<string, mixed> $pricing  The option's published `pricing`.
	 * @param string               $answer   The number the customer supplied.
	 * @param array<string>        $unpriced Collects quantities this build cannot charge.
	 * @return int Minor units, possibly negative.
	 */
	private static function tiered_delta( array $pricing, string $answer, array &$unpriced ): int {
		$quantity = self::parse_number( $answer );

		if ( null === $quantity ) {
			return 0;
		}

		$amount = self::tier_amount( $pricing['tiers'] ?? null, $quantity );

		if ( null === $amount ) {
			/*
			 * No bracket covers this quantity. A negative one is excluded here
			 * rather than reported: `per_unit_delta()` floors it to zero, and a
			 * customer typing `-5` has not found a configuration gap.
			 */
			if ( $quantity > 0 ) {
				$type = is_scalar( $pricing['type'] ?? null ) ? (string) $pricing['type'] : '';

				if ( '' !== $type && ! in_array( $type, $unpriced, true ) ) {
					$unpriced[] = $type;
				}
			}

			return 0;
		}

		return self::per_unit_delta(
			array(
				'type'         => $pricing['type'] ?? self::PRICE_TYPE_TIERED,
				'amount_minor' => $amount,
			),
			$answer,
			$unpriced
		);
	}

	/**
	 * The amount of the bracket a quantity falls in, or null when none covers it.
	 *
	 * The **last** tier whose `min_quantity` does not exceed the quantity. Walked
	 * rather than assumed sorted: the published document preserves whatever order
	 * the dashboard stored, and a reader that trusted the order would price by
	 * whichever bracket happened to come last in the array.
	 *
	 * `max_quantity` is deliberately not consulted. See `tiered_delta()`.
	 *
	 * @param mixed     $tiers    The published `tiers` array, or anything else.
	 * @param int|float $quantity The customer's quantity.
	 * @return int|null The matching tier's amount in minor units, or null.
	 */
	private static function tier_amount( $tiers, $quantity ): ?int {
		if ( ! is_array( $tiers ) ) {
			return null;
		}

		$best_min = null;
		$amount   = null;

		foreach ( $tiers as $tier ) {
			if ( ! is_array( $tier ) ) {
				continue;
			}

			$min = $tier['min_quantity'] ?? null;
			$amt = $tier['amount_minor'] ?? null;

			// A malformed tier is skipped rather than failing the whole set: the
			// others may still price this quantity, and refusing everything would
			// take a storefront down over one bad bracket.
			if ( ! is_int( $min ) || ! is_int( $amt ) || $quantity < $min ) {
				continue;
			}

			if ( null === $best_min || $min > $best_min ) {
				$best_min = $min;
				$amount   = $amt;
			}
		}

		return $amount;
	}

	/**
	 * The delta a `per_unit` price contributes for one answer.
	 *
	 * ```text
	 * delta = round(max(0, quantity) * amount_minor)
	 * ```
	 *
	 * The arithmetic -- the floor on the quantity, the overflow guard, and the
	 * away-from-zero rounding -- lives in `Pricing::per_unit_of()`, beside every
	 * other money rule this project shares with its TypeScript twin.
	 *
	 * ## The quantity is parsed, never cast
	 *
	 * `(float) $answer` would turn `"abc"` into `0.0` and `"1e3"` into `1000`,
	 * and `Money`'s own docblock records that second trap costing a real charge.
	 * `parse_number()` is the same strict parser the validation rules use, so a
	 * quantity is priced by exactly the string the validator accepted.
	 *
	 * A malformed quantity charges nothing and is **not** recorded as unpriced:
	 * `per_unit` IS priced by this build, and naming the type in a merchant
	 * notice would send them looking for an unsupported feature rather than a
	 * broken value. Same choice `per_char_delta()` makes for a malformed amount.
	 *
	 * An **uncomputable** quantity is different and IS recorded: the merchant's
	 * configuration is fine and the amount cannot be produced, so the line must
	 * not quietly become free. See the catch below.
	 *
	 * @param array<string, mixed> $pricing  The option's published `pricing`.
	 * @param string               $answer   The number the customer supplied.
	 * @param array<string>        $unpriced Collects quantities this build cannot charge.
	 * @return int Minor units, possibly negative.
	 */
	private static function per_unit_delta( array $pricing, string $answer, array &$unpriced ): int {
		$amount = $pricing['amount_minor'] ?? null;

		if ( ! is_int( $amount ) ) {
			return 0;
		}

		$quantity = self::parse_number( $answer );

		if ( null === $quantity ) {
			return 0;
		}

		/*
		 * The absolute ceiling, checked before the arithmetic.
		 *
		 * Reported rather than clamped: charging for a million units when the
		 * customer asked for more would invent a number nobody chose, and
		 * charging zero would make the option free. Neither is defensible, so the
		 * line prices without this option and the merchant is told.
		 */
		if ( $quantity > self::ABSOLUTE_MAX_QUANTITY ) {
			$type = is_scalar( $pricing['type'] ?? null ) ? (string) $pricing['type'] : '';

			if ( '' !== $type && ! in_array( $type, $unpriced, true ) ) {
				$unpriced[] = $type;
			}

			return 0;
		}

		/*
		 * Guarded, because the customer supplies the quantity and a number option
		 * has no length ceiling the way text does. Reported rather than raised:
		 * an uncaught throw here reaches
		 * `woocommerce_before_calculate_totals` and takes cart and checkout down,
		 * which is the defect M16.1's audit found in `percentage`.
		 */
		try {
			return Pricing::per_unit_of( $amount, $quantity );
		} catch ( \InvalidArgumentException | \RangeException $e ) {
			unset( $e );

			/*
			 * 🔴 **Recorded, not silently zero.**
			 *
			 * This branch returned a bare 0 until the M16.2 audit, and the
			 * docblock above claimed otherwise. Two things went wrong at once:
			 *
			 * - At the boundary the option became **free**. Measured: at the
			 *   schema's maximum amount, a quantity of 9,007,199 charged and
			 *   9,007,200 charged nothing -- a customer who asks for MORE pays
			 *   LESS, with no notice anywhere. That is exactly the silent zero
			 *   `Admin\UnpricedTypesNotice` exists to prevent, reintroduced at a
			 *   numeric boundary.
			 * - The TypeScript twin **did** report it, so the two languages
			 *   disagreed about the same input. The fixture could not see it
			 *   because the case asserted only the delta.
			 *
			 * `percentage_of()`'s catch has recorded this since M16.1. Two price
			 *  types must not disagree about what an uncomputable amount means.
			 */
			$type = is_scalar( $pricing['type'] ?? null ) ? (string) $pricing['type'] : '';

			if ( '' !== $type && ! in_array( $type, $unpriced, true ) ) {
				$unpriced[] = $type;
			}

			return 0;
		}
	}

	/**
	 * The delta a `per_char` price contributes for one answer.
	 *
	 * ```text
	 * delta = max(0, measure(text) - free_characters) * amount_minor
	 * ```
	 *
	 * ## The floor is on the COUNT, not the delta
	 *
	 * `max(0, ...)` wraps the character count. Without it a string shorter than
	 * the allowance produces a negative count and therefore a **negative
	 * delta** -- a discount for typing less, which no merchant configured and
	 * which a customer could farm by leaving the field nearly empty.
	 *
	 * A discount is expressed by a negative `amount_minor` instead, so
	 * `free_characters` never needs to produce one. That is why the floor cannot
	 * move to the delta: a merchant's negative amount must survive, and
	 * `max(0, delta)` would silently discard it. `PRICING-SPEC.md` §3's line
	 * total clamp is what stops a negative delta paying out.
	 *
	 * ## The count comes from `Text::measure()`, never from `strlen`
	 *
	 * M11.1a's whole reason for existing. In `optionia-app` the price and the
	 * character counter were written separately, and `"AB CD"` is charged as
	 * five characters while the counter shows four -- live there today. Display
	 * and server agree with each other, which is why nobody noticed: not a
	 * pricing bug but a credibility one, on engraving.
	 *
	 * @param array<string, mixed> $pricing The option's published `pricing`.
	 * @param string               $answer  What the customer typed.
	 * @return int Minor units, possibly negative.
	 */
	private static function per_char_delta( array $pricing, string $answer ): int {
		$amount = $pricing['amount_minor'] ?? null;

		/*
		 * A malformed amount charges nothing rather than being coerced, the same
		 * choice `delta_for()` makes for a percentage with no rate. It is not
		 * recorded as unpriced: `per_char` IS priced by this build, and naming
		 * the type in a notice would send a merchant looking for an unsupported
		 * feature rather than a broken value.
		 */
		if ( ! is_int( $amount ) ) {
			return 0;
		}

		$free = $pricing['free_characters'] ?? 0;
		$free = is_int( $free ) && $free > 0 ? $free : 0;

		$charged = Text::measure( $answer ) - $free;

		if ( $charged <= 0 ) {
			return 0;
		}

		/*
		 * Guarded like every other multiplication in the pricing path. The API
		 * caps `amountMinor` and `freeCharacters`, but the customer supplies the
		 * text: `MAX_TEXT_BYTES` bounds a request rather than one field, so the
		 * product is checked before it is committed. Same reasoning as
		 * `Pricing::percentage_of()`, and the same outcome -- 0, not a fatal in
		 * `woocommerce_before_calculate_totals`.
		 */
		try {
			Pricing::assert_multiplication_in_range( $charged, $amount );
		} catch ( \InvalidArgumentException | \RangeException $e ) {
			unset( $e );

			return 0;
		}

		return $charged * $amount;
	}

	/**
	 * The first content rule this text breaks, or null.
	 *
	 * Checks `pattern`, `allowed_charset` and `forbidden_words` — M14.4's
	 * content rules, as distinct from the length rules above. One violation is
	 * returned rather than all of them: a customer fixing an engraving changes
	 * one thing, and three messages about one field read as three problems.
	 *
	 * @param array<string, mixed> $option One published option.
	 * @param string               $text   The sanitised text.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function text_rule_violation( array $option, string $text ): ?array {
		$validation = $option['validation'] ?? null;

		if ( ! is_array( $validation ) ) {
			return null;
		}

		$charset = self::charset_violation( $validation, $text );

		if ( null !== $charset ) {
			return $charset;
		}

		$word = self::forbidden_word_violation( $validation, $text );

		if ( null !== $word ) {
			return $word;
		}

		return self::pattern_violation( $validation, $text );
	}

	/**
	 * Whether the text uses characters the merchant's charset forbids.
	 *
	 * Named sets rather than a merchant-supplied character list: a set has one
	 * meaning both languages can agree on, where a hand-written list is a second
	 * pattern with none of a pattern's safeguards.
	 *
	 * ⚠️ **Matched on graphemes conceptually but bytes practically** — the sets
	 * below are all ASCII, so a multi-byte character simply is not in them and
	 * is refused, which is the intended answer for "letters and numbers only".
	 *
	 * @param array<string, mixed> $validation The option's rules.
	 * @param string               $text       The sanitised text.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function charset_violation( array $validation, string $text ): ?array {
		$charset = isset( $validation['allowed_charset'] ) && is_scalar( $validation['allowed_charset'] )
			? (string) $validation['allowed_charset']
			: '';

		$patterns = array(
			'alpha'        => '/^[A-Za-z]*$/',
			'alphanumeric' => '/^[A-Za-z0-9]*$/',
			'numeric'      => '/^[0-9]*$/',
			// Space, apostrophe and hyphen: a name is not alphanumeric.
			'latin'        => "/^[A-Za-z0-9 '\\-]*$/",
		);

		// An unrecognised charset is **no rule**, matching every other malformed
		// rule in this class: it must not refuse every answer a customer gives.
		if ( '' === $charset || ! isset( $patterns[ $charset ] ) ) {
			return null;
		}

		if ( 1 === preg_match( $patterns[ $charset ], $text ) ) {
			return null;
		}

		return array(
			'code'   => self::ERROR_CHARSET,
			'params' => array( 'charset' => $charset ),
		);
	}

	/**
	 * Whether the text contains a word the merchant forbids.
	 *
	 * Case-insensitive and matched as a **substring**, deliberately. A merchant
	 * forbidding a slur means it however it is spelled around, and a word-boundary
	 * match would let padding defeat the list. The cost is that a forbidden word
	 * inside an innocent longer word also matches, which is the safer error for a
	 * list a merchant writes for their own storefront.
	 *
	 * @param array<string, mixed> $validation The option's rules.
	 * @param string               $text       The sanitised text.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function forbidden_word_violation( array $validation, string $text ): ?array {
		$words = $validation['forbidden_words'] ?? null;

		if ( ! is_array( $words ) || array() === $words ) {
			return null;
		}

		$haystack = function_exists( 'mb_strtolower' ) ? mb_strtolower( $text, 'UTF-8' ) : strtolower( $text );

		foreach ( $words as $word ) {
			if ( ! is_scalar( $word ) ) {
				continue;
			}

			$needle = trim( (string) $word );

			if ( '' === $needle ) {
				continue;
			}

			$needle = function_exists( 'mb_strtolower' ) ? mb_strtolower( $needle, 'UTF-8' ) : strtolower( $needle );

			if ( false !== strpos( $haystack, $needle ) ) {
				return array(
					// ⚠️ The word is **not** returned in params: it reaches a
					// customer-facing message, and echoing a slur back at the
					// customer who typed it is not an improvement.
					'code'   => self::ERROR_FORBIDDEN_WORD,
					'params' => array(),
				);
			}
		}

		return null;
	}

	/**
	 * Whether the text fails the merchant's regex.
	 *
	 * 🔴 **The three defences, and why each is needed.**
	 *
	 * 1. **Length cap.** A pattern longer than `MAX_PATTERN_LENGTH` is refused
	 *    unread. Cheap, and it bounds what can be built.
	 *
	 * 2. **A bailout is not a mismatch.** Measured: `/^(a+)+$/` against 31
	 *    characters returns `false` with `PREG_BACKTRACK_LIMIT_ERROR` in 3 ms,
	 *    while a genuine non-match returns `0`. A naive `! preg_match()` treats
	 *    both as invalid input — so a merchant's own pattern could **refuse every
	 *    answer**, silently, on inputs slightly longer than the ones they tested.
	 *    An engine error means *the rule could not be applied*, and an
	 *    unapplicable rule is no rule.
	 *
	 * 3. **An invalid pattern is no rule**, not a rejection. `preg_match` emits a
	 *    warning and returns `false` for `/[unclosed/`; suppressing and checking
	 *    the error code is what tells those apart from a mismatch.
	 *
	 * PHP's `pcre.backtrack_limit` (1,000,000 here) is what makes 2 survivable
	 * rather than fatal — it is a **budget**, not a timeout, so the bailout is
	 * bounded by steps rather than seconds.
	 *
	 * @param array<string, mixed> $validation The option's rules.
	 * @param string               $text       The sanitised text.
	 * @return array{code: string, params: array<string, mixed>}|null
	 */
	private static function pattern_violation( array $validation, string $text ): ?array {
		$pattern = isset( $validation['pattern'] ) && is_scalar( $validation['pattern'] )
			? (string) $validation['pattern']
			: '';

		if ( '' === $pattern || strlen( $pattern ) > self::MAX_PATTERN_LENGTH ) {
			return null;
		}

		/*
		 * Delimited here rather than trusting the merchant's own delimiters.
		 * A stored `/foo/e` would once have meant *eval*; taking the body and
		 * applying `D` (dollar matches end only) and `u` (UTF-8) ourselves means
		 * no modifier arrives from configuration at all.
		 */
		$compiled = '/' . str_replace( '/', '\\/', $pattern ) . '/Du';

		/*
		 * ⚠️ **Suppressed deliberately, and the return value is checked instead.**
		 *
		 * `preg_match` emits a warning for a pattern it cannot compile —
		 * merchant configuration, not a programming error, and a storefront must
		 * not print PHP warnings to a customer. The `false` return is what
		 * carries the information, and it is handled immediately below.
		 */
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- see above; the return value is the check.
		$result = @preg_match( $compiled, $text );

		if ( false === $result ) {
			// Could not be applied — invalid, or the backtrack budget ran out.
			// Either way this is not evidence the customer typed something wrong.
			return null;
		}

		if ( 1 === $result ) {
			return null;
		}

		return array(
			'code'   => self::ERROR_PATTERN,
			'params' => array(),
		);
	}

	/**
	 * An option's `min_length`, or 0 when it has none.
	 *
	 * Anything that is not a positive integer means **no minimum**, matching
	 * `max_length()`'s handling of a malformed rule: a rule that cannot be read
	 * must not refuse every answer a customer gives.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function min_length( array $option ): int {
		$validation = $option['validation'] ?? null;

		if ( ! is_array( $validation ) ) {
			return 0;
		}

		$min = $validation['min_length'] ?? null;

		if ( ! is_int( $min ) || $min < 1 ) {
			return 0;
		}

		/*
		 * A minimum above the absolute ceiling would refuse every possible
		 * answer. The API's schema already forbids `minLength > maxLength`, so a
		 * document like that did not come from the dashboard.
		 */
		return min( $min, self::ABSOLUTE_MAX_LENGTH );
	}

	/**
	 * An option's `max_length`, or the absolute ceiling when it has none.
	 *
	 * Read from `validation`, which is where the API publishes per-type rules.
	 * Anything that is not a positive integer falls back to
	 * `ABSOLUTE_MAX_LENGTH` rather than to "unbounded" — a malformed rule must
	 * not refuse every answer a customer gives, and equally must not accept a
	 * megabyte of it.
	 *
	 * @param array<string, mixed> $option One published option.
	 */
	private static function max_length( array $option ): int {
		$validation = $option['validation'] ?? null;

		if ( ! is_array( $validation ) ) {
			return self::ABSOLUTE_MAX_LENGTH;
		}

		$max = $validation['max_length'] ?? null;

		if ( ! is_int( $max ) || $max < 1 ) {
			// No usable limit configured — fall back to the absolute ceiling
			// rather than to "unbounded".
			return self::ABSOLUTE_MAX_LENGTH;
		}

		// A merchant cannot raise the ceiling: the API caps `maxLength` at the
		// same number, so a larger value in a document did not come from the
		// dashboard.
		return min( $max, self::ABSOLUTE_MAX_LENGTH );
	}

	/**
	 * The delta an OPTION-level price contributes, in minor units.
	 *
	 * The counterpart to `delta_for()`, which prices a chosen **value**. An
	 * option with no values -- text, date, number, file -- has no value row to
	 * hang a price on, so its price hangs on the option itself.
	 *
	 * ## Why this returns a delta rather than only recording
	 *
	 * It replaced `record_option_pricing()`, which returned nothing. That was
	 * correct while no option-level type could be charged, and it left the
	 * accepting branches recording a selection without recording a delta --
	 * which silently defeated the price freeze for any line carrying a text
	 * field, because `trusted_deltas()` refuses a freeze that covers fewer
	 * options than the line resolved.
	 *
	 * Returning a delta makes the invariant *"one entry per accepted option"*
	 * true by construction rather than by five branches each remembering to say
	 * so.
	 *
	 * @param array<string, mixed> $option   One published option.
	 * @param string               $answer   What the customer supplied.
	 * @param array<string>        $unpriced Collects price types this build cannot price.
	 * @param int|false|null       $ruled    A `set_price` rule's answer, from `set_price_for()`.
	 * @return int Minor units, possibly negative; 0 when nothing is charged.
	 */
	private static function option_delta( array $option, string $answer, array &$unpriced, $ruled = null ): int {
		/*
		 * 🔴 **A `set_price` rule is answered here too, not only in the choice
		 * branch.**
		 *
		 * ✏️ **Added in M17.8's audit.** `set_price_for()` had exactly one call
		 * site — inside the branch that looks a chosen value up — so a rule
		 * targeting a **text, number, date or file** option was neither applied
		 * nor reported. Measured: *"set price to 9.00"* on a text option
		 * published cleanly and the storefront charged **0**, telling nobody.
		 * A silent undercharge is the failure class ADR-049 §3 exists to stop.
		 *
		 * `false` means a rule set a price this build refuses to honour, and the
		 * authored pricing must not stand in for it; an `int` replaces the
		 * authored amount outright; `null` means no rule spoke.
		 */
		if ( false === $ruled ) {
			return 0;
		}

		if ( is_int( $ruled ) ) {
			return $ruled;
		}

		$pricing = $option['pricing'] ?? null;

		if ( ! is_array( $pricing ) ) {
			return 0;
		}

		$type = is_scalar( $pricing['type'] ?? null ) ? (string) $pricing['type'] : '';

		/*
		 * `fixed` at the OPTION level has no defined meaning.
		 *
		 * `PRICING-SPEC.md` prices `fixed` per value, so an option-level one is a
		 * configuration this build must not invent a rule for -- and inventing
		 * one independently in two languages is how they begin to disagree. It is
		 * not "unpriced" either, since the type is implemented; it is simply not
		 * this shape of thing. Silence is the honest answer.
		 */
		if ( '' === $type || self::PRICE_TYPE_FIXED === $type ) {
			return 0;
		}

		if ( self::PRICE_TYPE_PER_CHAR === $type ) {
			/*
			 * 🔴 **Only an option the customer TYPES INTO is charged per
			 * character.**
			 *
			 * This method dispatches on `pricing.type` and would otherwise charge
			 * for the length of whatever string the option happens to produce.
			 * Measured, before this guard:
			 *
			 * ```text
			 * per_char on a FILE option   -> a 64-character upload token -> 32.00
			 * per_char on a DATE option   -> "2026-10-01"                ->  5.00
			 * per_char on a NUMBER option -> "12345"                     ->  2.50
			 * ```
			 *
			 * A customer paying 32.00 for the length of a hash they never typed
			 * is not a configuration any merchant meant.
			 *
			 * The cloud's type registry refuses these combinations at authoring
			 * time, which is where the clear error belongs. This is the second
			 * line: AC4 makes the published document input, not authority, and a
			 * document can arrive from a stale cache, a partial publish, or a
			 * build older than the registry rule.
			 *
			 * Reported rather than silently zero, so a merchant whose document
			 * somehow carries the combination is told instead of undercharged.
			 *
			 * ⚠️ **`is_free_text()` alone is not enough**, and `is_hidden()` is
			 * the reason its own docblock gives: a hidden field's `value_kind` is
			 * `text`, but its value is the merchant's `default_value` and never
			 * customer input. Charging per character there bills a customer for
			 * the length of a campaign tag -- measured at 5.00 for `campaign-a`,
			 * on a value the customer cannot see, let alone type.
			 */
			if ( ! self::is_free_text( $option ) || self::is_hidden( $option ) ) {
				if ( ! in_array( $type, $unpriced, true ) ) {
					$unpriced[] = $type;
				}

				return 0;
			}

			return self::per_char_delta( $pricing, $answer );
		}

		if ( self::PRICE_TYPE_PER_UNIT === $type || self::PRICE_TYPE_TIERED === $type ) {
			/*
			 * 🔴 **Only an option that produces a NUMBER is charged per unit.**
			 *
			 * The same rule `per_char` has for typed text, for the same reason:
			 * this method dispatches on `pricing.type` and would otherwise
			 * multiply by whatever the answer happens to be. A date answer of
			 * `"2026-10-01"` is not a quantity, and neither is an engraving.
			 *
			 * The cloud's type registry refuses the combination at authoring
			 * time, where a clear error belongs. This is the second line, because
			 * AC4 makes a published document input rather than authority.
			 */
			if ( ! self::is_number( $option ) ) {
				if ( ! in_array( $type, $unpriced, true ) ) {
					$unpriced[] = $type;
				}

				return 0;
			}

			return self::PRICE_TYPE_TIERED === $type
				? self::tiered_delta( $pricing, $answer, $unpriced )
				: self::per_unit_delta( $pricing, $answer, $unpriced );
		}

		/*
		 * Recorded, not merely skipped -- the same reasoning as `delta_for()`'s
		 * unknown-type branch. 0 is the right arithmetic and an ambiguous signal,
		 * so the signal is sent separately and the merchant is told.
		 */
		if ( ! in_array( $type, $unpriced, true ) ) {
			$unpriced[] = $type;
		}

		return 0;
	}

	/**
	 * Whether an error for this field has already been collected.
	 *
	 * @param array<int, array<string, mixed>> $errors    Errors so far.
	 * @param string                           $option_id Field to look for.
	 */
	private static function already_reported( array $errors, string $option_id ): bool {
		foreach ( $errors as $error ) {
			if ( ( $error['field'] ?? null ) === $option_id ) {
				return true;
			}
		}

		return false;
	}
}
