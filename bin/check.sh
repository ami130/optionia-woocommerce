#!/usr/bin/env bash
#
# Every cross-repository gate, in one command.
#
# ## Why this exists
#
# Each repository has its own `bin/check.sh`; these are the checks that span
# **two or more** of them and therefore belong to none. They were added one at a
# time and run one at a time, which means the only thing making them run was
# somebody remembering all five — and the gates exist precisely because
# "somebody remembers" is not a mechanism.
#
# Discovered rather than listed: a gate added tomorrow is included without
# anyone editing this file. `mutate.sh` is excluded because it is a tool a
# person drives, not a check with a verdict.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILED=0
TOTAL=0

for gate in bin/check-*.sh; do
  [ -f "$gate" ] || continue

  TOTAL=$((TOTAL + 1))
  printf '\033[1m== %s ==\033[0m\n' "$(basename "$gate")"

  if bash "$gate"; then
    :
  else
    FAILED=$((FAILED + 1))
  fi

  echo
done

if [ "$TOTAL" -eq 0 ]; then
  # A loop that matched nothing must not report success: that is a green run
  # over zero checks, which is the most misleading result available.
  printf '\033[31mNo cross-repo gates found — the glob is wrong, not the code.\033[0m\n'
  exit 1
fi

if [ "$FAILED" -gt 0 ]; then
  printf '\033[31m%d of %d cross-repo gate(s) failed.\033[0m\n' "$FAILED" "$TOTAL"
  exit 1
fi

printf '\033[32mAll %d cross-repo gates passed.\033[0m\n' "$TOTAL"
