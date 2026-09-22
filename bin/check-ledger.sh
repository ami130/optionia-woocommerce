#!/usr/bin/env bash
#
# The phase ledger still describes reality.
#
# ## Why this exists
#
# 🔴 **This is the plan's most-repeated defect, and it has now happened twice in
# the same way.** Gate 1 met all ten criteria on 2026-09-03 and was ticked on
# 2026-09-10, with the `◀ HERE` marker sitting *before* the gate while Phases 14,
# 15 and 16 were built past it. Then the marker read `[~] 18 Groups ◀ HERE` until
# 2026-09-21, by which time 18, 19, 20, 21 and 21b had all shipped — **four
# phases of drift**, and one Phase 18 criterion that stayed `[ ]` for eight days
# after the stage that closed it.
#
# The plan's own words: *"a ledger nobody updates is a ledger nobody can trust to
# say what is left."* It records that lesson six times and drifted anyway,
# because a note asking a human to remember is not a mechanism.
#
# ## What is checked
#
# **Not** whether a phase is finished — that is what exit criteria are for, and a
# second opinion here would be a second source of truth. What is checked is the
# one thing a human reliably forgets: a phase whose criteria are **all ticked**
# must not still be `[ ]` in the ledger.
#
# ⚠️ **`[~]` is always allowed.** It means *"partially met, remainder owned by a
# named milestone"*, which is a deliberate statement — Phase 6 and Phase 20b both
# carry one on purpose. Only the silent `[ ]` is caught.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLAN="$ROOT/developePlan.md"

if [ ! -f "$PLAN" ]; then
  fail "missing: developePlan.md"
  printf '\n\033[31m1 ledger check failed.\033[0m\n'
  exit 1
fi

# The ledger is the fenced block after "## Phase ledger".
LEDGER=$(awk '/^## Phase ledger/{f=1} f&&/^```text/{p=1;next} p&&/^```/{exit} p{print}' "$PLAN")

if [ -z "$LEDGER" ]; then
  fail "could not read the ledger block — the pattern is wrong, not the plan"
  printf '\n\033[31m1 ledger check failed.\033[0m\n'
  exit 1
fi

# The marker exists, exactly once. It is how a reader finds the current phase.
# `grep -c` counts matching LINES; two markers on one line read as one.
MARKERS=$(printf '%s\n' "$LEDGER" | grep -o '◀ HERE' | grep -c . || true)

if [ "$MARKERS" -eq 1 ]; then
  pass "the ◀ HERE marker appears exactly once"
else
  fail "the ◀ HERE marker appears $MARKERS time(s), expected 1"
  printf '      A reader cannot find the current phase without it.\n'
fi

# The phases whose exit criteria the plan states as checkboxes.
#
# 🔴 **Two formats, and the first draft of this gate saw only one.** Phase 18
# writes `- [x]` markdown list items; every other phase writes a fenced block of
# bare `[x]` lines — **305 of them**. Matching the dash form alone meant this gate
# evaluated *one phase out of 44*, and silently passed Phases 21 and 21b being
# left unticked: the exact drift it was built to catch. Its four mutations all
# "passed" because every one of them happened to exercise Phase 18.
#
# ⚠️ **Scoped to the phase's own exit block, never the whole section.** Milestones
# state their own acceptance criteria in the same notation — Phase 20b's section
# holds 8 phase-level boxes and 8 more belonging to milestones under
# `##### The acceptance this milestone is held to`. A gate reading the section
# would conflate a milestone's open box with a phase that is not finished, and
# then be wrong in the safe-looking direction.
#
# The canonical heading is `### Phase N exit criteria`. Phase 18 writes
# `#### Exit criteria` and Phases 20b and 26b write `**Exit criteria:**`, so the
# block is located from the phase's own line range rather than by heading text.
PHASES=$(grep -oE '^## Phase [0-9]+[a-z]?' "$PLAN" | sed 's/^## Phase //' | sort -u)
COUNT=$(printf '%s\n' "$PHASES" | grep -c . || true)
FLOOR=20

if [ "$COUNT" -lt "$FLOOR" ]; then
  fail "found $COUNT phase heading(s), floor $FLOOR — the pattern is wrong, not the plan"
else
  pass "read $COUNT phase heading(s) from the plan"

  UNTICKED=0
  GRADED=0
  DASH_SEEN=0

  for phase in $PHASES; do
    START=$(grep -nE "^## Phase ${phase} —" "$PLAN" | head -1 | cut -d: -f1)
    [ -z "$START" ] && continue

    END=$(awk -v s="$START" 'NR>s && /^## /{print NR; exit}' "$PLAN")
    [ -z "$END" ] && END=$(wc -l < "$PLAN")

    # The exit block inside that range: the first heading whose text names it.
    EXIT_LINE=$(sed -n "${START},${END}p" "$PLAN" \
      | grep -nE '^### Phase .* exit criteria|^#### Exit criteria|^\*\*Exit criteria' \
      | head -1 | cut -d: -f1)

    [ -z "$EXIT_LINE" ] && continue

    ABS=$((START + EXIT_LINE - 1))
    STOP=$(awk -v s="$ABS" 'NR>s && /^(#|---)/{print NR; exit}' "$PLAN")
    [ -z "$STOP" ] && STOP="$END"

    BLOCK=$(sed -n "${ABS},${STOP}p" "$PLAN")

    # Both notations: fenced `[x]` lines and `- [x]` list items.
    TOTAL=$(printf '%s\n' "$BLOCK" | grep -cE '^(- )?\[[x ~]\] ' || true)
    [ "$TOTAL" -eq 0 ] && continue

    GRADED=$((GRADED + 1))

    # Phase 18 is the only phase written in the `- [x]` notation, so it is also
    # the only evidence that this gate still reads it. Counted by name: a floor
    # alone cannot notice one phase leaving a population of twenty-one.
    printf '%s\n' "$BLOCK" | grep -qE '^- \[[x ~]\] ' && DASH_SEEN=1

    OPEN=$(printf '%s\n' "$BLOCK" | grep -cE '^(- )?\[ \] ' || true)
    [ "$OPEN" -ne 0 ] && continue

    # Every criterion is met. The ledger must not still say "not started".
    BOX=$(printf '%s\n' "$LEDGER" \
      | grep -oE "\[[x ~]\] ${phase} [A-Za-z]" | head -1 | cut -c2)

    if [ "$BOX" = " " ]; then
      fail "Phase ${phase}: all ${TOTAL} exit criteria are met, but the ledger says [ ]"
      printf '      A ledger that understates progress is how four phases of drift went unnoticed.\n'
      UNTICKED=$((UNTICKED + 1))
    fi
  done

  # 🔴 The floor that matters: how many phases were actually GRADED, not how many
  # headings exist. The first draft's floor counted headings (44) while grading
  # one, so a broken criteria pattern read as reassurance.
  #
  # ⚠️ **Set just under the true count, not comfortably under it.** At 18 against
  # 21 graded, dropping the `- [x]` notation entirely still left 20 and the gate
  # stayed green — a floor loose enough to absorb the loss of a whole format is a
  # floor that would not have caught this gate's first draft.
  GRADED_FLOOR=20

  if [ "$GRADED" -lt "$GRADED_FLOOR" ]; then
    fail "graded $GRADED phase(s), floor $GRADED_FLOOR — the criteria pattern is wrong, not the plan"
  else
    pass "graded $GRADED phase(s) against their own exit criteria"

    if [ "$DASH_SEEN" -eq 1 ]; then
      pass "both criteria notations are still read"
    else
      fail "no phase matched the '- [x]' notation — that format has stopped being read"
      printf '      Phase 18 writes its criteria that way; losing it was the first-draft defect.\n'
    fi

    if [ "$UNTICKED" -eq 0 ]; then
      pass "no phase with all criteria met is left unticked"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# The gates grade themselves too (F21 again, one level down)
#
# 🔴 **Gate 2 sat at 19 unticked criteria while several had been met for weeks.**
# This gate was written because *"a ledger nobody updates is a ledger nobody can
# trust to say what is left"* -- and it read the phase ledger only, so a 🚩 GATE
# block drifted exactly as the phase boxes had, unnoticed by the mechanism built
# for that failure.
#
# ⚠️ **What is checked is agreement, not completion.** A gate with every
# criterion met must not still read `[ ]` in the ledger, and a gate with an open
# criterion must not read `[x]`. Whether a criterion *should* be met is the
# gate's own business.
# ---------------------------------------------------------------------------

GATES=$(grep -oE '^## 🚩 GATE [0-9]+' "$PLAN" | grep -oE '[0-9]+' | sort -u)
GATE_COUNT=$(printf '%s\n' "$GATES" | grep -c . || true)

if [ "$GATE_COUNT" -lt 1 ]; then
  fail "found no gate sections — the pattern is wrong, not the plan"
else
  pass "read $GATE_COUNT gate section(s)"

  MISMATCHED=0

  for gate in $GATES; do
    START=$(grep -nE "^## 🚩 GATE ${gate} " "$PLAN" | head -1 | cut -d: -f1)
    [ -z "$START" ] && continue

    END=$(awk -v s="$START" 'NR>s && /^## /{print NR; exit}' "$PLAN")
    [ -z "$END" ] && END=$(wc -l < "$PLAN")

    BLOCK=$(sed -n "${START},${END}p" "$PLAN")
    TOTAL=$(printf '%s\n' "$BLOCK" | grep -cE '^\[[x ~]\] ' || true)

    [ "$TOTAL" -eq 0 ] && continue

    OPEN=$(printf '%s\n' "$BLOCK" | grep -cE '^\[[ ~]\] ' || true)

    # The ledger's own box for this gate.
    BOX=$(printf '%s\n' "$LEDGER" \
      | grep -oE "\[[x ~]\] 🚩 GATE ${gate}" | head -1 | cut -c2)

    [ -z "$BOX" ] && continue

    if [ "$OPEN" -eq 0 ] && [ "$BOX" = " " ]; then
      fail "GATE ${gate}: all ${TOTAL} criteria are met, but the ledger says [ ]"
      MISMATCHED=$((MISMATCHED + 1))
    fi

    if [ "$OPEN" -ne 0 ] && [ "$BOX" = "x" ]; then
      fail "GATE ${gate}: ${OPEN} criterion(s) are open, but the ledger says [x]"
      printf '      A gate that claims more than it has met is how a launch slips past one.\n'
      MISMATCHED=$((MISMATCHED + 1))
    fi
  done

  if [ "$MISMATCHED" -eq 0 ]; then
    pass "every gate's ledger box agrees with its own criteria"
  fi
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d ledger check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll ledger checks passed.\033[0m\n'
