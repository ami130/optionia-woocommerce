#!/usr/bin/env bash
#
# No migration names its own charset or collation.
#
# ## Why this exists
#
# 🔴 **One table out of 36 pinned a collation, and it broke every CI run for
# eight days.** `1790100000000-OptionViewCounts.ts` created its table with
# `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`; every other table in
# this schema takes the database default. MySQL refuses a foreign key between
# columns whose collations differ:
#
#     Referencing column 'storeId' and referenced column 'id' in foreign key
#     constraint 'fk_option_view_counts_store' are incompatible.
#
# ⚠️ **It passed locally and failed only in CI, which is why it survived.** A
# development database created with `utf8mb4_unicode_ci` as its default gives
# `stores.id` that collation too, so the pin agreed with its neighbour by luck.
# CI's `mysql:8.4` service uses the server default, `utf8mb4_0900_ai_ci`, and
# the constraint is rejected. Reproduced on a probe database with CI's
# collation: the old migration fails with that exact error, the fixed one
# completes all 27 migrations and 39 tables.
#
# ## What is checked
#
# Any `CHARSET=` or `COLLATE=` in a migration. Not a heuristic — the correct
# number is zero, because a table that names its own disagrees with the rest the
# moment a server default changes.
#
# 📌 **Column-level `COLLATE` is caught too.** A single column pinned the same
# way produces the identical failure, and is harder to spot by eye.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$ROOT/optioniaWooCommerceBackend/src/migrations"
FAILED=0

pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILED=$((FAILED + 1)); }

printf 'Checking migrations name no charset or collation…\n'

if [ ! -d "$MIGRATIONS" ]; then
  fail "no migrations directory — this gate's path is stale"
else
  # 🔴 **Matched line-by-line over the whole tree, never file-by-file through a
  # shell variable.** The first version of this gate collected filenames into
  # `OFFENDERS` and looped `for file in $OFFENDERS` — which word-splits on
  # spaces, and this repository lives in a directory called
  # `optionia woocommerce`. Every path split in two, neither half existed, and
  # the gate reported "none" while the defect sat on disk. Caught by
  # reintroducing the original defect and watching the gate stay green.
  #
  # `|| true`: grep exits 1 on no match, and `set -u` with a bare pipeline would
  # end the script there — the silent-abort failure this suite has hit before.
  #
  # A migration may *describe* the rule in prose; only SQL is a finding, so
  # comment lines (`*` or `//` once trimmed) are dropped. `grep -r` prefixes
  # each hit with `path:line:`, and the path may itself contain a colon-free
  # space, so the comment filter matches on what follows the line number.
  REAL=$(grep -rniE 'charset=|collate=' "$MIGRATIONS" --include='*.ts' 2>/dev/null \
    | grep -vE ':[0-9]+: *\*' \
    | grep -vE ':[0-9]+: *//' || true)

  if [ -z "$REAL" ]; then
    COUNT=$(ls "$MIGRATIONS"/*.ts 2>/dev/null | wc -l | tr -d ' ')
    pass "none of the $COUNT migration(s) pins a charset or collation"
  else
    fail "a migration pins a charset or collation — a foreign key to another table will be refused"
    printf '%b' "$REAL" | sed 's/^/        /' | head -8
  fi
fi

if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32mAll migration collation checks passed.\033[0m\n'
else
  printf '\n\033[31m%d migration collation check(s) failed.\033[0m\n' "$FAILED"
fi

exit "$FAILED"
