#!/usr/bin/env bash
#
# The plugin release shape agrees across the two repositories (M20b.3).
#
# `PluginRelease` is declared in the API's `plugin-download.controller.ts` and
# again in the dashboard's `lib/activation/api.ts`. TypeScript keeps each honest
# *within* its own repository and knows nothing about the other, so a renamed
# field compiles on both sides and fails at runtime — on the one link the install
# screen exists for.
#
# The same reasoning as `check-activation-parity.sh`: a duplicate is allowed,
# drift is not.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="$ROOT/optioniaWooCommerceBackend/src/plugin-download/plugin-download.controller.ts"
UI="$ROOT/optioniaWooCommerceFrontend/src/lib/activation/api.ts"

for f in "$API" "$UI"; do
  [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

echo "Checking plugin release parity..."

fields_of() {
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(r'interface PluginRelease \{(.*?)\n\}', text, re.S)
if not match:
    print('PARSE_FAILED')
else:
    body = re.sub(r'/\*[\s\S]*?\*/', '', match.group(1))
    body = re.sub(r'//.*$', '', body, flags=re.M)
    print(' '.join(sorted(re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\??:', body, re.M))))
PY
}

API_FIELDS="$(fields_of "$API")"
UI_FIELDS="$(fields_of "$UI")"

if [ "$API_FIELDS" = "PARSE_FAILED" ] || [ -z "$API_FIELDS" ]; then
  fail "could not read PluginRelease from the API"
elif [ "$UI_FIELDS" = "PARSE_FAILED" ] || [ -z "$UI_FIELDS" ]; then
  fail "could not read PluginRelease from the dashboard"
elif [ "$API_FIELDS" != "$UI_FIELDS" ]; then
  fail "plugin release fields differ"
  printf '        api:       %s\n' "$API_FIELDS"
  printf '        dashboard: %s\n' "$UI_FIELDS"
else
  COUNT=$(printf '%s' "$API_FIELDS" | wc -w | tr -d ' ')

  # A gate that compares nothing passes for the wrong reason: version, filename,
  # sizeBytes, downloadUrl.
  FLOOR=4
  if [ "$COUNT" -lt "$FLOOR" ]; then
    fail "only $COUNT field(s) compared (floor $FLOOR) — the parser is wrong, not the code"
  else
    pass "all $COUNT release field(s) agree across both repositories"
  fi
fi

# The dashboard must not invent a `/v1` of its own: the API's path already
# carries one and `API_BASE_URL` ends in another, so the prefix is stripped.
if grep -q "replace(/\^\\\\/v1/" "$UI"; then
  pass "the dashboard strips the API's /v1 rather than doubling it"
else
  fail "the dashboard no longer strips /v1 from downloadUrl — the link will 404"
fi

# ---------------------------------------------------------------------------
# The shipped version must appear in the changelog.
# ---------------------------------------------------------------------------
# 🔴 **F151 changed `OrderPayload` and the version stayed at 0.2.0**, which meant
# per-product revenue existed in the database and no merchant could ever see it:
# the backend reads, the column and the dashboard all shipped, and the one
# artefact a merchant installs did not. That is the mechanism-with-no-caller
# defect in its deployment form, and nothing caught it — this gate compared
# download metadata, never whether a code change had been released.
#
# ⚠️ **What is checked is the pairing, not the number.** Deciding whether a
# change is a patch or a minor is a judgement; shipping source that no changelog
# entry describes is not.
PLUGIN_PHP="$ROOT/optioniaWooCommercePlugin/optionia.php"
CHANGELOG="$ROOT/optioniaWooCommercePlugin/CHANGELOG.md"

if [ ! -f "$PLUGIN_PHP" ] || [ ! -f "$CHANGELOG" ]; then
  fail "missing optionia.php or CHANGELOG.md"
else
  PLUGIN_VERSION=$(grep -oE "define\( 'OPTIONIA_VERSION', '[0-9]+\.[0-9]+\.[0-9]+' \)" "$PLUGIN_PHP" \
    | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1)

  if [ -z "$PLUGIN_VERSION" ]; then
    fail "could not read OPTIONIA_VERSION from optionia.php — the parser is wrong, not the code"
  elif grep -qE "^## \[$PLUGIN_VERSION\]" "$CHANGELOG"; then
    pass "the shipped version ($PLUGIN_VERSION) has a changelog entry"
  else
    fail "plugin is at $PLUGIN_VERSION and CHANGELOG.md has no '## [$PLUGIN_VERSION]' entry"
    printf '        a released version nothing describes is a release no merchant can assess\n'
  fi
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d plugin release parity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll plugin release parity checks passed.\033[0m\n'
