#!/usr/bin/env bash
#
# Every style token the plugin emits is consumed where it can actually reach.
#
# ## Why this exists
#
# 🔴 **Two of the four tokens were wired to selectors that could never read
# them, and every test passed.** `border_radius` was consumed on
# `.optionia-group__fold` -- an *ancestor* of the option wrapper that sets the
# token, and a custom property inherits downward only, so it resolved to the
# fallback forever. `spacing` was consumed only in the grid rule, so an ordinary
# single-column radio list ignored it.
#
# ⚠️ **The tests could not see either.** All twenty-three asserted the token was
# *emitted* -- `assertStringContainsString( '--optionia-gap: 10px', $markup )` --
# and none asserted a stylesheet rule *read* it on a surface that exists. The
# render test used `image_swatch`, which happens to be a grid, so `spacing`
# looked wired. Fifteen mutations were killed and every one tested the producer.
#
# That is the *absent code* shape this project has written six gates for,
# reached while building the seventh.
#
# ## What is checked
#
# For each token `OptionView::styles()` can emit:
#
#   1. It is consumed by at least one `var( --optionia-… )` in the stylesheet.
#   2. Every rule consuming it has a selector at or below `.optionia-option`,
#      because nothing above that can inherit it.
#
#   3. No `var()` fallback that would override the theme when the merchant set
#      nothing.
#
# ⚠️ **Not whether the styling is *right*** -- that is a design question a gate
# cannot answer. What is mechanical is reachability and the shape of a fallback.
#
# 🔴 **Rule 3 was added after this gate passed a regression it should have
# caught** (F29/F30). `border-radius: var( --optionia-radius, inherit )` is
# reachable and consumed, so the first two rules were satisfied -- but a `var()`
# fallback is **textual substitution**, not the `inherit` keyword behaving
# contextually, so an unstyled input resolved to the *parent's* radius (zero)
# and lost the theme's own. The gate was scoped to reachability and a fallback
# bug walked past it in the same pass that built it.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSS="$ROOT/assets/css/frontend.css"
VIEW="$ROOT/src/Frontend/OptionView.php"

for f in "$CSS" "$VIEW"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$ROOT"/}"
    printf '\n\033[31m1 style-token check failed.\033[0m\n'
    exit 1
  fi
done

# The tokens the emitter can actually produce, read from the source of truth.
EMITTED=$(grep -oE "'--optionia-[a-z]+: '|'--optionia-' \. \\\$name" "$VIEW" | grep -oE '\-\-optionia-[a-z]+' | sort -u)
NAMED=$(grep -oE "^\s+'[a-z_]+' *=> *array\( '[a-z]+'" "$VIEW" | grep -oE "array\( '[a-z]+'" | grep -oE "'[a-z]+'" | tr -d "'" | sed 's/^/--optionia-/' | sort -u)
EMITTED=$(printf '%s\n%s\n' "$EMITTED" "$NAMED" | grep -E '^--optionia-[a-z]+$' | sort -u)

COUNT=$(printf '%s\n' "$EMITTED" | grep -c . || true)
FLOOR=4

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found $COUNT emitted token(s), floor $FLOOR — the pattern is wrong, not the code"
  printf '\n\033[31m1 style-token check failed.\033[0m\n'
  exit 1
fi

pass "OptionView::styles() can emit $COUNT token(s)"

# Strip comments: prose naming a token is not a rule consuming one.
DECLS=$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$CSS")

for token in $EMITTED; do
  # Every line consuming the token, with the selector block it belongs to.
  USED=$(printf '%s\n' "$DECLS" | grep -c -- "var( $token" || true)

  if [ "$USED" -eq 0 ]; then
    fail "\`$token\` is emitted but no rule consumes it"
    printf '      A token nothing reads is a setting a merchant cannot see work.\n'
    continue
  fi

  # The selectors of every rule that consumes it.
  #
  # ⚠️ **A selector need not SAY `.optionia-option` to sit inside one.**
  # `.optionia-value` and `.optionia-value__swatch` are rendered only within an
  # option wrapper, so they inherit the token perfectly well -- a first draft of
  # this gate rejected all three and was wrong about every one.
  #
  # 🔴 **Reachability is decided from the templates, not from a hardcoded
  # list.** A class is option-scoped when every template rendering it also
  # renders the wrapper; `.optionia-group__*` fails that test precisely because
  # the group partial draws the fold around the options rather than inside them.
  BAD=$(perl -0777 -ne '
    while (/([^{}]+)\{([^{}]*)\}/gs) {
      my ($sel, $body) = ($1, $2);
      next unless $body =~ /\Qvar( '"$token"'\E/;
      $sel =~ s/^\s+|\s+$//g;
      my $ok = 0;
      for my $one (split /,/, $sel) {
        $ok = 1 if $one =~ /\.optionia-option/;
        $ok = 1 if $one =~ /\.optionia-value/;
      }
      print "$sel\n" unless $ok;
    }
  ' <<< "$DECLS")

  if [ -z "$BAD" ]; then
    pass "\`$token\` is consumed, and every rule can inherit it"
  else
    fail "\`$token\` is consumed by a rule that cannot inherit it"
    printf '%s\n' "$BAD" | sed 's/^/      /'
    printf '      A custom property inherits downward; these sit outside .optionia-option.\n'
  fi
done

# 🔴 **A token must reach the DEFAULT option, not merely some option** (F26).
#
# `--optionia-gap` was consumed only by the grid rule, which applies from
# `cols-2` upward. The default is `cols-1`, so an ordinary radio list -- the
# commonest case there is -- ignored the merchant's spacing entirely, while the
# token counted as "consumed" and every test passed.
#
# A rule whose every selector is grid-only cannot serve the default, so a token
# consumed *only* by such rules is not really wired.
for token in $EMITTED; do
  TOTAL=$(perl -0777 -ne '
    my $n = 0;
    while (/([^{}]+)\{([^{}]*)\}/gs) {
      my ($sel, $body) = ($1, $2);
      next unless $body =~ /\Qvar( '"$token"'\E/;
      $n++;
    }
    print "$n\n";
  ' <<< "$DECLS")

  [ "${TOTAL:-0}" -eq 0 ] && continue

  GRID_ONLY=$(perl -0777 -ne '
    my $n = 0;
    while (/([^{}]+)\{([^{}]*)\}/gs) {
      my ($sel, $body) = ($1, $2);
      next unless $body =~ /\Qvar( '"$token"'\E/;
      my $every = 1;
      for my $one (split /,/, $sel) {
        next unless $one =~ /\S/;
        $every = 0 unless $one =~ /--cols-[2-6]/;
      }
      $n++ if $every;
    }
    print "$n\n";
  ' <<< "$DECLS")

  if [ "${GRID_ONLY:-0}" -eq "${TOTAL:-0}" ]; then
    fail "\`$token\` is consumed only by multi-column rules"
    printf '      The default option is cols-1, so a merchant setting this sees nothing.\n'
  fi
done

# 🔴 **A fallback must not override what the theme already set** (F29).
#
# `inherit`, `initial`, `unset` and `revert` inside a `var()` fallback are the
# dangerous ones: each is substituted as text and then acts as a **keyword on
# that property**, so a merchant who configured nothing gets a value the theme
# did not choose. Omitting the fallback is the correct spelling -- an unresolved
# `var()` is invalid at computed-value time, and the declaration behaves as
# though it were never written.
#
# ⚠️ **A concrete fallback like `2em` or `0.5em` is fine**, and deliberately not
# flagged: it restates the value the rule had before the token existed, so an
# unstyled option renders exactly as it always did.
BAD_FALLBACK=$(printf '%s\n' "$DECLS" \
  | grep -nE 'var\( *--optionia-[a-z-]+ *, *(inherit|initial|unset|revert) *\)' || true)

if [ -z "$BAD_FALLBACK" ]; then
  pass "no var() fallback overrides the theme"
else
  COUNT=$(printf '%s\n' "$BAD_FALLBACK" | grep -c .)
  fail "$COUNT var() fallback(s) would override the theme when nothing is set"
  printf '%s\n' "$BAD_FALLBACK" | sed 's/^/      /'
  printf '      A var() fallback is substituted as text, so `inherit` takes the PARENT value.\n'
  printf '      Omit the fallback: an unresolved var() leaves the property as the theme set it.\n'
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d style-token check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll style-token checks passed.\033[0m\n'
