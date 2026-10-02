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
#
# ✏️ **`src/lib/design` and `src/design` were removed, and the editor is
# DELIBERATELY not scanned.** Both were written before the Design Lab existed,
# and neither was ever created — the editor landed in `src/lib/design-lab`. The
# comment above calls the editor "the likeliest violator", which made those two
# paths read as coverage of it; they were not, and could never have been.
#
# 🔴 **Scanning it would be WRONG, not merely redundant.** The editor works in
# pixels by design — `MIN_LAYER_SIZE = 24`, `CANVAS_BASE_H = 460`,
# `CROP_OFF_FRAME_MARGIN = 20` are all correct there — and M26c.2's contract is
# that the conversion happens in exactly two functions, not that the editor
# holds no pixels. What guards the editor is `check-design-store.sh`, which
# asserts those two conversion points and the crop's third one.
#
# 📌 **The plugin paths stay**: M26e.1 puts a storefront overlay there and it
# will hold geometry, so an absent directory is a guard waiting rather than a
# guard that cannot fire.
GEO_DIRS="$ROOT/shared/design
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

# Every font a merchant may use has a recorded licence.
#
# 🔴 **M26d.3 asks for this in its own words** — "a curated, licence-cleared
# list — verify print/embedding rights, not just web use" — and eight families
# had shipped into the type system with nothing recorded anywhere. A webfont
# licence and a print-embedding licence are different grants, and
# print-on-demand is commercial reproduction of the glyphs.
#
# ⚠️ **The list is the easy thing to extend and the easy thing to extend
# WITHOUT checking.** Adding a ninth family is one line; verifying its licence
# is a different kind of work, and nothing connected the two until this.
FONTS_FILE="$ROOT/shared/design/design-geometry.types.ts"
LICENCE_DOC="$ROOT/docs/M26-PRINT-PIPELINE-DECISIONS.md"

if [ ! -f "$FONTS_FILE" ] || [ ! -f "$LICENCE_DOC" ]; then
  fail "the font list or the decisions document is missing"
else
  UNLICENSED=""
  FONT_COUNT=0

  # The declared families, read from the runtime array rather than a copy.
  FONT_LIST=$(perl -0ne 'print $1 if /TEXT_FONTS = \[(.*?)\] as const;/s' "$FONTS_FILE" \
    | grep -oE "'[^']+'" | tr -d "'")

  if [ -z "$FONT_LIST" ]; then
    fail "could not read TEXT_FONTS — has its shape changed?"
  else
    while IFS= read -r font; do
      [ -n "$font" ] || continue

      FONT_COUNT=$((FONT_COUNT + 1))

      # 📌 Matched in the licence TABLE, not anywhere in the document: the
      # families are named in prose elsewhere, and a mention is not a record.
      grep -qE "^\| $font \| " "$LICENCE_DOC" || UNLICENSED="$UNLICENSED $font"
    done <<EOF
$FONT_LIST
EOF

    if [ -n "$UNLICENSED" ]; then
      fail "font(s) with no recorded licence:$UNLICENSED"
      printf '        Add a row to Decision 4'"'"'s licensing table, verified against\n'
      printf '        github.com/google/fonts — not from memory.\n'
    else
      pass "all $FONT_COUNT font(s) have a recorded licence"
    fi
  fi

  # 🔴 **Every curated family needs an axis entry, and a missing one is
  # SILENT.** Measured against the live API on 2026-10-02: a family requested
  # without its axes loads only the regular face, so bold and italic fall back
  # to a synthesised approximation — and the merchant's measured `advanceRatio`
  # is then taken from the wrong glyphs and persisted into the design.
  #
  # ⚠️ **A misspelt family is the fatal case**: HTTP 400 for the whole
  # stylesheet, which loads none of the eight. Neither failure announces itself,
  # which is why this is a gate rather than a comment.
  AXES_FILE="$ROOT/optioniaWooCommerceFrontend/src/lib/design-lab/text-fonts.ts"

  if [ ! -f "$AXES_FILE" ]; then
    fail "the font axis map is missing — the editor cannot load its fonts"
  else
    MISSING_AXES=""
    AXES_COUNT=0

    while IFS= read -r font; do
      [ -n "$font" ] || continue

      AXES_COUNT=$((AXES_COUNT + 1))

      # Matched as a KEY in the map — quoted or bare, as the object spells it.
      grep -qE "^  ('$font'|\"$font\"|$font): " "$AXES_FILE" \
        || MISSING_AXES="$MISSING_AXES $font"
    done <<EOF
$FONT_LIST
EOF

    if [ -n "$MISSING_AXES" ]; then
      fail "curated font(s) with no axis entry:$MISSING_AXES"
      printf '        They would load their regular face only — bold and italic
'
      printf '        would silently fall back, and advanceRatio would be measured
'
      printf '        from the wrong glyphs.
'
    else
      pass "all $AXES_COUNT curated font(s) have a CSS2 axis entry"
    fi
  fi

  # 🔴 **The sign-off landed (2026-10-02), so this check CHANGED MEANING rather
  # than being deleted.** It used to say "no font file may ship"; it now says
  # "exactly the eight that were signed off, and no others". Removing it would
  # have thrown away the only thing standing between an accepted list and a
  # ninth font nobody approved.
  #
  # ⚠️ **The acceptance covers those eight families UNMODIFIED.** A file that is
  # subset, re-hinted or renamed engages the Reserved Font Name clause on Lato,
  # Playfair Display and Dancing Script — which is why what ships is checked
  # against `TEXT_FONTS` rather than merely counted.
  FONT_DIR="$ROOT/optioniaWooCommerceBackend/src/design/fonts"

  if [ ! -d "$FONT_DIR" ]; then
    # 📌 Not an error: the renderer that needs them is M26e.4, still to come.
    pass "no font file ships yet (the renderer that needs them is M26e.4)"
  else
    SHIPPED=$(find "$FONT_DIR" -name '*.ttf' -o -name '*.otf' 2>/dev/null | wc -l | tr -d ' ')
    #
    # ⚠️ **`|| true` on the pipe, because `grep -v` that filters EVERYTHING away
    # exits 1** — and under `set -euo pipefail` that killed the script on this
    # very line, silently, with exit 0 and every later check unprinted. The
    # healthy case (no stray fonts) was the one that aborted.
    STRAY=$(find "$ROOT/shared" "$ROOT/optioniaWooCommerceBackend/src" \
      \( -name '*.ttf' -o -name '*.otf' \) 2>/dev/null \
      | { grep -v "^$FONT_DIR/" || true; } | wc -l | tr -d ' ')

    UNSHIPPED=""

    while IFS= read -r font; do
      [ -n "$font" ] || continue

      # The file name a family is expected to ship under: no spaces.
      file=$(printf '%s' "$font" | tr -d ' ')

      #
      # ⚠️ **Counted, not `grep -q`-ed.** `find … | grep -q .` exits 1 when a
      # family has no file, and under `set -euo pipefail` that killed the whole
      # script — silently, exit 0, with every later check simply never printed.
      # The third time this gate pattern has bitten here; a count cannot fail.
      matches=$(find "$FONT_DIR" \( -iname "$file*.ttf" -o -iname "$file*.otf" \) \
        2>/dev/null | wc -l | tr -d ' ')

      [ "${matches:-0}" -gt 0 ] || UNSHIPPED="$UNSHIPPED $font"
    done <<EOF
$FONT_LIST
EOF

    if [ "${STRAY:-0}" -gt 0 ]; then
      fail "$STRAY font file(s) ship from outside $FONT_DIR"
      printf '        the sign-off names one home; a file elsewhere is one nobody reviewed\n'
    elif [ -n "$UNSHIPPED" ]; then
      fail "curated font(s) with no file to render from:$UNSHIPPED"
      printf '        resvg renders textPath from a FILE — a missing one prints nothing\n'
    elif [ "${SHIPPED:-0}" -ne "$FONT_COUNT" ]; then
      fail "$SHIPPED font file(s) ship for $FONT_COUNT licensed famil(y/ies)"
      printf '        the sign-off covers those eight and no others\n'
    else
      pass "all $SHIPPED shipped font file(s) are licensed and signed off"
    fi
  fi
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d design-fraction check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll design-fraction checks passed.\033[0m\n'
