#!/usr/bin/env bash
#
# A renderer never runs without its bounds check.
#
# ## Why this exists before the renderer does
#
# 🔴 **An oversized canvas succeeds, and succeeding is the problem.** Measured
# during M26's Stage 0 spike: a 50000×50000 SVG handed to `@resvg/resvg-js`
# rendered in 46 seconds at roughly 10 GB of RGBA, and the OS killed the process
# at exit 137. A kernel kill is not an exception — nothing catches it, nothing
# logs it, and the merchant waiting on a print file learns only that it never
# arrived.
#
# ⚠️ **`checkRenderBounds` has no caller today, and that is honest rather than
# hidden.** The render service does not exist yet. This gate is what makes the
# absence temporary: the moment anything imports a rasteriser, the bounds check
# must be imported beside it or this fails.
#
# 📌 **The alternative was a mechanism with no trigger**, which this project has
# shipped eleven times and found eleven times. A guard nobody calls is not a
# guard; a guard a gate insists on is.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/optioniaWooCommerceBackend/src"

printf '\033[1m== check-render-bounds.sh ==\033[0m\n'
printf 'Checking that a rasteriser is never called unguarded...\n'

if [ ! -d "$SRC" ]; then
  fail "missing: optioniaWooCommerceBackend/src"
  printf '\n\033[31m1 render-bounds check failed.\033[0m\n'
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. The guard still exists and still carries its measured limits.
# ---------------------------------------------------------------------------
BOUNDS="$SRC/common/render/render-bounds.ts"

if [ ! -f "$BOUNDS" ]; then
  fail "render-bounds.ts is gone; the 50000×50000 OOM has nothing stopping it"
elif ! grep -q "MAX_RENDER_MEGAPIXELS = 36" "$BOUNDS"; then
  fail "MAX_RENDER_MEGAPIXELS is no longer the measured 36 (≈6000×6000, ~229 MB)"
  printf '        raising it silently removes the headroom a 1 GB instance needs\n'
else
  pass "the bounds guard exists, at its measured limits"
fi

# ---------------------------------------------------------------------------
# 2. Every file that reaches a rasteriser also reaches the guard.
# ---------------------------------------------------------------------------
# Matched on the LIBRARY rather than a filename, so a new render path is caught
# without anyone remembering to extend this — the same shape as the plugin's
# AC3 network check.
RASTERISERS='@resvg/resvg-js|\bResvg\b|require\(.sharp.\)|from .sharp.'

UNGUARDED=""

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # The guard itself, and tests, are not render paths.
  case "$file" in
    *"/common/render/"*) continue ;;
    *.spec.ts) continue ;;
  esac

  if ! grep -q "checkRenderBounds" "$file"; then
    UNGUARDED="$UNGUARDED  ${file#"$SRC/"}\n"
  fi
done <<EOF
$(grep -rlE "$RASTERISERS" "$SRC" --include='*.ts' 2>/dev/null || true)
EOF

if [ -n "$UNGUARDED" ]; then
  fail "a rasteriser is reached without checkRenderBounds:"
  printf "%b" "$UNGUARDED" | sed 's|^|      |'
  printf '        an unbounded canvas is an OOM kill, and a kernel kill reports nothing\n'
else
  pass "no unguarded rasteriser call site"
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d render-bounds check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll render-bounds checks passed.\033[0m\n'
