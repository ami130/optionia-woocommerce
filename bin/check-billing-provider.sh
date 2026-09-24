#!/usr/bin/env bash
#
# The billing provider's wiring: the API pin, the null contract, the config.
#
# ## Why this exists
#
# 🔴 **Every invariant here was a comment first, and the comment was wrong.**
# Phase 22 step C produced three findings of the same shape, which is the shape
# this whole phase keeps producing: a guarantee asserted in prose while nothing
# enforced it.
#
#   - F94/E3 — the adapter's docblock claimed the Stripe API version was pinned.
#     Nothing pinned it; the library's default applied.
#   - G1 — `BILLING_PROVIDER` was a config field documented as *"which provider
#     to bind"* that **nothing read**, whose name also collided with the DI
#     token of the same name.
#   - G2 — the module asserted *"callers must handle `null`; the token's type
#     says so."* An injection token is a bare symbol and carries no type at all.
#
# ⚠️ **Unit tests cover each of these, and a grep is still worth having**,
# because the failure mode is re-introduction rather than regression: a future
# `@Inject(BILLING_PROVIDER)` in a new controller compiles, passes every existing
# test, and holds `null` in production. Nothing in the type system objects. This
# gate reads the source the way a reviewer would.

set -uo pipefail

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

SRC="optioniaWooCommerceBackend/src"
BILLING="$SRC/billing"

printf 'Checking the billing provider wiring…\n'

# --- 1. The API version is a literal, not an environment read ----------------
#
# 🔴 A version an operator can change from `.env` is not pinned: it is a billing
# change with no diff and no review. Stripe ships breaking changes behind dated
# versions, so the pin must be a code edit someone reviews.
if grep -q "^export const STRIPE_API_VERSION = '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}" \
  "$BILLING/billing.module.ts"; then
  pass "the Stripe API version is pinned to a dated literal"
else
  fail "STRIPE_API_VERSION is not a dated literal in billing.module.ts"
  printf '        A pin that is computed, or read from the environment, is not a pin.\n'
fi

# ⚠️ **Prose is allowed; a read is not.** `env.ts` explains at length why the
# version is NOT configurable, so matching the bare word finds the explanation
# and calls it a violation — which is what the first version of this check did.
# Only a real config member counts: `apiVersion:` or a read of the variable.
if grep -n "apiVersion\s*:\|process\.env\[\?['\"]\?STRIPE_API_VERSION" "$SRC/config/env.ts" \
  | grep -vq '^[0-9]*:\s*\*'; then
  fail "the API version is reachable from configuration"
  printf '        It belongs in billing.module.ts, where changing it leaves a reviewable diff.\n'
else
  pass "no environment variable can move the API version"
fi

# --- 2. The client is constructed through the pinned path only ---------------
#
# ⚠️ `new Stripe(...)` anywhere but the factory inherits the library's default,
# which *today* equals the pin — so the mistake is invisible until the two
# diverge, and then it is a silent billing change. This is the mutation that
# survived the first attempt at a test (F95).
STRAY=$(grep -rln "new Stripe(" "$SRC" --include="*.ts" \
  | grep -v "\.spec\.ts$" \
  | grep -v "^$BILLING/billing.module.ts$" || true)

if [ -z "$STRAY" ]; then
  pass "every Stripe client is built through the pinned factory"
else
  fail "these construct a Stripe client outside the pinned factory:"
  printf '        %s\n' $STRAY
  printf '        Use createStripeClient(), or the API version silently follows the library.\n'
fi

# --- 3. Nobody injects the token directly ------------------------------------
#
# 🔴 The token resolves to `BillingProvider | null`. A bare symbol cannot say so,
# so `@Inject(BILLING_PROVIDER) private p: BillingProvider` compiles and then
# holds `null` at runtime — a crash inside a checkout handler. Consumers go
# through `requireBillingProvider`, which is a signature the compiler checks.
# ⚠️ **Prose again.** Both billing files *mention* `@Inject(BILLING_PROVIDER)` in
# docblocks warning against it, so matching the bare text reported two consumers
# where there are none — the second time in this one gate that a check passed by
# reading its own explanation. A real decorator is followed by a parameter
# declaration on the same line or the next; a comment line starts with `*`.
DIRECT=$(grep -rn "@Inject(BILLING_PROVIDER)" "$SRC" --include="*.ts" \
  | grep -v "\.spec\.ts:" \
  | grep -v ':[0-9]*:\s*\*' \
  | cut -d: -f1 | sort -u || true)

for file in $DIRECT; do
  if ! grep -q "BillingProviderOrNull" "$file"; then
    fail "$file injects BILLING_PROVIDER without the nullable type"
    printf '        Inject BillingProviderOrNull and unwrap with requireBillingProvider().\n'
  fi
done

# 📌 Said plainly when there are none, rather than reporting that every member
# of an empty set complies — a vacuous pass reads like coverage and is not.
if [ -z "$DIRECT" ]; then
  pass "no consumer injects the provider token yet (nothing to check)"
else
  pass "every consumer injecting the token uses the nullable type"
fi

# --- 4. The unwrap helper still exists ---------------------------------------
#
# The inverse check. A gate that only forbids the unsafe form passes on a system
# where the safe form was deleted — which is how "absent code has nothing to
# mutate" ships green.
if grep -q "export function requireBillingProvider" "$BILLING/billing-provider.ts"; then
  pass "requireBillingProvider is the sanctioned unwrap"
else
  fail "requireBillingProvider is gone — nothing turns the nullable token into a usable provider"
fi

# --- 5. The mapper's columns are tied to the entity --------------------------
#
# ⚠️ G4: `MappedInvoice` and the `Invoice` entity drifted freely. TypeORM ignores
# unrecognised keys on `create()`, so a renamed column produced no error — the
# mapper simply stopped filling it. `Pick<Invoice, ...>` makes a rename a build
# failure instead.
if grep -q "MappedInvoiceColumns = Pick<" "$BILLING/invoice.mapper.ts"; then
  pass "the mapper's columns are Pick'd from the Invoice entity"
else
  fail "MappedInvoiceColumns no longer derives from the Invoice entity"
  printf '        A hand-listed shape drifts silently: TypeORM drops keys it does not recognise.\n'
fi

# --- 6. The raw body is preserved, in production AND in the harness ----------
#
# 🔴 **A Stripe signature is over the bytes Stripe sent.** Without
# `rawBody: true` the global JSON parser consumes them, `req.rawBody` is
# undefined, and every webhook fails verification for a reason that reads like a
# wrong secret.
#
# ⚠️ **Both files, because the harness has diverged from `main.ts` twice before**
# — on compression and on the body limit, each time making a real difference
# untestable until a confusing failure exposed it. A harness missing this flag
# would let the webhook suite pass against an app that keeps no raw body at all.
# 📌 **Comment lines excluded — for the third time in this one gate.** Both files
# explain `rawBody: true` at length in a docblock, so the bare string matches the
# explanation and the check passes with the flag deleted. A mutation removing it
# from the harness proved exactly that.
for file in "$SRC/main.ts" "optioniaWooCommerceBackend/test/harness.ts"; do
  if grep -n "rawBody: true" "$file" | grep -vq '^[0-9]*:\s*\*'; then
    pass "$(basename "$file") preserves the raw request body"
  else
    fail "$(basename "$file") does not set rawBody: true"
    printf '        Stripe signatures are computed over exact bytes; a parsed body cannot verify.\n'
  fi
done

# --- 7. The webhook route stays public and unthrottled -----------------------
#
# ⚠️ Authentication is global with `@Public()` opt-out, so losing the decorator
# makes this route answer 401 to Stripe — an outage that looks like a Stripe
# problem. And a throttled webhook is worse than it sounds: every rejected event
# is retried, so the backlog that tripped the limit grows.
WEBHOOK="$BILLING/billing-webhook.controller.ts"

if grep -q "^@Public()" "$WEBHOOK" && grep -q "^@SkipThrottle()" "$WEBHOOK"; then
  pass "the webhook route is public and exempt from the throttler"
else
  fail "the webhook controller lost @Public() or @SkipThrottle()"
  printf '        Stripe sends no bearer token, and retries everything it cannot deliver.\n'
fi

# --- 8. Idempotency is the database's job, not a read-then-write -------------
#
# 🔴 Stripe delivers the same event concurrently. A `SELECT` before the `INSERT`
# races: both see no row, both insert. `uq_billing_events_provider_event` is what
# actually decides, and the loser must read the violation as "already handled".
if grep -q "ER_DUP_ENTRY" "$BILLING/billing-webhook.service.ts"; then
  pass "redelivery is settled by the unique index"
else
  fail "the webhook service no longer treats a duplicate key as 'already handled'"
  printf '        A check-then-write cannot survive concurrent redelivery.\n'
fi

# --- 9. Subscription state comes from webhooks, never from a redirect --------
#
# 🔴 **A merchant who closes the tab after paying must still end up subscribed,
# and one who forges a return URL must not.** The browser is a hint; the webhook
# is the fact. The lifecycle service must therefore be reachable from the webhook
# path and from nothing that a browser can reach.
LIFECYCLE="$BILLING/subscription-lifecycle.service.ts"

CALLERS=$(grep -rn "lifecycle.apply(\|SubscriptionLifecycleService" "$SRC" --include="*.ts" \
  | grep -v "\.spec\.ts:" \
  | grep -v ':[0-9]*:\s*\*' \
  | cut -d: -f1 | sort -u \
  | grep -v "^$LIFECYCLE$" \
  | grep -v "^$BILLING/billing-webhook.service.ts$" \
  | grep -v "^$BILLING/billing.module.ts$" || true)

if [ -z "$CALLERS" ]; then
  pass "subscription state is driven by webhooks alone"
else
  fail "these reach the subscription lifecycle outside the webhook path:"
  printf '        %s\n' $CALLERS
  printf '        A redirect can be forged; a signed webhook cannot.\n'
fi

# --- 10. The grace period is ADR-116's fourteen days ------------------------
#
# ⚠️ ADR-116 is a commitment to merchants, not a tunable: fourteen days of grace,
# then read-only authoring, and the storefront never goes dark. A silent change
# here shortens the runway of every merchant whose card expires.
if grep -q "^export const GRACE_DAYS = 14;" "$LIFECYCLE"; then
  pass "the grace period is ADR-116's fourteen days"
else
  fail "GRACE_DAYS no longer matches ADR-116"
  printf '        Changing it is a policy decision; amend the ADR in the same commit.\n'
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d billing provider check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll billing provider checks passed.\033[0m\n'
