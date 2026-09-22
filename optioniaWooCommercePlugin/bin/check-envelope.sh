#!/usr/bin/env bash
#
# Wire-contract gate: plugin fixtures must match the API's envelope (ADR-009).
#
#   bash bin/check-envelope.sh
#
# The cloud wraps every response as `{"data": ..., "meta": {...}}` and every
# error as `{"error": {...}, "meta": {...}}`. The plugin read neither, so
# against the real API the handshake returned null, the callback stored no
# token, and the heartbeat recorded no version — the entire connection flow.
#
# Both suites passed throughout. The backend's e2e asserts
# `body.data.authorize_url`; every plugin fixture was flat. Each side was
# internally consistent and disagreed with the other, and no check compared
# them — the two repositories are separate checkouts, so nothing could.
#
# This is the plugin's half of that comparison: a fixture standing in for a
# cloud response must carry the envelope, so a test can no longer pass against
# a shape the wire never sends.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

FIXTURES=$(grep -rn "'body'" tests/unit/*.php 2>/dev/null \
  | grep -oE "'body'[^=]*=> *'[^']*'" \
  | grep -oE "'\{[^']*\}'" || true)

COUNT=$(printf '%s\n' "$FIXTURES" | grep -c '{' || true)

# A gate that inspects nothing passes for the wrong reason.
#
# Set from the literal fixtures that exist (8), not from a guess. Fixtures built
# through a `$body` variable are deliberately out of scope: this reads source,
# not runtime, and cannot follow a variable. Those are covered instead by
# `ResponseEnvelopeTest`, which drives the real shapes end to end.
#
# The floor caught its own parser once already — an earlier value of 10 counted
# request-body assertions as response fixtures, which is exactly the "check that
# inspects nothing" this project keeps finding.
FLOOR=8
if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "only $COUNT response fixture(s) found (floor $FLOOR) — the parser is wrong, not the tests"
else
  BAD=""
  while IFS= read -r fixture; do
    [ -z "$fixture" ] && continue

    # A fixture is well-formed when it carries `data` (success) or `error`
    # (failure). Anything else is a shape the cloud never sends.
    case "$fixture" in
      *'"data"'*|*'"error"'*) ;;
      *) BAD="$BAD
        $fixture" ;;
    esac
  done <<EOF
$FIXTURES
EOF

  if [ -n "$BAD" ]; then
    fail "response fixture(s) missing the envelope — the wire never sends these:$BAD"
    printf '        Wrap as {"data":{...}} or {"error":{"code":...,"message":...}}.\n'
  else
    pass "all $COUNT response fixture(s) carry the API envelope"
  fi
fi

# --- The unwrapping itself must stay ------------------------------------------
#
# The fixtures above only matter because `Client` unwraps. If that is removed,
# every fixture is still correct and every caller is broken again — so the seam
# is asserted here too, not only by the tests that exercise it.

if grep -q 'private static function unwrap' src/Api/Client.php; then
  pass "Api\\Client unwraps the response envelope"
else
  fail "Api\\Client no longer unwraps the envelope — callers read a transport detail"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d envelope check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll envelope checks passed.\033[0m\n'
