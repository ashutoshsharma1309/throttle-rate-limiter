#!/usr/bin/env bash
# gRPC usage examples via grpcurl. Run `pnpm seed` first.
# Server reflection is not enabled, so we point grpcurl at the proto file.
#   brew install grpcurl   (if needed)
set -euo pipefail
cd "$(dirname "$0")/.."
ADDR="${GRPC_HOST:-localhost:50051}"
KEY="${API_KEY:-tk_demo_00000000000000000000000000000000}"
PROTO=(-import-path ./proto -proto throttle.proto)

echo "# Check"
grpcurl -plaintext "${PROTO[@]}" \
  -H "x-api-key: $KEY" \
  -d '{"rule":"burst_api","identifier":"user-1"}' \
  "$ADDR" throttle.v1.RateLimiter/Check

echo "# CheckBatch (partial results)"
grpcurl -plaintext "${PROTO[@]}" \
  -H "x-api-key: $KEY" \
  -d '{"checks":[{"rule":"burst_api","identifier":"a"},{"rule":"ghost","identifier":"a"}]}' \
  "$ADDR" throttle.v1.RateLimiter/CheckBatch

echo "# Health"
grpcurl -plaintext "${PROTO[@]}" -d '{}' "$ADDR" throttle.v1.RateLimiter/Health
