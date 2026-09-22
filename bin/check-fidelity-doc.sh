#!/usr/bin/env bash
#
# `docs/PREVIEW-FIDELITY.md` says what the comparison measured, not what someone
# remembered.
#
# ## Why this exists
#
# 🔴 **The document was ungated, and its own header promises otherwise.** It is
# stamped *"Generated — do not edit by hand"*, and ADR-102 requires exactly that:
# M21.5's deviations are *"documented rather than surprising"*, and a document
# written by hand records what someone recalled rather than what is true.
#
# Measured: replacing the whole file with one line of nonsense left **all fifteen
# cross-repo gates green**. The suite regenerates it on the next run, so it
# self-heals — but in the window between an edit and that run, a file claiming to
# be generated reads as authoritative while saying whatever was typed.
#
# ## What is checked
#
# Not the content — that is the comparison's job, and duplicating its verdicts
# here would be a second answer to the same question. What is checked is that the
# document **is** the generated one: the header it writes, a row for every type in
# the registry, and the recorded limits that are decisions rather than
# measurements.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$ROOT/docs/PREVIEW-FIDELITY.md"
TYPES="$ROOT/optioniaWooCommerceFrontend/src/lib/schemas/option-sets.ts"

for f in "$DOC" "$TYPES"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT/"}"
    printf '\n\033[31m%d fidelity-document check(s) failed.\033[0m\n' "$FAILURES"
    exit 1
  fi
done

if grep -qF 'do not edit by hand' "$DOC"; then
  pass "the document still declares itself generated"
else
  fail "the document has lost its generated header"
  printf '      Someone has replaced it by hand, or the generator has stopped writing it.\n'
fi

# Every authorable type, read from the registry rather than counted here: the
# list is the schema's to grow, and this gate's job is to notice when it does.
EXPECTED=$(awk '/^export const AUTHORABLE_TYPES/{inside=1} inside' "$TYPES" \
  | sed -n "/^\] as const;/q;p" \
  | grep -oE "value: '[a-z_]+'" | sed "s/value: '//;s/'//")

COUNT=$(printf '%s\n' "$EXPECTED" | grep -c .)
FLOOR=15

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found $COUNT authorable type(s), floor $FLOOR — the pattern is wrong, not the code"
else
  MISSING=0

  for type in $EXPECTED; do
    if ! grep -qF "\`$type\`" "$DOC"; then
      fail "the document has no row for \`$type\`"
      MISSING=$((MISSING + 1))
    fi
  done

  if [ "$MISSING" -eq 0 ]; then
    pass "every one of $COUNT registry type(s) has a row"
  fi
fi

# The limits that are decisions rather than measurements. Each has an ADR behind
# it, so each must survive a regeneration — a document that quietly lost one
# would read as though the deviation had gone away.
for limit in 'Pricing shown' 'Column counts' 'Collapsed groups' 'Preview width' \
             'Base price' 'Multiple sets' 'Selection and date bounds' 'Control shape' \
             'Unordered entries' 'Dialect safety'; do
  if ! grep -qF "$limit" "$DOC"; then
    fail "the document no longer records the limit: $limit"
  fi
done

if [ "$FAILURES" -eq 0 ]; then
  pass "all ten recorded limits are still stated"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d fidelity-document check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll fidelity-document checks passed.\033[0m\n'
