#!/usr/bin/env bash
#
# The shared geometry stays shareable, and both projects still see it.
#
# ## Why this exists
#
# 🔴 **One copy of the geometry, two consumers.** `shared/design/` is the port of
# `designScene.ts` — the code that decides where a customer's name lands on a
# physical object. The API renders print files from it and the dashboard's canvas
# editor authors against it, and the plan calls re-deriving it *"the most
# expensive avoidable work in this project."*
#
# ⚠️ **A single framework import would end that.** One `import ... from
# '@nestjs/common'` or `'react'` makes this unusable by the other consumer, and
# nothing in either project's own type-check would notice — each compiles with
# its own framework present.
#
# 🔴 **Moving it already lost 134 tests once.** The backend's Jest `rootDir` was
# `src`, so relocating the tree out of `src/` dropped 6 suites — and Jest
# reported "82 passed" in green. A test count that falls silently is this
# project's most repeated defect shape, so the count is asserted here.
set -euo pipefail

printf '\033[1m== check-shared-design.sh ==\033[0m\n'
printf 'Checking the shared geometry…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED="$ROOT/shared/design"

if [ ! -d "$SHARED" ]; then
  fail "shared/design is missing — this gate is checking nothing"
  exit 1
fi

# Comments stripped first: the files EXPLAIN why they import no framework, and
# prose naming one must never read as an import of it.
strip_comments() {
  perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g;' "$1"
}

# 1. Framework-free, which is the property that makes it shareable at all.
OFFENDERS=""
CHECKED=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in *.spec.ts) continue ;; esac
  CHECKED=$((CHECKED + 1))

  if strip_comments "$f" \
    | grep -qE "from '(@nestjs/|react|next/|typeorm|@tanstack/)"; then
    OFFENDERS="$OFFENDERS  $(basename "$f")\n"
  fi
done <<EOF
$(find "$SHARED" -name '*.ts' -type f)
EOF

if [ "$CHECKED" -eq 0 ]; then
  fail "read no shared files at all — the parser is wrong, not the code"
elif [ -n "$OFFENDERS" ]; then
  fail "shared geometry importing a framework:"
  printf "%b" "$OFFENDERS" | sed 's|^|      |'
  printf '        one framework import makes this unusable by the other consumer\n'
else
  pass "all $CHECKED shared module(s) are framework-free"
fi

# 2. It compiles with NO framework types in scope — proven, not asserted.
#
# 📌 `"types": []` in its own tsconfig means not even Node globals. A file that
# reached for `process` or `window` fails here.
TSC="$ROOT/optioniaWooCommerceBackend/node_modules/.bin/tsc"

if [ ! -x "$TSC" ]; then
  fail "no tsc available to prove the shared tree stands alone"
elif "$TSC" --noEmit -p "$SHARED/tsconfig.json" >/dev/null 2>&1; then
  pass "the shared tree compiles with no framework types in scope"
else
  fail "the shared tree no longer compiles standalone"
  "$TSC" --noEmit -p "$SHARED/tsconfig.json" 2>&1 | head -3 | sed 's|^|      |'
fi

# 3. Both projects can still resolve it.
for project in optioniaWooCommerceBackend optioniaWooCommerceFrontend; do
  if grep -q '"@shared/\*"' "$ROOT/$project/tsconfig.json"; then
    pass "$project aliases @shared/*"
  else
    fail "$project no longer aliases @shared/* — it cannot import the geometry"
  fi
done

# 4. The dashboard's test runner resolves `@shared` too.
#
# 🔴 **Two resolvers, two declarations.** Vitest resolves through Vite, which
# does not read tsconfig paths — so the first test importing the shared geometry
# failed with "Failed to resolve import" while `tsc` was perfectly happy. Gate 31
# checked the tsconfig alias and said nothing, because that alias was fine.
VITEST="$ROOT/optioniaWooCommerceFrontend/vitest.config.ts"

if [ -f "$VITEST" ] && strip_comments "$VITEST" | grep -q "'@shared'"; then
  pass "vitest resolves @shared (tsconfig paths do not reach Vite)"
else
  fail "vitest.config.ts does not alias @shared — a test importing it cannot resolve"
fi

# 5. The fit modes agree across the two implementations.
#
# ⚠️ `applyStyleGeometry` WRITES a layer when its style changes; `layerRect`
# READS one on every render. Both implement cover/fit/fullw/fullh, in different
# coordinate spaces, and in `optionia-app` the only thing tying them together was
# a comment in each pointing at the other. A merchant picks a fit mode in the
# editor and a factory prints the result.
PARITY="$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/style-geometry.test.ts"

# ⚠️ **A COUNT, not two names.** The first version asserted that `layerRect(`
# and `applyStyleGeometry(` both appeared in the file — which emptying
# `SHARED_STYLES` satisfied perfectly: the suite fell from 32 tests to 5 and
# this gate stayed green. A check that confirms a name is present rather than
# work being done is this project's most repeated gate defect.
#
# 🔴 **And it must run the PARITY FILE, not the directory.** It ran
# `src/lib/design-lab` — so the number it reported was every test in the folder,
# and the message "the fit modes are compared against the renderer (N cases)"
# counted the drag, store, list and panel suites as fit-mode comparisons. The
# floor still held, but only because unrelated modules kept arriving: emptying
# the parity suite would have been masked by them. A floor that any other file
# can satisfy is not a floor.
PARITY_MIN=24

if [ ! -f "$PARITY" ]; then
  fail "the fit-mode parity test is missing — the editor and renderer are unchecked"
else
  PARITY_RUN=$( cd "$ROOT/optioniaWooCommerceFrontend" \
    && npx vitest run src/lib/design-lab/style-geometry.test.ts --reporter=json 2>/dev/null \
    | node -e "
      let raw = '';
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', () => {
        const start = raw.indexOf('{');
        try {
          const report = JSON.parse(raw.slice(start));
          process.stdout.write(String(report.numPassedTests ?? 0));
        } catch {
          process.stdout.write('0');
        }
      });
    " || true )

  if [ "${PARITY_RUN:-0}" -lt "$PARITY_MIN" ]; then
    fail "the fit-mode parity suite ran ${PARITY_RUN:-0} test(s), below the floor of $PARITY_MIN"
    printf '        emptying the style or shape list leaves this file passing\n'
    printf '        while checking nothing — the floor is what notices\n'
  elif strip_comments "$PARITY" | grep -q 'layerRect(' \
    && strip_comments "$PARITY" | grep -q 'applyStyleGeometry('; then
    pass "the fit modes are compared against the renderer ($PARITY_RUN cases)"
  else
    fail "the parity test no longer compares applyStyleGeometry with layerRect"
  fi
fi

# 6. The backend's test runner still SEES the shared specs.
#
# ⚠️ This is the check that would have caught the 134 vanished tests. A `roots`
# entry is what carries them; without it Jest finds nothing here and says so in
# green.
if grep -q '"<rootDir>/../shared"' "$ROOT/optioniaWooCommerceBackend/package.json"; then
  pass "the backend test runner includes the shared tree"
else
  fail "jest no longer roots the shared tree — its specs would vanish silently"
fi

# 🔴 **The scene module must have a PRODUCTION caller, and for four milestones
# it had none.** `buildScene` and `sceneToSvgString` were built in M26c.1,
# covered by their own specs, and wired to nothing — invisible because
# `shared/design` sits outside `check-symbol-reachable.sh`'s watch path and
# every check above this one asserts the tree's STRUCTURE (framework-free,
# aliased, parity-tested) rather than whether anything draws with it.
#
# ⚠️ **Tests do not count.** A module exercised only by its own spec is
# geometry the product never runs, which is exactly the state this went
# unnoticed in.
RENDER_ENTRY="buildScene
sceneToSvgString"

ORPHANED=""
ENTRY_CHECKED=0

while IFS= read -r symbol; do
  [ -z "$symbol" ] && continue

  ENTRY_CHECKED=$((ENTRY_CHECKED + 1))

  consumers=$(grep -rlE "\b$symbol\b" \
    "$ROOT/optioniaWooCommerceFrontend/src" \
    "$ROOT/optioniaWooCommerceBackend/src" \
    --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -vE '\.(spec|test)\.tsx?$' \
    | wc -l | tr -d ' ')

  if [ "${consumers:-0}" -eq 0 ]; then
    ORPHANED="$ORPHANED  $symbol\n"
  fi
done <<EOF
$RENDER_ENTRY
EOF

if [ "$ENTRY_CHECKED" -eq 0 ]; then
  fail "checked no renderer entry points — the parser is wrong, not the code"
elif [ -n "$ORPHANED" ]; then
  fail "scene module entry point(s) nothing in the product calls:"
  printf "%b" "$ORPHANED" | sed 's|^|      |'
  printf '        geometry built, tested, and drawing nothing\n'
else
  pass "all $ENTRY_CHECKED scene entry point(s) have a production caller"
fi

# ⚠️ **One renderer, which is M26d.6's exact wording — "never a second
# renderer".** The dashboard preview must hand its decisions to the shared
# module, not lay artwork out itself; a component computing its own geometry
# would agree with the storefront only by accident.
PREVIEW="$ROOT/optioniaWooCommerceFrontend/src/components/option-sets/design-preview.tsx"

if [ ! -f "$PREVIEW" ]; then
  fail "the dashboard design preview is missing (M26d.6)"
#
# 📌 **Matched with or without the call paren.** A first version required
# `wrapTextLines(`, so importing the geometry and not yet calling it passed —
# and an import is the step before a call, which is the moment worth catching.
elif grep -qE 'textArcPath|wrapTextLines|fitTextToBox|layerRect|frameImageRect' "$PREVIEW"; then
  fail "the preview re-derives geometry instead of delegating to the scene"
  printf '        M26d.6: "never a second renderer"\n'
elif grep -q 'buildScene(' "$PREVIEW" && grep -q 'sceneToSvgString(' "$PREVIEW"; then
  pass "the dashboard preview draws through the shared scene module"
else
  fail "the preview does not render through buildScene/sceneToSvgString"
fi

# 🔴 **Stored URLs are re-checked before they reach the DOM.** The preview is
# the first surface to read a saved design back and inject it, and the API
# stores the design body unvalidated BY DESIGN — so a row written by any other
# path can carry a `javascript:` href. `escAttr` escapes `&"<>`, which does
# nothing about a scheme; the check has to be the editor's own rule.
SCENE_INPUT="$ROOT/optioniaWooCommerceFrontend/src/lib/preview/preview-scene.ts"

if [ ! -f "$SCENE_INPUT" ]; then
  fail "the preview's scene input module is missing"
elif grep -q 'checkLayerSource(' "$SCENE_INPUT"; then
  pass "stored design URLs are re-checked before the preview renders them"
else
  fail "the preview renders stored URLs without re-checking them"
  printf '        escAttr escapes quotes; it does not refuse javascript:\n'
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d shared-design check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll shared-design checks passed.\033[0m\n'
