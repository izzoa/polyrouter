import { createHmac } from 'node:crypto';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { StructuralBaseline } from '@polyrouter/data-plane';
import { Redis } from 'ioredis';

/**
 * Per-agent structural baseline (#13, spec §7.2). Realizes "learn a per-agent
 * baseline; subtract anything constant across that agent's traffic" as an EWMA
 * of effective input size per (tenant, agent, system-fingerprint), WITHOUT any
 * network I/O on the hot path (invariants 1, 9):
 *
 * - `read`/`observe` are synchronous over a bounded in-process LRU — never await.
 * - Redis is a bounded, best-effort SHARED backing (invariant 10): a dedicated
 *   connection with `enableOfflineQueue:false` (a down Redis rejects at once, no
 *   buffered commands), plus a coalesced/throttled background worker whose total
 *   transient state is capped at `MAX_BACKGROUND_ENTRIES` (admission is rejected
 *   before per-key state is allocated) so a unique-fingerprint flood cannot grow
 *   process memory.
 * - Baselines live in a per-(tenant, agent) Redis HASH; the atomic Lua caps the
 *   field count per agent and refreshes a sliding TTL, so key cardinality is
 *   hard-bounded. The hash FIELD is a server-keyed HMAC of the framed system
 *   prompt — not dictionary-correlatable, and never recorded/logged (invariant 8).
 */

const FP_CONTEXT = 'polyrouter.structural.fingerprint.v1';
const MAX_BASELINE_ENTRIES = 10_000;
const MAX_BACKGROUND_ENTRIES = 4_096;
const MAX_FINGERPRINTS_PER_AGENT = 32;
const BASELINE_TTL_SECONDS = 2_592_000; // 30 days
const OBSERVE_FLUSH_MS = 5_000;

/** Atomic EWMA of a hash field, capped field count, sliding TTL.
 * KEYS[1]=hash; ARGV: [1]=field [2]=x [3]=alpha [4]=maxFields [5]=ttl. */
const EWMA_LUA = `
local exists = redis.call('HEXISTS', KEYS[1], ARGV[1])
if exists == 0 then
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then
    redis.call('EXPIRE', KEYS[1], ARGV[5])
    return 0
  end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
else
  local prev = tonumber(redis.call('HGET', KEYS[1], ARGV[1]))
  local a = tonumber(ARGV[3])
  redis.call('HSET', KEYS[1], ARGV[1], a * tonumber(ARGV[2]) + (1 - a) * prev)
end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
`;

interface Obs {
  readonly hashKey: string;
  readonly field: string;
  readonly x: number;
  readonly alpha: number;
}

@Injectable()
export class StructuralBaselineStore implements OnApplicationShutdown {
  private readonly cache = new Map<string, number>(); // ck -> ewma (Map order = LRU)
  private readonly fpKey: Buffer;
  private readonly redis: Redis;

  private readonly pendingSeed = new Set<string>(); // ck (queued + running seeds)
  private readonly pendingFlush = new Map<string, Obs>(); // ck -> latest coalesced obs
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  private activeFlush = 0;
  private shuttingDown = false;

  constructor(shared: Redis, apiKeyHmacSecret: string) {
    this.fpKey = createHmac('sha256', apiKeyHmacSecret).update(FP_CONTEXT).digest();
    this.redis = shared.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => {}); // degradation is by design — never surface
    if (this.redis.status === 'wait') void this.redis.connect().catch(() => {});
  }

  /** Synchronous local read (never awaits). Cold miss → `null` + a coalesced
   * cold-seed so a later request for this key can subtract a shared baseline. */
  read(
    tenantId: string,
    agentId: string | null,
    canonicalSystem: string,
  ): StructuralBaseline | null {
    const hashKey = this.hashKey(tenantId, agentId);
    const field = this.field(canonicalSystem);
    const ck = `${hashKey}|${field}`;
    const hit = this.cache.get(ck);
    if (hit !== undefined) {
      this.cache.delete(ck);
      this.cache.set(ck, hit); // LRU touch
      return { ewma: hit };
    }
    this.scheduleSeed(hashKey, field, ck);
    return null;
  }

  /** Update the local EWMA synchronously; enqueue a throttled, coalesced Redis
   * sync. Never throws. */
  observe(
    tenantId: string,
    agentId: string | null,
    canonicalSystem: string,
    x: number,
    alpha: number,
  ): void {
    if (!Number.isFinite(x) || x < 0) return;
    const hashKey = this.hashKey(tenantId, agentId);
    const field = this.field(canonicalSystem);
    const ck = `${hashKey}|${field}`;
    const cur = this.cache.get(ck);
    this.setCache(ck, cur === undefined ? x : alpha * x + (1 - alpha) * cur);
    this.scheduleFlush(ck, { hashKey, field, x, alpha });
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    this.pendingFlush.clear();
    this.pendingSeed.clear();
    try {
      this.redis.disconnect();
    } catch {
      /* already closed */
    }
  }

  /** Force all throttled flushes to run now (skips their timers). For operational
   * pre-shutdown sync and deterministic tests; never throws. */
  async flushPending(): Promise<void> {
    for (const ck of [...this.pendingFlush.keys()]) {
      const t = this.flushTimers.get(ck);
      if (t !== undefined) {
        clearTimeout(t);
        this.flushTimers.delete(ck);
      }
      await this.runFlush(ck);
    }
  }

  /** Current total transient background state — for bounded-work assertions. */
  get backgroundEntries(): number {
    return this.backgroundSize();
  }

  /** Resolve once the dedicated connection is usable (or the timeout lapses).
   * The hot path never calls this — it's for operational readiness checks and
   * deterministic tests; background ops before readiness simply drop. */
  async waitReady(timeoutMs = 2_000): Promise<boolean> {
    if (this.redis.status === 'ready') return true;
    return new Promise<boolean>((resolve) => {
      const done = (v: boolean): void => {
        clearTimeout(t);
        this.redis.removeListener('ready', onReady);
        resolve(v);
      };
      const onReady = (): void => done(true);
      const t = setTimeout(() => done(false), timeoutMs);
      if (typeof t.unref === 'function') t.unref();
      this.redis.once('ready', onReady);
    });
  }

  // --- internals ---

  private hashKey(tenantId: string, agentId: string | null): string {
    return `route:sbaseline:${tenantId}:${agentId ?? '-'}`;
  }

  private field(canonicalSystem: string): string {
    // 128-bit keyed digest — not correlatable without the server secret.
    return createHmac('sha256', this.fpKey).update(canonicalSystem).digest('hex').slice(0, 32);
  }

  private backgroundSize(): number {
    return this.pendingSeed.size + this.pendingFlush.size + this.activeFlush;
  }

  private setCache(ck: string, ewma: number): void {
    this.cache.delete(ck);
    this.cache.set(ck, ewma);
    if (this.cache.size > MAX_BASELINE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private scheduleSeed(hashKey: string, field: string, ck: string): void {
    if (this.shuttingDown || this.pendingSeed.has(ck)) return;
    if (this.backgroundSize() >= MAX_BACKGROUND_ENTRIES) return; // admit before allocating
    this.pendingSeed.add(ck);
    void this.runSeed(hashKey, field, ck);
  }

  private async runSeed(hashKey: string, field: string, ck: string): Promise<void> {
    try {
      const raw = await this.redis.hget(hashKey, field);
      if (raw !== null) {
        const ewma = Number(raw);
        if (Number.isFinite(ewma) && !this.cache.has(ck)) this.setCache(ck, ewma);
      }
    } catch {
      /* swallow — best-effort */
    } finally {
      this.pendingSeed.delete(ck);
    }
  }

  private scheduleFlush(ck: string, obs: Obs): void {
    if (this.shuttingDown) return;
    if (this.pendingFlush.has(ck)) {
      this.pendingFlush.set(ck, obs); // coalesce → keep the latest observation
      return;
    }
    if (this.backgroundSize() >= MAX_BACKGROUND_ENTRIES) return; // admit before allocating
    this.pendingFlush.set(ck, obs);
    const timer = setTimeout(() => void this.runFlush(ck), OBSERVE_FLUSH_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.flushTimers.set(ck, timer);
  }

  private async runFlush(ck: string): Promise<void> {
    this.flushTimers.delete(ck);
    const obs = this.pendingFlush.get(ck);
    this.pendingFlush.delete(ck);
    if (obs === undefined || this.shuttingDown) return;
    this.activeFlush++;
    try {
      await this.redis.eval(
        EWMA_LUA,
        1,
        obs.hashKey,
        obs.field,
        String(obs.x),
        String(obs.alpha),
        String(MAX_FINGERPRINTS_PER_AGENT),
        String(BASELINE_TTL_SECONDS),
      );
    } catch {
      /* swallow — best-effort */
    } finally {
      this.activeFlush--;
    }
  }
}
