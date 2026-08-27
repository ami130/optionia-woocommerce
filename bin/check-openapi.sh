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

npx ts-node --transpile-only bin/check-openapi.ts
