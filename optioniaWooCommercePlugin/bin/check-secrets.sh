#!/usr/bin/env bash
#
# AC8 gate: no SaaS secret ever ships inside the plugin.
#
#   bash bin/check-secrets.sh
#
# The plugin is distributed source. Every merchant who installs it can read
# every line, so a shared secret baked in here is a secret published to every
# customer at once -- and it cannot be rotated without shipping a release.
#
# The architecture is built to make this structurally true: the plugin holds a
# per-store credential it obtained itself through the PKCE handshake, and never
# a credential shared between stores. This gate is what keeps that true after
# the architecture is no longer fresh in anyone's mind.
#
# AC8 was verified by hand three times during Phase 8 and was correct each
# time. A criterion nothing enforces is one nobody notices breaking.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

# Every file git would ship, not only the PHP.
#
# An earlier version scanned `*.php` alone and reported "36 shipped files
# scanned", which sounded thorough and was a subset: a key planted in
# `assets/js/admin.js` passed cleanly. JS is the *worse* place for one --
# PHP at least executes server-side, while a key in an admin script is served
# to every browser that opens the page.
#
# Excluded, deliberately:
#   - `tests/`   fixtures are fake by definition and must stay readable
#   - `bin/`     this scanner's own patterns would match themselves
#   - lock files vendor hashes are long opaque strings by nature, and are not
#                secrets; scanning them is pure false-positive noise
# `--cached --others --exclude-standard`, not plain `git ls-files`.
#
# Plain `ls-files` lists **tracked** files only, so every file added since the
# last commit is invisible to this gate — measured at six production files,
# including the push signature verifier, all unscanned. A secret is most likely
# to be introduced in new code, which is exactly what was being skipped.
#
# `--others --exclude-standard` adds untracked files while still honouring
# `.gitignore`, so `vendor/` and build output stay out.
FILES=$(git ls-files --cached --others --exclude-standard 2>/dev/null \
        | grep -vE '^tests/|^bin/|^composer\.lock$|^package-lock\.json$' \
        || true)

if [ -z "$FILES" ]; then
  fail "no shipped files found to scan — is this a git checkout?"
  echo
  printf '\033[31m%d secret check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')

# A gate that scans nothing passes for the wrong reason. If this count
# collapses, the file list broke rather than the code becoming clean.
FLOOR=40
if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "only $COUNT shipped file(s) scanned (floor $FLOOR) — the file list is wrong, not the code"
fi

# --- 1. Credential-shaped assignments ----------------------------------------
#
# `Keys.php` is exempted for snake_case values only, and nowhere else is.
#
# That file is the registry of every option, meta and cron name in the plugin,
# so `OPTION_STORE_TOKEN = 'optionia_store_token'` is a wp_options row name,
# not a credential. Exempting the *shape* everywhere was the obvious move and
# was wrong: `sk_live_9f8a7b6c5d4e3f2a1b0c` is also lowercase snake_case, so a
# real Stripe-style key passed cleanly. Location distinguishes them where shape
# cannot -- a secret hardcoded in the name registry would be absurd, and one
# anywhere else is still caught.
#
# The value must be at least 16 characters. Real credentials clear that easily
# (`sk_live_...` 28, a GitHub PAT 40, an AWS key 20); short constants like
# `CART_ITEM_KEY = 'optionia'` do not, and an 8-character floor flagged those
# as secrets -- noise that trains people to ignore the gate.
#
# `pass` is matched separately from `password`: the sibling project's mail
# credential was named SMTP_PASS and a scanner looking only for `password`
# waved a real Gmail app password straight through.
#
# The optional quote before the separator matters as much. PHP config is
# written as `'api_key' => 'k_live_...'`, and a pattern expecting the name to
# sit flush against `=>` sees the key's own closing quote and misses every
# array-style secret -- which is most of them.
#
# Placeholders are allowed through: anything with x's, "your", "example",
# "changeme" and the like is a stand-in, not a secret.
#
# Note what is NOT excluded. An earlier version here also skipped any line
# containing a PHP variable, meaning to ignore `= $config`. It matched the
# variable being *assigned to* as well, so `private $pass = "real-secret";`
# was waved through -- the precise shape that leaked in the sibling project.
# The literal is what matters; a quoted value is a secret whatever the line
# around it looks like.
ASSIGN=$(grep -rniE \
  "(secret|password|passwd|[^a-z_]pass|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|[a-z0-9]_key|[a-z0-9]_token|[a-z0-9]_secret)['\"]?[[:space:]]*(=>|=|:)[[:space:]]*['\"][^'\"]{16,}['\"]" \
  $FILES 2>/dev/null \
  | grep -viE "xxx|your[_-]|example|changeme|placeholder|redact|dummy|sample" \
  | grep -vE "^src/Support/Keys\.php:.*= *['\"][a-z][a-z0-9_]*['\"] *;" || true)

if [ -n "$ASSIGN" ]; then
  fail "credential-shaped literal in shipped source:"
  printf '%s\n' "$ASSIGN" | sed 's/^/        /'
else
  pass "no credential-shaped assignments in $COUNT shipped file(s)"
fi

# --- 2. Long opaque literals -------------------------------------------------
#
# A baked key need not be named like one. Anything long, high-entropy and
# quoted is worth a human look -- API keys, PEM blocks, base64 blobs.
#
# The plugin's own generated values (PKCE verifiers, nonces) are produced at
# runtime, never written as literals, so a match here is genuinely unusual.
#
# The run must contain lower, upper AND a digit: comment dividers, kebab-case
# names and prose cannot satisfy all three, while base64 and hex keys do. `/`
# is excluded from the run so a long filesystem path is not mistaken for a
# blob -- a real key broken by a slash is still caught by its two halves.
#
# `vendor/package` names in composer.json are exempted by shape, not by
# skipping the file: a long dependency name is not a key, but a long *value*
# in composer.json still is one -- an `extra.something` holding a token would
# still be caught.
OPAQUE=$(grep -rnE "[A-Za-z0-9+=]{40,}" $FILES 2>/dev/null \
  | grep -E "[a-z]" | grep -E "[A-Z]" | grep -E "[0-9]" \
  | grep -vE "^composer\.json:.*[a-z-]+/[a-z-]+" || true)

if [ -n "$OPAQUE" ]; then
  fail "long opaque literal — confirm this is not a key:"
  printf '%s\n' "$OPAQUE" | sed 's/^/        /'
else
  pass "no long opaque literals"
fi

# --- 3. Private key blocks ---------------------------------------------------
PEM=$(grep -rn "BEGIN .*PRIVATE KEY\|BEGIN RSA\|BEGIN OPENSSH" $FILES 2>/dev/null || true)

if [ -n "$PEM" ]; then
  fail "private key material in shipped source:"
  printf '%s\n' "$PEM" | sed 's/^/        /'
else
  pass "no private key blocks"
fi

# --- 4. The structural guarantee ---------------------------------------------
#
# The strongest form of AC8 is not "no secret was found" but "there is nowhere
# for one to live". The plugin authenticates with a per-store credential it
# obtained itself; a *shared* client secret would have to be read from
# somewhere, and there is no such constant.
SHARED=$(grep -rnE "define\(\s*['\"]OPTIONIA_(CLIENT_SECRET|API_SECRET|SHARED_SECRET|SIGNING_KEY)" \
  $FILES optionia.php 2>/dev/null || true)

if [ -n "$SHARED" ]; then
  fail "a shared-secret constant exists — AC8 is about there being nowhere to put one:"
  printf '%s\n' "$SHARED" | sed 's/^/        /'
else
  pass "no shared-secret constant is defined"
fi

# --- 5. Secrets are compared in constant time ------------------------------
#
# `hash_equals()` and `===` return the same answer, so no test can tell them
# apart — a mutation swapping one for the other survives every assertion. What
# differs is *timing*: string comparison returns on the first differing byte, so
# its duration leaks how much of a guess was right.
#
# Three comparisons here decide whether a request or a price is genuine: the
# handshake's `state` (`Connection\Callback`), the push signature
# (`Connection\PushSignature`), and the frozen cart payload
# (`Integration\CartItemPayload`). Each is attacker-supplied and compared against
# a secret, which is exactly the shape that must not be timed.
#
# 🔴 **This gate missed the third one for seven stages, and its own comment said
# it could not.** Found 2026-09-01 by mutation: swapping `hash_equals()` for
# `===` in `CartItemPayload::verify()` passed every test *and* this check.
#
# The old pattern discovered verifiers by grepping for `hash_hmac`. The previous
# comment claimed that matched "the variables rather than a list of files, so a
# third comparison added later is caught without anyone remembering to extend
# this" -- but `hash_hmac` **is** a list, of length one. `CartItemPayload` signs
# with `wp_hash()`, WordPress's own keyed hash, so the file was never inspected.
# `FLOOR_VERIFIERS` did not help either: it still found two files, so it caught
# "the parser broke" and could not catch "the codebase grew past the pattern".
#
# Discovery is now the union of two questions, because each covers the other's
# blind spot:
#
#   1. **What signs?**   Any keyed-hash primitive -- `hash_hmac`, `wp_hash`,
#      `wp_salt` -- plus the handshake state. Catches a file that verifies a
#      secret while its comparison is *already* wrong, which usage alone cannot:
#      a file whose only `hash_equals` was mutated away would drop out of a
#      usage-only list and pass by vanishing.
#   2. **What compares safely?**  Any call to `hash_equals()` itself. There is no
#      other reason to reach for it, so this catches a *fourth* signing primitive
#      arriving later without anyone remembering to extend the list above --
#      which is the failure this gate has now actually shipped.
#   3. **What compares unsafely?**  A secret-shaped variable (`$expected`,
#      `$signature`, `$token`, `$digest`, ...) compared with `===` against
#      **another variable**. Questions 1 and 2 together still miss the worst
#      case, measured: a new verifier using an unlisted primitive that compares
#      with `===` has no `hash_equals` call to find and no known primitive to
#      match, so it would pass by being doubly invisible. This finds it by the
#      shape of the mistake itself.
#
#      Compared against a *literal* is deliberately not matched: `'' === $token`
#      is an emptiness check, and four such lines exist today in
#      `CartItemPayload`, `SystemStatus` and `Api\Client`. Requiring a variable
#      on both sides distinguishes them with no false positives.
#
# Ordinary hashing is deliberately not matched. `Integration\CartItemKey` calls
# `md5()` to reproduce WooCommerce's cart-id algorithm; that is not a secret and
# compares nothing.
SECRET_NAMES='expected|signature|token|secret|digest|hmac|hash|state'

VERIFIERS=$(printf '%s\n' \
  "$(grep -rlE 'hash_hmac|wp_hash|wp_salt|pending\[.state.\]' \
      $(printf '%s\n' "$FILES" | grep -E '\.php$') 2>/dev/null || true)" \
  "$(grep -rlE 'hash_equals[[:space:]]*\(' \
      $(printf '%s\n' "$FILES" | grep -E '\.php$') 2>/dev/null || true)" \
  "$(grep -rlE "\\\$($SECRET_NAMES)[A-Za-z_]*[[:space:]]*(===|!==)[[:space:]]*\\\$|\\\$[A-Za-z_][A-Za-z0-9_]*[[:space:]]*(===|!==)[[:space:]]*\\\$($SECRET_NAMES)" \
      $(printf '%s\n' "$FILES" | grep -E '\.php$') 2>/dev/null || true)" \
  | grep -v '^$' | sort -u)

# Comments are stripped before inspection.
#
# The first version of this check grepped the file for `hash_equals`, which a
# docblock saying "`hash_equals`, never `===`" satisfies just as well as the
# call does. A mutation swapping the real comparison for `===` passed this gate
# because the prose describing the rule was still there — the check was reading
# the documentation instead of the code.
strip_comments() {
  # Drops `//` and `#` line comments, and every line inside a `/* */` block
  # (including its continuation lines, which begin with `*`). Only code remains.
  sed -e 's://.*::' -e 's:^[[:space:]]*[*/].*::' -e 's:#.*::' "$1"
}

UNSAFE=''
for verifier in $VERIFIERS; do
  CODE=$(strip_comments "$verifier")

  # A file that DERIVES from a salt but compares nothing is not a verifier.
  #
  # ⚠️ **Narrowed 2026-09-08, and narrowed as little as possible.** `Upload\
  # UploadStore` hashes `wp_salt()` into an unguessable *directory name*, and
  # `uninstall.php` recomputes that same name to delete the directory. Neither
  # compares an attacker-supplied value against a secret — there is nothing to
  # time — so demanding `hash_equals()` of them would mean adding a meaningless
  # call, and a gate that forces meaningless calls teaches people to satisfy it
  # rather than read it.
  #
  # The exemption is deliberately narrow: it applies only when the file contains
  # **no comparison at all** between two variables and no `hash_equals` — that
  # is, when it demonstrably verifies nothing. A file that grows a comparison
  # later stops matching this and is inspected again, which is the property that
  # makes the exemption safe rather than a hole.
  if ! printf '%s\n' "$CODE" | grep -qE 'hash_hmac|wp_hash|pending\[.state.\]'; then
    if ! printf '%s\n' "$CODE" | grep -qE '\$[A-Za-z_][A-Za-z0-9_]*[[:space:]]*(===|!==)[[:space:]]*\$'; then
      continue
    fi
  fi

  # A file discovered **only because a comment mentions `hash_equals`** is not a
  # verifier.
  #
  # ⚠️ **Narrowed 2026-09-08, after a first attempt opened a hole.**
  # `Upload\UploadContent` compares a file's first bytes against a magic string
  # (`%PDF-`) and explains in a comment why constant-time comparison is
  # unnecessary. Discovery greps the **raw** file, so that comment enrolled it —
  # the gate reading documentation as code, the failure its own header warns
  # about, arriving from the other direction.
  #
  # ✏️ **The first fix counted comparisons against constant-assignments and
  # exempted the file wholesale.** Measured: adding `$head === $secret` to that
  # same file then passed. Counting is the wrong shape — one exempt comparison
  # cannot vouch for another.
  #
  # This exempts on **discovery**, not on content: if the only reason a file was
  # picked up is a `hash_equals` mention that is *not* a call, and it signs
  # nothing, it was never a verifier. Every real verifier calls `hash_equals()`
  # in code and is unaffected, and a file that later compares a secret is still
  # caught by the `===` rule below.
  if ! printf '%s\n' "$CODE" | grep -qE 'hash_hmac|wp_hash|hash_equals[[:space:]]*\(' \
     && grep -qE 'hash_equals' "$verifier" \
     && ! printf '%s\n' "$CODE" | grep -qE "\\\$($SECRET_NAMES)[A-Za-z_]*[[:space:]]*(===|!==)|(===|!==)[[:space:]]*\\\$($SECRET_NAMES)[A-Za-z_]*"; then
    continue
  fi

  # Must actually call it, not merely mention it in a comment.
  printf '%s\n' "$CODE" | grep -qE 'hash_equals[[:space:]]*\(' \
    || { UNSAFE="$UNSAFE $verifier(no-hash_equals-call)"; continue; }

  # And no `===` between two *variables* in a file that verifies a secret.
  #
  # Comparing a variable to a literal (`'' === $credential`, `null === $pending`)
  # is an emptiness check, not a secret comparison, and is fine. Comparing two
  # variables in one of these files is the shape that must be constant-time —
  # it catches a file that keeps a decorative `hash_equals` call while the
  # comparison that actually decides the request is a plain string equality.
  printf '%s\n' "$CODE" \
    | grep -qE '\$[A-Za-z_][A-Za-z0-9_]*[[:space:]]*(===|!==)[[:space:]]*\$[A-Za-z_]' \
    && UNSAFE="$UNSAFE $verifier(=== between two variables)"
done

COUNT_VERIFIERS=$(printf '%s\n' "$VERIFIERS" | grep -c . || true)

# A gate that finds no verifiers passes for the wrong reason. Three files verify
# a secret today: the handshake `state` check, the push signature, and the
# frozen cart payload.
#
# The floor is raised with the count deliberately. It cannot detect a *new*
# verifier the pattern fails to see -- that is what the two-question discovery
# above is for -- but it does catch the pattern silently matching fewer files
# than it did, which is how a regression in this gate would look.
FLOOR_VERIFIERS=3

if [ "$COUNT_VERIFIERS" -lt "$FLOOR_VERIFIERS" ]; then
  fail "found only $COUNT_VERIFIERS secret verifier(s) (floor $FLOOR_VERIFIERS) — the parser is wrong, not the code"
elif [ -n "$UNSAFE" ]; then
  fail "verifies a secret without hash_equals():$UNSAFE"
  printf '        String comparison returns early on the first differing byte,\n'
  printf '        so its timing leaks how much of a guess was right.\n'
else
  pass "all $COUNT_VERIFIERS secret verifier(s) compare with hash_equals()"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d secret check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll secret checks passed.\033[0m\n'
