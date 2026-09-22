#!/usr/bin/env bash
#
# The preview acts on every display setting the storefront acts on.
#
# ## Why this exists
#
# 🔴 **Three settings were normalised and never used.** `displaySettings()`
# computed `columns`, `swatchSize`, `collapsed`, `priceDisplay` and `tooltip`
# with the storefront's exact fallbacks — and the component read one of them. A
# merchant setting `columns: 4` saw a plain list in the preview and a grid on the
# shop.
#
# ⚠️ **Absent code again.** No line existed to mutate and no test asserted the
# behaviour, so every mutation passed and the suite stayed green — the same shape
# as the missing `validation` transform, the missing value-level price
# conversion, and the three rule effects before it. A count notices what was
# never written; this is the third gate written for that reason.
#
# ## Two settings are deliberately not consumed by the component
#
# `tooltip` reaches the markup through `guidance()`, which renders it as a
# described-by block — so it is asserted against the view helper, not the
# component. `collapsed` is a near-no-op on the storefront itself
# (`opacity: 0.92`), and the plugin says why: *"honouring it in CSS alone would
# hide a control from sighted customers while leaving it in the tab order and the
# accessibility tree — the worst of both."* Reproducing that faithfully means
# reproducing almost nothing, so it is recorded as a fidelity limit rather than
# drawn. Both are named here, so a reader sees a decision rather than a gap.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$ROOT/optioniaWooCommerceFrontend/src"
VIEW="$DASH/lib/preview/option-view.ts"
PREVIEW="$DASH/components/option-sets/set-preview.tsx"
CSS="$ROOT/optioniaWooCommercePlugin/assets/css/frontend.css"

for f in "$VIEW" "$PREVIEW" "$CSS"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT/"}"
    printf '\n\033[31m%d display-setting check(s) failed.\033[0m\n' "$FAILURES"
    exit 1
  fi
done

strip_comments() {
  sed -e 's://.*::' "$1" | awk '/\/\*/{b=1} !b{print} /\*\//{b=0}'
}

# Read the fields from the interface rather than listing them here: the shape is
# the view helper's to grow, and this gate's job is to notice when it does.
FIELDS=$(strip_comments "$VIEW" \
  | awk '/^export interface DisplaySettings \{/{inside=1; next} inside && /^\}/{inside=0} inside' \
  | grep -oE '^\s+readonly [a-zA-Z]+' | awk '{print $2}')

COUNT=$(printf '%s\n' "$FIELDS" | grep -c .)
FLOOR=5

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found $COUNT DisplaySettings field(s), floor $FLOOR — the pattern is wrong, not the code"
else
  pass "DisplaySettings declares $COUNT setting(s)"

  for field in $FIELDS; do
    case "$field" in
      tooltip)
        # Rendered through `guidance()`, not read from the settings object.
        if strip_comments "$VIEW" | grep -qE 'display\.tooltip'; then
          pass "\`tooltip\` reaches the markup through guidance()"
        else
          fail "\`tooltip\` is computed but never rendered"
        fi
        ;;
      collapsed)
        # A recorded fidelity limit; see the header.
        pass "\`collapsed\` is a recorded fidelity limit, not drawn"
        ;;
      *)
        if strip_comments "$PREVIEW" | grep -qE "\b$field\b"; then
          pass "the preview acts on \`$field\`"
        else
          fail "the preview never reads \`$field\`, a setting the storefront honours"
          printf '      A merchant would set it and see no change.\n'
        fi
        ;;
    esac
  done
fi

# 🔴 **The grid minimum is a shared magic number.** The preview wraps at the same
# width the shop does only while these agree, and nothing else would notice.
CSS_MIN=$(strip_comments "$CSS" | grep -oE 'minmax\([0-9]+em, 1fr\)' | grep -oE '[0-9]+em' | head -1)
TS_MIN=$(strip_comments "$VIEW" | grep -oE "CHOICE_COLUMN_MIN = '[0-9]+em'" | grep -oE "[0-9]+em" | head -1)

if [ -z "$CSS_MIN" ] || [ -z "$TS_MIN" ]; then
  fail "could not read the choice-column minimum from both sides (css='$CSS_MIN' ts='$TS_MIN')"
elif [ "$CSS_MIN" != "$TS_MIN" ]; then
  fail "the storefront wraps choices at $CSS_MIN, the preview at $TS_MIN"
  printf '      The preview would wrap at a different width from the shop.\n'
else
  pass "preview and storefront both wrap choices at $CSS_MIN"
fi

# `columns` is a MAXIMUM, not a count (ADR-108): the storefront gives every
# count one identical `auto-fit` rule, so a fixed-count grid would promise a
# layout the shop gives only when the container is wide enough.
if strip_comments "$PREVIEW" | grep -qE 'repeat\(auto-fit'; then
  pass "the preview lays choices out with auto-fit, as the storefront does"
else
  fail "the preview does not use an auto-fit grid for choices"
  printf '      A fixed column count promises a layout the storefront does not give.\n'
fi

# 🔴 **A value's price sits BESIDE its label, never aligned in a column**
# (ADR-065). The storefront states the rule and its reason in `frontend.css`:
# *"the label and the price are one sentence a customer reads together, and a
# column needs a width this stylesheet cannot know without owning the theme's
# layout."*
#
# ⚠️ **That decision lived ONLY in that comment.** The preview drifted into
# `justify-between` — the column layout the ADR rejects — and nothing failed,
# because no gate, test or plan entry named it. Asserted from both sides now: the
# storefront must still say it, and the preview must not contradict it.
if strip_comments "$CSS" | grep -qE '\.optionia-value__price' \
  && grep -qE 'margin-left: 0\.35em' "$CSS"; then
  pass "the storefront still spaces a price beside its label"
else
  fail "the storefront no longer sets \`margin-left\` on a value price"
  printf '      ADR-065 may have changed; the preview mirrors it and must follow.\n'
fi

if strip_comments "$PREVIEW" | grep -qE 'justify-between'; then
  fail "the preview aligns a value's price in a column — ADR-065 puts it beside the label"
  printf '      Most visibly wrong inside the narrow frame M21.2 added.\n'
else
  pass "the preview keeps a price beside its label, as ADR-065 requires"
fi

# 🔴 **Every option type a customer answers must have a control.** Nine of
# fifteen had none: `OptionPreview` is deliberately inert (ADR-104) and the
# set-scope preview answered options only by choosing a **value**, so a rule
# reading *"engraving text is not empty"* could never fire. A merchant rewrites a
# rule that was right.
#
# ⚠️ **Absent code, again** — the fourth time. No line to mutate, no test to
# fail, suite green.
INPUTS="$DASH/lib/preview/answer-input.ts"

if [ ! -f "$INPUTS" ]; then
  fail "missing: ${INPUTS#"$ROOT/"}"
elif strip_comments "$PREVIEW" | grep -qE 'answerInput\('; then
  pass "the preview asks what control answers each option"
else
  fail "the preview does not vary its control by option type"
  printf '      Nine of fifteen types would be unanswerable, and their rules could never fire.\n'
fi

# `per_char`, `per_unit` and `tiered` are authorable, the server charges them,
# and nine shared fixtures pin the arithmetic — and nothing rendered a penny of
# it (ADR-107 reaches this half too).
if strip_comments "$PREVIEW" | grep -qE 'optionPricingDelta\('; then
  pass "the preview prices option-level pricing, as the server does"
else
  fail "the preview never prices \`per_char\`, \`per_unit\` or \`tiered\`"
  printf '      A merchant would set a per-character charge and see no cost anywhere.\n'
fi

# 🔴 **The constraints a browser enforces.** The preview read `max_length` and
# discarded the other sixteen validation rules, so a merchant setting min 1 /
# max 100 saw no limit while the storefront emits real HTML attributes.
#
# ⚠️ **Absent code for the fifth time** — after the missing transforms, the
# missing rule effects, the unused display settings, and the nine unanswerable
# types. No line to mutate, no test to fail, suite green.
if strip_comments "$PREVIEW" | grep -qE 'fieldConstraints\('; then
  pass "the preview emits the constraints a browser enforces"
else
  fail "the preview emits no numeric or length constraints"
  printf '      A merchant would set min/max and see no limit at all.\n'
fi

# ---------------------------------------------------------------------------
# The style tokens, which are display settings by another name (M21c.2, F33)
#
# 🔴 **This gate counted five fields and was blind to four more.** The tokens
# live in `styleTokens()` rather than the `DisplaySettings` interface, so the
# count above -- written because *"a count notices what was never written"* --
# could not see them. The same absent-code shape, one level up, inside the gate
# built to catch it.
#
# ⚠️ **Counted from the PLUGIN's emitter**, which is the surface of truth: the
# storefront is what a customer sees, and the preview's job is to agree with it.
# A token added there and forgotten here fails, rather than passing quietly.
# ---------------------------------------------------------------------------

STYLES="$ROOT/optioniaWooCommercePlugin/src/Frontend/OptionView.php"

if [ ! -f "$STYLES" ]; then
  fail "missing: optioniaWooCommercePlugin/src/Frontend/OptionView.php"
else
  # Single-quoted inside double quotes would still expand `$name`, so the
  # second alternative is dropped: `styles()` emits the accent literally and
  # the three pixel tokens through the named map below, which PLUGIN_NAMED
  # reads. Between them every token is found.
  PLUGIN_TOKENS=$(grep -oE "'--optionia-[a-z]+: '" "$STYLES" \
    | grep -oE '\-\-optionia-[a-z]+' | sort -u)
  PLUGIN_NAMED=$(grep -oE "^\s+'[a-z_]+' *=> *array\( '[a-z]+'" "$STYLES" \
    | grep -oE "array\( '[a-z]+'" | grep -oE "'[a-z]+'" | tr -d "'" \
    | sed 's/^/--optionia-/' | sort -u)
  PLUGIN_TOKENS=$(printf '%s\n%s\n' "$PLUGIN_TOKENS" "$PLUGIN_NAMED" \
    | grep -E '^--optionia-[a-z]+$' | sort -u)

  TOKEN_COUNT=$(printf '%s\n' "$PLUGIN_TOKENS" | grep -c . || true)
  TOKEN_FLOOR=4

  if [ "$TOKEN_COUNT" -lt "$TOKEN_FLOOR" ]; then
    fail "found $TOKEN_COUNT style token(s), floor $TOKEN_FLOOR — the pattern is wrong, not the code"
  else
    pass "the storefront emits $TOKEN_COUNT style token(s)"

    MISSING=0

    for token in $PLUGIN_TOKENS; do
      if strip_comments "$VIEW" | grep -q -- "$token"; then
        continue
      fi

      fail "\`$token\` is emitted by the storefront and not by the preview"
      printf '      Phase 21c requires configured styles render identically in both.\n'
      MISSING=$((MISSING + 1))
    done

    if [ "$MISSING" -eq 0 ]; then
      pass "the preview emits every token the storefront does"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Presentational display: the divider style (M21c.5, F36)
#
# 🔴 **This gate was built for F34 and then missed the very next styling field.**
# It compares the four *option* style tokens and knows nothing about a
# presentational item's `display` -- so M21c.5 shipped a divider style the
# storefront honoured and the preview ignored, and every check here stayed green.
#
# ⚠️ **The styles are read from the backend schema**, which is what a merchant
# may author, and both renderers must agree with it. A style added there and
# forgotten in either surface fails, rather than passing quietly.
# ---------------------------------------------------------------------------

DIVIDER_SCHEMA="$ROOT/optioniaWooCommerceBackend/src/option-sets/types/presentational-display.ts"
DIVIDER_TEMPLATE="$ROOT/optioniaWooCommercePlugin/templates/presentational/divider.php"

if [ ! -f "$DIVIDER_SCHEMA" ]; then
  fail "missing: the presentational display schema"
else
  DIVIDER_STYLES=$(grep -oE "DIVIDER_STYLES = \[[^]]+\]" "$DIVIDER_SCHEMA" \
    | grep -oE "'[a-z]+'" | tr -d "'" | sort -u)

  STYLE_COUNT=$(printf '%s\n' "$DIVIDER_STYLES" | grep -c . || true)
  STYLE_FLOOR=3

  if [ "$STYLE_COUNT" -lt "$STYLE_FLOOR" ]; then
    fail "found $STYLE_COUNT divider style(s), floor $STYLE_FLOOR — the pattern is wrong, not the code"
  else
    pass "the schema defines $STYLE_COUNT divider style(s)"

    # The storefront reads them through OptionView; the preview through its twin.
    PLUGIN_VIEW="$ROOT/optioniaWooCommercePlugin/src/Frontend/OptionView.php"
    MISSING_STYLE=0

    for style in $DIVIDER_STYLES; do
      if ! grep -q "'$style'" "$PLUGIN_VIEW"; then
        fail "the storefront does not accept the divider style \`$style\`"
        MISSING_STYLE=$((MISSING_STYLE + 1))
      fi

      if ! strip_comments "$VIEW" | grep -q "'$style'"; then
        fail "the preview does not accept the divider style \`$style\`"
        MISSING_STYLE=$((MISSING_STYLE + 1))
      fi

      # ⚠️ **Accepting a style is not drawing it.** A mutation dropping `dotted`
      # from the component's class map **survived** a check that only read the
      # parser -- the style name still appeared in `option-view.ts`, so parity
      # looked intact while the preview drew nothing for it.
      if ! strip_comments "$PREVIEW" | grep -q "$style:"; then
        fail "the preview accepts \`$style\` but has no rule that draws it"
        MISSING_STYLE=$((MISSING_STYLE + 1))
      fi
    done

    if [ "$MISSING_STYLE" -eq 0 ]; then
      pass "both renderers accept every divider style the schema defines"
    fi
  fi

  # 🔴 **And the preview must DRAW it, not merely parse it.** Parsing a style
  # and rendering one rule regardless is exactly what F35 was.
  if strip_comments "$PREVIEW" | grep -q 'dividerStyle('; then
    pass "the preview draws the divider style it reads"
  else
    fail "the preview never calls dividerStyle() — a divider would draw one rule for every style"
  fi

  if [ -f "$DIVIDER_TEMPLATE" ] && grep -q 'divider_style' "$DIVIDER_TEMPLATE"; then
    pass "the storefront template draws the divider style"
  else
    fail "the divider template never calls divider_style()"
  fi
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d display-setting check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll display-setting checks passed.\033[0m\n'
