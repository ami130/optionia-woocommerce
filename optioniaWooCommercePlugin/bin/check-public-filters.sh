#!/usr/bin/env bash
#
# Every filter the README promises still exists, and nothing new is undocumented.
#
# ## Why this exists
#
# 🔴 **A filter name is a public contract.** Once a cart drawer or a theme calls
# `optionia_cart_item_rows`, renaming it breaks their site on update — silently,
# because a filter nobody applies simply never fires. There is no error, no log
# line, and no failing test: the integration's callback is just never called.
#
# ⚠️ **And the reverse is worse.** A filter added to the source and left out of
# the README is an accidental commitment: somebody finds it, depends on it, and
# the next refactor breaks a contract nobody knew they had made. M21b.5 is a
# *policy* milestone precisely because the alternative is chasing every plugin.
#
# So the two lists must agree, in both directions.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
README="$ROOT/README.md"

if [ ! -f "$README" ]; then
  fail "missing: README.md"
  printf '\n\033[31m1 public-filter check failed.\033[0m\n'
  exit 1
fi

# Filters the source actually applies, and filters the README documents.
#
# `apply_filters(` and its name often sit on separate lines, because PHPCS wraps
# long calls. So join the file first, then match the call — matching the bare
# literal instead would sweep in every option name, nonce action and meta key.
#
# ⚠️ **Every shipped PHP file, not just `src/`.** This scanned `src/` alone and
# a filter applied from `optionia.php`, `uninstall.php` or a template escaped
# the undocumented half entirely — the gate promised more than it checked.
# `templates/` is the likeliest place for one, since a theme override is exactly
# where somebody reaches for a hook.
IN_SOURCE=$(find "$ROOT/src" "$ROOT/templates" -name '*.php' 2>/dev/null \
  -exec cat {} + ; cat "$ROOT"/*.php 2>/dev/null)
IN_SOURCE=$(printf '%s' "$IN_SOURCE" \
  | tr '\n\t' '  ' \
  | grep -oE "apply_filters\( *'optionia_[a-z_]+'" \
  | grep -oE "optionia_[a-z_]+" | sort -u)
IN_README=$(grep -oE '`optionia_[a-z_]+`' "$README" | tr -d '`' | sort -u)

COUNT=$(printf '%s\n' "$IN_SOURCE" | grep -c .)
FLOOR=3

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found $COUNT public filter(s), floor $FLOOR — the pattern is wrong, not the code"
else
  pass "the source applies $COUNT public filter(s)"

  for filter in $IN_SOURCE; do
    if printf '%s\n' "$IN_README" | grep -qx "$filter"; then
      pass "\`$filter\` is documented"
    else
      fail "\`$filter\` is applied but not documented"
      printf '      An undocumented filter is a contract nobody knew they made.\n'
    fi
  done

  for filter in $IN_README; do
    if printf '%s\n' "$IN_SOURCE" | grep -qx "$filter"; then
      continue
    fi

    fail "the README promises \`$filter\`, which nothing applies"
    printf '      An integration calling it would never fire, with no error.\n'
  done
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d public-filter check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll public-filter checks passed.\033[0m\n'
