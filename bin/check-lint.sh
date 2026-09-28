#!/usr/bin/env bash
#
# The linters CI runs are run here too.
#
# ## Why this exists
#
# 🔴 **Seven lint errors sat unseen for four days while every gate was green.**
# `npm run lint` runs in the Backend workflow and was **not** part of
# `bin/check.sh`, so `bin/check.sh` passing meant nothing about it — and the first
# push in 57 commits failed on errors introduced on 2026-09-24.
#
# ⚠️ **A check that only runs remotely is a check that runs after the decision.**
# The whole argument for this repository's gates is that a mistake is cheapest
# where it is made; a linter reachable only by pushing inverts that.
#
# 📌 **Scoped to what CI actually runs**, so the two cannot disagree. If CI gains
# a linter, it belongs here; if this gains one CI does not run, a merchant-facing
# failure could still ship green.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

printf 'Checking the linters CI runs…\n'

for project in optioniaWooCommerceBackend optioniaWooCommerceFrontend; do
  DIR="$ROOT/$project"

  if [ ! -f "$DIR/package.json" ]; then
    fail "$project: no package.json"
    continue
  fi

  # 📌 **A project with no lint script is a finding, not a pass.** Both have one
  # today, and one losing it silently is exactly the drift this gate is for.
  if ! grep -q '"lint"' "$DIR/package.json"; then
    fail "$project declares no lint script"
    continue
  fi

  # ⚠️ **`node_modules` absent is SKIPPED, not failed.** A fresh clone has no
  # dependencies, and a gate that fails there would be a gate people stop
  # running. CI always installs, so the check is never skipped where it matters.
  if [ ! -d "$DIR/node_modules" ]; then
    printf '\033[33mskip\033[0m  %s: dependencies not installed\n' "$project"
    continue
  fi

  if (cd "$DIR" && npm run lint --silent >/dev/null 2>&1); then
    pass "$project lints clean"
  else
    fail "$project has lint errors"
    printf '        Run: cd %s && npm run lint\n' "$project"
  fi
done

# --- The backend's own doc check, which CI runs and bin/check.sh did not ------
#
# 🔴 **`invoices` and `plan_prices` went undocumented for four days** while every
# gate here was green, because `bin/check-docs.sh` lives in the backend and runs
# only in CI. Same blind spot as the lint errors above, found on the same push.
#
# ⚠️ **It needs a database with migrations applied**, so it is SKIPPED rather
# than failed when one is unreachable — a gate that fails on a laptop with MySQL
# stopped is a gate people stop running. CI always has one.
DOCS="$ROOT/optioniaWooCommerceBackend/bin/check-docs.sh"

if [ ! -f "$DOCS" ]; then
  fail "the backend's doc check is missing"
elif [ ! -d "$ROOT/optioniaWooCommerceBackend/node_modules" ]; then
  printf '\033[33mskip\033[0m  DATABASE.md: dependencies not installed\n'
elif (cd "$ROOT/optioniaWooCommerceBackend" && bash bin/check-docs.sh >/dev/null 2>&1); then
  pass "docs/DATABASE.md still describes the schema migrations produce"
else
  # ✏️ **The output is shown, unlike the lint checks above.** This one names the
  # exact table or foreign key, and hiding that would cost a round trip.
  fail "docs/DATABASE.md disagrees with the schema"
  (cd "$ROOT/optioniaWooCommerceBackend" && bash bin/check-docs.sh 2>&1 | grep -E '✗' | sed 's/^/        /') || true
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d lint check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll lint checks passed.\033[0m\n'
