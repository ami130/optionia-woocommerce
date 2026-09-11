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

  local api_values
  api_values=$(awk -v name="$api_name" '
    $0 ~ "^export const " name " = \\{" { inside = 1; next }
    inside && /^\} as const;/ { exit }
    inside { print }
  ' "$API" | grep -oE "'[a-z_]+'" | tr -d "'" | sort | tr '\n' ' ')

  local ui_values
  ui_values=$(awk -v name="$ui_name" '
    $0 ~ "^export const " name " = \\[" { inside = 1 }
    inside { print }
    inside && /\] as const;/ { exit }
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
