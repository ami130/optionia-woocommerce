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

npx ts-node --transpile-only bin/check-isolation.ts
