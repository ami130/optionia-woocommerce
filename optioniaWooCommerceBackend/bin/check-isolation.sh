#!/usr/bin/env bash
#
# Assert every tenant-scoped route has a negative test (M6.6, extended by 7n).
#
# Twelve suites contain a cross-tenant assertion; none could answer whether the
# set was complete. This compares the isolation matrix against the router, so a
# route added without a probe fails rather than joining a green suite.
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
npx ts-node -r tsconfig-paths/register --transpile-only bin/check-isolation.ts
