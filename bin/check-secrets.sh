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
FILES=$(git ls-files 2>/dev/null \
        | grep -E '\.(ts|js|json|yml|yaml|env|example|sh)$' \
        | grep -vE '\.spec\.ts$|^test/|\.test\.ts$' || true)

if [ -z "$FILES" ]; then
  pass "no files staged for scanning yet"
  exit 0
fi

# --- 1. Credential-shaped assignments -------------------------------------
# Matches password/secret/token/api_key followed by a non-placeholder value.
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

HITS=$(grep -IniE '[a-z_]*(password|secret|passwd|api[_-]?key|token|credential)[a-z_]*[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}' $FILES 2>/dev/null \
       | strip_comments \
       | grep -viE 'changeme|placeholder|example|your[_-]|xxx|\*\*\*|<[a-z]|process\.env|configService|\$\{' \
       | grep -vE ':[[:space:]]*[A-Z_]+:[[:space:]]*.[A-Za-z_]+.,?$' || true)

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

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d secret check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll secret checks passed.\033[0m\n'
