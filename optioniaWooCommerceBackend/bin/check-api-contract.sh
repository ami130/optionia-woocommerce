#!/usr/bin/env bash
#
# Assert docs/API-CONTRACT.md still describes the routes the app registers.
#
# The contract is consumed by a plugin that ships to merchant sites and cannot be
# redeployed, so a documented endpoint that does not exist — or an endpoint nobody
# documented — is more expensive here than anywhere else in the system.
#
# Boots the application to read its router, so it needs the same environment the
# app needs. Runs in CI after migrations.

set -euo pipefail

cd "$(dirname "$0")/.."

# 🔴 **`-r tsconfig-paths/register`, because this BOOTS the app.** I assumed
# it only parsed source and left it out; it imports the module tree, so a
# production file importing `@shared/*` broke it on
# `Cannot find module '@shared/design/design-scene'`. Boots the app → needs
# the resolver; reads files → does not. `check-docs` and `check-reachable`
# genuinely only read.
npx ts-node -r tsconfig-paths/register --transpile-only bin/check-api-contract.ts
