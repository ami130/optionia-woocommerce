#!/usr/bin/env bash
#
# Apply one mutation, run the suite, report whether it was KILLED — correctly.
#
# ## Why this exists
#
# A hand-rolled probe grepping `Tests: N failed` reported a mutant as SURVIVED
# when it had actually **died**. The mutation caused a *compile* failure, so the
# suite reported `611 passed` with zero failures and two suites that never ran —
# a lower total, not a failure.
#
# `optioniaWooCommerceBackend/test/README.md` warns about exactly this:
#
#   "Treat a count below the known total as a skip, not a pass."
#
# A mutation probe that ignores the suite line will call a killed mutant a
# survivor, and the natural next step — writing a test to kill something already
# dead — wastes effort and, worse, teaches false confidence about coverage.
#
# So this script decides on THREE signals, not one:
#
#   1. exit code        — the runner failed
#   2. failing tests    — a real assertion broke
#   3. a lower total    — a suite did not compile, which is also a kill
#
# ## Usage
#
#   bin/mutate.sh <baseline-total> <file> <search> <replace> -- <command...>
#
#   bin/mutate.sh 645 optioniaWooCommerceBackend/src/x.ts "a" "b" \
#     -- npx jest --silent
#
# The file is restored on every exit path, including Ctrl-C: a mutation left
# behind is worse than no probe at all.

set -uo pipefail

if [ "$#" -lt 6 ]; then
  echo "usage: $0 <baseline-total> <file> <search> <replace> -- <command...>" >&2
  exit 2
fi

BASELINE="$1"; FILE="$2"; SEARCH="$3"; REPLACE="$4"; shift 4
[ "${1:-}" = "--" ] || { echo "expected -- before the command" >&2; exit 2; }
shift

[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 2; }

BACKUP="$(mktemp)"
cp "$FILE" "$BACKUP"
# Restore on success, failure, and interrupt alike.
trap 'cp "$BACKUP" "$FILE"; rm -f "$BACKUP"' EXIT INT TERM

# Literal replacement, not a regex: a mutation is an exact edit, and a pattern
# that silently matches nothing produces a "surviving" mutant that was never
# applied — a false result this script exists to prevent.
python3 - "$FILE" "$SEARCH" "$REPLACE" <<'PY'
import sys
path, search, replace = sys.argv[1], sys.argv[2], sys.argv[3]
source = open(path).read()
if search not in source:
    sys.stderr.write('MUTATION NOT APPLIED: search text absent\n')
    sys.exit(3)
open(path, 'w').write(source.replace(search, replace, 1))
PY

if [ "$?" -ne 0 ]; then
  printf '\033[31mINVALID\033[0m  the mutation never applied — the result would be meaningless\n'
  exit 3
fi

OUTPUT="$("$@" 2>&1)"
STATUS=$?

# Every runner in this project prints a total somewhere in these shapes:
#   Tests:       645 passed, 645 total     (jest)
#   Tests: 815, Assertions: 1606,          (phpunit)
#   Tests  62 passed (62)                  (vitest)
TOTAL="$(printf '%s' "$OUTPUT" | python3 -c '
import re, sys

text = sys.stdin.read()

# Each runner states its total differently, and the *total* is the number that
# matters — a lower one means a suite did not run.
#   jest    "Tests:       645 passed, 645 total"
#   vitest  "Tests  62 passed (62)"          (two spaces, no colon)
#   phpunit "Tests: 815, Assertions: 1606,"
for pattern in (
    r"Tests:\s+\d+[^\n]*?(\d+)\s+total",   # jest
    r"Tests\s+\d+\s+\w+[^\n]*?\((\d+)\)",  # vitest
    r"Tests:\s+(\d+),",                     # phpunit
):
    found = re.search(pattern, text)
    if found:
        print(found.group(1))
        break
')"
FAILED="$(printf '%s' "$OUTPUT" | grep -oiE '[0-9]+ (failed|failures?|errors?)' | grep -oE '[0-9]+' | head -1)"

REASON=''
[ "$STATUS" -ne 0 ] && REASON='non-zero exit'
[ -n "${FAILED:-}" ] && [ "${FAILED:-0}" -gt 0 ] && REASON="${FAILED} failing"
if [ -n "${TOTAL:-}" ] && [ "$TOTAL" -lt "$BASELINE" ]; then
  # The case the naive probe misses entirely.
  REASON="only ${TOTAL} of ${BASELINE} tests ran — a suite did not compile"
fi

if [ -n "$REASON" ]; then
  printf '\033[32mKILLED\033[0m   %s\n' "$REASON"
  exit 0
fi

printf '\033[31mSURVIVED\033[0m %s tests, all passing — this path is untested\n' "${TOTAL:-?}"
exit 1
