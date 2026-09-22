#!/usr/bin/env bash
#
# `npm audit`, minus the advisories `.npm-audit-exceptions.md` accepts.
#
# ## Why this is not just `npm audit --audit-level=high`
#
# 🔴 **One unreachable advisory should not lower the bar for every future one.**
# `multer` ships with `@nestjs/platform-express@11` and carries two DoS
# advisories that need a multipart upload endpoint this API does not have. The
# options were to drop `--audit-level` to `critical` -- silencing every future
# *high* finding, including ones that would matter -- or to except the one
# package and keep the rest strict. This is the second.
#
# ⚠️ **An exception is a claim about reachability.** Each entry in
# `.npm-audit-exceptions.md` names the code path the advisory needs and why this
# codebase does not have it. This script enforces the list; the file carries the
# argument, so a reader can check the reasoning rather than trust a package name.
#
# 📌 **A package is excepted, not a severity.** A *new* high advisory in any
# other dependency still fails the build.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXCEPTIONS="$ROOT/.npm-audit-exceptions.md"

if [ ! -f "$EXCEPTIONS" ]; then
  fail "missing: .npm-audit-exceptions.md"
  printf '\n\033[31m1 advisory check failed.\033[0m\n'
  exit 1
fi

# Package names from the `## <name> ...` headings, which is where an exception
# has to be argued for rather than merely listed.
EXCEPTED=$(grep -oE '^## [a-z0-9@/-]+' "$EXCEPTIONS" | sed 's/^## //' | sort -u)
EXCEPTED_COUNT=$(printf '%s\n' "$EXCEPTED" | grep -c . || true)

pass "$EXCEPTED_COUNT package(s) have a recorded exception"

REPORT=$(cd "$ROOT" && npm audit --omit=dev --audit-level=high --json 2>/dev/null || true)

if [ -z "$REPORT" ]; then
  fail "npm audit produced no output — the pattern is wrong, not the tree"
  printf '\n\033[31m1 advisory check failed.\033[0m\n'
  exit 1
fi

# Vulnerable packages at high or critical, as npm reports them.
VULNERABLE=$(printf '%s' "$REPORT" | python3 -c "
import json, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# 🔴 **Report the ROOT of each advisory, not every package that depends on it.**
# One vulnerable leaf makes npm flag its whole dependent chain: multer alone
# produced five entries -- @nestjs/core, platform-express, swagger, terminus and
# typeorm -- none of which is itself at fault. Excepting five package names to
# accept one advisory would mean four of them silently swallowing a future
# advisory of their own.
#
# (No backticks or command substitution in this comment: it sits inside one,
# where either would run as a command of its own.)
for name, entry in (data.get('vulnerabilities') or {}).items():
    if entry.get('severity') not in ('high', 'critical'):
        continue

    roots = [v for v in entry.get('via', []) if isinstance(v, dict)]

    if roots:
        for via in roots:
            print(via.get('name', name))
    else:
        # Every via entry is a package name, so this one is downstream of another
        # entry that carries the real advisory. It is not a root.
        if not entry.get('via'):
            print(name)
" | sort -u)

UNEXPECTED=''

for pkg in $VULNERABLE; do
  if printf '%s\n' "$EXCEPTED" | grep -qx "$pkg"; then
    continue
  fi

  UNEXPECTED="$UNEXPECTED $pkg"
done

if [ -n "$UNEXPECTED" ]; then
  fail "high or critical advisory with no recorded exception:$UNEXPECTED"
  printf '      Fix it, or add a section to .npm-audit-exceptions.md saying why\n'
  printf '      the vulnerable code path is unreachable here.\n'
else
  pass "no unexcepted high or critical advisory"
fi

# 🔴 **An exception for a package that is no longer vulnerable is stale.** It
# reads as a live risk and hides the fact that the real one is gone.
for pkg in $EXCEPTED; do
  if printf '%s\n' "$VULNERABLE" | grep -qx "$pkg"; then
    continue
  fi

  fail "\`$pkg\` is excepted but no longer flagged — remove the section"
done

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d advisory check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll advisory checks passed.\033[0m\n'
