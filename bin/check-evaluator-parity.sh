#!/usr/bin/env bash
#
# The shared evaluators are the same logic in both repositories.
#
# ## Why this exists
#
# 🔴 **M21.1's strongest demand is "never a second set of rules"** — the preview
# must price and evaluate exactly as the storefront does, or a merchant tunes an
# option against a number their customer will not be charged.
#
# ADR-083 allows the duplicate: the dashboard cannot import from the backend, so
# it carries a copy. What it does not allow is **drift**.
#
# ## Why the shared fixtures are not enough on their own
#
# `pricing-fixtures.json` and `rule-fixtures.json` run on both sides and would
# catch a *semantic* divergence — a copy that computed a different answer for a
# case the fixtures cover. They cannot catch a **new** behaviour added to one copy
# and not the other: a price type, a rule operator, a clamp. The fixture has no
# case for it, so both sides pass while only one can do it.
#
# So the fixtures prove the shared cases agree, and this proves there is nothing
# outside them.
#
# ## What is compared
#
# ⚠️ **Imports are excluded, deliberately.** The two copies resolve the same
# symbols by different paths — `../database/enums` against `./price-type` — and
# that is the *point* of the duplicate, not a divergence. Comments are excluded
# for the same reason: each copy explains itself to its own readers.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/optioniaWooCommerceBackend/src"
DASH="$ROOT/optioniaWooCommerceFrontend/src"

echo "Checking evaluator parity..."

# Each entry is `backend-path:dashboard-path`, relative to the two `src` roots.
#
# 📌 The list is the contract: an evaluator absent from it is unguarded, which is
# why the floor below rises with it.
PAIRS="
common/money/line-total.ts:lib/money/line-total.ts
common/money/percentage.ts:lib/money/percentage.ts
common/money/price-config-delta.ts:lib/money/price-config-delta.ts
common/rules/rule-evaluator.ts:lib/rules/rule-evaluator.ts
"

# Strip comments, imports and blank lines — what remains is the logic.
logic_of() {
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
text = re.sub(r'/\*[\s\S]*?\*/', '', text)
text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
text = re.sub(r'^import[\s\S]*?;\s*$', '', text, flags=re.M)
print('\n'.join(line.rstrip() for line in text.splitlines() if line.strip()))
PY
}

CHECKED=0

for pair in $PAIRS; do
  [ -n "$pair" ] || continue

  B="$BACKEND/${pair%%:*}"
  D="$DASH/${pair##*:}"

  for f in "$B" "$D"; do
    [ -f "$f" ] || { fail "missing $f"; continue 2; }
  done

  CHECKED=$((CHECKED + 1))

  if [ "$(logic_of "$B")" != "$(logic_of "$D")" ]; then
    fail "$(basename "$B"): the two copies compute differently"
    diff <(logic_of "$B") <(logic_of "$D") | head -12 | sed 's/^/          /'
  fi
done

# A gate that compares nothing passes for the wrong reason.
#
# Four evaluators today: line-total, percentage, price-config-delta,
# rule-evaluator. The floor rises when a fifth is shared.
FLOOR=4
if [ "$CHECKED" -lt "$FLOOR" ]; then
  fail "only $CHECKED evaluator pair(s) compared (floor $FLOOR) — the list is wrong, not the code"
elif [ "$FAILURES" -eq 0 ]; then
  pass "all $CHECKED evaluator pair(s) are the same logic in both repositories"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d evaluator parity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll evaluator parity checks passed.\033[0m\n'
