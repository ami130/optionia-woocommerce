#!/usr/bin/env bash
#
# Every page can be reached from inside the app, or says why it cannot.
#
# ## Why this exists
#
# 🔴 **Twice in three commits I built a screen nobody could navigate to.** The
# admin plans page shipped with no nav entry; the fix for that was a nav entry
# and `check-route-guards.sh` — and the pricing page shipped one commit later
# with the identical defect, because that gate checks *modelled routes exist*,
# not *real pages are reachable*. It passed while `/pricing` was orphaned.
#
# ⚠️ **The lesson was narrower than the one available.** Fixing the instance
# left the property unguarded; this checks the property.
#
# ## What counts as reachable
#
# A `<Link href>`, a `href:` entry in a navigation array, or a
# `router.push`/`replace` from anywhere other than the page itself. A page that
# only links to itself is not reachable.
#
# 📌 **Arriving from OUTSIDE is reachable too**, and four pages do. A password
# reset arrives from an email, a store handshake from WordPress, a redirect
# target is never linked — each is named below with its reason, because the
# alternative is a check people switch off the first time it is wrong.
set -euo pipefail

printf '\033[1m== check-page-reachable.sh ==\033[0m\n'
printf 'Checking that every page can be reached…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/optioniaWooCommerceFrontend/src"

if [ ! -d "$SRC/app" ]; then
  fail "the app directory is missing — this gate is checking nothing"
  exit 1
fi

# Pages reached from outside the app. Each needs a reason, not just a path.
is_entry_point() {
  case "$1" in
    # The root renders nothing; it redirects by session state.
    /) return 0 ;;

    # ⚠️ **A link in an email is the credential.** `/reset-password` is opened
    # from a message, and the token in the URL is what authorises it — linking
    # to it from inside the app would offer a reset with no token.
    /reset-password) return 0 ;;

    # ⚠️ **WordPress sends the merchant here.** The plugin opens `/connect` and
    # `/install` to hand over a handshake; neither is somewhere a merchant
    # navigates to from the dashboard.
    /connect) return 0 ;;

    *) return 1 ;;
  esac
}

# A dynamic segment is reached by its list, which is checked on its own.
is_dynamic() {
  case "$1" in
    *'['*']'*) return 0 ;;
    *) return 1 ;;
  esac
}

UNREACHABLE=""
CHECKED=0
EXEMPT=0

while IFS= read -r page; do
  [ -z "$page" ] && continue

  route=$(printf '%s' "$page" \
    | sed "s|$SRC/app||;s|/page.tsx||;s|([a-z]*)||g;s|//*|/|g")
  [ -z "$route" ] && route="/"

  if is_entry_point "$route" || is_dynamic "$route"; then
    EXEMPT=$((EXEMPT + 1))
    continue
  fi

  CHECKED=$((CHECKED + 1))

  # ⚠️ **The page's own file is excluded by its REAL path**, not by a path
  # rebuilt from the route. A route group is a parenthesised directory that does
  # not appear in the URL, so `/selfish` lives at `app/(public)/selfish/page.tsx`
  # and an exclusion of `app/selfish/page.tsx` matched nothing — a page linking
  # only to itself counted as reachable. Caught by the probe written to prove
  # the opposite.
  links=$(grep -rlE "href=[\"']${route}[\"']|href: '${route}'|push\('${route}'\)|replace\('${route}'\)" \
    "$SRC" --include='*.tsx' --include='*.ts' 2>/dev/null \
    | grep -vxF "$page" | wc -l | tr -d ' ' || true)

  if [ "${links:-0}" -eq 0 ]; then
    UNREACHABLE="$UNREACHABLE  $route\n"
  fi
done <<EOF
$(find "$SRC/app" -name 'page.tsx' -type f)
EOF

if [ "$CHECKED" -eq 0 ]; then
  fail "checked no pages at all — the parser is wrong, not the code"
elif [ -n "$UNREACHABLE" ]; then
  fail "page(s) nothing links to:"
  printf "%b" "$UNREACHABLE" | sed 's|^|      |'
  printf '        a page nobody can navigate to is not shipped\n'
  printf '        link it, or name it as an entry point with a reason\n'
else
  pass "all $CHECKED page(s) are reachable ($EXEMPT entry point(s) and dynamic route(s))"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d page-reachability check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll page-reachability checks passed.\033[0m\n'
