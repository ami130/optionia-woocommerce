#!/usr/bin/env bash
#
# Unstyled options inherit the theme (M21c.1).
#
# ## Why this exists
#
# 🔴 **The intent was in a comment and the code had drifted from it.** The colour
# swatch carried *"`currentColor` at low alpha: an outline that works on any
# theme"* directly above a declaration using a fixed low-alpha black -- and four
# more borders and surfaces did the same. On a light theme that reads as a
# hairline. On a dark one it is invisible, and M21c.1's exit criterion names
# Twenty Twenty-Five, which ships dark styles.
#
# Nothing caught it, because there is nothing to catch: a stylesheet has no
# tests, and the storefront renders it the same either way until somebody looks
# at a dark theme. This is the *absent code* shape this project keeps finding --
# a suite staying green over behaviour nobody wrote an assertion for.
#
# ## What is checked
#
# The three rules M21c.1 and ADR-112 turn on, all mechanical:
#
#   1. No absolute colour in a declaration -- it cannot inherit.
#   2. No `!important` -- ADR-112: merchant CSS must always be able to win.
#   3. No `font-family` -- the theme owns typography.
#
# ⚠️ **Comments are stripped first.** The token block explains what it replaced,
# so prose describing a black would otherwise fail the gate that forbids one.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSS="$ROOT/assets/css/frontend.css"

if [ ! -f "$CSS" ]; then
  fail "missing: assets/css/frontend.css"
  printf '\n\033[31m1 theme-inheritance check failed.\033[0m\n'
  exit 1
fi

# Declarations only: strip /* ... */ comments, keep `property: value;` lines.
DECLS=$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$CSS" | grep -E '^[[:space:]]*[a-z-]+[[:space:]]*:')

TOTAL=$(printf '%s\n' "$DECLS" | grep -c . || true)
FLOOR=40

if [ "$TOTAL" -lt "$FLOOR" ]; then
  fail "read $TOTAL declaration(s), floor $FLOOR — the pattern is wrong, not the CSS"
  printf '\n\033[31m1 theme-inheritance check failed.\033[0m\n'
  exit 1
fi

pass "read $TOTAL declaration(s) from the storefront stylesheet"

# 1. An absolute colour cannot inherit.
ABSOLUTE=$(printf '%s\n' "$DECLS" \
  | grep -inE '#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|: *(black|white|red|blue|green|gray|grey)\b' \
  || true)

if [ -z "$ABSOLUTE" ]; then
  pass "no absolute colour in any declaration"
else
  COUNT=$(printf '%s\n' "$ABSOLUTE" | grep -c .)
  fail "$COUNT declaration(s) use an absolute colour, which cannot inherit"
  printf '%s\n' "$ABSOLUTE" | sed 's/^/      /'
  printf '      Use color-mix( in srgb, currentColor N%%, transparent ) instead.\n'
fi

# 2. ADR-112: merchant CSS must always be able to win.
BANG=$(printf '%s\n' "$DECLS" | grep -c '!important' || true)

if [ "$BANG" -eq 0 ]; then
  pass "no !important — merchant CSS can always win (ADR-112)"
else
  fail "$BANG declaration(s) use !important, which takes the override away"
fi

# 3. The theme owns typography.
# ⚠️ **Anchored on the property, not the line start.** A mutation appending
# `font-family: Arial;` after another declaration on one line **survived** a
# `^[[:space:]]*` form — and minified or hand-compacted CSS puts several
# declarations on a line as a matter of course.
FONTS=$(printf '%s\n' "$DECLS" | grep -cE '(^|[;{[:space:]])font-family[[:space:]]*:' || true)

if [ "$FONTS" -eq 0 ]; then
  pass "no font-family — typography is the theme's"
else
  fail "$FONTS declaration(s) set font-family, overriding the theme"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d theme-inheritance check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll theme-inheritance checks passed.\033[0m\n'
