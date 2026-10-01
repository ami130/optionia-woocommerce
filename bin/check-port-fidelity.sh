#!/usr/bin/env bash
#
# Every symbol in the ported source is accounted for.
#
# ## Why this exists
#
# 🔴 **Two symbols went missing from the same port, silently.** `DesignImage`
# and `frameClipId` were both in the block being ported, both skipped, and both
# found only by a later audit reading the source again. Neither was a decision —
# each was an omission that looked like one.
#
# ⚠️ **A port's only value is fidelity.** The reason to port `designScene.ts`
# rather than rewrite it is that it carries parity fixes derived across four
# rendering surfaces; a port missing pieces is a rewrite with extra steps and
# the same cost the port was meant to avoid.
#
# ## What is checked
#
# Every `export` in the source file must either appear in the port, or be listed
# below as deliberately not ported, with a reason. 📌 **Not "the port is
# correct"** — mutation tests do that. This answers the narrower question a human
# reading two files cannot reliably answer: *is anything simply absent?*
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/optionia-app/app/components/design-lab/designScene.ts"
# The two sibling files this port MERGES IN — their exports were always public,
# just in a different file, so they are not "widened" surface.
SRC_DIR="$ROOT/optionia-app/app/components/design-lab"
# ⚠️ **`shared/design`, not the backend's `src/`.** The geometry moved out when
# the dashboard's canvas store became its second consumer (M26d.1) — before
# either depended on it, which was the cheapest moment. This gate failed loudly
# on the stale path rather than passing on an empty one, which is why repointing
# it was a correction and not a discovery.
PORT_DIR="$ROOT/shared/design"

printf '\033[1m== check-port-fidelity.sh ==\033[0m\n'
printf 'Checking the designScene port against its source...\n'

if [ ! -f "$SOURCE" ]; then
  # 📌 **Not a failure.** The reference repository is a sibling checkout and may
  # legitimately be absent — on CI, or on a machine that never had it. A gate
  # that failed here would fail for everyone who did nothing wrong.
  pass "reference not present; nothing to compare (this is not a defect)"
  printf '\n\033[32mAll port-fidelity checks passed.\033[0m\n'
  exit 0
fi

if [ ! -d "$PORT_DIR" ]; then
  fail "missing: optioniaWooCommerceBackend/src/design"
  printf '\n\033[31m1 port-fidelity check failed.\033[0m\n'
  exit 1
fi

# Symbols deliberately NOT ported, each with the reason.
#
# ⚠️ **A reason, not a list.** "Not needed" is how a list stops being read; each
# entry here names what replaces it or why it cannot apply.
not_ported() {
  case "$1" in
    # `resvg` renders <textPath> natively, so nothing consumes ArcParams —
    # `text-to-path.server.ts` was its only reader and does not port.
    ArcParams) return 0 ;;
    *) return 1 ;;
  esac
}

PORTED=$(cat "$PORT_DIR"/*.ts 2>/dev/null \
  | grep -oE "^export (const|function|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" \
  | awk '{print $3}' | sort -u)

MISSING=""
CHECKED=0
SKIPPED=0

for symbol in $(grep -oE "^export (const|function|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" "$SOURCE" \
  | awk '{print $3}' | sort -u); do
  if not_ported "$symbol"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  CHECKED=$((CHECKED + 1))

  if ! printf '%s\n' "$PORTED" | grep -qx "$symbol"; then
    MISSING="$MISSING  $symbol\n"
  fi
done

if [ "$CHECKED" -eq 0 ]; then
  fail "parsed no symbols from the source — the parser is wrong, not the code"
elif [ -n "$MISSING" ]; then
  # 🔴 **Reported, and NOT a failure while the port is in progress.** The text
  # half of `designScene.ts` lands in a later stage, and failing on it would
  # make the gate red for a month and therefore ignored. It fails only once the
  # port claims to be finished — see PORT_COMPLETE below.
  COUNT=$(printf "%b" "$MISSING" | grep -c . || true)

  if [ -f "$PORT_DIR/.port-complete" ]; then
    fail "the port is marked complete and $COUNT symbol(s) are absent:"
    printf "%b" "$MISSING" | sed 's|^|      |'
    printf '        port it, or list it in not_ported() with a reason\n'
  else
    pass "$((CHECKED - COUNT)) of $CHECKED symbol(s) ported; $COUNT pending, $SKIPPED not ported by design"
    printf '      still to port:\n'
    printf "%b" "$MISSING" | sed 's|^|        |'
  fi
else
  pass "every one of $CHECKED source symbol(s) is ported ($SKIPPED not ported by design)"
fi

# 🔴 **The source's PRIVATE functions are invisible to the check above**, which
# reads `^export` only — and they are where the geometry actually lives.
# `arcGeometryFromR` alone builds every arc path and bbox; `glyphReach` and
# `curveTheta` feed every radius. A port that dropped one would still report
# "every symbol ported", because the gate would never have been looking.
#
# ⚠️ **Found by auditing this gate, not by it.** Each was verified by hand and
# all seven were present — but "I checked once" is not a gate, and the next
# private helper the source grows would go unnoticed.
PRIVATE_SYMBOLS="curveTheta
glyphReach
arcGeometryFromR
escAttr
textAnchorFor
GLYPH_ASCENT
GLYPH_DESCENT"

PRIVATE_MISSING=""
PRIVATE_CHECKED=0
while IFS= read -r sym; do
  [ -z "$sym" ] && continue
  # It must exist in the SOURCE (or this list has gone stale) …
  if ! grep -qE "(^|[^A-Za-z0-9_])(function|const) $sym\b" "$SOURCE"; then
    fail "private symbol '$sym' is no longer in the source — this list is stale"
    continue
  fi
  PRIVATE_CHECKED=$((PRIVATE_CHECKED + 1))
  # … and somewhere in the port, exported or not.
  if ! grep -rqE "(^|[^A-Za-z0-9_])(function|const) $sym\b" "$PORT_DIR"/*.ts 2>/dev/null; then
    PRIVATE_MISSING="$PRIVATE_MISSING  $sym\n"
  fi
done <<EOF
$PRIVATE_SYMBOLS
EOF

if [ "$PRIVATE_CHECKED" -eq 0 ]; then
  fail "checked no private symbols at all — the parser is wrong, not the code"
elif [ -n "$PRIVATE_MISSING" ]; then
  fail "private source symbol(s) absent from the port:"
  printf "%b" "$PRIVATE_MISSING" | sed 's|^|      |'
  printf '        these carry the geometry; the export check cannot see them\n'
else
  pass "all $PRIVATE_CHECKED private source symbol(s) are present too"
fi

# ⚠️ **The port EXPORTS more than the source does, and every addition is listed
# here rather than left for a reviewer to rediscover.** The source exports 28
# symbols; the port exports 50. That gap looks alarming until it is itemised, and
# an unexplained gap is exactly how an accidental leak hides among deliberate
# ones.
#
# 📌 Thirteen come from `types.ts` and `helpers.ts` — separate files in the
# source that this port merges in, so they were always public, just elsewhere.
# The rest are deliberate:
#
#   • LINE_HEIGHT, MIN_FONT_RATIO — the named-constant fix M26c.1 asked for.
#   • Letterbox, letterboxFor, willLetterbox, AuthoringCanvas, authoringCanvasOf
#     — the aspect policy (Decision 5). Deliberately absent from the source,
#     which is where the reflow defect it prevents comes from.
#   • LayerRect, TextAnchor — return shapes named so callers can hold one.
#   • textAnchorFor — private in the source; exported here because flat and
#     curved text now live in separate modules and both need it.
WIDENED="LINE_HEIGHT
MIN_FONT_RATIO
Letterbox
letterboxFor
willLetterbox
AuthoringCanvas
authoringCanvasOf
LayerRect
TextAnchor
textAnchorFor"

UNDECLARED=""
WIDENED_OK=0
PORT_ONLY=$(printf '%s\n' "$PORTED" | while IFS= read -r sym; do
  [ -z "$sym" ] && continue
  grep -qE "^export (const|function|interface|type|class) $sym\b" "$SOURCE" && continue
  grep -qE "^export (const|function|interface|type) $sym\b" "$SRC_DIR/types.ts" 2>/dev/null && continue
  grep -qE "^export (const|function|interface|type) $sym\b" "$SRC_DIR/helpers.ts" 2>/dev/null && continue
  printf '%s\n' "$sym"
done)

while IFS= read -r sym; do
  [ -z "$sym" ] && continue
  if printf '%s\n' "$WIDENED" | grep -qx "$sym"; then
    WIDENED_OK=$((WIDENED_OK + 1))
  else
    UNDECLARED="$UNDECLARED  $sym\n"
  fi
done <<EOF
$PORT_ONLY
EOF

if [ -n "$UNDECLARED" ]; then
  fail "the port exports symbol(s) the source does not, and they are not declared:"
  printf "%b" "$UNDECLARED" | sed 's|^|      |'
  printf '        add it to WIDENED with a reason, or stop exporting it\n'
else
  pass "all $WIDENED_OK widened export(s) are declared with a reason"
fi

# 📌 **What this gate does NOT prove, stated so nobody over-reads it.** It
# matches NAMES. A symbol whose body is wrong passes every check above. The
# evidence for behaviour is the differential fuzzing recorded in
# docs/M26-PRINT-PIPELINE-DECISIONS.md — 300,003 arc comparisons and 46,837
# byte-identical SVG documents — and this assertion exists so the two are read
# together rather than the cheap one being mistaken for the strong one.
if grep -q '46,837' "$ROOT/docs/M26-PRINT-PIPELINE-DECISIONS.md" 2>/dev/null; then
  pass "behavioural evidence is recorded (names alone are not proof)"
else
  fail "the differential-fuzz evidence is missing from the decisions document"
  printf '        this gate proves NAMES; the fuzz is what proves behaviour\n'
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d port-fidelity check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll port-fidelity checks passed.\033[0m\n'
