#!/usr/bin/env bash
#
# Run every quality gate for the plugin.
#
#   bash bin/check.sh
#
# Uses WordPress Studio's bundled PHP when a system PHP is unavailable, so the
# checks run without installing anything.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Locate a PHP binary.
if command -v php >/dev/null 2>&1; then
  PHP="php"
else
  PHP="$(find /Applications/Studio.app/Contents/Resources/php-bin -maxdepth 2 -name php -type f 2>/dev/null | head -1)"
fi

if [ -z "${PHP:-}" ] || ! "$PHP" -v >/dev/null 2>&1; then
  echo "No PHP binary found. Install PHP, or install WordPress Studio." >&2
  exit 1
fi

FAILED=0
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

section "1/4  Syntax (php -l)"
COUNT=0
BAD=0
while IFS= read -r file; do
  COUNT=$((COUNT + 1))
  if ! "$PHP" -l "$file" >/dev/null 2>&1; then
    BAD=$((BAD + 1))
    echo "  syntax error: $file"
    "$PHP" -l "$file" 2>&1 | sed 's/^/    /'
  fi
done < <(find . -name '*.php' -not -path './vendor/*' -type f)
if [ "$BAD" -eq 0 ]; then
  printf '\033[32mok\033[0m    %d files, no syntax errors\n' "$COUNT"
else
  printf '\033[31mFAIL\033[0m  %d of %d files have syntax errors\n' "$BAD" "$COUNT"
  FAILED=$((FAILED + 1))
fi

section "2/4  Architecture guards"
if bash bin/check-architecture.sh; then :; else FAILED=$((FAILED + 1)); fi

section "3/4  Coding standards (PHPCS, WordPress-Extra)"
if [ -x vendor/bin/phpcs ]; then
  if "$PHP" vendor/bin/phpcs -q --report=summary; then
    printf '\033[32mok\033[0m    PHPCS clean\n'
  else
    FAILED=$((FAILED + 1))
  fi
else
  printf '\033[33mskip\033[0m  vendor/ not installed — run: composer install\n'
fi

section "4/5  Unit tests (PHPUnit)"
if [ -x vendor/bin/phpunit ]; then
  if "$PHP" vendor/bin/phpunit --testsuite=unit; then :; else FAILED=$((FAILED + 1)); fi
else
  printf '\033[33mskip\033[0m  vendor/ not installed — run: composer install\n'
fi

# A passing suite says nothing about what it would catch.
#
# When this was written the plugin had 45 green tests covering **4 of 28
# classes** — 14% — and the gate reported nothing but "OK". A suite that
# exercises a seventh of the code is not a safety net, and a gate that cannot
# say so is the failure this project keeps finding: a check that passes while
# inspecting almost nothing.
#
# The floor is deliberately a *ratio of classes touched*, not a line-coverage
# percentage. Line coverage needs Xdebug, which Studio's PHP does not ship, and
# would fail the gate for an environment reason rather than a code one. Counting
# the classes a test file imports is cruder and always available.
section "5/5  Test coverage floor"
SRC_CLASSES=$(find src -name '*.php' -not -name 'Autoloader.php' | wc -l | tr -d ' ')
TESTED=$(grep -ohE 'use Optionia\\[A-Za-z\\]+' tests/unit/*.php 2>/dev/null | sort -u | wc -l | tr -d ' ')

# Named explicitly so raising it is a decision rather than a drift.
FLOOR=16

if [ "$TESTED" -lt "$FLOOR" ]; then
  printf '\033[31mFAIL\033[0m  %d of %d classes exercised; the floor is %d\n' \
    "$TESTED" "$SRC_CLASSES" "$FLOOR"
  printf '        Raise the floor when you raise the coverage — never the reverse.\n'
  FAILED=$((FAILED + 1))
else
  printf '\033[32mok\033[0m    %d of %d classes exercised (floor %d)\n' \
    "$TESTED" "$SRC_CLASSES" "$FLOOR"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  printf '\033[31m%d gate(s) failed.\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32mAll gates passed.\033[0m\n'
