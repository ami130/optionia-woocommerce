#!/usr/bin/env bash
#
# The thing that ships is the thing that was checked.
#
# ## Why this exists
#
# 🔴 **Moving the geometry to `shared/` broke production, and all 31 gates
# passed.** Widening the backend's `include` to `../shared/**` made TypeScript
# infer the emit root from the widest common ancestor — the repository root — so
# `nest build` wrote `dist/optioniaWooCommerceBackend/src/main.js` while
# `start:prod` still ran `node dist/main.js`. The server could not start.
#
# ⚠️ **Nothing noticed because nothing built.** 1,712 unit tests, 1,279 e2e,
# lint, typecheck and every gate were green: a compile error would have been
# caught, a BUILD OUTPUT error would not. CI runs `lint` and `typecheck` and
# never `npm run build`.
#
# 📌 **That is the gap this closes, not the instance.** A file move is exactly
# where compile-success and build-success diverge, and the next one will be too.
set -euo pipefail

printf '\033[1m== check-build-output.sh ==\033[0m\n'
printf 'Checking the built artefact…\n'

FAILURES=0
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/optioniaWooCommerceBackend"

if [ ! -f "$BACKEND/package.json" ]; then
  fail "the backend is missing — this gate is checking nothing"
  exit 1
fi

# The entry point `start:prod` actually runs, read from the script rather than
# assumed — a hard-coded `dist/main.js` here would drift from the script it is
# meant to protect.
ENTRY=$(node -e "
  const p = require('$BACKEND/package.json');
  const s = p.scripts && p.scripts['start:prod'];
  if (!s) { process.exit(3); }
  const m = s.match(/([\w./-]*dist[\w./-]*\.js)/);
  process.stdout.write(m ? m[1] : '');
" 2>/dev/null || true)

if [ -z "$ENTRY" ]; then
  fail "could not read an entry point from start:prod — the parser is wrong, not the code"
  printf '\n\033[31m1 build-output check failed.\033[0m\n'
  exit 1
fi

pass "start:prod runs $ENTRY"

# 🔴 **`start:dev` was broken for weeks and this gate did not look.** When a
# production file began importing `@shared/*`, TypeScript's emit root moved from
# `dist/main.js` to `dist/optioniaWooCommerceBackend/src/main.js`. `start:prod`
# was corrected; `nest start`, `start:dev` and `start:debug` were not, and they
# resolve their entry through `nest-cli.json` rather than through a script this
# gate could read. The failure surfaced only when someone tried to run the API
# locally — *"Cannot find module .../dist/main"* — and from a merchant's side it
# looked like *"Optionia could not reach the connection service"*.
#
# ⚠️ **A gate that checks only the deploy path leaves the development path to
# luck.** `entryFile` must name the file that actually exists, because `nest
# start` defaults to `main` and says nothing about why it cannot find it.
NEST_CLI="$BACKEND/nest-cli.json"

if [ ! -f "$NEST_CLI" ]; then
  fail "nest-cli.json is missing — nest start has no entry point to resolve"
else
  DEV_ENTRY=$(node -e "
    const c = require('$NEST_CLI');
    process.stdout.write(c.entryFile || 'main');
  " 2>/dev/null || true)

  if [ -z "$DEV_ENTRY" ]; then
    fail "could not read entryFile from nest-cli.json — the parser is wrong, not the code"
  elif [ -f "$BACKEND/dist/$DEV_ENTRY.js" ]; then
    pass "nest start resolves dist/$DEV_ENTRY.js — the dev server can start"
  else
    fail "nest start would look for dist/$DEV_ENTRY.js, which the build does not emit"
    printf '        start, start:dev and start:debug all resolve through this\n'
    printf '        set entryFile in nest-cli.json to the emitted path\n'
  fi
fi

# 🔴 **A real build, not a typecheck.** `deleteOutDir` is on, so this is the
# same artefact a deploy would produce.
if ( cd "$BACKEND" && npm run build >/tmp/check-build.log 2>&1 ); then
  pass "the backend builds"
else
  fail "the backend does not build"
  tail -5 /tmp/check-build.log | sed 's|^|      |'
  printf '\n\033[31m1 build-output check failed.\033[0m\n'
  exit 1
fi

# 1. The entry point exists where the start script looks.
if [ -f "$BACKEND/$ENTRY" ]; then
  pass "$ENTRY exists — the server can start"
else
  fail "$ENTRY does not exist — \`npm run start:prod\` would fail"
  printf '        built instead:\n'
  find "$BACKEND/dist" -name 'main.js' 2>/dev/null | sed "s|$BACKEND/|        |" | head -3
fi

# 2. No test code in the artefact.
#
# ⚠️ `tsconfig.build.json` excludes `**/*spec.ts`, and that exclude stopped
# matching when the shared tree joined the program at a different path depth —
# six spec files compiled into the production build.
SPECS=$(find "$BACKEND/dist" -name '*.spec.js' 2>/dev/null | wc -l | tr -d ' ' || true)

if [ "${SPECS:-0}" -eq 0 ]; then
  pass "no test code in the artefact"
else
  fail "$SPECS spec file(s) compiled into the production build:"
  find "$BACKEND/dist" -name '*.spec.js' 2>/dev/null | sed "s|$BACKEND/|      |" | head -4
fi

# 3. The artefact's module graph resolves.
#
# 🔴 **A present file is not a working one.** `main.js` existing says nothing
# about whether its requires resolve — the broken build produced a file too.
#
# ⚠️ **Resolved, never EXECUTED.** The first version of this check `require`d the
# entry point, which bootstraps Nest and listens — so the gate hung until it was
# killed, after printing four passes. A check that never returns is worse than
# none: it blocks the commit and says nothing. `require.resolve` walks the same
# module graph and runs no code.
RESOLVE=$( cd "$BACKEND" && node -e "
  const path = require('path');
  const fs = require('fs');
  const entry = path.resolve('$ENTRY');

  // Follow the entry's own requires one level: a missing dependency of main.js
  // is what a wrong emit root produces, and it is invisible to a file check.
  const source = fs.readFileSync(entry, 'utf8');
  const specs = [...source.matchAll(/require\\(\"([^\"]+)\"\\)/g)].map((m) => m[1]);

  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    try {
      require.resolve(path.resolve(path.dirname(entry), spec));
    } catch {
      process.stdout.write('cannot resolve ' + spec + ' from ' + path.basename(entry));
      break;
    }
  }
" 2>&1 | head -1 || true )

if [ -z "$RESOLVE" ]; then
  pass "the artefact's local requires all resolve"
else
  fail "the artefact cannot load its own modules"
  printf '        %s\n' "$RESOLVE"
fi

# The DASHBOARD builds too.
#
# 🔴 **Added after a defect that typecheck, lint and 2161 tests all missed.**
# The shared geometry lives outside the Next.js project root, and Turbopack
# reads neither `tsconfig.json` nor `vitest.config.ts` — so `@shared/*` resolved
# everywhere except in a real build. It stayed latent for several commits
# because nothing in the PAGE TREE had imported a design-lab module; the moment
# M26d.4 wired the Design Lab into the option-set editor, `next build` failed
# with three unresolved imports while every other check stayed green.
#
# ⚠️ **A build is the only check that sees a bundler's resolver.** This gate
# already builds the backend for the same class of reason; the dashboard was
# simply never added.
FRONTEND="$ROOT/optioniaWooCommerceFrontend"

if [ ! -d "$FRONTEND/node_modules" ]; then
  printf '\033[33mskip\033[0m  the dashboard builds: dependencies not installed\n'
elif ( cd "$FRONTEND" && npm run build >/tmp/check-build-frontend.log 2>&1 ); then
  pass "the dashboard builds"
else
  fail "the dashboard does not build"
  grep -E "Error|Can't resolve" /tmp/check-build-frontend.log | head -5 | sed 's/^/        /' || true
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m%d build-output check(s) failed.\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\033[32mAll build-output checks passed.\033[0m\n'
