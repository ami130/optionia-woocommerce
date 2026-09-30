#!/usr/bin/env bash
#
# An exported symbol has a consumer, not merely a file that does.
#
# ## The blind spot this closes
#
# 🔴 **`check:reachable` works on FILES, and that is enough to hide a whole
# module's worth of dead code.** `design/design-geometry.types.ts` entered the
# codebase exporting nine things of which exactly one was used — and the gate
# passed, because one used export makes the file "reached".
#
# ⚠️ **That is the fifth instance of this project's mechanism-with-no-caller
# defect, and the first to pass THROUGH a gate rather than be caught by one.** A
# check at the wrong granularity gives false assurance, which is worse than no
# check: the screen-reachability gate did the same thing a day earlier by
# matching a field name inside a comment.
#
# ## What is checked
#
# Only the directories where ported or pre-built code lands ahead of its caller.
# 📌 **Not the whole codebase**, deliberately: a shared type exported for a
# future consumer is the normal shape of `common/`, and flagging all of it would
# produce an exemption list nobody reads.
#
# Exemptions are per FILE, with the stage that removes them.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/optioniaWooCommerceBackend/src"

printf '\033[1m== check-symbol-reachable.sh ==\033[0m\n'
printf 'Checking that exported symbols have consumers...\n'

# 🔴 **A whole FILE may be exempt; a symbol may not be silently unused.**
# Exempting a file says "this is ported ahead of a named stage", which is true
# and dated. Exempting a symbol would say "this one is fine to be dead", which
# is how an exemption list stops being read.
is_exempt_file() {
  case "$1" in
    # Ported from `optionia-app` ahead of its consumer. `designScene.ts`
    # (M26c.1) reads every one of these in one function signature.
    # ⚠️ **DELETE WHEN M26c.1 LANDS**, or they are a transcription nobody needed.
    design/design-geometry.types.ts) return 0 ;;

    # Guards written before the thing they guard, and already exempt in
    # `check-reachable.ts` with these same stages. ⚠️ An unbounded canvas
    # OOM-kills a container with no error to report (M26e.4); a design with no
    # recorded aspect reflows onto a differently-shaped product (M26c.4).
    design/letterbox.ts) return 0 ;;
    common/render/render-bounds.ts) return 0 ;;

    *) return 1 ;;
  esac
}

# ⚠️ **One per line, not a space-separated string.** The repository path contains
# a space, so a `for dir in $WATCHED` loop yielded one non-existent path and the
# gate checked nothing — caught by the "checked no symbols at all" assertion
# below, which is why that assertion exists.
WATCHED_DIRS="design
common/render"

UNUSED=""
CHECKED=0
EXEMPT=0

while IFS= read -r watched; do
  [ -n "$watched" ] || continue

  dir="$SRC/$watched"

  [ -d "$dir" ] || continue

  for file in "$dir"/*.ts; do
    [ -f "$file" ] || continue

    case "$file" in *.spec.ts) continue ;; esac

    rel="${file#"$SRC/"}"

    if is_exempt_file "$rel"; then
      EXEMPT=$((EXEMPT + 1))
      continue
    fi

    for symbol in $(grep -oE "^export (const|function|interface|type|class) [A-Za-z_][A-Za-z0-9_]*" "$file" \
      | awk '{print $3}'); do
      CHECKED=$((CHECKED + 1))

      # A consumer is any non-test file outside this one that names it.
      hits=$(grep -rlE "\b$symbol\b" "$SRC" --include='*.ts' 2>/dev/null \
        | grep -v "^$file$" \
        | grep -v '\.spec\.ts$' \
        | wc -l | tr -d ' ')

      if [ "$hits" -eq 0 ]; then
        UNUSED="$UNUSED  $rel :: $symbol\n"
      fi
    done
  done
done <<EOF
$WATCHED_DIRS
EOF

if [ "$CHECKED" -eq 0 ] && [ "$EXEMPT" -eq 0 ]; then
  fail "checked no symbols at all — the parser is wrong, not the code"
elif [ -n "$UNUSED" ]; then
  fail "exported symbol(s) with no production consumer:"
  printf "%b" "$UNUSED" | sed 's|^|      |'
  printf '        a symbol only its own tests use is code the product does not run\n'
  printf '        give it a caller, delete it, or exempt the FILE with a removal stage\n'
else
  pass "all $CHECKED watched symbol(s) have a consumer ($EXEMPT file(s) exempt)"
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d symbol-reachability check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll symbol-reachability checks passed.\033[0m\n'
