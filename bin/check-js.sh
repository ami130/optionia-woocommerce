#!/usr/bin/env bash
#
# Frontend JavaScript guards.
#
# Phase 10 Stage 5 added the first JavaScript to this plugin, and every other
# gate is PHP-shaped: PHPCS parses PHP, PHPUnit runs PHP, and of the eight checks
# only `check-secrets.sh` reads `.js` -- for credentials, not correctness. So the
# storefront runtime arrived in the one place nothing could see it.
#
# Deliberately not ESLint. That means a `package.json`, a lockfile, a `node`
# step in a CI job that installs only PHP today, and a dependency tree to keep
# current -- real weight for a handful of files. `node --check` needs none of
# that and catches the failure that actually ships: a syntax error that makes the
# whole bundle a no-op, silently, on every product page.
#
# The two rules below are the ones this project has already decided and would
# otherwise enforce by hope.
#
# Usage: bash bin/check-js.sh

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

FILES=$(find assets/js -name '*.js' ! -name '*.min.js' -type f 2>/dev/null | sort)
COUNT=$(printf '%s\n' "$FILES" | grep -c . || true)

# A gate that inspects no files passes for the wrong reason. Two ship today --
# the frontend runtime and the admin script.
FLOOR=2

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found only $COUNT JavaScript file(s) (floor $FLOOR) -- the search is wrong, not the code"
  echo
  printf '\033[31m%d JavaScript check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

# --- 1. It parses ------------------------------------------------------------
#
# `node --check` and nothing else. A syntax error in a bundle WordPress enqueues
# does not fail loudly: the browser refuses the file, every listener never binds,
# and the page looks fine until a customer tries to choose an option.
if ! command -v node >/dev/null 2>&1; then
  fail "node is not available, so no JavaScript was parsed -- install it or drop this gate honestly"
else
  BAD=''

  for file in $FILES; do
    node --check "$file" >/dev/null 2>&1 || BAD="$BAD $file"
  done

  if [ -n "$BAD" ]; then
    fail "JavaScript does not parse:$BAD"
  else
    pass "all $COUNT JavaScript file(s) parse"
  fi
fi

# --- 2. No jQuery ------------------------------------------------------------
#
# M10.3: "Vanilla ES6, no jQuery." Not a style preference -- jQuery is a
# dependency this plugin would be asking every storefront to load, and
# WooCommerce's own variation script already owns the events we listen to. The
# moment one `$(...)` lands, the next is free.
#
# Comments are stripped first: this file's own docblocks say "no jQuery", and a
# rule that its own explanation trips is a rule nobody keeps.
JQUERY=''

for file in $FILES; do
  if perl -0777 -ne 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; exit(1) if /\bjQuery\b|\$\s*\(/' "$file"; then
    :
  else
    JQUERY="$JQUERY $file"
  fi
done

if [ -n "$JQUERY" ]; then
  fail "jQuery used in:$JQUERY"
  printf '        M10.3 is explicit: vanilla ES6. WooCommerce already loads its own.\n'
else
  pass "no jQuery in $COUNT file(s)"
fi

# --- 3. No debugging left in -------------------------------------------------
#
# A `console.log` left in ships to every customer's browser and, worse, is how
# selection state ends up in a support screenshot. `console.error` is excluded
# from the same reasoning only if it is deliberate -- it is not, today.
#
# `debugger` is the same accident wearing different clothes, and a worse one: it
# does nothing in normal browsing, so it survives every manual check, and then
# halts the page for the one customer who happens to have devtools open. Added
# after an audit found the gate caught the first and not the second.
#
# `window["console"]["log"]` still passes, and that is where this stops. Nobody
# writes bracket-access console by accident -- that is an author defeating the
# gate rather than forgetting to remove a line, and a check cannot outrun
# someone who is trying.
DEBUG_LEFT=''

for file in $FILES; do
  if perl -0777 -ne 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; exit(1) if /\bconsole\s*\.|\bdebugger\b/' "$file"; then
    :
  else
    DEBUG_LEFT="$DEBUG_LEFT $file"
  fi
done

if [ -n "$DEBUG_LEFT" ]; then
  fail "console output or a debugger statement left in:$DEBUG_LEFT"
else
  pass "no console output or debugger in $COUNT file(s)"
fi

# --- Behaviour ---------------------------------------------------------------
#
# The three checks above are static: they prove the file parses and avoids two
# banned constructs. Neither would have caught either defect this file has
# actually shipped.
#
# A dropdown's price estimate totalled £0 for an entire stage, because the
# selector matched `<select>` -- which is never `:checked` -- while the prices
# sit on its `<option>` children. And the character counter's grapheme parity
# with PHP was proven twice by throwaway harnesses that were then deleted, so
# nothing stopped it regressing to `.length`.
#
# `tests/js/` drives the real file through jsdom. The fixtures its contract
# tests read are produced by the **real renderer** first, because reading
# attribute placement out of PHP source with a regex does not work: those
# attributes sit inside `<?php if ( ... ) : ?>` blocks, and any `[^>]*` pattern
# stops at the `?>`.
if [ ! -d node_modules ]; then
  # 🔴 **A skip on a developer machine; a failure in CI.**
  #
  # Locally, someone running the PHP gates without having opted into the Node
  # tooling should be told, not blocked. In CI there is no such person: absent
  # tooling means the suite silently did not run, and the gate would report
  # "All JavaScript checks passed" over 47 tests that never executed.
  #
  # Measured before this guard existed — that is exactly what happened, which
  # made the whole stage worthless in the one place it mattered.
  if [ -n "${CI:-}" ]; then
    fail "node_modules/ absent in CI -- the behavioural tests did not run (add: npm ci)"
  else
    printf '\033[33mskip\033[0m  node_modules/ absent -- run: npm install (behaviour not tested)\n'
  fi
else
  PHP_BIN="${OPTIONIA_PHP:-php}"

  if ! command -v "$PHP_BIN" >/dev/null 2>&1; then
    fail "PHP is unavailable, so the rendered fixtures cannot be regenerated"
  elif ! "$PHP_BIN" tests/js/generate-fixtures.php >/dev/null 2>&1; then
    fail "could not render the template fixtures the contract tests read"
  elif npx vitest run --silent >/dev/null 2>&1; then
    pass "storefront runtime behaviour (vitest)"
  else
    fail "storefront runtime tests failed -- run: npx vitest run"
  fi
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d JavaScript check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll JavaScript checks passed.\033[0m\n'
