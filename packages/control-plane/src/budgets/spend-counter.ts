import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { BUDGETS_CONFIG, type BudgetsConfig } from './budgets.config';
import type { BudgetWindow } from './period';

const HEARTBEAT_KEY = 'budget:reconcile:heartbeat';

/** Monotonic reconcile write: set the counter to `v` only if it exceeds the
 * current value, then (re)apply the TTL. Single-writer + an append-only period
 * ledger means a later snapshot is always ≥ an earlier one, so `max` makes an
 * out-of-order / retried occurrence a safe no-op instead of lowering the counter.
 * KEYS[1]=counter; ARGV[1]=µ$ snapshot; ARGV[2]=ttlMs. Returns the resulting µ$. */
const RECONCILE_MAX_LUA = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
local v = tonumber(ARGV[1])
if v > c then redis.call('SET', KEYS[1], v) end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if v > c then return v else return c end
`;

/**
 * The Redis spend counter (#16, invariant 10). Integer micro-dollars keyed per
 * distinct `(owner, scope, scopeId, window, period)`, shared across proxy
 * instances (no per-instance drift). All ops run on a DEDICATED fail-fast
 * connection (`enableOfflineQueue:false` + a `commandTimeout`) so a slow/down
 * Redis rejects at once instead of piling up on the request path — callers treat
 * a throw as "enforcement unavailable" and apply the named fail mode.
 *
 * The scheduler is the SOLE writer (`reconcileMax`); the block check only
 * `read`s. A reconcile heartbeat (`heartbeatSet`/`heartbeatAgeMs`) lets the block
 * check detect a stopped scheduler (stale counters) and route it through the fail
 * mode rather than silently reading 0.
 */
@Injectable()
export class SpendCounter implements OnApplicationShutdown {
  private readonly conn: Redis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis, @Inject(BUDGETS_CONFIG) cfg: BudgetsConfig) {
    this.conn = redis.duplicate({
      enableOfflineQueue: false,
      commandTimeout: cfg.redisTimeoutMs,
      maxRetriesPerRequest: 1,
    });
    this.conn.on('error', () => {}); // fail-fast throws at the call site; never crash
    if (this.conn.status === 'wait') void this.conn.connect().catch(() => {});
  }

  /** Resolve once the dedicated connection is usable (or the timeout lapses). The
   * hot path never calls this — it's for operational readiness checks and
   * deterministic tests (`enableOfflineQueue:false` rejects commands before ready). */
  async waitReady(timeoutMs = 2_000): Promise<boolean> {
    if (this.conn.status === 'ready') return true;
    return new Promise<boolean>((resolve) => {
      const done = (v: boolean): void => {
        clearTimeout(t);
        this.conn.removeListener('ready', onReady);
        resolve(v);
      };
      const onReady = (): void => done(true);
      const t = setTimeout(() => done(false), timeoutMs);
      if (typeof t.unref === 'function') t.unref();
      this.conn.once('ready', onReady);
    });
  }

  key(
    ownerUserId: string,
    scope: string,
    scopeId: string,
    window: BudgetWindow,
    periodId: string,
  ): string {
    return `budget:${ownerUserId}:${scope}:${scopeId}:${window}:${periodId}`;
  }

  /** The block-check read: current µ$ for each key (a missing key = 0). Throws
   * on a fault/timeout (the caller applies the fail mode). */
  async read(keys: string[]): Promise<number[]> {
    if (keys.length === 0) return [];
    const raw = await this.conn.mget(keys);
    return raw.map((v) => (v === null ? 0 : Number(v)));
  }

  /** Scheduler write: monotonically raise the counter to `micros` and (re)set its
   * TTL. Returns the resulting µ$. */
  async reconcileMax(key: string, micros: number, ttlMs: number): Promise<number> {
    const out = await this.conn.eval(
      RECONCILE_MAX_LUA,
      1,
      key,
      String(Math.max(0, Math.round(micros))),
      String(Math.max(1, Math.round(ttlMs))),
    );
    return Number(out);
  }

  /** Prove reconciliation is alive: stamp the heartbeat with `nowMs`, expiring
   * after `ttlMs` so a stopped scheduler's heartbeat goes absent. */
  async heartbeatSet(nowMs: number, ttlMs: number): Promise<void> {
    await this.conn.set(HEARTBEAT_KEY, String(nowMs), 'PX', Math.max(1, Math.round(ttlMs)));
  }

  /** Age of the last reconciliation heartbeat in ms (`+Infinity` if absent/
   * unreadable) — the block check treats an over-`BUDGET_STALE_MS` age as stale. */
  async heartbeatAgeMs(nowMs: number): Promise<number> {
    const raw = await this.conn.get(HEARTBEAT_KEY);
    if (raw === null) return Number.POSITIVE_INFINITY;
    const t = Number(raw);
    if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
    return nowMs - t;
  }

  /** Atomic once-per-period marker (alert/block dedup). True iff this call won
   * the claim (`SET NX`). */
  async markOnce(key: string, ttlMs: number): Promise<boolean> {
    const res = await this.conn.set(key, '1', 'PX', Math.max(1, Math.round(ttlMs)), 'NX');
    return res === 'OK';
  }

  onApplicationShutdown(): void {
    try {
      this.conn.disconnect();
    } catch {
      /* already closed */
    }
  }
}
