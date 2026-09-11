#!/usr/bin/env bash
#
# The dashboard's rule vocabulary must agree with the API's.
#
# `optioniaWooCommerceFrontend/src/lib/rules/vocabulary.ts` mirrors four enums
# from `optioniaWooCommerceBackend/src/common/database/enums.ts`, because the two
# repositories cannot import from each other.
#
# 🔴 **An operator in the picker that the API refuses is a merchant choosing it,
# submitting, and being handed a 400 they cannot act on** — and it is invisible
# to both test suites, because neither can see the other. Measured on the option
# type picker, 2026-09-03: adding `checkbox` to it passed all 305 frontend tests
# and `tsc`, because nothing compared the two.
#
# ⚠️ **Exact equality, not a subset — and that is the difference from
# `check-option-type-parity.sh`.** A type may be registered long before the
# dashboard can author it, so that gate allows a subset. A rule *operator* has no
# such staging: the schema is `.strict()` and the evaluator returns `false` for
# anything it does not know, so an operator the dashboard omits is one a merchant
# cannot author at all, and one it invents is a 400.
#
# Usage: bash bin/check-rule-vocabulary-parity.sh

set -uo pipefail

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="$ROOT/optioniaWooCommerceBackend/src/common/database/enums.ts"
UI="$ROOT/optioniaWooCommerceFrontend/src/lib/rules/vocabulary.ts"

printf 'Checking rule vocabulary parity...\n'

for f in "$API" "$UI"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT/"}"
    exit 1
  fi
done

# One enum: the API's `const X = { KEY: 'value', ... }` versus the dashboard's
# `const Y = ['value', ...]`. Both reduced to a sorted list of the values.
compare() {
  local label="$1" api_name="$2" ui_name="$3"

  # Two shapes on the API side, and both are read.
  #
  # The four vocabularies are objects — `const X = { KEY: 'value', ... }` — and
  # yield their quoted values directly. The five groupings are arrays of
  # **references**: `[RuleOperator.IS_EMPTY, ...]`, which carry no quoted value
  # at all. Those are resolved back through the `RuleOperator` object.
  #
  # ⚠️ Reading only the first shape is why this gate reported "the parser is
  # wrong" on its first run against groupings — correctly, and about itself.
  local api_values
  api_values=$(awk -v name="$api_name" '
    $0 ~ "^export const " name " = \\{" { inside = 1; next }
    inside && /^\} as const;/ { exit }
    inside { print }
  ' "$API" | grep -oE "'[a-z_]+'" | tr -d "'" | sort | tr '\n' ' ')

  if [ -z "$api_values" ]; then
    # An array of `RuleOperator.KEY` references: collect the keys, then look each
    # one up in the `RuleOperator` object to get the value it names.
    local keys
    keys=$(awk -v name="$api_name" '
      $0 ~ "^export const " name " = \\[" { inside = 1 }
      inside { print }
      inside && /\] as const;/ { exit }
    ' "$API" | grep -oE "RuleOperator\.[A-Z_]+" | sed 's/RuleOperator\.//' | sort -u)

    if [ -n "$keys" ]; then
      local resolved=""

      for key in $keys; do
        local value
        value=$(awk -v k="$key" '
          /^export const RuleOperator = \{/ { inside = 1; next }
          inside && /^\} as const;/ { exit }
          inside && $0 ~ "^  " k ":" { print }
        ' "$API" | grep -oE "'[a-z_]+'" | tr -d "'")

        if [ -z "$value" ]; then
          fail "$label: $key is not a member of RuleOperator"

          return
        fi

        resolved="$resolved$value "
      done

      api_values=$(printf '%s' "$resolved" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ')
    fi
  fi

  # Two shapes on the dashboard side too. The four vocabularies are
  # `const X = [...] as const;`; the five groupings carry a type annotation —
  # `const X: readonly RuleOperator[] = [...];` — and end at `];` rather than
  # `] as const;`. Both are matched by anchoring on the name and stopping at the
  # first line that closes an array.
  local ui_values
  ui_values=$(awk -v name="$ui_name" '
    $0 ~ "^export const " name "(:| =)" { inside = 1 }
    inside { print }
    inside && /\];/ { exit }
  ' "$UI" | grep -oE "'[a-z_]+'" | tr -d "'" | sort | tr '\n' ' ')

  if [ -z "$api_values" ]; then
    fail "$label: could not read $api_name from the API -- the parser is wrong, not the code"

    return
  fi

  if [ -z "$ui_values" ]; then
    fail "$label: could not read $ui_name from the dashboard"

    return
  fi

  if [ "$api_values" != "$ui_values" ]; then
    fail "$label disagree"
    printf '        API:       %s\n' "$api_values"
    printf '        dashboard: %s\n' "$ui_values"

    return
  fi

  local count
  count=$(printf '%s' "$api_values" | wc -w | tr -d ' ')
  pass "$label agree ($count)"
}

compare "rule operators"     "RuleOperator"   "RULE_OPERATORS"
compare "rule actions"       "RuleAction"     "RULE_ACTIONS"
compare "rule target types"  "RuleTargetType" "RULE_TARGET_TYPES"
compare "rule match types"   "RuleMatchType"  "RULE_MATCH_TYPES"

# The five operand shapes.
#
# 🔴 **`ruleConditionSchema` is a discriminated union of FIVE branches**, each
# accepting a different `value`: absent, a list, a number, a string, or any
# scalar. The builder picks its input control from these groupings, so one that
# has drifted renders a text box where the API demands a number — a 400 the
# merchant meets at submit.
#
# ⚠️ **Comparing only the flat lists above could not see this.** Two of the five
# were missing from the dashboard when the builder came to need them, and every
# check here passed. That is the same blindness the option-type gate was written
# for, one level down.
#
# The API's `ORDERING_` is the dashboard's `NUMERIC_`: named for the schema on
# one side and for what a merchant is choosing on the other. Mapped here rather
# than renamed, because both names are right where they live.
compare "unary operators"     "UNARY_RULE_OPERATORS"     "UNARY_OPERATORS"
compare "list operators"      "LIST_RULE_OPERATORS"      "LIST_OPERATORS"
compare "ordering operators"  "ORDERING_RULE_OPERATORS"  "NUMERIC_OPERATORS"
compare "substring operators" "SUBSTRING_RULE_OPERATORS" "SUBSTRING_OPERATORS"
compare "equality operators"  "EQUALITY_RULE_OPERATORS"  "EQUALITY_OPERATORS"

# Every operator must read as a sentence, or a summary names it by its raw value.
PHRASED=$(awk '/^export const OPERATOR_PHRASING/,/^};/' "$UI" | grep -cE "^  [a-z_]+:")
OPERATORS=$(awk '/^export const RULE_OPERATORS/,/\] as const;/' "$UI" | grep -oE "'[a-z_]+'" | wc -l | tr -d ' ')

if [ "$PHRASED" != "$OPERATORS" ]; then
  fail "$OPERATORS operator(s) but $PHRASED phrasing(s) -- a summary would print a raw value"
else
  pass "all $OPERATORS operator(s) have plain-language phrasing"
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\n\033[31m%d rule vocabulary check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\n\033[32mAll rule vocabulary checks passed.\033[0m\n'
