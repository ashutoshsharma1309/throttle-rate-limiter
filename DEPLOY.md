# Deploying Throttle

Recommended **no-credit-card** path: **Render** (free Docker web service) +
**Upstash** (free serverless Redis). REST goes live on a public HTTPS URL; the
gRPC port stays internal because Render routes one port per service (gRPC is
still proven by the parity tests and runnable locally). Fly.io is a fuller
alternative but requires a card — see the bottom.

Blueprint: [`render.yaml`](render.yaml). The app honors Render's injected
`$PORT` automatically.

---

## 1. Create the Redis (Upstash — free, no card)
1. Sign up at <https://upstash.com> with GitHub (no card).
2. **Create Database** → Redis → pick a region near your Render region (e.g. US-East).
3. Copy the **`rediss://…`** connection string (the TLS one, with the password).

## 2. Deploy on Render (free, no card)
1. Push this repo to GitHub (if you haven't: `gh repo create` or via the website).
2. At <https://render.com> → **New** → **Blueprint** → connect the repo. Render
   reads `render.yaml` and proposes the `throttle` web service.
3. When prompted for the `sync:false` env vars, set:
   - `REDIS_URL` = the Upstash `rediss://…` string
   - `ADMIN_API_KEY` = a strong value (e.g. run `openssl rand -hex 24` locally)
4. **Apply** → Render builds the Dockerfile and deploys. First build ~3–5 min.

Your base URL is `https://throttle-XXXX.onrender.com` (Render shows it).

> Free instances sleep after ~15 min idle (≈30–50s cold start on the next hit).
> Fine for a demo; the first request after idle is slow, then it's warm.

## 3. Seed a demo tenant (over the public admin API)
```bash
APP=https://throttle-XXXX.onrender.com
ADMIN=<your ADMIN_API_KEY>

# create a tenant -> note tenantId + apiKey from the response
curl -s -XPOST "$APP/v1/admin/tenants" -H "x-api-key: $ADMIN"

KEY=<apiKey>; TID=<tenantId>

# a token-bucket rule: burst 10, sustained 5/s
curl -s -XPUT "$APP/v1/admin/tenants/$TID/rules/burst_api" \
  -H "x-api-key: $ADMIN" -H "content-type: application/json" \
  -d '{"algorithm":"token_bucket","capacity":10,"refillRate":5}'
```

## 4. Demo it
```bash
curl -s "$APP/v1/health"           # {"status":"ok","redis":"up",...}

# hammer until 429 (capacity 10)
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" -XPOST "$APP/v1/check" \
    -H "x-api-key: $KEY" -H "content-type: application/json" \
    -d '{"rule":"burst_api","identifier":"demo"}'
done

curl -s "$APP/metrics" | head      # Prometheus metrics
```

Auto-deploy is on (`autoDeploy: true`): every push to `main` redeploys.

---

## Want gRPC live too? (still no card)
Render free exposes one port, so run **both** transports locally and expose them
through a free **Cloudflare Tunnel**:
```bash
docker compose up --build          # REST :8080 + gRPC :50051 locally
brew install cloudflared
cloudflared tunnel --url http://localhost:8080      # public HTTPS for REST
```
For gRPC over a named tunnel, add an ingress route to `:50051` (HTTP/2). This is
ideal for an interview screen-share; it's only up while your machine runs.

---

## Alternative: Fly.io (needs a credit card)
[`fly.toml`](fly.toml) + [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
deploy **both** REST and gRPC publicly (gRPC via a TLS-terminated TCP service).
Fly requires a card on file even for the free allowance, so it's a no-go without
one — kept here for completeness.

```bash
fly auth login && fly apps create <name>
fly redis create
fly secrets set REDIS_URL="rediss://…" ADMIN_API_KEY="$(openssl rand -hex 24)"
fly deploy --remote-only
```

---

### Production notes (beyond a demo)
- **`FAIL_OPEN`**: `true` here (availability). Set `false` for auth/OTP/billing.
- **`/metrics`** is unauthenticated — keep it off the public internet for real traffic.
- **Scaling**: the app is stateless (per-instance 30s rule cache) and scales horizontally with no coordination.
