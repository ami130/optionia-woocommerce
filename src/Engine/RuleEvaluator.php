<?php
/**
 * The rule evaluator (M17.2), in PHP.
 *
 * The twin of `src/common/rules/rule-evaluator.ts` in the cloud. Both read the
 * same `rule-fixtures.json`, and `bin/check-shared-fixtures.sh` fails if either
 * stops executing it.
 *
 * 🔴 **Two coercions are pinned by the fixture because the languages disagree by
 * default**, and a rule's outcome decides whether a field is hidden — which
 * under ADR-051 decides whether it is charged. So a disagreement here is a
 * disagreement about money, which is 16d's shape: PHP returned a bare `0` where
 * TypeScript reported `unpriced`, and the two parted company at exactly the
 * boundary where the money was wrong.
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Engine;

defined( 'ABSPATH' ) || exit;

/**
 * Conditional rules, evaluated to a fixed point.
 *
 * ## Order-independence
 *
 * M17.2 requires evaluation be deterministic and order-independent, and
 * `sort_order` is presentation rather than precedence. Two rules acting on one
 * target in opposite directions are resolved by **what they say**, not by which
 * ran first (ADR-052):
 *
 * | Pair | Winner |
 * |---|---|
 * | `show` / `hide` | **`hide`** — a hidden field cannot be filled |
 * | `require` / `unrequire` | **`require`** — refusing an incomplete order is recoverable |
 *
 * ## Cascading
 *
 * Hiding an option clears its answer (ADR-051), and a cleared answer may satisfy
 * another rule's condition — so evaluation repeats until nothing changes.
 *
 * 🔴 **Hides accumulate**, which is what makes the fixed point monotone and
 * therefore terminating. Without it, "hide A when A is answered" flips for ever
 * and reaches the cap — and M17.3 **publishes** that rule deliberately, so the
 * evaluator refusing it would make the product unbuyable on a document the
 * publish gate approved.
 */
final class RuleEvaluator {

	/**
	 * The most passes a rule set may take to settle.
	 *
	 * Each pass can only *add* a hide — the resolution table has no way back — so
	 * a set of N rules settles in at most N passes. Ten is far above any real
	 * cascade, and it bounds what a hostile or corrupt cached document can cost
	 * a storefront render.
	 *
	 * **Must equal `MAX_RULE_PASSES` in the TypeScript evaluator.** The shared
	 * fixture carries a case that reaches it and expects a refusal, so the two
	 * cannot drift silently.
	 */
	public const MAX_PASSES = 10;

	/** Actions that change an option's answer, and so can feed another rule. */
	private const ANSWER_AFFECTING = array( 'show', 'hide', 'set_default' );

	/**
	 * Evaluate a rule set against the answers so far.
	 *
	 * @param array<int, array<string, mixed>>  $rules         Published rules, in document shape.
	 * @param array<string, mixed>              $answers       Answers keyed by option id.
	 * @param array<string, array<int, string>> $options_under Target id -> the option ids it controls.
	 *
	 * @return array{states: array<string, array<string, mixed>>, passes: int, refused: ?string}
	 */
	public static function evaluate( array $rules, array $answers, array $options_under ): array {
		$hidden  = array();
		$current = $answers;

		for ( $pass = 1; $pass <= self::MAX_PASSES; $pass++ ) {
			$states = self::resolve( $rules, $current, $hidden );

			foreach ( $states as $target_id => $state ) {
				if ( true === $state['hidden'] ) {
					$hidden[ $target_id ] = true;
				}
			}

			/*
			 * Rebuilt from the ORIGINAL answers each pass rather than mutated, so
			 * the result cannot depend on the order rules were visited. What
			 * carries between passes is `$hidden`, not the answers.
			 */
			$next = $answers;

			foreach ( array_keys( $hidden ) as $target_id ) {
				foreach ( $options_under[ $target_id ] ?? array() as $option_id ) {
					unset( $next[ $option_id ] );
				}
			}

			if ( $next === $current ) {
				return array(
					'states'  => $states,
					'passes'  => $pass,
					'refused' => null,
				);
			}

			$current = $next;
		}

		/*
		 * 🔴 Refused, not truncated (ADR-050). Returning the state reached would
		 * be a field wrongly shown or hidden and a price computed from it — a
		 * wrong price that looks right, which this project has shipped twice.
		 */
		return array(
			'states'  => array(),
			'passes'  => self::MAX_PASSES,
			'refused' => 'Rules did not settle within the pass limit.',
		);
	}

	/**
	 * Whether one condition holds against the answers so far.
	 *
	 * ⚠️ **An unknown operator is `false`, never fatal.** The document is input
	 * rather than authority (AC4), and a plugin build older than the operator
	 * reaching it must render the product rather than refuse it.
	 *
	 * @param array<string, mixed> $condition One published condition.
	 * @param array<string, mixed> $answers   Answers keyed by option id.
	 */
	public static function condition_holds( array $condition, array $answers ): bool {
		$option_id = isset( $condition['option_id'] ) && is_string( $condition['option_id'] )
			? $condition['option_id']
			: '';
		$operator  = isset( $condition['operator'] ) && is_string( $condition['operator'] )
			? $condition['operator']
			: '';

		$answer   = $answers[ $option_id ] ?? null;
		$supplied = null !== $answer && '' !== $answer;
		$operand  = $condition['value'] ?? null;

		switch ( $operator ) {
			case 'is_empty':
				return ! $supplied;

			case 'is_not_empty':
				return $supplied;

			case 'equals':
				return $supplied && self::same_scalar( $answer, $operand );

			case 'not_equals':
				/*
				 * ⚠️ **An unanswered option does NOT satisfy `not_equals`.**
				 * "Colour is not red" asks about a colour that was chosen;
				 * treating a blank as a match would fire the rule on a form the
				 * customer has not begun.
				 */
				return $supplied && ! self::same_scalar( $answer, $operand );

			case 'contains':
				return $supplied && is_string( $operand )
					&& str_contains( self::as_string( $answer ), $operand );

			case 'greater_than':
				return self::compare_numeric( $answer, $operand, static fn( $a, $b ) => $a > $b );

			case 'less_than':
				return self::compare_numeric( $answer, $operand, static fn( $a, $b ) => $a < $b );

			case 'in':
				return $supplied && self::in_list( $answer, $operand );

			case 'not_in':
				return $supplied && ! self::in_list( $answer, $operand );

			default:
				return false;
		}
	}

	/**
	 * Whether a rule's conditions are satisfied, under its own connective.
	 *
	 * ⚠️ **A rule with no conditions never fires.** The authoring schema refuses
	 * one, so this is reachable only from a document written before that check —
	 * and a rule that always fires is not a conditional rule at all. `false`
	 * leaves the storefront as the merchant would see it without the rule.
	 *
	 * @param array<string, mixed> $rule    One published rule.
	 * @param array<string, mixed> $answers Answers keyed by option id.
	 */
	public static function rule_fires( array $rule, array $answers ): bool {
		$conditions = is_array( $rule['conditions'] ?? null ) ? $rule['conditions'] : array();

		if ( array() === $conditions ) {
			return false;
		}

		$any = 'any' === ( $rule['match_type'] ?? 'all' );

		foreach ( $conditions as $condition ) {
			/*
			 * 🔴 **An unreadable condition is FALSE, never skipped.**
			 *
			 * `continue` was the first version, and it made the two evaluators
			 * disagree: measured, a rule with `[valid-and-true, garbage]` under
			 * `all` fired in PHP and did not in TypeScript, which evaluates the
			 * garbage as false. Under ADR-051 a hidden field is one that is not
			 * charged, so the two languages disagreed about **money** — the
			 * exact class M17.6 exists to close.
			 *
			 * PHP's was the wrong answer. A condition the evaluator cannot read
			 * is one it cannot confirm, and under `all` an unconfirmable
			 * condition must fail — skipping made a rule *more* likely to fire
			 * the more corrupt its document was.
			 */
			$holds = is_array( $condition ) && self::condition_holds( $condition, $answers );

			if ( $any && $holds ) {
				return true;
			}

			if ( ! $any && ! $holds ) {
				return false;
			}
		}

		return ! $any;
	}

	/**
	 * Collect what every rule says, and resolve each target by ADR-052's table.
	 *
	 * @param array<int, array<string, mixed>> $rules          Published rules.
	 * @param array<string, mixed>             $answers        Answers keyed by option id.
	 * @param array<string, bool>              $already_hidden Targets hidden by an earlier pass.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function resolve( array $rules, array $answers, array $already_hidden ): array {
		$states = array();

		foreach ( $rules as $rule ) {
			if ( ! is_array( $rule ) || ! self::rule_fires( $rule, $answers ) ) {
				continue;
			}

			$target_id = isset( $rule['target_id'] ) && is_string( $rule['target_id'] )
				? $rule['target_id']
				: '';
			$action    = isset( $rule['action'] ) && is_string( $rule['action'] ) ? $rule['action'] : '';

			$state = $states[ $target_id ] ?? array(
				'hidden'         => false,
				'required'       => null,
				'price_minor'    => null,
				'price_conflict' => false,
			);

			switch ( $action ) {
				case 'hide':
					$state['hidden'] = true;
					break;

				case 'require':
					$state['required'] = true;
					break;

				case 'unrequire':
					// `require` wins, for the same reason `hide` does.
					$state['required'] = true === $state['required'] ? true : false;
					break;

				case 'set_price':
					$amount = $rule['action_value']['amount_minor'] ?? null;

					if ( is_int( $amount ) ) {
						/*
						 * 🔴 **Two rules setting DIFFERENT amounts cancel,
						 * rather than the later one winning.**
						 *
						 * ADR-052 refuses conflicting payloads at publish,
						 * because `5.00` versus `7.00` has no principled
						 * winner. But AC4 makes the document input rather than
						 * authority, so a stale cache, a partial publish, or a
						 * build older than the publish rule can still deliver
						 * the pair — and "last writer wins" then makes the
						 * price a function of **array order**.
						 *
						 * That is M17.4a's defect one layer down: it was
						 * `sort_order` deciding a price, and this is document
						 * order deciding the same price. Found in 17-8 by
						 * resolving one pair in both orders and getting 1500
						 * and 1700.
						 *
						 * Cancelling is the only resolution that is
						 * order-independent AND never invents a number no
						 * merchant chose. `price_conflict` carries the fact so
						 * the caller reports it rather than silently charging
						 * the authored price.
						 *
						 * Two rules setting the SAME amount agree and are not a
						 * conflict — the case ADR-052 explicitly declines to
						 * refuse.
						 */
						if ( ! empty( $state['price_conflict'] )
							|| ( null !== $state['price_minor'] && $state['price_minor'] !== $amount ) ) {
							$state['price_minor']    = null;
							$state['price_conflict'] = true;
							break;
						}

						$state['price_minor'] = $amount;
					}
					break;

				default:
					// An action a newer build authored. Ignored, never fatal (AC4).
					break;
			}

			$states[ $target_id ] = $state;
		}

		/*
		 * 🔴 A target hidden by an earlier pass stays hidden, even when the rule
		 * that hid it no longer fires — because what stopped it firing was the
		 * hide itself clearing the answer its condition read. This is what makes
		 * the fixed point monotone, and therefore what makes it terminate.
		 */
		foreach ( array_keys( $already_hidden ) as $target_id ) {
			$state           = $states[ $target_id ] ?? array(
				'required'       => null,
				'price_minor'    => null,
				'price_conflict' => false,
			);
			$state['hidden'] = true;

			$states[ $target_id ] = $state;
		}

		return $states;
	}

	/**
	 * Whether two scalars are the same answer.
	 *
	 * 🔴 **`(string)` is deliberately not used on a boolean.** PHP casts `true`
	 * to `'1'` and `false` to `''`; JavaScript's `String()` gives `'true'` and
	 * `'false'`. Measured, and the shared fixture pins the JavaScript spelling in
	 * both languages — a merchant writing `equals: true` means the answer the
	 * form submits, which is the word.
	 *
	 * @param mixed $answer  The customer's answer.
	 * @param mixed $operand The merchant's operand.
	 */
	private static function same_scalar( $answer, $operand ): bool {
		if ( gettype( $answer ) === gettype( $operand ) ) {
			return $answer === $operand;
		}

		return self::as_string( $answer ) === self::as_string( $operand );
	}

	/**
	 * A value as the string both languages agree on.
	 *
	 * @param mixed $value Any scalar.
	 */
	private static function as_string( $value ): string {
		if ( is_bool( $value ) ) {
			return $value ? 'true' : 'false';
		}

		return is_scalar( $value ) ? (string) $value : '';
	}

	/**
	 * Compare two values as numbers, or answer `false`.
	 *
	 * @param mixed    $answer  The customer's answer.
	 * @param mixed    $operand The merchant's operand.
	 * @param callable $compare Receives two floats.
	 */
	private static function compare_numeric( $answer, $operand, callable $compare ): bool {
		$left  = self::numeric_value( $answer );
		$right = self::numeric_value( $operand );

		if ( null === $left || null === $right ) {
			return false;
		}

		return (bool) $compare( $left, $right );
	}

	/**
	 * A value as a number, or `null` when it is not one.
	 *
	 * 🔴 **Neither language's own coercion can be trusted, and they disagree in
	 * opposite directions.** Measured:
	 *
	 * ```text
	 * input     Number() (JS)   (float) (PHP)   is_numeric() (PHP)
	 * "abc"     NaN             0.0             false
	 * "0x10"    16              0.0             false
	 * "9abc"    NaN             9.0             false
	 * "1e3"     1000            1000.0          true
	 * " 9 "     9               9.0             true
	 * ```
	 *
	 * So PHP's cast makes `less_than 5` fire on `"abc"`, and JavaScript's makes
	 * `greater_than 5` fire on `"0x10"`. The fixture pins **decimal notation
	 * only**, and both evaluators match that rather than their own casts.
	 *
	 * @param mixed $value Any scalar.
	 */
	private static function numeric_value( $value ): ?float {
		if ( is_int( $value ) || is_float( $value ) ) {
			return is_finite( (float) $value ) ? (float) $value : null;
		}

		if ( ! is_string( $value ) ) {
			return null;
		}

		$trimmed = trim( $value );

		/*
		 * Decimal, with an optional sign and exponent. Deliberately narrower than
		 * `is_numeric()`, which accepts hexadecimal in some PHP versions and
		 * leading-whitespace forms JavaScript reads differently.
		 */
		if ( 1 !== preg_match( '/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $trimmed ) ) {
			return null;
		}

		return (float) $trimmed;
	}

	/**
	 * Whether an answer appears in an `in` / `not_in` operand.
	 *
	 * @param mixed $answer  The customer's answer.
	 * @param mixed $operand The merchant's list.
	 */
	private static function in_list( $answer, $operand ): bool {
		if ( ! is_array( $operand ) ) {
			return false;
		}

		foreach ( $operand as $entry ) {
			if ( self::same_scalar( $answer, $entry ) ) {
				return true;
			}
		}

		return false;
	}
}
