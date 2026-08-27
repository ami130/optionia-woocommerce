#!/usr/bin/env bash
#
# Connection state is written in exactly one place (M8.1b).
#
# M8.1b requires an "explicit, persisted state machine — not inferred", and the
# way that requirement dies is by attrition: each step writes `stores.status`
# where it happens to be convenient, every write looks reasonable on its own, and
# the illegal transitions are the ones nobody wrote down.
#
# `[8e]` shipped exactly that. `UPDATE stores SET status = 'connected'
# WHERE id = ?` with no precondition let a connection code redeemed after the
# merchant disconnected silently reconnect the store — no attacker needed, just a
# failed exchange the plugin retries and an impatient merchant in between.
#
# `[8g]`, `[8h]` and `[8i]` each add transitions. This makes the state machine
# the only route rather than the recommended one.
#
# Usage: bash bin/check-store-state.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() { printf '  \033[31mx\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }

printf '\nChecking connection-state writes...\n\n'

# The state machine itself, plus migrations and seeds, legitimately write status.
ALLOWED='src/stores/store-state.service.ts|src/migrations/|src/seeds/'

# Drop comment lines, so the scanner cannot flag its own documentation — the same
# reason `check-secrets` strips them. A doc comment describing the pattern is not
# a write; treating it as one trains everyone to phrase comments around the gate.
strip_comments() { grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|#|\*|/\*)'; }

HITS=$(grep -rnE "UPDATE[[:space:]]+stores[[:space:]]+SET[^\`\"']*status" src 2>/dev/null \
       | strip_comments \
       | grep -vE "$ALLOWED" || true)

if [ -n "$HITS" ]; then
  fail "stores.status written outside StoreStateService (use it, so the machine decides):"
  echo "$HITS" | sed 's/^/      /'
else
  pass "every stores.status write goes through the state machine"
fi

# A floor: the check must be looking at something. A refactor that renamed the
# table or the column would otherwise leave this passing while verifying nothing.
TOTAL=$(grep -rnE "UPDATE[[:space:]]+stores[[:space:]]+SET[^\`\"']*status" src 2>/dev/null \
        | strip_comments | wc -l | tr -d ' ')

if [ "$TOTAL" -lt 1 ]; then
  fail "found no stores.status writes at all — the pattern no longer matches anything"
else
  pass "$TOTAL status write(s) found and accounted for"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31mConnection-state checks failed.\033[0m\n\n'
  exit 1
fi
printf '\033[32mAll connection-state checks passed.\033[0m\n\n'
