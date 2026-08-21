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

section "4/4  Unit tests (PHPUnit)"
if [ -x vendor/bin/phpunit ]; then
  if "$PHP" vendor/bin/phpunit --testsuite=unit; then :; else FAILED=$((FAILED + 1)); fi
else
  printf '\033[33mskip\033[0m  vendor/ not installed — run: composer install\n'
fi

echo
if [ "$FAILED" -gt 0 ]; then
  printf '\033[31m%d gate(s) failed.\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32mAll gates passed.\033[0m\n'
