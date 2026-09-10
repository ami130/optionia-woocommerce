#!/usr/bin/env bash
#
# The dashboard's capability table must agree with the API's.
#
# `optioniaWooCommerceFrontend/src/lib/auth/capabilities.ts` mirrors a subset of
# the API's `capabilities.ts` so the UI stops offering actions a role cannot
# perform. A *hint*, never enforcement — but a hint that has drifted is worse
# than none: it either hides a button that would work, or offers one that answers
# 403, which is the exact defect Phase 13 Stage 3's audit found.
#
# Only the capabilities the dashboard branches on are compared. Everything else
# in the API's table is deliberately absent from the mirror.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="$ROOT/optioniaWooCommerceBackend/src/auth/permissions/capabilities.ts"
UI="$ROOT/optioniaWooCommerceFrontend/src/lib/auth/capabilities.ts"

for f in "$API" "$UI"; do
  [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

echo "Checking capability parity..."

# `MIRRORED` is the contract: each entry is an API constant and its UI string.
MIRRORED="STORES_CONNECT:stores:connect PRODUCTS_VIEW:products:view PRODUCTS_ASSIGN:products:assign OPTION_SETS_EDIT:option_sets:edit OPTION_SETS_DELETE:option_sets:delete OPTION_SETS_PUBLISH:option_sets:publish OPTION_SETS_ROLLBACK:option_sets:rollback"
ROLES="owner admin editor viewer billing"
CHECKED=0

for role in $ROLES; do
  for pair in $MIRRORED; do
    api_const="${pair%%:*}"
    ui_name="${pair#*:}"

    api_has=$(python3 - "$API" "$role" "$api_const" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(rf'  {sys.argv[2]}: \[(.*?)\],?\n  (?:[a-z]+: \[|\}} as const)', text, re.S)
print('yes' if match and sys.argv[3] in match.group(1) else 'no')
PY
)
    ui_has=$(python3 - "$UI" "$role" "$ui_name" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(rf'  {sys.argv[2]}: \[(.*?)\],', text, re.S)
print('yes' if match and f"'{sys.argv[3]}'" in match.group(1) else 'no')
PY
)

    CHECKED=$((CHECKED + 1))

    if [ "$api_has" != "$ui_has" ]; then
      fail "$role / $ui_name: api=$api_has dashboard=$ui_has"
    fi
  done
done

# A gate that compares nothing passes for the wrong reason.
#
# The floor rises with the mirror, deliberately. This gate can only compare what
# the dashboard's table lists, so **an omitted capability is invisible to it** —
# and that is exactly how `option_sets:delete` and `option_sets:rollback` were
# missing until Stage 4 while this check reported everything in agreement.
#
# 5 roles x 7 mirrored capabilities.
FLOOR=35
if [ "$CHECKED" -lt "$FLOOR" ]; then
  fail "only $CHECKED pair(s) compared (floor $FLOOR) — the parser is wrong, not the code"
elif [ "$FAILURES" -eq 0 ]; then
  pass "all $CHECKED role/capability pair(s) agree across both repositories"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d capability parity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll capability parity checks passed.\033[0m\n'
