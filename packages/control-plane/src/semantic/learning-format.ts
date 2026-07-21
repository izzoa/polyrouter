import { createHmac } from 'node:crypto';

/**
 * The shared on-Redis format contract for semantic learning (add-semantic-learning
 * D6/D8). The EVIDENCE ACCUMULATOR (data-plane hot path, task 3.2) WRITES pending
 * buckets and the LEARNING STORE (control-plane sweep, task 4.1) READS them — they
 * MUST agree byte-for-byte on the key layout, the tenant digest, and the packed
 * vector encoding, or learning silently corrupts. This module is that single
 * source of truth; both sides import it so the two Lua scripts (accumulator's
 * add-sum, store's rotate) can never drift apart.
 *
 * KEY LAYOUT (all under one `{tenantHmac}` hash-tag → single Redis Cluster slot,
 * so the store's multi-key Lua is slot-safe):
 *   pending: `sem:{<hmac>}:pending:<label>:<revision>:<yyyymmdd>`  (fixed-window daily bucket)
 *   work:    `sem:{<hmac>}:work:<occurrenceId>`                    (one sweep occurrence's rotated sums)
 *   stage:   `sem:{<hmac>}:stage:<occurrenceId>`                   (unreadable G+1 candidate)
 *   active:  `sem:{<hmac>}:active`                                 (the one readable learned state)
 *
 * PENDING VALUE ENCODING (produced by {@link ADD_PENDING_LUA}, consumed by the
 * store's rotate): `"<count>" ‖ 0x0A ‖ <dims·4 raw little-endian float32 bytes>`.
 * The count is the number of contributing embeddings summed into the vector; the
 * body is the element-wise SUM (never a mean — the sweep divides by the count).
 */

/** Domain separator for the tenant digest (NOT the raw tenant id — clink r1
 * Low-1). Bumping this rotates every tenant's keyspace. */
const TENANT_HMAC_CONTEXT = 'polyrouter.semantic.learning.tenant.v1';

/**
 * Derive the per-server tenant-HMAC key from the API-key HMAC secret. A distinct
 * domain separator keeps this digest unrelated to the agent-key HMAC that shares
 * the same secret.
 */
export function deriveTenantHmacKey(apiKeyHmacSecret: string): Buffer {
  return createHmac('sha256', apiKeyHmacSecret).update(TENANT_HMAC_CONTEXT).digest();
}

/** Domain-separated 128-bit tenant digest (hex) — never the raw tenant id, never
 * logged/persisted. Keys built from it are not dictionary-correlatable without
 * the server secret. */
export function tenantHmac(tenantKey: Buffer, tenantId: string): string {
  return createHmac('sha256', tenantKey).update(tenantId).digest('hex').slice(0, 32);
}

/** The two learning labels; a settled cascade outcome maps to one (or neither). */
export type LearningLabel = 'high' | 'low';

/** `yyyymmdd` for the fixed-window daily bucket (UTC). */
export function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

const tag = (hmac: string): string => `sem:{${hmac}}`;

/** Pending buckets are namespaced by the REVOCATION EPOCH (clink impl High-3):
 * a revert bumps E→E+1, so evidence from pre-revert requests (decided under E)
 * that flush AFTER the revert land under the OLD epoch's key and are never
 * rotated by the E+1 sweep — the revert stays race-proof. */
export function pendingBucketKey(
  hmac: string,
  epoch: number,
  label: LearningLabel,
  revision: string,
  day: string,
): string {
  return `${tag(hmac)}:pending:${String(epoch)}:${label}:${revision}:${day}`;
}

/** The Redis occurrence token: `epoch:day` — epoch-scoped (so a mid-day revert's
 * new-epoch sweep can't resume the old epoch's work key) and containing NO raw
 * tenant id (D8; clink impl Med-5). The Postgres audit occurrence id embeds the
 * owner separately (its table is owner-scoped). */
export function redisOccurrence(epoch: number, day: string): string {
  return `${String(epoch)}:${day}`;
}

export function workKey(hmac: string, occurrenceId: string): string {
  return `${tag(hmac)}:work:${occurrenceId}`;
}

export function stageKey(hmac: string, occurrenceId: string): string {
  return `${tag(hmac)}:stage:${occurrenceId}`;
}

export function activeKey(hmac: string): string {
  return `${tag(hmac)}:active`;
}

/** Glob matching every key a tenant owns — for the revert fence's cleanup SCAN.
 * `{`/`}` are literal in a Redis glob (only `*?[]\` are special). */
export function tenantKeyGlob(hmac: string): string {
  return `${tag(hmac)}:*`;
}

/**
 * Pack a vector to `dims·4` raw LITTLE-ENDIAN float32 bytes — explicit LE (not a
 * raw `Buffer.from(v.buffer)` view) so the encoding is endianness-independent and
 * matches the Lua's `struct.pack('<f', …)`, and so a pooled/offset backing store
 * can never alias in.
 */
export function packVector(v: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i += 1) buf.writeFloatLE(v[i] ?? 0, i * 4);
  return buf;
}

/** Inverse of {@link packVector}: raw LE float32 bytes → `Float32Array`. Returns
 * null when the byte length is not a whole number of float32s. */
export function unpackVector(buf: Buffer): Float32Array | null {
  if (buf.length === 0 || buf.length % 4 !== 0) return null;
  const dims = buf.length / 4;
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * Add a packed cohort SUM + count into a fixed-window pending bucket, element-
 * wise, refreshing the bucket's TTL. The bucket value is
 * `"<count>" ‖ 0x0A ‖ <raw LE float32 bytes>`; a first write creates it, a
 * subsequent write sums into it. Cluster-safe: the one key is under the caller's
 * `{tenantHmac}` hash-tag.
 *
 * KEYS[1]=bucket; ARGV[1]=addCount ARGV[2]=packed-sum-bytes ARGV[3]=dims ARGV[4]=ttl.
 */
export const ADD_PENDING_LUA = `
local cur = redis.call('GET', KEYS[1])
local dims = tonumber(ARGV[3])
local addCount = tonumber(ARGV[1])
local add = ARGV[2]
if not cur then
  redis.call('SET', KEYS[1], addCount .. '\\n' .. add, 'EX', tonumber(ARGV[4]))
  return addCount
end
local nl = string.find(cur, '\\n', 1, true)
local count = tonumber(string.sub(cur, 1, nl - 1))
local body = string.sub(cur, nl + 1)
local out = {}
for i = 0, dims - 1 do
  local off = i * 4 + 1
  local a = struct.unpack('<f', string.sub(body, off, off + 3))
  local b = struct.unpack('<f', string.sub(add, off, off + 3))
  out[i + 1] = struct.pack('<f', a + b)
end
redis.call('SET', KEYS[1], (count + addCount) .. '\\n' .. table.concat(out), 'EX', tonumber(ARGV[4]))
return count + addCount
`;
