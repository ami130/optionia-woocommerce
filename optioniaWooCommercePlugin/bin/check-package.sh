#!/usr/bin/env bash
#
# The distributable zip contains what a merchant needs and nothing else (M20b.3).
#
# 🔴 **A packaging bug is invisible until it is on someone's server.** A missing
# runtime directory renders nothing; a stray `vendor/` adds 26M to every download;
# a shipped `tests/` or `.env` is a disclosure. None of it shows up in development,
# where the files are all present anyway — so the archive is asserted rather than
# eyeballed.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

echo "Checking the distributable package..."

command -v zip >/dev/null 2>&1 || { fail "zip is not installed"; exit 1; }
command -v unzip >/dev/null 2>&1 || { fail "unzip is not installed"; exit 1; }

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if ! bash bin/package.sh "$OUT" >/dev/null 2>&1; then
  fail "bin/package.sh did not build"
  exit 1
fi

ZIP="$(find "$OUT" -name 'optionia-*.zip' | head -1)"
[ -n "$ZIP" ] || { fail "no zip produced"; exit 1; }

# `unzip -Z1` lists paths only.
#
# ✏️ `unzip -l | awk '{print $4}'` was the first attempt and it silently included
# the table's own header and rule rows — so the "one top-level directory" check
# counted `Name` and `----` as entries and failed against a correct archive.
LISTING="$(unzip -Z1 "$ZIP")"

# ── What must be there ──────────────────────────────────────────────────────
#
# One entry per runtime concern, named individually: a single "src/ exists"
# check passes against a zip holding one stray file from it.
REQUIRED=(
  'optionia/optionia.php'
  'optionia/uninstall.php'
  'optionia/src/Autoloader.php'
  'optionia/src/Plugin.php'
  # `templates/` is runtime code despite the name — `Frontend/Templates.php`
  # renders storefront options from it, so a zip without it renders nothing.
  'optionia/templates/options/'
  'optionia/assets/js/frontend.js'
  'optionia/assets/css/frontend.css'
)

MISSING=0
for path in "${REQUIRED[@]}"; do
  if ! printf '%s\n' "$LISTING" | grep -q "^${path}"; then
    fail "missing from the package: $path"
    MISSING=1
  fi
done
[ "$MISSING" -eq 0 ] && pass "every runtime path is present (${#REQUIRED[@]} checked)"

# ── What must NOT be there ──────────────────────────────────────────────────
#
# ⚠️ Each pattern is a real cost: `vendor/` and `node_modules/` are 26M and 66M,
# `tests/` and `bin/` are developer surface, and a dotfile is how a secret ships.
FORBIDDEN=(
  'optionia/vendor/'
  'optionia/node_modules/'
  'optionia/tests/'
  'optionia/bin/'
  'optionia/composer.json'
  'optionia/package.json'
  'optionia/phpunit.xml.dist'
  'optionia/phpcs.xml.dist'
  'optionia/.git'
  'optionia/.env'
)

FOUND=0
for path in "${FORBIDDEN[@]}"; do
  if printf '%s\n' "$LISTING" | grep -q "^${path}"; then
    fail "must not ship: $path"
    FOUND=1
  fi
done
[ "$FOUND" -eq 0 ] && pass "no development artefact ships (${#FORBIDDEN[@]} patterns)"

# ── One top-level directory ─────────────────────────────────────────────────
#
# WordPress installs "Upload Plugin" archives by extracting them into
# `wp-content/plugins/`. A zip with two roots, or with the files loose, installs
# to the wrong place or not at all.
ROOTS="$(printf '%s\n' "$LISTING" | sed 's|/.*||' | sort -u | grep -v '^$' | wc -l | tr -d ' ')"
if [ "$ROOTS" = "1" ]; then
  pass "one top-level directory, as WordPress expects"
else
  fail "the archive has $ROOTS top-level entries; WordPress needs exactly one"
fi

# ── The filename states the version it contains ─────────────────────────────
#
# The download route serves this by name, so a zip whose name disagrees with its
# own header would hand a merchant a version they did not ask for.
ZIP_VERSION="$(basename "$ZIP" .zip | sed 's/^optionia-//')"
HEADER_VERSION="$(unzip -p "$ZIP" optionia/optionia.php | grep -m1 '^ \* Version:' | sed 's/.*Version: *//' | tr -d ' \r')"

if [ "$ZIP_VERSION" = "$HEADER_VERSION" ]; then
  pass "filename version ($ZIP_VERSION) matches the packaged header"
else
  fail "filename says $ZIP_VERSION, the packaged plugin says $HEADER_VERSION"
fi

# ── The archive is not trivially small ──────────────────────────────────────
#
# A gate that passes against an empty zip passes for the wrong reason. The floor
# is well below the real count (~150 files) and well above a broken build.
COUNT="$(printf '%s\n' "$LISTING" | grep -c '[^/]$')"
if [ "$COUNT" -ge 50 ]; then
  pass "$COUNT files packaged"
else
  fail "only $COUNT file(s) packaged — the build is broken, not the plugin"
fi

# ── The directory that is actually served ───────────────────────────────────
#
# 🔴 **Everything above tests a zip built into a temp directory**, which is right
# for checking what `package.sh` produces and blind to what is on disk. The
# download route serves `dist/`, and nothing looked at it.
#
# Reproduced during the Phase 20b audit: bump the plugin to 0.3.0, package,
# revert the source to 0.2.0 — and `GET /plugin/latest` advertises **0.3.0** while
# the repository says **0.2.0**, with every gate green. A merchant downloads a
# version the source no longer matches.
#
# ⚠️ **Older versions are not the problem.** A merchant on 0.1.0 may legitimately
# re-download it, and `latest` picks the highest, so keeping them is correct. What
# cannot be right is an archive **newer than the source that built it** — that one
# can only come from a build nobody reverted.
DIST="${DIST_DIR:-dist}"

if [ ! -d "$DIST" ]; then
  # Not an error: a clean checkout has never built one, and the download route
  # answers 404, which is the truth.
  pass "no dist/ yet — nothing stale to serve"
else
  SOURCE_VERSION="$(grep -m1 "define( 'OPTIONIA_VERSION'" optionia.php | sed "s/.*'\([0-9][^']*\)'.*/\1/")"
  NEWER=""

  for archive in "$DIST"/optionia-*.zip; do
    [ -e "$archive" ] || continue

    FOUND="$(basename "$archive" .zip | sed 's/^optionia-//')"

    # Sort numerically per segment: `0.10.0` is newer than `0.9.0`, and a string
    # comparison says the opposite.
    HIGHEST="$(printf '%s\n%s\n' "$SOURCE_VERSION" "$FOUND" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"

    if [ "$HIGHEST" = "$FOUND" ] && [ "$FOUND" != "$SOURCE_VERSION" ]; then
      NEWER="$NEWER $FOUND"
    fi
  done

  if [ -n "$NEWER" ]; then
    fail "dist/ holds archive(s) newer than the source ($SOURCE_VERSION):$NEWER"
    printf '        the download route would serve a version this repository is not at\n'
  else
    pass "dist/ holds nothing newer than the source ($SOURCE_VERSION)"
  fi
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d package check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll package checks passed.\033[0m\n'
