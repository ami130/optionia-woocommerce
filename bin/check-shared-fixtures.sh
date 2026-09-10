#!/usr/bin/env bash
#
# Shared cross-repository fixtures.
#
# Two implementations of the same pricing rules live in separate git
# repositories, and CI checks out **one at a time** -- every `actions/checkout`
# in both workflows is bare, with no `repository:` parameter. So neither test
# suite can read a file belonging to the other, and M11.4's "one shared fixture
# executed by both" cannot be literally one file.
#
# It is a vendored copy in each repository, and this gate is what stops the two
# drifting. A package would need one per language versioned in lockstep, and
# generation can only run locally because of the same checkout constraint --
# both defer detection to a step someone has to remember. A gate fails in the
# repository where the edit was made, which is where the person who can fix it
# is standing.
#
# ## Why the count as well as the hash
#
# A hash catches an edited copy. It does not catch **identical bytes with a
# runner looping fewer cases than the file declares** -- a fixture offering
# twelve cases and a suite executing one passes every checksum ever written.
# That is the "inspects nothing" failure this repository has already found in
# `check-config-invalidation`, `check-secrets`, the architecture gate's autoload
# scan, and `ConfigReadBudgetTest`'s own docblock. So `case_count` is declared
# in the file, asserted against the array's real length, and asserted again
# against the floor below.
#
# ## What this gate cannot see
#
# It verifies **this** repository's copy against a hash **this** repository pins,
# so changing the fixture and the pinned hash together passes here while the two
# repositories diverge. Measured: both gates reported success with the files
# different. No single-checkout gate can close that -- there is nothing to compare
# against that the repository under test cannot also rewrite.
#
# `bin/check-fixture-parity.sh` in the working tree that holds **both**
# repositories closes it, by comparing the files and the pinned hashes directly.
# Run it before committing any change to a shared fixture.
#
# Usage: bash bin/check-shared-fixtures.sh

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  printf '\033[32mok\033[0m    %s\n' "$1"
}

# The hash of the fixture as both repositories must hold it. Changing the
# fixture means changing this line in **both** repositories; until then, both
# builds fail, which is the entire point.
EXPECTED_SHA='ba3e24692eadae8e5d8052a96abe8214f85d2b8634cc9edb118e0311119c5ed2'

# Where this repository keeps the suites that execute the fixture. Not derived
# from FIXTURE: the backend colocates specs with source, so the two trees differ.
SUITE_ROOT="src"

# A gate that finds no fixture passes for the wrong reason.
FIXTURE="test/fixtures/shared/pricing-fixtures.json"

if [ ! -f "$FIXTURE" ]; then
  fail "shared fixture missing at $FIXTURE -- the path is wrong, or the file was deleted"
  echo
  printf '\033[31m%d shared-fixture check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

# --- 1. The bytes match the other repository ---------------------------------
ACTUAL_SHA=$(shasum -a 256 "$FIXTURE" | awk '{print $1}')

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  fail "shared fixture does not match the recorded hash"
  printf '        expected %s\n' "$EXPECTED_SHA"
  printf '        actual   %s\n' "$ACTUAL_SHA"
  printf '        Edit the fixture in BOTH repositories and update EXPECTED_SHA in both gates.\n'
else
  pass "shared fixture matches the recorded hash"
fi

# --- 2. The file declares how many cases it holds, and holds that many --------
DECLARED=$(grep -oE '"case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
# Counted **inside the `cases` array**, not across the whole file.
#
# Three keys were tried and all three collided: `"name"` matches every measure
# case, `"base_minor"` matches the generated cases, and `"deltas"` — which was
# supposed to be the field that makes a case *that kind* of case — started
# matching the moment `bound_cases` was added, reporting 22 for 16.
#
# The lesson took three rounds: no field name is reliably unique to one array,
# because the arrays hold the same shape of thing on purpose. Scope the count to
# the array instead, so a fourth block of cases cannot collide with this one.
ACTUAL=$(awk '/"cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
              inside && /^  \]/{inside=0}
              inside && /"deltas"[[:space:]]*:/{n++}
              END{print n+0}' "$FIXTURE")

# Below this, the fixture is not covering what M11.4 requires -- each pricing
# type alone, combinations, zero and negative deltas, and the line-total floor.
FLOOR_CASES=16

if [ -z "$DECLARED" ]; then
  fail "shared fixture declares no case_count -- a runner cannot check it executed them all"
elif [ "$DECLARED" != "$ACTUAL" ]; then
  fail "shared fixture declares $DECLARED case(s) but holds $ACTUAL"
elif [ "$DECLARED" -lt "$FLOOR_CASES" ]; then
  fail "shared fixture holds only $DECLARED case(s) (floor $FLOOR_CASES) -- coverage was removed, not the gate"
else
  pass "shared fixture declares and holds $ACTUAL case(s)"
fi

# --- 3. The captured wire contract matches the other repository ---------------
#
# The same mechanism, for a fixture that already existed as a **PHP constant**.
# `AssignmentWireContractTest` held bytes captured from the real
# `GET /v1/store/config` response -- the right instinct, since a hand-written
# shape would be a guess and the Phase 8 envelope defect was two internally
# consistent halves that disagreed. What was missing was anything noticing when
# the capture went stale: changing the captured `priority` from `5` to `99` left
# the plugin suite reporting `OK`, because no gate read the constant and the
# backend did not know it existed.
#
# Moved into a file so it can be hashed, and hashed so it cannot drift.
WIRE='test/fixtures/shared/assignment-wire.json'
EXPECTED_WIRE_SHA='a279fbbebbff863d1fbd1900b52bf1840cf965b0a5dd0ddbd23c41add2f53c10'

if [ ! -f "$WIRE" ]; then
  fail "captured wire fixture missing at $WIRE"
else
  ACTUAL_WIRE_SHA=$(shasum -a 256 "$WIRE" | awk '{print $1}')

  if [ "$ACTUAL_WIRE_SHA" != "$EXPECTED_WIRE_SHA" ]; then
    fail "captured wire fixture does not match the recorded hash"
    printf '        expected %s\n' "$EXPECTED_WIRE_SHA"
    printf '        actual   %s\n' "$ACTUAL_WIRE_SHA"
    printf '        Re-capture from the cloud, update BOTH copies and BOTH gates.\n'
  else
    pass "captured wire fixture matches the recorded hash"
  fi
fi

# --- 4. The measure cases are declared and present ---------------------------
#
# M11.1a's whole point is that one function backs pricing, the counter and the
# length limits, so the fixture carries the cases that prove PHP and TypeScript
# agree on what a character is. Counted for the same reason as the pricing cases:
# identical bytes and a runner looping fewer of them passes every hash.
M_DECLARED=$(grep -oE '"measure_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
# Scoped to the array. The FOURTH counter in this file to learn it, and the
# lesson has not changed: no field name stays unique, because the arrays hold the
# same shape of thing on purpose. `"text"` was unique until `text_price_cases`
# arrived carrying the strings it prices, at which point a whole-file count read
# 20 measure cases where 11 exist.
M_ACTUAL=$(awk '/"measure_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                inside && /^  \]/{inside=0}
                inside && /"text"[[:space:]]*:/{n++}
                END{print n+0}' "$FIXTURE")

# Below this the fixture has stopped covering what makes the two languages
# comparable: an inner space, a combining mark, a ZWJ sequence, a flag.
FLOOR_MEASURE=11

if [ -z "$M_DECLARED" ]; then
  fail "shared fixture declares no measure_case_count"
elif [ "$M_DECLARED" != "$M_ACTUAL" ]; then
  fail "shared fixture declares $M_DECLARED measure case(s) but holds $M_ACTUAL"
elif [ "$M_DECLARED" -lt "$FLOOR_MEASURE" ]; then
  fail "shared fixture holds only $M_DECLARED measure case(s) (floor $FLOOR_MEASURE) -- coverage was removed, not the gate"
else
  pass "shared fixture declares and holds $M_ACTUAL measure case(s)"
fi

# --- 5. The rounding cases, including the ones that actually differ -----------
#
# PHP rounds half up **away from zero**; JavaScript's `Math.round` rounds toward
# positive infinity. They agree on every positive tie and disagree on every
# negative one, so a fixture testing only `+0.005` and `+0.015` passes in both
# languages while proving nothing about the case that diverges.
#
# The floor is what keeps the negative cases present: dropping them leaves a
# suite that agrees for the wrong reason.
R_DECLARED=$(grep -oE '"rounding_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
# Counted **inside the `rounding_cases` array**, for the reason the `cases`
# counter above records: no field name stays unique to one array, because the
# arrays hold the same shape of thing on purpose. `"basis_points"` was unique
# until `config_cases` arrived carrying a percentage price config, at which point
# a whole-file count reported 9 rounding cases where 8 exist. Scoping it is the
# same fix that block already applied, applied one block later.
R_ACTUAL=$(awk '/"rounding_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                inside && /^  \]/{inside=0}
                inside && /"basis_points"[[:space:]]*:/{n++}
                END{print n+0}' "$FIXTURE")

FLOOR_ROUNDING=8

if [ -z "$R_DECLARED" ]; then
  fail "shared fixture declares no rounding_case_count"
elif [ "$R_DECLARED" != "$R_ACTUAL" ]; then
  fail "shared fixture declares $R_DECLARED rounding case(s) but holds $R_ACTUAL"
elif [ "$R_DECLARED" -lt "$FLOOR_ROUNDING" ]; then
  fail "shared fixture holds only $R_DECLARED rounding case(s) (floor $FLOOR_ROUNDING) -- coverage was removed, not the gate"
else
  # Scoped to the array for the third time in this file. `rounding_cases` holds
  # 5 negatives; a whole-file count reads 6, because `config_cases` carries a
  # negative percentage of its own. That slack is exactly what would let someone
  # delete negative rounding cases and still clear the floor of 3.
  NEGATIVE=$(awk '/"rounding_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                  inside && /^  \]/{inside=0}
                  inside && /"basis_points"[[:space:]]*:[[:space:]]*-/{n++}
                  END{print n+0}' "$FIXTURE")

  if [ "$NEGATIVE" -lt 3 ]; then
    fail "only $NEGATIVE negative rounding case(s) -- positives agree in both languages and prove nothing"
  else
    pass "shared fixture declares and holds $R_ACTUAL rounding case(s), $NEGATIVE negative"
  fi
fi

# --- 5b. The derivation cases: price config + base -> delta -------------------
#
# Everything above tests the two ENDS of pricing. The main `cases` hand the
# summer deltas that are already computed, and `rounding_cases` test bare
# `percentageOf(10, 500) == 1`. Neither tests the step between them -- that a
# `{type: percentage, basis_points: 500}` config against a base of 10 yields a
# delta of 1 -- which is exactly where two evaluators can diverge while both
# suites stay green, because each half is correct in isolation.
#
# 16b adds that step in two languages at once. These cases are the only thing
# holding them to the same answer.
C_DECLARED=$(grep -oE '"config_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
C_ACTUAL=$(awk '/"config_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                inside && /^  \]/{inside=0}
                inside && /"expect_delta"[[:space:]]*:/{n++}
                END{print n+0}' "$FIXTURE")

FLOOR_CONFIG=10

if [ -z "$C_DECLARED" ]; then
  fail "shared fixture declares no config_case_count -- the config-to-delta step is untested"
elif [ "$C_DECLARED" != "$C_ACTUAL" ]; then
  fail "shared fixture declares $C_DECLARED config case(s) but holds $C_ACTUAL"
elif [ "$C_DECLARED" -lt "$FLOOR_CONFIG" ]; then
  fail "shared fixture holds only $C_DECLARED config case(s) (floor $FLOOR_CONFIG) -- coverage was removed, not the gate"
else
  # A percentage of a zero base, a zero percentage, and a negative percentage are
  # the three that separate a real evaluator from one that multiplies and hopes.
  # Named individually so removing any one of them fails by name.
  MISSING=''
  grep -q '"base_minor"[[:space:]]*:[[:space:]]*0' "$FIXTURE" || MISSING="$MISSING zero-base"
  grep -q '"basis_points"[[:space:]]*:[[:space:]]*0' "$FIXTURE" || MISSING="$MISSING zero-percentage"
  grep -q '"expect_unpriced"' "$FIXTURE" || MISSING="$MISSING unpriceable-type"

  if [ -n "$MISSING" ]; then
    fail "config cases are missing:$MISSING -- an evaluator that mishandles these still passes"
  else
    pass "shared fixture declares and holds $C_ACTUAL config-to-delta case(s)"
  fi
fi

# --- 5c. The text-price cases: measure() -> per_char -> delta -----------------
#
# The third bridge this file has had to grow, for the same reason as the second.
# `measure_cases` prove text -> a count. `config_cases` prove a config + base ->
# a delta. Nothing proved the step between: that a `per_char` price over a
# measured string yields a particular amount.
#
# That gap is not hypothetical here -- it is the `optionia-app` bug this whole
# specification exists to prevent, where pricing counted five characters while
# the counter beside the field showed four. Both halves were self-consistent.
T_DECLARED=$(grep -oE '"text_price_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
T_ACTUAL=$(awk '/"text_price_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                inside && /^  \]/{inside=0}
                inside && /"free_characters"[[:space:]]*:/{n++}
                END{print n+0}' "$FIXTURE")

FLOOR_TEXT_PRICE=9

if [ -z "$T_DECLARED" ]; then
  fail "shared fixture declares no text_price_case_count -- per_char is untested"
elif [ "$T_DECLARED" != "$T_ACTUAL" ]; then
  fail "shared fixture declares $T_DECLARED text-price case(s) but holds $T_ACTUAL"
elif [ "$T_DECLARED" -lt "$FLOOR_TEXT_PRICE" ]; then
  fail "shared fixture holds only $T_DECLARED text-price case(s) (floor $FLOOR_TEXT_PRICE) -- coverage was removed, not the gate"
else
  # The three that separate a real evaluator from one that multiplies a length.
  # A grapheme case catches `strlen`; a below-allowance case catches a missing
  # floor, which would pay a customer to type less; a negative amount catches an
  # implementation that clamped the delta instead of the count.
  MISSING=''
  grep -q '"text": "AB CD"' "$FIXTURE" || MISSING="$MISSING grapheme"
  grep -qE '"amount_minor"[[:space:]]*:[[:space:]]*-' "$FIXTURE" || MISSING="$MISSING negative-amount"
  awk '/"text_price_cases"/{i=1} i && /"free_characters"[[:space:]]*:[[:space:]]*[1-9]/{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING free-allowance"

  if [ -n "$MISSING" ]; then
    fail "text-price cases are missing:$MISSING -- an evaluator that mishandles these still passes"
  else
    pass "shared fixture declares and holds $T_ACTUAL text-price case(s)"
  fi
fi

# --- 5d. The unit-price cases: quantity -> per_unit -> delta ------------------
#
# The fourth bridge, and the one with the widest input range. A character count
# comes from `measure()` and is a non-negative integer by construction; a
# QUANTITY is whatever the customer typed, and the number types accept fractions
# and negatives unless the merchant configured otherwise.
#
# So these cases carry the three properties no arithmetic gets right by accident:
# a negative quantity floored at zero, a fractional product rounded away from
# zero, and a negative amount that survives the floor.
U_DECLARED=$(grep -oE '"unit_price_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
U_ACTUAL=$(awk '/"unit_price_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                inside && /^  \]/{inside=0}
                inside && /"quantity"[[:space:]]*:/{n++}
                END{print n+0}' "$FIXTURE")

FLOOR_UNIT_PRICE=11

if [ -z "$U_DECLARED" ]; then
  fail "shared fixture declares no unit_price_case_count -- per_unit is untested"
elif [ "$U_DECLARED" != "$U_ACTUAL" ]; then
  fail "shared fixture declares $U_DECLARED unit-price case(s) but holds $U_ACTUAL"
elif [ "$U_DECLARED" -lt "$FLOOR_UNIT_PRICE" ]; then
  fail "shared fixture holds only $U_DECLARED unit-price case(s) (floor $FLOOR_UNIT_PRICE) -- coverage was removed, not the gate"
else
  # Named individually so removing any one fails by name. A negative quantity
  # catches a missing floor -- which pays a customer to ask for less than
  # nothing; a fractional one catches an evaluator that truncates instead of
  # rounding; a negative amount catches a floor applied to the delta instead of
  # the quantity, which would silently discard every discount.
  MISSING=''
  awk '/"unit_price_cases"/{i=1} i && /"quantity"[[:space:]]*:[[:space:]]*"-/{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING negative-quantity"
  awk '/"unit_price_cases"/{i=1} i && /"quantity"[[:space:]]*:[[:space:]]*"[0-9]*\./{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING fractional-quantity"
  awk '/"unit_price_cases"/{i=1} i && /"amount_minor"[[:space:]]*:[[:space:]]*-/{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING negative-amount"

  if [ -n "$MISSING" ]; then
    fail "unit-price cases are missing:$MISSING -- an evaluator that mishandles these still passes"
  else
    pass "shared fixture declares and holds $U_ACTUAL unit-price case(s)"
  fi
fi

# --- 5e. The tier cases: quantity -> bracket -> delta -------------------------
#
# The fifth bridge, and the only one whose arithmetic depends on a LOOKUP. The
# amount is not in the config; it is the amount of whichever tier the quantity
# falls in, so an off-by-one at a boundary charges the wrong rate for every unit
# rather than being out by a minor unit.
#
# The boundary cases are therefore the point: exactly the lower bound, exactly
# the upper bound, one below, one above.
R2_DECLARED=$(grep -oE '"tier_price_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
R2_ACTUAL=$(awk '/"tier_price_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                 inside && /^  \]/{inside=0}
                 inside && /"quantity"[[:space:]]*:/{n++}
                 END{print n+0}' "$FIXTURE")

FLOOR_TIER_PRICE=12

if [ -z "$R2_DECLARED" ]; then
  fail "shared fixture declares no tier_price_case_count -- tiered is untested"
elif [ "$R2_DECLARED" != "$R2_ACTUAL" ]; then
  fail "shared fixture declares $R2_DECLARED tier case(s) but holds $R2_ACTUAL"
elif [ "$R2_DECLARED" -lt "$FLOOR_TIER_PRICE" ]; then
  fail "shared fixture holds only $R2_DECLARED tier case(s) (floor $FLOOR_TIER_PRICE) -- coverage was removed, not the gate"
else
  # Named individually so removing any one fails by name. An open-ended tier
  # catches a lookup that requires an upper bound; a fractional quantity catches
  # one that matches on BOTH bounds and leaves 9.5 unpriced; an uncovered
  # quantity catches a lookup that charges the nearest tier instead of reporting.
  MISSING=''
  awk '/"tier_price_cases"/{i=1} i && /"max_quantity"[[:space:]]*:[[:space:]]*null/{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING open-ended-tier"
  awk '/"tier_price_cases"/{i=1} i && /"quantity"[[:space:]]*:[[:space:]]*"[0-9]*\./{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING fractional-quantity"
  awk '/"tier_price_cases"/{i=1} i && /"expect_unpriced"/{f=1} END{exit !f}' "$FIXTURE" \
    || MISSING="$MISSING uncovered-quantity"

  if [ -n "$MISSING" ]; then
    fail "tier cases are missing:$MISSING -- an evaluator that mishandles these still passes"
  else
    pass "shared fixture declares and holds $R2_ACTUAL tier case(s)"
  fi
fi

# --- 5f. The currency cases: which types follow a converted base --------------
#
# Not arithmetic -- a **behavioural split** the specification now states as a
# table, and a table nobody executes is prose. Only `percentage` follows a base
# a currency switcher converted, because it is the only relative type; the other
# four are absolute amounts in the currency they were published in.
#
# The pair of bases is the whole point: one case, two bases, and an assertion
# that the delta changes for one type and not the other. A single base could not
# express "does not convert" at all.
C2_DECLARED=$(grep -oE '"currency_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
C2_ACTUAL=$(awk '/"currency_cases"[[:space:]]*:[[:space:]]*\[/{inside=1; next}
                 inside && /^  \]/{inside=0}
                 inside && /"converts"[[:space:]]*:/{n++}
                 END{print n+0}' "$FIXTURE")

FLOOR_CURRENCY=5

if [ -z "$C2_DECLARED" ]; then
  fail "shared fixture declares no currency_case_count -- the conversion split is untested"
elif [ "$C2_DECLARED" != "$C2_ACTUAL" ]; then
  fail "shared fixture declares $C2_DECLARED currency case(s) but holds $C2_ACTUAL"
elif [ "$C2_DECLARED" -lt "$FLOOR_CURRENCY" ]; then
  fail "shared fixture holds only $C2_DECLARED currency case(s) (floor $FLOOR_CURRENCY) -- coverage was removed, not the gate"
else
  # BOTH sides of the split, or the table proves nothing: a suite holding only
  # the converting case would pass on an evaluator that converted everything.
  #
  # 🔴 **And every type the table names.** The floor was 2 -- set to what the
  # fixture happened to hold rather than to what the specification claims -- so
  # three of the table's five rows were unexecuted prose, which is the exact
  # thing the comment above this block warns about. The floor is now the number
  # of published price types.
  MISSING_TYPES=''

  for price_type in fixed percentage per_unit per_char tiered; do
    awk -v want="\"$price_type\"" '
      /"currency_cases"[[:space:]]*:[[:space:]]*\[/{inside=1}
      inside && /^  \]/{inside=0}
      inside && index($0, "\"type\": " want){f=1}
      END{exit !f}' "$FIXTURE" || MISSING_TYPES="$MISSING_TYPES $price_type"
  done

  if [ -n "$MISSING_TYPES" ]; then
    fail "the currency table names types no case executes:$MISSING_TYPES"
  elif ! grep -q '"converts": true' "$FIXTURE" || ! grep -q '"converts": false' "$FIXTURE"; then
    fail "currency cases must cover a type that converts AND one that does not"
  else
    pass "shared fixture declares and holds $C2_ACTUAL currency case(s), both sides of the split"
  fi
fi

# --- 6. The specification both implementations answer to ----------------------
#
# `PRICING-SPEC.md` is normative for the PHP evaluator and the TypeScript one. A
# paragraph edited on one side and not the other is the same failure as an edited
# fixture, and a worse one to notice: two numbers differing is obvious in a diff,
# two prose descriptions of a rounding rule differing is not.
SPEC='test/fixtures/shared/PRICING-SPEC.md'
EXPECTED_SPEC_SHA='f2b96a55a42173a625152702bbf9c09cc29b7a70d31cd878f741ca45166d3ffe'

if [ ! -f "$SPEC" ]; then
  fail "pricing specification missing at $SPEC"
else
  ACTUAL_SPEC_SHA=$(shasum -a 256 "$SPEC" | awk '{print $1}')

  if [ "$ACTUAL_SPEC_SHA" != "$EXPECTED_SPEC_SHA" ]; then
    fail "pricing specification does not match the recorded hash"
    printf '        expected %s\n' "$EXPECTED_SPEC_SHA"
    printf '        actual   %s\n' "$ACTUAL_SPEC_SHA"
    printf '        Edit it in BOTH repositories and update EXPECTED_SPEC_SHA in both gates.\n'
  else
    pass "pricing specification matches the recorded hash"
  fi
fi

# --- 7. The generated cases, which assert the structural bound ----------------
#
# `AUTHORING_LIMITS` allows 100 groups of 200 options, so one option set can put
# **20,000** deltas on a line. The literal cases top out at fifty — enough to
# prove the arithmetic, and a four-hundredth of what a merchant can actually
# build.
#
# Writing twenty thousand numbers into a file humans read would be worse than the
# gap. These carry `repeat_delta` and `repeat_count` instead, and each suite
# expands them, so the true bound is asserted without the fixture becoming
# unreadable.
G_DECLARED=$(grep -oE '"generated_case_count"[[:space:]]*:[[:space:]]*[0-9]+' "$FIXTURE" | grep -oE '[0-9]+$' || true)
G_ACTUAL=$(grep -cE '"repeat_count"[[:space:]]*:' "$FIXTURE" || true)

FLOOR_GENERATED=2

if [ -z "$G_DECLARED" ]; then
  fail "shared fixture declares no generated_case_count"
elif [ "$G_DECLARED" != "$G_ACTUAL" ]; then
  fail "shared fixture declares $G_DECLARED generated case(s) but holds $G_ACTUAL"
elif [ "$G_DECLARED" -lt "$FLOOR_GENERATED" ]; then
  fail "shared fixture holds only $G_DECLARED generated case(s) (floor $FLOOR_GENERATED)"
else
  pass "shared fixture declares and holds $G_ACTUAL generated case(s)"
fi

# --- 8. The specification's own numbers are executed somewhere ----------------
#
# The hash above stops `PRICING-SPEC.md` drifting **between repositories**. It
# does nothing about the spec drifting from **reality**: measured, a spec edited
# in both copies to claim `"AB CD"` measures 4, with both hashes updated, passed
# every gate and every test while the code measured 5.
#
# That matters more for a document than a fixture. A fixture's numbers are
# executed, so a wrong one fails a build. A spec's numbers are read by people --
# and someone implementing `percentage` in TypeScript from a spec asserting the
# wrong boundary implements the wrong boundary.
#
# So every number the spec states as an example must also exist as a case some
# suite actually runs. Not a proof that the prose is right; a guarantee that the
# prose cannot say something no test would catch.
SPEC_CLAIMS=0
SPEC_UNBACKED=''

check_claim() {
  # $1 human label, $2 pattern that must appear in the spec, $3 pattern that must
  # appear in the fixture.
  if grep -qF "$2" "$SPEC" 2>/dev/null; then
    SPEC_CLAIMS=$((SPEC_CLAIMS + 1))

    grep -qF "$3" "$FIXTURE" 2>/dev/null || SPEC_UNBACKED="$SPEC_UNBACKED $1"
  fi
}

check_claim 'measure("AB CD")=5'   'measures **5**'          '"text": "AB CD"'
check_claim 'measure("John Smith")=10' 'measures **10**'     '"text": "John Smith"'
check_claim 'combining-accent=1-char' '| **4** |'            '"expect": 4'
check_claim 'round(-2.5)=-3'       'round(-2.5) → -3'        '"expect": -3'
check_claim 'round(+2.5)=+3'       'round(+2.5) → +3'        '"basis_points": 2500'
check_claim 'clamp-at-end=0'       'clamped at the end   :   0' '"deltas": ['
check_claim 'safe-range=2^53-1'    '9007199254740991'        '"bound_minor": 9007199254740991'
# M16.2's two claims. The percentage one is checked against the CONFIG cases, not
# the rounding cases: `basis_points: 5000` appears in both, and matching the
# rounding array would have let the derivation claim be "backed" by a case that
# never builds a price config -- the same one-end-of-pricing gap 16b closed.
check_claim 'percentage-of-base'   'of the base           : 4000 + 4000' '"expect_delta": 4000'
check_claim 'malformed-rate=0'     '**nothing and is reported**' '"expect_unpriced"'
# M16.3's two worked examples. Both are `per_char` arithmetic the spec states as
# numbers, so both must be executed somewhere -- and the second is the one that
# matters: without the floor on the COUNT, a string shorter than the allowance
# yields a NEGATIVE delta, a discount for typing less.
check_claim 'per-char=100'         '(5 - 3) * 50 = 100'      '"expect_delta": 100'
check_claim 'per-char-floor=0'     'max(0, -1) * 50 = 0'     '"text": "HI"'
# M16.4's ceiling. The number is stated in prose rather than in a worked example,
# so the backing case is the one that crosses it -- a quantity of 1,000,001,
# which must be reported rather than charged or silently zeroed.
check_claim 'quantity-ceiling'     'capped at 1,000,000'     '"quantity": "1000001"'
# M16.6's conversion split. The spec states it as a TABLE rather than a worked
# example, and a table nobody executes is prose -- the backing cases are the pair
# that prove one type follows a converted base and another does not.
check_claim 'converts-split'       'does **not** convert'    '"converts": false'
# The frozen-delta consequence, stated as a worked number in §6. Backed by a
# `fixed` currency case: the claim is that an absolute amount stays 500 minor
# units whatever the store's decimals become, which is the same property.
check_claim 'frozen-across-switch' 'charged 580'             '"expect_delta_a": 500'

# A gate that recognised none of the spec's claims would pass silently while the
# document said anything at all.
FLOOR_CLAIMS=14

if [ "$SPEC_CLAIMS" -lt "$FLOOR_CLAIMS" ]; then
  fail "recognised only $SPEC_CLAIMS of $FLOOR_CLAIMS specification claims -- the spec was reworded, or these patterns are stale"
elif [ -n "$SPEC_UNBACKED" ]; then
  fail "the specification states numbers no executed case covers:$SPEC_UNBACKED"
  printf '        A spec example nobody runs is a claim nobody checks.\n'
else
  pass "all $SPEC_CLAIMS specification claims are backed by executed cases"
fi


# --- 9. The pricing cases are executed by THIS repository ---------------------
#
# Checks 1-8 all pass on a fixture no local suite reads. That was literally the
# state before Stage 5: the sixteen pricing cases and two generated cases were
# executed by TypeScript alone, so the shared file proved that TypeScript agreed
# with itself. Every hash matched. Every count matched. Nothing was cross-checked.
#
# A shared fixture's whole value is that two implementations answer to it, so
# each gate has to assert LOCAL execution rather than local presence. It keys on
# the fixture field names a suite must read to run a case -- code, not a comment
# mentioning the file, and not an import that could sit above dead tests. This is
# the recurring failure in this project: `check-secrets` matched `hash_equals` in
# a comment, and the architecture gate matched `update_option` in prose. A gate
# that reads documentation checks nothing.
#
# SUITE_ROOT is set beside FIXTURE at the top, because the two are NOT derivable
# from one another: this repository colocates its suites with the source it
# tests, so the fixture and the suites live in different trees. Deriving one from
# the other looked tidy and made the gate search an empty directory.

count_readers() {
  # $1 the fixture field a suite must read to execute a case. Quoted either way,
  # since PHP writes $case['base_minor'] and TypeScript writes c.base_minor or
  # destructures it.
  grep -rlE "['\"'\''.]$1['\"'\'']?" "$SUITE_ROOT" 2>/dev/null \
    | grep -vE '/fixtures/' | wc -l | tr -d ' '
}

PRICING_READERS=$(count_readers base_minor)
EXPECT_READERS=$(count_readers expect_minor)
GENERATED_READERS=$(count_readers repeat_count)
BOUND_READERS=$(count_readers bound_minor)
CONFIG_READERS=$(count_readers expect_delta)
TEXT_PRICE_READERS=$(count_readers text_price_cases)
UNIT_PRICE_READERS=$(count_readers unit_price_cases)
TIER_PRICE_READERS=$(count_readers tier_price_cases)
CURRENCY_READERS=$(count_readers currency_cases)

# Reading the field names is not the same as running the cases, and measured, the
# difference was reachable: a suite that assigned all three to unused variables
# and asserted `true` passed this check with the real suite deleted. What caught
# a provider truncated to one row was an assertion INSIDE the suite, comparing
# the row count against the fixture's own declared count.
#
# So the gate requires that assertion to exist. It is the thing doing the work;
# the greps above are a floor against deletion, which is a different guarantee
# and a weaker one.
# Counted on the SAME file, not merely somewhere in the tree. Measured: three
# suites mention `case_count`, so a hollow reader plus any one of them satisfied
# two independent greps while nothing tied them together. The guarantee is that
# one file both runs the cases and checks how many it ran.
COUNT_ASSERTIONS=$(grep -rlE '\bbase_minor\b' "$SUITE_ROOT" 2>/dev/null \
  | grep -vE '/fixtures/' \
  | xargs grep -lE 'case_count' 2>/dev/null | wc -l | tr -d ' ')

if [ "$PRICING_READERS" -lt 1 ]; then
  fail "no local suite reads base_minor -- the $ACTUAL pricing case(s) are executed by the other language only"
  printf '        A fixture only one language runs proves that language agrees with itself.\n'
elif [ "$EXPECT_READERS" -lt 1 ]; then
  fail "a local suite reads base_minor but never asserts expect_minor -- the cases run without being checked"
elif [ "$GENERATED_READERS" -lt 1 ]; then
  fail "no local suite expands repeat_count -- the $G_ACTUAL generated case(s) are executed by the other language only"
elif [ "$CONFIG_READERS" -lt 1 ]; then
  fail "no local suite reads expect_delta -- the $C_ACTUAL config-to-delta case(s) are executed by the other language only"
  printf '        This is the step where two evaluators diverge while both suites stay\n'
  printf '        green: each language tests one END of pricing and neither tests the\n'
  printf '        derivation between them. A config case run in one language only is\n'
  printf '        that same blind spot with a fixture in front of it.\n'
elif [ "$TEXT_PRICE_READERS" -lt 1 ]; then
  fail "no local suite reads text_price_cases -- the $T_ACTUAL per_char case(s) are executed by the other language only"
  printf '        `measure()` is shared precisely so pricing and the character counter\n'
  printf '        cannot disagree. A per_char case run in one language only reopens that\n'
  printf '        gap one layer up.\n'
elif [ "$UNIT_PRICE_READERS" -lt 1 ]; then
  fail "no local suite reads unit_price_cases -- the $U_ACTUAL per_unit case(s) are executed by the other language only"
  printf '        A quantity is whatever the customer typed, so the floor and the\n'
  printf '        rounding are where two evaluators diverge. Running them in one\n'
  printf '        language proves that language agrees with itself.\n'
elif [ "$TIER_PRICE_READERS" -lt 1 ]; then
  fail "no local suite reads tier_price_cases -- the $R2_ACTUAL tiered case(s) are executed by the other language only"
  printf '        A tier lookup off by one at a boundary charges the wrong RATE for\n'
  printf '        every unit, not a minor unit. Running the boundaries in one language\n'
  printf '        proves that language agrees with itself.\n'
elif [ "$CURRENCY_READERS" -lt 1 ]; then
  fail "no local suite reads currency_cases -- the conversion split is executed by the other language only"
  printf '        Which types follow a converted base is a documented behaviour a\n'
  printf '        merchant relies on. Stated in one language and unexecuted in the\n'
  printf '        other, it is prose.\n'
elif [ "$BOUND_READERS" -lt 1 ]; then
  fail "no local suite reads bound_minor -- the safe range is hardcoded, not shared"
  printf '        A bound stated in the spec and hardcoded in both suites can be edited to\n'
  printf '        contradict both implementations with every gate still green.\n'
elif [ "$COUNT_ASSERTIONS" -lt 1 ]; then
  fail "no local suite asserts its row count against the fixture's declared count"
  printf '        Reading the field names proves they appear in a test file, not that any\n'
  printf '        case runs. A truncated provider is caught by the count assertion, not here.\n'
else
  pass "pricing, bound and generated cases are all executed and counted here"
fi


echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d shared-fixture check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll shared-fixture checks passed.\033[0m\n'
