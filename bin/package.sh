#!/usr/bin/env bash
#
# Build the distributable plugin zip (M20b.3).
#
#   bash bin/package.sh [output-dir]
#
# Produces `optionia-<version>.zip` containing a single top-level `optionia/`
# directory, which is what WordPress expects from "Upload Plugin".
#
# ## An allow-list, not a deny-list
#
# 🔴 **The list below names what ships; everything else is excluded by default.**
# A deny-list ships any file nobody remembered to exclude — a new `.env.example`,
# a scratch script, a developer's notes — and the failure is silent because the
# plugin still works. The cost of the allow-list is that a genuinely new runtime
# directory must be added here, which `check-package.sh` turns into a failing
# test rather than a missing file on a merchant's server.
#
# ## Why no `vendor/`
#
# The plugin has **no runtime Composer dependencies** — `composer.json` requires
# only `php`, `ext-intl` and `ext-mbstring`, and everything under `require-dev` is
# tooling. `optionia.php` loads `vendor/autoload.php` *if present* and falls back
# to `src/Autoloader.php`, so the zip ships without it and loads through its own
# autoloader. That keeps 26M out of every merchant's download.
#
# There is likewise **no JS build step**: `assets/` holds plain CSS and JS with no
# bundler and no runtime dependencies, so the files ship as they are.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

OUT_DIR="${1:-dist}"

# Everything the plugin needs at runtime, and nothing else.
#
# `templates/` is **runtime code** despite the name — `Frontend/Templates.php`
# resolves `templates/options/*.php` to render a storefront option, and an
# overridable theme path falls back to it. Excluding it by its name would ship a
# plugin that renders nothing.
INCLUDE=(src assets templates languages optionia.php uninstall.php)

VERSION="$(grep -m1 "define( 'OPTIONIA_VERSION'" optionia.php | sed "s/.*'\([0-9][^']*\)'.*/\1/")"

if [ -z "$VERSION" ]; then
  echo "Could not read OPTIONIA_VERSION from optionia.php" >&2
  exit 1
fi

# The header and the constant are already required to agree by
# `check-architecture.sh`, so either is a trustworthy source for the filename.
HEADER_VERSION="$(grep -m1 '^ \* Version:' optionia.php | sed 's/.*Version: *//' | tr -d ' \r')"

if [ "$VERSION" != "$HEADER_VERSION" ]; then
  echo "Version mismatch: header $HEADER_VERSION != OPTIONIA_VERSION $VERSION" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/optionia"

for path in "${INCLUDE[@]}"; do
  if [ ! -e "$path" ]; then
    echo "Missing required path: $path" >&2
    exit 1
  fi

  cp -R "$path" "$STAGE/optionia/"
done

# Developer artefacts that live *inside* otherwise-shipping directories.
#
# ⚠️ `src/` and `templates/` are copied wholesale, so anything a developer leaves
# in them travels. These are the patterns that have no business on a merchant's
# server; `check-package.sh` asserts the result rather than trusting this list.
find "$STAGE/optionia" \
  \( -name '.DS_Store' -o -name '*.map' -o -name '__tests__' -o -name '*.test.js' \) \
  -exec rm -rf {} + 2>/dev/null

mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/optionia-$VERSION.zip"
rm -f "$ZIP"

# `-x` on the directory name, not a path: zip is run from the stage root so the
# archive carries `optionia/…` and nothing above it.
( cd "$STAGE" && zip -qr "optionia.zip" optionia ) || exit 1
mv "$STAGE/optionia.zip" "$ZIP"

printf '\033[32mok\033[0m    built %s (%s)\n' "$ZIP" "$(du -h "$ZIP" | cut -f1 | tr -d ' ')"
