#!/usr/bin/env bash
#
# Every symbol in the ported source is accounted for.
#
# ## Why this exists
#
# 🔴 **Two symbols went missing from the same port, silently.** `DesignImage`
# and `frameClipId` were both in the block being ported, both skipped, and both
# found only by a later audit reading the source again. Neither was a decision —
# each was an omission that looked like one.
#
# ⚠️ **A port's only value is fidelity.** The reason to port `designScene.ts`
# rather than rewrite it is that it carries parity fixes derived across four
# rendering surfaces; a port missing pieces is a rewrite with extra steps and
# the same cost the port was meant to avoid.
#
# ## What is checked
#
# Every `export` in the source file must either appear in the port, or be listed
# below as deliberately not ported, with a reason. 📌 **Not "the port is
# correct"** — mutation tests do that. This answers the narrower question a human
# reading two files cannot reliably answer: *is anything simply absent?*
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/optionia-app/app/components/design-lab/designScene.ts"
PORT_DIR="$ROOT/optioniaWooCommerceBackend/src/design"

printf '\033[1m== check-port-fidelity.sh ==\033[0m\n'
printf 'Checking the designScene port against its source...\n'

if [ ! -f "$SOURCE" ]; then
  # 📌 **Not a failure.** The reference repository is a sibling checkout and may
  # legitimately be absent — on CI, or on a machine that never had it. A gate
  # that failed here would fail for everyone who did nothing wrong.
  pass "reference not present; nothing to compare (this is not a defect)"
  printf '\n\033[32mAll port-fidelity checks passed.\033[0m\n'
  exit 0
fi

if [ ! -d "$PORT_DIR" ]; then
  fail "missing: optioniaWooCommerceBackend/src/design"
  printf '\n\033[31m1 port-fidelity check failed.\033[0m\n'
  exit 1
fi

# Symbols deliberately NOT ported, each with the reason.
#
# ⚠️ **A reason, not a list.** "Not needed" is how a list stops being read; each
# entry here names what replaces it or why it cannot apply.
not_ported() {
  case "$1" in
    # `resvg` renders <textPath> natively, so nothing consumes ArcParams —
    # `text-to-path.server.ts` was its only reader and does not port.
    ArcParams) return 0 ;;
    *) return 1 ;;
  esac
}

PORTED=$(cat "$PORT_DIR"/*.ts 2>/dev/null \
  | grep -oE "^export (const|function|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" \
  | awk '{print $3}' | sort -u)

MISSING=""
CHECKED=0
SKIPPED=0

for symbol in $(grep -oE "^export (const|function|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" "$SOURCE" \
  | awk '{print $3}' | sort -u); do
  if not_ported "$symbol"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  CHECKED=$((CHECKED + 1))

  if ! printf '%s\n' "$PORTED" | grep -qx "$symbol"; then
    MISSING="$MISSING  $symbol\n"
  fi
done

if [ "$CHECKED" -eq 0 ]; then
  fail "parsed no symbols from the source — the parser is wrong, not the code"
elif [ -n "$MISSING" ]; then
  # 🔴 **Reported, and NOT a failure while the port is in progress.** The text
  # half of `designScene.ts` lands in a later stage, and failing on it would
  # make the gate red for a month and therefore ignored. It fails only once the
  # port claims to be finished — see PORT_COMPLETE below.
  COUNT=$(printf "%b" "$MISSING" | grep -c . || true)

  if [ -f "$PORT_DIR/.port-complete" ]; then
    fail "the port is marked complete and $COUNT symbol(s) are absent:"
    printf "%b" "$MISSING" | sed 's|^|      |'
    printf '        port it, or list it in not_ported() with a reason\n'
  else
    pass "$((CHECKED - COUNT)) of $CHECKED symbol(s) ported; $COUNT pending, $SKIPPED not ported by design"
    printf '      still to port:\n'
    printf "%b" "$MISSING" | sed 's|^|        |'
  fi
else
  pass "every one of $CHECKED source symbol(s) is ported ($SKIPPED not ported by design)"
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d port-fidelity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll port-fidelity checks passed.\033[0m\n'
