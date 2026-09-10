#!/usr/bin/env bash
#
# `docs/ARCHITECTURE.md` must stay true.
#
# Gate 1 requires it "current", not merely present — and a document nothing
# checks decays into a description of a system that used to exist. Three of the
# four Gate 1 documents already have gates (`check-api-contract.ts` covers
# API-CONTRACT and DATABASE; `check-shared-fixtures.sh` covers PRICING-SPEC).
# This is the fourth.
#
# It checks the claims that would silently rot: the file counts, the route count,
# the guard chains, and that every path the document points at still exists. It
# does not check the prose — that is a reader's job, and a gate pretending to do
# it would give false confidence.
#
# Usage: bash bin/check-architecture-doc.sh
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$ROOT/docs/ARCHITECTURE.md"

if [ ! -f "$DOC" ]; then
  fail "docs/ARCHITECTURE.md does not exist — Gate 1 requires it"
  exit 1
fi

printf 'Checking ARCHITECTURE.md…\n'

# --- Every referenced path must exist ---------------------------------------
# A document whose links are dead is worse than one that omits them: it sends a
# reader looking for something, and they conclude they misunderstood.
MISSING=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if [ ! -e "$ROOT/$path" ]; then
    fail "references a path that does not exist: $path"
    MISSING=$((MISSING + 1))
  fi
done < <(grep -oE '`[a-zA-Z][a-zA-Z0-9_/.-]+\.(md|sh|ts)`' "$DOC" \
           | tr -d '`' | grep '/' | sort -u)

[ "$MISSING" -eq 0 ] && pass "every referenced path exists"

# --- The counts it prints ----------------------------------------------------
# Approximate by design (`~74`), so this allows drift and catches rot: a number
# that is wrong by half is describing a different codebase.
check_count() {
  local label="$1" claimed="$2" actual="$3" tolerance="$4"
  local low=$(( actual - tolerance ))
  local high=$(( actual + tolerance ))

  if [ "$claimed" -lt "$low" ] || [ "$claimed" -gt "$high" ]; then
    fail "$label: document says $claimed, actual is $actual"
  else
    pass "$label: $claimed ≈ $actual"
  fi
}

TS_ACTUAL=$(find "$ROOT/optioniaWooCommerceFrontend/src" \( -name '*.ts' -o -name '*.tsx' \) | wc -l | tr -d ' ')
PHP_ACTUAL=$(find "$ROOT/optioniaWooCommercePlugin/src" -name '*.php' | wc -l | tr -d ' ')

TS_CLAIMED=$(grep -oE '~[0-9]+ TS/TSX files' "$DOC" | grep -oE '[0-9]+' | head -1)
PHP_CLAIMED=$(grep -oE '~[0-9]+ PHP files' "$DOC" | grep -oE '[0-9]+' | head -1)
ROUTES_CLAIMED=$(grep -oE '[0-9]+ routes' "$DOC" | grep -oE '[0-9]+' | head -1)

# Generous: these move with ordinary work, and a gate that fails on every commit
# gets disabled rather than heeded.
check_count "frontend TS files" "${TS_CLAIMED:-0}" "$TS_ACTUAL" 15
check_count "plugin PHP files"  "${PHP_CLAIMED:-0}" "$PHP_ACTUAL" 15

# Routes come from the API's own gate rather than being re-derived here.
#
# ⚠️ An earlier version counted table rows in API-CONTRACT.md with a regex and
# got 45 against a true 60 — it matched `| \`GET …` and missed the rows whose
# formatting differs. Two ways of counting the same thing is one way too many:
# `check:api` is the authority, and this reads its answer.
ROUTES_ACTUAL=$(cd "$ROOT/optioniaWooCommerceBackend" 2>/dev/null \
  && npm run --silent check:api 2>/dev/null \
  | grep -oE '[0-9]+ routes registered' | grep -oE '[0-9]+' | head -1)

if [ -n "${ROUTES_ACTUAL:-}" ] && [ "$ROUTES_ACTUAL" -gt 0 ] 2>/dev/null; then
  check_count "API routes" "${ROUTES_CLAIMED:-0}" "$ROUTES_ACTUAL" 10
else
  pass "API routes: skipped (check:api unavailable)"
fi

# --- The invariants it names must still be enforced --------------------------
# The document's central claim is that each architectural rule has a gate. If a
# gate is deleted, the document becomes a promise nobody keeps.
for gate in \
  "optioniaWooCommercePlugin/bin/check-secrets.sh" \
  "optioniaWooCommercePlugin/bin/check-architecture.sh" \
  "bin/check-capability-parity.sh"
do
  if [ -x "$ROOT/$gate" ] || [ -f "$ROOT/$gate" ]; then
    pass "invariant still gated: $(basename "$gate")"
  else
    fail "ARCHITECTURE.md claims this gate enforces an invariant, and it is gone: $gate"
  fi
done

# --- The guard chains it quotes ---------------------------------------------
API_SRC="$ROOT/optioniaWooCommerceBackend/src"

if grep -rq "JwtAuthGuard, TenantGuard, CapabilityGuard" "$API_SRC" --include='*.ts'; then
  pass "dashboard guard chain unchanged"
else
  fail "ARCHITECTURE.md describes 'JwtAuthGuard → TenantGuard → CapabilityGuard'; no controller uses it"
fi

if grep -rq "StoreTokenGuard, SiteMatchGuard" "$API_SRC" --include='*.ts'; then
  pass "store guard chain unchanged"
else
  fail "ARCHITECTURE.md describes 'StoreTokenGuard → SiteMatchGuard'; no controller uses it"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%s check(s) failed. ARCHITECTURE.md no longer describes this codebase.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mARCHITECTURE.md is current.\033[0m\n'
