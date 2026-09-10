#!/usr/bin/env bash
#
# Cross-repository fixture parity.
#
# ## Why this exists, and why it is not a CI gate
#
# `bin/check-shared-fixtures.sh` runs inside each repository and asserts that
# its own copy of a shared fixture matches a pinned hash. That catches drift by
# **omission** -- someone edits one copy and forgets the other, and the build
# fails where the edit was made.
#
# It does not catch drift by **commission**. Change the fixture *and* the pinned
# hash in one repository and both builds stay green while the two files differ,
# which is precisely the failure the mechanism exists to prevent. Measured
# 2026-08-31: backend fixture and `EXPECTED_SHA` both updated, plugin untouched,
# and both gates reported success.
#
# No CI gate can close that. Each workflow checks out **one** repository -- every
# `actions/checkout` in both is bare, verified -- so a run has nothing to compare
# against that the repository under test cannot also rewrite. A network fetch
# would trade a silent failure for a flaky one.
#
# What *can* close it is this: the working tree that holds all three repositories
# is the only place both copies exist at once, and it is where a divergence is
# actually created. So the check lives here, and it compares the files rather
# than trusting either repository's account of them.
#
# Run before committing a fixture change:
#
#   bash bin/check-fixture-parity.sh
#
# Two controls remain beyond it, and are worth naming because neither is
# mechanical: a pinned hash changing is a **visible diff on a reviewed line**,
# and a fixture change that is not mirrored fails the *other* repository's build
# the next time it runs.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

PLUGIN_DIR='optioniaWooCommercePlugin/tests/fixtures/shared'
BACKEND_DIR='optioniaWooCommerceBackend/test/fixtures/shared'

FAILURES=0

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  printf '\033[32mok\033[0m    %s\n' "$1"
}

if [ ! -d "$PLUGIN_DIR" ] || [ ! -d "$BACKEND_DIR" ]; then
  fail "a shared fixture directory is missing -- this check must run from the working tree that holds both repositories"
  echo
  printf '\033[31m%d parity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

# Every shared file the plugin holds must exist in the backend and match byte for
# byte. Discovered rather than listed: a file added to one repository and not the
# other is exactly the drift this is looking for, and a hand-maintained list
# would not know about it.
#
# Every file, not only `*.json`. `PRICING-SPEC.md` is normative for **both**
# implementations, so a paragraph edited on one side and not the other is the
# same failure as an edited fixture — and the more dangerous kind, because prose
# disagreeing is harder to notice than a number.
COUNT=0

for file in "$PLUGIN_DIR"/*; do
  [ -e "$file" ] || continue

  NAME=$(basename "$file")
  OTHER="$BACKEND_DIR/$NAME"
  COUNT=$((COUNT + 1))

  if [ ! -f "$OTHER" ]; then
    fail "$NAME exists in the plugin but not the backend"
    continue
  fi

  if ! cmp -s "$file" "$OTHER"; then
    fail "$NAME differs between the two repositories"
    printf '        plugin  %s\n' "$(shasum -a 256 "$file" | awk '{print $1}')"
    printf '        backend %s\n' "$(shasum -a 256 "$OTHER" | awk '{print $1}')"
  fi
done

# And the reverse direction: a file the backend holds alone is drift too.
for file in "$BACKEND_DIR"/*; do
  [ -e "$file" ] || continue

  NAME=$(basename "$file")

  if [ ! -f "$PLUGIN_DIR/$NAME" ]; then
    fail "$NAME exists in the backend but not the plugin"
  fi
done

# A check that compares no files passes for the wrong reason.
FLOOR=3

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "only $COUNT shared fixture(s) compared (floor $FLOOR) -- the search is wrong, not the code"
fi

# Both repositories pin a hash for each fixture. They must pin the *same* one:
# two gates agreeing with their own files while disagreeing with each other is
# the failure this whole script is about.
PLUGIN_PINS=$(grep -oE "EXPECTED[A-Z_]*_SHA='[a-f0-9]+'" optioniaWooCommercePlugin/bin/check-shared-fixtures.sh | sort)
BACKEND_PINS=$(grep -oE "EXPECTED[A-Z_]*_SHA='[a-f0-9]+'" optioniaWooCommerceBackend/bin/check-shared-fixtures.sh | sort)

if [ -z "$PLUGIN_PINS" ] || [ -z "$BACKEND_PINS" ]; then
  fail "could not read the pinned hashes from one of the gates -- the pattern is wrong, not the code"
elif [ "$PLUGIN_PINS" != "$BACKEND_PINS" ]; then
  fail "the two gates pin different hashes"
  printf '        plugin:\n%s\n' "$(printf '%s\n' "$PLUGIN_PINS" | sed 's/^/          /')"
  printf '        backend:\n%s\n' "$(printf '%s\n' "$BACKEND_PINS" | sed 's/^/          /')"
else
  pass "both gates pin the same hashes"
fi

# The gates themselves must not diverge either. One repository lowering its own
# `FLOOR_CASES` from twelve to one is invisible to the other -- measured, and a
# weaker gate is a quieter one rather than a broken one, which is worse.
#
# Compared with the fixture paths normalised away, since those legitimately
# differ: the plugin keeps fixtures under `tests/`, the backend under `test/`.
#
# SUITE_ROOT is normalised for the same reason, and it is a *different* reason
# from the fixture path: the backend colocates its specs with the source they
# test, so its suites live in `src/` while its fixtures live in `test/`. The two
# paths are genuinely independent, which is why neither can be derived from the
# other. Only the assignment line is normalised -- every use of the variable
# still has to match, so a gate that searched the wrong tree would be caught.
NORMALISE_GATE="s|tests\{0,1\}/fixtures/shared|SHARED|g; s|^SUITE_ROOT=.*|SUITE_ROOT=SUITES|"
PLUGIN_GATE=$(sed "$NORMALISE_GATE" optioniaWooCommercePlugin/bin/check-shared-fixtures.sh)
BACKEND_GATE=$(sed "$NORMALISE_GATE" optioniaWooCommerceBackend/bin/check-shared-fixtures.sh)

if [ "$PLUGIN_GATE" != "$BACKEND_GATE" ]; then
  fail "the two gate scripts differ beyond their fixture paths"
  printf '        One repository has changed its own checks. Diff them:\n'
  printf '        diff optioniaWooCommercePlugin/bin/check-shared-fixtures.sh \\\n'
  printf '             optioniaWooCommerceBackend/bin/check-shared-fixtures.sh\n'
else
  pass "both gate scripts are identical apart from their fixture paths"
fi

if [ "$FAILURES" -eq 0 ]; then
  pass "all $COUNT shared fixture(s) are byte-identical across both repositories"
fi

echo

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d parity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll fixture parity checks passed.\033[0m\n'
