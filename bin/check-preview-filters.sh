#!/usr/bin/env bash
#
# The preview drops exactly what the publish serializer drops.
#
# ## Why this exists
#
# 🔴 **A disabled thing is absent from the published document, not present and
# flagged.** The serializer filters disabled groups, options, values and rules
# before the document is built, so the storefront never sees the flag — only its
# effect. `previewTree()` reproduces those filters so a merchant previews what a
# customer will actually get.
#
# The failure this guards is **asymmetric and silent**. If a fifth authorable
# entity gains an `isEnabled` filter in the serializer and the preview does not
# follow, nothing breaks: both sides compile, every test passes, and the preview
# simply shows one thing more than the storefront will. A merchant tunes an
# option that was never published.
#
# ## Why a count rather than a text comparison
#
# The two are not the same code and must not be: the serializer walks loaded
# entities and builds a `snake_case` document, the preview walks the authoring
# tree and leaves rules in `camelCase` (ADR-103). Only the *number of things
# filtered* is common to both, so that is what is compared — read from each
# side's own source, never written down here.
#
# ⚠️ **`presentational_items` has no `isEnabled` at all**, which is why the
# expected count is four and not five. A heading cannot be disabled; it is
# deleted. The count reads the source, so if that ever changes this gate reports
# it rather than encoding today's answer.
#
# ## Transforms, not only filters
#
# 🔴 **This gate counted filters only, and a missing TRANSFORM slipped past it.**
# The serializer applies three per-option transforms — `validation`, `pricing`,
# `display` — and the preview applied two. Every validation rule reached the
# preview in the authoring spelling: a renderer enforcing `validation.maxLength`
# would honour a limit the storefront, which reads `max_length`, does not.
#
# Deleting a transform is caught by the preview's own tests. **Adding one to the
# serializer and forgetting the preview is not** — there is no test to fail,
# because nobody writes a test for a transform they have not thought of. That
# asymmetry is what a count catches and a test cannot, which is the same argument
# that justified counting the filters.
#
# ⚠️ **Counted at BOTH levels, because the first version counted only one.**
# Extending the count to per-option transforms left the per-VALUE transform
# unguarded, and that is where the next defect was: a value's `priceConfig` left
# in the stored spelling priced a 2.5% surcharge at zero. A count that stops one
# level short is the same blind spot with a smaller radius.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERIALIZER="$ROOT/optioniaWooCommerceBackend/src/option-sets/serialization/option-set.serializer.ts"
PREVIEW="$ROOT/optioniaWooCommerceFrontend/src/lib/preview/preview-tree.ts"

# A floor, so a rename that makes both patterns match nothing cannot pass as
# agreement. Four is what both sides filter today; it is checked, not trusted.
FLOOR=4

for f in "$SERIALIZER" "$PREVIEW"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT/"}"
    printf '\n\033[31m%d preview filter check(s) failed.\033[0m\n' "$FAILURES"
    exit 1
  fi
done

# ⚠️ **Comments are stripped before counting.** Both files *discuss* filtering in
# their docblocks — the preview's own docblock quotes the naive predicate as the
# thing not to write — and a gate that counted prose would measure the
# explanation rather than the code. Caught on this gate's first run, where the
# preview counted five.
strip_comments() {
  sed -e 's://.*::' "$1" | awk '
    /\/\*/ { inblock = 1 }
    !inblock { print }
    /\*\// { inblock = 0 }
  '
}

# `.filter((x) => y.isEnabled)` in the serializer: groups, rules, options, values.
SERIALIZER_COUNT=$(strip_comments "$SERIALIZER" | grep -cE '\.filter\(\(.*\) => .*\.isEnabled\)')

# The preview's own four. The value filter reads `isEnabled !== false` (the flag
# is optional on `AuthoringValue`), so it is counted through its named predicate
# rather than by repeating the comparison here.
PREVIEW_COUNT=$(strip_comments "$PREVIEW" | grep -cE '\.filter\(\(.*\) => .*\.isEnabled\)|\.filter\(valueIsEnabled\)')

if [ "$SERIALIZER_COUNT" -lt "$FLOOR" ]; then
  fail "serializer: found $SERIALIZER_COUNT isEnabled filter(s), floor $FLOOR — the pattern is wrong, not the code"
elif [ "$PREVIEW_COUNT" -lt "$FLOOR" ]; then
  fail "preview: found $PREVIEW_COUNT isEnabled filter(s), floor $FLOOR — the pattern is wrong, not the code"
elif [ "$SERIALIZER_COUNT" -ne "$PREVIEW_COUNT" ]; then
  fail "the serializer filters $SERIALIZER_COUNT thing(s) on isEnabled, the preview $PREVIEW_COUNT"
  printf '      A preview showing more than the storefront publishes, or less.\n'
  printf '      serializer: %s\n' "${SERIALIZER#"$ROOT/"}"
  printf '      preview:    %s\n' "${PREVIEW#"$ROOT/"}"
else
  pass "preview and serializer each drop $SERIALIZER_COUNT disabled entity kind(s)"
fi

# The three per-option transforms, counted from each side's own source. Named
# individually rather than by a wildcard so that a *renamed* transform fails here
# too, rather than being silently recounted.
TRANSFORM_FLOOR=3
SERIALIZER_TRANSFORMS=$(strip_comments "$SERIALIZER" \
  | grep -cE 'toPublished(Validation|OptionPricing|Display)\(option\.')
PREVIEW_TRANSFORMS=$(strip_comments "$PREVIEW" \
  | grep -cE 'toPublished(Validation|OptionPricing|Display)\(option\.')

if [ "$SERIALIZER_TRANSFORMS" -lt "$TRANSFORM_FLOOR" ]; then
  fail "serializer: found $SERIALIZER_TRANSFORMS per-option transform(s), floor $TRANSFORM_FLOOR — the pattern is wrong, not the code"
elif [ "$PREVIEW_TRANSFORMS" -lt "$TRANSFORM_FLOOR" ]; then
  fail "preview: found $PREVIEW_TRANSFORMS per-option transform(s), floor $TRANSFORM_FLOOR — a transform the serializer applies is missing"
elif [ "$SERIALIZER_TRANSFORMS" -ne "$PREVIEW_TRANSFORMS" ]; then
  fail "the serializer applies $SERIALIZER_TRANSFORMS per-option transform(s), the preview $PREVIEW_TRANSFORMS"
  printf '      A preview showing a field in a spelling the storefront does not read.\n'
else
  pass "preview and serializer each apply $SERIALIZER_TRANSFORMS per-option transform(s)"
fi

# The per-value transform. One on each side: the serializer's `price_config`, the
# preview's `toPreviewValue`.
VALUE_FLOOR=1
SERIALIZER_VALUE=$(strip_comments "$SERIALIZER" | grep -cE 'toPublishedPriceConfig\(')
PREVIEW_VALUE=$(strip_comments "$PREVIEW" | grep -cE 'toPublishedPriceConfig\(')

if [ "$SERIALIZER_VALUE" -lt "$VALUE_FLOOR" ]; then
  fail "serializer: found $SERIALIZER_VALUE per-value transform(s), floor $VALUE_FLOOR — the pattern is wrong, not the code"
elif [ "$PREVIEW_VALUE" -lt "$VALUE_FLOOR" ]; then
  fail "preview: found $PREVIEW_VALUE per-value transform(s), floor $VALUE_FLOOR — a value's priceConfig would reach an evaluator in the stored spelling, and price as zero"
elif [ "$SERIALIZER_VALUE" -ne "$PREVIEW_VALUE" ]; then
  fail "the serializer applies $SERIALIZER_VALUE per-value transform(s), the preview $PREVIEW_VALUE"
else
  pass "preview and serializer each apply $SERIALIZER_VALUE per-value transform(s)"
fi

# The value predicate must not be the naive one: `AuthoringValue.isEnabled` is
# optional, so `.filter((v) => v.isEnabled)` silently drops every value whose
# flag was never sent.
if strip_comments "$PREVIEW" | grep -qE '\.filter\(\(value\) => value\.isEnabled\)'; then
  fail "preview filters values with a truthiness test — the flag is optional, so absent would read as disabled"
else
  pass "preview treats an absent value flag as enabled"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d preview filter check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll preview filter checks passed.\033[0m\n'
