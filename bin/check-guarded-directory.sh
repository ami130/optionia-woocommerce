#!/usr/bin/env bash
#
# Everything that WRITES into the guarded upload directory is known to the
# thing that DELETES from it.
#
# ## Why this exists
#
# 🔴 **The sweeper deleted every print file the pipeline ever collected.**
# `Upload\UploadSweeper` decides what is an orphan by scanning the directory
# and comparing against `known_names()`, which read ONLY the uploads table. A
# print file lives in ORDER META, so every one looked abandoned and was removed
# the moment it passed the grace period.
#
# ⚠️ **Measured on a live site, not reasoned about.** Both print files the
# project had ever collected were gone, and the guarded directory held nothing
# but its own `.htaccess`, `index.php` and `web.config`. M26e.5's whole purpose
# is that a merchant can reach the file; a sweeper that cannot see it makes the
# milestone worthless — and 1,972 tests agreed everything was fine, because the
# two systems share a directory and nothing else.
#
# 📌 **The gap was structural, not a typo.** `RenderCollector` was written
# months after `UploadSweeper` and had no reason to know it existed. Nothing
# coupled them, so the next writer into that directory would be invisible the
# same way.
#
# ## What is checked
#
# **Not** that the sweeper is correct — only a run shows that, and the suite
# does. What is checked is the COUPLING: every file that writes into the
# directory is one the sweeper has been taught about, by name, in its own
# source. A new writer fails this gate until someone decides what the sweeper
# should do with its files.
set -u

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/optioniaWooCommercePlugin"
SWEEPER="$PLUGIN/src/Upload/UploadSweeper.php"

printf '\033[1m== check-guarded-directory.sh ==\033[0m\n'
printf 'Checking every writer into the guarded directory is known to the sweeper...\n'

if [ ! -f "$SWEEPER" ]; then
  fail "the sweeper is missing — this gate's path is stale"
  printf '\n\033[31m1 guarded-directory check failed.\033[0m\n'
  exit 1
fi

# ⚠️ **Comments stripped**, so prose naming a class cannot satisfy the rule —
# the mistake `check-option-type-parity.sh` made with the word `design`, caught
# only by deleting the call and watching the gate pass.
strip_php() {
  perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g;' "$1" 2>/dev/null || true
}

# A writer is a file that puts bytes into the store's own directory. Matched on
# the WRITE paired with the directory, because a class may hold the store for
# other reasons — `PrintFiles` reads from it and writes nothing.
WRITERS=""
WRITER_COUNT=0

while IFS= read -r file; do
  [ -n "$file" ] || continue

  BODY=$(strip_php "$file")

  printf '%s' "$BODY" | grep -q 'store->directory()\|this->directory()' || continue
  printf '%s' "$BODY" | grep -qE 'file_put_contents|move_uploaded_file|->move\(' || continue

  WRITER_COUNT=$((WRITER_COUNT + 1))
  WRITERS="$WRITERS $(basename "$file" .php)"
done <<EOF
$(find "$PLUGIN/src" -name '*.php' 2>/dev/null | sort)
EOF

# A gate that inspects nothing passes for the wrong reason.
if [ "$WRITER_COUNT" -lt 2 ]; then
  fail "found $WRITER_COUNT writer(s) into the guarded directory — the parser is wrong, not the code"
else
  SWEEPER_BODY=$(strip_php "$SWEEPER")
  UNKNOWN=""

  for writer in $WRITERS; do
    # The sweeper itself writes its own guard files; it needs no knowledge of
    # those, and `UploadStore` is the directory, not a user of it.
    case "$writer" in
      UploadSweeper|UploadStore|UploadMover) continue ;;
    esac

    # Known either by name, or by the meta key its files are recorded under.
    if printf '%s' "$SWEEPER_BODY" | grep -q "$writer"; then
      continue
    fi

    case "$writer" in
      RenderCollector)
        printf '%s' "$SWEEPER_BODY" | grep -q 'META_RENDER_FILES' && continue
        ;;
      UploadEndpoint)
        printf '%s' "$SWEEPER_BODY" | grep -q 'TABLE_UPLOADS' && continue
        ;;
    esac

    UNKNOWN="$UNKNOWN $writer"
  done

  if [ -n "$UNKNOWN" ]; then
    fail "writer(s) the sweeper does not know about:$UNKNOWN"
    printf '        a file it cannot account for is deleted as an orphan\n'
    printf '        teach known_names() where these files are recorded\n'
  else
    pass "all $WRITER_COUNT writer(s) into the guarded directory are accounted for"
  fi
fi

# 🔴 **The two record-keeping systems must reach `known_names()` ITSELF.**
#
# ⚠️ **Grepping the whole file was not enough, and the first version of this
# gate PASSED with the real defect reintroduced.** Deleting the print-file
# lookup from `known_names()` left `META_RENDER_FILES` present in the helper
# that fetches them — a method nothing called any more — so the check was
# satisfied by dead code. Measured by reintroducing the exact defect and
# watching the gate stay green, which is the only way this kind of flaw shows.
#
# 📌 **So the body of `known_names()` is extracted and checked on its own.** It
# is the one function whose answer decides what survives a sweep.
KNOWN_BODY=$(strip_php "$SWEEPER" \
  | awk '/private function known_names/{f=1} f{print} f&&/^\t}/{exit}')

if [ -z "$KNOWN_BODY" ]; then
  fail "could not read known_names() — this gate's parser is stale"
else
  for marker in 'TABLE_UPLOADS' 'print_file_names'; do
    if printf '%s' "$KNOWN_BODY" | grep -q "$marker"; then
      pass "known_names() consults $marker"
    else
      fail "known_names() no longer consults $marker — every file it records will be swept"
      printf '        a sweeper that cannot see a file deletes it as an orphan\n'
    fi
  done
fi

# And the lookup it delegates to must still read the meta key print files live in.
if strip_php "$SWEEPER" | grep -q 'META_RENDER_FILES'; then
  pass "the print-file lookup reads META_RENDER_FILES"
else
  fail "the print-file lookup no longer reads META_RENDER_FILES"
fi

printf '\n'

if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d guarded-directory check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi

printf '\033[32mAll guarded-directory checks passed.\033[0m\n'
