import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { BUDGETS_CONFIG, type BudgetsConfig } from './budgets.config';
import type { MeteringBasis } from '../database/budget.reader';
import type { BudgetWindow } from './period';

const HEARTBEAT_KEY = 'budget:reconcile:heartbeat';
/** A connection fault is a whole-instance condition — throttle the warn to avoid a
 * log flood while a Redis outage persists (per-command faults still surface via the
 * block check's fault metric). */
const CONN_WARN_WINDOW_MS = 30_000;

/** Monotonic reconcile write: set the counter to `v` only if it exceeds the
 * current value, then (re)apply the TTL. Single-writer + an append-only period
 * ledger means a later snapshot is always ≥ an earlier one, so `max` makes an
 * out-of-order / retried occurrence a safe no-op instead of lowering the counter.
 * A MISSING key is materialized even at v=0, so "seeded, and the total really is zero"
 * is distinguishable from "never reconciled" — which matters when a basis switch seeds
 * a fresh key (a missing key reads as an authoritative 0 in `read()`).
 * KEYS[1]=counter; ARGV[1]=µ$ snapshot; ARGV[2]=ttlMs. Returns the resulting µ$. */
const RECONCILE_MAX_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
local v = tonumber(ARGV[1])
if v > c or exists == 0 then redis.call('SET', KEYS[1], v) end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if v > c then return v else return c end
`;

/**
 * Atomic check-and-reserve for a batch ceiling (add-batch-inference D8): admit iff
 * `spend + pending + ceiling ≤ amount`, and in the same script add the ceiling to
 * the PENDING key. KEYS[1]=spend counter, KEYS[2]=its pending key — co-located in
 * one slot by construction (`pendingKeyFor`), so the script is Cluster-safe.
 * ARGV[1]=ceiling µ$; ARGV[2]=amount µ$; ARGV[3]=pending TTL ms.
 * Returns {admitted, spend, pending}. */
const CHECK_AND_RESERVE_LUA = `
local spend = tonumber(redis.call('GET', KEYS[1]) or '0')
local pending = tonumber(redis.call('GET', KEYS[2]) or '0')
local ceiling = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
if spend + pending + ceiling > amount then return {0, spend, pending} end
redis.call('INCRBY', KEYS[2], ceiling)
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return {1, spend, pending}
`;

/** Release a reservation: subtract, floor at zero (a release racing a reconcile
 * SET must never drive the key negative), keep the key expiring with its period.
 * KEYS[1]=pending key; ARGV[1]=µ$; ARGV[2]=TTL ms. */
const RELEASE_LUA = `
local v = redis.call('DECRBY', KEYS[1], ARGV[1])
if v < 0 then
  redis.call('SET', KEYS[1], '0')
  v = 0
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return v
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
  private readonly logger = new Logger(SpendCounter.name);
  /** Fail-fast (hot-path block check + fire-and-forget block-notify dedup). */
  private readonly readConn: Redis;
  /** Generous bound for the scheduler's reconcile writes + alert dedup (E6.3), so a
   * slow-but-healthy Redis still stamps the heartbeat instead of going stale. */
  private readonly writeConn: Redis;
  private lastConnWarnAt = 0;

  constructor(@Inject(REDIS_CLIENT) redis: Redis, @Inject(BUDGETS_CONFIG) cfg: BudgetsConfig) {
    this.readConn = this.build(redis, cfg.redisTimeoutMs, 'read');
    this.writeConn = this.build(redis, cfg.reconcileTimeoutMs, 'reconcile');
  }

  private build(base: Redis, commandTimeout: number, role: string): Redis {
    const conn = base.duplicate({
      enableOfflineQueue: false,
      commandTimeout,
      maxRetriesPerRequest: 1,
    });
    // fail-fast throws at the call site; never crash — but a connection that never
    // comes up (silent before this change) is now logged (throttled).
    conn.on('error', (err) => this.warnConn(role, err));
    if (conn.status === 'wait') void conn.connect().catch((err) => this.warnConn(role, err));
    return conn;
  }

  private warnConn(role: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastConnWarnAt < CONN_WARN_WINDOW_MS) return;
    this.lastConnWarnAt = now;
    this.logger.warn(
      `budget ${role} Redis connection fault: ${err instanceof Error ? err.constructor.name : 'unknown'}`,
    );
  }

  /** Resolve once the dedicated connection is usable (or the timeout lapses). The
   * hot path never calls this — it's for operational readiness checks and
   * deterministic tests (`enableOfflineQueue:false` rejects commands before ready). */
  async waitReady(timeoutMs = 2_000): Promise<boolean> {
    if (this.readConn.status === 'ready') return true;
    return new Promise<boolean>((resolve) => {
      const done = (v: boolean): void => {
        clearTimeout(t);
        this.readConn.removeListener('ready', onReady);
        resolve(v);
      };
      const onReady = (): void => done(true);
      const t = setTimeout(() => done(false), timeoutMs);
      if (typeof t.unref === 'function') t.unref();
      this.readConn.once('ready', onReady);
    });
  }

  /** The per-period counter key. The METERING BASIS is part of the key
   * (split-subscription-spend): `reconcileMax` below only ever RAISES a counter, so a
   * budget switching from `notional` to `cash` — whose true total is smaller — would
   * otherwise stay pinned at the old higher value and keep blocking for the rest of the
   * period. A separate key per basis preserves that monotonic guarantee instead of
   * weakening it. (The block/alert dedupe markers are deliberately NOT keyed by basis:
   * their contract is at most one notification per budget per period.) */
  key(
    ownerUserId: string,
    scope: string,
    scopeId: string,
    window: BudgetWindow,
    periodId: string,
    basis: MeteringBasis,
  ): string {
    // `notional` deliberately keeps the LEGACY key shape. Every budget predating this
    // change meters notional, so namespacing it would move every existing counter to a
    // cold key on upgrade — and a missing counter reads as an authoritative zero while
    // the global heartbeat stays fresh from other budgets' reconciles, silently
    // admitting requests against an already-blocked budget until its next reconcile.
    // Only `cash` — a genuinely different quantity, and a basis no budget had before —
    // gets its own namespace.
    const suffix = basis === 'cash' ? 'cash:' : '';
    return `budget:${ownerUserId}:${scope}:${scopeId}:${window}:${suffix}${periodId}`;
  }

  /** The block-check read: current µ$ for each key (a missing key = 0). Throws
   * on a fault/timeout (the caller applies the fail mode). */
  async read(keys: string[]): Promise<number[]> {
    if (keys.length === 0) return [];
    const raw = await this.readConn.mget(keys);
    return raw.map((v) => (v === null ? 0 : Number(v)));
  }

  /**
   * The pending-reservation key beside a spend key (add-batch-inference D8). It is
   * its OWN structure — the scheduler `SET`s the spend counter from the ledger and
   * would erase anything held inside it — and it is placed in the spend key's
   * cluster slot by hash tag: a key without braces hashes its whole name, and
   * `{<name>}:pending` hashes exactly `<name>`, so the two co-locate without moving
   * the spend key (an upgrade must find every existing counter where it left it).
   */
  pendingKeyFor(spendKey: string): string {
    return `{${spendKey}}:pending`;
  }

  /** Spend + pending for each spend key, in one round trip (missing = 0). */
  async readWithPending(spendKeys: string[]): Promise<{ spend: number; pending: number }[]> {
    if (spendKeys.length === 0) return [];
    const raw = await this.readConn.mget([
      ...spendKeys,
      ...spendKeys.map((k) => this.pendingKeyFor(k)),
    ]);
    const n = spendKeys.length;
    return spendKeys.map((_, i) => ({
      spend: raw[i] === null || raw[i] === undefined ? 0 : Number(raw[i]),
      pending: raw[n + i] === null || raw[n + i] === undefined ? 0 : Number(raw[n + i]),
    }));
  }

  /** Atomic check-and-reserve against ONE spend key (see the script). Fail-fast:
   * a fault throws and the caller applies the named fail mode. */
  async checkAndReserve(
    spendKey: string,
    amountMicros: number,
    ceilingMicros: number,
    ttlMs: number,
  ): Promise<{ admitted: boolean; spend: number; pending: number }> {
    const out = (await this.readConn.eval(
      CHECK_AND_RESERVE_LUA,
      2,
      spendKey,
      this.pendingKeyFor(spendKey),
      String(Math.max(0, Math.ceil(ceilingMicros))),
      String(Math.max(0, Math.round(amountMicros))),
      String(Math.max(1, Math.round(ttlMs))),
    )) as [number, number, number];
    return { admitted: Number(out[0]) === 1, spend: Number(out[1]), pending: Number(out[2]) };
  }

  /** Release a reservation from ONE spend key's pending structure (floored at 0). */
  async release(spendKey: string, micros: number, ttlMs: number): Promise<number> {
    const out = await this.readConn.eval(
      RELEASE_LUA,
      1,
      this.pendingKeyFor(spendKey),
      String(Math.max(0, Math.ceil(micros))),
      String(Math.max(1, Math.round(ttlMs))),
    );
    return Number(out);
  }

  /** Scheduler write: the authoritative pending total from the job rows (NOT
   * monotonic — pending falls as jobs settle; the database is the source of truth). */
  async reconcilePending(spendKey: string, micros: number, ttlMs: number): Promise<void> {
    await this.writeConn.set(
      this.pendingKeyFor(spendKey),
      String(Math.max(0, Math.round(micros))),
      'PX',
      Math.max(1, Math.round(ttlMs)),
    );
  }

  /** Scheduler write: monotonically raise the counter to `micros` and (re)set its
   * TTL. Returns the resulting µ$. */
  async reconcileMax(key: string, micros: number, ttlMs: number): Promise<number> {
    const out = await this.writeConn.eval(
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
    await this.writeConn.set(HEARTBEAT_KEY, String(nowMs), 'PX', Math.max(1, Math.round(ttlMs)));
  }

  /** Age of the last reconciliation heartbeat in ms (`+Infinity` if absent/
   * unreadable) — the block check treats an over-`BUDGET_STALE_MS` age as stale. */
  async heartbeatAgeMs(nowMs: number): Promise<number> {
    const raw = await this.readConn.get(HEARTBEAT_KEY);
    if (raw === null) return Number.POSITIVE_INFINITY;
    const t = Number(raw);
    if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
    return nowMs - t;
  }

  /** Fire-and-forget BLOCK-notify dedup (from the hot-path block check) — fail-fast
   * connection: a slow Redis timing out here is fine (the block is already enforced;
   * the emit is best-effort). True iff this call won the claim (`SET NX`). */
  async markBlockOnce(key: string, ttlMs: number): Promise<boolean> {
    return this.setNx(this.readConn, key, ttlMs);
  }

  /** Scheduler ALERT dedup — the reconcile occurrence AWAITS this before stamping
   * the heartbeat, so it MUST use the generous write connection (E6.3): a fail-fast
   * timeout here would abort the occurrence before `heartbeatSet` and leave
   * enforcement stale. */
  async markAlertOnce(key: string, ttlMs: number): Promise<boolean> {
    return this.setNx(this.writeConn, key, ttlMs);
  }

  private async setNx(conn: Redis, key: string, ttlMs: number): Promise<boolean> {
    const res = await conn.set(key, '1', 'PX', Math.max(1, Math.round(ttlMs)), 'NX');
    return res === 'OK';
  }

  onApplicationShutdown(): void {
    for (const conn of [this.readConn, this.writeConn]) {
      try {
        conn.disconnect();
      } catch {
        /* already closed */
      }
    }
  }
}
