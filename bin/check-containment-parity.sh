#!/usr/bin/env bash
#
# Three builders answer one question: whose answer disappears when this target
# is hidden?
#
# ## Why this exists
#
# 🔴 **Getting this map wrong destroyed a real customer's answer.** Until M17.8
# the plugin mapped a value to its owning option — which reads like the
# containment the index is named for, but the question is narrower. Hiding one
# colour of five removes a *choice*: the question stays on the page and the
# answer stays valid. Measured with the old mapping, hiding `val-extra` deleted
# the answer of a customer who had chosen `plain`, and an unrelated rule reading
# *"opt-b is empty"* then fired, hiding a third option nothing was meant to
# touch.
#
# Three copies now build this map, and M21.1 added the third:
#
#   plugin PHP  SelectionResolver::index_containment()   the server-side resolve
#   plugin JS   frontend.js containmentIn()              the storefront's live UI
#   dashboard   lib/preview/options-under.ts             the live preview
#
# ## Why the shared fixture is not enough on its own
#
# `rule-fixtures.json` pins the semantics and both evaluators run it — but it
# carries **7 containment entries across 63 cases**: one empty (a value), one
# multi (a group), the rest self-mapping. One example per shape proves the
# evaluator handles a map of that shape; it cannot prove three *builders* still
# produce it. A copy that stopped registering values would pass every fixture,
# because the fixtures supply their own map rather than building one.
#
# ## Why lines rather than logic
#
# These are three languages with three data structures — a PHP array, a JS
# object, an ES `Map`. There is no common text to diff, unlike the evaluators.
# What *is* common is the decision each one encodes, so each is asserted against
# the shape its own language spells it in, and the gate fails when a line stops
# saying what it says today.
#
# ⚠️ **A BLOCKER on divergence, not a warning.** The failure mode is silent data
# loss in someone's cart, which no test downstream would attribute back here.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHP="$ROOT/optioniaWooCommercePlugin/src/Engine/SelectionResolver.php"
JS="$ROOT/optioniaWooCommercePlugin/assets/js/frontend.js"
TS="$ROOT/optioniaWooCommerceFrontend/src/lib/preview/options-under.ts"

for f in "$PHP" "$JS" "$TS"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT/"}"
    printf '\n\033[31m%d containment check(s) failed.\033[0m\n' "$FAILURES"
    exit 1
  fi
done

# Comments are stripped before matching: all three files *discuss* the mapping at
# length — the TS copy quotes the rejected one — and a gate that read prose would
# measure the explanation rather than the code. The same trap
# `check-preview-filters.sh` fell into on its first run.
strip_php() { sed -e 's://.*::' "$1" | awk '/\/\*/{b=1} !b{print} /\*\//{b=0}'; }

# Each row: a human-readable claim, then the pattern proving it in each language.
#
# 🔴 **A value maps to NOTHING.** This is the M17.8 fix, and the row this gate
# exists for. `[]` / `array()` — never the owning option's id.
check_rule() {
  local label="$1" file="$2" pattern="$3" lang="$4"

  if strip_php "$file" | grep -qE "$pattern"; then
    pass "$lang: $label"
  else
    fail "$lang: $label — not found"
    printf '      in %s\n' "${file#"$ROOT/"}"
    printf '      expected to match: %s\n' "$pattern"
  fi
}

check_rule "a value maps to nothing" "$PHP" \
  '\$under\[ \(string\) \$value\[.id.\] \] = array\(\);' 'plugin PHP'
check_rule "a value maps to nothing" "$JS" \
  'under\[ valueId \] = \[\];' 'plugin JS'
check_rule "a value maps to nothing" "$TS" \
  'under\.set\(value\.id, \[\]\);' 'dashboard TS'

check_rule "an option maps to itself" "$PHP" \
  '\$under\[ \$option_id \]\[\] = \$option_id;' 'plugin PHP'
check_rule "an option maps to itself" "$JS" \
  'under\[ optionId \] = \[ optionId \];' 'plugin JS'
check_rule "an option maps to itself" "$TS" \
  'under\.set\(option\.id, \[option\.id\]\);' 'dashboard TS'

check_rule "a group collects its options" "$PHP" \
  '\$under\[ \$group_id \]\[\] = \$option_id;' 'plugin PHP'
check_rule "a group collects its options" "$JS" \
  'under\[ groupId \]\.push\( optionId \);' 'plugin JS'
check_rule "a group collects its options" "$TS" \
  'under\.set\(group\.id, \[\.\.\.\(under\.get\(group\.id\) \?\? \[\]\), option\.id\]\);' 'dashboard TS'

# 🔴 **The mapping that caused the defect must appear in NO builder.** The
# assertions above prove each file still says the right thing; this proves none
# of them has *also* grown the wrong thing — a second write that clobbers the
# first would leave every pattern above matching.
for pair in "$PHP|plugin PHP|\\\$under\[ \(string\) \\\$value\[.id.\] \] = array\( \\\$option_id \)" \
            "$JS|plugin JS|under\[ valueId \] = \[ optionId \]" \
            "$TS|dashboard TS|under\.set\(value\.id, \[option\.id\]\)"; do
  f="${pair%%|*}"; rest="${pair#*|}"; lang="${rest%%|*}"; bad="${rest#*|}"

  if strip_php "$f" | grep -qE "$bad"; then
    fail "$lang: a value maps to its owning option — this is the M17.8 defect"
    printf '      Hiding one choice would delete the customer answer beside it.\n'
  else
    pass "$lang: no value → owning-option edge"
  fi
done

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d containment check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll containment parity checks passed.\033[0m\n'
