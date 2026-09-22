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
PICKER_PRICING="$ROOT/optioniaWooCommerceFrontend/src/lib/option-sets/option-pricing.ts"
RESOLVER="$ROOT/optioniaWooCommercePlugin/src/Engine/SelectionResolver.php"

for file in "$REGISTRY" "$PICKER" "$PICKER_PRICING"; do
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

# ---------------------------------------------------------------------------
# Which types may take SEVERAL answers, in both repositories.
#
# 🔴 **The plugin keeps its own copy of this decision, and it has to.** AC4
# makes the published document *input*, not authority, so `SelectionResolver`
# cannot trust a `cardinality` it is handed — it checks the type against
# `MANY_CAPABLE_TYPES` before accepting an array.
#
# Two lists, one decision, in repositories that cannot see each other. The
# failure is asymmetric and both directions are real:
#
#   - A type the API allows at `many` but the plugin does not: a merchant
#     authors a multi-select, publishes it, and every customer selection is
#     refused at add-to-cart. Authored successfully, unsellable.
#   - A type the plugin allows but the API does not: unreachable through the
#     dashboard, but AC4 means a crafted payload reaches the resolver anyway.
#     Measured before the plugin's guard landed: a `radio` at `many` sold
#     **Small and Large on one line** and charged for both.
#
# So this compares them as SETS and requires equality, not a subset either way.
MANY_REGISTERED=$(grep -oE 'presentation: Presentation\.[A-Z_]+,[[:space:]]*$|cardinality: \[[^]]*\]' "$REGISTRY" \
  | awk '/presentation:/ { sub(/.*Presentation\./, ""); sub(/,.*/, ""); t = tolower($0); next }
         /Cardinality\.MANY/ && t != "" { print t; t = "" }
         /cardinality:/ { t = t }' \
  | sort -u)

MANY_PLUGIN=$(sed -n '/MANY_CAPABLE_TYPES = array(/,/);/p' "$RESOLVER" \
  | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)

if [ ! -f "$RESOLVER" ]; then
  fail "missing: ${RESOLVER#"$ROOT/"}"
elif [ -z "$MANY_PLUGIN" ]; then
  # The same lesson as above: an unreadable list must not compare as empty and
  # pass. Both lists being empty is a legitimate state -- it was the state
  # before M18.3 -- so silence here is indistinguishable from agreement.
  fail "could not read MANY_CAPABLE_TYPES from the plugin -- has its shape changed?"
elif [ "$MANY_REGISTERED" != "$MANY_PLUGIN" ]; then
  fail "the two multi-select lists disagree"
  printf '        API registry allows many for: %s\n' "$(printf '%s' "$MANY_REGISTERED" | tr '\n' ' ')"
  printf '        Plugin resolver allows:       %s\n' "$(printf '%s' "$MANY_PLUGIN" | tr '\n' ' ')"
  printf '        A type in one and not the other is either an unsellable option\n'
  printf '        a merchant can author, or a crafted payload the resolver accepts.\n'
else
  pass "both repositories allow many for the same $(printf '%s\n' "$MANY_PLUGIN" | grep -c .) type(s)"
fi

# --- Which PRICE TYPES each option type may use ------------------------------
#
# 🔴 **A third copy of a registry decision, and nothing compared it.** The API
# decides per option type: a choice option prices per *value* and accepts
# `noTypeLevelPricing`, which is `z.null()`; a text option accepts `per_char`; a
# number option accepts `per_unit` or `tiered`. `optionPricingKinds()` in the
# dashboard states the same thing again, so a merchant can be offered a kind the
# API refuses.
#
# Measured 2026-09-15: making the dashboard offer `per_char` on a date option
# passed all 17 of its own tests **and** every check in this gate — the same
# shape as the `checkbox` measurement above, one decision further in.
#
# ⚠️ **The failure is a 400 on save, not a wrong charge** — the API refuses the
# write. That makes it a form that fails where a merchant cannot tell why, which
# is precisely what this gate exists to catch.
PRICING_MAP=$(grep -oE 'presentation: Presentation\.[A-Z_]+|pricingSchema: [a-zA-Z]+' "$REGISTRY" \
  | sed 's/presentation: Presentation\.//; s/pricingSchema: //' \
  | awk '/^[A-Z_]+$/ { t = tolower($0); next } t != "" { print t ":" $0; t = "" }' \
  | sort -u)

# The dashboard's map: the presentations named in each branch of the function.
KINDS_FN=$(sed -n '/export function optionPricingKinds/,/^}/p' "$PICKER_PRICING")

if [ -z "$PRICING_MAP" ]; then
  fail "could not read the pricing map from the API registry — has its shape changed?"
elif [ -z "$KINDS_FN" ]; then
  fail "could not read optionPricingKinds() — has its shape changed?"
else
  PRICING_MISMATCH=0

  while IFS=: read -r type schema; do
    [ -z "$type" ] && continue

    # What the dashboard offers for this type: the branch naming it, if any.
    OFFERS=$(printf '%s\n' "$KINDS_FN" | grep -c "'$type'" || true)

    case "$schema" in
      noTypeLevelPricing)
        # The API accepts only `null`; the dashboard must offer nothing.
        if [ "$OFFERS" -ne 0 ]; then
          fail "the dashboard offers option-level pricing for '$type', which the API refuses"
          PRICING_MISMATCH=$((PRICING_MISMATCH + 1))
        fi
        ;;
      *)
        # The API accepts a kind; the dashboard must name the type somewhere.
        if [ "$OFFERS" -eq 0 ]; then
          fail "the API prices '$type' per option ($schema) and the dashboard offers nothing"
          PRICING_MISMATCH=$((PRICING_MISMATCH + 1))
        fi
        ;;
    esac
  done <<< "$PRICING_MAP"

  if [ "$PRICING_MISMATCH" -eq 0 ]; then
    pass "all $(printf '%s\n' "$PRICING_MAP" | grep -c .) type(s) agree on option-level pricing"
  fi
fi

# --- Contracts the PLUGIN states in prose ------------------------------------
#
# 🔴 **A requirement written in a docblock that nothing compares.** The plugin's
# templates state things the *dashboard* must do, and no gate read them —
# measured 2026-09-15, one of those requirements was broken by a change in this
# very session and found only by a human reading the template.
#
# `templates/options/text_field.php`: *"The dashboard derives `character_counter`
# from the limit rather than offering it as a separate switch, so the two cannot
# disagree."* Making `maxLength` authorable without honouring it produced exactly
# the defect M14.4b names — a customer meeting a twenty-character limit with no
# warning, *"a support ticket and often an abandoned cart"*.
#
# ⚠️ **These check that the dashboard has the MECHANISM, not that a given option
# is configured.** A gate cannot see a merchant's data; it can see whether the
# code that keeps the promise exists, which is what went missing.
CONTRACTS=0
CONTRACT_FAILS=0

contract() {
  # $1 human name · $2 file that must contain · $3 the pattern
  CONTRACTS=$((CONTRACTS + 1))

  if [ ! -f "$2" ]; then
    fail "$1: missing file ${2#"$ROOT/"}"
    CONTRACT_FAILS=$((CONTRACT_FAILS + 1))
  elif ! grep -qE "$3" "$2"; then
    fail "$1"
    CONTRACT_FAILS=$((CONTRACT_FAILS + 1))
  fi
}

DISPLAY_MOD="$ROOT/optioniaWooCommerceFrontend/src/lib/option-sets/option-display.ts"
EDITOR="$ROOT/optioniaWooCommerceFrontend/src/app/(app)/option-sets/[id]/page.tsx"

# The dashboard must DERIVE the counter from the length limit...
contract "the dashboard must derive character_counter from maxLength" \
  "$DISPLAY_MOD" 'characterCounter = typeof validation\?\.maxLength'

# ...and actually call that derivation where an option is saved.
contract "the editor must apply the derived display when saving an option" \
  "$EDITOR" 'deriveDisplay\('

# 🔴 **And never offer it as a switch**, which is the half the prose is about:
# a merchant who could turn the counter off while a limit stood is precisely the
# disagreement the plugin's template guards against.
if grep -qE "'characterCounter'" "$DISPLAY_MOD" \
  && grep -qE "DisplayField\[\] *=|return choice \?" "$DISPLAY_MOD" \
  && sed -n '/export function optionDisplayFields/,/^}/p' "$DISPLAY_MOD" \
    | grep -qE "characterCounter"; then
  fail "the dashboard offers characterCounter as a merchant setting; it must be derived"
  CONTRACT_FAILS=$((CONTRACT_FAILS + 1))
fi

CONTRACTS=$((CONTRACTS + 1))

# `stepped` is published and deliberately not offered (ADR-063): a wizard needs
# a second reason for a group to be hidden, and `frontend.js` recomputes
# visibility from scratch on every change.
#
# ⚠️ **Asserted on the picker's own block, not with a negative pattern.** A
# first draft used a negative lookahead, which POSIX `grep -E` does not have —
# it printed `repetition-operator operand invalid` and failed the check for its
# own reason rather than the code's.
if ! grep -q 'GROUP_LAYOUTS = \[' "$PICKER"; then
  fail "could not read GROUP_LAYOUTS — has its shape changed?"
  CONTRACT_FAILS=$((CONTRACT_FAILS + 1))
elif sed -n '/GROUP_LAYOUTS = \[/,/\] as const;/p' "$PICKER" | grep -qE "value: 'stepped'"; then
  fail "the dashboard offers the 'stepped' layout, which the plugin renders as inline"
  CONTRACT_FAILS=$((CONTRACT_FAILS + 1))
fi

if [ "$CONTRACT_FAILS" -eq 0 ]; then
  pass "all $CONTRACTS plugin-stated contract(s) are honoured by the dashboard"
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
