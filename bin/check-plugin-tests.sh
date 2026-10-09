#!/usr/bin/env bash
#
# The plugin's test suite runs, and its harness is not silently incomplete.
#
# ## Why this exists
#
# 🔴 **91 tests sat broken for a week and nothing noticed.** `RendererTest`
# errored on every one of them with `Call to undefined function wp_date()`,
# from 2026-09-29 until 2026-10-06. Not a defect in the plugin — `wp_date()`
# exists in real WordPress — but the harness never stubbed it, so a quarter of
# the storefront rendering suite could not run.
#
# ⚠️ **The damage was worse than "91 red tests", and this is the part worth
# understanding.** Fixing the stub moved the suite from 3,347 assertions to
# **3,582**: 235 assertions had never executed. The tests were not merely
# failing loudly — they were loading, erroring early, and taking their
# assertions with them. A suite can be a third dormant and still look like a
# suite.
#
# 📌 **Nothing in the repository ran these tests.** The backend has its gates;
# the plugin's own `composer check` runs `phpcs` and the architecture script,
# neither of which executes a single test. The blind spot was total, which is
# why it lasted a week and was found by accident while building something else.
#
# ## What is checked
#
#   1. **The suite runs and passes.** 6.5 seconds, which is cheap enough to pay
#      on every commit and is the only check that catches a breakage of a kind
#      nobody predicted.
#   2. **Every WordPress function production code calls is stubbed.** This is
#      the specific shape that failed, and it is caught *by name* so the
#      failure says which function is missing rather than leaving a developer
#      to read 91 identical stack traces.
#
# 🔴 **Both, not either.** Running the suite alone would catch this one, but
# only once it had already broken something. The stub check catches the next
# `wp_date` the moment production code reaches for it — before a test errors,
# and naming the cause.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/optioniaWooCommercePlugin"

printf '\033[1m== check-plugin-tests.sh ==\033[0m\n'
printf 'Checking the plugin suite runs, and its harness is complete...\n'

# ⚠️ **PHP is not on the PATH in every environment here**, and a gate that
# failed for that reason would be telling a backend-only developer their commit
# is broken when it is not. Studio ships its own binaries; the newest is used so
# a syntax feature the plugin relies on is not missing from an older one.
PHP=""

if command -v php >/dev/null 2>&1; then
  PHP="php"
else
  CANDIDATE=$(ls -d "$HOME"/.studio/php-bin/*/php 2>/dev/null | sort -V | tail -1 || true)

  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    PHP="$CANDIDATE"
  fi
fi

# 🔴 **Skip for a developer; FAIL in CI.** The same rule the JavaScript suite
# below follows, and for the same measured reason: without it this gate reported
# success while 1974 tests did not run. `ci.yml` installs PHP and Composer so the
# skip never fires there — and if that step is ever dropped, this says so rather
# than going quietly green.
if [ -z "$PHP" ]; then
  if [ -n "${CI:-}" ]; then
    fail "no PHP interpreter in CI — the plugin suite did not run (add: setup-php)"
  else
    printf '\033[33mskip\033[0m  the plugin suite: no PHP interpreter found\n'
  fi
elif [ ! -f "$PLUGIN/vendor/bin/phpunit" ]; then
  if [ -n "${CI:-}" ]; then
    fail "vendor/ absent in CI — the plugin suite did not run (add: composer install)"
  else
    printf '\033[33mskip\033[0m  the plugin suite: dependencies not installed\n'
  fi
else
  if ( cd "$PLUGIN" && "$PHP" vendor/bin/phpunit --testsuite unit ) >/tmp/check-plugin-tests.log 2>&1; then
    COUNT=$(grep -aoE "OK \([0-9]+ tests, [0-9]+ assertions\)" /tmp/check-plugin-tests.log | head -1 || true)
    pass "the plugin suite passes${COUNT:+ — ${COUNT#OK }}"
  else
    fail "the plugin suite does not pass"
    grep -aE "^[0-9]+\) |^Tests: |Error: " /tmp/check-plugin-tests.log | head -6 | sed 's/^/        /' || true
  fi
fi

# --- The plugin's JavaScript suite -------------------------------------------
#
# 🔴 **174 tests were running nowhere.** The plugin ships `vitest` + `jsdom`
# and a harness that loads the real `assets/js/frontend.js`, and this gate ran
# PHPUnit only — so the entire JS suite passed or failed on whether a developer
# happened to type `npx vitest` by hand. `frontend.js` is over 2,000 lines of
# storefront runtime: the half of this plugin a customer actually touches was
# protected by nothing automated.
#
# ⚠️ **A missing `node_modules` is a skip, not a pass.** A gate that reports
# success because it could not run is worse than one that is absent, since it
# answers the question it never asked.
if [ ! -f "$PLUGIN/package.json" ]; then
  printf '\033[33mskip\033[0m  the plugin JS suite: no package.json\n'
elif ! command -v npx >/dev/null 2>&1; then
  printf '\033[33mskip\033[0m  the plugin JS suite: npx not found\n'
elif [ ! -d "$PLUGIN/node_modules" ]; then
  # 🔴 **A skip on a developer machine; a FAILURE in CI.** This is the plugin's
  # own convention, from `bin/check-js.sh`: a person who has not installed the
  # JavaScript tooling should be told, not blocked, but in CI there is nobody to
  # tell and a green gate that ran nothing is worse than a red one. Measured
  # before this was added — moving `node_modules` away left the gate reporting
  # success with all 191 tests unrun.
  if [ -n "${CI:-}" ]; then
    fail "node_modules/ absent in CI — the plugin JS suite did not run (add: npm ci)"
  else
    printf '\033[33mskip\033[0m  the plugin JS suite: dependencies not installed\n'
  fi
elif [ -z "$PHP" ]; then
  # The fixtures below need PHP. Without it this cannot run honestly either way.
  if [ -n "${CI:-}" ]; then
    fail "no PHP interpreter in CI — the rendered fixtures cannot be generated"
  else
    printf '\033[33mskip\033[0m  the plugin JS suite: no PHP to render its fixtures\n'
  fi
else
  # 🔴 **The contract suite reads fixtures that are GENERATED, not committed.**
  # `tests/js/rendered-fixtures.json` is gitignored and written by
  # `tests/js/generate-fixtures.php` from the real templates. An earlier version
  # of this gate ran `npx vitest run` alone, which passed on a developer machine
  # that already had the file and failed on every fresh clone — measured in CI:
  # `FAIL tests/js/frontend-contract.test.js`.
  #
  # ⚠️ **Regenerated every run, never reused.** The fixtures exist so the
  # contract tests read what the templates ACTUALLY render; a stale copy would
  # let the templates drift away from the runtime silently, which is the one
  # failure this suite exists to catch.
  #
  # 📌 **The plugin's own `bin/check-js.sh` does exactly this** (its line ~165).
  # This gate duplicated the vitest call without the step before it.
  if ! ( cd "$PLUGIN" && "$PHP" tests/js/generate-fixtures.php ) >/tmp/check-plugin-fixtures.log 2>&1; then
    fail "could not render the template fixtures the contract tests read"
    tail -3 /tmp/check-plugin-fixtures.log | sed 's/^/        /' || true
  elif ( cd "$PLUGIN" && npx vitest run ) >/tmp/check-plugin-js.log 2>&1; then
    JSCOUNT=$(grep -aoE "Tests +[0-9]+ passed" /tmp/check-plugin-js.log | head -1 || true)
    pass "the plugin JS suite passes${JSCOUNT:+ — ${JSCOUNT#Tests }}"
  else
    fail "the plugin JS suite does not pass"
    grep -aE "FAIL|AssertionError|Tests +[0-9]+ failed" /tmp/check-plugin-js.log | head -6 | sed 's/^/        /' || true
  fi
fi

# --- Every WordPress function production code calls must be stubbed ----------
#
# 📌 **Matched on the CALL, not on an import**, because PHP has no imports for
# these — a bare `wp_date(...)` is the only evidence that production code needs
# it. Namespaced calls (`Optionia\Frontend\wp_date`) resolve to the global at
# runtime, which is exactly how the missing stub produced its error message.
BOOTSTRAP="$PLUGIN/tests/bootstrap.php"

if [ ! -f "$BOOTSTRAP" ]; then
  fail "the test bootstrap is missing — this gate's path is stale"
else
  # Functions the plugin itself defines are not WordPress's to stub.
  OWN=$(grep -rhoE "^\s*(public |private |protected |static )*function [a-z_]+" \
    "$PLUGIN/src" --include='*.php' 2>/dev/null \
    | sed -E 's/.*function //' | sort -u || true)

  STUBBED=$(grep -oE "^\s*function [a-z_]+" "$BOOTSTRAP" \
    | sed -E 's/.*function //' | sort -u || true)

  # ⚠️ **`wp_`, `wc_` and the escaping helpers only.** A wider net would sweep
  # in PHP's own built-ins and report a hundred false positives, which is how a
  # gate gets switched off rather than fixed.
  #
  # 🔴 **Comments are stripped first, and the first version did not.** It
  # reported `wp_strip_all_tag` — a name that exists nowhere, truncated out of
  # the prose `wp_strip_all_tags()'s behaviour` inside a docblock that explains
  # why the function is *reimplemented rather than called*. A gate that invents
  # a missing function is one a developer switches off rather than fixes.
  #
  # ⚠️ **Three things this extraction has to get right, each learned from a
  # false positive the first version produced:**
  #
  #   1. **Comments stripped**, or the prose `wp_strip_all_tags()'s behaviour`
  #      in a docblock explaining why that function is *reimplemented rather
  #      than called* is reported as a missing stub.
  #   2. **`$wpdb->esc_like()` is a METHOD**, not a global function, so a bare
  #      word-boundary match reports a stub that would do nothing if written.
  #   3. **`function_exists()` guards mean the call is OPTIONAL.** `Assets`
  #      wraps `wc_get_price_decimals()` in one precisely so the plugin works
  #      where WooCommerce does not define it; demanding a stub for a call the
  #      code already handles the absence of would be the gate inventing work.
  CALLED=$(find "$PLUGIN/src" -name '*.php' -print0 2>/dev/null \
    | xargs -0 -n 1 perl -0777 -pe "s{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; s{^\s*#[^\n]*}{}gm;" 2>/dev/null \
    | grep -oE "(->)?\b(wp_|wc_|esc_|sanitize_|wptexturize)[a-z_]+[[:space:]]*\(" \
    | grep -v -- '->' \
    | sed -E 's/[[:space:]]*\($//' \
    | tr -d '(' \
    | sort -u || true)

  # Names the code itself tests for before calling: absence is already handled.
  #
  # 🔴 **Guarded EVERYWHERE, not guarded somewhere — and the first version got
  # this wrong in the one way that mattered.** `StoreClock` wraps `wp_date()`
  # in `function_exists()`; `Assets` calls it bare. With a global by-name
  # exclusion, that single guarded call site exempted the unguarded one, and
  # the gate reported *"all 57 stubbed"* with the stub deleted — silent about
  # the exact defect it was written to catch. Measured by removing the stub and
  # watching it pass.
  #
  # 📌 **So a name is excluded only when every occurrence of it is guarded.**
  # Counting both is cheaper than parsing scope, and errs toward reporting:
  # a function called ten times with one bare call still needs its stub.
  STRIPPED=$(find "$PLUGIN/src" -name '*.php' -print0 2>/dev/null \
    | xargs -0 -n 1 perl -0777 -pe "s{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; s{^\s*#[^\n]*}{}gm;" 2>/dev/null || true)

  guarded_everywhere() {
    GUARDS=$(printf '%s' "$STRIPPED" | grep -coE "function_exists\([[:space:]]*'$1'" || true)
    CALLS=$(printf '%s' "$STRIPPED" | grep -coE "(^|[^>a-z_])$1[[:space:]]*\(" || true)

    [ "${GUARDS:-0}" -gt 0 ] && [ "${CALLS:-0}" -le "${GUARDS:-0}" ]
  }

  MISSING=""

  for fn in $CALLED; do
    if printf '%s\n' "$STUBBED" | grep -qx "$fn"; then
      continue
    fi

    if printf '%s\n' "$OWN" | grep -qx "$fn"; then
      continue
    fi

    if guarded_everywhere "$fn"; then
      continue
    fi

    MISSING="$MISSING $fn"
  done

  MISSING=$(printf '%s' "$MISSING" | sed -E 's/^ //')

  if [ -n "$MISSING" ]; then
    fail "production code calls WordPress functions the harness does not stub"
    printf '        a test that reaches one errors before it asserts anything\n'

    for fn in $MISSING; do
      printf '        missing: %s()\n' "$fn"
    done
  else
    TOTAL=$(printf '%s\n' "$CALLED" | grep -c . || true)
    pass "all ${TOTAL} WordPress function(s) production code calls are stubbed"
  fi
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d plugin-test check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll plugin-test checks passed.\033[0m\n'
