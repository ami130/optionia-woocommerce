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

# --- Dependencies that nothing imports -------------------------------------
# A package installed and never used reads as part of the design. pino survived
# Phase 3 that way, and @nestjs/config survived two audits with a note saying
# "decide next phase" until the phase closed without deciding (ADR-022).
#
# The five allowed below are genuinely indirect and were each verified:
#   mysql2                   TypeORM loads the driver by name at runtime
#   @nestjs/platform-express Nest's HTTP adapter, implicit in NestFactory.create
#   @types/bcrypt            types only, never imported
#   @types/compression       types only; `compression` itself IS imported in main.ts
#   class-transformer        required by class-validator's ValidationPipe
INDIRECT="mysql2 @nestjs/platform-express @types/bcrypt @types/compression class-transformer"

UNUSED=""
for dep in $(node -e "console.log(Object.keys(require('./package.json').dependencies).join(' '))"); do
  case " $INDIRECT " in *" $dep "*) continue ;; esac

  if ! grep -rq "$dep" src --include='*.ts' 2>/dev/null; then
    UNUSED="$UNUSED $dep"
  fi
done

if [ -n "$UNUSED" ]; then
  fail "dependencies nothing imports (remove them, or add to INDIRECT with a reason):"
  for dep in $UNUSED; do echo "        $dep"; done
else
  pass "every dependency is imported or explicitly indirect"
fi


if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d script check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll script checks passed.\033[0m\n'
