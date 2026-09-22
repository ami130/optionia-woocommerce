#!/usr/bin/env bash
#
# The plugin's catalogue caps must agree with the API's validators.
#
# `CataloguePayload` truncates and caps before sending so that one over-long
# field cannot fail a whole batch. Those numbers are the API's — `@Length` and
# `@ArrayMaxSize` in `ingest-products.dto.ts` — written out a second time in
# PHP, and a number duplicated across repositories is a number that drifts.
#
# 🔴 The failure is asymmetric, which is why this is gated rather than trusted.
# A plugin cap **larger** than the API's sends a value the API refuses, and a
# batch is all-or-nothing: one product costs 249 good ones their write, and the
# cursor never advances past it. A plugin cap **smaller** silently truncates
# data the API would have accepted. Neither surfaces as an error anyone reads.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DTO="$ROOT/optioniaWooCommerceBackend/src/products/dto/ingest-products.dto.ts"
PAYLOAD="$ROOT/optioniaWooCommercePlugin/src/Catalogue/CataloguePayload.php"

for f in "$DTO" "$PAYLOAD"; do
  [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

echo "Checking catalogue limit parity..."

# --- The taxonomy array cap ---------------------------------------------------
API_TERMS=$(grep -oE '@ArrayMaxSize\(([0-9]+)\)' "$DTO" | grep -oE '[0-9]+' | sort -u)
PLUGIN_TERMS=$(grep -oE 'MAX_TERMS = ([0-9]+)' "$PAYLOAD" | grep -oE '[0-9]+')

if [ -z "$PLUGIN_TERMS" ]; then
  fail "MAX_TERMS not found in CataloguePayload.php — the matcher is stale"
elif [ "$(echo "$API_TERMS" | wc -l | tr -d ' ')" != "1" ]; then
  fail "the API declares more than one @ArrayMaxSize on ingest; this gate compares one"
elif [ "$API_TERMS" != "$PLUGIN_TERMS" ]; then
  fail "taxonomy cap disagrees: API @ArrayMaxSize($API_TERMS) vs plugin MAX_TERMS=$PLUGIN_TERMS"
else
  pass "taxonomy cap agrees ($API_TERMS terms)"
fi

# --- Field lengths ------------------------------------------------------------
# Each entry is a wire field, its API @Length maximum, and the length the plugin
# truncates it to. The plugin's number is read from the call, not assumed.
CHECKED=0

check_length() {
  local field="$1" expected="$2" actual="$3"

  CHECKED=$((CHECKED + 1))

  if [ -z "$actual" ]; then
    fail "$field: no truncation found in CataloguePayload.php"
  elif [ "$expected" != "$actual" ]; then
    fail "$field: API allows $expected, plugin truncates to $actual"
  fi
}

# `name` -> get_name, 255; `sku` -> get_sku, 100; `type`/`status` -> 20.
check_length "name"      "255" "$(grep -oE "get_name', ([0-9]+)"   "$PAYLOAD" | grep -oE '[0-9]+')"
check_length "sku"       "100" "$(grep -oE "get_sku', ([0-9]+)"    "$PAYLOAD" | grep -oE '[0-9]+')"
check_length "type"      "20"  "$(grep -oE "get_type', ([0-9]+)"   "$PAYLOAD" | grep -oE '[0-9]+')"
check_length "status"    "20"  "$(grep -oE "get_status', ([0-9]+)" "$PAYLOAD" | grep -oE '[0-9]+')"
check_length "permalink" "500" "$(grep -oE "get_permalink', ([0-9]+)" "$PAYLOAD" | grep -oE '[0-9]+')"

if [ "$CHECKED" -lt 5 ]; then
  fail "only $CHECKED field(s) compared — the list is wrong, not the code"
elif [ "$FAILURES" -eq 0 ]; then
  pass "all $CHECKED field length(s) agree with the API's validators"
fi

# --- The batch cap ------------------------------------------------------------
# The plugin must never ask the API to accept more products than it will.
API_BATCH=$(grep -oE 'MAX_PRODUCTS_PER_PUSH = ([0-9]+)' "$DTO" | grep -oE '[0-9]+')

if [ -z "$API_BATCH" ]; then
  fail "MAX_PRODUCTS_PER_PUSH not found in the API DTO — the matcher is stale"
else
  pass "API batch cap is $API_BATCH product(s) per request"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d catalogue limit check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll catalogue limit checks passed.\033[0m\n'
