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

# 5. Every decision module the canvas was built on is actually wired to it.
#
# 🔴 **The defect this repository has met five times**: logic built, typed,
# tested and reached by nothing. Here the risk is sharper than usual, because
# the whole point of `drag-dispatch` and `selection-box` was to pull decisions
# OUT of the component — and an extraction that is never imported back leaves
# the component with a second, divergent copy of the rule, both green.
CANVAS="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/design-canvas.tsx"

if [ ! -f "$CANVAS" ]; then
  fail "the canvas component is missing"
else
  WIRED=0
  MISSING=""

  for sym in dragIntentFor selectsLayer moveTo resizeFrom rotateTo \
             drawnSelectionRect showsHandles handlesFor attachStage; do
    # ⚠️ **A CALL, not a mention.** Matching the bare name passes on the import
    # line alone — so deleting the call site while leaving the import tidy-up
    # for later would keep this green. Caught by mutating the call away and
    # watching the gate pass anyway, which is why it now requires the paren.
    if grep -qE "\b$sym\(" "$CANVAS"; then
      WIRED=$((WIRED + 1))
    else
      MISSING="$MISSING $sym"
    fi
  done

  if [ -n "$MISSING" ]; then
    fail "the canvas does not use:$MISSING (an extraction nothing imports is a second copy of the rule)"
  else
    pass "all $WIRED extracted decision(s) are wired to the canvas"
  fi

  # The component must not re-implement what it was given.
  #
  # ⚠️ `Math.atan2` is the specific one: `rotateTo` does its own, and a second
  # call in the component meant the angle was computed twice and the function
  # handed the result of the first — which is exactly the bug this caught.
  if grep -q "Math\.atan2" "$CANVAS"; then
    ATAN_COUNT=$(grep -c "Math\.atan2" "$CANVAS")

    if [ "$ATAN_COUNT" -gt 1 ]; then
      fail "the canvas calls Math.atan2 $ATAN_COUNT times; rotateTo owns that maths"
    else
      pass "the canvas measures the opening angle once and delegates the rest"
    fi
  else
    fail "the canvas never measures the drag's opening angle"
  fi
fi

# 6. The Design Lab is not yet reachable, and says so.
#
# ⚠️ **This asserts a KNOWN GAP rather than hiding it.** `DesignCanvas` has no
# route and no nav entry until M26d.4; gate 30 (page reachability) cannot see it
# because it is a component rather than a page. Rather than leave the hole
# unmarked, this fails the moment the component gains a consumer WITHOUT the
# note below being removed — so the next person must delete this block
# deliberately, having actually wired the route.
CANVAS_CONSUMERS=$( grep -rl "\bDesignCanvas\b" \
  "$ROOT/optioniaWooCommerceFrontend/src" \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v '\.test\.' \
  | grep -cv 'design-canvas\.tsx$' || true )

if [ "${CANVAS_CONSUMERS:-0}" -eq 0 ]; then
  pass "the canvas is knowingly unreachable (no route until M26d.4)"
else
  fail "the canvas now has a consumer — wire gate 30 to its route and delete this check"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d design-store check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll design-store checks passed.\033[0m\n'
