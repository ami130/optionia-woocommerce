#!/usr/bin/env bash
#
# Two gates that reported defects which were their own reading of the code.
#
# ## Why this exists
#
# 🔴 **A gate that misreads is worse than no gate.** It sends someone to fix
# code that was already correct, and it spends the credibility that makes the
# other thirty-five worth running. Both of these did exactly that on the first
# CI run after `ci.yml` stopped skipping them:
#
#   check-build-output.sh   asserted `dist/<entryFile>.js` exists ELEVEN LINES
#                           before the `npm run build` that emits it. It passed
#                           on a developer machine because an earlier build had
#                           left one behind; on a clean runner it failed with
#                           "which the build does not emit" — naming
#                           `nest-cli.json` when the fault was its own order.
#
#   check-scripts.sh        matched `(src|test|bin)/…` ANYWHERE in a script
#                           body, so `node dist/…/src/main.js` yielded the
#                           substring `src/main.js` — absent, because the source
#                           is `main.ts`. `start:prod` was correct throughout.
#
# ⚠️ **Neither fix is protected by anything else.** They are shell scripts with
# no suite, and both regressions are a one-line edit away: moving a block, or
# dropping an anchor from a regex. This asserts the two properties that make
# them read correctly, not their whole behaviour.
#
# 📌 **Line numbers are derived, never literal.** A gate that hard-coded them
# would fail on any unrelated edit and teach people to update it without
# thinking, which is how a check stops being one.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILED=$((FAILED + 1)); }

printf 'Checking the gates that misread the code…\n'

# --- 1. The build runs before anything asserts about its output --------------
BUILD_GATE="$ROOT/bin/check-build-output.sh"

if [ ! -f "$BUILD_GATE" ]; then
  fail "check-build-output.sh is missing — this gate's path is stale"
else
  # `|| true` on both: grep exits 1 with no match, and `set -u` would end the
  # script there rather than report — the silent abort this suite has hit before.
  # 🔴 **The BACKEND build, named specifically — not "a line mentioning a
  # build".** This file contains three such mentions: a comment, the backend
  # build, and the frontend build. Two earlier versions of this check were
  # defeated by that:
  #
  #   1. `grep -n … | grep -v '^\s*#'` never stripped comments, because every
  #      line already began with `16:` rather than `#`. It selected the comment
  #      and passed because 16 < 98 by luck.
  #   2. Taking the first non-comment match still passed with the original
  #      broken ordering restored, as long as ANY other line mentioning
  #      `npm run build` sat above the assertion — a `BUILD_CMD` variable, or
  #      the frontend build moving up. Demonstrated: green with the exact
  #      defect present.
  #
  # Matching `cd "$BACKEND" && npm run build` identifies the one invocation
  # whose output the assertion reads, so a decoy elsewhere cannot stand in for
  # it and reordering the two builds cannot either.
  BUILD_LINE=$(grep -n 'cd "$BACKEND" && npm run build' "$BUILD_GATE" | head -1 | cut -d: -f1 || true)
  ASSERT_LINE=$(grep -n 'DEV_ENTRY\.js' "$BUILD_GATE" | head -1 | cut -d: -f1 || true)

  if [ -z "$BUILD_LINE" ] || [ -z "$ASSERT_LINE" ]; then
    fail "could not locate the build and the entryFile assertion — this gate's parser is stale, not the code"
  elif [ "$BUILD_LINE" -lt "$ASSERT_LINE" ]; then
    pass "the backend build (line $BUILD_LINE) runs before the entryFile assertion (line $ASSERT_LINE)"
  else
    fail "the entryFile assertion (line $ASSERT_LINE) runs BEFORE the build (line $BUILD_LINE)"
    printf '        it will pass on a machine with a stale dist/ and fail on a clean runner\n'
  fi
fi

# --- 2. Script paths are matched at a token boundary -------------------------
SCRIPTS_GATE="$ROOT/optioniaWooCommerceBackend/bin/check-scripts.sh"

if [ ! -f "$SCRIPTS_GATE" ]; then
  fail "check-scripts.sh is missing — this gate's path is stale"
else
  # 🔴 **The pattern is LIFTED and run, not grepped for.** An earlier version
  # searched for the literal string `(^|\s)`, which failed a correct rewrite:
  # spelling the same anchor as `\b` reported "no longer anchors its path
  # pattern" against code that anchors perfectly well. A check that demands one
  # spelling teaches people to restore the spelling rather than the property.
  #
  # So the regex is extracted from the gate and exercised on two inputs: a
  # `dist/` path it must ignore, and a real source path it must still find.
  VERDICT=$(
    LINE=$(grep 'body\.match(/' "$SCRIPTS_GATE" | head -1 || true)

    if [ -z "$LINE" ]; then
      printf 'NOPATTERN'
    else
      node -e '
        const line = process.argv[1];
        const m = line.match(/body\.match\((\/.*\/)([gimsuy]*)\)/);

        if (!m) {
          process.stdout.write("NOPATTERN");
        } else {
          const re = new RegExp(m[1].slice(1, -1), m[2] || "g");

          /* The emitted artefact: its `src/` segment must NOT be taken as a
             source path, because `src/main.js` does not exist — the source is
             `main.ts` and the build writes under `dist/`. */
          const ignoresDist =
            "node dist/optioniaWooCommerceBackend/src/main.js".match(re) === null;

          /* …while a genuine reference must still be found, or the check would
             pass by matching nothing at all. */
          const findsReal =
            ("jest --config test/jest-e2e.json".match(re) || []).length > 0;

          process.stdout.write(ignoresDist ? (findsReal ? "OK" : "BLIND") : "UNANCHORED");
        }
      ' "$LINE" 2>/dev/null || printf 'NOPATTERN'
    fi
  )

  case "$VERDICT" in
    OK)
      pass "script paths are matched at a token boundary, not mid-string"
      ;;
    UNANCHORED)
      fail "check-scripts.sh matches a path inside dist/<project>/src/main.js"
      printf '        it will report a correct start:prod as referencing a missing file\n'
      ;;
    BLIND)
      fail "check-scripts.sh no longer matches real source paths"
      printf '        it would pass by finding nothing, which is not the same as finding nothing wrong\n'
      ;;
    *)
      fail "could not lift the path pattern from check-scripts.sh — this gate's parser is stale, not the code"
      ;;
  esac
fi

if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32mAll gate-integrity checks passed.\033[0m\n'
else
  printf '\n\033[31m%d gate-integrity check(s) failed.\033[0m\n' "$FAILED"
fi

exit "$FAILED"
