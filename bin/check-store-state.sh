#!/usr/bin/env bash
#
# Connection state is written in exactly one place (M8.1b).
#
# M8.1b requires an "explicit, persisted state machine — not inferred", and the
# way that requirement dies is by attrition: each step writes `stores.status`
# where it happens to be convenient, every write looks reasonable on its own, and
# the illegal transitions are the ones nobody wrote down.
#
# `[8e]` shipped exactly that. `UPDATE stores SET status = 'connected'
# WHERE id = ?` with no precondition let a connection code redeemed after the
# merchant disconnected silently reconnect the store — no attacker needed, just a
# failed exchange the plugin retries and an impatient merchant in between.
#
# ## Why this matches `StoreStatus`, not `UPDATE stores`
#
# The first version of this gate matched `UPDATE[[:space:]]+stores[...]status` on
# a single line. Audited against realistic evasions it caught **none of three**:
# multi-line SQL, `manager.update(Store, id, { status })`, and `repo.save()` all
# passed a green build. It proved only that nobody had written one particular
# spelling — the shape I had in mind while writing it.
#
# Enumerating TypeORM's write APIs is a losing game (`update`, `save`, `upsert`,
# `createQueryBuilder().update()`, plain entity mutation). Every one of them must
# name a **value** to write, and every legitimate value comes from the
# `StoreStatus` enum. So the enum is the signal: a file outside the state machine
# that mentions `StoreStatus.` is either writing state or doing something that
# deserves to be looked at.
#
# Usage: bash bin/check-store-state.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0

fail() { printf '  \033[31mx\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }

printf '\nChecking connection-state writes...\n\n'

# Files that may name a status value.
#
#   store-state.ts / .service.ts  the machine itself
#   enums.ts                      the declaration
#   store.entity.ts               the column default
#   migrations, seeds             fixed data, no transitions
ALLOWED='src/stores/store-state\.ts|src/stores/store-state\.service\.ts|src/common/database/enums\.ts|src/stores/entities/store\.entity\.ts|src/migrations/|src/seeds/'

# Drop comment lines, so the scanner cannot flag its own documentation — the same
# reason `check-secrets` strips them.
strip_comments() { grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|#|\*|/\*)'; }

# Which files name a `StoreStatus` value, and are they entitled to?
#
# Analysed per **file**, not per line. A line-based allowance has the same
# fragility the detection had: a legitimate
# `transition(\n  id,\n  StoreStatus.CONNECTING,\n)` split across lines stops
# matching, and the gate fails on correct code. Flattening the file first means
# formatting cannot change the verdict either way.
#
# A file is entitled when every status value it names is accounted for by one of:
#   `transition(… StoreStatus.X …)`   the machine performing the write
#   `changes: { … status: … }`        an audit entry *recording* a write
#   `INSERT INTO stores`              an initial state, not a transition
OFFENDERS=""

for f in $(grep -rl "StoreStatus\." src --include='*.ts' 2>/dev/null \
           | grep -vE "$ALLOWED" | grep -vE '\.spec\.ts$'); do
  FLAT=$(tr '\n' ' ' < "$f")

  # Count the status values this file names...
  NAMED=$(echo "$FLAT" | grep -oE "StoreStatus\.[A-Z_]+" | wc -l | tr -d ' ')

  # ...and those each allowance accounts for.
  VIA_TRANSITION=$(echo "$FLAT" | grep -oE "transition\([^)]*StoreStatus\.[A-Z_]+" | wc -l | tr -d ' ')
  VIA_AUDIT=$(echo "$FLAT" | grep -oE "changes: \{[^}]*StoreStatus\.[A-Z_]+" | wc -l | tr -d ' ')
  VIA_INSERT=$(echo "$FLAT" | grep -oE "INSERT INTO stores[^\`]*\`[^;]*StoreStatus\.[A-Z_]+" | wc -l | tr -d ' ')

  ACCOUNTED=$((VIA_TRANSITION + VIA_AUDIT + VIA_INSERT))

  if [ "$NAMED" -gt "$ACCOUNTED" ]; then
    OFFENDERS="${OFFENDERS}${f} (names $NAMED, accounted $ACCOUNTED)\n"
  fi
done

OFFENDERS=$(printf '%b' "$OFFENDERS" | grep -v '^$' || true)

if [ -n "$OFFENDERS" ]; then
  fail "connection state named outside StoreStateService (route it through transition()):"
  echo "$OFFENDERS" | sed 's/^/      /'
else
  pass "every connection-state write goes through the state machine"
fi

# Raw SQL, across lines. `tr` flattens the file so a statement broken over three
# lines reads the same as one written on a single line — the evasion the first
# version of this gate missed.
RAW=$(for f in $(grep -rl "UPDATE" src --include='*.ts' 2>/dev/null | grep -vE "$ALLOWED"); do
        if tr '\n' ' ' < "$f" | grep -qiE "UPDATE[[:space:]]+stores[[:space:]]+SET[^;]*status"; then
          echo "$f"
        fi
      done || true)

if [ -n "$RAW" ]; then
  fail "raw SQL writing stores.status outside the state machine:"
  echo "$RAW" | sed 's/^/      /'
else
  pass "no raw SQL writes stores.status outside the machine"
fi

# The floor. A refactor that renamed the enum would otherwise leave both checks
# above passing while inspecting nothing at all.
TOTAL=$(grep -rn "StoreStatus\." src 2>/dev/null | strip_comments | wc -l | tr -d ' ')

if [ "$TOTAL" -lt 5 ]; then
  fail "found only $TOTAL StoreStatus reference(s) — the pattern no longer matches the code"
else
  pass "$TOTAL status reference(s) scanned"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31mConnection-state checks failed.\033[0m\n\n'
  exit 1
fi
printf '\033[32mAll connection-state checks passed.\033[0m\n\n'
