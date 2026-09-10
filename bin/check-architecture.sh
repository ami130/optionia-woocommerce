#!/usr/bin/env bash
#
# Architecture guards for the Optionia plugin.
#
# The M3.0 principles are only real if something checks them. This script is
# that something: it runs in CI and fails the build when a layering rule is
# broken. A convention nobody checks is a convention nobody keeps.
#
# Usage: bash bin/check-architecture.sh

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  printf '\033[32mok\033[0m    %s\n' "$1"
}

# --- Principle 1: Engine/ is pure -------------------------------------------
# The engine is a port of TypeScript logic and must run against shared fixtures
# without a WordPress bootstrap. One get_option() call breaks that.
WP_FUNCS='get_option|update_option|delete_option|add_action|add_filter|apply_filters|do_action|wp_remote_|get_post|wc_get_|WC\(\)|\$wpdb|esc_html|esc_attr|__\('
if grep -rInE "(^|[^a-zA-Z_])(${WP_FUNCS})" src/Engine --include='*.php' \
     | grep -v 'defined( .ABSPATH. )' > /tmp/optionia_engine_hits 2>/dev/null; then
  if [ -s /tmp/optionia_engine_hits ]; then
    fail "src/Engine/ must not call WordPress functions (Principle 1):"
    sed 's/^/        /' /tmp/optionia_engine_hits
  else
    pass "src/Engine/ is free of WordPress calls"
  fi
else
  pass "src/Engine/ is free of WordPress calls"
fi

# --- Principle 2: one owner for outbound HTTP -------------------------------
HTTP_HITS=$(grep -rIln 'wp_remote_' src --include='*.php' | grep -v '^src/Api/' || true)
if [ -n "$HTTP_HITS" ]; then
  fail "wp_remote_* is only allowed in src/Api/ (Principle 2):"
  echo "$HTTP_HITS" | sed 's/^/        /'
else
  pass "outbound HTTP confined to src/Api/"
fi

# --- Principle 5: no float money -------------------------------------------
# Money must never be a float. Time, byte counts and ratios legitimately are,
# so the check targets money-shaped identifiers rather than every float cast.
#
# One use is legitimate and cannot be written any other way: **overflow
# detection**. PHP has no `Number.isSafeInteger`, and past `PHP_INT_MAX` the
# addition itself yields a float -- so testing the result would mean testing a
# value the overflow has already corrupted. The operands must be widened to
# float and summed *before* the integer addition commits.
#
# Exempted by an explicit marker rather than by filename. `Money.php` was
# exempted by path, and when `Engine/Pricing.php` needed the identical cast for
# the identical reason the rule had no way to say so -- the choice was to add a
# second path and keep adding them, or to name the reason once. A marker also
# survives a rename, and states in the source itself why the cast is there.
#
# Comment lines are excluded before matching, not after. `Money.php` carries a
# docblock explaining that it avoids `(float) $value * 100` -- prose describing
# the very thing the rule forbids. Matching it would be this project's recurring
# bug in miniature: a gate that reads documentation instead of code.
# The identifier list is matched anywhere on the line, which misses a cast whose
# *source* is generically named. Measured 2026-09-01: `Reporting\OrderPayload`
# converted an order total with `$minor = (int) round( (float) $value * 100 )`
# and passed, while the identical line two methods earlier -- differing only in
# saying `$delta` instead of `$value` -- was caught. A real violation hid behind
# a variable name.
#
# So `minor` joins the list. It is the name every money *destination* in this
# codebase carries, which is what a float conversion is ultimately assigned to.
# 🔴 **The identifier match runs on the code, never on the path.** `grep -rIn`
# prefixes every line with `file:line:`, so matching the whole line meant any
# float in `Integration/CartTotals.php` or `Integration/CartItemPayload.php` was
# a hit on the *filename* — `total` and `payload`-adjacent words live there.
# Measured 2026-09-09: a weight in grams, named `$line_grams` precisely to avoid
# money words, still failed. That is the same defect this file warns about two
# comments above — a gate reading something other than the code — pointed at
# paths instead of prose. `cut` drops the prefix before the identifier test, and
# the prefix is put back for the report so a failure still names its line.
#
# A SECOND marker, for a different reason. `overflow-guard` says "this float is
# a bound check, never a value" -- it is discarded immediately after being
# compared. `quantity-not-money` says something else: the float IS used, because
# a QUANTITY is not money. "1.5 metres" is a real measurement, and refusing it
# would make `per_unit` unable to price anything measured.
#
# It is a narrower licence than it looks. The product is rounded to an integer
# **on the next statement**, so nothing fractional reaches a total and
# `Pricing::sum_deltas()` still sees only integers. A marker that let a float
# survive into a sum would be this rule with the teeth removed; this one lets it
# survive one multiplication.
FLOAT_HITS=$(grep -rInE '\(float\)|\(double\)|floatval' src --include='*.php' \
             | grep -vE ':[[:space:]]*(\*|//|#)' \
             | grep -v 'overflow-guard' \
             | grep -v 'quantity-not-money' \
             | awk -F: -v IGNORECASE=1 '{ code = substr($0, index($0, $3)) }
                 code ~ /price|amount|total|cost|money|delta|subtotal|fee|minor/ { print }' || true)
if [ -n "$FLOAT_HITS" ]; then
  fail "money must use Support\\Money, not floats (Principle 5):"
  echo "$FLOAT_HITS" | sed 's/^/        /'
else
  pass "no float used for money outside Support/Money.php"
fi

# --- Principle 2: logging has one owner ------------------------------------
LOG_HITS=$(grep -rInE 'error_log\(|var_dump\(|print_r\(|\bdie\(|\bexit;.*debug' src --include='*.php' \
           | grep -v 'src/Support/Logger.php' || true)
if [ -n "$LOG_HITS" ]; then
  fail "use Support\\Logger, not error_log/var_dump (Principle 2):"
  echo "$LOG_HITS" | sed 's/^/        /'
else
  pass "logging confined to Support/Logger.php"
fi

# --- Direct file access guard ----------------------------------------------
MISSING_GUARD=""
while IFS= read -r file; do
  if ! grep -q "defined( 'ABSPATH' )\|defined( 'WP_UNINSTALL_PLUGIN' )" "$file"; then
    MISSING_GUARD="${MISSING_GUARD}${file}\n"
  fi
done < <(find src templates -name '*.php' -type f 2>/dev/null)

if [ -n "$MISSING_GUARD" ]; then
  fail "every PHP file needs a direct-access guard:"
  printf "%b" "$MISSING_GUARD" | sed 's/^/        /'
else
  pass "all PHP files carry a direct-access guard"
fi

# --- AC4: the add-to-cart boundary covers every call site --------------------
#
# `woocommerce_add_to_cart_validation` is applied from SIX places in WC 11.0.1:
#
#   includes/class-wc-form-handler.php:981          3   simple
#   includes/class-wc-form-handler.php:1013         3   order-again ($item is an ARRAY)
#   includes/class-wc-form-handler.php:1063         5   variable
#   includes/class-wc-cart-session.php:615          6   reorder ($cart_item_data)
#   includes/class-wc-ajax.php:520                  3   shop-loop AJAX
#   src/StoreApi/Utilities/CartController.php:335   6   block cart / block checkout
#
# The count has been wrong four times -- two, three, five, now six -- and every
# correction came from searching one directory further, never from an insight.
# Stage 6 and Stage 7 both grepped `includes/` and called it exhaustive; the
# Store API lives in `src/`.
#
# So take this floor for what it is: a guard against the record being *reduced*,
# not evidence that six is right. It cannot be, because it reads our own map.
#
# **Deriving the count from WooCommerce is not possible here.** CI is a bare
# `actions/checkout` with no WordPress and no WooCommerce -- `composer.json`
# requires `php`, `ext-intl`, `ext-mbstring` and dev tooling, nothing else. A gate
# cannot grep a plugin that is not on disk.
#
# What covers the gap instead is a *runtime* check: the validator registers with
# arity headroom and reports any call site supplying more arguments than the
# widest recorded one. `WP_Hook` caps delivery at `accepted_args`, so registering
# at the maximum would make a seventh argument invisible by construction. That is
# why the arity assertion below is `>`, not `>=`.
#
# This checks the three things that are silent when wrong: the recorded site
# count, that the registration carries headroom above it, and that there is
# exactly one registration.
VALIDATOR='src/Integration/AddToCartValidator.php'

if [ ! -f "$VALIDATOR" ]; then
  fail "the add-to-cart validator is missing -- AC4 has no server-side boundary"
else
  SITE_COUNT=$(awk '/private const CALL_SITES = array\(/{inside=1; next}
                    inside && /\);/{inside=0}
                    inside && /=> *[0-9]+,/{n++}
                    END{print n+0}' "$VALIDATOR")
  # `match()` with a capture array is a gawk extension; BSD awk on macOS returns
  # nothing and the gate would pass while reporting an empty arity. Extracted
  # with grep instead, which behaves the same on both.
  MAX_ARITY=$(awk '/private const CALL_SITES = array\(/{inside=1; next}
                   inside && /\);/{inside=0}
                   inside{print}' "$VALIDATOR" \
              | grep -oE '=> *[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
  MAX_ARITY=${MAX_ARITY:-0}

  # One registration covers every site, because `accepted_args` belongs to the
  # registration and WordPress runs every registration at every call site. Five
  # registrations made the callback vote five times and refused valid reorders --
  # measured, not theorised.
  #
  # Detected as "is the registration inside a loop", not by counting `add_filter`
  # lines: the regression that actually happened wrapped a single line in a
  # `foreach`, so a line count still read 1 and the gate passed. Counting the
  # thing that is easy to count rather than the thing that breaks is how a gate
  # ends up inspecting nothing.
  REGISTRATIONS=$(grep -cE "add_filter\( self::HOOK" "$VALIDATOR" || true)
  LOOPED_REGISTRATION=$(awk '/function register\(\): void/{inside=1}
                             inside && /^\t}/{inside=0}
                             inside && /foreach|for \(|while \(/{n++}
                             END{print n+0}' "$VALIDATOR")

  # Headroom above the widest recorded site, read from the source rather than
  # assumed, so lowering it is a failure rather than a tidy-up.
  #
  # Comment lines are dropped before matching. Measured: setting the constant to
  # zero while leaving `// ARITY_HEADROOM = 2 would go here.` above it passed this
  # check, because the pattern found the comment. That is this project's recurring
  # bug -- `check-secrets` matched `hash_equals` in a comment, the architecture
  # gate matched `update_option` in prose, the float rule matched a docblock
  # describing the cast it avoids, and now this. Fourth time.
  HEADROOM=$(grep -vE '^[[:space:]]*(\*|//|#|/\*)' "$VALIDATOR" \
             | grep -oE 'ARITY_HEADROOM = [0-9]+' | grep -oE '[0-9]+$')
  HEADROOM=${HEADROOM:-0}

  # The constant existing is not the same as the registration using it. Measured:
  # `registered_arity()` returning a literal `6` left the constant untouched and
  # this gate still reported "+2 headroom" -- a gate describing a property it had
  # not checked. So the derivation itself is asserted, on a comment-free view.
  DERIVES_ARITY=$(grep -vE '^[[:space:]]*(\*|//|#|/\*)' "$VALIDATOR" \
                  | grep -cE 'return self::max_accepted_args\(\) \+ self::ARITY_HEADROOM;' || true)

  if [ "$SITE_COUNT" -lt 6 ]; then
    fail "the validator records only $SITE_COUNT call site(s); WC 11.0.1 has 6"
    printf '        A missed call site is not a coverage gap, it is a path where nothing checks.\n'
  elif [ "$MAX_ARITY" -lt 6 ]; then
    fail "the validator registers at $MAX_ARITY argument(s); two sites supply 6"
    printf '        At fewer than 6, cart_item_data is dropped and reorder cannot be validated.\n'
  elif [ "$HEADROOM" -lt 1 ]; then
    fail "the validator registers at exactly the widest known arity, with no headroom"
    printf '        WP_Hook caps delivery at accepted_args, so a seventh argument from a\n'
    printf '        future WooCommerce would be invisible. The headroom is the only\n'
    printf '        detector of a call site nobody has found yet.\n'
  elif [ "$DERIVES_ARITY" -ne 1 ]; then
    fail "the registration arity is not derived from max_accepted_args() + ARITY_HEADROOM"
    printf '        A literal arity leaves the constant in place while ignoring it, so the\n'
    printf '        headroom becomes documentation rather than behaviour.\n'
  elif [ "$REGISTRATIONS" -ne 1 ] || [ "$LOOPED_REGISTRATION" -gt 0 ]; then
    fail "the validator registers $REGISTRATIONS time(s); exactly one registration is correct"
    printf '        accepted_args belongs to the registration, and WordPress runs every\n'
    printf '        registration at every call site -- so N registrations vote N times.\n'
  else
    pass "add-to-cart boundary covers all $SITE_COUNT call sites at arity $MAX_ARITY (+$HEADROOM headroom)"
  fi
fi

# --- M11.6: the cart price is PER UNIT, never multiplied by quantity ---------
#
# `WC_Cart_Totals` computes a line as per-unit price times quantity (WC 11.0.1,
# `includes/class-wc-cart-totals.php:233`):
#
#   $item->price = wc_add_number_precision_deep( (float) $cart_item['data']->get_price() * (float) $cart_item['quantity'] );
#
# So a plugin that hands WooCommerce a *line* total has its option deltas
# multiplied by quantity TWICE. It is the silent-overcharge bug of this phase,
# and it is silent precisely because quantity 1 looks correct -- the case most
# manual testing uses.
#
# Checked as "no arithmetic on a quantity in the pricing path", not by looking
# for a correct implementation: there is no positive signature to match, but
# multiplying by a quantity is a specific, greppable mistake. Comment lines are
# excluded first, because the rule is discussed in prose in exactly the files it
# governs -- the `check-secrets`/`hash_equals` failure, which this project has
# now hit three times.
# Matched on `qty` as well as `quantity`. Measured: a mutation that multiplied by
# a local named `$qty` passed a pattern keyed only on `quantity`, while the tests
# caught it -- a gate narrower than the bug it names is a gate that reports safety
# it has not checked. `$item['quantity']` is matched too, since the value can be
# read straight out of the cart item without ever landing in a variable.
QTY_MATH=$(grep -rInE '\*[[:space:]]*\$[a-z_]*(quantity|qty)|\$[a-z_]*(quantity|qty)[[:space:]]*\*|\*[[:space:]]*\$[a-z_]+\[.?(quantity|qty).?\]|\$[a-z_]+\[.?(quantity|qty).?\][[:space:]]*\*' \
           src --include='*.php' \
           | grep -vE ':[[:space:]]*(\*|//|#)' || true)

if [ -n "$QTY_MATH" ]; then
  fail "the pricing path multiplies by a quantity -- WooCommerce already does (M11.6):"
  echo "$QTY_MATH" | sed 's/^/        /'
  printf '        A line total handed to set_price() is multiplied by quantity again.\n'
else
  pass "no quantity arithmetic in the pricing path (prices stay per unit)"
fi

# --- The frozen deltas have exactly one trust gate ---------------------------
#
# `Keys::CART_ITEM_DELTAS` holds a price the customer was quoted, and it is only
# meaningful when its signature verifies AND it covers the line's selections.
# `CartItemPayload::trusted_deltas()` answers both questions in one place.
#
# Every consumer must ask it. Reading the sub-key directly, or asking the weaker
# `frozen_deltas()`, gives a different answer to the same question -- and this
# project has now shipped that defect **four times in four stages**:
#
#   Stage 3  the pricing path itself, before the freeze was read at all
#   Stage 6  the order recorded a 20.00 delta on a line charged 179.00
#   Stage 7  the cart breakdown would have shown (+20.00) beside that same line
#   audit    the Stage 6 fix used frozen_deltas(), so it caught only three of
#            the four cases -- signed-but-incomplete slipped through
#
# Each was found by measuring a different surface, never by the tests. So the
# rule is a gate rather than a convention: only `CartItemPayload` may touch the
# sub-key, and only through the one method.
DELTA_READERS=$(grep -rn "CART_ITEM_DELTAS" src --include='*.php' \
                | grep -vE ':[[:space:]]*(\*|//|#|/\*)' \
                | grep -vE '^src/(Support/Keys|Integration/CartItemPayload|Integration/CartItemData)\.php:' || true)

FROZEN_CALLERS=$(grep -rn "frozen_deltas(" src --include='*.php' \
                 | grep -vE ':[[:space:]]*(\*|//|#|/\*)' \
                 | grep -v '^src/Integration/CartItemPayload\.php:' || true)

if [ -n "$DELTA_READERS" ]; then
  fail "the frozen deltas are read outside CartItemPayload:"
  echo "$DELTA_READERS" | sed 's/^/        /'
  printf '        A second reader is a second answer. Ask trusted_deltas().\n'
elif [ -n "$FROZEN_CALLERS" ]; then
  fail "frozen_deltas() is called outside CartItemPayload:"
  echo "$FROZEN_CALLERS" | sed 's/^/        /'
  printf '        It verifies the signature but not that the deltas cover the\n'
  printf '        line. Use trusted_deltas(), which checks both.\n'
else
  pass "the frozen deltas have one trust gate (CartItemPayload::trusted_deltas)"
fi

# --- Every hook-registering class is actually registered ---------------------
#
# The reachability check below asks whether a class is *referenced*. That is not
# the same as being *wired*, and the difference is invisible: deleting the
# `->register()` line for `CheckoutValidator`, `OrderLineItem` or `CartItemKey`
# left the `use` statement and the container factory in place, so reachability
# passed, every test passed, and the feature silently stopped running in
# production. Measured, all three.
#
# A class whose `register()` attaches WordPress hooks does nothing at all unless
# someone calls it. So: if a class has a `register()` method and that method
# mentions `add_action` or `add_filter`, `Plugin.php` must call it.
#
# Comment lines are stripped before matching, because a docblock explaining a
# registration is not a registration -- the failure this project has now shipped
# five times.
HOOK_CLASSES=''
UNREGISTERED=''

while IFS= read -r file; do
  class=$(basename "$file" .php)

  # Only classes that attach hooks in register(). Comments excluded first.
  body=$(grep -vE '^[[:space:]]*(\*|//|#|/\*)' "$file")

  case "$body" in
    *'public function register()'*) ;;
    *) continue ;;
  esac

  case "$body" in
    *add_action*|*add_filter*) ;;
    *) continue ;;
  esac

  HOOK_CLASSES="${HOOK_CLASSES}${class} "

  # Called via the container, or constructed inline with arguments.
  if grep -vE '^[[:space:]]*(\*|//|#|/\*)' src/Plugin.php \
     | grep -qE "(${class}::class \)|new ${class}\()[^;]*->register\(\)"; then
    continue
  fi

  UNREGISTERED="${UNREGISTERED}${class}\n"
done < <(find src -name '*.php' -type f)

HOOK_COUNT=$(printf '%s' "$HOOK_CLASSES" | wc -w | tr -d ' ')

# A floor, so a broken matcher that finds nothing fails instead of passing.
if [ "$HOOK_COUNT" -lt 10 ]; then
  fail "found only $HOOK_COUNT hook-registering class(es) -- the matcher is stale"
elif [ -n "$UNREGISTERED" ]; then
  fail "class attaches hooks in register() but Plugin.php never calls it:"
  printf "%b" "$UNREGISTERED" | sed 's/^/        /'
  printf '        The class is referenced, so reachability passes -- and the feature\n'
  printf '        never runs. Tests pass too: they call register() themselves.\n'
else
  pass "all $HOOK_COUNT hook-registering class(es) are wired in Plugin.php"
fi

# --- Reachability: every class is referenced by production code -------------
#
# `[8k]` shipped three correct, well-tested classes that **nothing could reach**:
# no container registration, no caller, no UI. Every gate passed — the
# architecture guards check layering, PHPCS checks style, and the unit tests
# passed because they call the classes directly.
#
# Worse, the coverage floor *rewarded* it: it counts the classes a test imports,
# so testing an unwired class raises the number. A merchant could not connect a
# store, and nothing said so.
#
# A class referenced only by its own file and its tests is either dead or not
# wired yet. Both are worth failing on: the second is a step reporting itself
# finished before it is.
UNREACHABLE=""
while IFS= read -r file; do
  class=$(basename "$file" .php)

  # Interfaces are referenced by their implementors' `implements` clause and by
  # type hints; both count, so no special case is needed. Autoloader and Plugin
  # are the entry points — nothing in src/ refers to them by design.
  # Autoloader and Plugin are entry points; nothing in src/ names them by design.
  #
  # `Money` is the one deliberate exception: a value object built in Phase 3 for
  # pricing that arrives in Phase 9. It is listed by name rather than by a
  # pattern, so it expires the moment someone asks why it is here — an exemption
  # that cannot quietly widen.
  #
  # `Pricing` was exempted here through Stage 5, on a fuse marked DELETE IN
  # STAGE 6. Stage 6 gave it its caller -- `Engine\SelectionResolver` sums the
  # resolved deltas, which is M11.5's "recompute price from cached config" --
  # and the exemption was removed. The gate passed without it, which is the
  # evidence that the class was pending rather than dead.
  #
  # `RuleEvaluator` is exempted on the same terms, with the same kind of fuse.
  # M17.6 builds it and proves it against the shared `rule-fixtures.json`, which
  # both languages now execute; its caller arrives in **17-8**, where
  # `SelectionResolver::resolve()` is restructured so rules run BEFORE selections
  # are validated — because whether a submitted value is legal depends on the
  # rule outcome.
  #
  # ⚠️ **DELETE THIS LINE IN 17-8.** If the gate then passes without it, the
  # class was pending rather than dead — which is exactly the evidence `Pricing`
  # produced when its own exemption was removed in Stage 6. If it still fails,
  # 17-8 did not actually wire the evaluator and the gate is right.
  case "$class" in
    Autoloader|Plugin) continue ;;
    Money) continue ;;
    RuleEvaluator) continue ;;
  esac

  # Referenced anywhere in src/, the entry file, **or a template** other than
  # its own?
  #
  # `optionia.php` is where WordPress hooks are registered, so a class reachable
  # only from `register_deactivation_hook` lives there and nowhere else — as
  # `Activation\Deactivator` does. Scanning src/ alone reported it dead.
  #
  # `templates/` is here for the same reason, one directory over: templates are
  # `include`d rather than called, so a view helper used by every option
  # template and by nothing in src/ looked dead while being on every product
  # page — as `Frontend\OptionView` was. A gate that reports a wired class as
  # dead teaches people to add a fake reference to silence it, which is worse
  # than the gap it was closing.
  if ! grep -rqE "(^|[^A-Za-z_])${class}(::|\(|;|,|\)|\s|$)" src optionia.php templates \
       --include='*.php' --exclude="$(basename "$file")" 2>/dev/null; then
    UNREACHABLE="${UNREACHABLE}${file}\n"
  fi
done < <(find src -name '*.php' -type f)

if [ -n "$UNREACHABLE" ]; then
  fail "class is not referenced by any other source file — dead, or built but not wired:"
  printf "%b" "$UNREACHABLE" | sed 's/^/        /'
else
  pass "every class is reachable from production code"
fi

# --- Autoload discipline ---------------------------------------------------
#
# M8.4: "Token in wp_options, autoload off." That applies to every option this
# plugin writes, not only the credential. WordPress loads all autoloaded options
# on *every request to the entire site* -- a cached config document or a
# heartbeat record left autoloaded is a sitewide performance regression that
# ships silently and is attributed to whatever else changed that week.
#
# Every update_option() call must pass an explicit third argument. The check is
# for a literal `false`, not merely "an argument": passing `true` fails here,
# and passing a variable would too -- there is no reason for this plugin to
# decide autoload at runtime, and a variable is how one accidentally becomes
# `true`.
AUTOLOAD_BAD=0
AUTOLOAD_TOTAL=0

while IFS= read -r file; do
  # Normalise each update_option( ... ) call onto one line, so multi-line calls
  # are checked the same way as single-line ones. Without this, the two calls
  # written across several lines would be invisible to the check.
  # Comments are stripped before the scan, so *prose* is not mistaken for code.
  # A docblock in `ProductIndex.php` explaining why a call passes `false` was
  # itself reported as a violation, because this regex reads file text rather
  # than code -- the same mistake `check-secrets.sh` made with `hash_equals`.
  CALLS=$(perl -0777 -ne 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; while (/update_option\s*\((.*?)\);/gs) { my $a = $1; $a =~ s/\s+/ /g; print "$a
"; }' "$file")

  while IFS= read -r call; do
    [ -z "$call" ] && continue
    AUTOLOAD_TOTAL=$((AUTOLOAD_TOTAL + 1))
    case "$call" in
      *", false"*) ;;
      *) AUTOLOAD_BAD=$((AUTOLOAD_BAD + 1)); echo "        $file: update_option($call)" ;;
    esac
  done <<EOF
$CALLS
EOF
done < <(find src -name '*.php' -type f)

# A check that finds no calls to inspect passes for the wrong reason. The
# plugin writes well over a dozen options; if this collapses, the parser broke.
AUTOLOAD_FLOOR=12

if [ "$AUTOLOAD_TOTAL" -lt "$AUTOLOAD_FLOOR" ]; then
  fail "only $AUTOLOAD_TOTAL update_option call(s) found (floor $AUTOLOAD_FLOOR) — the parser is wrong, not the code"
elif [ "$AUTOLOAD_BAD" -gt 0 ]; then
  fail "$AUTOLOAD_BAD update_option call(s) do not pass autoload=false (listed above)"
else
  pass "all $AUTOLOAD_TOTAL option writes pass autoload=false"
fi

# --- Version consistency ---------------------------------------------------
HEADER_VERSION=$(grep -m1 '^ \* Version:' optionia.php | sed 's/.*Version: *//' | tr -d ' \r')
CONST_VERSION=$(grep -m1 "define( 'OPTIONIA_VERSION'" optionia.php | sed "s/.*'\\([0-9][^']*\\)'.*/\\1/")
if [ "$HEADER_VERSION" != "$CONST_VERSION" ]; then
  fail "plugin header version ($HEADER_VERSION) != OPTIONIA_VERSION ($CONST_VERSION)"
else
  pass "version consistent: $HEADER_VERSION"
fi

# --- AC3: the read path never reaches the network ---------------------------
#
# `Config\Repository` is what a storefront calls. Phase 10 Stage 2 gave it
# `sets_for_product()`, and Stage 4's renderer will call that on every product
# page -- so a network call reachable from here is a customer waiting on
# Optionia, which is exactly what AC3 forbids.
#
# Today the separation holds by construction: the file names no transport at
# all. That is a property of how it happens to be written, and nothing protected
# it. A later `sets_for_product()` that fetched on a cache miss would break AC3
# and pass every other check in this repository -- the failure this codebase
# keeps finding, one layer over.
#
# Matched on the transports rather than a list of files, so a new way to reach
# the network is caught without anyone remembering to extend this.
NETWORK='wp_remote_|Api\\Client|FetchesFromCloud|curl_|file_get_contents\s*\(\s*.https'

# Files a storefront render reaches.
#
# Two named explicitly -- `Repository` owns the read API and `ProductIndex` is
# what it delegates to -- plus **every file that calls `sets_for_product()`**,
# discovered rather than listed.
#
# The discovery is the point. A hand-maintained list covers the code that
# existed when someone last remembered to edit it: an audit found that a
# renderer calling `Api\Client` passed this check purely because its file was
# not named here, while Principle 2 and the runtime guard caught it. That is a
# deferred obligation with nothing enforcing it -- the pattern M9.4b was written
# about -- and Phase 10 Stage 4 adds exactly such a file.
#
# The markers are the read methods a storefront calls: `sets_for_product()` for
# the ids and `option_sets_for_product()` for their content. Phase 10 Stage 4
# added the second, and matching only the first missed `Frontend\Renderer`
# entirely -- the very file this gate exists to protect. Both are matched now,
# and the pattern is anchored on the shared suffix so a third reader is caught
# without editing this.
#
# `index_entry_count()` and `index_skipped_count()` are deliberately *not*
# markers: `Admin\SystemStatus` reads those, and it is an admin screen, not a
# render.
RENDER_PATH='src/Config/Repository.php src/Config/ProductIndex.php'

CALLERS=$(grep -rlE '(->|::)[a-z_]*sets_for_product\s*\(' src --include='*.php' 2>/dev/null || true)

for caller in $CALLERS; do
  case " $RENDER_PATH " in
    *" $caller "*) ;;
    *) RENDER_PATH="$RENDER_PATH $caller" ;;
  esac
done

RENDER_BAD=''
RENDER_COUNT=0

for file in $RENDER_PATH; do
  if [ ! -f "$file" ]; then
    fail "$file is named in the AC3 render path but does not exist -- the list is stale, not the code"
    continue
  fi

  RENDER_COUNT=$((RENDER_COUNT + 1))

  # Comments stripped first. `Repository` explains *why* it holds no transport,
  # and prose describing a rule must not satisfy the rule -- the mistake
  # `check-secrets.sh` made with `hash_equals` and this file made with
  # `update_option`.
  if perl -0777 -ne 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; exit(1) if /'"$NETWORK"'/' "$file"; then
    :
  else
    RENDER_BAD="$RENDER_BAD $file"
  fi
done

# A gate that inspects no files passes for the wrong reason.
FLOOR_RENDER=2

if [ "$RENDER_COUNT" -lt "$FLOOR_RENDER" ]; then
  fail "only $RENDER_COUNT render-path file(s) inspected (floor $FLOOR_RENDER) -- the list is wrong, not the code"
elif [ -n "$RENDER_BAD" ]; then
  fail "AC3: the storefront read path can reach the network:$RENDER_BAD"
  printf '        A product page must be served from cache. Nothing a renderer\n'
  printf '        calls may fetch, however it degrades on failure.\n'
else
  pass "all $RENDER_COUNT render-path file(s) are free of network access (AC3)"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d architecture check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll architecture checks passed.\033[0m\n'
