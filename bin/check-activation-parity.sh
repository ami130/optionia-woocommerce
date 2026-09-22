#!/usr/bin/env bash
#
# The dashboard's funnel steps must agree with the API's, in order.
#
# `optioniaWooCommerceFrontend/src/lib/activation/api.ts` mirrors `ACTIVATION_STEPS`
# and `ACTIVATION_STEP` from the backend's `funnel-steps.ts` (M20b.1). The copy
# exists because the dashboard must label and order the steps without a round
# trip, and ADR-083's rule applies: a duplicate is allowed, drift is not.
#
# **Order is compared, not just membership.** The order *is* the funnel — it is
# what makes "the earliest unreached step" the merchant's next action — so two
# lists holding the same names in a different sequence are a defect, and a
# set-comparison would call them equal.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="$ROOT/optioniaWooCommerceBackend/src/activation/funnel-steps.ts"
API_SVC="$ROOT/optioniaWooCommerceBackend/src/activation/activation.service.ts"
UI="$ROOT/optioniaWooCommerceFrontend/src/lib/activation/api.ts"

for f in "$API" "$API_SVC" "$UI"; do
  [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

echo "Checking activation funnel parity..."

steps_of() {
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(r'ACTIVATION_STEPS = \[(.*?)\] as const', text, re.S)
if not match:
    print('PARSE_FAILED')
else:
    print(' '.join(re.findall(r"'([a-z_]+)'", match.group(1))))
PY
}

activation_step_of() {
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
match = re.search(r"ACTIVATION_STEP\s*:\s*ActivationStep\s*=\s*'([a-z_]+)'", text)
print(match.group(1) if match else 'PARSE_FAILED')
PY
}

API_STEPS="$(steps_of "$API")"
UI_STEPS="$(steps_of "$UI")"

# A parser that found nothing must fail loudly rather than compare two blanks.
if [ "$API_STEPS" = "PARSE_FAILED" ] || [ -z "$API_STEPS" ]; then
  fail "could not read ACTIVATION_STEPS from the API"
elif [ "$UI_STEPS" = "PARSE_FAILED" ] || [ -z "$UI_STEPS" ]; then
  fail "could not read ACTIVATION_STEPS from the dashboard"
elif [ "$API_STEPS" != "$UI_STEPS" ]; then
  fail "funnel steps differ (order matters)"
  printf '        api:       %s\n' "$API_STEPS"
  printf '        dashboard: %s\n' "$UI_STEPS"
else
  COUNT=$(printf '%s' "$API_STEPS" | wc -w | tr -d ' ')

  # 10 steps, per M20b.1. A shrunken list that still matched would pass silently.
  FLOOR=10
  if [ "$COUNT" -lt "$FLOOR" ]; then
    fail "only $COUNT step(s) compared (floor $FLOOR) — the parser is wrong, not the code"
  else
    pass "all $COUNT funnel step(s) agree, in order"
  fi
fi

API_ACTIVATION="$(activation_step_of "$API")"
UI_ACTIVATION="$(activation_step_of "$UI")"

if [ "$API_ACTIVATION" = "PARSE_FAILED" ] || [ "$UI_ACTIVATION" = "PARSE_FAILED" ]; then
  fail "could not read ACTIVATION_STEP (api=$API_ACTIVATION dashboard=$UI_ACTIVATION)"
elif [ "$API_ACTIVATION" != "$UI_ACTIVATION" ]; then
  fail "activation step differs: api=$API_ACTIVATION dashboard=$UI_ACTIVATION"
else
  pass "both repositories activate at '$API_ACTIVATION'"
fi

# The response shape, which the step names alone do not cover.
#
# 🔴 **`signedUpAt` was added to the API and not to the dashboard, and this gate
# said nothing.** It compared `ACTIVATION_STEPS` and the activation step — both of
# which still agreed — while the two `TenantActivation` interfaces had diverged.
# TypeScript keeps each honest within its own repository and knows nothing about
# the other, so a field added on one side compiles on both and is simply missing
# at runtime.
SHAPE_MISMATCH="$(python3 - "$API_SVC" "$UI" <<'PY'
import re, sys

def fields(path, name='TenantActivation'):
    text = open(path).read()
    match = re.search(rf'interface {name} \{{(.*?)\n\}}', text, re.S)
    if not match:
        return None
    body = re.sub(r'/\*[\s\S]*?\*/', '', match.group(1))
    body = re.sub(r'//.*$', '', body, flags=re.M)
    return sorted(set(re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\??:', body, re.M)))

api, ui = fields(sys.argv[1]), fields(sys.argv[2])
if api is None or ui is None:
    print('PARSE_FAILED')
elif api != ui:
    print(f"api={' '.join(api)} | dashboard={' '.join(ui)}")
else:
    print('')
PY
)"

if [ "$SHAPE_MISMATCH" = "PARSE_FAILED" ]; then
  fail "could not read TenantActivation from one or both repositories"
elif [ -n "$SHAPE_MISMATCH" ]; then
  fail "TenantActivation fields differ"
  printf '        %s\n' "$SHAPE_MISMATCH"
else
  pass "the activation response shape agrees across both repositories"
fi

# Every step the dashboard renders needs a label, or the UI shows a raw key.
MISSING="$(python3 - "$UI" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
steps = re.findall(r"'([a-z_]+)'", re.search(r'ACTIVATION_STEPS = \[(.*?)\] as const', text, re.S).group(1))
labels = re.search(r'STEP_LABELS[^=]*= \{(.*?)\n\} as const', text, re.S)
have = set(re.findall(r'^\s*([a-z_]+):', labels.group(1), re.M)) if labels else set()
print(' '.join(s for s in steps if s not in have))
PY
)"

if [ -n "$MISSING" ]; then
  fail "steps with no label in the dashboard: $MISSING"
else
  pass "every funnel step has a merchant-facing label"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d activation parity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll activation parity checks passed.\033[0m\n'
