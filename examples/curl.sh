#!/usr/bin/env bash
# REST usage examples. Run `pnpm seed` first (or set API_KEY to your own).
set -euo pipefail
BASE="${BASE_URL:-http://localhost:8080}"
KEY="${API_KEY:-tk_demo_00000000000000000000000000000000}"

echo "# health"
curl -s "$BASE/v1/health"; echo

echo "# single check (burst_api: token bucket, capacity 10 @ 5/s)"
curl -s -i -XPOST "$BASE/v1/check" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"rule":"burst_api","identifier":"user-1"}' | grep -iE 'HTTP/|x-ratelimit|retry-after'
echo

echo "# hammer until 429 (free_tier would take 100; burst_api takes ~11)"
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/v1/check" \
    -H "x-api-key: $KEY" -H "content-type: application/json" \
    -d '{"rule":"burst_api","identifier":"spammer"}')
  echo "request $i -> $code"
done

echo "# batch (partial results: one good, one unknown rule)"
curl -s -XPOST "$BASE/v1/check/batch" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"checks":[{"rule":"burst_api","identifier":"a"},{"rule":"ghost","identifier":"a"}]}'; echo

echo "# prometheus metrics"
curl -s "$BASE/metrics" | head -n 12
