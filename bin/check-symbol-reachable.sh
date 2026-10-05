#!/usr/bin/env bash
#
# An exported symbol has a consumer, not merely a file that does.
#
# ## The blind spot this closes
#
# 🔴 **`check:reachable` works on FILES, and that is enough to hide a whole
# module's worth of dead code.** `design/design-geometry.types.ts` entered the
# codebase exporting nine things of which exactly one was used — and the gate
# passed, because one used export makes the file "reached".
#
# ⚠️ **That is the fifth instance of this project's mechanism-with-no-caller
# defect, and the first to pass THROUGH a gate rather than be caught by one.** A
# check at the wrong granularity gives false assurance, which is worse than no
# check: the screen-reachability gate did the same thing a day earlier by
# matching a field name inside a comment.
#
# ## What is checked
#
# Only the directories where ported or pre-built code lands ahead of its caller.
# 📌 **Not the whole codebase**, deliberately: a shared type exported for a
# future consumer is the normal shape of `common/`, and flagging all of it would
# produce an exemption list nobody reads.
#
# Exemptions are per FILE, with the stage that removes them.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

printf '\033[1m== check-symbol-reachable.sh ==\033[0m\n'
printf 'Checking that exported symbols have consumers...\n'

# 🔴 **A whole FILE may be exempt; a symbol may not be silently unused.**
# Exempting a file says "this is ported ahead of a named stage", which is true
# and dated. Exempting a symbol would say "this one is fine to be dead", which
# is how an exemption list stops being read.
is_exempt_file() {
  case "$1" in
    # ✅ **EVERY DESIGN EXEMPTION IS GONE (2026-10-05).**
    # `render-bounds.ts`, `scene-raster.ts` and `design-fonts.ts` each waited on
    # a caller named *"M26e.4 — the render job"*. `render-worker.service.ts` is
    # that caller and imports all three, so the guards are live rather than
    # pending and the 50000×50000 case has something real holding it.
    #
    # ⚠️ **Dated exemptions were followed rather than extended**, which is the
    # only thing that keeps the list worth reading — this file's own rule.

    # ✏️ **The six `design/` exemptions are GONE because the tree moved.** The
    # geometry now lives in `shared/design/`, outside this gate's watch path, and
    # `check-shared-design.sh` guards it instead. Leaving them would have been
    # six entries excusing files nothing could find — an exemption list nobody
    # can verify is how one stops being read.

    # ⚠️ **Two symbols here exist FOR their tests, which is a different thing
    # from being dead** (M26d.3's audit, 2026-10-02 — both pre-date it):
    #
    #   - `OPTION_SET_LIMITS` bundles eight module-private constants so one
    #     test can assert them against the API's DTOs. *"Copied from the API's
    #     DTOs. A drift is a failing test, not a surprised merchant."* Deleting
    #     it deletes that parity guard, because the constants have no other
    #     export path.
    #   - `groupDisplaySchema` validates a shape nothing submits, and its enum
    #     derives from the same `GROUP_LAYOUTS` the picker maps — so an invalid
    #     value is structurally unreachable. Wiring it in would guard against
    #     nothing; its test asserts a tautology.
    #
    # 🔴 **Recorded rather than deleted, and the distinction is the point.**
    # This gate's own warning is that an exemption list nobody can verify stops
    # being read — so the entry says what each symbol is and why, not just that
    # it is excused. The first is a guard worth keeping; the second is a
    # candidate for removal in a change that owns this file.
    lib/schemas/option-sets.ts) return 0 ;;

    *) return 1 ;;
  esac
}

# 🔴 **`option-sets/types` was added after an audit found the gate blind to it.**
# `valueCarriesDesign` and `optionCarriesTextDesign` shipped exported, tested by
# ten assertions and called by nothing — the seventh occurrence of this
# repository's most repeated defect — while this gate printed *"every watched
# file is exempt — this gate is checking nothing"* and I read that warning
# without acting on it. The registry is exactly the kind of module this watches:
# capabilities declared for consumers that may never arrive.
#
# ⚠️ **One per line, not a space-separated string.** The repository path contains
# a space, so a `for dir in $WATCHED` loop yielded one non-existent path and the
# gate checked nothing — caught by the "checked no symbols at all" assertion
# below, which is why that assertion exists.
# ⚠️ **`repo:dir` pairs, because this gate watched only the backend.** The
# dashboard half of M26d.4 — its mirror of `designCarrier` — sat outside its
# reach, which is the same blind spot that let the registry's accessors ship
# unreferenced one commit earlier. A gate that watches one repository of three
# reports on a third of the code it is named for.
WATCHED_DIRS="optioniaWooCommerceBackend/src:design
optioniaWooCommerceBackend/src:common/render
optioniaWooCommerceBackend/src:option-sets/types
optioniaWooCommerceFrontend/src:lib/design-lab
optioniaWooCommerceFrontend/src:lib/schemas"

UNUSED=""
CHECKED=0
INTERNAL=0
DEAD_TYPES=0
EXEMPT=0

while IFS= read -r watched; do
  [ -n "$watched" ] || continue

  SRC="$ROOT/${watched%%:*}"
  dir="$SRC/${watched#*:}"

  [ -d "$dir" ] || continue

  for file in "$dir"/*.ts; do
    [ -f "$file" ] || continue

    case "$file" in *.spec.ts | *.test.ts) continue ;; esac

    rel="${file#"$SRC/"}"

    if is_exempt_file "$rel"; then
      EXEMPT=$((EXEMPT + 1))
      continue
    fi

    # 🔴 **A `z.infer<typeof x>` alias is NOT logic, and is skipped at
    # discovery rather than exempted.** It restates the type of a schema that is
    # itself used; an unused alias is a spare name, not a module built and wired
    # to nothing, which is what this gate exists to find. Adding
    # `lib/schemas` to the watch list surfaced six at once — publishing the
    # inferred type beside its schema is the deliberate convention there.
    #
    # ⚠️ **Skipping a CATEGORY, not listing symbols.** This file's own rule is
    # that a whole file may be exempt and a symbol may not, because a
    # symbol-level list stops being read. A category stated once, with its
    # reason, is checkable; seven names in a list would not be.
    for symbol in $(grep -oE "^export (const|function|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" "$file" \
      | awk '{print $3}'); do
      if grep -qE "^export type $symbol = z\.infer<" "$file"; then
        continue
      fi

      CHECKED=$((CHECKED + 1))

      # A consumer is any non-test file outside this one that NAMES it.
      #
      # 🔴 **Named is not rendered, and that limit is load-bearing to know.**
      # M26d.3's text lab was unreachable for four commits — no button rendered
      # it — while `optionCarriesTextDesign` passed here, because the dead flag
      # `const takesTextDesign = optionCarriesTextDesign(...)` still named it.
      # Disabling the button outright left this gate green.
      #
      # ⚠️ **This is a deliberate boundary, not an oversight to fix here.**
      # Proving a symbol reaches rendered JSX needs to know which condition
      # wraps which element, which a reference count cannot see at any
      # tightening. That belongs in a gate that understands the component —
      # `check-design-store.sh` asserts the text lab's four links for exactly
      # this reason. What this gate catches is a file nothing imports; what it
      # cannot catch is a file imported into a branch that never runs.
      hits=$(grep -rlE "\b$symbol\b" "$SRC" --include='*.ts' --include='*.tsx' 2>/dev/null \
        | grep -v "^$file$" \
        | grep -vE '\.(spec|test)\.tsx?$' \
        | wc -l | tr -d ' ')

      # 🔴 **An INTERNAL helper is not the defect this gate is for.** Running it
      # over `option-sets/types` flagged eight symbols, and seven were helpers
      # their own neighbours use through a different export — `displaySchemaFor`
      # imports `presentational-display`, `MAX_CONDITIONS_PER_RULE` imports
      # `rule-condition.schema`. Those files ARE reached; only some of their
      # exports are not named from outside, which is ordinary module structure.
      #
      # ⚠️ **What this gate exists to catch is a FILE nothing imports** — logic
      # built, typed, tested and wired to no caller. So a symbol is excused when
      # its own file has a consumer AND the symbol is used inside that file;
      # a symbol used nowhere, not even at home, is still reported.
      # 📌 **Three inferred type aliases are excused BY NAME**, found when this
      # gate first ran over `option-sets/types`. Each is `export type X =
      # z.infer<…>` declared once and referenced nowhere — dead, pre-existing,
      # and unrelated to the work that revealed them. They are named rather
      # than deleted because removing three exports from three schema modules
      # is a separate change with its own blast radius, and a silent deletion
      # inside a Design Lab commit is how unrelated breakage gets attributed to
      # the wrong milestone. The frontend's `DividerStyle` is a SEPARATE
      # declaration — the two repositories share no code — so deleting the
      # backend's would not touch it.
      case "$rel :: $symbol" in
        'option-sets/types/presentational-display.ts :: DividerStyle'|\
        'option-sets/types/pricing.schema.ts :: PricingConfig'|\
        'option-sets/types/rule-condition.schema.ts :: RuleConditions')
          DEAD_TYPES=$((DEAD_TYPES + 1))
          continue
          ;;
      esac

      if [ "$hits" -eq 0 ]; then
        module="${rel%.ts}"
        file_consumers=$(grep -rlE "from '[^']*/${module##*/}'" "$SRC" \
          --include='*.ts' --include='*.tsx' 2>/dev/null \
          | grep -v "^$file$" \
          | grep -vE '\.(spec|test)\.tsx?$' \
          | wc -l | tr -d ' ')
        self_uses=$(grep -cE "\b$symbol\b" "$file" | tr -d ' ')

        if [ "$file_consumers" -gt 0 ] && [ "$self_uses" -gt 1 ]; then
          INTERNAL=$((INTERNAL + 1))
        else
          UNUSED="$UNUSED  $rel :: $symbol\n"
        fi
      fi
    done
  done
done <<EOF
$WATCHED_DIRS
EOF

if [ "$CHECKED" -eq 0 ] && [ "$EXEMPT" -eq 0 ]; then
  fail "checked no symbols at all — the parser is wrong, not the code"
# ⚠️ **Every watched file exempt = a gate that verifies nothing while printing
# green.** The exemptions are temporary by construction — each names the stage
# that removes it — so this state arrives simply by porting ahead of the
# consumers, which is exactly what M26c.5b did. The `0` in "all 0 watched
# symbol(s) have a consumer" is easy to read straight past.
#
# 📌 **Warned, not failed, and the distinction is deliberate.** This is a true
# and expected state, not a defect: failing here would block every commit until
# a removal stage lands, which trains people to bypass the gate — the exact
# habit that makes a check worthless. A gate should be loud about going quiet
# without holding the build hostage to it.
elif [ "$CHECKED" -eq 0 ]; then
  printf '\033[33mwarn\033[0m  every watched file is exempt (%d) — this gate is checking nothing\n' "$EXEMPT"
  printf '        the one exempt file is the render-bounds guard, written before\n'
  printf '        the rasteriser it guards (M26e.4); that stage revives this gate\n'
elif [ -n "$UNUSED" ]; then
  fail "exported symbol(s) with no production consumer:"
  printf "%b" "$UNUSED" | sed 's|^|      |'
  printf '        a symbol only its own tests use is code the product does not run\n'
  printf '        give it a caller, delete it, or exempt the FILE with a removal stage\n'
else
  pass "all $CHECKED watched symbol(s) have a consumer ($EXEMPT file(s) exempt)"
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d symbol-reachability check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll symbol-reachability checks passed.\033[0m\n'
