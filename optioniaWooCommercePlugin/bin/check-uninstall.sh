#!/usr/bin/env bash
#
# Uninstall completeness gate.
#
#   bash bin/check-uninstall.sh
#
# `uninstall.php` promises to "remove every trace of the plugin". It cannot use
# the autoloader -- WordPress loads it in isolation -- so every option name and
# cron hook is repeated there as a literal. A hand-kept copy drifts, and this
# one did: four options added after the list was written survived uninstall,
# among them a tenant name, plus a daily cron event that would fire forever
# against a plugin no longer installed.
#
# This gate diffs the literals in uninstall.php against the constants in
# Support/Keys.php, so the next option added fails CI rather than leaking.
#
# Two names are deliberately NOT expected:
#   - CRON_SCHEDULE_QUARTER_HOUR is an interval *name*, not a scheduled hook;
#     clearing it would be meaningless.
#   - META_* / OPTION_SET_ID are post and order-item meta, removed by a query
#     rather than delete_option(). They are checked separately below.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

KEYS="src/Support/Keys.php"
UNINSTALL="uninstall.php"
FAILED=0

ok()   { printf '\033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILED=$((FAILED + 1)); }

for f in "$KEYS" "$UNINSTALL"; do
  [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

# --- Options -----------------------------------------------------------------

# `\bOPTION_` anchors on a word boundary so META_OPTION_SET_ID does not match
# on its tail, and the value pattern requires a leading letter: meta keys are
# `_optionia_*` by WordPress convention (the underscore hides them from the
# custom-fields UI), which is what separates them from options here.
EXPECTED_OPTIONS=$(grep -oE "\bOPTION_[A-Z_]+ *= *'[a-z][a-z_]*'" "$KEYS" \
  | grep -oE "'[a-z][a-z_]*'" | tr -d "'" | sort -u)

MISSING_OPTIONS=""
COUNT_OPTIONS=0
for option in $EXPECTED_OPTIONS; do
  COUNT_OPTIONS=$((COUNT_OPTIONS + 1))
  grep -q "'${option}'" "$UNINSTALL" || MISSING_OPTIONS="$MISSING_OPTIONS $option"
done

# A gate that inspects nothing passes for the wrong reason. If the grep above
# stops matching -- a refactor to enum-style constants, say -- this catches it
# instead of reporting a clean run over an empty list.
FLOOR_OPTIONS=12
if [ "$COUNT_OPTIONS" -lt "$FLOOR_OPTIONS" ]; then
  fail "found only $COUNT_OPTIONS OPTION_* constants in Keys (floor $FLOOR_OPTIONS) — is the parser still matching?"
elif [ -n "$MISSING_OPTIONS" ]; then
  fail "uninstall.php never deletes:$MISSING_OPTIONS"
  printf '        Add each to the $options array, or uninstall leaves it behind.\n'
else
  ok "all $COUNT_OPTIONS option keys are removed on uninstall"
fi

# --- Cron hooks --------------------------------------------------------------

EXPECTED_HOOKS=$(grep -oE "CRON_[A-Z_]+ *= *'[a-z_]+'" "$KEYS" \
  | grep -vE "CRON_SCHEDULE_" \
  | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)

MISSING_HOOKS=""
COUNT_HOOKS=0
for hook in $EXPECTED_HOOKS; do
  COUNT_HOOKS=$((COUNT_HOOKS + 1))
  grep -q "'${hook}'" "$UNINSTALL" || MISSING_HOOKS="$MISSING_HOOKS $hook"
done

FLOOR_HOOKS=2
if [ "$COUNT_HOOKS" -lt "$FLOOR_HOOKS" ]; then
  fail "found only $COUNT_HOOKS CRON_* hooks in Keys (floor $FLOOR_HOOKS) — is the parser still matching?"
elif [ -n "$MISSING_HOOKS" ]; then
  fail "uninstall.php never clears:$MISSING_HOOKS"
  printf '        A scheduled event outlives the plugin files and fires forever.\n'
else
  ok "all $COUNT_HOOKS cron hooks are cleared on uninstall"
fi

# --- Cron hooks, on deactivation ---------------------------------------------
#
# 🔴 `uninstall.php` is only reached when a merchant *deletes* the plugin.
# Deactivation runs `Activation\Scheduler::clear()`, which enumerates hooks by
# hand -- and until M19.1 nothing checked it. A hook missing there stays
# scheduled on every deactivated install, firing against code WordPress is no
# longer loading, which is the failure `uninstall.php`'s own comment warns of.
#
# The same `EXPECTED_HOOKS` list, because the two must clear the same set: a
# hook worth removing on delete is worth removing on deactivate.
SCHEDULER="src/Activation/Scheduler.php"

if [ ! -f "$SCHEDULER" ]; then
  fail "missing $SCHEDULER"
else
  MISSING_DEACTIVATION=""

  for hook in $EXPECTED_HOOKS; do
    # Matched against the constant, not the string: `clear()` calls
    # `wp_clear_scheduled_hook( Keys::CRON_* )`, never the literal.
    constant=$(grep -oE "CRON_[A-Z_]+ *= *'${hook}'" "$KEYS" | grep -oE "CRON_[A-Z_]+" | head -1)

    if [ -n "$constant" ]; then
      grep -q "wp_clear_scheduled_hook( Keys::${constant} )" "$SCHEDULER" \
        || MISSING_DEACTIVATION="$MISSING_DEACTIVATION $hook"
    fi
  done

  if [ -n "$MISSING_DEACTIVATION" ]; then
    fail "Scheduler::clear() never clears:$MISSING_DEACTIVATION"
    printf '        A deactivated plugin leaves the event firing against unloaded code.\n'
  else
    ok "all $COUNT_HOOKS cron hooks are cleared on deactivation"
  fi
fi

# --- Database tables ---------------------------------------------------------
#
# Same failure mode as the options list, one category over: `uninstall.php`
# names the table to drop as a literal, and nothing checked that the literal
# kept pace with `Keys`. Adding a `TABLE_*` constant without a matching DROP
# passed cleanly -- verified -- which is exactly how four options came to
# survive uninstall before this gate existed.
#
# A leftover table is worse than a leftover option: it is invisible in the
# admin, survives reinstalls, and accumulates rows nobody reads.

EXPECTED_TABLES=$(grep -oE "TABLE_[A-Z_]+ *= *'[a-z_]+'" "$KEYS" \
  | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)

MISSING_TABLES=""
COUNT_TABLES=0
for table in $EXPECTED_TABLES; do
  COUNT_TABLES=$((COUNT_TABLES + 1))
  grep -q "$table" "$UNINSTALL" || MISSING_TABLES="$MISSING_TABLES $table"
done

FLOOR_TABLES=1
if [ "$COUNT_TABLES" -lt "$FLOOR_TABLES" ]; then
  fail "found no TABLE_* constants in Keys (floor $FLOOR_TABLES) — is the parser still matching?"
elif [ -n "$MISSING_TABLES" ]; then
  fail "uninstall.php never drops:$MISSING_TABLES"
  printf '        A leftover table survives reinstalls and is invisible in the admin.\n'
else
  ok "all $COUNT_TABLES table(s) are dropped on uninstall"
fi

# --- Stored files -------------------------------------------------------------
#
# 🔴 **The category this gate did not have.** Options, cron events and tables are
# all database state; `Upload\UploadStore` is the first thing that writes real
# **files** to a merchant's disk. Dropping its table while leaving the bytes
# would look clean in the admin and still carry every customer's artwork
# forever — a disk problem and a data-protection one at once.
#
# The check is deliberately shaped like the others: if the plugin can write to
# an upload directory, `uninstall.php` must contain something that removes it.

if grep -rq "UploadStore" src 2>/dev/null; then
  if grep -q "optionia_delete_upload_files\|optionia-uploads-" "$UNINSTALL"; then
    ok "stored upload files are removed on uninstall"
  else
    fail "src/ writes uploads, and uninstall.php removes no files"
    printf '        Dropping the table leaves every customer file on the disk.\n'
  fi
else
  ok "no upload storage in src/ (nothing to clean)"
fi

# --- Post meta, and why ORDER meta is deliberately excluded ------------------
#
# Post meta attached to *products* or *posts* is plugin data: it exists because
# the plugin exists, and uninstalling should take it away.
#
# **Order item meta is not, and must never be deleted.** An order is a business
# record. The options on a line are what the merchant sold and what they may
# still have to fulfil, refund or account for -- possibly years later, possibly
# under a legal obligation the plugin knows nothing about. Removing a plugin is
# not a statement about past orders, and a merchant who uninstalls Optionia
# should still be able to read what order #1025 was for.
#
# So `Integration\OrderLineItem` writes order item meta and `uninstall.php`
# leaves it alone, on purpose. Decided 2026-09-01 in Stage 6.
#
# Comment lines are stripped before matching. Measured: this check failed on a
# *docblock* mentioning `wc_add_order_item_meta()` while explaining why the CRUD
# API is used instead -- prose describing the very thing the rule looks for. That
# is the fifth time this project has shipped a gate that reads documentation
# instead of code (`check-secrets`/`hash_equals`, the architecture gate's
# `update_option`, the float rule, the arity headroom, now this).

# A sixth instance, found 2026-09-01 while adding M12.7: this gate matched only
# the *WordPress* meta functions. `Reporting\OrderReporter` writes its reported
# marker through `$order->update_meta_data()`, WooCommerce's CRUD API -- which
# lands in `postmeta` under legacy storage and `wc_orders_meta` under HPOS, and
# which this check could not see at all.
#
# That specific write is correctly exempt: it is *order* meta, and the paragraph
# above is why order meta is kept. But a future `$product->update_meta_data()`
# would be plugin data, would need cleanup, and would have passed silently. So
# the CRUD calls are counted too, with the order objects excluded by name rather
# than by being invisible.
# Matched as an actual method *call* -- `->update_meta_data(` -- rather than as
# the bare name. `method_exists( $order, 'update_meta_data' )` is a capability
# check, not a write, and counting it flagged two guards as data to clean up.
CRUD_META=$(grep -rnE '\->(update|add)_meta_data\(' src/ 2>/dev/null \
            | grep -vE ':[[:space:]]*(\*|//|#|/\*)' \
            | grep -vE '\$(order|item)->' \
            | wc -l | tr -d ' ')

META_WRITERS=$(grep -rn "update_post_meta\|add_post_meta" src/ 2>/dev/null \
               | grep -vE ':[[:space:]]*(\*|//|#|/\*)' \
               | wc -l | tr -d ' ')

META_WRITERS=$(( META_WRITERS + CRUD_META ))

if [ "$META_WRITERS" -gt 0 ]; then
  if grep -q "postmeta" "$UNINSTALL"; then
    ok "post meta is written and uninstall cleans it up"
  else
    fail "src/ writes post meta but uninstall.php never deletes any"
    printf '        %s call site(s) write post meta; add a postmeta cleanup query.\n' "$META_WRITERS"
  fi
else
  ok "no cleanable post meta written (order meta is kept by design)"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  printf '\033[31m%d uninstall check(s) failed.\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32mAll uninstall checks passed.\033[0m\n'
