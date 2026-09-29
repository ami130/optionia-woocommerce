#!/usr/bin/env bash
#
# Every e2e suite removes the rows it creates.
#
# ## Why this exists
#
# 🔴 **This defect class has now recurred FIVE times**, and every previous fix
# was applied one suite at a time with nothing left behind to catch the next.
# `cleanup-tenants.ts` records three of them in its own docblock — *"Three
# suites had the same defect and were fixed one at a time. This exists so the
# fourth does not"* — and then there was a fourth (`billing-webhook`, which
# orphaned its `@dunning.test` users) and a fifth (`rate-limit`, which deleted
# tenants by a name its own registration never set).
#
# The cost is not tidiness. The test database reached **6,900 tenants** once,
# and the added latency turned other suites' fixture creates into intermittent
# 404s that moved between tests, never reproduced in isolation, and were chased
# through three wrong theories across two audits. A second occurrence reached 73
# tenants, 126 users and 86 orphaned users before anyone counted.
#
# 📌 **A note asking a human to remember is not a mechanism.** That is the
# lesson `check-ledger.sh` opens with, and it applies exactly here.
#
# ## What is checked
#
# **Not** whether a suite's teardown is complete — only a run can show that, and
# the run already does. What is checked are the two shapes that have actually
# produced a leak:
#
#   1. Deleting tenants by `name`, which the suite does not control. Registration
#      names a tenant from the request payload, so a suite passing `name: 'x'`
#      creates a tenant called `x` that no namespace match will ever find.
#   2. Deleting `tenant_members` by hand *before* the tenants they point at,
#      which destroys the only link between a tenant and the suite that made it.
#      `deleteTenantsFor` exists precisely because it reads memberships first.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTS="$ROOT/optioniaWooCommerceBackend/test"

printf '\033[1m== check-test-teardown.sh ==\033[0m\n'
printf 'Checking e2e teardown hygiene...\n'

if [ ! -d "$TESTS" ]; then
  fail "missing: optioniaWooCommerceBackend/test"
  printf '\n\033[31m1 teardown check failed.\033[0m\n'
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Tenants are never deleted by a name the suite does not control.
# ---------------------------------------------------------------------------
# Matches the statement, not the prose about it: a docblock explaining the trap
# is how four earlier checks in this repository were satisfied by a comment.
# ⚠️ **The comment filter is the point, not an afterthought.** The first draft
# of this check failed on its OWN docblock quoting the statement it forbids —
# the fifth time in this repository that prose has satisfied a code check. A
# line whose content (after `path:lineno:`) starts with `*`, `//` or `#` is
# documentation, and documentation describing a trap is not the trap.
BY_NAME=$(grep -rn "DELETE FROM tenants WHERE name" "$TESTS" --include='*.ts' \
  | sed 's/^[^:]*:[0-9]*://' \
  | grep -vE '^[[:space:]]*(\*|//|#)' || true)

if [ -n "$BY_NAME" ]; then
  fail "a suite deletes tenants by name, which registration sets from the payload:"
  printf '%s\n' "$BY_NAME" | sed 's|^|        |'
  printf '        use deleteTenantsFor(dataSource, NS) — it finds them through membership\n'
else
  pass "no suite deletes tenants by a name it does not control"
fi

# ---------------------------------------------------------------------------
# 2. A hand-rolled membership delete must not be the only way tenants are found.
# ---------------------------------------------------------------------------
# A suite may delete memberships by hand, but then it must ALSO delete its
# tenants by slug — a handle that survives the membership going away. Deleting
# memberships while relying on them to locate the tenants is the ordering bug.
OFFENDERS=""

for file in "$TESTS"/*.e2e-spec.ts; do
  [ -f "$file" ] || continue

  grep -q "DELETE tm FROM tenant_members" "$file" || continue
  grep -q "deleteTenantsFor" "$file" && continue
  grep -qE "DELETE (FROM tenants|t FROM tenants).*(slug|WHERE t.slug)" "$file" && continue
  grep -q "deleteTenantsBySlug" "$file" && continue

  OFFENDERS="$OFFENDERS  $(basename "$file")\n"
done

if [ -n "$OFFENDERS" ]; then
  fail "a suite deletes memberships by hand with no slug-based tenant delete to fall back on:"
  printf "%b" "$OFFENDERS" | sed 's|^|      |'
  printf '        memberships are the only link to a tenant — delete them last, or use the helper\n'
else
  pass "every hand-rolled membership delete is backed by a slug-based tenant delete"
fi

# ---------------------------------------------------------------------------
# 3. The harness cleans up when it closes.
# ---------------------------------------------------------------------------
# 23 of 32 suites called close() and nothing else, so everything they created
# survived the run. Fixed at the harness rather than in 23 teardowns; this check
# is what stops close() quietly reverting to app.close() alone.
HARNESS="$TESTS/harness.ts"

if grep -qE "close: \(\) => app\.close\(\)" "$HARNESS" 2>/dev/null; then
  fail "harness close() no longer cleans up — 23 suites call only close()"
elif grep -qE "close: async \(\) => \{" "$HARNESS" 2>/dev/null \
  && awk '/close: async \(\) => \{/,/^    \},/' "$HARNESS" | grep -q "await cleanup()"; then
  pass "harness close() removes the namespace's rows before shutting down"
else
  fail "harness close() does not call cleanup() — see F-leak in test/harness.ts"
fi

# ---------------------------------------------------------------------------
# 4. deleteTenantsFor still reads memberships before deleting them.
# ---------------------------------------------------------------------------
# The helper's whole value is this ordering. Reversing it would silently break
# every suite that trusts it, with no test failing.
CT="$TESTS/cleanup-tenants.ts"
SELECT_LINE=$(grep -n "SELECT DISTINCT tm.tenantId" "$CT" 2>/dev/null | head -1 | cut -d: -f1)
DELETE_LINE=$(grep -n "DELETE tm FROM tenant_members" "$CT" 2>/dev/null | head -1 | cut -d: -f1)

if [ -n "$SELECT_LINE" ] && [ -n "$DELETE_LINE" ] && [ "$SELECT_LINE" -lt "$DELETE_LINE" ]; then
  pass "deleteTenantsFor reads memberships before deleting them"
else
  fail "deleteTenantsFor must SELECT the memberships before it DELETEs them"
fi

# ---------------------------------------------------------------------------
# 5. The test server actually listens.
# ---------------------------------------------------------------------------
# 🔴 **This was the wandering cross-suite intermittent, and it survived three
# wrong theories across two audits.** `app.init()` alone does not bind a port,
# so `getHttpServer()` hands supertest a server it must bind itself — one
# ephemeral listener per request. Under concurrency those collide and the
# kernel resets connections: `read ECONNRESET`, or a status line with no body
# at all, which presented as `404 {} contentType=(none) text=""`.
#
# Measured at 20 concurrent GETs: 12 of 20 rejected without the listen, 0 of 20
# with it. It moved between option-authoring, publish, cascade,
# connect-handshake and concurrency because it follows whichever suite issues
# concurrent requests on a busy machine, never a particular piece of code.
#
# ⚠️ **A revert here is silent.** Nothing fails immediately; the suite simply
# starts failing somewhere else, occasionally, for a reason that looks like a
# product defect.
HARNESS="$TESTS/harness.ts"

if grep -q "server.listen(0" "$HARNESS" 2>/dev/null \
  && grep -q "await app.init()" "$HARNESS" 2>/dev/null; then
  pass "the test server listens, so concurrent requests are not reset"
else
  fail "bootstrapTestApp must call server.listen(0) after app.init()"
  printf '        without it supertest binds one ephemeral server per request\n'
  printf '        and concurrent requests are reset — the wandering intermittent\n'
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d teardown check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll teardown checks passed.\033[0m\n'
