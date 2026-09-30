#!/usr/bin/env bash
#
# The screen and the routes agree on who is staff.
#
# ## Why this exists
#
# 🔴 **Two places decide whether a user is platform staff**, and they must give
# the same answer. `StaffGuard` authorises every `/admin` route; `/auth/me`
# reports `staff` so the dashboard knows whether to render the group at all.
#
# ⚠️ **If they diverge, the failure is a dashboard that lies.** Reporting staff
# where the guard refuses gives a merchant buttons that always `403`; refusing
# where the guard allows hides a screen from someone entitled to it. The first is
# worse and neither is visible in a test of either half alone.
#
# 📌 **A gate rather than a refactor.** The guard reads through TypeORM and the
# profile through raw SQL — different spellings of one predicate, which is this
# project's most-repeated defect shape (the Design Lab's `1.25`, the
# `'month' | 'year'` triple). Collapsing them would mean rewriting a working auth
# guard to share a helper; asserting they still match is cheaper and catches the
# same drift.
set -euo pipefail

printf '\033[1m== check-staff-identity.sh ==\033[0m\n'
printf 'Checking that staff identity is decided one way…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/optioniaWooCommerceBackend/src"
GUARD="$SRC/admin/staff.guard.ts"
PROFILE="$SRC/auth/auth.service.ts"

# Comments stripped first: both files EXPLAIN the predicate at length, and prose
# describing a rule must never satisfy a check that the rule is applied.
strip_comments() {
  perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g;' "$1"
}

for f in "$GUARD" "$PROFILE"; do
  if [ ! -f "$f" ]; then
    fail "$(basename "$f") is missing — this gate is checking nothing"
    exit 1
  fi
done

# 1. The guard still excludes revoked grants.
if strip_comments "$GUARD" | grep -qE 'revokedAt:\s*IsNull\(\)'; then
  pass "StaffGuard excludes a revoked grant"
else
  fail "StaffGuard no longer filters on revokedAt — a revoked staff member would keep access"
fi

# 2. The profile does too, and reads it LIVE rather than from token claims.
if strip_comments "$PROFILE" | grep -qE 'FROM platform_staff WHERE userId = \? AND revokedAt IS NULL'; then
  pass "the profile excludes a revoked grant, read live"
else
  fail "/auth/me no longer filters on revokedAt — the admin group would outlive a revocation"
fi

# 3. Neither reads staff identity from the JWT.
#
# 🔴 A claim minted before a revocation would keep working until the token
# expired, which is the whole reason both read the table.
if strip_comments "$PROFILE" | grep -qE "claims\.(staff|role)\b.*staff|staff.*claims\."; then
  fail "the profile reads staff identity from token claims — a revocation would not take effect"
else
  pass "staff identity comes from the table, never from a token claim"
fi

# 4. The dashboard treats it as presence, not as a truthy role string.
#
# ⚠️ `me.staff` is an OBJECT or null. A client testing `me.staff === true` or
# reading `me.isStaff` would silently never show the group.
GUARDS="$ROOT/optioniaWooCommerceFrontend/src/components/layout/route-guards.tsx"
if [ -f "$GUARDS" ] && strip_comments "$GUARDS" | grep -qE 'me\?\.staff\s*!=\s*null'; then
  pass "the dashboard tests staff by presence, as the API reports it"
else
  fail "route-guards does not test me.staff for presence — the admin group may never render"
fi

# 5. The dashboard's discount ceiling matches the API's.
#
# 🔴 **Two numbers, two languages, one rule.** The backend refuses a discount
# above 9999 basis points; the form validated `< 100` PERCENT, so 99.995% passed
# the client, rounded to 10000 and was refused by the server — a form saying yes
# where the server says no. Both now express the ceiling in basis points, and
# this asserts they still agree.
BACKEND_MAX=$(strip_comments "$SRC/plans/plan-discount.ts" \
  | grep -oE 'FULL_DISCOUNT_BASIS_POINTS = 10_000' | head -1)
FRONT_MAX=$(strip_comments "$ROOT/optioniaWooCommerceFrontend/src/lib/admin/api.ts" \
  | grep -oE 'MAX_DISCOUNT_BASIS_POINTS = 9_999' | head -1)

if [ -n "$BACKEND_MAX" ] && [ -n "$FRONT_MAX" ]; then
  pass "the dashboard's discount ceiling matches the API's (9999 bp)"
else
  fail "the discount ceiling disagrees between the API and the dashboard"
  printf '        backend: %s\n' "${BACKEND_MAX:-<not found>}"
  printf '        dashboard: %s\n' "${FRONT_MAX:-<not found>}"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d staff-identity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll staff-identity checks passed.\033[0m\n'
