#!/usr/bin/env bash
#
# Every route the guard table models is a route that exists.
#
# ## Why this exists
#
# 🔴 **A decision table is only as honest as its paths.** `route-guards.test.ts`
# models which guard owns which route and proves the set never loops — a real
# property, and the test that caught two live redirect loops. But it is a pure
# function over strings: it passes just as happily for `/admin/unicorns`.
#
# ⚠️ **Measured 2026-09-30.** `/admin/plans` was added to that table with four
# tests around it while no such page existed. Seven of the eight entries mapped
# to a real `page.tsx`; mine was the only invention, and nothing would have
# noticed when the first real admin screen landed at a different path — the
# tests would have kept passing while covering nothing.
#
# 📌 **The inverse is NOT checked**, deliberately. A page with no entry in the
# table is a page in a route group whose layout already guards it; requiring an
# entry for every page would make the table a second router to keep in step.
# What matters is that a modelled route is a real one.
set -euo pipefail

printf '\033[1m== check-route-guards.sh ==\033[0m\n'
printf 'Checking that guarded routes exist…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/optioniaWooCommerceFrontend/src/app"
TABLE="$ROOT/optioniaWooCommerceFrontend/src/components/layout/route-guards.test.ts"

if [ ! -f "$TABLE" ]; then
  fail "the guard table is missing — this gate is checking nothing"
  exit 1
fi

# Only the GUARD_FOR block: the file also names paths in prose and in
# assertions, and a comment must never satisfy a check that a route is real.
BLOCK=$(awk '/^const GUARD_FOR/,/^};/' "$TABLE")

if [ -z "$BLOCK" ]; then
  fail "could not read GUARD_FOR — the parser is wrong, not the code"
  exit 1
fi

MISSING=""
CHECKED=0

while IFS= read -r route; do
  [ -z "$route" ] && continue
  CHECKED=$((CHECKED + 1))

  # ⚠️ **The root is its own case.** `*//page.tsx` matches nothing, so the first
  # run of this gate reported `/` missing while `app/page.tsx` sat right there —
  # a false positive in the gate, not a gap in the app.
  #
  # 📌 Next.js route groups are parenthesised directories that do not appear in
  # the URL, so the page for `/dashboard` may live at `(app)/dashboard/page.tsx`
  # — which is why this matches by suffix rather than by literal path.
  if [ "$route" = "/" ]; then
    found=$([ -f "$APP/page.tsx" ] && echo yes || echo '')
  else
    found=$(find "$APP" -path "*${route}/page.tsx" -print -quit 2>/dev/null)
  fi

  if [ -z "$found" ]; then
    MISSING="$MISSING  $route\n"
  fi
done <<EOF
$(printf '%s' "$BLOCK" | grep -oE "^  '/[a-z0-9/-]*'" | tr -d " '")
EOF

if [ "$CHECKED" -eq 0 ]; then
  fail "read no routes from the guard table — the parser is wrong, not the code"
elif [ -n "$MISSING" ]; then
  fail "guarded route(s) with no page:"
  printf "%b" "$MISSING" | sed 's|^|      |'
  printf '        the table models a path nothing serves; build it or drop it\n'
else
  pass "all $CHECKED guarded route(s) map to a real page"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d route-guard check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll route-guard checks passed.\033[0m\n'
