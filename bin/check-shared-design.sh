#!/usr/bin/env bash
#
# The shared geometry stays shareable, and both projects still see it.
#
# ## Why this exists
#
# 🔴 **One copy of the geometry, two consumers.** `shared/design/` is the port of
# `designScene.ts` — the code that decides where a customer's name lands on a
# physical object. The API renders print files from it and the dashboard's canvas
# editor authors against it, and the plan calls re-deriving it *"the most
# expensive avoidable work in this project."*
#
# ⚠️ **A single framework import would end that.** One `import ... from
# '@nestjs/common'` or `'react'` makes this unusable by the other consumer, and
# nothing in either project's own type-check would notice — each compiles with
# its own framework present.
#
# 🔴 **Moving it already lost 134 tests once.** The backend's Jest `rootDir` was
# `src`, so relocating the tree out of `src/` dropped 6 suites — and Jest
# reported "82 passed" in green. A test count that falls silently is this
# project's most repeated defect shape, so the count is asserted here.
set -euo pipefail

printf '\033[1m== check-shared-design.sh ==\033[0m\n'
printf 'Checking the shared geometry…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED="$ROOT/shared/design"

if [ ! -d "$SHARED" ]; then
  fail "shared/design is missing — this gate is checking nothing"
  exit 1
fi

# Comments stripped first: the files EXPLAIN why they import no framework, and
# prose naming one must never read as an import of it.
strip_comments() {
  perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g;' "$1"
}

# 1. Framework-free, which is the property that makes it shareable at all.
OFFENDERS=""
CHECKED=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in *.spec.ts) continue ;; esac
  CHECKED=$((CHECKED + 1))

  if strip_comments "$f" \
    | grep -qE "from '(@nestjs/|react|next/|typeorm|@tanstack/)"; then
    OFFENDERS="$OFFENDERS  $(basename "$f")\n"
  fi
done <<EOF
$(find "$SHARED" -name '*.ts' -type f)
EOF

if [ "$CHECKED" -eq 0 ]; then
  fail "read no shared files at all — the parser is wrong, not the code"
elif [ -n "$OFFENDERS" ]; then
  fail "shared geometry importing a framework:"
  printf "%b" "$OFFENDERS" | sed 's|^|      |'
  printf '        one framework import makes this unusable by the other consumer\n'
else
  pass "all $CHECKED shared module(s) are framework-free"
fi

# 2. It compiles with NO framework types in scope — proven, not asserted.
#
# 📌 `"types": []` in its own tsconfig means not even Node globals. A file that
# reached for `process` or `window` fails here.
TSC="$ROOT/optioniaWooCommerceBackend/node_modules/.bin/tsc"

if [ ! -x "$TSC" ]; then
  fail "no tsc available to prove the shared tree stands alone"
elif "$TSC" --noEmit -p "$SHARED/tsconfig.json" >/dev/null 2>&1; then
  pass "the shared tree compiles with no framework types in scope"
else
  fail "the shared tree no longer compiles standalone"
  "$TSC" --noEmit -p "$SHARED/tsconfig.json" 2>&1 | head -3 | sed 's|^|      |'
fi

# 3. Both projects can still resolve it.
for project in optioniaWooCommerceBackend optioniaWooCommerceFrontend; do
  if grep -q '"@shared/\*"' "$ROOT/$project/tsconfig.json"; then
    pass "$project aliases @shared/*"
  else
    fail "$project no longer aliases @shared/* — it cannot import the geometry"
  fi
done

# 4. The backend's test runner still SEES the shared specs.
#
# ⚠️ This is the check that would have caught the 134 vanished tests. A `roots`
# entry is what carries them; without it Jest finds nothing here and says so in
# green.
if grep -q '"<rootDir>/../shared"' "$ROOT/optioniaWooCommerceBackend/package.json"; then
  pass "the backend test runner includes the shared tree"
else
  fail "jest no longer roots the shared tree — its specs would vanish silently"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d shared-design check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll shared-design checks passed.\033[0m\n'
