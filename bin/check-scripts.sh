#!/usr/bin/env bash
#
# Script integrity.
#
# Verifies that every file path referenced by an npm script actually exists.
#
# Written after committing a package.json that described the finished project
# rather than the one that exists: five scripts pointed at files that had not
# been created, so `npm run migration:run` — a documented setup step — failed
# immediately, and CI would have failed on first push.
#
# A directory that is empty is honest. A script that fails is a lie.
#
# Usage: bash bin/check-scripts.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

# Extract every ./src/... , src/... , ./test/... and bin/... path from scripts.
REFS=$(node -e "
  const s = require('./package.json').scripts || {};
  const seen = new Set();
  for (const body of Object.values(s)) {
    const m = body.match(/(\.\/)?((src|test|bin)\/[A-Za-z0-9._\/-]+)/g) || [];
    for (const hit of m) seen.add(hit.replace(/^\.\//, ''));
  }
  console.log([...seen].join('\n'));
")

if [ -z "$REFS" ]; then
  pass "no file paths referenced by scripts"
else
  MISSING=""
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if [ ! -e "$ref" ]; then
      # Report which script referenced it, so the fix is obvious.
      OWNER=$(node -e "
        const s = require('./package.json').scripts || {};
        const hits = Object.entries(s).filter(([, v]) => v.includes('$ref')).map(([k]) => k);
        console.log(hits.join(', '));
      ")
      MISSING="${MISSING}${ref}  (referenced by: ${OWNER})\n"
    fi
  done <<< "$REFS"

  if [ -n "$MISSING" ]; then
    fail "npm scripts reference files that do not exist:"
    printf "%b" "$MISSING" | sed 's/^/        /'
  else
    pass "all script file references resolve ($(echo "$REFS" | grep -c . ) paths)"
  fi
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d script check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll script checks passed.\033[0m\n'
