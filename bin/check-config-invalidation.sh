#!/usr/bin/env bash
#
# A change a storefront can see must move `config_version` (M9.4b).
#
# `GET /store/config` builds its ETag from `stores.config_version`. A change to
# published configuration that does not move it is a change no plugin ever
# fetches: every connected store answers `304` and keeps serving the old
# document until something else happens to publish.
#
# That was not hypothetical. Deleting a published option set removed it from the
# document and left the version untouched — measured, before this gate existed:
#
#     sets 1 -> 0 | version 1 -> 1 | etag unchanged
#
# Two routes had it. `DELETE /option-sets/:id` soft-deletes, and
# `DELETE /option-sets/:id/permanent` purges — and purge accepts a set that was
# never soft-deleted, so it can erase live published configuration on its own.
# Neither bumped. Nothing failed, nothing logged; it would have surfaced as a
# merchant saying "I deleted that option and it is still on my site".
#
# ## Why this matches writes to the backing tables, not mutating routes
#
# The obvious rule — "a mutating store-scoped route must bump" — over-fires by a
# factor of five. Around twenty authoring routes mutate; only a handful can
# change what a storefront is served, because the config document is built from
# **immutable published snapshots**. A draft edit is invisible to it. So is
# renaming a published set: measured, the document does not carry the set's name
# at all, so `PATCH /option-sets/:id` correctly changes nothing.
#
# A gate flagging all twenty would be noise, and noise gets exemptions added
# until it means nothing.
#
# The document reads exactly two tables: `option_sets` (its status and
# `deletedAt`) and `option_set_versions` (the snapshot).
#
# ## Why this matches values, not TypeORM write APIs
#
# The first version of this gate matched `.update(OptionSet)` and
# `.delete(OptionSet`. Audited against realistic evasions it caught **none of
# six**: `repo.save(set)`, `manager.save`, `upsert`, `softDelete`, `softRemove`
# and raw SQL all passed a green build. `.save()` is not hypothetical — sixteen
# files in this repository use it — so a service archiving a published set by
# loading it, assigning `status` and saving would have been invisible.
#
# `bin/check-store-state.sh` had already learned this and says so in its own
# header: enumerating TypeORM's write APIs is a losing game. Every write must
# name a **value**, and the values that matter here are few:
#
#   OptionSetStatus.PUBLISHED / .ARCHIVED   a status the document filters on
#   .set({ … deletedAt … })                 soft-deleting a row it reads
#   OptionSetVersion                        the snapshot table itself
#
# `OptionSetStatus.DRAFT` is deliberately absent: a draft is invisible to the
# document, so writing one is not a change a storefront can see.
#
# ## What this gate cannot see
#
# It reads text, so it cannot tell a call from a comment. A file that writes
# published configuration with the bump **commented out** satisfies the
# compliance check:
#
#     const shouldBump = false;
#     if (shouldBump) {
#       // this.configVersion.bump(manager, storeId);
#     }
#
# Tightening the match to `this.configVersion.bump(` does not close it — that
# string appears in the comment too. No text-based check can, which is why this
# is recorded rather than papered over.
#
# The realistic shape is not sabotage: it is a developer stubbing the call
# meaning to wire it later. What actually closes it is a behavioural test —
# every path that changes published configuration is asserted in
# `test/config-delivery.e2e-spec.ts` to move `config_version`, not merely to
# call something. This gate catches the writer nobody wrote a test for; the
# tests catch the writer whose bump does not work.
#
# Usage: bash bin/check-config-invalidation.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

# Writes to the three tables the config document reads.
#
# `.update(OptionSet)` and `.delete(OptionSet` cover status and soft-delete;
# `create(OptionSetVersion` and `OptionSetVersion,` cover writing a snapshot and
# erasing one. Entity files, specs and the read-only projection are excluded:
# they define or read the shape rather than change it.
#
# `OptionSetAssignment` joined this list in Phase 10 Stage 1b, and it is the one
# entry here that was added *before* the code it guards existed.
#
# [M9.4b](developePlan.md) recorded "product assignment changed" as an
# invalidation trigger that nothing covered, and closed the entry with: *"nothing
# forces Phase 13 to when it lands. A bug scheduled for four phases out."* That
# was accurate and it was enforced by nothing — a note in a plan, which is the
# failure this repository keeps finding in its own checks.
#
# Phase 10 Stage 1 made assignments reach the storefront document, so from that
# point an assignment write that does not bump `config_version` is a **live
# staleness bug**: the merchant assigns a set to a product, every storefront
# answers `304`, and the option never appears. Exactly the deletion bug found in
# Phase 9, one table over.
#
# Measured before the pattern was widened: a service that saved an
# `OptionSetAssignment` and never bumped passed this gate cleanly. The picker
# that will write these rows is [M13.6](developePlan.md), several phases out —
# so the trap is set here, while the reasoning is in front of us, rather than
# left for that phase to rediscover.
WRITE_PATTERN='OptionSetStatus\.(PUBLISHED|ARCHIVED)|\.set\(\{[^}]*deletedAt|OptionSetVersion|OptionSetAssignment'

# Files that write a backing table but must NOT bump. Each needs a reason, and
# each reason has been verified rather than assumed.
#
#   option-sets.repository.ts
#     Its `applyChange` writes `OptionSet`, but only ever for a rename or a
#     `rowVersion` touch — never status or `deletedAt`. The document does not
#     carry the set's name, so a rename is invisible to a storefront. Probed:
#     `PATCH` a published set, document unchanged, version unchanged.
#
#   option-sets.service.ts
#     Names `OptionSetStatus.PUBLISHED` once, in a **comparison** — it reads the
#     status to tell `CascadeService` whether the set was visible, and the
#     cascade does the bumping inside its own transaction. Its only status
#     *writes* are `DRAFT`, on create and duplicate, which no document reads.
#
#   seeds/demo.seed.ts
#     Writes published sets directly, deliberately: a seed builds a database
#     from nothing, so there is no storefront holding a cached document to
#     invalidate. Bumping here would be advancing a version nobody has read.
#
# **An exemption is a claim, and the claim is re-checked below.** A file excused
# here could start writing the values that matter tomorrow and the exemption
# would quietly cover it — which is how a gate becomes decoration. Each exempt
# file is re-scanned against the reason recorded for it.
#   serialization/config-document.ts
#     Names `OptionSetAssignment` to **read** it — Stage 1's read-time join. A
#     reader cannot invalidate anything, and this is the file the whole gate
#     exists to protect the output of.
#   option-sets/option-sets.module.ts
#     Wiring. It names the entity to register it with TypeORM.
EXEMPT="src/option-sets/option-sets.repository.ts src/option-sets/option-sets.service.ts src/seeds/demo.seed.ts src/option-sets/serialization/config-document.ts src/option-sets/option-sets.module.ts"

WRITERS=""
COUNT=0

while IFS= read -r file; do
  [ -z "$file" ] && continue

  case "$file" in
    *"/entities/"*|*".spec.ts"|*"/projections.ts"|*"/config-document.ts") continue ;;
  esac

  grep -qE "$WRITE_PATTERN" "$file" 2>/dev/null || continue

  COUNT=$((COUNT + 1))
  WRITERS="$WRITERS $file"
done <<EOF
$(find src -name '*.ts' -type f | sort)
EOF

# A gate that inspects nothing passes for the wrong reason.
#
# Five files name these values today: publish, cascade, hard-delete, the
# repository and the orchestrator, plus the demo seed. If this count collapses,
# the pattern stopped matching rather than the code becoming clean — the failure
# this project keeps finding in its own checks.
FLOOR=5

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "only $COUNT writer(s) of the document's backing tables found (floor $FLOOR) — the pattern is wrong, not the code"
else
  MISSING=""

  for file in $WRITERS; do
    case " $EXEMPT " in *" $file "*) continue ;; esac

    grep -q "configVersion\." "$file" 2>/dev/null || MISSING="$MISSING
        ${file#src/}"
  done

  if [ -n "$MISSING" ]; then
    fail "writes published configuration without advancing config_version:$MISSING"
    printf '        Call ConfigVersionService inside the same transaction, or add\n'
    printf '        the file to EXEMPT in this script with a verified reason.\n'
  else
    pass "all $COUNT writer(s) of published configuration advance config_version"
  fi
fi

# --- Exemptions are re-verified, not trusted ----------------------------------
#
# The reason each file is exempt is that it does not write a column the document
# reads. That is a statement about today's code, so it is checked rather than
# believed: `status:` or `deletedAt` appearing in a `.set({...})` on one of these
# files means the reason has expired.

# Each exemption's reason is a different claim, so each is checked differently.
# A single shared assertion would pass for the wrong reason on two of the three.

check_exemption() {
  local file="$1" label="$2" pattern="$3" reason="$4"

  # A vanished exemption is a stale one, and silence is the wrong answer.
  #
  # This used to `return 0` when the file was gone, so renaming an exempt file
  # left the entry behind and the gate stayed green — the row simply disappeared
  # from the output. That matters because exemptions are the part of this gate
  # most likely to rot: a stale entry is the one someone later copies for a
  # *different* file, carrying a reason that was never checked against it.
  if [ ! -f "$file" ]; then
    fail "$label is exempted here but no longer exists — remove the entry, or point it at the file that replaced it"

    return 0
  fi

  if grep -qE "$pattern" "$file" 2>/dev/null; then
    fail "$label is exempt because $reason — that is no longer true"
    printf '        Bump through ConfigVersionService, or update the reason above.\n'
  else
    pass "$label: $reason, still"
  fi
}

# Claim: writes names and rowVersion, never a status or a soft delete.
check_exemption \
  "src/option-sets/option-sets.repository.ts" \
  "option-sets.repository" \
  "\.set\(\{[^}]*(status|deletedAt)" \
  "it writes no value the document reads"

# Claim: its only status *writes* are DRAFT; PUBLISHED appears in a comparison.
check_exemption \
  "src/option-sets/option-sets.service.ts" \
  "option-sets.service" \
  "status: *OptionSetStatus\.(PUBLISHED|ARCHIVED)" \
  "it writes only DRAFT and delegates deletion to the cascade"

# Claim: a seed builds a database from nothing, so no storefront holds a cached
# document to invalidate — it writes `configVersion` as a literal rather than
# advancing one. The claim expires if it ever calls the bumper, which would mean
# it had started mutating a store someone was already reading.
check_exemption \
  "src/seeds/demo.seed.ts" \
  "demo.seed" \
  "configVersion\." \
  "it seeds a version rather than advancing one"

# --- The bumper stays reachable ----------------------------------------------
#
# The bug existed because the bump was a *private method* on `PublishService`:
# publishing was the only caller that could reach it, so the deletion path did
# not fail to bump so much as have no way to. A regression to that shape would
# leave every check above passing.

if [ -f src/common/config-version.service.ts ]; then
  pass "ConfigVersionService is shared, not private to one caller"
else
  fail "src/common/config-version.service.ts is gone — the bump has an owner again"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d invalidation check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll invalidation checks passed.\033[0m\n'
