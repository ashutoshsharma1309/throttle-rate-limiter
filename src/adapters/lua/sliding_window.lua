--[[
  SLIDING WINDOW LOG — single atomic check, exact.

  Why one Lua script (not MULTI/EXEC or app-side check-then-set)
  -------------------------------------------------------------
  The decision is evict -> count -> conditional append:
    1. ZREMRANGEBYSCORE   drop timestamps older than the window
    2. ZCARD              how many remain
    3. IF count + cost <= limit THEN ZADD (admit) ELSE deny
  Step 3 branches on the ZCARD reply. Outside a script this races:

    limit 10, current count 9, two concurrent requests A and B:
      A: ZCARD -> 9          B: ZCARD -> 9      (both read before either writes)
      A: 9+1<=10 -> ZADD     B: 9+1<=10 -> ZADD
      => 11 entries admitted against a limit of 10.

  MULTI/EXEC cannot help: it batches commands and cannot branch on ZCARD's
  reply. WATCH + retry can, but degenerates into a retry storm on a hot key.
  The Lua script runs evict->count->add atomically: B observes count 10 and is
  denied. The 100-parallel atomicity test proves this property holds.

  Clock: server TIME, never the caller (ARGV[4]=0 in prod; >0 is a test hook).
  Cluster: KEYS[1] is hash-tagged so the whole window lives in one slot.

  KEYS[1]                         the sorted set of admitted timestamps
  ARGV[1] limit                   max admitted per window
  ARGV[2] windowMs                window length (ms)
  ARGV[3] cost                    entries this request adds (>= 1)
  ARGV[4] nowOverrideMs           0 => server TIME; >0 => test override
  ARGV[5] seq                     caller-unique suffix (collision-proof members)
  returns { allowed(0|1), remaining, retryAfterMs, resetMs }
]]

local key      = KEYS[1]
local limit    = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local nowOver  = tonumber(ARGV[4])
local seq      = ARGV[5]

local now
if nowOver > 0 then
  now = nowOver
else
  local t = redis.call('TIME')
  now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
end

-- Evict everything at or before the window's left edge: window is (now-windowMs, now].
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)

local count = redis.call('ZCARD', key)

local allowed = 0
if count + cost <= limit then
  -- One member per token, each unique even within the same millisecond
  -- (score = now; member = "<now>-<seq>-<i>"). ZSET members must be distinct.
  for i = 1, cost do
    redis.call('ZADD', key, now, now .. '-' .. seq .. '-' .. i)
  end
  allowed = 1
  count = count + cost
end

local remaining = limit - count
if remaining < 0 then remaining = 0 end

-- Oldest surviving entry sets both the natural reset point and, on a deny,
-- when the next slot frees up.
local resetMs
local retryAfterMs = 0
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[1] ~= nil then
  local oldestScore = tonumber(oldest[2])
  resetMs = oldestScore + windowMs
  if allowed == 0 then
    retryAfterMs = oldestScore + windowMs - now
    if retryAfterMs < 1 then retryAfterMs = 1 end
  end
else
  -- Empty set (limit 0, or cost>limit on a fresh key): nothing frees up within a window.
  resetMs = now + windowMs
  if allowed == 0 then retryAfterMs = windowMs end
end

-- TTL: once a full window passes with no new entries, every member would have
-- expired anyway — so expire the key. Bounds memory.
redis.call('PEXPIRE', key, windowMs)

return { allowed, remaining, retryAfterMs, resetMs }
