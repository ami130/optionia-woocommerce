#!/usr/bin/env bash
#
# The starter-template fixture matches what the dashboard actually ships (M20b.4).
#
# ## Why this exists
#
# `optioniaWooCommerceBackend/test/fixtures/dashboard/starter-templates.json` is what
# proves every starter template survives the real import endpoint. It is emitted
# from the dashboard's `templates.ts`, and a fixture that has drifted from its
# source tests a document no merchant will ever send.
#
# 🔴 **The version it replaced had already drifted.** The engraving document was
# pasted into `option-sets-http.e2e-spec.ts` by hand and carried **one** option
# where the real template carries two — so the only template with endpoint
# coverage was being tested in a shape the dashboard had stopped shipping, and
# the other three had no coverage at all.
#
# ## What this gate does NOT check, and where that lives
#
# ⚠️ **It compares ids, names and non-emptiness — not the documents' content.**
# Shell cannot execute `templateDocument()`, so it cannot know what a template
# *should* contain; only the dashboard can.
#
# 🔴 That is not a theoretical limit. Removing an option from the engraving
# document — **exactly the drift this fixture exists to prevent** — left this gate
# reporting success. Measured during M20b.4's audit.
#
# So the content comparison lives in
# `optioniaWooCommerceFrontend/src/lib/option-sets/templates.fixture.test.ts`,
# which rebuilds every document from source and diffs it. This gate keeps the
# structural checks, which are still worth having: they run even when that suite
# does not, and they name the failure in the working tree that holds both repos.
#
# Regenerate the fixture with:
#   cd optioniaWooCommerceFrontend && \
#     UPDATE_TEMPLATE_FIXTURE=1 npx vitest run src/lib/option-sets/templates.fixture.test.ts
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI="$ROOT/optioniaWooCommerceFrontend/src/lib/option-sets/templates.ts"
FIXTURE="$ROOT/optioniaWooCommerceBackend/test/fixtures/dashboard/starter-templates.json"

for f in "$UI" "$FIXTURE"; do
  [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

echo "Checking starter-template fixture parity..."

# The ids the dashboard ships, in the order `STARTER_TEMPLATES` declares them.
UI_IDS="$(python3 - "$UI" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(r'STARTER_TEMPLATES[^=]*=\s*\[(.*?)\n\];', text, re.S)
print(' '.join(sorted(re.findall(r"id:\s*'([a-z-]+)'", match.group(1)))) if match else 'PARSE_FAILED')
PY
)"

FIXTURE_IDS="$(python3 - "$FIXTURE" <<'PY'
import json, sys
print(' '.join(sorted(json.load(open(sys.argv[1])).keys())))
PY
)"

if [ "$UI_IDS" = "PARSE_FAILED" ] || [ -z "$UI_IDS" ]; then
  fail "could not read STARTER_TEMPLATES from the dashboard"
elif [ "$UI_IDS" != "$FIXTURE_IDS" ]; then
  fail "template ids differ"
  printf '        dashboard: %s\n' "$UI_IDS"
  printf '        fixture:   %s\n' "$FIXTURE_IDS"
else
  COUNT=$(printf '%s' "$UI_IDS" | wc -w | tr -d ' ')

  # Four templates, per M20.7. A shrunken list that still matched would pass.
  if [ "$COUNT" -lt 4 ]; then
    fail "only $COUNT template(s) compared (floor 4) — the parser is wrong, not the code"
  else
    pass "all $COUNT template id(s) agree"
  fi
fi

# Each template's *name* must match too: the id is a slug nobody sees, and a
# renamed template that kept its id would test one document and ship another.
MISMATCH="$(python3 - "$UI" "$FIXTURE" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
block = re.search(r'STARTER_TEMPLATES[^=]*=\s*\[(.*?)\n\];', text, re.S)
ui = dict(re.findall(r"id:\s*'([a-z-]+)',\s*\n\s*name:\s*'([^']+)'", block.group(1))) if block else {}
fixture = {k: v.get('name') for k, v in json.load(open(sys.argv[2])).items()}
print(' '.join(f"{k}({ui.get(k)!r}!={fixture.get(k)!r})" for k in sorted(set(ui) | set(fixture))
               if ui.get(k) != fixture.get(k)))
PY
)"

if [ -n "$MISMATCH" ]; then
  fail "template names differ: $MISMATCH"
else
  pass "every template name matches the document it ships"
fi

# A fixture whose documents are empty would import and assert nothing.
THIN="$(python3 - "$FIXTURE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(' '.join(k for k, v in data.items()
               if not v.get('groups') or not any(g.get('options') for g in v['groups'])))
PY
)"

if [ -n "$THIN" ]; then
  fail "templates with no groups or no options: $THIN"
else
  pass "every template carries at least one group with options"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d template fixture check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll template fixture checks passed.\033[0m\n'
