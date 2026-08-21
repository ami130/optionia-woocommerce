#!/usr/bin/env bash
#
# Architecture guards for the Optionia plugin.
#
# The M3.0 principles are only real if something checks them. This script is
# that something: it runs in CI and fails the build when a layering rule is
# broken. A convention nobody checks is a convention nobody keeps.
#
# Usage: bash bin/check-architecture.sh

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  printf '\033[32mok\033[0m    %s\n' "$1"
}

# --- Principle 1: Engine/ is pure -------------------------------------------
# The engine is a port of TypeScript logic and must run against shared fixtures
# without a WordPress bootstrap. One get_option() call breaks that.
WP_FUNCS='get_option|update_option|delete_option|add_action|add_filter|apply_filters|do_action|wp_remote_|get_post|wc_get_|WC\(\)|\$wpdb|esc_html|esc_attr|__\('
if grep -rInE "(^|[^a-zA-Z_])(${WP_FUNCS})" src/Engine --include='*.php' \
     | grep -v 'defined( .ABSPATH. )' > /tmp/optionia_engine_hits 2>/dev/null; then
  if [ -s /tmp/optionia_engine_hits ]; then
    fail "src/Engine/ must not call WordPress functions (Principle 1):"
    sed 's/^/        /' /tmp/optionia_engine_hits
  else
    pass "src/Engine/ is free of WordPress calls"
  fi
else
  pass "src/Engine/ is free of WordPress calls"
fi

# --- Principle 2: one owner for outbound HTTP -------------------------------
HTTP_HITS=$(grep -rIln 'wp_remote_' src --include='*.php' | grep -v '^src/Api/' || true)
if [ -n "$HTTP_HITS" ]; then
  fail "wp_remote_* is only allowed in src/Api/ (Principle 2):"
  echo "$HTTP_HITS" | sed 's/^/        /'
else
  pass "outbound HTTP confined to src/Api/"
fi

# --- Principle 5: no float money -------------------------------------------
# Money must never be a float. Time, byte counts and ratios legitimately are,
# so the check targets money-shaped identifiers rather than every float cast.
FLOAT_HITS=$(grep -rInE '\(float\)|\(double\)|floatval' src --include='*.php' \
             | grep -v 'src/Support/Money.php' \
             | grep -iE 'price|amount|total|cost|money|delta|subtotal|fee' || true)
if [ -n "$FLOAT_HITS" ]; then
  fail "money must use Support\\Money, not floats (Principle 5):"
  echo "$FLOAT_HITS" | sed 's/^/        /'
else
  pass "no float used for money outside Support/Money.php"
fi

# --- Principle 2: logging has one owner ------------------------------------
LOG_HITS=$(grep -rInE 'error_log\(|var_dump\(|print_r\(|\bdie\(|\bexit;.*debug' src --include='*.php' \
           | grep -v 'src/Support/Logger.php' || true)
if [ -n "$LOG_HITS" ]; then
  fail "use Support\\Logger, not error_log/var_dump (Principle 2):"
  echo "$LOG_HITS" | sed 's/^/        /'
else
  pass "logging confined to Support/Logger.php"
fi

# --- Direct file access guard ----------------------------------------------
MISSING_GUARD=""
while IFS= read -r file; do
  if ! grep -q "defined( 'ABSPATH' )\|defined( 'WP_UNINSTALL_PLUGIN' )" "$file"; then
    MISSING_GUARD="${MISSING_GUARD}${file}\n"
  fi
done < <(find src templates -name '*.php' -type f 2>/dev/null)

if [ -n "$MISSING_GUARD" ]; then
  fail "every PHP file needs a direct-access guard:"
  printf "%b" "$MISSING_GUARD" | sed 's/^/        /'
else
  pass "all PHP files carry a direct-access guard"
fi

# --- Version consistency ---------------------------------------------------
HEADER_VERSION=$(grep -m1 '^ \* Version:' optionia.php | sed 's/.*Version: *//' | tr -d ' \r')
CONST_VERSION=$(grep -m1 "define( 'OPTIONIA_VERSION'" optionia.php | sed "s/.*'\\([0-9][^']*\\)'.*/\\1/")
if [ "$HEADER_VERSION" != "$CONST_VERSION" ]; then
  fail "plugin header version ($HEADER_VERSION) != OPTIONIA_VERSION ($CONST_VERSION)"
else
  pass "version consistent: $HEADER_VERSION"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d architecture check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll architecture checks passed.\033[0m\n'
