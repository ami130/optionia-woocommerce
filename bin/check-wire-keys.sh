#!/usr/bin/env bash
#
# The config document's key spelling, checked across the two repositories that
# have to agree about it.
#
# ## Why this exists
#
# The document is **snake_case** because its reader is PHP; the storage that
# feeds it is **camelCase** because its schema is TypeScript. Two bugs have come
# from that seam:
#
#   1. `price_config` shipped `amountMinor` on one path and `amount_minor` on
#      another, so a PHP evaluator reading `amount_minor` got null for every
#      value configured the first way. Fixed by `toPublishedPriceConfig`.
#   2. `validation` and `display` were published **verbatim** from storage, so a
#      merchant's `maxLength` arrived spelled in a way
#      `SelectionResolver::max_length()` does not look for — present in the
#      document, enforced nowhere, and a customer could type past the limit.
#      Fixed by `toPublishedValidation` / `toPublishedDisplay`.
#
# Both were found by accident. Unit tests now pin the keys that exist, but a
# **new** rule added to the catalogue (M14.4 adds `pattern`, `allowed_charset`,
# `forbidden_words`) would ship camelCase silently unless someone remembers to
# write the test — which is exactly what did not happen the first two times.
#
# This gate does not need anyone to remember.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

MAP="optioniaWooCommerceBackend/src/option-sets/serialization/option-config.ts"
PRICE="optioniaWooCommerceBackend/src/option-sets/serialization/price-config.ts"
ENGINE="optioniaWooCommercePlugin/src/Engine/SelectionResolver.php"

for file in "$MAP" "$PRICE" "$ENGINE"; do
  if [ ! -f "$file" ]; then
    fail "missing: $file"
    printf '\n\033[31mCould not read the contract; nothing was compared.\033[0m\n'
    exit 1
  fi
done

printf 'Checking config-document key spelling...\n'

# --- 1. Every key the document carries is snake_case --------------------------
#
# The stored side is camelCase by construction, so a camelCase key on the
# right-hand side of a mapping means the rename was forgotten rather than
# decided.
EMITTED=$(grep -oE "[a-zA-Z]+: '[a-zA-Z_]+'," "$MAP" | sed "s/.*: '//;s/',//" | sort -u)

if [ -z "$EMITTED" ]; then
  fail "read no key mappings from option-config.ts — has its shape changed?"
else
  BAD=''
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    # An uppercase letter anywhere is camelCase reaching the wire.
    if printf '%s' "$key" | grep -q '[A-Z]'; then
      BAD="$BAD $key"
    fi
  done <<< "$EMITTED"

  if [ -n "$BAD" ]; then
    fail "these document keys are not snake_case:$BAD"
    printf '        The reader is PHP. A camelCase key is one it will never find.\n'
  else
    pass "all $(printf '%s\n' "$EMITTED" | grep -c .) document key(s) are snake_case"
  fi
fi

# --- 2. Every rule the plugin reads is one the backend emits ------------------
#
# The other direction: a plugin looking for `min_length` that the backend never
# publishes is a rule that silently never applies. Only keys read out of
# `validation` and `display` are compared — the plugin reads many other document
# fields, and those are covered by the fixture-parity gate.
#
# ⚠️ **`$optionia_display` is deliberately excluded.**
#
# `OptionView::display()` returns a *normalised* array whose keys are the
# template's vocabulary (`collapsed`, `swatch_size`), not the document's — it
# reads the wire keys itself, from `$config`. Scanning that variable made the
# gate report `collapsed` as a rule the API never publishes, when the wire key
# `collapsed_by_default` was being read correctly on the same line.
#
# A gate that cannot tell reading a document from reading its own return value
# produces false failures, and a false failure is how a real one gets ignored.
READ=$(grep -oE "\\\$validation\['[a-z_]+'\]|\\\$config\['[a-z_]+'\]|\\\$optionia_validation\['[a-z_]+'\]|\\\$optionia_raw_display\['[a-z_]+'\]" \
  "$ENGINE" optioniaWooCommercePlugin/src/Frontend/OptionView.php \
  optioniaWooCommercePlugin/templates/options/*.php 2>/dev/null \
  | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)

if [ -z "$READ" ]; then
  fail "read no validation/display keys from the plugin — has its shape changed?"
else
  MISSING=''
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if ! printf '%s\n' "$EMITTED" | grep -qx "$key"; then
      MISSING="$MISSING $key"
    fi
  done <<< "$READ"

  if [ -n "$MISSING" ]; then
    fail "the plugin reads rule(s) the API never publishes:$MISSING"
    printf '        A rule nothing emits is a rule that silently never applies.\n'
  else
    pass "all $(printf '%s\n' "$READ" | grep -c .) rule(s) the plugin reads are published"
  fi
fi

# --- 3. Rule keys reaching the document are snake_case ------------------------
#
# Check 1 reads `key: 'value'` mappings, which is the shape `VALIDATION_KEYS` and
# `DISPLAY_KEYS` use. `toPublishedRule` and its helpers build their objects
# **literally** — `option_id: condition.optionId` — so none of their keys appear
# in that grep at all, and a camelCase one would have been invisible to the gate
# written to catch exactly this.
#
# The literal side is the one that reaches PHP, so it is what this reads: every
# property name assigned inside the rule converters.
# Only the keys ASSIGNED FROM something — `option_id: condition.optionId`. The
# parameter list declares `targetId: string` in the same shape, and reading those
# would flag the storage side the converter exists to translate away from.
RULE_KEYS=$(sed -n '/^function toPublishedConditions/,$p' "$MAP" \
  | grep -oE "^\s+[a-zA-Z_]+: (rule|condition|actionValue)\." \
  | sed 's/[[:space:]]//g;s/:.*//' | sort -u)

if [ -z "$RULE_KEYS" ]; then
  fail "read no rule keys from option-config.ts — has toPublishedRule moved?"
else
  BAD_RULE=''
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if printf '%s' "$key" | grep -q '[A-Z]'; then
      BAD_RULE="$BAD_RULE $key"
    fi
  done <<< "$RULE_KEYS"

  if [ -n "$BAD_RULE" ]; then
    fail "these rule keys are not snake_case:$BAD_RULE"
    printf '        A rule the plugin cannot read is a rule that silently never applies.\n'
  else
    pass "all $(printf '%s\n' "$RULE_KEYS" | grep -c .) rule key(s) are snake_case"
  fi
fi

echo

# --- 5. Every key the SCHEMA accepts appears in the rename map ----------------
#
# 🔴 **The hole the other checks could not see.** Check 1 reads the right-hand
# side of `VALIDATION_KEYS`, so it judges only keys that are already in the map.
# `rename()` falls through with `keys[key] ?? key`, so a key the schema accepts
# and the map omits is published **verbatim** — camelCase on a snake_case wire —
# and check 1 never sees it, because a key it is not shown cannot be judged.
#
# Measured: `minSelections` and `maxSelections` were accepted by
# `choiceValidationSchema` from M5.4b and absent from the map until M18.3a. They
# published as `{"minSelections":1,"maxSelections":3}` beside a correctly
# renamed `max_length`, and every gate passed.
#
# This check closes it from the other side: read what the schemas accept, and
# require the map to know each one. A key deliberately left unpublished must be
# named in EXEMPT below, so the decision is visible rather than an omission.
REGISTRY="optioniaWooCommerceBackend/src/option-sets/types/type-registry.ts"

# Keys accepted by an option's `validation` or `display` schema.
#
# ⚠️ **Scoped to the schema bodies, not the whole file.** A bare grep for
# `name: z.` also matches the registry's own structural fields —
# `validationSchema: z.ZodType` and `displaySchema: z.ZodType` — which are not
# document keys at all. Reading them as such made this check fail on its first
# run against two names no merchant ever sets.
SCHEMA_KEYS=$(awk '
  /^const [a-zA-Z]+(Validation|Display)Schema = z$|^const [a-zA-Z]+(Validation|Display)Schema = z\./ { inside=1; next }
  inside && /^(const|export|\/\*\*)/ { inside=0 }
  inside && match($0, /^[[:space:]]+[a-z][a-zA-Z]*: z\./) {
    k=$0; sub(/^[[:space:]]+/,"",k); sub(/: z\..*/,"",k); print k
  }
' "$REGISTRY" | sort -u)

# Keys the map knows, by their STORED (left-hand) spelling.
MAPPED_KEYS=$(grep -oE "^[[:space:]]+[a-zA-Z]+: '[a-zA-Z_]+'," "$MAP" \
  | sed "s/[[:space:]]*//;s/:.*//" | sort -u)

# Named exemptions: accepted by a schema, deliberately not published.
#
# `maxFiles` is the file option's own cap and is enforced at upload, not by the
# storefront resolver -- see the type registry's note on it.
EXEMPT='maxFiles'

if [ ! -f "$REGISTRY" ]; then
  fail "missing: $REGISTRY"
elif [ -z "$SCHEMA_KEYS" ]; then
  # The same lesson the other gates learned: an unreadable input must not
  # compare as empty and pass.
  fail "read no keys from the type registry -- has its shape changed?"
else
  UNMAPPED=''

  while IFS= read -r key; do
    [ -z "$key" ] && continue

    if printf '%s\n' "$EXEMPT" | grep -qx "$key"; then
      continue
    fi

    if ! printf '%s\n' "$MAPPED_KEYS" | grep -qx "$key"; then
      UNMAPPED="$UNMAPPED $key"
    fi
  done <<< "$SCHEMA_KEYS"

  if [ -n "$UNMAPPED" ]; then
    fail "these keys are accepted by a schema but absent from the rename map:$UNMAPPED"
    printf '        rename() falls through, so each would publish VERBATIM --\n'
    printf '        camelCase on a snake_case wire, and check 1 cannot see it.\n'
    printf '        Add it to VALIDATION_KEYS/DISPLAY_KEYS, or name it in EXEMPT.\n'
  else
    pass "all $(printf '%s\n' "$SCHEMA_KEYS" | grep -c .) schema key(s) are known to the rename map"
  fi
fi

echo

# --- 6. The contract document agrees with the enum it describes ---------------
#
# 🔴 **`CONFIG-CONTRACT.md` listed `display_type` as `inline · accordion · tab ·
# modal`.** Two of those four values do not exist: the enum is `inline ·
# accordion · tabs · stepped`. Nothing compared the two, so the doc drifted
# silently and would have stayed wrong indefinitely.
#
# ⚠️ **Nothing broke, and that is why it survived.** The plugin never believed
# the doc — it reads the enum's real values — so the only casualty was the next
# person to trust the contract. A document that describes a wire incorrectly is
# worse than one that says nothing, because it is read as authority.
#
# Only `display_type` is checked: it is the value list the doc spells out in
# full. Extending this to the other enums is worth doing when one of them next
# gains a value.
CONTRACT="optioniaWooCommerceBackend/docs/CONFIG-CONTRACT.md"
ENUMS="optioniaWooCommerceBackend/src/common/database/enums.ts"

DOC_TYPES=$(grep -oE '^\| `display_type` \|[^|]*\|[^|]*' "$CONTRACT" \
  | grep -oE '`[a-z_]+`' | tr -d '`' | grep -v '^display_type$' | sort -u)

ENUM_TYPES=$(awk '/^export const GroupDisplayType = \{/{inside=1;next} inside&&/^\}/{inside=0} inside' "$ENUMS" \
  | grep -oE ": '[a-z_]+'" | sed "s/: '//;s/'//" | sort -u)

if [ ! -f "$CONTRACT" ] || [ ! -f "$ENUMS" ]; then
  fail "missing the contract document or the enum file"
elif [ -z "$DOC_TYPES" ] || [ -z "$ENUM_TYPES" ]; then
  fail "could not read display_type from the contract or the enum -- has either shape changed?"
else
  MISSTATED=$(comm -23 <(printf '%s\n' "$DOC_TYPES") <(printf '%s\n' "$ENUM_TYPES"))

  if [ -n "$MISSTATED" ]; then
    fail "CONFIG-CONTRACT.md names display_type value(s) the enum does not have: $(printf '%s' "$MISSTATED" | tr '\n' ' ')"
    printf '        The document is read as authority. A value it invents is a value\n'
    printf '        somebody will publish, and the storefront will draw as inline.\n'
  else
    pass "the contract's display_type values all exist in the enum"
  fi
fi

echo

# --- 4. price_config keeps its own rename ------------------------------------
#
# The first instance of this bug. Asserted rather than trusted to stay fixed.
if grep -q "amount_minor" "$PRICE"; then
  pass "price_config still renames to snake_case"
else
  fail "price_config no longer emits amount_minor — the first instance of this bug is back"
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d wire-key check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll wire-key checks passed.\033[0m\n'
