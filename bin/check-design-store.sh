#!/usr/bin/env bash
#
# Continuous gestures do not enter the undo history.
#
# ## Why this exists
#
# 🔴 **The Design Lab's store splits its mutations in two, and the split is easy
# to "tidy" away.** Discrete acts — add, delete, reorder, lock, change a style —
# each commit a snapshot. Continuous ones — dragging, nudging, the opacity and
# rotation sliders — only notify, and the COMPONENTS debounce a commit when the
# gesture ends: 250ms after a slider, 400ms after a nudge, immediately on drag
# release.
#
# ⚠️ **A setter that commits on every tick fills all eighty history entries with
# one slider drag**, and undo then steps back a pixel at a time. Nothing about
# that looks wrong in a diff: `this.commit()` beside `this.notify()` reads like
# the obviously consistent thing to do.
#
# 📌 **The store deliberately does not know when a gesture ends**, which is why
# the rule cannot be expressed in its own types.
set -euo pipefail

printf '\033[1m== check-design-store.sh ==\033[0m\n'
printf 'Checking the design store…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/store.ts"
SPEC="$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/store.test.ts"

if [ ! -f "$STORE" ]; then
  fail "the design store is missing — this gate is checking nothing"
  exit 1
fi

strip_comments() {
  perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g;' "$1"
}

# The body of one method, comments stripped — so prose about committing can
# never read as a commit.
method_body() {
  strip_comments "$STORE" \
    | awk -v name="$1" '
        $0 ~ "^  " name "\\(" { inside = 1 }
        inside { print }
        inside && /^  \}$/ { exit }
      '
}

# 1. Continuous gestures notify and never commit.
CONTINUOUS="setOpacity
setRotation
nudge"

OFFENDERS=""
CHECKED=0

while IFS= read -r name; do
  [ -z "$name" ] && continue

  body=$(method_body "$name")

  if [ -z "$body" ]; then
    fail "$name is missing from the store — this gate's method list is stale"
    continue
  fi

  CHECKED=$((CHECKED + 1))

  if printf '%s' "$body" | grep -q 'this\.commit()'; then
    OFFENDERS="$OFFENDERS  $name\n"
  fi
done <<EOF
$CONTINUOUS
EOF

if [ "$CHECKED" -eq 0 ]; then
  fail "checked no methods at all — the parser is wrong, not the code"
elif [ -n "$OFFENDERS" ]; then
  fail "continuous gesture(s) committing to history:"
  printf "%b" "$OFFENDERS" | sed 's|^|      |'
  printf '        one slider drag would fill all eighty history entries\n'
  printf '        the caller debounces a commit when the gesture ends\n'
else
  pass "all $CHECKED continuous gesture(s) notify without committing"
fi

# 2. Discrete acts DO commit.
#
# ⚠️ **The inverse, deliberately.** A gate that only forbids passes on a store
# where nothing commits at all — and then undo does nothing, which is the
# quieter failure of the two.
DISCRETE="addLayer
duplicateLayer
removeLayerById
reorderByIds
toggleLock
setStyle"

MISSING=""

while IFS= read -r name; do
  [ -z "$name" ] && continue

  body=$(method_body "$name")

  if [ -n "$body" ] && ! printf '%s' "$body" | grep -q 'this\.commit()'; then
    MISSING="$MISSING  $name\n"
  fi
done <<EOF
$DISCRETE
EOF

if [ -n "$MISSING" ]; then
  fail "discrete act(s) that no longer commit:"
  printf "%b" "$MISSING" | sed 's|^|      |'
  printf '        undo would skip straight past them\n'
else
  pass "every discrete act still commits"
fi

# 3. The store stays headless.
#
# 🔴 It is testable without a browser only because nothing here touches the DOM
# at module load. This project has no JSX runner, so a store that needed one
# would be untestable rather than merely awkward.
if strip_comments "$STORE" | grep -qE "from 'react'|from 'next/|document\.|window\."; then
  fail "the design store reaches for React or the DOM — it is no longer headless"
else
  pass "the store is headless (no React, no DOM)"
fi

# 4. Its suite actually ran.
#
# ⚠️ A floor rather than a name: emptying a describe block leaves the file
# passing while checking nothing, which is how two earlier gates in this
# repository went quiet.
STORE_MIN=28

if [ ! -f "$SPEC" ]; then
  fail "the store suite is missing"
else
  RAN=$( cd "$ROOT/optioniaWooCommerceFrontend" \
    && npx vitest run src/lib/design-lab/store.test.ts --reporter=json 2>/dev/null \
    | node -e "
      let raw = '';
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', () => {
        const start = raw.indexOf('{');
        try {
          process.stdout.write(String(JSON.parse(raw.slice(start)).numPassedTests ?? 0));
        } catch {
          process.stdout.write('0');
        }
      });
    " || true )

  if [ "${RAN:-0}" -lt "$STORE_MIN" ]; then
    fail "the store suite ran ${RAN:-0} test(s), below the floor of $STORE_MIN"
  else
    pass "the store suite ran $RAN tests"
  fi
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d design-store check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll design-store checks passed.\033[0m\n'
