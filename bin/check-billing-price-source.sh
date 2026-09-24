#!/usr/bin/env bash
#
# One source of truth for what a merchant is charged.
#
# ## Why this exists
#
# Phase 22 step 1 created `plan_prices` — immutable price versions a subscription
# pins to — while `plans.priceMonthlyMinor` and `plans.priceYearlyMinor` stayed
# in place. That is **two money representations for one price**, and the
# migration's own docblock had argued against exactly that one table over:
# *"two money representations are how rounding disagreements start."*
#
# Step 2a settled it. `plan_prices` is what a signup reads and what a
# subscription is charged against; the columns on `plans` are the **seed's
# declaration of intent** and what a pricing page may display.
#
# 🔴 **They were not dropped, and this gate is the reason that is safe.** A
# migration removing them in the same step that first populated their
# replacement would be one change doing two jobs. What makes leaving them
# honest is proving nothing in a billing path reads them — which is a grep, and
# cheaper than a migration that cannot be undone once a live subscription
# depends on it.
#
# ⚠️ **The failure this catches is silent.** A future `checkout()` that reads
# `plan.priceMonthlyMinor` would charge the plan's *current* figure rather than
# the version the merchant bought — re-pricing an existing subscriber, which is
# the defect `plan_prices` exists to prevent. Nothing in TypeScript stops it:
# both are numbers on an entity that is already in scope.

set -uo pipefail

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

SRC="optioniaWooCommerceBackend/src"

printf 'Checking the billing price source…\n'

# --- 1. Only the seed and the entity may name the plan's own price columns ----
#
# `plan-price.entity.ts` names them in prose, explaining why a row per interval
# beats two columns on one row. Prose is allowed; a read is not.
READERS=$(grep -rln "priceMonthlyMinor\|priceYearlyMinor" "$SRC" --include="*.ts" \
  | grep -v "/migrations/" \
  | grep -v "\.spec\.ts$" \
  | grep -v "^$SRC/seeds/plans.seed.ts$" \
  | grep -v "^$SRC/plans/entities/plan.entity.ts$" \
  | grep -v "^$SRC/plans/entities/plan-price.entity.ts$" || true)

if [ -z "$READERS" ]; then
  pass "no billing path reads plans.priceMonthlyMinor or priceYearlyMinor"
else
  fail "these read the plan's own price columns instead of plan_prices:"
  printf '        %s\n' $READERS
  printf '        A subscription is charged its PINNED price (plan_prices), not the plan.\n'
fi

# --- 2. The replacement is actually wired ------------------------------------
#
# The inverse check: a gate that only forbids the old path would pass on a
# system where neither path exists, which is how "absent code has nothing to
# mutate" ships green.
if grep -rq "PlanPrice" "$SRC/tenants/tenant-provisioning.service.ts"; then
  pass "provisioning pins a subscription to a plan_prices row"
else
  fail "provisioning no longer reads PlanPrice — a subscription with no pinned price re-prices itself"
fi

# --- 3. The pin itself is still on the subscription --------------------------
if grep -q "planPriceId" "$SRC/subscriptions/entities/subscription.entity.ts"; then
  pass "subscriptions still carry planPriceId"
else
  fail "subscriptions.planPriceId is gone — nothing records what a merchant bought"
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d billing price-source check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll billing price-source checks passed.\033[0m\n'
