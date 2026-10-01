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
#
# ## How to write a check here, learned the hard way
#
# 🔴 **Match inside the BLOCK the rule is about, never across the file.** Four
# commits running, a majority of new checks in this gate passed their first
# mutation, and every failure was the same shape — a `grep` finding the string
# somewhere else:
#
#   - `<DesignLabDialog` matched inside `<DesignLabDialogX`
#   - `updateValue(…design…)` also appears in the undo and redo callbacks
#   - `saveDesign.error` is named twice per branch, so a count of 2 meant 1
#   - `Design ${value.label}` is the BUTTON's label as well as the undo entry's
#   - `pointer-events: auto` and `--dl-zoom` matched this file's own comments
#
# ⚠️ **So: strip comments, extract the enclosing function or JSX block with
# `perl -0ne`, and match within it.** A bare `grep -q NAME "$FILE"` over a
# 4,300-line editor is a check that something is mentioned, not that it is done.
#
# 📌 **And prove every new check fails.** Not one of those was found by review.
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

# 6. The canvas has a stylesheet, and it is the FUNCTIONAL kind.
#
# 🔴 **Found by audit, after the component was committed.** The canvas emitted
# twelve class names that nothing styled, and this is not a cosmetic gap: the
# overlay sets `pointer-events: none` so clicks reach the layers beneath, and
# each grip takes it back with `pointer-events: auto`. Without the stylesheet a
# handle is a zero-size div that cannot receive a mousedown — so `resize` and
# `rotate` are unreachable however correct the dispatch logic is. The component
# compiled, the suite passed and 33 gates were green while half the editor could
# not be operated.
STYLES="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/design-lab.css"

if [ ! -f "$STYLES" ]; then
  fail "the canvas stylesheet is missing — handles would be unclickable"
else
  # The component must actually import it; an unreferenced file styles nothing.
  if grep -q "design-lab.css" "$CANVAS"; then
    pass "the canvas imports its stylesheet"
  else
    fail "the canvas does not import design-lab.css"
  fi

  # ⚠️ **Comments are stripped first, and that is not fussiness.** The first
  # version of these checks matched `pointer-events: auto` and `--dl-zoom`
  # inside this file's own prose, so three of them passed while the
  # declarations they describe were gone. A check that reads the commentary
  # about its subject rather than the subject is the recurring defect of this
  # phase; stripping is what makes the match mean something.
  CSS_CODE="$(mktemp)"
  trap 'rm -f "$CSS_CODE"' EXIT
  perl -0pe 's{/\*.*?\*/}{}gs' "$STYLES" > "$CSS_CODE"

  # Every class the component emits must appear in SELECTOR position — between a
  # `}` (or the start of the file) and the next `{`. Matching a bare `.foo`
  # anywhere would be satisfied by a declaration value; anchoring to the start of
  # a line would reject the legitimate compound selectors this file uses, such as
  # `.canvas.checker` and `.overlay.is-dragging .handle-pt`. Both were tried, and
  # the second rejected two real rules — hence this.
  SELECTORS="$(mktemp)"
  perl -0ne 'print "$1\n" while /(?:^|\})([^{}]*)\{/gs' "$CSS_CODE" > "$SELECTORS"

  UNSTYLED=""
  EMITTED=0

  for cls in $(grep -oE "optionia-designlab-[a-z-]+" "$CANVAS" | sort -u); do
    EMITTED=$((EMITTED + 1))

    # ⚠️ The boundary must exclude every character a CSS identifier may
    # continue with — letters of EITHER case, digits, `-` and `_`. An earlier
    # version excluded lowercase only, so `.foo` matched inside `.fooX` and a
    # renamed rule still satisfied the check.
    grep -qE "\.$cls([^A-Za-z0-9_-]|\$)" "$SELECTORS" || UNSTYLED="$UNSTYLED $cls"
  done

  rm -f "$SELECTORS"

  if [ -n "$UNSTYLED" ]; then
    fail "class(es) emitted but never styled:$UNSTYLED"
  else
    pass "all $EMITTED emitted class(es) have a rule"
  fi

  # 🔴 The pointer-events chain, asserted on the SPECIFIC selectors that carry
  # it. The overlay must fall through; both grips must take the click back. A
  # count alone would survive the declarations moving to the wrong rule.
  CHAIN_OK=1

  overlay_block="$(perl -0ne 'print $1 if /\.optionia-designlab-canvas-overlay\s*\{(.*?)\}/s' "$CSS_CODE")"
  case "$overlay_block" in *"pointer-events: none"*) ;; *) CHAIN_OK=0 ;; esac

  handle_block="$(perl -0ne 'print $1 if /\.optionia-designlab-handle-pt\s*\{(.*?)\}/s' "$CSS_CODE")"
  case "$handle_block" in *"pointer-events: auto"*) ;; *) CHAIN_OK=0 ;; esac

  rotate_block="$(perl -0ne 'print $1 if /\.optionia-designlab-rotate-pt\s*\{(.*?)\}/s' "$CSS_CODE")"
  case "$rotate_block" in *"pointer-events: auto"*) ;; *) CHAIN_OK=0 ;; esac

  if [ "$CHAIN_OK" -eq 1 ]; then
    pass "the overlay falls through and both grips take the click back"
  else
    fail "the overlay's pointer-events chain is broken — grips would not be clickable"
  fi

  # The grips counter-scale against a property the fit must publish. Checked
  # against the store's CODE, since a comment naming it proves nothing.
  STORE_CODE="$(mktemp)"
  perl -0pe 's{/\*.*?\*/}{}gs; s{//.*$}{}gm' \
    "$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/store.ts" > "$STORE_CODE"

  if grep -q -- "--dl-zoom" "$CSS_CODE" \
    && grep -q "setProperty('--dl-zoom'" "$STORE_CODE"; then
    pass "the grips counter-scale against the zoom the fit publishes"
  else
    fail "--dl-zoom is read by the stylesheet but never published by fitCanvas (grips shrink with the canvas)"
  fi

  rm -f "$STORE_CODE"
fi

# 7. A layer that cannot be dragged says so with its cursor.
#
# ⚠️ **`pinned` is a distinct refusal precisely so the UI can explain it.**
# `dragIntentFor` returns `select-only` with reason `pinned` for a layer whose
# style allows no movement; without a cursor the explanation is never given and
# the layer reads as broken rather than constrained.
if grep -q "layerCursor(" "$CANVAS"; then
  pass "the canvas shows which layers can be dragged"
else
  fail "the canvas never sets a cursor — a pinned layer looks draggable and silently refuses"
fi

# 8. The lab is assembled: every part it was built from is mounted.
#
# 🔴 **This replaces the "nothing mounts it yet" check**, which failed the moment
# the dialog appeared — deliberately, so that whoever wired it had to think
# rather than delete a line. The risk it guarded against has not gone away, it
# has moved: a canvas with no panels, or panels built over a second copy of the
# rules, would still compile and still pass every other check here.
DIALOG="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/design-lab-dialog.tsx"
LIST="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/layer-list.tsx"
PROPS="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/properties-panel.tsx"

if [ ! -f "$DIALOG" ] || [ ! -f "$LIST" ] || [ ! -f "$PROPS" ]; then
  fail "the Design Lab is incomplete — dialog, layer list and properties panel are one feature"
else
  MISSING=""

  for part in DesignCanvas LayerList PropertiesPanel; do
    grep -q "<$part\b" "$DIALOG" || MISSING="$MISSING $part"
  done

  if [ -n "$MISSING" ]; then
    fail "the dialog does not mount:$MISSING"
  else
    pass "the dialog mounts the canvas and both panels"
  fi

  # 📌 The two conversion points, and the ONLY place both are called. M26c.2's
  # contract is that fractions become editor pixels in exactly two functions;
  # a second caller would be a third conversion nobody is watching.
  if grep -q "store.importDesign(" "$DIALOG" && grep -q "store.exportDesign(" "$DIALOG"; then
    pass "the dialog hydrates and returns a design through the two conversion points"
  else
    fail "the dialog does not round-trip a design (importDesign / exportDesign)"
  fi

  # ⚠️ The panels must be built over the tested decisions, not their own copies.
  PANEL_MISSING=""

  for sym in listOrder backgroundOf canMoveUp canMoveDown moveInList rowActions; do
    grep -qE "\b$sym\(" "$LIST" || PANEL_MISSING="$PANEL_MISSING $sym"
  done

  grep -qE "\bpanelState\(" "$PROPS" || PANEL_MISSING="$PANEL_MISSING panelState"

  if [ -n "$PANEL_MISSING" ]; then
    fail "the panels re-derive rather than use:$PANEL_MISSING"
  else
    pass "both panels are built over the tested decisions"
  fi

  # 🔴 The slider contract's other half. `setRotation` and `setOpacity` notify
  # WITHOUT committing, by design — committing each input would make one undo
  # move a slider by a single step. The debounce in the panel is what turns a
  # drag into one undo entry, and nothing else tests it.
  #
  # ⚠️ **The commit must be INSIDE the timeout, which is the whole point.** An
  # earlier version asked only that `setTimeout` and `store.commit()` both
  # appear somewhere in the file — and both survive deleting the debounce,
  # because the cleanup still clears a timer and the commit is still called.
  # Caught by mutating the debounce away and watching this pass.
  #
  # 📌 **Its known limit, stated rather than implied**: an EXTRA immediate
  # commit beside the timer still passes, because the debounced call is still
  # there to match. Catching that needs a real render, which this project cannot
  # do (no JSX runner). What is gated is the structural mistake — a commit that
  # is not debounced at all.
  if perl -0ne 'exit 1 unless /setTimeout\(\s*\(\)\s*=>\s*[a-zA-Z]+\.commit\(\)/s' "$PROPS"; then
    pass "the sliders commit once after a pause, not on every input"
  else
    fail "the properties panel commits outside a timer — a slider drag would be dozens of undo entries"
  fi

  # Every class the panels emit must have a rule, as the canvas's must.
  PANEL_UNSTYLED=""
  PANEL_EMITTED=0
  PANEL_SELECTORS="$(mktemp)"
  perl -0pe 's{/\*.*?\*/}{}gs' "$STYLES" \
    | perl -0ne 'print "$1\n" while /(?:^|\})([^{}]*)\{/gs' > "$PANEL_SELECTORS"

  for cls in $(grep -hoE "optionia-designlab-[a-z-]+" "$DIALOG" "$LIST" "$PROPS" | sort -u); do
    PANEL_EMITTED=$((PANEL_EMITTED + 1))

    grep -qE "\.$cls([^A-Za-z0-9_-]|\$)" "$PANEL_SELECTORS" \
      || PANEL_UNSTYLED="$PANEL_UNSTYLED $cls"
  done

  rm -f "$PANEL_SELECTORS"

  if [ -n "$PANEL_UNSTYLED" ]; then
    fail "panel class(es) emitted but never styled:$PANEL_UNSTYLED"
  else
    pass "all $PANEL_EMITTED panel class(es) have a rule"
  fi
fi

# 8b. Every component that reads the store subscribes to it.
#
# 🔴 **Found by audit, after the lab was committed.** M26d.1 is the one
# milestone in its phase that dictates an implementation — "an explicit state
# engine with subscribe/notify rather than React state… reconciliation on every
# pointer move is why naive implementations feel laggy" — and the first assembly
# adopted the store while inverting the pattern. Only the dialog subscribed; the
# panels read the store with no subscription of their own and updated solely
# because the parent re-rendered its whole subtree. That reconciles the layer
# list, the properties panel and the dialog chrome on every pointer move of a
# drag: exactly the cost the architecture exists to avoid, reintroduced one
# level up. Nothing caught it, because everything still worked.
UNSUBSCRIBED=""

for part in design-canvas layer-list properties-panel design-lab-dialog; do
  file="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/$part.tsx"

  if [ ! -f "$file" ]; then
    UNSUBSCRIBED="$UNSUBSCRIBED $part(missing)"
  elif ! grep -qE "\buseDesignStore\(" "$file"; then
    UNSUBSCRIBED="$UNSUBSCRIBED $part"
  fi
done

if [ -n "$UNSUBSCRIBED" ]; then
  fail "component(s) read the store without subscribing:$UNSUBSCRIBED"
else
  pass "all 4 store-reading component(s) subscribe independently"
fi

# 8c. Every operation M26d.1 names can be reached by a merchant.
#
# 🔴 **The defect this repository has now met six times**: built, typed, tested
# and reached by nothing. Here it was `store.addLayer` and `store.nudge` — "add"
# is M26d.1's FIRST listed capability, and the lab opened onto a canvas a
# merchant could never put anything on, with every other control operating on
# layers that could not exist. `nudge` had its lock guard and commit debounce
# tested, and no caller at all.
#
# ⚠️ **Excluded by name, with a reason**: `setBg` belongs to the background
# picker (M26d.5) and `setChecker` is a backdrop toggle M26d.1 does not name.
UI_DIR="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab"
UNREACHED=""

for op in addLayer nudge reorderByIds toggleLock toggleVisible duplicateLayer \
          deleteLayer setStyle setOpacity setRotation alignH alignV undo redo; do
  grep -rqE "\b(store|this)\.$op\(" "$UI_DIR" --include='*.tsx' \
    || UNREACHED="$UNREACHED $op"
done

if [ -n "$UNREACHED" ]; then
  fail "store operation(s) M26d.1 names have no UI caller:$UNREACHED"
else
  pass "all 14 operation(s) M26d.1 names are reachable"
fi

# 8d. A merchant's image URL is checked before it becomes a layer.
#
# ⚠️ **A security boundary, not a form nicety.** The URL becomes an `<img src>`
# and later an `<image href>` inside an SVG the server rasterises, so a
# `javascript:` URL is an XSS vector and `data:` can carry SVG — which M15
# already refuses on upload. The check is a tested function; the component must
# actually call it rather than trusting the input's `type="url"`.
if grep -qE "\bcheckLayerSource\(" "$UI_DIR/layer-list.tsx"; then
  pass "an added layer's URL is checked before it is loaded"
else
  fail "the add-layer control does not validate its URL (javascript: and data: would pass)"
fi

# 8e. The canvas has a backdrop to compose against.
#
# 🔴 **The lab opened on a blank 392x464 canvas for several commits**, so a
# merchant placed artwork without seeing what it sat on. I twice described that
# as a limitation of shipping before M26d.5 — and the data was already there:
# Phase 19 syncs every product with its `imageUrl`, and nothing read it.
#
# ⚠️ **The photo must be MEASURED before the design is imported.** `importDesign`
# calls `setCanvasSize` from the aspect and then places every layer against that
# canvas; importing first and resizing after places them against the default and
# leaves them there.
DIALOG_BG="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/design-lab-dialog.tsx"

if [ ! -f "$DIALOG_BG" ]; then
  fail "the Design Lab dialog is missing"
else
  BG_FAILS=0

  grep -qE "\bbackgroundFor\(" "$DIALOG_BG" \
    || { fail "the dialog never builds a background from the product"; BG_FAILS=$((BG_FAILS + 1)); }

  # The measurement, and the import that depends on it, inside one handler.
  ONLOAD=$(perl -0ne 'print $1 if /img\.onload = \(\) => \{(.*?)\n    \};/s' "$DIALOG_BG")

  if [ -n "$ONLOAD" ] \
    && printf '%s' "$ONLOAD" | grep -q "naturalWidth" \
    && printf '%s' "$ONLOAD" | grep -q "importDesign"; then
    pass "the product photo is measured before the design is imported"
  else
    fail "the design is imported without measuring the photo — layers land on the default canvas"
    BG_FAILS=$((BG_FAILS + 1))
  fi

  # 📌 A photo that will not load must not block the lab.
  ONERROR=$(perl -0ne 'print $1 if /img\.onerror = \(\) => \{(.*?)\n    \};/s' "$DIALOG_BG")

  if [ -n "$ONERROR" ] && printf '%s' "$ONERROR" | grep -q "importDesign"; then
    pass "a photo that cannot load still opens the lab on a blank canvas"
  else
    fail "a failed photo load leaves the lab empty — the design would be unreachable"
    BG_FAILS=$((BG_FAILS + 1))
  fi
fi

# 8f. The SVG rule M26d.5 states, enforced on both paths.
#
# 🔴 **"SVG stays rejected — a design lab is not a reason to accept an XSS
# vector."** The scheme check refuses `data:` and `javascript:` and says nothing
# about what an `https:` URL SERVES, so `https://cdn.example.com/evil.svg`
# passed everything — and a layer's `src` becomes an `<image href>` inside the
# SVG the SERVER rasterises, so this is not only a browser concern. I named this
# gap in an audit and shipped without closing it.
LAYER_SRC="$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/layer-source.ts"
BG_SRC="$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/background.ts"

if [ ! -f "$LAYER_SRC" ] || [ ! -f "$BG_SRC" ]; then
  fail "the layer-source or background module is missing"
else
  SVG_FAILS=0

  grep -qE "^export function isVectorImage\(" "$LAYER_SRC" \
    || { fail "no single place decides what a vector image is"; SVG_FAILS=$((SVG_FAILS + 1)); }

  # ⚠️ **One rule, imported — not two copies.** A second regex in the background
  # module would be two rules that agree until one is edited.
  if grep -qE "\.svgz\?" "$BG_SRC"; then
    fail "the background module tests for SVG itself instead of using the shared rule"
    SVG_FAILS=$((SVG_FAILS + 1))
  fi

  # ⚠️ **The REFUSAL, not the name.** `layer-source.ts` declares the function, so
  # matching `isVectorImage(` there matched its own definition and the check
  # stayed green with the refusal deleted. Each file is asserted on what it does
  # with the answer.
  grep -qE "if \(isVectorImage\(url\)\)" "$LAYER_SRC" \
    || { fail "the layer path does not refuse a vector image"; SVG_FAILS=$((SVG_FAILS + 1)); }

  grep -qE "\bisVectorImage\(product\.imageUrl\)" "$BG_SRC" \
    || { fail "background.ts does not refuse a vector image"; SVG_FAILS=$((SVG_FAILS + 1)); }

  if [ "$SVG_FAILS" -eq 0 ]; then
    pass "SVG is refused on the layer path and the backdrop, by one rule"
  fi
fi

# 8g. The backdrop's cache read has the guard it depends on.
#
# ⚠️ **`ValueRow` reads the set with `getQueryData`, which is a one-shot read
# and not a subscription.** It is safe only because the page returns early while
# its set query is loading, so nothing below renders before the cache is filled.
# Remove that guard — a reasonable move toward streaming — and `storeId` is
# undefined, the products query never enables, and the backdrop is silently
# absent with no test failing. The coupling is invisible from the row, so it is
# asserted here.
SET_EDITOR="$ROOT/optioniaWooCommerceFrontend/src/app/(app)/option-sets/[id]/page.tsx"

if grep -qE "if \(query\.isLoading\)" "$SET_EDITOR"; then
  pass "the editor still blocks on its set query, which the backdrop relies on"
else
  fail "the editor no longer blocks on its set query — ValueRow's cache read may now miss"
fi

# 9. The lab opens from a choice, and what it returns is persisted.
#
# 🔴 **This replaces the "not yet bound" check**, which failed the moment the
# trigger appeared — deliberately, so whoever wired it had to think rather than
# delete a line. The risk has moved rather than gone: a dialog that opens and
# returns a design nobody saves looks like a working feature and loses every
# edit.
EDITOR="$ROOT/optioniaWooCommerceFrontend/src/app/(app)/option-sets/[id]/page.tsx"

if [ ! -f "$EDITOR" ]; then
  fail "the option-set editor is missing — the lab has nowhere to open from"
else
  BOUND_FAILS=0

  # The dialog is mounted from the editor.
  #
  # ⚠️ **A word boundary, because `grep` matches substrings.** The first version
  # looked for `<DesignLabDialog` and so matched inside `<DesignLabDialogX` —
  # renaming the component away left the check green. The boundary must include
  # end-of-line: this JSX tag has its props on the lines below it, so a class of
  # trailing characters alone matched nothing and failed on correct code.
  grep -qE "<DesignLabDialog([[:space:]/>]|$)" "$EDITOR" \
    || { fail "nothing opens the Design Lab"; BOUND_FAILS=$((BOUND_FAILS + 1)); }

  # 📌 **Hydrated from the STORED design, not from nothing.** A dialog opened
  # with `design={null}` would compose correctly and silently discard whatever
  # the merchant had saved before — the round trip broken at its last step.
  grep -q "design={" "$EDITOR" \
    || { fail "the dialog is not hydrated from the value's stored design"; BOUND_FAILS=$((BOUND_FAILS + 1)); }

  # 🔴 **And hydrated ON OPEN ONLY.** `importDesign` empties the canvas and
  # resets history, so an effect that also depends on the design prop wipes a
  # merchant's work the moment any new object identity arrives mid-edit — an
  # undo from the history panel, a background refetch, a second tab. The first
  # version did exactly that; `ValueRow` solves the identical problem the right
  # way and says so in a comment I had already read.
  #
  # ⚠️ Asserted on the DEPENDENCY ARRAY, because that is where the defect lives:
  # the call itself looks identical either way.
  DIALOG="$ROOT/optioniaWooCommerceFrontend/src/components/design-lab/design-lab-dialog.tsx"
  #
  # ✏️ **Re-anchored when the photo measurement landed.** The first version
  # matched the dependency array immediately after `importDesign`, which was the
  # effect's last statement until the image load made it one branch of several.
  # It now anchors on the effect's OPENING — `if (!open) return;` — and takes the
  # array that closes it, which does not depend on what the body grows into.
  HYDRATE_DEPS=$(perl -0ne 'print $1 if /if \(!open\) return;(?:(?!useEffect).)*?\n  \}, (\[[^\]]*\])\);/s' "$DIALOG")

  case "$HYDRATE_DEPS" in
    *design*|*background*)
      fail "the dialog re-hydrates when its design prop changes — that discards work in progress"
      BOUND_FAILS=$((BOUND_FAILS + 1))
      ;;
    '')
      fail "could not read the hydration effect's dependencies — has its shape changed?"
      BOUND_FAILS=$((BOUND_FAILS + 1))
      ;;
    *)
      pass "the dialog hydrates on open only, so work in progress survives"
      ;;
  esac

  # 🔴 **And what it returns is WRITTEN.** `onApply` handing the design to a
  # local setState would look identical until the page reloaded.
  #
  # 🔴 **Matched on the MUTATION, not on any `updateValue` naming a design.**
  # The undo and redo callbacks also send a design, so an earlier version
  # stayed green with the primary write gutted: two matches remained and the
  # check only asked for one. What must exist is the handler that writes what
  # the dialog returned.
  #
  # ⚠️ **Scoped to the mutation's own body.** Two earlier versions matched text
  # that exists elsewhere: `updateValue(…design…)` also appears in the undo and
  # redo callbacks, so gutting the primary write left two matches behind and the
  # check green. What is asserted is that the function receiving the applied
  # design is the one that sends it.
  APPLY_BODY=$(perl -0ne 'print $1 if /mutationFn: \(design: DesignData\) =>(.*?)onSuccess:/s' "$EDITOR")

  if grep -q "onApply=" "$EDITOR" \
    && [ -n "$APPLY_BODY" ] \
    && printf '%s' "$APPLY_BODY" | grep -qE "updateValue\(value\.id, \{ design"; then
    pass "the lab opens from a choice and persists what it returns"
  else
    fail "the applied design is never sent to the API"
    BOUND_FAILS=$((BOUND_FAILS + 1))
  fi

  # ⚠️ **Offered only where the API accepts it.** `valueCarriesDesign` mirrors
  # the registry; without it the button appears on a date picker and the
  # merchant loses a whole design to a 400.
  if grep -qE "\bvalueCarriesDesign\(" "$EDITOR"; then
    pass "the Design button is offered only on types that carry one"
  else
    fail "the editor does not check which types carry a design"
    BOUND_FAILS=$((BOUND_FAILS + 1))
  fi

  # 🔴 **A refusal must be visible, in BOTH branches.** The row returns early
  # when collapsed and that branch holds the Design button, so an error rendered
  # only in the editing branch would leave a refused save silent — the merchant
  # watches their work vanish with no reason given.
  #
  # ⚠️ **Counting the RENDERED element, not every mention.** Each branch names
  # `saveDesign.error` twice — once to test it and once to pass it — so a count
  # of the name reached four and `>= 2` passed with a whole branch deleted.
  DESIGN_ERRORS=$(grep -c "<ErrorState error={saveDesign.error}" "$EDITOR" || true)

  if [ "${DESIGN_ERRORS:-0}" -ge 2 ]; then
    pass "a refused design save is reported from either branch of the row"
  else
    fail "a refused design save is invisible in at least one branch (found ${DESIGN_ERRORS:-0})"
    BOUND_FAILS=$((BOUND_FAILS + 1))
  fi

  # 📌 **Undoable, like every other edit in this editor.** M20.10 made the row's
  # field edits reversible; a design applied outside that log would be the one
  # change a merchant could not take back.
  #
  # ⚠️ **Scoped to the design mutation's success handler**, for the same reason.
  # `Design ${value.label}` is also the BUTTON's label, so matching it anywhere
  # in the file passed with the undo entry deleted outright — the one change a
  # merchant could not take back, reported as reversible.
  DESIGN_SUCCESS=$(perl -0ne 'print $1 if /const saveDesign = useMutation\(\{(.*?)\n  \}\);/s' "$EDITOR")

  if [ -n "$DESIGN_SUCCESS" ] && printf '%s' "$DESIGN_SUCCESS" | grep -qE "onRecord\(\{"; then
    pass "an applied design is recorded for undo"
  else
    fail "an applied design cannot be undone"
    BOUND_FAILS=$((BOUND_FAILS + 1))
  fi
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d design-store check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll design-store checks passed.\033[0m\n'
