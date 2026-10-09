#!/usr/bin/env bash
#
# Two gates that reported defects which were their own reading of the code.
#
# ## Why this exists
#
# 🔴 **A gate that misreads is worse than no gate.** It sends someone to fix
# code that was already correct, and it spends the credibility that makes the
# other thirty-five worth running. Both of these did exactly that on the first
# CI run after `ci.yml` stopped skipping them:
#
#   check-build-output.sh   asserted `dist/<entryFile>.js` exists ELEVEN LINES
#                           before the `npm run build` that emits it. It passed
#                           on a developer machine because an earlier build had
#                           left one behind; on a clean runner it failed with
#                           "which the build does not emit" — naming
#                           `nest-cli.json` when the fault was its own order.
#
#   check-scripts.sh        matched `(src|test|bin)/…` ANYWHERE in a script
#                           body, so `node dist/…/src/main.js` yielded the
#                           substring `src/main.js` — absent, because the source
#                           is `main.ts`. `start:prod` was correct throughout.
#
# ⚠️ **Neither fix is protected by anything else.** They are shell scripts with
# no suite, and both regressions are a one-line edit away: moving a block, or
# dropping an anchor from a regex. This asserts the two properties that make
# them read correctly, not their whole behaviour.
#
# 📌 **Line numbers are derived, never literal.** A gate that hard-coded them
# would fail on any unrelated edit and teach people to update it without
# thinking, which is how a check stops being one.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILED=$((FAILED + 1)); }

printf 'Checking the gates that misread the code…\n'

# --- 1. The build runs before anything asserts about its output --------------
BUILD_GATE="$ROOT/bin/check-build-output.sh"

if [ ! -f "$BUILD_GATE" ]; then
  fail "check-build-output.sh is missing — this gate's path is stale"
else
  # `|| true` on both: grep exits 1 with no match, and `set -u` would end the
  # script there rather than report — the silent abort this suite has hit before.
  # ✏️ **The comment filter has to run AFTER the line-number prefix is
  # stripped.** An earlier version piped `grep -n` output through
  # `grep -v '^\s*#'`, which never matched: every line now begins with `16:`,
  # not `#`. It selected line 16 — a comment reading "never `npm run build`" —
  # and passed only because 16 happens to precede the assertion. A real
  # reordering would have gone unnoticed.
  BUILD_LINE=$(grep -n 'npm run build' "$BUILD_GATE" \
    | awk -F: '{ rest = substr($0, index($0, ":") + 1); if (rest !~ /^[[:space:]]*#/) { print $1; exit } }' || true)
  ASSERT_LINE=$(grep -n 'DEV_ENTRY\.js' "$BUILD_GATE" | head -1 | cut -d: -f1 || true)

  if [ -z "$BUILD_LINE" ] || [ -z "$ASSERT_LINE" ]; then
    fail "could not locate the build and the entryFile assertion — this gate's parser is stale, not the code"
  elif [ "$BUILD_LINE" -lt "$ASSERT_LINE" ]; then
    pass "the backend build (line $BUILD_LINE) runs before the entryFile assertion (line $ASSERT_LINE)"
  else
    fail "the entryFile assertion (line $ASSERT_LINE) runs BEFORE the build (line $BUILD_LINE)"
    printf '        it will pass on a machine with a stale dist/ and fail on a clean runner\n'
  fi
fi

# --- 2. Script paths are matched at a token boundary -------------------------
SCRIPTS_GATE="$ROOT/optioniaWooCommerceBackend/bin/check-scripts.sh"

if [ ! -f "$SCRIPTS_GATE" ]; then
  fail "check-scripts.sh is missing — this gate's path is stale"
elif grep -q 'body\.match(/(\^|\\s)' "$SCRIPTS_GATE"; then
  pass "script paths are matched at a token boundary, not mid-string"
else
  fail "check-scripts.sh no longer anchors its path pattern"
  printf '        an unanchored (src|test|bin)/ matches inside dist/<project>/src/main.js\n'
  printf '        and reports a correct start:prod as referencing a missing file\n'
fi

if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32mAll gate-integrity checks passed.\033[0m\n'
else
  printf '\n\033[31m%d gate-integrity check(s) failed.\033[0m\n' "$FAILED"
fi

exit "$FAILED"
