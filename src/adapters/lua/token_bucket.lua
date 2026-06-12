--[[
  TOKEN BUCKET — single atomic check.

  Why one Lua script and not MULTI/EXEC or app-side check-then-set
  ------------------------------------------------------------------
  The decision is read -> compute -> conditional write:
    1. read {tokens, lastRefillMs}
    2. lazily refill based on elapsed time
    3. IF tokens >= cost THEN deduct & allow ELSE deny
  Step 3 branches on a value read in step 1. Two transports cannot do this
  safely outside a script:

    app-side race (capacity 1, two concurrent requests A and B):
      A: HMGET -> tokens=1        B: HMGET -> tokens=1     (both read full bucket)
      A: 1>=1 -> allow, tokens=0  B: 1>=1 -> allow, tokens=0
      => 2 requests admitted against a capacity of 1.

  MULTI/EXEC does NOT fix this: it only batches commands and runs them with no
  intermediate reads, so it cannot make the allow/deny choice that depends on
  the HMGET reply. WATCH + retry can, but every concurrent hit on a hot key
  CAS-fails and retries — a thundering herd precisely where a limiter is
  hottest. A Lua script executes server-side as ONE indivisible step: B sees
  tokens=0 and is denied. No interleaving exists.

  Clock
  -----
  Refill time comes from the Redis server (redis.call('TIME')), never the
  caller. A client clock that is fast or forged could otherwise claim a large
  elapsed interval and mint free tokens. ARGV[4] (nowOverrideMs) is a TEST-ONLY
  hook for deterministic simulated time; production always passes 0.

  Cluster
  -------
  KEYS[1] carries a hash tag — throttle:{tenantId:ruleId:identifier}:tb — so all
  state for one logical limit maps to a single Cluster slot (a Lua script may
  only touch keys in one slot).

  KEYS[1]                         bucket hash
  ARGV[1] capacity                bucket size / burst         (> 0)
  ARGV[2] refillPerSec            tokens added per second     (> 0)
  ARGV[3] cost                    tokens this request spends  (>= 1)
  ARGV[4] nowOverrideMs           0 => use server TIME; >0 => test override
  returns { allowed(0|1), remaining, retryAfterMs, resetMs }
]]

local key          = KEYS[1]
local capacity     = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local cost         = tonumber(ARGV[3])
local nowOverride  = tonumber(ARGV[4])

local now
if nowOverride > 0 then
  now = nowOverride
else
  local t = redis.call('TIME')          -- { unixSeconds, microseconds }
  now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
end

local state  = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(state[1])
local last   = tonumber(state[2])

if tokens == nil then
  tokens = capacity          -- a never-seen bucket starts full
  last = now
end

-- Lazy refill, capped at capacity. Guard a backwards clock (elapsed < 0).
local elapsedMs = now - last
if elapsedMs < 0 then elapsedMs = 0 end
tokens = math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSec)

local allowed = 0
local retryAfterMs = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  -- ms until enough tokens accrue to cover the shortfall.
  local deficit = cost - tokens
  retryAfterMs = math.ceil((deficit / refillPerSec) * 1000)
end

-- resetMs: when the bucket would be full again (drives X-RateLimit-Reset).
local missing = capacity - tokens
local resetMs = now + math.ceil((missing / refillPerSec) * 1000)

-- Persist. Store tokens as a string to keep the fractional part (a Lua-number
-- HSET value would be truncated by Redis).
redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(now))

-- TTL: an idle bucket is indistinguishable from "never seen" once fully
-- refilled, so expire it then. Bounds memory — no key lives forever.
local ttlMs = math.ceil((capacity / refillPerSec) * 1000)
if ttlMs < 1 then ttlMs = 1 end
redis.call('PEXPIRE', key, ttlMs)

return { allowed, math.floor(tokens), retryAfterMs, resetMs }
