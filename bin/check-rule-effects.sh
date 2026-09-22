#!/usr/bin/env bash
#
# The preview acts on every effect the rule evaluator can report.
#
# ## Why this exists
#
# 🔴 **Three effects were computed and thrown away.** `evaluateRules` keys its
# states by whatever a rule targeted — a group, an option or a value — and the
# first interactive preview read `states.get(option.id)` and stopped. So:
#
#   • a rule hiding a GROUP drew the whole group anyway
#   • a rule hiding a VALUE left it beside its siblings
#   • a price a rule set on a VALUE was ignored for the option's
#
# A merchant testing a group rule watched it do **nothing**, and would have
# rewritten a rule that was correct.
#
# ## Why a count rather than a test
#
# ⚠️ **These were ABSENT code.** No test asserted the behaviour and no line
# existed to mutate, so every mutation passed and the suite was green. The same
# shape as the missing `validation` transform and the missing value-level price
# conversion before it: a count catches what a mutation cannot, because a count
# notices the thing that was never written.
#
# `TargetState` is the evaluator's statement of what a rule can decide. Every
# field on it is an effect a storefront acts on, so every field must appear in
# the preview's own code. A fifth effect added to the evaluator and ignored here
# fails this gate rather than shipping as a preview that quietly disagrees with
# the shop.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$ROOT/optioniaWooCommerceFrontend/src"
EVALUATOR="$DASH/lib/rules/rule-evaluator.ts"
EFFECTS="$DASH/lib/preview/rule-effects.ts"
PREVIEW="$DASH/components/option-sets/set-preview.tsx"

for f in "$EVALUATOR" "$EFFECTS" "$PREVIEW"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT/"}"
    printf '\n\033[31m%d rule-effect check(s) failed.\033[0m\n' "$FAILURES"
    exit 1
  fi
done

strip_comments() {
  sed -e 's://.*::' "$1" | awk '/\/\*/{b=1} !b{print} /\*\//{b=0}'
}

# The fields of `TargetState`, read from the evaluator rather than written here:
# the list is the evaluator's to grow, and this gate's job is to notice when it
# does.
FIELDS=$(strip_comments "$EVALUATOR" \
  | awk '/^export interface TargetState \{/{inside=1; next} inside && /^\}/{inside=0} inside' \
  | grep -oE '^\s+readonly [a-zA-Z]+' | awk '{print $2}')

COUNT=$(printf '%s\n' "$FIELDS" | grep -c .)
FLOOR=4

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found $COUNT TargetState field(s), floor $FLOOR — the pattern is wrong, not the code"
else
  pass "TargetState declares $COUNT effect(s)"

  for field in $FIELDS; do
    if { strip_comments "$EFFECTS"; strip_comments "$PREVIEW"; } | grep -qE "\b$field\b"; then
      pass "the preview acts on \`$field\`"
    else
      fail "the preview never reads \`$field\`, an effect the evaluator reports"
      printf '      A rule would decide something the merchant is never shown.\n'
    fi
  done
fi

# 🔴 **The three target types the evaluator can key a state by.** The preview
# must expand through containment (so a group reaches its options) and recognise
# a value target on its own — the two mechanisms `SelectionResolver` keeps apart.
if strip_comments "$EFFECTS" | grep -qE 'under\.get\(targetId\)'; then
  pass "hidden targets expand through containment, as the storefront does"
else
  fail "the preview does not expand a hidden target through containment"
  printf '      A rule hiding a GROUP would leave every option inside it drawn.\n'
fi

if strip_comments "$EFFECTS" | grep -qE 'valueIds\.has\(targetId\)'; then
  pass "a value target is recognised on its own"
else
  fail "the preview does not recognise a value target"
  printf '      A rule hiding one choice would leave it beside its siblings.\n'
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d rule-effect check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll rule-effect checks passed.\033[0m\n'
