<?php
/**
 * Selection resolution against the cached config (M11.5).
 *
 * @package Optionia
 */

declare( strict_types=1 );

namespace Optionia\Tests\Unit;

use Optionia\Engine\SelectionResolver;
use Optionia\Engine\Text;
use PHPUnit\Framework\TestCase;

/**
 * The `config × selections → deltas` half of M11.2.
 *
 * Driven directly rather than through the filter, so a failure names the rule
 * that broke instead of "add-to-cart was refused".
 *
 * @covers \Optionia\Engine\SelectionResolver
 */
final class SelectionResolverTest extends TestCase {

	/**
	 * A valid selection resolves to its configured delta.
	 */
	public function test_resolves_a_valid_selection(): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'front' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt-a' => 500 ), $result->value()['deltas'] );
		$this->assertSame( array( 'opt-a' => 'front' ), $result->value()['resolved'] );
	}

	/**
	 * The total is the base plus the resolved deltas.
	 *
	 * M11.5's "recompute price from cached config" — the clause that makes this
	 * the AC4 boundary rather than a form validator.
	 */
	public function test_recomputes_the_total_from_the_cached_config(): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'back' ), 3000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 3750, $result->value()['total_minor'] );
	}

	/**
	 * A discount below the base clamps the line at zero, not the delta.
	 *
	 * The shared floor from `PRICING-SPEC.md` §3, reached through the resolver
	 * rather than asserted against `Pricing` directly — so the composition is
	 * what is tested, not the arithmetic a Stage 5 suite already covers.
	 */
	public function test_the_line_total_never_goes_below_zero(): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'discount' ), 1000 );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 0, $result->value()['total_minor'] );
	}

	/**
	 * Injected price fields are never read — asserted on the NUMBER.
	 *
	 * **This is AC4, and asserting "the request passed" does not test it.** A
	 * mutation that read `$_POST['delta']` in place of the configured amount
	 * survived a suite that only checked the request was accepted: the price was
	 * wrong and every test was green. The assertion has to be the total.
	 *
	 * @dataProvider provide_injected_price_fields
	 *
	 * @param string $field Field name an attacker might inject.
	 */
	public function test_an_injected_price_field_cannot_change_the_total( string $field ): void {
		$_POST[ $field ] = '99999';

		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'front' ), 3000 );

		unset( $_POST[ $field ] );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame(
			3500,
			$result->value()['total_minor'],
			'The total must come from the cached config, never from the request.'
		);
		$this->assertSame( array( 'opt-a' => 500 ), $result->value()['deltas'] );
	}

	/**
	 * Field names a tampered request might carry.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_injected_price_fields(): array {
		return array(
			'price'        => array( 'price' ),
			'delta'        => array( 'delta' ),
			'amount_minor' => array( 'amount_minor' ),
			'total_minor'  => array( 'total_minor' ),
			'line_total'   => array( 'line_total' ),
		);
	}

	/**
	 * A negative injected amount cannot discount the line either.
	 */
	public function test_an_injected_negative_amount_cannot_discount(): void {
		$_POST['delta']        = '-999999';
		$_POST['amount_minor'] = '-999999';

		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'back' ), 3000 );

		unset( $_POST['delta'], $_POST['amount_minor'] );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 3750, $result->value()['total_minor'] );
	}

	/**
	 * An unknown option id is refused, not ignored.
	 */
	public function test_refuses_an_unknown_option(): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'not-mine' => 'front' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_OPTION, $result->first_error_code() );
	}

	/**
	 * An unknown value key is refused.
	 */
	public function test_refuses_an_unknown_value(): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'HACKED' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_VALUE, $result->first_error_code() );
	}

	/**
	 * A missing required option is refused.
	 */
	public function test_refuses_a_missing_required_option(): void {
		$result = SelectionResolver::resolve( self::sets(), array() );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_REQUIRED, $result->first_error_code() );
	}

	/**
	 * A non-scalar where a value key belongs is refused.
	 *
	 * @dataProvider provide_non_scalars
	 *
	 * @param mixed $value Something that is not a scalar.
	 */
	public function test_refuses_a_non_scalar_value( $value ): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => $value ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_NOT_SCALAR, $result->first_error_code() );
	}

	/**
	 * Shapes that are not a value key.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_non_scalars(): array {
		return array(
			'an array'       => array( array( 'front' ) ),
			'a nested array' => array( array( array( 'front' ) ) ),
			'null'           => array( null ),
			'an empty array' => array( array() ),
		);
	}

	/**
	 * Several problems are reported together, not one at a time.
	 *
	 * A customer who mistypes two fields should see both, rather than
	 * discovering the second only after fixing the first.
	 */
	public function test_collects_every_error(): void {
		$result = SelectionResolver::resolve(
			self::sets(),
			array(
				'opt-a'    => 'HACKED',
				'not-mine' => 'x',
			)
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertCount( 2, $result->get_errors() );
	}

	/**
	 * A failed required option is reported once, not twice.
	 *
	 * `opt-a` is required and its value was rejected. Reporting both
	 * `unknown_value` and `required` for the same field would be noise.
	 */
	public function test_does_not_report_the_same_field_twice(): void {
		$result = SelectionResolver::resolve( self::sets(), array( 'opt-a' => 'HACKED' ) );

		$this->assertCount( 1, $result->get_errors() );
	}

	/**
	 * An optional option may be omitted.
	 */
	public function test_allows_an_omitted_optional_option(): void {
		$result = SelectionResolver::resolve( self::sets_optional(), array() );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array(), $result->value()['deltas'] );
	}

	/**
	 * A value with no price config contributes nothing, and is not an error.
	 *
	 * A merchant may legitimately offer a free choice, and Phase 16's price
	 * types must not make Phase 11 reject configurations it cannot price yet.
	 */
	public function test_a_value_without_a_price_adds_nothing(): void {
		$result = SelectionResolver::resolve( self::sets_optional(), array( 'opt-b' => 'plain' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt-b' => 0 ), $result->value()['deltas'] );
	}

	/**
	 * A price type this phase does not implement contributes nothing.
	 *
	 * `percentage` arrives in Phase 16. Until then it must not be silently
	 * treated as a fixed amount — 500 basis points is not 500 minor units.
	 */
	public function test_an_unimplemented_price_type_adds_nothing(): void {
		$result = SelectionResolver::resolve( self::sets_optional(), array( 'opt-b' => 'percent' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( array( 'opt-b' => 0 ), $result->value()['deltas'] );
	}

	/**
	 * A malformed config does not crash the resolver.
	 *
	 * The cache holds whatever the cloud last sent. A set without groups, or an
	 * option without an id, must be skipped rather than fatal — a storefront
	 * that white-screens on a bad publish is worse than one that refuses a
	 * selection.
	 */
	public function test_tolerates_a_malformed_config(): void {
		$result = SelectionResolver::resolve(
			array(
				array( 'id' => 'broken' ),
				array( 'groups' => array( array( 'options' => array( array( 'no-id' => true ) ) ) ) ),
			),
			array()
		);

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * One required radio, plus a discount value for the clamp test.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	/**
	 * A product with one file option.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function sets_file(): array {
		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array(
								'id'          => 'opt-f',
								'type'        => 'file_input',
								'value_kind'  => 'file',
								'label'       => 'Artwork',
								'is_required' => false,
								'values'      => array(),
							),
						),
					),
				),
			),
		);
	}

	/**
	 * 🔴 **Without a `file` branch a file option could not be bought at all.**
	 *
	 * A `file` kind matched none of the type branches, so the token fell through
	 * to the merchant's value set — which a file option does not have — and every
	 * upload was refused with `unknown_value`. The whole upload subsystem was
	 * complete and correct while the customer could not add the product to their
	 * cart.
	 */
	public function test_a_file_token_resolves(): void {
		$result = SelectionResolver::resolve( self::sets_file(), array( 'opt-f' => str_repeat( 'a', 64 ) ) );

		$this->assertTrue( $result->is_ok(), 'An uploaded file must be buyable.' );
	}

	/**
	 * ⚠️ **Shape is all `Engine/` can check.** It is pure — no WordPress, no
	 * database — so whether the token names a real file is settled once at
	 * add-to-cart by `Upload\UploadTokenCheck`. What is checkable here is that
	 * the value is a token rather than something a customer typed.
	 */
	public function test_a_value_that_is_not_a_token_is_refused_for_a_file_option(): void {
		$result = SelectionResolver::resolve( self::sets_file(), array( 'opt-f' => 'not-a-token' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_VALUE, $result->first_error_code() );
	}

	/** An unanswered file option is "not answered", as an empty text field is. */
	public function test_an_empty_file_option_is_not_answered(): void {
		$this->assertTrue(
			SelectionResolver::resolve( self::sets_file(), array( 'opt-f' => '' ) )->is_ok()
		);
	}

	private static function sets(): array {
		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array(
								'id'          => 'opt-a',
								'type'        => 'radio',
								'is_required' => true,
								'values'      => array(
									self::value( 'front', 500 ),
									self::value( 'back', 750 ),
									self::value( 'discount', -5000 ),
								),
							),
						),
					),
				),
			),
		);
	}

	/**
	 * One optional option: a free value and an unimplemented price type.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function sets_optional(): array {
		return array(
			array(
				'id'     => 'set-2',
				'groups' => array(
					array(
						'id'      => 'group-b',
						'options' => array(
							array(
								'id'     => 'opt-b',
								'type'   => 'radio',
								'values' => array(
									array( 'value_key' => 'plain' ),
									array(
										'value_key'    => 'percent',
										'price_config' => array(
											'type'         => 'percentage',
											'basis_points' => 500,
										),
									),
								),
							),
						),
					),
				),
			),
		);
	}

	/**
	 * One fixed-price value.
	 *
	 * @param string $key   Value key.
	 * @param int    $minor Amount in minor units.
	 * @return array<string, mixed>
	 */
	private static function value( string $key, int $minor ): array {
		return array(
			'value_key'    => $key,
			'label'        => ucfirst( $key ),
			'price_config' => array(
				'type'         => 'fixed',
				'amount_minor' => $minor,
			),
		);
	}

	/**
	 * A set holding one free-text option.
	 *
	 * `value_kind: text` and **no values** — which is what makes it text. The
	 * lookup every other type relies on has nothing to look in.
	 *
	 * @param bool $required Whether the option must be answered.
	 */
	/**
	 * One option set holding a single text option.
	 *
	 * @param bool                 $required Whether the option is required.
	 * @param array<string, mixed> $extras   Extra option fields (pricing, validation).
	 */
	private static function text_sets( bool $required = false, array $extras = array() ): array {
		return array(
			array(
				'id'     => 'set-1',
				'groups' => array(
					array(
						'id'      => 'group-a',
						'options' => array(
							array_merge(
								array(
									'id'          => 'opt-t',
									'type'        => 'text_field',
									'label'       => 'Engraving',
									'value_kind'  => 'text',
									'is_required' => $required,
									'values'      => array(),
								),
								$extras
							),
						),
					),
				),
			),
		);
	}

	/** What a customer types is accepted, priced at nothing, and labelled as itself. */
	public function test_free_text_is_accepted_without_a_value_set(): void {
		$result = SelectionResolver::resolve( self::text_sets(), array( 'opt-t' => 'Happy Birthday Mum' ) );

		$this->assertTrue( $result->is_ok(), 'Typed text must not be refused as an unknown value.' );
		$this->assertSame( 'Happy Birthday Mum', $result->value()['resolved']['opt-t'] );

		$labels = $result->value()['labels'];
		$this->assertSame( 'Engraving', $labels['opt-t']['option'] );
		$this->assertSame( 'Happy Birthday Mum', $labels['opt-t']['value'] );
	}

	/**
	 * 🔴 **What is stored and what is charged must be the same string.**
	 *
	 * `Text::measure()` (M11.1a) is the normative count behind `per_char`
	 * pricing, the character counter and `min_length`/`max_length`. If the
	 * resolver stores a *different* string from the one measured, the customer
	 * is charged for characters that were never saved.
	 *
	 * That is exactly what the first implementation did: `clean_text()` folded
	 * `\s+` to a single space, collapsing runs of ordinary spaces, while
	 * `Text::normalise()` deliberately keeps them — *"the space between the names
	 * is cut into the material"*. Measured, `"AB  CD"` stored as 5 graphemes and
	 * measured as **6**.
	 *
	 * This is the M14.4b credibility bug (counter and price disagreeing) from the
	 * other direction, and it would have shipped the moment a merchant put
	 * `per_char` pricing on a text option.
	 *
	 * @dataProvider provide_measurable_text
	 */
	public function test_stored_text_measures_the_same_as_the_input( string $raw, string $expected ): void {
		$result = SelectionResolver::resolve( self::text_sets(), array( 'opt-t' => $raw ) );

		$this->assertTrue( $result->is_ok() );
		$stored = $result->value()['resolved']['opt-t'];

		$this->assertSame( $expected, $stored );
		$this->assertSame(
			Text::measure( $raw ),
			Text::measure( $stored ),
			'A per_char price computed on the input must match the stored text.'
		);
	}

	/**
	 * Inputs where collapsing whitespace would change the count.
	 *
	 * @return array<string, array{string, string}>
	 */
	public static function provide_measurable_text(): array {
		return array(
			// 🔴 The regression: a run of spaces is engraved, so it is kept.
			'double inner space'   => array( 'AB  CD', 'AB  CD' ),
			'name with one space'  => array( 'John Smith', 'John Smith' ),
			'name with two'        => array( 'John  Smith', 'John  Smith' ),

			// Structure folds to a single space: an engraving is one line.
			'tab is structure'     => array( "AB\tCD", 'AB CD' ),
			'newline is structure' => array( "AB\nCD", 'AB CD' ),

			// Ends are a typing artefact and engrave nothing.
			'outer whitespace'     => array( '  AB CD  ', 'AB CD' ),
			'trailing nbsp'        => array( "AB\u{00A0}", 'AB' ),
		);
	}

	/**
	 * 🔴 **The security case: text is the first value a customer supplies.**
	 *
	 * Every value before it had to match a merchant-authored `value_key`, which
	 * is what made `AddToCartRequest`'s *"nothing here is trusted"* survivable.
	 * A text option removes that, so the boundary moves here.
	 */
	public function test_free_text_is_stripped_of_markup(): void {
		$result = SelectionResolver::resolve(
			self::text_sets(),
			array( 'opt-t' => '<script>alert(1)</script>Bob' )
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame(
			'Bob',
			$result->value()['resolved']['opt-t'],
			'Script *contents* must go too, not merely the tags around them.'
		);
		$this->assertStringNotContainsString( '<', $result->value()['resolved']['opt-t'] );
	}

	/**
	 * ⚠️ **Pins the parity claim `clean_text()` is built on.**
	 *
	 * The engine may not call `wp_strip_all_tags()` — `bin/check-architecture.sh`
	 * keeps `src/Engine/` WordPress-free — so it reimplements it. That is only
	 * safe while the two agree, and nothing else would notice if they stopped.
	 *
	 * The expectations below are WordPress core's own two steps, run against the
	 * inputs where a bare `strip_tags()` differs: it would leave `alert(1)` and
	 * `body{x:1}` behind as visible text on the order.
	 *
	 * @dataProvider provide_markup
	 */
	public function test_clean_text_matches_wp_strip_all_tags( string $raw, string $expected ): void {
		$result = SelectionResolver::resolve( self::text_sets(), array( 'opt-t' => $raw ) );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.strip_tags_strip_tags -- this IS wp_strip_all_tags(), copied from core as the oracle; calling it would compare the engine against itself.
		$wp = trim( strip_tags( (string) preg_replace( '@<(script|style)[^>]*?>.*?</\\1>@si', '', $raw ) ) );

		$this->assertSame( $expected, $wp, 'Fixture must match WordPress core.' );
		$this->assertSame( $expected, $result->value()['resolved']['opt-t'] ?? '' );
	}

	/**
	 * Inputs where a bare `strip_tags()` differs from WordPress core.
	 *
	 * @return array<string, array{string, string}>
	 */
	public static function provide_markup(): array {
		return array(
			'script contents dropped' => array( '<script>alert(1)</script>Bob', 'Bob' ),
			'style contents dropped'  => array( '<style>body{x:1}</style>Bob', 'Bob' ),
			'plain tag unwrapped'     => array( '<b>Bob</b>', 'Bob' ),
			'attributes gone'         => array( '<a href="x" onclick="y">Bob</a>', 'Bob' ),

			/*
			 * 🔴 **The `i` in `@si` is load-bearing.** Dropping it lets
			 * `<SCRIPT>alert(1)</SCRIPT>` through the pre-pass, and
			 * `strip_tags()` then leaves `alert(1)` behind as visible text on
			 * the order. A mutant that removed the flag survived until this row
			 * existed — every other fixture is lowercase.
			 */
			'uppercase stripped too'  => array( '<SCRIPT>alert(1)</SCRIPT>Bob', 'Bob' ),

			/*
			 * 🔴 **So is the `s`.** Without it `.` stops at a newline, so a
			 * payload broken across lines never matches the pre-pass and
			 * survives as text. This mutant also lived until the fixture did.
			 *
			 * Both flag rows exist because a mutant proved the flag mattered —
			 * an earlier probe of these same flags read "no difference" and was
			 * wrong: its shell escaping had mangled the `\1` backreference, so
			 * *nothing* matched and every variant looked identical.
			 */
			'newline in payload'      => array( "<script>alert(\n1)</script>Bob", 'Bob' ),
		);
	}

	/**
	 * A tag broken by an embedded null is still refused.
	 *
	 * ✏️ **This was written to prove the strip order mattered, and it does not.**
	 * A mutant swapping the two steps survived, and measuring three
	 * control-character placements showed `strip_tags()` handles them identically
	 * either way. The assertion is kept because the *input* is a real probe — a
	 * customer typing it must not produce markup — but the ordering claim it was
	 * written for is withdrawn.
	 */
	public function test_free_text_cannot_be_assembled_into_a_tag(): void {
		$result = SelectionResolver::resolve(
			self::text_sets(),
			array( 'opt-t' => "<scr\0ipt>x</scr\0ipt>" )
		);

		$this->assertStringNotContainsString( '<script', $result->value()['resolved']['opt-t'] ?? '' );
	}

	/**
	 * Line breaks collapse and the ends are trimmed; **runs of spaces survive**.
	 *
	 * ✏️ **This test previously expected `'Two Lines here'`** — every run of
	 * whitespace folded to one space. That was changed, not because the old
	 * behaviour looked wrong, but because it disagreed with `Text::normalise()`,
	 * and the disagreement charged a customer for characters that were never
	 * stored. See `test_stored_text_measures_the_same_as_the_input`.
	 *
	 * An engraving is still one line — that half of the original intent stands,
	 * and the newline here proves it.
	 */
	public function test_free_text_line_breaks_collapse_but_spaces_survive(): void {
		$result = SelectionResolver::resolve(
			self::text_sets(),
			array( 'opt-t' => "  Two\n\nLines   here  " )
		);

		$this->assertSame( 'Two Lines   here', $result->value()['resolved']['opt-t'] );
	}

	/**
	 * One option set holding a single number option.
	 *
	 * @param array<string, mixed> $validation Validation rules.
	 * @return array<int, array<string, mixed>>
	 */
	private static function number_sets( array $validation = array() ): array {
		return array(
			array(
				'id'     => 's1',
				'groups' => array(
					array(
						'id'      => 'g1',
						'options' => array(
							array(
								'id'          => 'opt-n',
								'type'        => 'number_field',
								'label'       => 'Quantity',
								'value_kind'  => 'number',
								'is_required' => false,
								'values'      => array(),
								'validation'  => $validation,
							),
						),
					),
				),
			),
		);
	}

	/**
	 * 🔴 **A number is stored canonically, not as the customer spelled it.**
	 *
	 * `"007"`, `"7"` and `"7.0"` are one quantity written three ways. Storing the
	 * spelling would put three different strings on three otherwise identical
	 * orders — and `CartItemKey` hashes the payload, so it would also stop them
	 * grouping into a single cart line.
	 *
	 * @dataProvider provide_canonical_numbers
	 *
	 * @param string $typed  What the customer submitted.
	 * @param string $stored What must be stored.
	 */
	public function test_a_number_is_stored_canonically( string $typed, string $stored ): void {
		$result = SelectionResolver::resolve( self::number_sets(), array( 'opt-n' => $typed ) );

		$this->assertTrue( $result->is_ok(), "{$typed} should be accepted." );
		$this->assertSame( $stored, $result->value()['resolved']['opt-n'] );
	}

	/**
	 * Spellings that mean the same quantity.
	 *
	 * @return array<string, array{string, string}>
	 */
	public static function provide_canonical_numbers(): array {
		return array(
			'leading zeros' => array( '007', '7' ),
			'plain'         => array( '7', '7' ),
			'trailing .0'   => array( '7.0', '7' ),
			'trailing zero' => array( '7.50', '7.5' ),
			'explicit plus' => array( '+3', '3' ),
			'negative zero' => array( '-0', '0' ),
			'negative'      => array( '-4', '-4' ),
		);
	}

	/**
	 * ⚠️ **Stricter than `is_numeric()`, deliberately.**
	 *
	 * That function accepts `"1e3"` and leading whitespace. `Money`'s docblock
	 * records the same trap from the pricing side: `'1e3'` silently became
	 * 100000. A customer typing a quantity does not mean scientific notation, and
	 * `1,234` means one-point-two-three-four in half of Europe.
	 *
	 * @dataProvider provide_non_numbers
	 *
	 * @param string $typed Input that is not a number.
	 */
	public function test_a_non_number_is_refused( string $typed ): void {
		$result = SelectionResolver::resolve( self::number_sets(), array( 'opt-n' => $typed ) );

		$this->assertFalse( $result->is_ok(), "{$typed} must not be accepted." );
		$this->assertSame( SelectionResolver::ERROR_NOT_A_NUMBER, $result->first_error_code() );
	}

	/**
	 * Inputs a customer might type that are not numbers.
	 *
	 * @return array<string, array{string}>
	 */
	public static function provide_non_numbers(): array {
		return array(
			'letters'             => array( 'abc' ),
			'scientific notation' => array( '1e3' ),
			// phpcs:ignore PHPCompatibility.Miscellaneous.ValidIntegers.HexNumericStringFound -- a hex string is precisely what this asserts is refused.
			'hex'                 => array( '0x1A' ),
			'thousands separator' => array( '1,234' ),
			'trailing text'       => array( '12kg' ),
			'two dots'            => array( '1.2.3' ),
			'lone dot'            => array( '.' ),
			'lone sign'           => array( '-' ),
		);
	}

	/**
	 * `min` and `max` bound the value, inclusively at both ends.
	 *
	 * @dataProvider provide_bounded_numbers
	 *
	 * @param string  $typed    What the customer submitted.
	 * @param ?string $expected Expected error code, or null when accepted.
	 */
	public function test_a_number_is_bounded( string $typed, ?string $expected ): void {
		$result = SelectionResolver::resolve(
			self::number_sets(
				array(
					'min' => 5,
					'max' => 10,
				)
			),
			array( 'opt-n' => $typed )
		);

		$this->assertSame( null === $expected, $result->is_ok() );
		$this->assertSame( $expected, $result->first_error_code() );
	}

	/**
	 * Values at and around a numeric range.
	 *
	 * @return array<string, array{string, ?string}>
	 */
	public static function provide_bounded_numbers(): array {
		return array(
			'below'          => array( '4', SelectionResolver::ERROR_OUT_OF_RANGE ),
			'at the floor'   => array( '5', null ),
			'inside'         => array( '7', null ),
			'at the ceiling' => array( '10', null ),
			'above'          => array( '11', SelectionResolver::ERROR_OUT_OF_RANGE ),
		);
	}

	/** `integer_only` refuses a fraction. */
	public function test_integer_only_refuses_a_fraction(): void {
		$result = SelectionResolver::resolve(
			self::number_sets( array( 'integer_only' => true ) ),
			array( 'opt-n' => '3.5' )
		);

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_BAD_STEP, $result->first_error_code() );
	}

	/**
	 * 🔴 **`step` is compared in integer space, and the scale comes from both
	 * sides.**
	 *
	 * Floats do not divide cleanly — `0.3 / 0.1` is `2.9999999999999996`, so a
	 * naive `fmod()` refuses a value sitting exactly on the step.
	 *
	 * ✏️ **And scaling by the step alone is not enough**: measured, `0.35`
	 * against a step of `0.1` scaled to `round(3.5) = 4`, divided cleanly, and
	 * was **accepted** — the rounding meant to avoid float error reintroduced the
	 * bug it was there to prevent. The scale now comes from the larger of the two
	 * precisions.
	 *
	 * @dataProvider provide_stepped_numbers
	 *
	 * @param array<string, mixed> $rules    Validation rules.
	 * @param string               $typed    What the customer submitted.
	 * @param bool                 $accepted Whether it should be accepted.
	 */
	public function test_a_number_honours_its_step( array $rules, string $typed, bool $accepted ): void {
		$result = SelectionResolver::resolve( self::number_sets( $rules ), array( 'opt-n' => $typed ) );

		$this->assertSame( $accepted, $result->is_ok(), "{$typed} against " . wp_json_encode( $rules ) );
	}

	/**
	 * Values on and off a step grid, including the float case.
	 *
	 * @return array<string, array{array<string, mixed>, string, bool}>
	 */
	public static function provide_stepped_numbers(): array {
		return array(
			'on the step'        => array( array( 'step' => 5 ), '10', true ),
			'off the step'       => array( array( 'step' => 5 ), '12', false ),
			// The offset is measured from `min`: 5, 15, 25 — not 10 and 20.
			'stepped from a min' => array(
				array(
					'min'  => 5,
					'step' => 10,
				),
				'15',
				true,
			),
			'ignores the min'    => array(
				array(
					'min'  => 5,
					'step' => 10,
				),
				'10',
				false,
			),
			'float step, on'     => array( array( 'step' => 0.1 ), '0.3', true ),
			'float step, off'    => array( array( 'step' => 0.1 ), '0.35', false ),
		);
	}

	/**
	 * A malformed rule is no rule, matching how lengths are handled.
	 *
	 * @dataProvider provide_malformed_number_rules
	 *
	 * @param array<string, mixed> $rules A rule that cannot be applied.
	 */
	public function test_a_malformed_number_rule_is_ignored( array $rules ): void {
		$result = SelectionResolver::resolve( self::number_sets( $rules ), array( 'opt-n' => '7' ) );

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * Numeric rules that cannot be applied, and must therefore not be.
	 *
	 * @return array<string, array{array<string, mixed>}>
	 */
	public static function provide_malformed_number_rules(): array {
		return array(
			'non-numeric min' => array( array( 'min' => 'x' ) ),
			'zero step'       => array( array( 'step' => 0 ) ),
			'negative step'   => array( array( 'step' => -5 ) ),
		);
	}

	/** An empty number field is "not answered", exactly as an empty text one is. */
	public function test_an_empty_number_is_not_answered(): void {
		$result = SelectionResolver::resolve( self::number_sets(), array( 'opt-n' => '   ' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertArrayNotHasKey( 'opt-n', $result->value()['resolved'] );
	}

	/**
	 * One option set holding a single date-family option.
	 *
	 * @param string               $type       `date_picker`, `time_picker` or `datetime_picker`.
	 * @param array<string, mixed> $validation Date rules.
	 * @return array<int, array<string, mixed>>
	 */
	private static function date_sets( string $type = 'date_picker', array $validation = array() ): array {
		return array(
			array(
				'id'     => 's1',
				'groups' => array(
					array(
						'id'      => 'g1',
						'options' => array(
							array(
								'id'          => 'opt-d',
								'type'        => $type,
								'label'       => 'Delivery date',
								'value_kind'  => 'date',
								'is_required' => false,
								'values'      => array(),
								'validation'  => $validation,
							),
						),
					),
				),
			),
		);
	}

	/**
	 * 🔴 **A hidden field is hidden from the page, not from the customer.**
	 *
	 * Anyone with developer tools can post whatever they like for a hidden
	 * input. Measured before this branch existed: a forged `FORGED-BY-CUSTOMER`
	 * replaced the merchant's own `campaign-a`, and nothing said so.
	 *
	 * The whole value of the type is that a merchant can attach data *about* an
	 * order — a batch code, a fulfilment route, a campaign tag — and rely on it.
	 * Reading anything from the request would make it exactly as trustworthy as
	 * a URL parameter.
	 */
	public function test_a_hidden_value_cannot_be_forged(): void {
		$result = SelectionResolver::resolve(
			self::hidden_sets( 'campaign-a' ),
			array( 'opt-h' => 'FORGED-BY-CUSTOMER' )
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 'campaign-a', $result->value()['resolved']['opt-h'] );
	}

	/** The configured value is used even when nothing is posted at all. */
	public function test_a_hidden_value_needs_no_submission(): void {
		$result = SelectionResolver::resolve( self::hidden_sets( 'batch-77' ), array( 'opt-h' => '' ) );

		$this->assertSame( 'batch-77', $result->value()['resolved']['opt-h'] );
	}

	/**
	 * A hidden field with nothing configured contributes nothing.
	 *
	 * An empty line on an order is worse than no line: a fulfilment operator
	 * reads it as a field somebody forgot to fill in.
	 */
	public function test_a_hidden_field_with_no_default_is_skipped(): void {
		$result = SelectionResolver::resolve( self::hidden_sets( '' ), array( 'opt-h' => 'anything' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertArrayNotHasKey( 'opt-h', $result->value()['resolved'] );
	}

	/**
	 * ⚠️ **Merchant-authored, and still sanitised.**
	 *
	 * The value reaches a cart row and an order line like any other, so it goes
	 * through `clean_text()` — a merchant pasting markup into a campaign tag
	 * should not put markup on a customer's order.
	 */
	public function test_a_hidden_value_is_sanitised(): void {
		$result = SelectionResolver::resolve(
			self::hidden_sets( '<script>alert(1)</script>batch-9' ),
			array( 'opt-h' => 'x' )
		);

		$this->assertSame( 'batch-9', $result->value()['resolved']['opt-h'] );
	}

	/**
	 * One option set holding a single hidden option.
	 *
	 * @param string $configured What the merchant configured.
	 * @return array<int, array<string, mixed>>
	 */
	private static function hidden_sets( string $configured ): array {
		return array(
			array(
				'id'     => 's1',
				'groups' => array(
					array(
						'id'      => 'g1',
						'options' => array(
							array(
								'id'            => 'opt-h',
								'type'          => 'hidden',
								'label'         => 'Source',
								'value_kind'    => 'text',
								'is_required'   => false,
								'values'        => array(),
								'default_value' => $configured,
							),
						),
					),
				),
			),
		);
	}

	/**
	 * 🔴 **Strict parsing, not `strtotime()`.**
	 *
	 * That function accepts `"next tuesday"` and `"+3 days"`, and silently rolls
	 * `2026-02-30` forward to the second of March — a customer would be delivered
	 * on a day they never chose, and nothing would say so.
	 *
	 * The round-trip check is what catches the overflow: `createFromFormat`
	 * answers the second of March, re-formatting gives `2026-03-02`, and that is
	 * not what arrived.
	 *
	 * @dataProvider provide_dates
	 *
	 * @param string  $typed  What the customer submitted.
	 * @param ?string $stored What must be stored, or null when refused.
	 */
	public function test_a_date_is_parsed_strictly( string $typed, ?string $stored ): void {
		$result = SelectionResolver::resolve( self::date_sets(), array( 'opt-d' => $typed ) );

		if ( null === $stored ) {
			$this->assertFalse( $result->is_ok(), "{$typed} must not be accepted." );
			$this->assertSame( SelectionResolver::ERROR_NOT_A_DATE, $result->first_error_code() );

			return;
		}

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( $stored, $result->value()['resolved']['opt-d'] );
	}

	/**
	 * Inputs a date field might receive, including the ones `strtotime` ruins.
	 *
	 * @return array<string, array{string, ?string}>
	 */
	public static function provide_dates(): array {
		return array(
			'iso date'          => array( '2026-09-07', '2026-09-07' ),
			'impossible day'    => array( '2026-02-30', null ),
			'relative phrase'   => array( 'next tuesday', null ),
			'ambiguous slashes' => array( '07/09/2026', null ),
			'zero date'         => array( '0000-00-00', null ),
			'unpadded'          => array( '2026-9-7', null ),
			'trailing text'     => array( '2026-09-07 please', null ),
		);
	}

	/**
	 * ⚠️ **Precision comes from the presentation, not the kind.**
	 *
	 * All three types are `value_kind: date`. A wedding date has no time, a
	 * collection slot has no day, and an appointment needs both — so a value
	 * valid for one is refused by another.
	 *
	 * @dataProvider provide_date_precision
	 *
	 * @param string $type     The presentation.
	 * @param string $typed    What the customer submitted.
	 * @param bool   $accepted Whether it should be accepted.
	 */
	public function test_date_precision_follows_the_presentation( string $type, string $typed, bool $accepted ): void {
		$result = SelectionResolver::resolve( self::date_sets( $type ), array( 'opt-d' => $typed ) );

		$this->assertSame( $accepted, $result->is_ok(), "{$typed} against {$type}" );
	}

	/**
	 * A value valid for one precision and refused by another.
	 *
	 * @return array<string, array{string, string, bool}>
	 */
	public static function provide_date_precision(): array {
		return array(
			'date in a date field'     => array( 'date_picker', '2026-09-07', true ),
			'time in a date field'     => array( 'date_picker', '14:30', false ),
			'time in a time field'     => array( 'time_picker', '14:30', true ),
			'date in a time field'     => array( 'time_picker', '2026-09-07', false ),
			'datetime in a datetime'   => array( 'datetime_picker', '2026-09-07T14:30', true ),
			'date in a datetime field' => array( 'datetime_picker', '2026-09-07', false ),
		);
	}

	/**
	 * The four absolute rules, which need no clock.
	 *
	 * @dataProvider provide_absolute_date_rules
	 *
	 * @param array<string, mixed> $rules    The merchant's configuration.
	 * @param string               $typed    What the customer submitted.
	 * @param ?string              $expected Expected error code, or null.
	 */
	public function test_absolute_date_rules_are_enforced( array $rules, string $typed, ?string $expected ): void {
		$result = SelectionResolver::resolve( self::date_sets( 'date_picker', $rules ), array( 'opt-d' => $typed ) );

		$this->assertSame( null === $expected, $result->is_ok() );
		$this->assertSame( $expected, $result->first_error_code() );
	}

	/**
	 * The four rules that need no clock.
	 *
	 * @return array<string, array{array<string, mixed>, string, ?string}>
	 */
	public static function provide_absolute_date_rules(): array {
		return array(
			'before the season' => array(
				array( 'min_date' => '2026-09-01' ),
				'2026-08-31',
				SelectionResolver::ERROR_DATE_OUT_OF_RANGE,
			),
			'on the first day'  => array( array( 'min_date' => '2026-09-01' ), '2026-09-01', null ),
			'after the season'  => array(
				array( 'max_date' => '2026-09-30' ),
				'2026-10-01',
				SelectionResolver::ERROR_DATE_OUT_OF_RANGE,
			),
			'a closure'         => array(
				array( 'blackout_dates' => array( '2026-12-25', '2026-12-26' ) ),
				'2026-12-25',
				SelectionResolver::ERROR_DATE_UNAVAILABLE,
			),
			'not a closure'     => array(
				array( 'blackout_dates' => array( '2026-12-25' ) ),
				'2026-12-24',
				null,
			),

			// 2026-09-07 is a Monday; 2026-09-06 is a Sunday.
			'a working weekday' => array( array( 'allowed_weekdays' => array( 1, 2, 3, 4, 5 ) ), '2026-09-07', null ),
			'a closed weekend'  => array(
				array( 'allowed_weekdays' => array( 1, 2, 3, 4, 5 ) ),
				'2026-09-06',
				SelectionResolver::ERROR_DATE_UNAVAILABLE,
			),
		);
	}

	/**
	 * 🔴 **The relative rules are measured from the store's today.**
	 *
	 * A lead time is a promise about the *merchant's* working days — "we need
	 * three days to make this" — so the merchant's calendar decides, not the
	 * server's and not the customer's. A workshop in Auckland and one in Los
	 * Angeles disagree about the date for twenty-one hours a day.
	 *
	 * @dataProvider provide_relative_date_rules
	 *
	 * @param array<string, mixed> $rules    The merchant's configuration.
	 * @param string               $typed    What the customer submitted.
	 * @param bool                 $accepted Whether it should be accepted.
	 */
	public function test_relative_date_rules_measure_from_today( array $rules, string $typed, bool $accepted ): void {
		$result = SelectionResolver::resolve(
			self::date_sets( 'date_picker', $rules ),
			array( 'opt-d' => $typed ),
			0,
			'2026-09-07'
		);

		$this->assertSame( $accepted, $result->is_ok(), "{$typed} with today = 2026-09-07" );
	}

	/**
	 * Windows measured from a fixed today of 2026-09-07.
	 *
	 * @return array<string, array{array<string, mixed>, string, bool}>
	 */
	public static function provide_relative_date_rules(): array {
		return array(
			'inside the lead time'  => array( array( 'lead_time_days' => 3 ), '2026-09-09', false ),
			'exactly the lead time' => array( array( 'lead_time_days' => 3 ), '2026-09-10', true ),
			'past the lead time'    => array( array( 'lead_time_days' => 3 ), '2026-09-20', true ),
			'within the horizon'    => array( array( 'max_advance_days' => 30 ), '2026-10-01', true ),
			'beyond the horizon'    => array( array( 'max_advance_days' => 30 ), '2026-12-01', false ),
			'inside both'           => array(
				array(
					'lead_time_days'   => 3,
					'max_advance_days' => 30,
				),
				'2026-09-15',
				true,
			),
		);
	}

	/**
	 * 🔴 **With no clock, the relative rules do not apply — and nothing else changes.**
	 *
	 * The safe direction: a caller with no clock must not refuse every date a
	 * merchant's lead time would have allowed. The absolute rules still hold,
	 * because they never needed one.
	 */
	public function test_without_a_clock_only_the_relative_rules_lapse(): void {
		$rules = array(
			'lead_time_days' => 30,
			'min_date'       => '2026-09-01',
		);

		$lapsed = SelectionResolver::resolve(
			self::date_sets( 'date_picker', $rules ),
			array( 'opt-d' => '2026-09-08' )
		);
		$this->assertTrue( $lapsed->is_ok(), 'A lead time without a clock cannot refuse anything.' );

		$absolute = SelectionResolver::resolve(
			self::date_sets( 'date_picker', $rules ),
			array( 'opt-d' => '2026-08-01' )
		);
		$this->assertFalse( $absolute->is_ok(), 'min_date needs no clock and must still apply.' );
	}

	/** An empty date field is "not answered", exactly as an empty text one is. */
	public function test_an_empty_date_is_not_answered(): void {
		$result = SelectionResolver::resolve( self::date_sets(), array( 'opt-d' => '   ' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertArrayNotHasKey( 'opt-d', $result->value()['resolved'] );
	}

	/**
	 * 🔴 **A catastrophic pattern must not hang, and must not refuse everything.**
	 *
	 * `/^(a+)+$/` against 40 non-matching characters is the textbook ReDoS. PHP's
	 * `pcre.backtrack_limit` bounds it — measured at **3 ms** — but the bailout
	 * returns `false`, which is what a *genuine* non-match looks like to a naive
	 * `! preg_match()`.
	 *
	 * So the danger is not the hang. It is that a merchant's own pattern would
	 * **refuse every answer**, silently, on inputs slightly longer than the ones
	 * they tested. An engine error means *the rule could not be applied*, and an
	 * unapplicable rule is no rule.
	 */
	public function test_a_catastrophic_pattern_neither_hangs_nor_refuses(): void {
		$started = microtime( true );

		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'pattern' => '^(a+)+$' ) ) ),
			array( 'opt-t' => str_repeat( 'a', 40 ) . 'X' )
		);

		$elapsed = ( microtime( true ) - $started ) * 1000;

		$this->assertTrue( $result->is_ok(), 'A rule that could not be applied must not refuse the answer.' );
		$this->assertLessThan( 1000, $elapsed, 'The backtrack budget must bound this.' );
	}

	/**
	 * A pattern the customer's text matches is accepted; one it does not is refused.
	 *
	 * @dataProvider provide_patterns
	 *
	 * @param string  $pattern  The merchant's rule.
	 * @param string  $typed    What the customer submitted.
	 * @param ?string $expected Expected error code, or null when accepted.
	 */
	public function test_a_pattern_is_enforced( string $pattern, string $typed, ?string $expected ): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'pattern' => $pattern ) ) ),
			array( 'opt-t' => $typed )
		);

		$this->assertSame( null === $expected, $result->is_ok() );
		$this->assertSame( $expected, $result->first_error_code() );
	}

	/**
	 * Patterns a merchant would plausibly write.
	 *
	 * @return array<string, array{string, string, ?string}>
	 */
	public static function provide_patterns(): array {
		return array(
			'matches'          => array( '^[A-Z]{2}[0-9]{2}$', 'AB12', null ),
			'does not match'   => array( '^[A-Z]{2}[0-9]{2}$', 'ab12', SelectionResolver::ERROR_PATTERN ),
			'anchored partial' => array( '^[0-9]+$', '12a', SelectionResolver::ERROR_PATTERN ),

			/*
			 * ⚠️ **A rule that cannot be applied is no rule** — the same stance
			 * every malformed rule in this class takes. An invalid pattern or one
			 * past the length cap must not refuse every answer a customer gives.
			 */
			'invalid pattern'  => array( '[unclosed', 'anything', null ),
		);
	}

	/** An over-long pattern is ignored rather than applied. */
	public function test_an_over_long_pattern_is_ignored(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'pattern' => str_repeat( 'a', 300 ) ) ) ),
			array( 'opt-t' => 'x' )
		);

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * ⚠️ **A stored pattern brings no modifiers of its own.**
	 *
	 * The body is delimited here and given `Du` — a pattern arriving with its own
	 * delimiters and flags would be configuration choosing PCRE behaviour, and
	 * `/foo/e` once meant *eval*.
	 */
	public function test_a_pattern_cannot_smuggle_modifiers(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'pattern' => '^abc$/i' ) ) ),
			array( 'opt-t' => 'ABC' )
		);

		$this->assertFalse( $result->is_ok(), 'A trailing /i must not make the match case-insensitive.' );
	}

	/**
	 * `allowed_charset` refuses characters outside its named set.
	 *
	 * @dataProvider provide_charsets
	 *
	 * @param string  $charset  The named set.
	 * @param string  $typed    What the customer submitted.
	 * @param ?string $expected Expected error code, or null when accepted.
	 */
	public function test_a_charset_is_enforced( string $charset, string $typed, ?string $expected ): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'allowed_charset' => $charset ) ) ),
			array( 'opt-t' => $typed )
		);

		$this->assertSame( null === $expected, $result->is_ok() );
		$this->assertSame( $expected, $result->first_error_code() );
	}

	/**
	 * Each named set, passing and failing.
	 *
	 * @return array<string, array{string, string, ?string}>
	 */
	public static function provide_charsets(): array {
		return array(
			'alpha ok'                   => array( 'alpha', 'Bob', null ),
			'alpha rejects digits'       => array( 'alpha', 'Bob1', SelectionResolver::ERROR_CHARSET ),
			'alphanumeric ok'            => array( 'alphanumeric', 'Bob1', null ),
			'alphanumeric rejects space' => array( 'alphanumeric', 'Bob Smith', SelectionResolver::ERROR_CHARSET ),
			'numeric ok'                 => array( 'numeric', '1234', null ),
			'numeric rejects letters'    => array( 'numeric', 'abc', SelectionResolver::ERROR_CHARSET ),

			// A name is not alphanumeric — apostrophes and hyphens are ordinary.
			'latin ok'                   => array( 'latin', "O'Brien-Smith 2", null ),
			'latin rejects emoji'        => array( 'latin', 'Bob 🎉', SelectionResolver::ERROR_CHARSET ),

			// An unrecognised set is no rule, not a refusal of everything.
			'unknown set'                => array( 'klingon', 'anything at all', null ),
		);
	}

	/**
	 * 🔴 **A forbidden word is matched as a substring, case-insensitively.**
	 *
	 * A merchant forbidding a slur means it however it is spelled around, and a
	 * word-boundary match would let padding defeat the list.
	 *
	 * @dataProvider provide_forbidden
	 *
	 * @param array<int, string> $words    The merchant's list.
	 * @param string             $typed    What the customer submitted.
	 * @param ?string            $expected Expected error code, or null.
	 */
	public function test_forbidden_words_are_enforced( array $words, string $typed, ?string $expected ): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'forbidden_words' => $words ) ) ),
			array( 'opt-t' => $typed )
		);

		$this->assertSame( null === $expected, $result->is_ok() );
		$this->assertSame( $expected, $result->first_error_code() );
	}

	/**
	 * Merchant word lists, and text that does or does not trip them.
	 *
	 * @return array<string, array{array<int, string>, string, ?string}>
	 */
	public static function provide_forbidden(): array {
		return array(
			'clean'          => array( array( 'badword' ), 'Happy Birthday', null ),
			'exact'          => array( array( 'badword' ), 'badword', SelectionResolver::ERROR_FORBIDDEN_WORD ),
			'different case' => array( array( 'badword' ), 'a BADWORD here', SelectionResolver::ERROR_FORBIDDEN_WORD ),
			'padded'         => array( array( 'badword' ), 'xxbadwordxx', SelectionResolver::ERROR_FORBIDDEN_WORD ),
			'second in list' => array( array( 'one', 'two' ), 'says two', SelectionResolver::ERROR_FORBIDDEN_WORD ),
			'empty list'     => array( array(), 'anything', null ),
			'blank entry'    => array( array( '', '   ' ), 'anything', null ),
		);
	}

	/**
	 * ⚠️ **The forbidden word is never echoed back.**
	 *
	 * The params reach a customer-facing message, and repeating a slur to the
	 * customer who typed it is not an improvement.
	 */
	public function test_a_forbidden_word_is_not_echoed_back(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'forbidden_words' => array( 'secretword' ) ) ) ),
			array( 'opt-t' => 'a secretword here' )
		);

		$errors = $result->get_errors();
		$this->assertSame( array(), $errors[0]['params'] );
	}

	/**
	 * 🔴 **`min_length` is not the same failure as `required`.**
	 *
	 * A customer who typed "Hi" into a field demanding five characters *answered
	 * it* — they simply have to say more. Reporting `ERROR_REQUIRED` would send
	 * them looking for a field they already filled, which is the worst kind of
	 * validation message: technically triggered, practically misleading.
	 *
	 * A minimum is a workshop saying "this is not worth setting up for one
	 * letter", so the constraint is real rather than cosmetic.
	 */
	public function test_text_below_min_length_is_refused(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'min_length' => 5 ) ) ),
			array( 'opt-t' => 'Hi!' )
		);

		$this->assertFalse( $result->is_ok() );
		$errors = $result->get_errors();
		$this->assertSame( SelectionResolver::ERROR_TOO_SHORT, $errors[0]['code'] );
		$this->assertSame( 5, $errors[0]['params']['min'] );
		$this->assertSame( 3, $errors[0]['params']['actual'], 'The message must name what they entered.' );
	}

	/** Exactly at the minimum is accepted: the bound is inclusive. */
	public function test_text_at_min_length_is_accepted(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'min_length' => 5 ) ) ),
			array( 'opt-t' => 'Hello' )
		);

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * A minimum and a maximum together describe a window, and both ends hold.
	 *
	 * @dataProvider provide_length_window
	 *
	 * @param string  $text     What the customer typed.
	 * @param ?string $expected Expected error code, or null when accepted.
	 */
	public function test_a_length_window_holds_at_both_ends( string $text, ?string $expected ): void {
		$result = SelectionResolver::resolve(
			self::text_sets(
				false,
				array(
					'validation' => array(
						'min_length' => 5,
						'max_length' => 10,
					),
				)
			),
			array( 'opt-t' => $text )
		);

		$this->assertSame( null === $expected, $result->is_ok() );
		$this->assertSame( $expected, $result->first_error_code() );
	}

	/**
	 * Lengths at and around a min/max window.
	 *
	 * @return array<string, array{string, ?string}>
	 */
	public static function provide_length_window(): array {
		return array(
			'under the window' => array( 'Hi', SelectionResolver::ERROR_TOO_SHORT ),
			'at the floor'     => array( 'Hello', null ),
			'inside'           => array( 'Just right', null ),
			'at the ceiling'   => array( '1234567890', null ),
			'over the window'  => array( 'Far too long here', SelectionResolver::ERROR_TOO_LONG ),
		);
	}

	/**
	 * A malformed minimum is no minimum, matching `max_length`'s handling.
	 *
	 * A rule that cannot be read must not refuse every answer a customer gives —
	 * the failure direction that takes a storefront down.
	 *
	 * @dataProvider provide_malformed_limits
	 *
	 * @param mixed $limit A `min_length` that cannot be applied.
	 */
	public function test_a_malformed_min_length_is_ignored( $limit ): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'min_length' => $limit ) ) ),
			array( 'opt-t' => 'x' )
		);

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * 🔴 **`max_length` is refused, never truncated.**
	 *
	 * Truncating would charge a customer for text they can read on the page and
	 * will not receive in the material — they find out when the parcel arrives.
	 * `clean_text()` records the decision; this is the refusal it defers to.
	 */
	public function test_text_over_max_length_is_refused(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'max_length' => 5 ) ) ),
			array( 'opt-t' => 'Much too long' )
		);

		$this->assertFalse( $result->is_ok() );
		$errors = $result->get_errors();
		$this->assertSame( SelectionResolver::ERROR_TOO_LONG, $errors[0]['code'] );
		$this->assertSame( 'opt-t', $errors[0]['field'] );
		$this->assertSame( 5, $errors[0]['params']['max'] );
		$this->assertSame( 13, $errors[0]['params']['actual'], 'The message must name what they entered.' );
	}

	/** Exactly at the limit is accepted: the bound is inclusive. */
	public function test_text_at_max_length_is_accepted(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'max_length' => 5 ) ) ),
			array( 'opt-t' => 'Mumsy' )
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 'Mumsy', $result->value()['resolved']['opt-t'] );
	}

	/**
	 * 🔴 **Graphemes, not bytes — the limit means what the counter shows.**
	 *
	 * A family emoji is five code points and eighteen bytes, and **one
	 * character**: one mark in the engraved material. `strlen()` would refuse
	 * this at a limit of 3; `measure()` counts 2.
	 *
	 * This is the whole reason M11.1a exists as one shared function, and the
	 * assertion that fails if the enforcement ever reaches for a cheaper count.
	 */
	public function test_max_length_counts_graphemes_not_bytes(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'max_length' => 3 ) ) ),
			array( 'opt-t' => "A\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}" )
		);

		$this->assertTrue( $result->is_ok(), 'Two graphemes must fit a limit of three.' );
	}

	/**
	 * ⚠️ **Measured after sanitising, because that is what is stored.**
	 *
	 * The markup is stripped before counting, so an answer whose *stored* form
	 * fits is accepted even though what the customer typed was longer. Refusing
	 * on the raw string would reject an engraving on the strength of characters
	 * that were removed and never charged for.
	 */
	public function test_max_length_measures_the_sanitised_text(): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'max_length' => 3 ) ) ),
			array( 'opt-t' => '<b>Mum</b>' )
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 'Mum', $result->value()['resolved']['opt-t'] );
	}

	/**
	 * A malformed limit is no limit.
	 *
	 * A rule that cannot be read must not refuse every answer a customer gives:
	 * that is the failure direction that takes a storefront down, and the
	 * milestone's own rule is that an evaluator meeting something it cannot
	 * apply does not fail the line.
	 *
	 * @dataProvider provide_malformed_limits
	 *
	 * @param mixed $limit A `max_length` that cannot be applied.
	 */
	public function test_a_malformed_max_length_is_ignored( $limit ): void {
		$result = SelectionResolver::resolve(
			self::text_sets( false, array( 'validation' => array( 'max_length' => $limit ) ) ),
			array( 'opt-t' => 'Much too long for any sane limit' )
		);

		$this->assertTrue( $result->is_ok() );
	}

	/**
	 * Limits that cannot be applied, and must therefore not be.
	 *
	 * @return array<string, array{mixed}>
	 */
	public static function provide_malformed_limits(): array {
		return array(
			'zero'     => array( 0 ),
			'negative' => array( -5 ),
			'a string' => array( '5' ),
			'null'     => array( null ),
			'a float'  => array( 5.5 ),
		);
	}

	/**
	 * 🔴 **A price this build cannot charge must be named, not swallowed.**
	 *
	 * Option-level pricing hangs on the **option** rather than on a chosen
	 * value, and the text branch returns before `delta_for()` — the function
	 * that does all the `$unpriced` bookkeeping. So a merchant could configure
	 * an option-level price, publish it, and sell it for free with nothing in
	 * the cart notice or the admin notice saying so.
	 *
	 * Strictly worse than the case that motivated that machinery: a 50%
	 * surcharge charged nothing and *at least appeared in the notice*.
	 *
	 * The example is `tiered` rather than `per_char` since M16.2 — `per_char` is
	 * now charged, and a test asserting it is unpriceable would assert the
	 * opposite of what the build does. `tiered` has no evaluator in any phase.
	 */
	public function test_option_level_pricing_is_reported_as_unpriced(): void {
		$result = SelectionResolver::resolve(
			self::text_sets(
				false,
				array(
					'pricing' => array(
						'type' => 'tiered',
					),
				)
			),
			array( 'opt-t' => 'Mum' )
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 0, $result->value()['total_minor'], 'A type with no evaluator must not be guessed at.' );
		$this->assertSame( array( 'tiered' ), $result->value()['unpriced'] );
	}

	/**
	 * 🔴 `per_char` is charged, and is NOT reported as unpriced.
	 *
	 * The counterpart to the test above, and the reason it had to change. Before
	 * M16.2 a merchant could configure engraving at 0.50/character, publish, and
	 * sell it for free — the notice said so, which was honest but not a feature.
	 *
	 * Asserted together with `unpriced` because charging correctly while telling
	 * the merchant the option is going uncharged trains them to disregard a
	 * notice that is right the next time.
	 */
	public function test_per_char_is_charged_rather_than_reported(): void {
		$result = SelectionResolver::resolve(
			self::text_sets(
				false,
				array(
					'pricing' => array(
						'type'         => 'per_char',
						'amount_minor' => 50,
					),
				)
			),
			array( 'opt-t' => 'Mum' )
		);

		$this->assertTrue( $result->is_ok() );
		$this->assertSame( 150, $result->value()['total_minor'], 'Three characters at 0.50 each.' );
		$this->assertSame( array(), $result->value()['unpriced'] );
	}

	/**
	 * ⚠️ **`fixed` at option level is not reported, and is not charged either.**
	 *
	 * It is excluded for the same reason `delta_for()` excludes it: `fixed` is
	 * the one type this phase implements, so calling it "unpriced" would put a
	 * warning in front of a merchant about a type that works — and a notice that
	 * fires on working configuration is one they learn to dismiss.
	 *
	 * It is not *charged* here either: `PRICING-SPEC.md` prices `fixed` **per
	 * value**, and an option-level `fixed` has no defined meaning, so this build
	 * must not invent a rule for it. A mutant that dropped the exclusion survived
	 * until this test existed.
	 */
	public function test_option_level_fixed_is_neither_charged_nor_reported(): void {
		$result = SelectionResolver::resolve(
			self::text_sets(
				false,
				array(
					'pricing' => array(
						'type'         => 'fixed',
						'amount_minor' => 500,
					),
				)
			),
			array( 'opt-t' => 'Mum' )
		);

		$this->assertSame( array(), $result->value()['unpriced'], 'A type this build prices is not "unpriced".' );
		$this->assertSame( 0, $result->value()['total_minor'] );
	}

	/**
	 * A text option with no pricing reports nothing.
	 *
	 * The common case, and the one that would break if the reporting were
	 * unconditional: a free engraving is not an unpriced one, and a notice that
	 * fires for every text option is a notice merchants learn to ignore.
	 */
	public function test_a_text_option_without_pricing_reports_nothing(): void {
		$result = SelectionResolver::resolve( self::text_sets(), array( 'opt-t' => 'Mum' ) );

		$this->assertSame( array(), $result->value()['unpriced'] );
	}

	/**
	 * 🔴 **Empty is "not answered", not "answered with nothing".**
	 *
	 * A required text option must fail the way an unselected radio does. Without
	 * this a customer could submit spaces and satisfy a required engraving,
	 * paying for a blank one.
	 */
	public function test_a_required_text_option_refuses_empty_input(): void {
		$result = SelectionResolver::resolve( self::text_sets( true ), array( 'opt-t' => '   ' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_REQUIRED, $result->get_errors()[0]['code'] );
	}

	/** And an optional one simply contributes no line. */
	public function test_an_optional_text_option_ignores_empty_input(): void {
		$result = SelectionResolver::resolve( self::text_sets(), array( 'opt-t' => '' ) );

		$this->assertTrue( $result->is_ok() );
		$this->assertArrayNotHasKey( 'opt-t', $result->value()['resolved'] );
	}

	/**
	 * ⚠️ **An unknown `value_kind` falls back to the lookup, and is refused.**
	 *
	 * The safe direction: a kind this engine does not recognise must not be
	 * treated as free text, or a typo in the document would accept arbitrary
	 * input for an option nobody meant to be free.
	 */
	public function test_an_unrecognised_value_kind_is_not_free_text(): void {
		$sets = self::text_sets();
		$sets[0]['groups'][0]['options'][0]['value_kind'] = 'mystery';

		$result = SelectionResolver::resolve( $sets, array( 'opt-t' => 'anything' ) );

		$this->assertFalse( $result->is_ok() );
		$this->assertSame( SelectionResolver::ERROR_UNKNOWN_VALUE, $result->get_errors()[0]['code'] );
	}
}
