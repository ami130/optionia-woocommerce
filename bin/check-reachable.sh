#!/usr/bin/env bash
#
# Module reachability. See bin/check-reachable.ts for what this asserts and why.
#
# Usage: bash bin/check-reachable.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

printf 'Checking module reachability…\n'

npx ts-node --transpile-only bin/check-reachable.ts
