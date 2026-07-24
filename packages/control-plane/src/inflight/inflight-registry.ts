import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { REDIS_CLIENT, type InflightSnapshot, type Principal } from '@polyrouter/shared/server';
import type { Redis } from 'ioredis';

/**
 * The ephemeral in-flight registry (add-inflight-requests): owner-scoped, metadata-
 * only presence for the requests being served right now, so the dashboard can show
 * work the immutable `request_log` (written only at settle) cannot. Every write is
 * FIRE-AND-FORGET and never awaited on the request path (invariants 1, 9); a Redis
 * fault — down or hung — degrades to "no live view", never touching inference.
 */

/** Per-request metadata published to the registry. METADATA ONLY — never any
 * prompt/response body, token payload, or credential (invariant 8). `startedAt`
 * is epoch milliseconds. */
export interface InflightEntry {
  readonly requestId: string;
  readonly startedAt: number;
  readonly decisionLayer: string;
  readonly tierAssigned: string | null;
  readonly modelLabel: string | null;
  readonly providerLabel: string | null;
  readonly protocol: string;
}

/** Handle returned by `mark`: `settle()` stops renewals SYNCHRONOUSLY and best-
 * effort clears the entry. Idempotent — safe to call from any settle path. */
export interface InflightLease {
  settle(): void;
}

/**
 * Optional transition sink (phase2-add-dashboard-event-stream), so a connected
 * dashboard learns of a mark/settle without polling. Publication is stage (i) of the
 * three-stage model: bounded O(1) scheduling that NEVER awaits dispatch, on exactly
 * the same best-effort terms as the registry's Redis writes — a failure can never
 * fail, block, delay, or reorder the request, nor alter the durable row.
 *
 * Injected as an interface (not the concrete bus) so the registry keeps no dependency
 * on the events module and stays usable — and testable — without it.
 */
export interface InflightTransitions {
  started(principal: Principal, entry: InflightEntry): void;
  settled(principal: Principal, requestId: string): void;
}

export const INFLIGHT_TRANSITIONS = 'polyrouter:inflight-transitions';

export interface InflightConfig {
  /** Immutable horizon (`startedAt + admissionLifetimeMs`) bounding a stale FIRST
   * mark and the settled-marker retention. Never extended by renewals. */
  readonly admissionLifetimeMs: number;
  /** Base entry lease; an exists-only `renew` extends it while the request runs. */
  readonly leaseMs: number;
  /** Clock-skew allowance (app `startedAt` vs Redis `TIME`). */
  readonly skewMs: number;
  /** Max items returned by `list`. */
  readonly listCap: number;
  /** Idle-owner index-key survival (auto-reclaims quiet owners). */
  readonly indexTtlMs: number;
  /** Sweep interval — reclaims stale index members below the read slice. */
  readonly sweepIntervalMs: number;
  /** `list` read deadline so a hung Redis returns unavailable, never blocks. */
  readonly readTimeoutMs: number;
}

export const DEFAULT_INFLIGHT_CONFIG: InflightConfig = {
  admissionLifetimeMs: 30 * 60_000, // a FIRST mark this late is pathological
  leaseMs: 60_000, // renew (every leaseMs/2) keeps a long request visible
  skewMs: 5_000,
  listCap: 100,
  indexTtlMs: 60 * 60_000,
  sweepIntervalMs: 60_000,
  readTimeoutMs: 300,
};

// Keys are hash-tagged on the owner so entry / index / marker co-locate on one
// Redis-Cluster slot (required for the atomic multi-key Lua scripts).
const ownerTag = (p: Principal): string => (p.kind === 'user' ? `u:${p.userId}` : `o:${p.orgId}`);
const entryKey = (tag: string, id: string): string => `inflight:{${tag}}:${id}`;
const indexKey = (tag: string): string => `inflight-idx:{${tag}}`;
const markerKey = (tag: string, id: string): string => `inflight-done:{${tag}}:${id}`;
const tagOfIndexKey = (key: string): string | null => {
  const m = /^inflight-idx:\{(.+)\}$/.exec(key);
  return m ? m[1]! : null;
};

/** The three co-located keys for a request (testability seam — the Lua contract is
 * asserted against these, so a key-format change fails loudly). */
export function inflightKeysFor(
  principal: Principal,
  requestId: string,
): { entry: string; index: string; marker: string } {
  const tag = ownerTag(principal);
  return {
    entry: entryKey(tag, requestId),
    index: indexKey(tag),
    marker: markerKey(tag, requestId),
  };
}

// The conditional server-time + settled-marker logic cannot ride a bare
// MULTI/EXEC, so mark/renew/clear are Lua scripts (atomic, one round-trip).

// KEYS: 1=entry 2=index 3=marker
// ARGV: 1=id 2=admissionCutoff 3=json 4=leaseMs 5=startedAt 6=indexTtlMs
const MARK_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
local t = redis.call('TIME')
local nowMs = t[1] * 1000 + math.floor(t[2] / 1000)
if nowMs > tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], nowMs + tonumber(ARGV[4]))
redis.call('ZADD', KEYS[2], tonumber(ARGV[5]), ARGV[1])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[6]))
return 1
`;

// KEYS: 1=entry 2=marker ; ARGV: 1=leaseMs. Exists-only: never creates an entry.
const RENEW_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local t = redis.call('TIME')
local nowMs = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('PEXPIREAT', KEYS[1], nowMs + tonumber(ARGV[1]))
return 1
`;

// KEYS: 1=entry 2=index 3=marker ; ARGV: 1=id 2=admissionCutoff. The marker is
// retained only THROUGH the admission cutoff (a late mark past it is rejected by
// the TIME check anyway), so a long-since-cutoff request writes no marker.
const CLEAR_LUA = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
local t = redis.call('TIME')
local nowMs = t[1] * 1000 + math.floor(t[2] / 1000)
local ttl = tonumber(ARGV[2]) - nowMs
if ttl > 0 then redis.call('SET', KEYS[3], '1', 'PX', ttl) end
return 1
`;

interface RegistryCommands {
  inflightMark(
    entryKey: string,
    indexKey: string,
    markerKey: string,
    id: string,
    admissionCutoff: number,
    json: string,
    leaseMs: number,
    startedAt: number,
    indexTtlMs: number,
  ): Promise<number>;
  inflightRenew(entryKey: string, markerKey: string, leaseMs: number): Promise<number>;
  inflightClear(
    entryKey: string,
    indexKey: string,
    markerKey: string,
    id: string,
    admissionCutoff: number,
  ): Promise<number>;
}

@Injectable()
export class InflightRegistry implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(InflightRegistry.name);
  private readonly cfg = DEFAULT_INFLIGHT_CONFIG;
  private readonly cmds: RegistryCommands;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional()
    @Inject(INFLIGHT_TRANSITIONS)
    private readonly transitions: InflightTransitions | null = null,
  ) {
    // defineCommand is idempotent per name — safe on the shared client.
    this.redis.defineCommand('inflightMark', { numberOfKeys: 3, lua: MARK_LUA });
    this.redis.defineCommand('inflightRenew', { numberOfKeys: 2, lua: RENEW_LUA });
    this.redis.defineCommand('inflightClear', { numberOfKeys: 3, lua: CLEAR_LUA });
    this.cmds = this.redis as unknown as RegistryCommands;
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweepOnce(), this.cfg.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stage (i) of publication: bounded, synchronous, and it can NEVER escape — a
   * broken or absent sink must be indistinguishable from no sink at all from the
   * request's point of view (same terms as the registry's Redis writes). */
  private publishTransition(emit: () => void): void {
    if (this.transitions === null) return;
    try {
      emit();
    } catch (err) {
      this.logger.warn(`inflight transition publish failed: ${String((err as Error).message)}`);
    }
  }

  onApplicationShutdown(): void {
    // Registry cleanup is NOT part of the shutdown drain (invariant 12).
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Publish an entry (fire-and-forget) and start the exists-only lease. The
   * returned handle's `settle()` stops renewals synchronously and clears the
   * entry — never awaited on the request path. */
  mark(principal: Principal, entry: InflightEntry): InflightLease {
    const tag = ownerTag(principal);
    const eKey = entryKey(tag, entry.requestId);
    const iKey = indexKey(tag);
    const mKey = markerKey(tag, entry.requestId);
    const admissionCutoff = entry.startedAt + this.cfg.admissionLifetimeMs + this.cfg.skewMs;
    const json = JSON.stringify({
      requestId: entry.requestId,
      startedAt: entry.startedAt,
      decisionLayer: entry.decisionLayer,
      tierAssigned: entry.tierAssigned,
      modelLabel: entry.modelLabel,
      providerLabel: entry.providerLabel,
      protocol: entry.protocol,
    });
    this.fire(() =>
      this.cmds.inflightMark(
        eKey,
        iKey,
        mKey,
        entry.requestId,
        admissionCutoff,
        json,
        this.cfg.leaseMs,
        entry.startedAt,
        this.cfg.indexTtlMs,
      ),
    );
    // Stage (i): O(1), synchronous, never awaited, never throws out of here.
    this.publishTransition(() => this.transitions?.started(principal, entry));
    let closed = false;
    const timer = setInterval(
      () => {
        if (closed) return;
        this.fire(() => this.cmds.inflightRenew(eKey, mKey, this.cfg.leaseMs));
      },
      Math.max(1_000, Math.floor(this.cfg.leaseMs / 2)),
    );
    timer.unref?.();
    return {
      settle: (): void => {
        if (closed) return;
        closed = true; // synchronous close: no renewal fires after this returns
        clearInterval(timer);
        this.fire(() => this.cmds.inflightClear(eKey, iKey, mKey, entry.requestId, admissionCutoff));
        this.publishTransition(() => this.transitions?.settled(principal, entry.requestId));
      },
    };
  }

  /** Owner-scoped live snapshot: bounded, newest-first, self-cleaning within the
   * slice; `{ items:[], available:false }` on any fault or a hung read, so the
   * caller never blocks and never mistakes a degraded poll for "no requests". */
  async list(principal: Principal): Promise<InflightSnapshot> {
    const tag = ownerTag(principal);
    const iKey = indexKey(tag);
    try {
      return await this.withTimeout(this.readSnapshot(tag, iKey), this.cfg.readTimeoutMs);
    } catch {
      return { items: [], available: false, truncated: false };
    }
  }

  private async readSnapshot(tag: string, iKey: string): Promise<InflightSnapshot> {
    const total = await this.redis.zcard(iKey);
    const truncated = total > this.cfg.listCap;
    const ids = await this.redis.zrevrange(iKey, 0, this.cfg.listCap - 1);
    if (ids.length === 0) return { items: [], available: true, truncated };
    const raws = await this.redis.mget(...ids.map((id) => entryKey(tag, id)));
    const items: InflightSnapshot['items'] = [];
    const expired: string[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const raw = raws[i];
      const id = ids[i]!;
      if (raw == null) {
        expired.push(id); // index member outlived its entry — reclaim it
        continue;
      }
      try {
        const e = JSON.parse(raw) as InflightEntry;
        items.push({
          id: e.requestId,
          startedAt: e.startedAt,
          decisionLayer: e.decisionLayer,
          tierAssigned: e.tierAssigned,
          modelLabel: e.modelLabel,
          providerLabel: e.providerLabel,
          protocol: e.protocol,
          status: 'running',
        });
      } catch {
        expired.push(id);
      }
    }
    if (expired.length > 0) this.fire(() => this.redis.zrem(iKey, ...expired));
    return { items, available: true, truncated };
  }

  /** Periodic bounded sweep: reclaim stale index members BELOW the read slice, so
   * an owner index cannot grow unbounded under sustained traffic. Bounded per tick;
   * the cursor visits the whole keyspace over successive ticks. */
  private async sweepOnce(): Promise<void> {
    try {
      let cursor = '0';
      let visited = 0;
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'inflight-idx:*', 'COUNT', 100);
        cursor = next;
        for (const iKey of keys) {
          const tag = tagOfIndexKey(iKey);
          if (tag === null) continue;
          const ids = await this.redis.zrange(iKey, 0, 500);
          if (ids.length === 0) continue;
          const raws = await this.redis.mget(...ids.map((id) => entryKey(tag, id)));
          const gone = ids.filter((_, i) => raws[i] == null);
          if (gone.length > 0) await this.redis.zrem(iKey, ...gone);
        }
        visited += keys.length;
      } while (cursor !== '0' && visited < 1_000);
    } catch (err) {
      this.logger.debug(`inflight sweep skipped: ${String(err)}`);
    }
  }

  /** Run a Redis op DETACHED, swallowing all faults — never awaited by a caller,
   * so a hung/failed Redis cannot affect the request path (invariants 1, 9). */
  private fire(op: () => Promise<unknown>): void {
    void op().catch(() => {
      // Swallowed by design; the connection-level error logger (RedisModule)
      // latches one line per outage, so we do not re-log per op.
    });
  }

  private withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('inflight read timeout')), ms);
    });
    return Promise.race([op, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
