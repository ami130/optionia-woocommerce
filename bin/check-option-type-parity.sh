#!/usr/bin/env bash
#
# The dashboard must not offer an option type the API will refuse.
#
# `optioniaWooCommerceFrontend`'s `AUTHORABLE_TYPES` is a **subset** of the API's
# registry, never a superset. The API registers a type when the server can
# validate it; the dashboard offers one only when it can also *author and
# re-open* it — so `text_field` will be registered long before it belongs in the
# picker, and that direction is fine.
#
# The other direction is not. A type in the picker that the registry lacks is a
# merchant choosing something, submitting, and being handed an error — and it is
# invisible to both repositories' test suites, because neither can see the other.
#
# Measured 2026-09-03: adding `checkbox` to the picker passed all 305 frontend
# tests and `tsc`, because nothing compared the two.
#
# Usage: bash bin/check-option-type-parity.sh
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="$ROOT/optioniaWooCommerceBackend/src/option-sets/types/type-registry.ts"
PICKER="$ROOT/optioniaWooCommerceFrontend/src/lib/schemas/option-sets.ts"

for file in "$REGISTRY" "$PICKER"; do
  if [ ! -f "$file" ]; then
    fail "missing: ${file#"$ROOT/"}"
    exit 1
  fi
done

printf 'Checking option type parity...\n'

# The API's registry: every `presentation: Presentation.X` inside DEFINITIONS,
# lowercased to the wire value the frontend uses.
REGISTERED=$(grep -oE 'presentation: Presentation\.[A-Z_]+' "$REGISTRY" \
  | sed 's/.*Presentation\.//' | tr 'A-Z' 'a-z' | sort -u)

# The dashboard's list: the `value:` of each AUTHORABLE_TYPES entry.
AUTHORABLE=$(sed -n '/AUTHORABLE_TYPES = \[/,/\] as const;/p' "$PICKER" \
  | grep -oE "value: '[a-z_]+'" | sed "s/value: '//;s/'//" | sort -u)

# An unreadable input cannot be compared, and comparing it anyway is worse than
# not trying.
#
# 🔴 **This used to fall through.** With `AUTHORABLE_TYPES` unreadable the gate
# printed its FAIL and then, beneath it, `ok  all 0 authorable type(s) are
# registered` — vacuously true because nothing had been read, and green to anyone
# scanning the output. A gate whose whole purpose is legibility across two
# repositories must not emit a reassuring line it did not earn.
if [ -z "$REGISTERED" ]; then
  fail "could not read any type from the API registry — has its shape changed?"
fi

if [ -z "$AUTHORABLE" ]; then
  fail "could not read AUTHORABLE_TYPES — has its shape changed?"
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\n\033[31mCould not read one or both lists; nothing was compared.\033[0m\n'
  exit 1
fi

# Every authorable type must be registered. Not the reverse.
ORPHANS=0
while IFS= read -r type; do
  [ -z "$type" ] && continue
  if ! printf '%s\n' "$REGISTERED" | grep -qx "$type"; then
    fail "the dashboard offers '$type', and the API registry does not have it"
    ORPHANS=$((ORPHANS + 1))
  fi
done <<< "$AUTHORABLE"

if [ "$ORPHANS" -eq 0 ]; then
  pass "all $(printf '%s\n' "$AUTHORABLE" | grep -c .) authorable type(s) are registered in the API"
fi

# Every authorable type must have a storefront template.
#
# 🔴 **The third repository, which neither list can see.** A type can be
# registered in the API *and* offered in the dashboard while the plugin has no
# template for it — and the plugin skips a type it cannot render, by design, so
# the storefront draws **nothing** and says nothing.
#
# Measured 2026-09-03: deleting `dropdown.php` passed this gate, the backend
# registry tests, and the plugin's architecture gate. The plugin's own
# `RendererTest` did catch it — but only a check that spans the repositories can
# see a merchant authoring an option no storefront can draw.
TEMPLATES="$ROOT/optioniaWooCommercePlugin/templates/options"
MISSING=0

while IFS= read -r type; do
  [ -z "$type" ] && continue
  if [ ! -f "$TEMPLATES/$type.php" ]; then
    fail "'$type' is authorable, and the plugin has no templates/options/$type.php"
    MISSING=$((MISSING + 1))
  fi
done <<< "$AUTHORABLE"

if [ "$MISSING" -eq 0 ]; then
  pass "every authorable type has a storefront template"
fi

# Every authorable presentational item kind must have a template too.
#
# 🔴 **The same gap, one level down.** `AUTHORABLE_ITEM_KINDS` in the item DTO is
# what the API will accept; `templates/presentational/` is what the plugin can
# draw. Add a kind to the DTO without a template and the storefront renders
# nothing and logs a debug line — exactly the failure the option-type check above
# was written for, on a list that check cannot see.
#
# ⚠️ **`rich_text` must NOT appear in that list.** It is gated behind M5.4c's
# sanitizer, so it is absent from `AUTHORABLE_ITEM_KINDS` and has no template —
# and both halves of that are load-bearing. This gate reads the DTO, so it stays
# correct whichever way that decision moves.
ITEM_DTO="$ROOT/optioniaWooCommerceBackend/src/option-sets/dto/presentational-item.dto.ts"
ITEM_TEMPLATES="$ROOT/optioniaWooCommercePlugin/templates/presentational"

if [ -f "$ITEM_DTO" ]; then
  # The kinds between `AUTHORABLE_ITEM_KINDS: readonly ... = [` and its `]`.
  KINDS=$(sed -n '/AUTHORABLE_ITEM_KINDS/,/\];/p' "$ITEM_DTO" \
    | grep -oE 'PresentationalKind\.[A-Z_]+' \
    | sed 's/PresentationalKind\.//' \
    | tr '[:upper:]' '[:lower:]' \
    | sort -u)

  ITEM_MISSING=0

  while IFS= read -r kind; do
    [ -z "$kind" ] && continue
    if [ ! -f "$ITEM_TEMPLATES/$kind.php" ]; then
      fail "item kind '$kind' is authorable, and the plugin has no templates/presentational/$kind.php"
      ITEM_MISSING=$((ITEM_MISSING + 1))
    fi
  done <<< "$KINDS"

  if [ "$ITEM_MISSING" -eq 0 ]; then
    pass "every authorable item kind has a template ($(printf '%s\n' "$KINDS" | grep -c .) kind(s))"
  fi

  # And the reverse: a template for a kind the API refuses would render markup
  # nothing can create — harmless, but it means one of the two moved alone.
  if [ -d "$ITEM_TEMPLATES" ]; then
    for file in "$ITEM_TEMPLATES"/*.php; do
      [ -e "$file" ] || continue
      name=$(basename "$file" .php)
      if ! printf '%s\n' "$KINDS" | grep -qx "$name"; then
        fail "templates/presentational/$name.php has no matching kind in AUTHORABLE_ITEM_KINDS"
      fi
    done
  fi
fi

# Informational: registered but not yet authorable. Expected, and worth seeing.
PENDING=$(comm -23 <(printf '%s\n' "$REGISTERED") <(printf '%s\n' "$AUTHORABLE") | grep -c . || true)
pass "$PENDING registered type(s) are not yet authorable in the dashboard (expected)"

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%s check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll option type parity checks passed.\033[0m\n'
