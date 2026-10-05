#!/usr/bin/env bash
#
# Assert the generated OpenAPI spec describes the same surface as the contract.
#
# The spec is a *description* generated from the controllers; the contract is the
# *design*. They will occasionally disagree, and that disagreement is the signal
# a controller drifted -- but only if something reads it.
#
# Boots the application, so it needs the same environment the app needs.

set -euo pipefail

cd "$(dirname "$0")/.."

# 🔴 **`-r tsconfig-paths/register`, because this boots the app** and a
# production module now imports `@shared/*` (`design/render-worker.service.ts`
# needs the serializer the storefront draws with). `ts-node` does not apply
# tsconfig `paths` on its own, so without this the whole check fails on
# `Cannot find module '@shared/design/design-scene'` — the same idiom
# `typeorm` and the seed scripts already use.
npx ts-node -r tsconfig-paths/register --transpile-only bin/check-openapi.ts
