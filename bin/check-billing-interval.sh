#!/usr/bin/env bash
#
# WooCommerce sells YEARLY only, and every purchase path enforces it.
#
# ## Why this is a gate
#
# 🔴 **Before this rule existed, `isCurrent` was the only gate on a price row.**
# A monthly row left by an earlier seed was purchasable: a merchant could
# subscribe and be billed monthly forever, with nothing failing, no error, and no
# test noticing. The product decision — *"in woocommerce there will be no
# monthly"* — was written down and enforced nowhere.
#
# ⚠️ **The rule is easy to half-apply**, which is what makes it worth gating.
# Guarding checkout alone leaves `changePlan` open, and a plan CHANGE is a
# purchase: a merchant could move themselves onto monthly after signing up
# yearly. Both paths are checked here, by name.
#
# 📌 **`month` remains a legal STORED value and that is deliberate.** A
# subscription pinned to a monthly price must keep resolving and its invoices
# must keep rendering — history is not rewritten by a change in what we sell
# today. This gate asserts what may be BOUGHT, never what may be read.
set -euo pipefail

printf '\033[1m== check-billing-interval.sh ==\033[0m\n'
printf 'Checking that only sellable intervals can be purchased…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/optioniaWooCommerceBackend/src"
VOCAB="$SRC/plans/billing-interval.ts"

if [ ! -f "$VOCAB" ]; then
  fail "the interval vocabulary is missing — this gate is checking nothing"
  exit 1
fi

# 1. The decision exists in exactly one place.
if grep -qE "^export const SELLABLE_INTERVALS = \['year'\]" "$VOCAB"; then
  pass "the sellable set is declared once, and it is yearly"
else
  fail "SELLABLE_INTERVALS is not the single yearly declaration this gate expects"
fi

# 2. Every purchase path consults it.
#    ⚠️ Comments are stripped first. This project's recurring gate defect is
#    reading documentation instead of code — a prose mention of the rule must
#    never satisfy a check that the rule is applied.
strip_comments() {
  perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g;' "$1"
}

# ⚠️ **Every path that puts a merchant on a price, not only the two obvious
# ones.** This list held checkout and changePlan; the discount route validates
# the interval too, in the DTO and again in the service, but the gate meant to
# stop that rule regressing was not watching it. Removing the service check would
# have left this green.
PURCHASE_PATHS="billing/checkout.service.ts
billing/billing-account.service.ts
plans/plans-admin.service.ts"

GUARDED=0
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  f="$SRC/$rel"
  if [ ! -f "$f" ]; then
    fail "$rel does not exist — this gate's path list is stale"
    continue
  fi
  # 🔴 **A CALL, not a mention.** The first version grepped for the identifier
  # anywhere in the file — which an unused `import { isSellableInterval }`
  # satisfies. Deleting the guard while leaving the import passed the gate, so
  # the check proved only that someone had once intended to use it. Requiring
  # `isSellableInterval(` with an argument is what makes it a rule.
  if strip_comments "$f" | grep -qE '!isSellableInterval\([a-zA-Z_.]+\)'; then
    GUARDED=$((GUARDED + 1))
  else
    fail "$rel does not check isSellableInterval — that path can sell any interval"
  fi
done <<EOF
$PURCHASE_PATHS
EOF

if [ "$GUARDED" -eq 0 ]; then
  fail "checked no purchase paths at all — the parser is wrong, not the code"
elif [ "$FAILURES" -eq 0 ]; then
  pass "all $GUARDED purchase path(s) refuse an unsellable interval"
fi

# 3. Nothing hardcodes an interval any more. The three spellings this replaced
#    ('month' | 'year' as an enum, a validator and a hand-written if) are the
#    defect class this prevents recurring.
# ⚠️ **Comments stripped, and the vocabulary file itself excluded.** The first
# run of this check reported three hits and ALL THREE were false: two were
# PROSE describing the defect being prevented, and one was
# `BILLING_INTERVALS`'s own legitimate declaration — the read vocabulary, which
# must contain 'month' so historical rows resolve. A rule that flags the file
# defining it, and the comments explaining it, is a rule that gets deleted.
HARDCODED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.spec.ts) continue ;;
    */plans/billing-interval.ts) continue ;;
  esac
  hits=$(strip_comments "$f" \
    | grep -nE "interval: 'month'|interval !== 'month'|\['month', 'year'\]" || true)
  if [ -n "$hits" ]; then
    rel="${f#"$SRC/"}"
    HARDCODED="$HARDCODED$(printf '%s' "$hits" | sed "s|^|  $rel:|")
"
  fi
done <<EOF
$(find "$SRC" -name '*.ts' -type f)
EOF

if [ -n "$HARDCODED" ]; then
  fail "hardcoded interval literal(s) outside the vocabulary:"
  printf '%s\n' "$HARDCODED" | sed 's|^|      |'
  printf '        read SELLABLE_INTERVALS / DEFAULT_SELLABLE_INTERVAL instead\n'
else
  pass "no purchase path hardcodes an interval"
fi

# 4. Nothing outside the purchase paths can put a merchant on an unsellable
#    interval WITHOUT someone finding out.
#
# 🔴 **The webhook adopts whatever Stripe reports, and that is correct** — it
# records what a merchant is actually billed rather than what we would have sold
# them, so refusing would make our database disagree with reality rather than
# stop the billing. A subscription created in Stripe's own dashboard therefore
# reaches an unsellable interval legitimately, and until the reconciler check
# existed nothing anywhere would have said so.
RECONCILER="$SRC/billing/subscription-reconciler.service.ts"
if strip_comments "$RECONCILER" | grep -qE '!isSellableInterval\([a-zA-Z_.]+\)'; then
  pass "the reconciler reports a subscription billing at an unsellable interval"
else
  fail "the reconciler does not detect an unsellable interval — a dashboard-created subscription would be silent"
fi

# 5. The seed writes only sellable rows.
SEED="$SRC/seeds/plans.seed.ts"
# Likewise a USE, not an import: the seed must actually map over the vocabulary.
if strip_comments "$SEED" | grep -qE 'SELLABLE_INTERVALS\.map|of SELLABLE_INTERVALS'; then
  pass "the seed writes only sellable intervals"
else
  fail "the seed does not read SELLABLE_INTERVALS — it may create unbuyable rows"
fi

# 6. Provisioning pins to a sellable interval.
#    🔴 This was the quiet hazard: provisioning looked up `interval: 'month'` by
#    hand, and the price pin tolerates null BY DESIGN — so retiring the monthly
#    rows would have left every new signup with no pin, no error and no failure.
PROV="$SRC/tenants/tenant-provisioning.service.ts"
# And a USE as the queried value, not merely an imported name.
if strip_comments "$PROV" | grep -qE 'interval: DEFAULT_SELLABLE_INTERVAL'; then
  pass "provisioning pins new tenants to a sellable interval"
else
  fail "provisioning does not read DEFAULT_SELLABLE_INTERVAL — new signups may lose their price pin"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d billing-interval check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll billing-interval checks passed.\033[0m\n'
