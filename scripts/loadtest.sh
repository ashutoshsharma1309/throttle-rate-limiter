#!/usr/bin/env bash
# Load test (autocannon, 3 scenarios) -> markdown table.
# Requires a running server (docker compose up) seeded with `pnpm seed`.
#
#   BASE_URL=http://localhost:8080 API_KEY=tk_demo_... ./scripts/loadtest.sh
#
# The actual autocannon driving + result aggregation lives in loadtest.ts so
# we can randomise identifiers per request and emit a clean table.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx scripts/loadtest.ts "$@"
