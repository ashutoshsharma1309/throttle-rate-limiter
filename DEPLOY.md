# Deploying Throttle to Fly.io

A live REST + gRPC endpoint backed by managed Redis, in ~10 minutes. Config
lives in [`fly.toml`](fly.toml); CI auto-deploys via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## Prerequisites
```bash
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login
```

## 1. Create the app
From the repo root (a `fly.toml` already exists, so this just registers the app):
```bash
fly apps create throttle-rate-limiter      # pick your own unique name
# then set `app = "<that name>"` in fly.toml
```

## 2. Provision Redis (Upstash, same region as the app)
```bash
fly redis create                 # choose region iad to match primary_region
# Copy the rediss://… connection string it prints, then:
fly secrets set REDIS_URL="rediss://default:<password>@<host>:6379"
```
> Keep Redis in the **same region** as the app — cross-region latency can exceed
> the command timeout and trip fail-open. `fly.toml` already sets a generous
> `REDIS_COMMAND_TIMEOUT_MS=200` to be safe.

## 3. Set the admin secret
```bash
fly secrets set ADMIN_API_KEY="$(openssl rand -hex 24)"
# print it once so you can use it below:
fly secrets list   # (values are hidden; keep the openssl output from above)
```

## 4. Deploy
```bash
fly deploy --remote-only
fly open /v1/health      # -> {"status":"ok","redis":"up",...}
```
Your base URL is `https://<app>.fly.dev`.

## 5. Seed a demo tenant (over the public admin API)
```bash
APP=https://<app>.fly.dev
ADMIN=<your ADMIN_API_KEY>

# create a tenant -> note the returned apiKey
curl -s -XPOST "$APP/v1/admin/tenants" -H "x-api-key: $ADMIN"

KEY=<apiKey from above>; TID=<tenantId from above>

# a token-bucket rule: burst 10, sustained 5/s
curl -s -XPUT "$APP/v1/admin/tenants/$TID/rules/burst_api" \
  -H "x-api-key: $ADMIN" -H "content-type: application/json" \
  -d '{"algorithm":"token_bucket","capacity":10,"refillRate":5}'
```

## 6. Demo it
```bash
# REST — hammer until 429
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" -XPOST "$APP/v1/check" \
    -H "x-api-key: $KEY" -H "content-type: application/json" \
    -d '{"rule":"burst_api","identifier":"demo"}'
done

# metrics
curl -s "$APP/metrics" | head

# gRPC — TLS at the Fly edge, so NO -plaintext, and use the proto in ./proto
grpcurl -import-path ./proto -proto throttle.proto \
  -H "x-api-key: $KEY" \
  -d '{"rule":"burst_api","identifier":"demo"}' \
  <app>.fly.dev:50051 throttle.v1.RateLimiter/Check
```

## 7. (Optional) CI auto-deploy
```bash
fly tokens create deploy -x 999999h        # a deploy token
# add it as the repo secret FLY_API_TOKEN (Settings → Secrets → Actions)
```
Every green push to `main` then runs `flyctl deploy`. Until the secret exists,
the deploy job no-ops (stays green).

---

### Notes for production (beyond a demo)
- **`FAIL_OPEN`**: `true` here (availability). Set `false` for auth/OTP/billing.
- **gRPC auth metadata** rides TLS to the Fly edge; inside, the app speaks h2c.
- **`/metrics`** is unauthenticated — fine on Fly's private demo URL; put it
  behind the private network or an auth proxy for real traffic.
- **Scaling**: `fly scale count 3` — the app is stateless (per-instance 30s rule
  cache), so it scales horizontally with no coordination.
