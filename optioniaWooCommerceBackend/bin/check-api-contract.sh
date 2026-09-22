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

npx ts-node --transpile-only bin/check-api-contract.ts
