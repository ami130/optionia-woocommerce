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

# ⚠️ **Declared HERE, not only inside the loop that fills it.** The checks below
# read it, and under `set -u` an unset variable aborts the script -- so a failing
# phase-count floor would have taken the whole gate down with it rather than
# reporting one failure. Shell has no block scope; this is the only thing that
# makes the read safe.
SEEN_PHASES=""
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
    SEEN_PHASES="$SEEN_PHASES $phase"

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

    # -----------------------------------------------------------------------
    # A phase this gate cannot grade must SAY so (F145)
    #
    # 🔴 **Phases 22, 23, 24 and 25 write their exit as prose -- `**Exit:** ...`
    # -- and were therefore skipped ENTIRELY by the loop above.** `TOTAL -eq 0
    # && continue` is silent, so the gate reported "graded 26 phases" and passed
    # while never looking at the four phases the project was actually working
    # on. All four sat at `[ ]` in the ledger with their work shipped.
    #
    # ⚠️ **This is the gate's own defect repeating one level down.** Its first
    # draft read one notation of two and passed; this draft reads both notations
    # and silently ignores every phase that uses neither. A gate that cannot see
    # a phase must not imply it checked it.
    #
    # 📌 **What is checked is VISIBILITY, not completion.** Whether a prose exit
    # is met is a human judgement -- but a phase whose section exists, whose
    # ledger box is `[ ]`, and which this gate cannot grade, must be named out
    # loud rather than skipped. Naming it is what stops "all checks passed" from
    # meaning "I did not look".
    # -----------------------------------------------------------------------

    # 📌 **Scoped to the work that has been REACHED.** The marker already means
    # "this is where we are", so the gate reuses the plan's own signal rather
    # than inventing a second one: every phase named on the marker's stage line
    # and on the stages above it. Phases further down are not drift -- they are
    # simply not started, and flagging eighteen of them every run is how a gate
    # teaches its reader to ignore it.
    REACHED=$(printf '%s\n' "$LEDGER" \
      | awk '/◀ HERE/{found=1} {print} found{exit}' \
      | grep -oE '\[[x ~ ]\] [0-9]+[a-z]?' | grep -oE '[0-9]+[a-z]?$')

    # ✏️ **And every phase on a STARTED stage**, which the scan above cannot see.
    #
    # 🔴 **The marker moves backwards legitimately.** When Phase 25 closed, the
    # marker went back to GATE 2 — the honest position, since Stage 4's phases
    # were done and Gate 2 was what stood before launch. That put Phases 22-26
    # *below* it, outside `REACHED`, and un-ticking Phase 25 then produced **no
    # failure at all**: the drift check had gone blind to the whole of Stage 4.
    #
    # ⚠️ **The first fix was CIRCULAR and is recorded so it is not re-proposed.**
    # It added every phase that was `[x]` or `[~]`, which cannot catch a phase
    # being un-ticked: un-ticking removes it from the set the check then walks.
    # Both mutations survived, and the gate reported green.
    #
    # 📌 **A stage with ANY ticked phase has been started**, and that property
    # survives one of its boxes being emptied. Every phase on such a stage is in
    # scope; a stage with nothing ticked is genuinely not started and stays out.
    # ⚠️ **Per STAGE, and a stage spans several lines.** The ledger wraps — Stage
    # 4 puts 22-25 on one line and 26/26b on the next — so the lines are joined
    # back into one block per `STAGE ` heading before being read.
    #
    # 🔴 **EVERY phase on a started stage, whatever its own box says.** Filtering
    # on each phase's `[x]` was the circular fix a second time: un-ticking one
    # removes it from the set the check then walks, so the very drift this
    # catches makes itself invisible. Measured — both un-tick mutations survived.
    #
    # ⚠️ **A phase carrying a footnote marker is EXCLUDED**, because a marker is
    # a statement. Phase 26 shares Stage 4 with four finished phases and is
    # genuinely not begun; its `§§` note says so and says why. Demanding a `[~]`
    # instead would mean claiming partial progress that does not exist — the
    # ledger bending to satisfy the gate rather than the gate describing the
    # ledger.
    #
    # 📌 **A bare `[ ]` with no marker is still caught**, which is the drift:
    # Phases 22-25 all sat that way while shipped.
    STARTED=$(printf '%s\n' "$LEDGER" | awk '
      /^STAGE /  { if (buf ~ /\[[x~]\]/) print buf; buf = $0; next }
      /\[/      { buf = buf " " $0; next }
                 { if (buf ~ /\[[x~]\]/) print buf; buf = "" }
      END        { if (buf ~ /\[[x~]\]/) print buf }
    ' | grep -oE '\[[x ~]\] [0-9]+[a-z]?' | grep -oE '[0-9]+[a-z]?$')

    REACHED=$(printf '%s\n%s\n' "$REACHED" "$STARTED" | grep -v '^$' | sort -u)

    # ⚠️ **The phase the marker POINTS AT is excluded.** It is the work in
    # progress by definition -- the marker means "here" -- and failing on it
    # would mean the gate is red for the whole of every phase, which is a gate
    # nobody can act on and therefore a gate everybody silences. What is caught
    # is a phase the marker has moved PAST while its box stayed empty, which is
    # the drift that actually happened.
    # ⚠️ **`[^][]*`, not `[A-Za-z]+`.** A phase name can be two words -- "Super
    # admin", "Product sync", "Full builder" -- and a single-word pattern matched
    # none of them, leaving this EMPTY and the check silently taking its
    # "marker is on a gate" branch. A gate that fails open is worse than no gate,
    # and this one did until a mutation with the marker on Phase 26 caught it.
    # The class excludes brackets so the match cannot run into the next box.
    CURRENT=$(printf '%s\n' "$LEDGER" | grep '◀ HERE' \
      | grep -oE '\[[x ~ ]\] [0-9]+[a-z]?[^][]*◀ HERE' \
      | grep -oE '[0-9]+[a-z]?' | head -1)

    REACHED=$(printf '%s\n' $REACHED | grep -vxF "${CURRENT:-__none__}" || true)

    UNGRADED=""

    for phase in $PHASES; do
      case " $SEEN_PHASES " in
        *" $phase "*) continue ;;
      esac

      # Not yet reached: not this gate's business.
      case " $(printf '%s ' $REACHED)" in
        *" $phase "*) ;;
        *) continue ;;
      esac

      # Deliberately unstarted, and said so in a footnote. A marker beside the
      # box is a claim someone made; silence is what this check is for.
      if printf '%s\n' "$LEDGER" \
        | grep -qE "\\[ \\] ${phase} [A-Za-z][^][]*[*†‡§¶]"; then
        continue
      fi

      # Only phases the ledger actually tracks. A phase with no box is not drift.
      BOX=$(printf '%s\n' "$LEDGER" \
        | grep -oE "\[[x ~]\] ${phase} [A-Za-z]" | head -1 | cut -c2)

      [ -z "$BOX" ] && continue
      [ "$BOX" != " " ] && continue

      UNGRADED="$UNGRADED $phase"
    done

    if [ -z "$UNGRADED" ]; then
      pass "every phase reached so far is graded, ticked, or knowingly partial"
    else
      fail "ungradable and unticked:$UNGRADED — prose exits this gate cannot read"
      printf '      These phases state their exit as **Exit:** prose, so the criteria\n'
      printf '      loop skips them. Grade each by hand and tick it, or give it\n'
      printf '      checkbox criteria. Silence here is how 22-25 drifted.\n'
    fi
  fi
fi

# ---------------------------------------------------------------------------
# A ticked prose-exit phase must show its working (G1)
#
# 🔴 **The ungraded-phase check above catches UNDERSTATEMENT only.** It fails on
# a phase left `[ ]` that should be ticked -- and says nothing about a phase
# ticked `[x]` whose prose exit nobody ever graded. A mutation ticking Phase 25
# without doing the work passed it cleanly.
#
# ⚠️ **Overstatement is the likelier failure here, not the rarer one.** Phase 20
# was ticked grading the team's own usability from the inside; Phase 24 was
# ticked TWICE with exit criteria unmet. Both were caught by a human re-reading
# the plan, which is the thing this gate exists so nobody has to rely on.
#
# 📌 **What is required is a FOOTNOTE, not a judgement.** This gate cannot know
# whether prose is satisfied. It can require that a phase which is ticked, and
# whose criteria it cannot read, carries a dagger marker pointing at a written
# grading -- so the tick is an argument someone made rather than a box someone
# clicked. Phases 22-24 carry `††` and the footnote grades every clause against
# named evidence.
# ---------------------------------------------------------------------------

UNJUSTIFIED=""

for phase in $PHASES; do
  # Only phases whose criteria the loop above could NOT read.
  case " $SEEN_PHASES " in
    *" $phase "*) continue ;;
  esac

  # The ledger box for this phase, with any trailing footnote markers.
  ENTRY=$(printf '%s\n' "$LEDGER" \
    | grep -oE "\[[x ~]\] ${phase} [A-Za-z][A-Za-z.]*[^][]*" | head -1)

  [ -z "$ENTRY" ] && continue

  # Not ticked: the ungraded-phase check above owns that case.
  printf '%s' "$ENTRY" | grep -q '^\[x\]' || continue

  # Ticked and ungradable: it must point at a written grading.
  #
  # ⚠️ **The marker must have a FOOTNOTE BODY, not merely be present.** A bare
  # `††` in the ledger satisfied the first draft of this check -- the same
  # "satisfied by the wrong thing" defect gate 37 had (its own render test) and
  # gate 40 had (a comment). So the dagger the entry carries has to also open a
  # line elsewhere in the plan, which is where a human states the grading.
  # ✏️ **`†` and `‡` both, because the ledger already uses both.** The first
  # draft matched daggers only, and Phase 25's `‡‡` footnote — a real grading
  # with a clause-by-clause table — was rejected as missing. A gate that refuses
  # a valid marker teaches its reader to work around it.
  MARK=$(printf '%s' "$ENTRY" | grep -oE '[†‡]+' | head -1)

  if [ -n "$MARK" ] && grep -qF "$MARK **" "$PLAN"; then
    continue
  fi

  UNJUSTIFIED="$UNJUSTIFIED $phase"
done

if [ -z "$UNJUSTIFIED" ]; then
  pass "every ticked prose-exit phase points at a written grading"
else
  fail "ticked without a recorded grading:$UNJUSTIFIED"
  printf '      These phases state their exit as prose, so this gate cannot check\n'
  printf '      them. A tick therefore needs a dagger footnote grading each clause\n'
  printf '      against named evidence -- as Phases 22-24 carry. Phase 20 and Phase\n'
  printf '      24 were both ticked once without one, and both were wrong.\n'
fi

# ---------------------------------------------------------------------------
# STATUS still describes reality (G2 / F145's other half)
#
# 🔴 **Seven recurrences, and none of them were gated.** The STATUS block sat at
# 2026-09-10 naming *"Phase 19, stage 19-2"* while Phases 19, 20b, 21, 21b, 21c,
# 22, 23 and 24 all shipped past it. Before that it named Gate 1 while 14-16 were
# built. The plan records this failure seven times and says of it: *"a ledger
# nobody updates is a ledger nobody can trust to say what is left."*
#
# ⚠️ **The ledger gate did NOT cover this.** It reads the phase ledger and the
# gate sections; STATUS is a different block, and refreshing it stayed a thing a
# human had to remember. Fixing the seventh instance by hand without gating the
# class is how there came to be a seventh.
#
# 📌 **What is checked is AGREEMENT, not content.** Whether STATUS describes the
# work well is a human judgement. Whether the phase it points at is the phase the
# ledger's marker points at is arithmetic -- and disagreement between them is
# exactly what every one of the seven instances looked like.
# ---------------------------------------------------------------------------

STATUS_PHASE=$(awk '/^## ▶ THE NEXT THING TO DO/{f=1;next} f&&/^## /{exit} f' "$PLAN" \
  | grep -oE '\[Phase [0-9]+[a-z]?\]' | head -1 | grep -oE '[0-9]+[a-z]?')

MARKER_PHASE=$(printf '%s\n' "$LEDGER" | grep '◀ HERE' \
  | grep -oE '\[[x ~ ]\] [0-9]+[a-z]?[^][]*◀ HERE' \
  | grep -oE '[0-9]+[a-z]?' | head -1)

if [ -z "$STATUS_PHASE" ]; then
  # A marker on a GATE rather than a phase is legitimate; so is STATUS naming
  # that gate. Only a STATUS that names no phase at all is unreadable.
  if printf '%s\n' "$LEDGER" | grep -q '🚩 GATE [0-9]* ◀ HERE'; then
    pass "STATUS and the ledger marker both sit on a gate"
  else
    fail "STATUS names no phase — 'THE NEXT THING TO DO' must link one"
    printf '      Seven stale-STATUS instances all began with it naming the wrong phase.\n'
  fi
elif [ -z "$MARKER_PHASE" ]; then
  pass "the ledger marker sits on a gate; STATUS names Phase ${STATUS_PHASE}"
elif [ "$STATUS_PHASE" = "$MARKER_PHASE" ]; then
  pass "STATUS and the ledger agree the current phase is ${MARKER_PHASE}"
else
  fail "STATUS says Phase ${STATUS_PHASE}; the ledger marker says ${MARKER_PHASE}"
  printf '      One of the two is stale. This disagreement is what all seven\n'
  printf '      stale-STATUS instances looked like from the outside.\n'
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

# ---------------------------------------------------------------------------
# A deferred milestone must not already be shipped.
# ---------------------------------------------------------------------------
# 🔴 **M25.5 sat in the deferral table reading "⏸️ Small and genuinely wanted,
# so it follows GATE 2's remaining item" for a full day after it shipped.** The
# phase marker was right, every criterion box was right, and the table beneath
# them described work that was already done — so the one document that says
# what is left was wrong about what is left.
#
# ⚠️ **A milestone can legitimately be deferred AND mentioned elsewhere**, so
# prose is not the signal. What cannot both be true is a `⏸️` row for a
# milestone that another row marks `✅ Shipped`. That contradiction is
# mechanical, and it is the one a human reliably misses when ticking a phase.
DEFERRED_SHIPPED=0

while IFS= read -r line; do
  MS=$(printf '%s' "$line" | grep -oE '\*\*M[0-9]+\.[0-9]+\*\*' | head -1 | tr -d '*')
  [ -z "$MS" ] && continue

  # Does any OTHER line mark this same milestone as shipped?
  if grep -qE "\*\*${MS}\*\*.*✅ \*\*Shipped" "$PLAN"; then
    fail "${MS} is listed as deferred (⏸️) and as shipped (✅) at the same time"
    DEFERRED_SHIPPED=$((DEFERRED_SHIPPED + 1))
  fi
done <<EOF
$(grep -E '^\| \*\*M[0-9]+\.[0-9]+\*\*.*⏸️' "$PLAN" || true)
EOF

if [ "$DEFERRED_SHIPPED" -eq 0 ]; then
  pass "no milestone is both deferred and shipped"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d ledger check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll ledger checks passed.\033[0m\n'
