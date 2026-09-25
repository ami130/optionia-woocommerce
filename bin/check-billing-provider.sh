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
  | grep -v "^$BILLING/billing.module.ts$" \
  `# 📌 M23.4's worker replays a STORED event whose signature was already` \
  `# verified on the way in. It is unreachable from a browser, which is what` \
  `# this check protects: "reachable from the webhook path and from nothing` \
  `# that a browser can reach". It adds no new source of truth — the row it` \
  `# replays was written by the webhook path itself.` \
  | grep -v "^$BILLING/billing-event-retry.service.ts$" || true)

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

# --- 11. The checkout entrance exists and is reachable ----------------------
#
# 🔴 **H1: `createCheckout` was built, tested and called by nothing.** Every
# lifecycle handler downstream was waiting on `checkout.session.completed`, which
# can only fire for a session something creates — so the whole phase had no
# entrance. The gap was in the plan, not the code, which is exactly the kind a
# test suite cannot notice: each part worked, and none of them were connected to
# a user.
if grep -rq "createCheckout(" "$BILLING/checkout.service.ts" 2>/dev/null \
  && grep -q "@Post('checkout')" "$BILLING/checkout.controller.ts" 2>/dev/null; then
  pass "a merchant can start a checkout"
else
  fail "nothing reaches createCheckout — the billing flow has no entrance"
  printf '        checkout.session.completed cannot fire for a session nobody creates.\n'
fi

# --- 12. A checkout is guarded, and costs money to start --------------------
#
# ⚠️ Starting a payment commits the tenant to money; seeing what a plan costs
# does not. `BILLING_MANAGE` is the capability drawn for that distinction, and
# the throttle is because each call creates a session at the provider.
if grep -q "RequireCapability(Capability.BILLING_MANAGE)" "$BILLING/checkout.controller.ts" \
  && grep -q "@Throttle" "$BILLING/checkout.controller.ts"; then
  pass "checkout requires BILLING_MANAGE and is rate limited"
else
  fail "the checkout route lost its capability guard or its throttle"
fi

# --- 13. The currency a tenant is billed in is checked (F94/E4) -------------
#
# 🔴 Nothing checked that a tenant's `billingCurrency` agreed with the price it
# was sent to, so a tenant recorded as billing in EUR could be charged in USD —
# and every later total would mix two currencies in a column that stores no
# currency per amount.
# ⚠️ Matched on the CALL, not the definition: a rename touching both would leave
# a dead method and a passing grep, which is how the first version of this check
# survived its own mutation.
if grep -q "this.assertCurrencyAgrees(" "$BILLING/checkout.service.ts"; then
  pass "checkout refuses a price in the wrong currency"
else
  fail "nothing checks the tenant's billing currency against the price (F94/E4)"
fi

# --- 14. ADR-118's billing identity is actually populated -------------------
#
# ⚠️ ADR-118 says verbatim that `tenants.country`, `vatNumber` and
# `billingCurrency` are populated from the completed session. The adapter
# collects all three; the handler discarded them (H2), so a paying tenant's
# billing identity stayed null for ever.
if grep -q "await this.recordBillingIdentity(" "$LIFECYCLE"; then
  pass "a completed checkout records the tenant's billing identity (ADR-118)"
else
  fail "nothing populates tenants.country / vatNumber / billingCurrency"
  printf '        ADR-118 decided this; an unimplemented ADR is a decision nobody kept.\n'
fi

# --- 15. A plan change moves the plan (H3) ----------------------------------
#
# 🔴 The lifecycle wrote status and dates and left `planId` alone, so a merchant
# who upgraded was charged the new price and kept the **old plan's limits**,
# permanently. ADR-117's "limit raises apply at once" cannot work without this.
if grep -q "await this.adoptPlanFromPrice(" "$LIFECYCLE"; then
  pass "a subscription change moves planId and planPriceId"
else
  fail "the lifecycle no longer propagates the plan (H3)"
  printf '        An upgrade would charge the new price and keep the old limits.\n'
fi

# --- 16. The provider links are reproducible, not hand-typed ---------------
#
# 🔴 **K1: `plan_prices.providerPriceId` was populated by manual SQL** during
# sandbox verification, so the mapping existed in one database and nowhere in
# this repository. A fresh database — CI, a new machine, live mode — would have
# `NULL` in every row, which is exactly the state that makes checkout refuse to
# sell, and the first person to find out would be a merchant trying to pay.
#
# ⚠️ The script must also VERIFY, not just link (K2): nothing compared our
# `amountMinor` against the provider's `unit_amount`, so a dashboard edit would
# leave the pricing page showing one figure while the merchant is charged
# another, silently.
if grep -q "billing:link-prices" "optioniaWooCommerceBackend/package.json" \
  && grep -q "export async function reconcileProviderPrices" "$BILLING/provider-prices.ts"; then
  pass "provider price links are reproducible from a command"
else
  fail "nothing rebuilds plan_prices.providerPriceId (K1)"
  printf '        A fresh database cannot sell anything, and no script says why.\n'
fi

if grep -q "function disagreement(" "$BILLING/provider-prices.ts"; then
  pass "a provider price that disagrees with ours is refused, not linked"
else
  fail "nothing compares our amount against the provider's (K2)"
  printf '        A dashboard price edit would charge a figure our UI never showed.\n'
fi

# --- 17. Live mode cannot create products by accident ----------------------
#
# 📌 **A duplicate product in live is a support problem, not a rollback.** The
# default must be link-only when the key is live; creating requires typing
# `--create`, and live mode is detected from the KEY rather than `NODE_ENV` —
# a live key in a `.env` marked development is exactly the accident this guards.
if grep -q "sk_live_" "$SRC/seeds/link-provider-prices.ts"; then
  pass "live mode is detected from the key, not from NODE_ENV"
else
  fail "the price linker no longer distinguishes live keys"
fi

# --- 18. All four merchant verbs exist -------------------------------------
#
# 🔴 **Phase 22's exit criterion is four verbs** — *"a merchant subscribes,
# upgrades, downgrades, and cancels"* — and for a long while only the first had
# a route. `cancelSubscription` and `updatePlan` were built, tested, and called
# by nothing: H1's defect repeated, because I fixed the single instance for
# `createCheckout` without asking whether its siblings had it too.
ACCOUNT="$BILLING/checkout.controller.ts"
MISSING=""

for route in "@Post('checkout')" "@Get('subscription')" "@Get('invoices')" \
  "@Post('plan')" "@Delete('subscription')"; do
  grep -q "$route" "$ACCOUNT" || MISSING="$MISSING $route"
done

if [ -z "$MISSING" ]; then
  pass "a merchant can subscribe, see, upgrade, downgrade and cancel"
else
  fail "billing routes are missing:$MISSING"
  printf '        Phase 22 exits on four verbs; a built provider method with no route is not one.\n'
fi

# --- 19. The manage routes never write subscription state ------------------
#
# 🔴 **M22.4: `subscriptions` is updated ONLY from verified webhooks.** A cancel
# records intent at the provider and the webhook records the truth — writing the
# status here would create a second source that disagrees the moment a call
# succeeds and its webhook is delayed.
#
# ⚠️ `cancellationReason` is the one exception and is deliberately OURS: a reason
# in the provider's metadata is readable only from their dashboard.
if grep -n "subscriptions.update(" "$BILLING/billing-account.service.ts" \
  | grep -qv ':[0-9]*:\s*\*'; then
  if grep -A3 "subscriptions.update(" "$BILLING/billing-account.service.ts" \
    | grep -qE "status:|graceEndsAt:|planId:"; then
    fail "a merchant-facing route writes provider-owned subscription state"
    printf '        M22.4: only a verified webhook may move status, plan or grace.\n'
  else
    pass "the manage routes write only cancellationReason, never provider state"
  fi
else
  pass "the manage routes write no subscription state at all"
fi

# --- 20. A price edit supersedes; it never mutates ------------------------
#
# 🔴 **M22.1a's whole reason for existing.** If editing a plan's price changed
# the row a subscription points at, every merchant on that plan would be
# re-priced — including ones who signed up under different terms. The plan calls
# it *"the single most expensive thing to get wrong here"*, and the merchant
# discovers it on their card statement.
ADMIN="$SRC/plans/plans-admin.service.ts"

if grep -q "isCurrent: false" "$ADMIN" && grep -q "retiredAt: new Date()" "$ADMIN"; then
  pass "a price edit retires the old row and inserts a new one"
else
  fail "the plan admin service no longer supersedes prices (M22.1a)"
  printf '        Mutating a price row re-prices every existing subscriber on it.\n'
fi

# ⚠️ And the replacement must NOT inherit the provider id: that would sell the
# OLD amount while the dashboard showed the new one.
if grep -q "providerPriceId: null," "$ADMIN"; then
  pass "a superseding price starts unlinked from the provider"
else
  fail "a new price may inherit the old provider price id"
  printf '        The merchant would be charged the old amount at the new label.\n'
fi

# --- 21. Pricing belongs to platform staff, never a tenant ----------------
#
# 🔴 *"A tenant admin editing what they pay is not a feature, it is a
# vulnerability."* The admin routes take `StaffGuard` and deliberately NOT
# `TenantGuard` — and the guard fails closed on a route that declares no role,
# for the reason `CapabilityGuard` records from a probe that found a `viewer`
# publishing with a 200.
if grep -q "UseGuards(JwtAuthGuard, StaffGuard)" "$SRC/plans/plans-admin.controller.ts" \
  && grep -q "declares no required role" "$SRC/admin/staff.guard.ts"; then
  pass "plan pricing is behind the staff realm, and the guard fails closed"
else
  fail "the plan admin routes lost the staff guard, or it no longer fails closed"
fi

# --- 22. The merchant's remaining trial survives an upgrade ---------------
#
# 🔴 **Nothing passed a trial to the provider until M22.3.** A merchant ten days
# into a fourteen-day trial who upgraded was **charged that day**, losing four
# days they had been promised.
#
# ⚠️ An absolute `trial_end`, never `trial_period_days`: the second grants a
# FRESH fortnight to anyone who upgrades early, which is the opposite mistake.
if grep -q "trial_end: trialEnd" "$BILLING/stripe.provider.ts" \
  && grep -q "trialEndsAt: tenant.trialEndsAt" "$BILLING/checkout.service.ts"; then
  pass "a merchant's remaining trial is carried into checkout"
else
  fail "the trial no longer reaches the provider (M22.3)"
  printf '        A merchant upgrading mid-trial would be charged immediately.\n'
fi

if grep -q "trial_period_days" "$BILLING/stripe.provider.ts"; then
  fail "checkout sends trial_period_days, which grants a fresh trial"
  printf '        Use an absolute trial_end so the REMAINING trial is honoured.\n'
else
  pass "the trial is an absolute end, not a fresh period"
fi

# --- 23. Payment methods stay the provider's surface ----------------------
#
# 🔴 **Collecting card details here would put this service in PCI scope** for no
# benefit a merchant can see. The portal also carries invoice history, tax ids
# and cancellation — all of which the provider must agree with anyway.
if grep -q "billingPortal.sessions.create" "$BILLING/stripe.provider.ts" \
  && grep -q "@Post('portal')" "$BILLING/checkout.controller.ts"; then
  pass "payment methods are handled at the provider's portal"
else
  fail "the billing portal route is missing (M22.3/M22.5)"
fi

# --- 24. A claimed webhook that never finished must be retryable ----------
#
# 🔴 **N1: the provider's retries were consumed by our own idempotency check.**
# The event row is claimed *before* the handler runs, so a handler that threw
# left it claimed and unprocessed — and the retry then hit the duplicate branch,
# answered 200, and never ran the handler again. A merchant whose `invoice.paid`
# failed once stayed `past_due` for ever.
#
# ⚠️ Measured before it was fixed: a probe with a handler that failed once then
# succeeded showed it running exactly once.
WEBHOOK_SVC="$BILLING/billing-webhook.service.ts"

if grep -q "existing.processedAt !== null" "$WEBHOOK_SVC"; then
  pass "a claimed-but-unprocessed event is re-run, not skipped"
else
  fail "a failed webhook can no longer be recovered by a retry (N1)"
  printf '        The provider retries; answering \"already handled\" loses the event for ever.\n'
fi

# --- 25. invoice.paid is one transaction ----------------------------------
#
# 🔴 **N2: the invoice and the activation were separate commits.** A failure
# between them stored the receipt and left the merchant `past_due` — they had
# paid, we had the invoice, and they were locked out.
if grep -q "this.dataSource.transaction" "$LIFECYCLE"; then
  pass "a paid invoice and its activation commit together"
else
  fail "invoice.paid is no longer atomic (N2)"
  printf '        A crash between the two writes leaves a paid merchant locked out.\n'
fi

# --- 26. The window between paying and the provider confirming ------------
#
# 🔴 **Q1: the merchant who just paid was shown the plan they left.**
# `checkout.session.completed` deliberately does not set ACTIVE — that is
# `customer.subscription.updated`'s to say, moments later — so the success page
# lands in between and reads stale state.
if grep -q "settling:" "$BILLING/billing-account.service.ts"; then
  pass "the summary reports a checkout still settling"
else
  fail "nothing tells the dashboard a payment is still confirming (Q1)"
  printf '        The success page would show the plan the merchant just left.\n'
fi

# --- 27. The tax question ADR-115 commits us to answering -----------------
#
# 🔴 **Q3: `invoices` was written by the webhook and asked by nobody but a
# test.** Stripe Tax calculates and collects; *filing is ours*, and filing needs
# this answer.
#
# ⚠️ Grouped by currency as well as country: summing minor units across
# currencies produces a number that looks like money and is not.
if grep -q "GROUP BY taxCountry, currency" "$BILLING/tax-report.service.ts"; then
  pass "staff can answer what tax was collected, by country and currency"
else
  fail "the tax report is missing or no longer groups by currency (ADR-115)"
  printf '        100 cents and 100 pence are not 200 of anything.\n'
fi

# --- 28. ADR-116's dunning mail, sent once per lapse ----------------------
#
# 🔴 **ADR-116 promised it and there was none**: *"Grace: everything works, with
# a dashboard banner and dunning mail."* A merchant whose card failed got a
# fourteen-day clock and no notification, so the first they learned was
# authoring going read-only.
#
# ⚠️ **Once per LAPSE, not per failure.** Stripe's dunning fires
# `invoice.payment_failed` several times, and `MailService` has suppression but
# no dedupe — `graceEndsAt === null` is true exactly once per lapse, which is
# what makes four identical warnings impossible.
if grep -q "firstFailureOfThisLapse" "$LIFECYCLE" \
  && grep -q "notifier.paymentFailed" "$LIFECYCLE"; then
  pass "a failed payment mails the merchant once per lapse"
else
  fail "dunning mail is missing, or no longer deduped per lapse (ADR-116)"
  printf '        Four identical \"your payment failed\" emails read as a broken system.\n'
fi

# 🔴 Transactional, so an UNSUBSCRIBE suppression cannot silence a declined card.
if grep -q "'billing-payment-failed'" "$SRC/common/database/enums.ts"; then
  pass "dunning mail is transactional, so unsubscribing cannot silence it"
else
  fail "billing-payment-failed is not in TRANSACTIONAL_TEMPLATES"
  printf '        An unsubscribed merchant would never hear their card was declined.\n'
fi

# --- 29. M23.3's seven handlers, all of them reachable --------------------
#
# 🔴 **Four times in this phase a mechanism shipped without its trigger** —
# `createCheckout` (H1), `cancelSubscription` and `updatePlan` (F106), and
# `trialEnding` (V1): built, tested, and called by nothing. This lists the event
# names because a handler with no `case` is exactly that defect again.
MISSING_EVENTS=""

for event in "checkout.session.completed" "customer.subscription.created" \
  "customer.subscription.updated" "customer.subscription.deleted" \
  "customer.subscription.trial_will_end" "invoice.paid" \
  "invoice.payment_succeeded" "invoice.payment_failed"; do
  grep -q "case '$event'" "$LIFECYCLE" || MISSING_EVENTS="$MISSING_EVENTS $event"
done

if [ -z "$MISSING_EVENTS" ]; then
  pass "every lifecycle event M23.3 names has a handler"
else
  fail "lifecycle events with no handler:$MISSING_EVENTS"
  printf '        A notifier method with no case is a mechanism with no trigger.\n'
fi

# --- 30. The contract specs, which nothing enforced until F118 ------------
#
# 🔴 **F118 happened BECAUSE this check did not exist.** F96 found three Stripe
# fields relocated between API versions (`invoice.tax`→`total_taxes[]`,
# `paid_at`→`status_transitions.paid_at`, `invoice.subscription`→
# `parent.subscription_details.subscription`) and answered them with a contract
# spec: fixtures typed as real Stripe objects, so a rename **stops the build**.
#
# ⚠️ **Nothing made that mechanism spread, and nothing kept it alive.** The
# subscription lifecycle never got one, and a fourth field moved unnoticed —
# `current_period_end` off the subscription and onto the item — leaving
# `currentPeriodEnd` permanently null. Five merchant-visible behaviours broke on
# that one line: the settling notice never cleared, the renewal date never
# rendered, the cancellation notice fell back to generic text, and the dashboard
# hid BOTH the cancel section and the whole change-plan section.
#
# 📌 **Existence is not enough, so the type-level assertions are pinned too.** A
# file that survives with its assertions gutted is the same defect wearing the
# same filename.
CONTRACT_SUBSCRIPTION="$BILLING/subscription-lifecycle.contract.spec.ts"
CONTRACT_INVOICE="$BILLING/invoice.mapper.contract.spec.ts"

if [ -f "$CONTRACT_SUBSCRIPTION" ] && [ -f "$CONTRACT_INVOICE" ]; then
  pass "both Stripe contract specs are still present"
else
  fail "a Stripe contract spec is missing"
  printf '        F96 and F118 were four renamed fields caught only by typed fixtures.\n'
fi

# 🔴 The two aliases that make the X1 mistake a compile error rather than a null.
if grep -q "'current_period_end' extends keyof Stripe.Subscription" "$CONTRACT_SUBSCRIPTION" 2>/dev/null \
  && grep -q "'current_period_end' extends keyof Stripe.SubscriptionItem" "$CONTRACT_SUBSCRIPTION" 2>/dev/null; then
  pass "the period end is pinned to the item, and away from the subscription"
else
  fail "the F118 type assertions are gone from the subscription contract spec"
  printf '        Without them currentPeriodEnd can silently return to null.\n'
fi

# ⚠️ F96's three relocated fields, each pinned by the fixture that found it.
MISSING_FIELDS=""

for field in "total_taxes" "status_transitions" "parent"; do
  grep -q "$field" "$CONTRACT_INVOICE" 2>/dev/null || MISSING_FIELDS="$MISSING_FIELDS $field"
done

if [ -z "$MISSING_FIELDS" ]; then
  pass "every field F96 found relocated is still pinned by a typed fixture"
else
  fail "the invoice contract spec no longer pins:$MISSING_FIELDS"
  printf '        These moved once already; an untyped fixture would not notice again.\n'
fi

# --- 31. M23.5's reconciler, and its safety default -----------------------
#
# 🔴 **`getSubscription` was the FIFTH mechanism built and called by nothing** —
# after `createCheckout` (H1), `cancelSubscription` and `updatePlan` (F106), and
# `trialEnding` (V1/F117). M23.5 is what gives it a production caller, so a
# reconciler that stops calling it is that defect returning.
#
# ⚠️ **The safety default is the invariant most worth pinning.** Reporting is
# safe; repairing is not. A job that writes on every difference is one provider
# outage — or one bug in the comparison itself — away from rewriting every
# subscription in the database in a single pass. F91 set the principle: the
# provider is authoritative, and a difference is a **finding**.
RECONCILER="$BILLING/subscription-reconciler.service.ts"

if [ -f "$RECONCILER" ] && grep -q "provider.getSubscription" "$RECONCILER"; then
  pass "reconciliation gives getSubscription a production caller (M23.5)"
else
  fail "the reconciler is missing, or no longer calls getSubscription"
  printf '        Five mechanisms have now shipped without a caller; this is the fix.\n'
fi

# 🔴 `?? true` is the whole safety argument: writing must be opt-in.
if grep -q "options.dryRun ?? true" "$RECONCILER" 2>/dev/null; then
  pass "reconciliation reports by default and repairs only when asked"
else
  fail "the reconciler no longer defaults to a dry run"
  printf '        A provider outage would rewrite every subscription in one pass.\n'
fi

# ⚠️ A free tenant has no remote id; scanning it reports the whole table as drift.
if grep -q "provider: Not('none')" "$RECONCILER" 2>/dev/null \
  && grep -q "providerSubscriptionId: Not(IsNull())" "$RECONCILER" 2>/dev/null; then
  pass "reconciliation asks the provider only about linked subscriptions"
else
  fail "the reconciler no longer excludes free tenants"
  printf '        Every free merchant would be reported as drift, every run.\n'
fi

# 📌 The command is how a deployment runs it; M23.4 decides what triggers that.
if grep -q '"billing:reconcile"' optioniaWooCommerceBackend/package.json; then
  pass "reconciliation is runnable as a command"
else
  fail "npm run billing:reconcile is not registered"
  printf '        Logic with no entry point is a mechanism with no trigger.\n'
fi

# --- 32. F121: a plan change invalidates cached storefront config ----------
#
# 🔴 **No billing path bumped `configVersion` at all.** Every caller lived in
# `src/option-sets/` — publish, assignments, cascade, hard-delete — so a merchant
# who upgraded kept a stale config and read it as *"I paid and nothing
# happened"*, and one who downgraded kept serving higher-tier options.
#
# ⚠️ **M9.4b predicted this and assigned it to Phase 23.** Its trigger table says
# in bold *"Plan or subscription changed — 🔴 not covered… wire it in Phase 23"*,
# and F39 closed only the documentation overclaim, not the work. Phase 23 then
# built every subscription-state path without it.
#
# 📌 **BOTH paths are pinned, because that was F121's whole argument**: fixing
# the webhook and not the reconciler would leave one silently broken while the
# finding looked closed.
INVALIDATOR="$BILLING/plan-change-invalidator.service.ts"

if [ -f "$INVALIDATOR" ] && grep -q "configVersion.bump" "$INVALIDATOR"; then
  pass "a plan change has something to invalidate cached config with"
else
  fail "the plan-change invalidator is missing, or no longer bumps"
  printf '        A merchant who upgrades would wait out the cron for their plan.\n'
fi

MISSING_INVALIDATION=""

for path in "$LIFECYCLE" "$BILLING/subscription-reconciler.service.ts"; do
  grep -q "invalidator.invalidate" "$path" 2>/dev/null \
    || MISSING_INVALIDATION="$MISSING_INVALIDATION $(basename "$path")"
done

if [ -z "$MISSING_INVALIDATION" ]; then
  pass "every path that moves a plan invalidates cached config (F121)"
else
  fail "these move a plan without invalidating config:$MISSING_INVALIDATION"
  printf '        Fixing one path and not the other is how this stayed open.\n'
fi

# 🔴 Best-effort inside, so a store bookkeeping problem cannot fail a webhook.
if grep -q "catch (error)" "$INVALIDATOR" 2>/dev/null; then
  pass "an unbumpable store cannot fail the webhook that moved the plan"
else
  fail "the invalidator no longer tolerates a store it cannot bump"
  printf '        bump() throws to roll back a publish; a webhook must not die of it.\n'
fi

# --- 33. M23.4: retry, and the point at which it gives up ------------------
#
# 🔴 **Stripe's retries and ours must not fight.** Stripe redelivers a non-2xx
# for days on its own schedule; the worker exists for the case Stripe will NOT
# retry — a row we answered 200 to and then failed to finish. N1 exists because
# our own idempotency check once *consumed* Stripe's retries.
RETRY="$BILLING/billing-event-retry.service.ts"

if [ -f "$RETRY" ] && grep -q "deadAt" "$RETRY"; then
  pass "failed billing events are retried and eventually dead-lettered (M23.4)"
else
  fail "the billing retry worker is missing, or no longer dead-letters"
  printf '        A deterministic failure would be re-run every cycle for ever.\n'
fi

# 🔴 The three conditions that define "retryable"; each is load-bearing.
MISSING_GUARDS=""

for guard in "processedAt: IsNull()" "deadAt: IsNull()" "createdAt: LessThan"; do
  grep -q "$guard" "$RETRY" 2>/dev/null || MISSING_GUARDS="$MISSING_GUARDS '$guard'"
done

if [ -z "$MISSING_GUARDS" ]; then
  pass "the retry query excludes finished, dead and in-flight events"
else
  fail "the retry query no longer guards on:$MISSING_GUARDS"
  printf '        Dropping any one re-runs dead rows or races a live request.\n'
fi

# ⚠️ In-process, so every instance that enables it walks the same rows.
if grep -q "BILLING_RETRY_ENABLED" "$BILLING/billing-event-retry.scheduler.ts" 2>/dev/null; then
  pass "the retry scheduler is off unless a deployment enables it"
else
  fail "the retry scheduler no longer checks BILLING_RETRY_ENABLED"
  printf '        Every instance and every test suite would retry the same rows.\n'
fi

# 🔴 v12 is pure ESM; this project is CommonJS and Jest cannot parse it.
if grep -qE '"@nestjs/schedule": "\^?6\.' optioniaWooCommerceBackend/package.json; then
  pass "@nestjs/schedule stays on the CommonJS 6.x line"
else
  fail "@nestjs/schedule is no longer pinned to 6.x"
  printf '        v12 is ESM-only: every suite loading the scheduler fails to run.\n'
fi

# --- 34. The two dormant mechanisms are on the launch checklist ------------
#
# 🔴 **M23.4's worker and M23.5's reconciler are invoked by NOTHING.** Both are
# built, tested and mutation-proven; neither has a cron entry, and
# `BILLING_RETRY_ENABLED` is set nowhere. That is correct today — there is no
# deployment to attach them to — and it is the **sixth and seventh** instance of
# the defect this phase produced five times already: a mechanism with no caller.
#
# ⚠️ **A checklist line is prose, and prose does not fail a build.** This is the
# nearest thing to enforcement available before a deployment exists: the items
# cannot be quietly dropped from GATE 3 without failing here.
CHECKLIST_MISSING=""

for item in "BILLING_RETRY_ENABLED=true on EXACTLY ONE instance" \
  "billing:reconcile\` scheduled" \
  "Dead-lettered billing events visible"; do
  grep -qF "$item" developePlan.md || CHECKLIST_MISSING="$CHECKLIST_MISSING|$item"
done

if [ -z "$CHECKLIST_MISSING" ]; then
  pass "the dormant billing mechanisms are on the launch checklist"
else
  fail "GATE 3 no longer requires:$CHECKLIST_MISSING"
  printf '        Built, tested, and invoked by nothing is how five of these shipped.\n'
fi

# --- 35. F92/D4: every invoice status is one the reporting query counts ----
#
# 🔴 **`invoices.status` is `varchar(20)`, not a database enum.** F92/D4 called
# it *"an enum written as prose"*: the tax report filters `status = 'paid'`, so
# an adapter writing `Paid` or `succeeded` would silently drop rows from a tax
# total — a return that does not reconcile against the bank.
#
# ✅ **The mapper closes it at runtime** by rejecting an unrecognised status
# before it reaches the database, and it is the only writer of these rows.
#
# ⚠️ **What stays open is a FUTURE writer that bypasses the mapper**, which a
# column type cannot prevent either — `varchar(20)` accepts `Paid` just as
# happily. So the guard that matters is the rejection itself, pinned here.
if grep -q "KNOWN_STATUSES" "$BILLING/invoice.mapper.ts" \
  && grep -q "unknown invoice status" "$BILLING/invoice.mapper.ts"; then
  pass "an unrecognised invoice status is refused, not stored (F92/D4)"
else
  fail "the invoice mapper no longer refuses an unknown status"
  printf '        The tax report filters status = paid; a stray spelling drops rows.\n'
fi

# 🔴 F92/D2: the arithmetic invariant lives in the schema, not a docblock.
if grep -rq "ck_invoices_totals" "$SRC/migrations"; then
  pass "subtotal + tax = total is enforced by the database (F92/D2)"
else
  fail "the ck_invoices_totals CHECK constraint is gone"
  printf '        This caught a wrong fixture in its own test suite once already.\n'
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d billing provider check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll billing provider checks passed.\033[0m\n'
