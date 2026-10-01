#!/usr/bin/env bash
#
# Every stored design coordinate is a FRACTION of the canvas, never a pixel.
#
# ## Why this is a gate and not a convention
#
# 🔴 **A design is authored once and rendered at four sizes** — the editor
# canvas, the dashboard preview, the storefront overlay and the print file, the
# last of which is several thousand pixels wide. A coordinate stored in pixels
# re-places correctly at exactly one of them and is silently wrong at the other
# three; the merchant discovers it on a physical object.
#
# M26c.2 states the contract: the editor works in pixels, conversion happens in
# exactly TWO functions (export and import), and every stored quantity —
# coordinate, size, letter-spacing, font size — is a ratio. The plan asks for it
# to be "enforced in CI, the same shape as the existing no-float-in-Engine
# check", which is what this is.
#
# ## What is checked, and what is deliberately NOT
#
# 📌 **An absolute pixel CONSTANT in the geometry module is the violation** — a
# literal that is neither a ratio nor derived from the canvas. Arithmetic on
# viewBox dimensions is the whole point of the module and is not flagged.
#
# ⚠️ **Comments are stripped before matching, never after.** This project's
# recurring gate defect is reading documentation instead of code: the screen
# reachability gate matched a field name inside a comment and passed both its
# probes. These files are heavily commented and several of those comments quote
# pixel measurements — "~221px of drift", "8px on a 460-tall canvas" — which are
# prose ABOUT the defect, not the defect.
#
# ⚠️ **Named constants are the sanctioned form.** `LINE_HEIGHT`, `CHAR_ADVANCE`,
# `MIN_FONT_RATIO`, `GLYPH_ASCENT` and the rest are ratios with names; a bare
# number in an expression is what this forbids. That is the same distinction the
# no-float check draws between a money identifier and a byte count.
set -euo pipefail

printf '\033[1m== check-design-fractions.sh ==\033[0m\n'
printf 'Checking that stored geometry is fractions, never pixels…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 🔴 **Every directory that holds design geometry, not just today's one.**
# The first spelling scoped to the backend's `src/design` alone, which was
# correct on the day it was written and would have gone quietly wrong within one
# milestone: M26d builds a canvas editor in the FRONTEND and M26e a storefront
# overlay in the PLUGIN, and both hold geometry.
#
# ⚠️ **The editor is the likeliest violator of the three.** It genuinely works in
# pixels — that is its job — and M26c.2's contract is precisely that the pixel↔
# fraction conversion happens in exactly two functions and nowhere else. A gate
# that stopped at the backend would have been silent exactly where the rule is
# hardest to keep.
#
# A directory that does not exist yet is not an error; it is simply not scanned,
# and the count below states how many were found so the coverage is visible
# rather than assumed.
GEO_DIRS="$ROOT/shared/design
$ROOT/optioniaWooCommerceFrontend/src/design
$ROOT/optioniaWooCommerceFrontend/src/lib/design
$ROOT/optioniaWooCommercePlugin/src/Design
$ROOT/optioniaWooCommercePlugin/assets/design"

PRESENT=""
DIR_COUNT=0
while IFS= read -r d; do
  [ -z "$d" ] && continue
  if [ -d "$d" ]; then
    PRESENT="$PRESENT$d\n"
    DIR_COUNT=$((DIR_COUNT + 1))
  fi
done <<EOF
$GEO_DIRS
EOF

if [ "$DIR_COUNT" -eq 0 ]; then
  fail "no geometry directory found at all — this gate is checking nothing"
  exit 1
fi

# Strip block comments, line comments and string literals, so only executable
# code is matched. String literals matter: the SVG serialiser embeds numbers in
# markup templates, which are output, not stored geometry.
strip() {
  perl -0777 -pe '
    s{/\*.*?\*/}{}gs;
    s{//[^\n]*}{}g;
    s{`[^`]*`}{``}gs;
    s{"[^"\n]*"}{""}g;
    s{'"'"'[^'"'"'\n]*'"'"'}{'"'"''"'"'}g;
  ' "$1"
}

# 🔴 **A pixel constant is one assigned to, or compared against, a SPATIAL
# quantity** — not merely any number >= 2. The first spelling of this rule
# matched every two-digit literal and produced three false positives on its first
# run: `opacity ?? 100` twice, and the curve clamp `Math.max(-100, ...)`.
#
# ⚠️ Neither is a violation, and the distinction is the whole point of M26c.2.
# Opacity is a PERCENTAGE and the curve is a SLIDER BOUND — both are unitless and
# identical at every canvas size. A pixel constant is one that should have scaled
# with the viewBox and did not. A rule that cannot tell those apart would be
# switched off within a week, which is how a gate stops being read.
#
# So the match is anchored to the spatial vocabulary this module actually uses.
SPATIAL='(x|y|w|h|cx|cy|left|top|width|height|fontSize|letterSpacing|lineH|radius|R|boxW|boxH|arcW|arcH|sceneW|sceneH)'
SUSPECT="(^|[^A-Za-z0-9_.])${SPATIAL}[[:space:]]*[:=][[:space:]]*-?[0-9]{2,}(\.[0-9]+)?([^0-9A-Za-z_]|$)"

VIOLATIONS=""
CHECKED=0
while IFS= read -r GEO; do
  [ -z "$GEO" ] && continue
for f in "$GEO"/*.ts "$GEO"/*.tsx "$GEO"/*.js; do
  [ -e "$f" ] || continue
  case "$f" in *.spec.ts|*.spec.tsx|*.test.ts) continue ;; esac
  CHECKED=$((CHECKED + 1))
  rel="$(basename "$(dirname "$f")")/$(basename "$f")"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    num="${line%%:*}"
    body="${line#*:}"
    # Allow: named-constant declarations, percentage strings already stripped,
    # and the documented geometry constants that ARE ratios expressed > 1.
    case "$body" in
      *'export const'*) continue ;;
      *'const GLYPH_'*) continue ;;
      *'FULL_CIRCLE_THRESHOLD'*) continue ;;
      *'FIT_ITERATIONS'*) continue ;;
      *'Math.PI'*) continue ;;
      *'toFixed'*) continue ;;
    esac
    VIOLATIONS="$VIOLATIONS  $rel:$num  $(printf '%s' "$body" | sed 's/^[[:space:]]*//')\n"
  done < <(strip "$f" | grep -nE "$SUSPECT" || true)
done
done <<EOF
$(printf "%b" "$PRESENT")
EOF

if [ "$CHECKED" -eq 0 ]; then
  fail "read no geometry files at all — the parser is wrong, not the code"
elif [ -n "$VIOLATIONS" ]; then
  fail "absolute pixel constant(s) in the geometry module:"
  printf "%b" "$VIOLATIONS" | sed 's|^|      |'
  printf '        every stored quantity is a FRACTION of the canvas (M26c.2)\n'
  printf '        derive it from the viewBox, or name it as an exported ratio\n'
else
  pass "$CHECKED geometry file(s) in $DIR_COUNT director(y/ies) carry no absolute pixel constant"
fi

# The inverse: a gate that only forbids passes trivially on a module that does
# no geometry at all. Assert the ratio vocabulary is still present.
RATIOS=$(printf "%b" "$PRESENT" | while IFS= read -r d; do
  [ -z "$d" ] && continue
  grep -rhoE '\b(Pct|sizePct|wPct|hPct|xPct|yPct)\b' "$d" 2>/dev/null
done | wc -l | tr -d ' ')
if [ "$RATIOS" -lt 10 ]; then
  fail "the fraction vocabulary has thinned to $RATIOS use(s) — is geometry still stored as ratios?"
else
  pass "the stored contract is still fractions ($RATIOS Pct reference(s))"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d design-fraction check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll design-fraction checks passed.\033[0m\n'
