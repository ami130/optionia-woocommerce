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

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d billing provider check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll billing provider checks passed.\033[0m\n'
