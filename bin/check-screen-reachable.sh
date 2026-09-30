#!/usr/bin/env bash
#
# Every field an API returns is read by a screen.
#
# ## Why this exists
#
# 🔴 **This is the defect this project has met FOUR times**, and every instance
# was caught by a human reading code rather than by a mechanism:
#
#   1. `usage[]` shipped on the subscription summary; the dashboard ignored it (F132)
#   2. `plan.read_only` shipped in the config document; the plugin never read it (F137)
#   3. `conversion` computed by M25.1's whole purpose; no screen rendered it
#   4. `topValues` computed, typed and fixtured; rendered by nothing
#
# ⚠️ **The third and fourth were one commit apart**, the fourth found while
# auditing the fix for the third. A pattern that survives being named is one that
# needs a check rather than more attention.
#
# ## What is checked, and what is deliberately not
#
# **Not** whether a field is rendered *well* — that is what render tests are for.
# What is checked is the one thing a passing e2e suite cannot tell you: that the
# dashboard reads the field at all. An HTTP test proves the API works; it proves
# nothing about whether a merchant can ever see the answer.
#
# 📌 **Exemptions are BY NAME with a reason**, following `check-reachable.ts`. A
# pattern would quietly widen; a name expires the moment someone reads it.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="$ROOT/optioniaWooCommerceFrontend/src/lib/analytics/api.ts"
PAGE="$ROOT/optioniaWooCommerceFrontend/src/app/(app)/analytics/page.tsx"

printf '\033[1m== check-screen-reachable.sh ==\033[0m\n'
printf 'Checking that every analytics field reaches a screen...\n'

if [ ! -f "$API" ] || [ ! -f "$PAGE" ]; then
  fail "missing the analytics API type or page"
  printf '\n\033[31m1 screen-reachability check failed.\033[0m\n'
  exit 1
fi

# Fields the page legitimately never names. Each needs a reason.
#
# `topValues` is NOT here — it was the fourth instance, and listing it would have
# been the exemption hiding the defect.
is_exempt() {
  case "$1" in
    # ⚠️ **Both are read, but through destructuring rather than `data.<field>`**
    # — `const { attach, currency } = data` at the top of `Summary`. Exempt from
    # the `data.` form, NOT from being read: the destructuring itself is
    # asserted below, so deleting it fails this gate.
    attach|currency) return 0 ;;
    *) return 1 ;;
  esac
}

# The destructured pair, checked explicitly rather than assumed.
assert_destructured() {
  if ! grep -qE 'const \{[^}]*\battach\b[^}]*\} = data' "$PAGE"; then
    fail "\`attach\` is no longer destructured from data; the summary cannot read it"
  elif ! grep -qE 'const \{[^}]*\bcurrency\b[^}]*\} = data' "$PAGE"; then
    fail "\`currency\` is no longer destructured from data; money cannot be formatted"
  else
    pass "the destructured fields (attach, currency) are still read"
  fi
}

# The fields of `AnalyticsSummary`, taken from the interface body rather than the
# whole file — a type alias elsewhere is not a field the page must render.
FIELDS=$(awk '/^export interface AnalyticsSummary \{/,/^\}/' "$API" \
  | grep -oE '^  (readonly )?[a-zA-Z][a-zA-Z0-9]*:' \
  | sed 's/^  //;s/readonly //;s/://')

if [ -z "$FIELDS" ]; then
  fail "parsed no fields from AnalyticsSummary — the parser is wrong, not the code"
  printf '\n\033[31m1 screen-reachability check failed.\033[0m\n'
  exit 1
fi

UNREAD=""
CHECKED=0

for field in $FIELDS; do
  CHECKED=$((CHECKED + 1))

  if is_exempt "$field"; then
    continue
  fi

  # 🔴 **`data.<field>` ONLY, and the first draft of this check was useless
  # without that.** It also accepted a bare word match, which matches the field
  # name inside a COMMENT — and both defects this gate exists for were removed
  # while their explanatory comments stayed. The gate passed on both. A check
  # that cannot fail on the thing it was written for is worse than none,
  # because it is believed.
  #
  # ⚠️ **Comments are stripped before matching**, so a docblock naming a field
  # cannot stand in for reading it.
  if ! sed 's|//.*||' "$PAGE" \
    | grep -v '^\s*\*' \
    | grep -q "data\.$field\b"; then
    UNREAD="$UNREAD  $field\n"
  fi
done

assert_destructured

if [ -n "$UNREAD" ]; then
  fail "the API returns field(s) no screen reads:"
  printf "%b" "$UNREAD" | sed 's|^|      |'
  printf '        a field a merchant never sees is work nobody receives\n'
  printf '        render it, remove it, or exempt it BY NAME with a reason\n'
else
  pass "all $CHECKED analytics field(s) reach the screen"
fi


# --- The ADMIN screen, on the same principle ---------------------------------
#
# 🔴 **This gate was hardcoded to analytics**, and the defect class it exists for
# reappeared the moment a second screen arrived: `GET /admin/plans` returns
# `limits` and `features`, and the plans screen displayed neither — a field
# crossing the wire that no screen reads, which is precisely what this checks.
#
# ⚠️ **A second assertion rather than a rewrite.** Generalising the whole gate
# would mean restructuring a check whose every line records a specific way it was
# once wrong; naming the second screen costs less and fails just as loudly. A
# third screen should prompt the generalisation.
ADMIN_API="$ROOT/optioniaWooCommerceFrontend/src/lib/admin/api.ts"
ADMIN_PAGE="$ROOT/optioniaWooCommerceFrontend/src/app/(admin)/admin/plans/page.tsx"

if [ ! -f "$ADMIN_API" ] || [ ! -f "$ADMIN_PAGE" ]; then
  fail "missing the admin API type or plans page"
else
  ADMIN_FIELDS=$(awk '/^export interface AdminPlan \{/,/^\}/' "$ADMIN_API" \
    | grep -oE '^  (readonly )?[a-zA-Z][a-zA-Z0-9]*:' \
    | sed 's/^  //;s/readonly //;s/://')

  if [ -z "$ADMIN_FIELDS" ]; then
    fail "parsed no fields from AdminPlan — the parser is wrong, not the code"
  else
    ADMIN_UNREAD=""
    ADMIN_CHECKED=0

    for field in $ADMIN_FIELDS; do
      case "$field" in
        # ⚠️ `id` is a React key and `sortOrder` decides the order the API
        # already returns rows in — read by the list, not displayed as text.
        id|sortOrder) continue ;;
      esac

      ADMIN_CHECKED=$((ADMIN_CHECKED + 1))

      # Comments stripped first, for the reason recorded above.
      if ! sed 's|//.*||' "$ADMIN_PAGE" \
        | grep -v '^\s*\*' \
        | grep -qE "plan\.$field\b"; then
        ADMIN_UNREAD="$ADMIN_UNREAD  $field\n"
      fi
    done

    if [ -n "$ADMIN_UNREAD" ]; then
      fail "admin plan field(s) the screen never reads:"
      printf "%b" "$ADMIN_UNREAD" | sed 's|^|      |'
      printf '        a field that crosses the wire and reaches no screen is not built\n'
    else
      pass "all $ADMIN_CHECKED admin plan field(s) reach the screen"
    fi

    # 🔴 **Defined is not rendered, and the first version of this check could
    # not tell the difference.** `plan.limits` is read inside `PlanAllowances`,
    # in this same file — so deleting the `<PlanAllowances />` call left the
    # component and its field reads intact, and a file-wide grep still found
    # them. The probe that was meant to prove this check passed instead.
    #
    # ⚠️ Every sub-component that reads a field must also be MOUNTED.
    for component in PlanAllowances DiscountForm; do
      defined=$(grep -cE "^function $component\(" "$ADMIN_PAGE" || true)
      mounted=$(sed 's|//.*||' "$ADMIN_PAGE" | grep -cE "<$component[ /]" || true)

      if [ "$defined" -gt 0 ] && [ "$mounted" -eq 0 ]; then
        fail "$component is defined but never rendered — its fields reach no screen"
      fi
    done

    if [ "$FAILURES" -eq 0 ]; then
      pass "every admin sub-component that reads a field is rendered"
    fi
  fi
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d screen-reachability check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll screen-reachability checks passed.\033[0m\n'
