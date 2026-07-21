/**
 * The learning store's three atomic Lua scripts (add-semantic-learning task 4.1).
 * Kept beside the store so the JS reference implementation
 * (`testing/in-memory-learning-store.ts`) and these scripts can be read as one
 * pair — the reference is the readable semantics, these are the authoritative
 * Redis mirror, and a real-Redis parity spec pins them together (the breaker's
 * `applyX` / `X_LUA` precedent).
 *
 * All keys a script touches share one `{tenantHmac}` hash-tag → one Cluster slot,
 * so a multi-key script is slot-safe. Values follow `./learning-format`:
 * pending buckets are `"<count>" ‖ 0x0A ‖ <raw LE f32 bytes>`; work/stage/active
 * are hashes whose vector fields hold raw LE f32 bytes (Lua strings are byte-safe,
 * so binary round-trips through HGET→HSET intact).
 */

/**
 * ROTATE — fold this occurrence's eligible in-window pending buckets into its
 * WORK hash and return their sums. RESUME-EXISTING: an already-present work key
 * is returned unchanged (a retry must never fold fresh contributions in). A label
 * is eligible only when its summed count ≥ minSamples; a below-floor label is
 * neither summed into work NOR deleted — its buckets persist toward the floor.
 *
 * KEYS[1]=work; KEYS[2..1+nHigh]=high pending buckets; KEYS[2+nHigh..]=low buckets.
 * ARGV[1]=nHigh ARGV[2]=minSamples ARGV[3]=workTtl.
 * Leaves the eligible sums + counts in the work hash (`hc`/`hs`/`lc`/`ls`) — the
 * caller reads them back with the typed `hgetallBuffer` (ioredis omits a typed
 * `evalBuffer`, so returning raw bytes from the script is avoided). Returns 1.
 */
export const ROTATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 1
end
local nHigh = tonumber(ARGV[1])
local minSamples = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local nKeys = #KEYS
local function fold(from, to)
  local count = 0
  local dims = 0
  local acc = nil
  local consumed = {}
  for i = from, to do
    local v = redis.call('GET', KEYS[i])
    if v then
      local nl = string.find(v, '\\n', 1, true)
      if nl then
        local c = tonumber(string.sub(v, 1, nl - 1))
        local body = string.sub(v, nl + 1)
        local d = math.floor(#body / 4)
        if c and d > 0 then
          if acc == nil then
            dims = d
            acc = {}
            for j = 1, dims do acc[j] = 0 end
          end
          if d == dims then
            for j = 0, dims - 1 do
              local off = j * 4 + 1
              acc[j + 1] = acc[j + 1] + struct.unpack('<f', string.sub(body, off, off + 3))
            end
            count = count + c
            consumed[#consumed + 1] = KEYS[i]
          end
        end
      end
    end
  end
  return count, dims, acc, consumed
end
local function packAcc(acc, dims)
  local out = {}
  for j = 1, dims do out[j] = struct.pack('<f', acc[j]) end
  return table.concat(out)
end
local hCount, hDims, hAcc, hCons = fold(2, 1 + nHigh)
local lCount, lDims, lAcc, lCons = fold(2 + nHigh, nKeys)
local hEligible = hAcc ~= nil and hCount >= minSamples
local lEligible = lAcc ~= nil and lCount >= minSamples
local created = false
if hEligible then
  redis.call('HSET', KEYS[1], 'hc', hCount, 'hs', packAcc(hAcc, hDims))
  for _, k in ipairs(hCons) do redis.call('DEL', k) end
  created = true
end
if lEligible then
  redis.call('HSET', KEYS[1], 'lc', lCount, 'ls', packAcc(lAcc, lDims))
  for _, k in ipairs(lCons) do redis.call('DEL', k) end
  created = true
end
if created then redis.call('EXPIRE', KEYS[1], ttl) end
return 1
`;

/**
 * STAGE — write an unreadable generation candidate under the occurrence. DELs any
 * partial stage from a crashed retry first, so the stage is always whole.
 * KEYS[1]=stage. ARGV[1]=epoch ARGV[2]=generation ARGV[3]=revision
 * ARGV[4]=highBytes ARGV[5]=lowBytes ARGV[6]=ttl.
 */
export const STAGE_LUA = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'e', ARGV[1], 'g', ARGV[2], 'r', ARGV[3], 'h', ARGV[4], 'l', ARGV[5])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
return 1
`;

/**
 * PROMOTE — copy the occurrence's stage to the single ACTIVE hash when the stage's
 * (epoch, generation) equals the just-committed (expected) coordinates AND the
 * current active is OLDER or absent, then delete the stage and work keys.
 *
 * MONOTONIC (clink 4.1 High-1): active never moves backward. A later occurrence
 * that already promoted a newer generation must not be downgraded by an older
 * occurrence's delayed/retried promote — the older stage is discarded instead.
 * "Older" orders by epoch first (a bumped revocation epoch supersedes any
 * generation), then generation.
 *
 * IDEMPOTENT: if the active is already exactly at (expected), a retry cleans up
 * the stage/work and reports success — so a crash between the Postgres commit and
 * this promote self-heals. KEYS[1]=stage KEYS[2]=active KEYS[3]=work.
 * ARGV[1]=epoch ARGV[2]=generation ARGV[3]=activeTtl. Returns 1 (promoted or
 * already-promoted) or 0 (nothing to promote / superseded).
 */
export const PROMOTE_LUA = `
local E = ARGV[1]
local G = ARGV[2]
local ae = redis.call('HGET', KEYS[2], 'e')
local ag = redis.call('HGET', KEYS[2], 'g')
if ae and ag and ae == E and ag == G then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[3])
  return 1
end
local se = redis.call('HGET', KEYS[1], 'e')
local sg = redis.call('HGET', KEYS[1], 'g')
if se and sg and se == E and sg == G then
  local older = not ae
  if not older then
    local aen = tonumber(ae)
    local agn = tonumber(ag)
    local en = tonumber(E)
    local gn = tonumber(G)
    older = aen < en or (aen == en and agn < gn)
  end
  if older then
    local sr = redis.call('HGET', KEYS[1], 'r')
    local sh = redis.call('HGET', KEYS[1], 'h')
    local sl = redis.call('HGET', KEYS[1], 'l')
    redis.call('DEL', KEYS[2])
    redis.call('HSET', KEYS[2], 'e', se, 'g', sg, 'r', sr, 'h', sh, 'l', sl)
    redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
    redis.call('DEL', KEYS[1])
    redis.call('DEL', KEYS[3])
    return 1
  end
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[3])
  return 0
end
return 0
`;
