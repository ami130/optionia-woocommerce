#!/usr/bin/env bash
#
# Secret scanner.
#
# The sibling project leaked a production database password three ways: a real
# credential in a committed .env.example, hardcoded fallbacks in source, and a
# plaintext notes file. All three were preventable by a check like this one.
#
# Runs in CI and can be wired to a pre-commit hook.
# Usage: bash bin/check-secrets.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

# Files git would actually commit. Untracked-and-ignored files cannot leak.
#
# Test files and markdown are excluded deliberately. Test fixtures are fake by
# definition and must stay readable; prose describing an anti-pattern is not the
# anti-pattern. Both are still reviewed like any other code.
#
# 🔴 **`--cached --others --exclude-standard`, not plain `git ls-files`.**
# Corrected 2026-09-01, after the Phase 12 audit found this gate had never seen
# any of M12.7's backend code: `orders.service.ts`, its controller, module and
# DTO were all uncommitted, and plain `ls-files` lists **tracked files only**.
# The comment above already said "files git would actually commit" -- the intent
# was right and the command did not deliver it.
#
# A secret, or an unguarded write, is most likely to be introduced in new code,
# which is exactly what was being skipped. The plugin repository hit this same
# bug in an earlier phase and measured six unscanned production files, the push
# signature verifier among them; its `bin/check-secrets.sh` was fixed then and
# this one was not.
#
# `--others --exclude-standard` adds untracked files while still honouring
# `.gitignore`, so `node_modules/` and `dist/` stay out.
FILES=$(git ls-files --cached --others --exclude-standard 2>/dev/null \
        | grep -E '\.(ts|js|json|yml|yaml|env|example|sh)$' \
        | grep -vE '\.spec\.ts$|^test/|\.test\.ts$' || true)

if [ -z "$FILES" ]; then
  pass "no files staged for scanning yet"
  exit 0
fi

# --- 1. Credential-shaped assignments -------------------------------------
# Matches password/secret/pass/token/api_key followed by a non-placeholder value.
#
# `pass` is listed separately from `password`. Without it `SMTP_PASS` — the exact
# name this project uses for its mail credential — matched nothing, and a real
# Gmail app password pasted there passed the scan. Found by testing the scanner
# against four credential shapes rather than one.
#
# The final filter drops SCREAMING_SNAKE constant declarations whose value is a
# bare identifier, e.g. `TOKEN_EXPIRED: 'TOKEN_EXPIRED'` or
# `PASSWORD_CHANGED: 'password_changed'`. Those are enum members, not
# credentials: the value is a stable string the code compares against, and no
# real secret is a lowercase word matching its own key.
#
# The value case is deliberately not constrained — an earlier version required
# uppercase and flagged `PASSWORD_CHANGED: 'password_changed'`, which is the same
# shape. A secret still fails this filter because it contains characters an
# identifier cannot: digits mixed with symbols, punctuation, or mixed case with
# separators.
# `strip_comments` drops //, #, and * lines so the scanner cannot flag its own
# documentation or a developer's note describing the pattern.
strip_comments() { grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|#|\*|/\*)'; }

# Drop enum members whose value echoes their key.
#
# `TOKEN_EXPIRED: 'TOKEN_EXPIRED'`, `PASSWORD_CHANGED: 'password_changed'` and
# `STORES_ROTATE_CREDENTIAL: 'stores:rotate_credential'` are all the same shape:
# a constant whose value is its own name, differing only in case and separator.
#
# This is checked rather than approximated. An earlier version allowed any
# identifier-shaped value, which was tested against real leaks and let three of
# four through — `sk_live_51H8xQ2eZvKYlo2C` and a Gmail app password are both
# pure identifier characters. A secret cannot echo its key, so this comparison
# is safe in a way a character-class rule is not.
strip_enum_members() {
  awk -F: '
    {
      line = $0
      # key: the SCREAMING_SNAKE identifier before the colon-quote
      if (match(line, /[A-Z][A-Z0-9_]*[[:space:]]*:[[:space:]]*["'"'"']/)) {
        key = substr(line, RSTART, RLENGTH)
        gsub(/[^A-Za-z0-9]/, "", key)
        # value: the quoted literal
        if (match(line, /["'"'"'][^"'"'"']+["'"'"']/)) {
          val = substr(line, RSTART + 1, RLENGTH - 2)
          gsub(/[^A-Za-z0-9]/, "", val)
          if (toupper(key) == toupper(val)) next
        }
      }
      print line
    }'
}

HITS=$(grep -IniE '[a-z_]*(password|secret|passwd|pass|api[_-]?key|token|credential)[a-z_]*[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}' $FILES 2>/dev/null \
       | strip_comments \
       | grep -viE 'changeme|placeholder|example|your[_-]|xxx|\*\*\*|<[a-z]|process\.env|configService|\$\{' \
       | strip_enum_members || true)

if [ -n "$HITS" ]; then
  fail "possible hardcoded credential:"
  echo "$HITS" | sed 's/^/        /'
else
  pass "no hardcoded credentials"
fi

# --- 1b. Credentials in env files ------------------------------------------
# Check 1 requires a quoted value, because that is how a credential appears in
# source. In a .env file values are bare — `SMTP_PASS=hooxpxetwpspbzwv` — so it
# matched nothing, while this script's own header claimed it caught "a credential
# in a committed .env.example". It did not, and that was verified by pasting a
# real app password into the file and watching the scan pass.
#
# Any tracked env file must have empty values for credential-shaped keys. The
# committed file is a template; the real values live in an untracked .env.
ENV_FILES=$(echo "$FILES" | grep -E '\.env(\.|$)|\.env\.example$' || true)

if [ -n "$ENV_FILES" ]; then
  HITS=$(grep -InE '^[A-Z_]*(PASSWORD|PASS|SECRET|TOKEN|API[_-]?KEY|CREDENTIAL)[A-Z_]*=.+' $ENV_FILES 2>/dev/null \
         | grep -viE '=[[:space:]]*$|changeme|placeholder|example|your[_-]|xxx|\*\*\*|<[a-z]' || true)

  if [ -n "$HITS" ]; then
    fail "credential with a value in a tracked env file (templates must be empty):"
    echo "$HITS" | sed 's/^/        /'
  else
    pass "tracked env files carry no credential values"
  fi
fi

# --- 2. Fallback defaults on env reads ------------------------------------
# `process.env.X || 'literal'` is how a local process silently reaches prod.
HITS=$(grep -InE "(process\.env\.[A-Z_]+|configService\.get<?[^>]*>?\([^)]+\))[[:space:]]*(\|\||\?\?)[[:space:]]*['\"][^'\"]+['\"]" $FILES 2>/dev/null \
       | strip_comments || true)

if [ -n "$HITS" ]; then
  fail "env read with a fallback default — must throw instead:"
  echo "$HITS" | sed 's/^/        /'
else
  pass "no env fallback defaults"
fi

# --- 3. Private keys and connection strings -------------------------------
HITS=$(grep -InE 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|mysql://[^ ]*:[^ @]+@|postgres://[^ ]*:[^ @]+@' $FILES 2>/dev/null \
       | strip_comments \
       | grep -viE 'changeme|example|user:pass' || true)

if [ -n "$HITS" ]; then
  fail "private key or credentialed connection string:"
  echo "$HITS" | sed 's/^/        /'
else
  pass "no private keys or connection strings"
fi

# --- 4. .env must never be tracked ----------------------------------------
if git ls-files 2>/dev/null | grep -qE '(^|/)\.env$'; then
  fail ".env is tracked by git — remove it from the index immediately"
else
  pass ".env is not tracked"
fi

# --- 5. Secrets are compared in constant time ------------------------------
#
# `timingSafeEqual()` and `===` return the same answer, so no test can tell them
# apart -- a mutation swapping one for the other survives every assertion. What
# differs is *timing*: string comparison returns on the first differing byte, so
# its duration leaks how much of a guess was right.
#
# Added 2026-09-01, after the plugin's equivalent check was found blind to a
# third verifier it had never inspected. This repository had no such check at
# all: `common/crypto/tokens.ts` compares correctly today, and nothing prevented
# that from regressing. A store credential is looked up by hash on **every**
# authenticated plugin request -- the highest-volume secret comparison in either
# codebase.
#
# ## What counts as a verifier here, and why the obvious rule is wrong
#
# The plugin's version asks "which files hash?" and requires `hash_equals` in
# each. Ported directly, that rule produces false positives, measured:
#
#   auth-throttler.guard.ts   hashes a token to derive a rate-limit key
#   connect.service.ts        hashes a PKCE verifier into a challenge
#
# Both hash a secret; **neither compares one** -- the PKCE challenge is matched
# in SQL, and a throttle key is not a comparison at all. Demanding
# `timingSafeEqual` of them would be noise, and a gate that cries wolf gets
# switched off.
#
# So a file is a verifier when it **compares** something secret-shaped, by
# either of two signals -- one for the safe form and one for the unsafe:
#
#   1. it calls `timingSafeEqual` (the correct comparison), or
#   2. it compares a secret-shaped identifier with `===` against another
#      identifier (the incorrect one).
#
# Signal 2 is what catches a *new* verifier written with an unlisted primitive
# and a plain `===` -- doubly invisible to any hash-based discovery, and exactly
# the hole that let the plugin's gate miss `CartItemPayload` for seven stages.
#
# `expected` is deliberately **not** a secret name here. `option-sets/optimistic-
# lock.ts` compares `expected !== current` on a *row version*, which is not a
# secret and must not be dragged in.
#
# Comparison against `null`, `undefined` or a literal is an emptiness check, not
# a secret comparison, and is excluded.
# Named for what it is -- a list of identifier *words* -- rather than
# `SECRET_...`, because check 1 above correctly reads `secret='literal'` as a
# hardcoded credential and flagged this very line. Renaming keeps that check
# strict instead of teaching it an exception.
VERIFIER_WORDS='signature|token|secret|digest|hmac|credential|challenge'

TS_FILES=$(printf '%s\n' "$FILES" | grep -E '\.ts$' | grep -v '\.spec\.ts$' || true)

# Two identifiers compared with ===, at least one secret-shaped, neither side a
# null/undefined/literal check.
UNSAFE_CMP="(($VERIFIER_WORDS)[A-Za-z]*[[:space:]]*(===|!==)[[:space:]]*[a-zA-Z_]|[a-zA-Z_][A-Za-z0-9_.]*[[:space:]]*(===|!==)[[:space:]]*($VERIFIER_WORDS)[A-Za-z]*)"

secret_comparisons() {
  # Strips comments first: prose describing the rule must not satisfy the rule,
  # a bug this project has now shipped six times.
  sed -e 's://.*::' -e 's:^[[:space:]]*[*/].*::' "$1" \
    | grep -aiE "$UNSAFE_CMP" \
    | grep -avE "(===|!==)[[:space:]]*(null|undefined|true|false|[0-9]|'|\"|\`)" || true
}

VERIFIERS=''
for f in $TS_FILES; do
  [ -f "$f" ] || continue

  if grep -qE 'timingSafeEqual[[:space:]]*\(' "$f" 2>/dev/null; then
    VERIFIERS="$VERIFIERS $f"
    continue
  fi

  [ -n "$(secret_comparisons "$f")" ] && VERIFIERS="$VERIFIERS $f"
done

UNSAFE=''
for verifier in $VERIFIERS; do
  if ! grep -qE 'timingSafeEqual[[:space:]]*\(' "$verifier" 2>/dev/null; then
    UNSAFE="$UNSAFE $verifier(no-timingSafeEqual-call)"
    continue
  fi

  # A decorative call kept while the deciding comparison is a plain `===`.
  [ -n "$(secret_comparisons "$verifier")" ] && UNSAFE="$UNSAFE $verifier(=== on a secret)"
done

COUNT_VERIFIERS=$(printf '%s\n' $VERIFIERS | grep -c . || true)

# A gate that finds no verifiers passes for the wrong reason. One file compares
# a secret today: `common/crypto/tokens.ts`, which every store request goes
# through.
FLOOR_VERIFIERS=1

if [ "$COUNT_VERIFIERS" -lt "$FLOOR_VERIFIERS" ]; then
  fail "found only $COUNT_VERIFIERS secret verifier(s) (floor $FLOOR_VERIFIERS) — the parser is wrong, not the code"
elif [ -n "$UNSAFE" ]; then
  fail "verifies a secret without timingSafeEqual():$UNSAFE"
  printf '        String comparison returns early on the first differing byte,\n'
  printf '        so its timing leaks how much of a guess was right.\n'
else
  pass "all $COUNT_VERIFIERS secret verifier(s) compare in constant time"
fi

# --- 6. Multi-statement writes are atomic ----------------------------------
#
# A service issuing two raw writes without a transaction can be interrupted
# between them, and the failure is **silent and shaped like data**: the rows that
# landed look legitimate, so nothing reports an error and nothing looks broken.
#
# `OrdersService.report()` is the case that prompted this. It deletes an order's
# selections and reinserts them, because a retry must *replace* rather than
# append -- appending would double-count every option on a second delivery. A
# crash between the two leaves an order with **no selections at all**, which
# reads as a plain product sale rather than as a missing write. Phase 25 would
# then under-report option revenue with no signal that anything went wrong.
#
# 🔴 **No test can catch this.** Removing the transaction from `report()` passed
# all 23 e2e tests, measured 2026-09-01: the one test that looks like it covers
# atomicity ("writes nothing when one selection is invalid") is rejected by the
# validation pipe *before the service runs*, so it proves the DTO. Failure
# between two statements cannot be provoked from outside. Like `hash_equals`
# above, a gate is the only possible protection.
#
# The rule is deliberately narrow: **more than one raw write statement in a file
# requires a transaction somewhere in it.** That is coarse -- it does not prove
# the writes are *inside* the transaction -- but it is checkable without parsing
# TypeScript, and it catches the regression that matters (a transaction deleted
# wholesale). A single write is atomic on its own and is not asked to justify
# itself, which is what keeps this quiet: three files write exactly once today
# and none of them are flagged.
TS_WRITERS=$(printf '%s\n' "$FILES" | grep -E '\.ts$' | grep -v '\.spec\.ts$' || true)

NON_ATOMIC=''
COUNT_MULTI=0

for f in $TS_WRITERS; do
  [ -f "$f" ] || continue

  # Comments stripped first: a docblock describing a DELETE is not a DELETE.
  # `ON DUPLICATE KEY UPDATE` is a *clause* of the INSERT above it, not a second
  # statement -- an upsert is one atomic write, and counting it twice flagged the
  # most atomic thing a service can do. Dropped before counting rather than
  # exempting the file, which would have stopped counting its real writes too.
  WRITES=$(sed -e 's://.*::' -e 's:^[[:space:]]*[*/].*::' -e 's:ON DUPLICATE KEY UPDATE::' "$f" \
           | grep -acE 'INSERT INTO|DELETE FROM|UPDATE[[:space:]]+[a-z_]+' || true)

  [ "$WRITES" -gt 1 ] || continue

  COUNT_MULTI=$((COUNT_MULTI + 1))

  grep -qE '\.transaction\(' "$f" 2>/dev/null \
    || NON_ATOMIC="$NON_ATOMIC $f($WRITES writes, no transaction)"
done

# A gate that inspects no files passes for the wrong reason. Four services write
# more than once today: connect, stores, team and orders.
FLOOR_MULTI=4

if [ "$COUNT_MULTI" -lt "$FLOOR_MULTI" ]; then
  fail "only $COUNT_MULTI multi-write file(s) inspected (floor $FLOOR_MULTI) — the pattern is wrong, not the code"
elif [ -n "$NON_ATOMIC" ]; then
  fail "multi-statement writes without a transaction:$NON_ATOMIC"
  printf '        A failure between two writes leaves data that looks legitimate,\n'
  printf '        so nothing reports an error and nothing looks broken.\n'
else
  pass "all $COUNT_MULTI multi-write service(s) wrap their writes in a transaction"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d secret check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll secret checks passed.\033[0m\n'
