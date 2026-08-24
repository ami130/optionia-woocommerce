#!/usr/bin/env bash
#
# Assert docs/DATABASE.md still describes the schema that migrations produce.
#
# This document has now been wrong twice: it promised a cascading rule and a
# ~40-option fixture, and for a while neither existed. Both times a person found
# it by reading, which is the slowest and least reliable detector available.
#
# The check is deliberately narrow. It compares only claims that can be stated
# unambiguously and compared mechanically:
#
#   - the set of documented tables against the tables migrations create
#   - every `table.column ... ON DELETE <rule>` the document asserts
#
# Prose is not checked. A document can pass this and still explain a column
# badly; the point is that it cannot silently describe a schema that no longer
# exists.
#
# Requires a reachable database with migrations applied, so it runs in CI after
# migration:run rather than alongside lint.

set -euo pipefail

cd "$(dirname "$0")/.."

npx ts-node --transpile-only bin/check-docs.ts
