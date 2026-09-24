/**
 * Redis-shared circuit breaker (§3.2, invariant 10). The pure `transition`
 * functions are the semantic source of truth; two stores implement them —
 * `InMemoryBreakerStore` (the per-instance fallback, and, shared by two
 * breakers in tests, the "one simulated Redis") and `RedisBreakerStore` (the
 * same math in one atomic Lua script). Admission returns a generation-stamped
 * token; a completion applies only when its generation still matches, so a slow
 * request admitted in an older state can't impersonate the half-open probe.
 */
import type { NormalizedStreamEvent } from '../proxy/translate';
import {
  CallCancelledError,
  ProviderCircuitOpenError,
  ProviderError,
  breakerImpact,
  classifyStreamError,
} from './errors';
import type { ProviderErrorKind } from './errors';
import { PROBE_RECORD_TTL_HEADROOM_MS } from './probe-patience';

export type BreakerState = 'closed' | 'open' | 'half_open';
export type BreakerOutcome = 'success' | 'trip' | 'neutral';
export type BreakerDecision = 'allow' | 'skip';

export interface BreakerConfig {
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly probeLeaseMs: number;
  readonly stateTtlMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  threshold: 5,
  cooldownMs: 30_000,
  probeLeaseMs: 10_000,
  stateTtlMs: 300_000,
};

export interface BreakerRecord {
  readonly state: BreakerState;
  readonly failures: number;
  readonly openedAt: number;
  readonly generation: number;
  readonly probeExpiresAt: number;
}

export const INITIAL_RECORD: BreakerRecord = {
  state: 'closed',
  failures: 0,
  openedAt: 0,
  generation: 0,
  probeExpiresAt: 0,
};

export interface DecideResult {
  readonly next: BreakerRecord;
  readonly decision: BreakerDecision;
  readonly generation: number;
  readonly isProbe: boolean;
}

/** Pure admission decision. Admitting a probe — including reclaiming an expired
 * lease — increments the generation, so a superseded probe's late completion is
 * ignored (a stale generation can't close/reopen the current one). */
export function decide(rec: BreakerRecord, now: number, cfg: BreakerConfig): DecideResult {
  if (rec.state === 'closed') {
    return { next: rec, decision: 'allow', generation: rec.generation, isProbe: false };
  }
  if (rec.state === 'open') {
    if (now - rec.openedAt >= cfg.cooldownMs) {
      const generation = rec.generation + 1;
      return {
        next: {
          state: 'half_open',
          failures: 0,
          openedAt: rec.openedAt,
          generation,
          probeExpiresAt: now + cfg.probeLeaseMs,
        },
        decision: 'allow',
        generation,
        isProbe: true,
      };
    }
    return { next: rec, decision: 'skip', generation: rec.generation, isProbe: false };
  }
  // half_open
  if (now >= rec.probeExpiresAt) {
    const generation = rec.generation + 1; // reclaim expired lease → new generation
    return {
      next: {
        state: 'half_open',
        failures: 0,
        openedAt: rec.openedAt,
        generation,
        probeExpiresAt: now + cfg.probeLeaseMs,
      },
      decision: 'allow',
      generation,
      isProbe: true,
    };
  }
  return { next: rec, decision: 'skip', generation: rec.generation, isProbe: false };
}

/** Pure completion. No-op when the token's generation is stale. */
export function applyComplete(
  rec: BreakerRecord,
  tokenGeneration: number,
  outcome: BreakerOutcome,
  now: number,
  cfg: BreakerConfig,
): BreakerRecord {
  if (tokenGeneration !== rec.generation || outcome === 'neutral') return rec;
  if (outcome === 'success') {
    if (rec.state === 'half_open') {
      return {
        state: 'closed',
        failures: 0,
        openedAt: 0,
        generation: rec.generation + 1,
        probeExpiresAt: 0,
      };
    }
    if (rec.state === 'closed') return rec.failures === 0 ? rec : { ...rec, failures: 0 };
    return rec;
  }
  // trip
  if (rec.state === 'half_open') {
    return {
      state: 'open',
      failures: 0,
      openedAt: now,
      generation: rec.generation + 1,
      probeExpiresAt: 0,
    };
  }
  if (rec.state === 'closed') {
    const failures = rec.failures + 1;
    if (failures >= cfg.threshold) {
      return {
        state: 'open',
        failures: 0,
        openedAt: now,
        generation: rec.generation + 1,
        probeExpiresAt: 0,
      };
    }
    return { ...rec, failures };
  }
  return rec;
}

/** Pure lease renewal. Extends the half-open probe lease for the CURRENT
 * generation while it is still unexpired; a no-op otherwise. The expiry guard
 * (`now < probeExpiresAt`) is load-bearing: a renewal arriving at/after lease
 * expiry must NOT revive the dead lease, or a silent-until-expiry probe would
 * dodge reclamation (its stale completion could then transition the breaker). */
export function applyRenew(
  rec: BreakerRecord,
  tokenGeneration: number,
  now: number,
  cfg: BreakerConfig,
): BreakerRecord {
  if (
    rec.state !== 'half_open' ||
    tokenGeneration !== rec.generation ||
    now >= rec.probeExpiresAt
  ) {
    return rec;
  }
  // A renewal only ever EXTENDS the lease — `Math.max` guarantees it can never
  // shorten it, so a backward wall-clock step can't shrink a live probe's window.
  return { ...rec, probeExpiresAt: Math.max(rec.probeExpiresAt, now + cfg.probeLeaseMs) };
}

export interface Admission {
  readonly decision: BreakerDecision;
  readonly generation: number;
  readonly isProbe: boolean;
}

/** Result of a completion — `justOpened` is true iff this completion applied a
 * transition INTO the open state (closed→open or half_open→open), so a caller
 * can fire a one-shot side effect (e.g. a `provider_down` alert) on the trip. */
export interface BreakerCompletion {
  readonly justOpened: boolean;
  readonly generation: number;
  readonly openedAt: number;
  /** add-provider-health-signals: the completion APPLIED — its token generation
   * was current and the outcome not neutral (a closed-state success that leaves
   * the record unchanged still applied). A stale completion is `false`. */
  readonly applied: boolean;
  /** add-provider-health-signals: a per-provider event sequence, strictly
   * increasing (including completions in the same millisecond, and across the
   * record's expiry or reset); 0 when not applied. Lets a consumer order
   * observations without comparing instance clocks. */
  readonly seq: number;
}

/** Where a completion was settled: the shared primary store, the per-instance
 * fallback, or neither (a primary-store FAULT). Only `primary` observations are
 * shared-breaker facts (add-provider-health-signals). */
export type BreakerCompletionSource = 'primary' | 'fallback' | 'fault';

export interface BreakerSettlement extends BreakerCompletion {
  readonly source: BreakerCompletionSource;
}

export interface BreakerStore {
  decide(providerId: string, now: number, cfg: BreakerConfig): Promise<Admission>;
  complete(
    providerId: string,
    generation: number,
    outcome: BreakerOutcome,
    now: number,
    cfg: BreakerConfig,
  ): Promise<BreakerCompletion>;
  /** Extend a live half-open probe's lease (see {@link applyRenew}). Best-effort
   * and idempotent — a stale-generation or expired-lease renewal is a no-op. */
  renew(providerId: string, generation: number, now: number, cfg: BreakerConfig): Promise<void>;
  /** Drop the provider's breaker record entirely (add-subscription-oauth): called ONLY
   * on a successful OAuth reauthorization, so a freshly reconnected provider is not
   * stuck serving a cooldown earned by its dead credential. NEVER called by ordinary
   * refresh — routine token renewal must not erase genuine upstream failure history. */
  reset(providerId: string): Promise<void>;
}

/** In-memory store: the read-compute-write is synchronous (single-threaded JS),
 * so it is atomic. Two breakers sharing one instance = two instances, one store. */
export class InMemoryBreakerStore implements BreakerStore {
  private readonly records = new Map<string, BreakerRecord>();
  /** Per-provider event sequence (parity with the Redis store's `lastSeq`). */
  private readonly lastSeq = new Map<string, number>();

  /** A record created where none exists takes a generation no earlier token can
   * carry (seeded from the clock, never a fixed 0 — add-provider-health-signals). */
  private recordFor(providerId: string, now: number): BreakerRecord {
    return this.records.get(providerId) ?? { ...INITIAL_RECORD, generation: now };
  }

  decide(providerId: string, now: number, cfg: BreakerConfig): Promise<Admission> {
    const rec = this.recordFor(providerId, now);
    const r = decide(rec, now, cfg);
    this.records.set(providerId, r.next);
    return Promise.resolve({ decision: r.decision, generation: r.generation, isProbe: r.isProbe });
  }

  complete(
    providerId: string,
    generation: number,
    outcome: BreakerOutcome,
    now: number,
    cfg: BreakerConfig,
  ): Promise<BreakerCompletion> {
    const existed = this.records.has(providerId);
    const rec = this.recordFor(providerId, now);
    const next = applyComplete(rec, generation, outcome, now, cfg);
    const applied = generation === rec.generation && outcome !== 'neutral';
    // Redis parity: a stale completion against a MISSING record writes nothing (the
    // Lua returns before its HMSET) — never materialize a phantom record here.
    if (existed || applied) this.records.set(providerId, next);
    let seq = 0;
    if (applied) {
      seq = Math.max(now * 1000, (this.lastSeq.get(providerId) ?? 0) + 1);
      this.lastSeq.set(providerId, seq);
    }
    return Promise.resolve({
      justOpened: rec.state !== 'open' && next.state === 'open',
      generation: next.generation,
      openedAt: next.openedAt,
      applied,
      seq,
    });
  }

  renew(providerId: string, generation: number, now: number, cfg: BreakerConfig): Promise<void> {
    // Redis parity: RENEW_LUA only touches a live half-open record — a renewal
    // against a missing record creates nothing.
    const rec = this.records.get(providerId);
    if (rec !== undefined) this.records.set(providerId, applyRenew(rec, generation, now, cfg));
    return Promise.resolve();
  }

  /** Closed with no failures, the generation ADVANCED (never deleted to a
   * reusable 0) — every call admitted before the reset completes stale. */
  reset(providerId: string): Promise<void> {
    const now = Date.now();
    const rec = this.records.get(providerId);
    this.records.set(providerId, {
      ...INITIAL_RECORD,
      generation: Math.max((rec?.generation ?? 0) + 1, now),
    });
    return Promise.resolve();
  }
}

/** The subset of ioredis used by the Redis store (structurally satisfied by an
 * ioredis `Redis`). Keeps the breaker decoupled from a concrete client. */
export interface BreakerRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// `now` is derived from the Redis server clock (`TIME`) inside every script, not
// from a per-instance `Date.now()` ARGV, so inter-instance wall-clock skew cannot
// corrupt cooldown/lease arithmetic (spec: "a single Lua script … using the Redis
// server clock"). Redis 7 replicates script *effects*, so a `TIME` read in a
// writing script is allowed. The store still accepts a `now` argument (interface
// parity with the in-memory store) but does not forward it.
const NOW_FROM_SERVER = `local st=redis.call('TIME'); local now=tonumber(st[1])*1000+math.floor(tonumber(st[2])/1000)`;

const DECIDE_LUA = `
${NOW_FROM_SERVER}
local cooldown=tonumber(ARGV[1]); local lease=tonumber(ARGV[2]); local ttl=tonumber(ARGV[3])
local h=redis.call('HMGET',KEYS[1],'state','failures','openedAt','generation','probeExpiresAt')
local state=h[1] or 'closed'
local failures=tonumber(h[2] or '0'); local openedAt=tonumber(h[3] or '0'); local generation=tonumber(h[4] or now); local probeExp=tonumber(h[5] or '0')
local decision='allow'; local isProbe=0
if state=='closed' then decision='allow'
elseif state=='open' then
  if now-openedAt>=cooldown then generation=generation+1; state='half_open'; failures=0; probeExp=now+lease; decision='allow'; isProbe=1
  else decision='skip' end
else
  if now>=probeExp then generation=generation+1; state='half_open'; failures=0; probeExp=now+lease; decision='allow'; isProbe=1
  else decision='skip' end
end
redis.call('HMSET',KEYS[1],'state',state,'failures',failures,'openedAt',openedAt,'generation',generation,'probeExpiresAt',probeExp)
redis.call('PEXPIRE',KEYS[1],ttl)
return {decision,generation,isProbe}
`;

const COMPLETE_LUA = `
${NOW_FROM_SERVER}
local tokenGen=tonumber(ARGV[1]); local outcome=ARGV[2]; local threshold=tonumber(ARGV[3]); local ttl=tonumber(ARGV[4])
local h=redis.call('HMGET',KEYS[1],'state','failures','openedAt','generation','probeExpiresAt','lastSeq')
local state=h[1] or 'closed'
local failures=tonumber(h[2] or '0'); local openedAt=tonumber(h[3] or '0'); local generation=tonumber(h[4] or now); local probeExp=tonumber(h[5] or '0')
local lastSeq=tonumber(h[6] or '0')
local prev=state
if tokenGen~=generation then return {0,generation,openedAt,0,0} end
if outcome=='neutral' then return {0,generation,openedAt,0,0} end
local seq=math.max(now*1000, lastSeq+1)
if outcome=='success' then
  if state=='half_open' then state='closed'; failures=0; openedAt=0; generation=generation+1; probeExp=0
  elseif state=='closed' then failures=0 end
else
  if state=='half_open' then state='open'; failures=0; openedAt=now; generation=generation+1; probeExp=0
  elseif state=='closed' then failures=failures+1; if failures>=threshold then state='open'; failures=0; openedAt=now; generation=generation+1; probeExp=0 end end
end
redis.call('HMSET',KEYS[1],'state',state,'failures',failures,'openedAt',openedAt,'generation',generation,'probeExpiresAt',probeExp,'lastSeq',seq)
redis.call('PEXPIRE',KEYS[1],ttl)
local justOpened=0
if prev~='open' and state=='open' then justOpened=1 end
return {justOpened,generation,openedAt,1,seq}
`;

// The reauthorization-only reset (add-subscription-oauth), made generation-safe
// (add-provider-health-signals): closed with no failures and the generation
// ADVANCED — never a DEL back to a reusable generation 0 — so every call admitted
// before the reset completes as stale and cannot count against, or re-open, the
// freshly reset breaker. `lastSeq` is kept (the sequence stays increasing). The
// fixed TTL outlives any in-flight call; the next decide/complete re-applies the
// configured state TTL.
const RESET_LUA = `
${NOW_FROM_SERVER}
local h=redis.call('HMGET',KEYS[1],'generation')
local generation=math.max(tonumber(h[1] or '0')+1, now)
redis.call('HMSET',KEYS[1],'state','closed','failures',0,'openedAt',0,'generation',generation,'probeExpiresAt',0)
redis.call('PEXPIRE',KEYS[1],86400000)
return 1
`;

// Renew a live half-open probe's lease (E4.1). Mirrors `applyRenew`: extends only
// the current generation's lease and only while it is still unexpired (server
// clock), so a late/silent probe is left to be reclaimed by the next `decide`.
const RENEW_LUA = `
${NOW_FROM_SERVER}
local tokenGen=tonumber(ARGV[1]); local lease=tonumber(ARGV[2]); local ttl=tonumber(ARGV[3])
local h=redis.call('HMGET',KEYS[1],'state','generation','probeExpiresAt')
local state=h[1] or 'closed'; local generation=tonumber(h[2] or '0'); local probeExp=tonumber(h[3] or '0')
if state=='half_open' and tokenGen==generation and now<probeExp then
  redis.call('HSET',KEYS[1],'probeExpiresAt',math.max(probeExp,now+lease))
  redis.call('PEXPIRE',KEYS[1],ttl)
end
return 1
`;

export class RedisBreakerStore implements BreakerStore {
  constructor(
    private readonly redis: BreakerRedis,
    private readonly keyPrefix = 'cb:',
  ) {}

  private key(providerId: string): string {
    return `${this.keyPrefix}${providerId}`;
  }

  // `_now` is ignored: the Lua reads the Redis server clock (E4.2). The parameter
  // stays for `BreakerStore` interface parity with the in-memory store.
  async decide(providerId: string, _now: number, cfg: BreakerConfig): Promise<Admission> {
    const res = (await this.redis.eval(
      DECIDE_LUA,
      1,
      this.key(providerId),
      cfg.cooldownMs,
      cfg.probeLeaseMs,
      cfg.stateTtlMs,
    )) as [unknown, unknown, unknown];
    return {
      decision: String(res[0]) === 'allow' ? 'allow' : 'skip',
      generation: Number(res[1]),
      isProbe: Number(res[2]) === 1,
    };
  }

  async complete(
    providerId: string,
    generation: number,
    outcome: BreakerOutcome,
    _now: number,
    cfg: BreakerConfig,
  ): Promise<BreakerCompletion> {
    const res = (await this.redis.eval(
      COMPLETE_LUA,
      1,
      this.key(providerId),
      generation,
      outcome,
      cfg.threshold,
      cfg.stateTtlMs,
    )) as [unknown, unknown, unknown, unknown, unknown];
    return {
      justOpened: Number(res[0]) === 1,
      generation: Number(res[1]),
      openedAt: Number(res[2]),
      applied: Number(res[3]) === 1,
      seq: Number(res[4]),
    };
  }

  async renew(
    providerId: string,
    generation: number,
    _now: number,
    cfg: BreakerConfig,
  ): Promise<void> {
    await this.redis.eval(
      RENEW_LUA,
      1,
      this.key(providerId),
      generation,
      cfg.probeLeaseMs,
      cfg.stateTtlMs,
    );
  }

  async reset(providerId: string): Promise<void> {
    await this.redis.eval(RESET_LUA, 1, this.key(providerId));
  }
}

export interface BreakerToken {
  readonly providerId: string;
  readonly store: BreakerStore;
  readonly generation: number;
  readonly isProbe: boolean;
  /** Whether admission ran on the shared primary store (vs the per-instance
   * fallback). Only a primary-store transition surfaces `justOpened` — a Redis
   * outage must not fan out N duplicate `provider_down` alerts. */
  readonly isPrimary: boolean;
  /** The GRANTED lease duration (probe patience, add-fallback-attempt-detail):
   * `max(config lease, caller-requested minimum)`, decided at admission and
   * carried on the token so every subsequent renewal extends by IT — a renewal
   * snapping back to the default would strand a widened probe whose next legal
   * silence exceeds it. Equals the config lease for ordinary admissions. */
  readonly leaseMs: number;
}

/** What the breaker wrappers hand their callbacks at admission (probe patience):
 * `isProbe` lets the attempt widen its typed bounds; `renewOnActivity` is the
 * internally-throttled, token-closing lease renewal (the private generation-
 * stamped token itself is never exposed) — a no-op for non-probe admissions, so
 * callers may wire it unconditionally (e.g. as the adapter's `onBytes`). */
export interface BreakerAdmission {
  readonly isProbe: boolean;
  readonly renewOnActivity: () => void;
}

export interface CircuitBreakerOptions {
  readonly config?: BreakerConfig;
  readonly fallback?: BreakerStore;
  readonly now?: () => number;
  readonly onError?: (err: unknown) => void;
}

export class CircuitBreaker {
  private readonly cfg: BreakerConfig;
  private readonly fallback: BreakerStore;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly primary: BreakerStore,
    opts: CircuitBreakerOptions = {},
  ) {
    this.cfg = opts.config ?? DEFAULT_BREAKER_CONFIG;
    this.fallback = opts.fallback ?? new InMemoryBreakerStore();
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => undefined);
  }

  /** Per-call config for a (possibly widened) lease: the lease and the record
   * TTL are already per-call store arguments, so probe patience needs no store
   * or script change. The TTL strictly OUTLIVES the lease (named headroom): at
   * equality the record could expire at `probeExpiresAt` and the next admission
   * would read a vanished record as `closed`, bypassing the generation-bumping
   * reclaim (add-fallback-attempt-detail). */
  private cfgForLease(leaseMs: number): BreakerConfig {
    if (leaseMs <= this.cfg.probeLeaseMs) return this.cfg;
    return {
      ...this.cfg,
      probeLeaseMs: leaseMs,
      stateTtlMs: Math.max(this.cfg.stateTtlMs, leaseMs + PROBE_RECORD_TTL_HEADROOM_MS),
    };
  }

  /** `minProbeLeaseMs` (probe patience): the caller's floor on the lease a probe
   * admission is granted — `max(config lease, floor)` — so a widened-bound probe
   * cannot be reclaimed mid-legal-silence. Unused for non-probe admissions. */
  async before(
    providerId: string,
    minProbeLeaseMs?: number,
  ): Promise<{ decision: BreakerDecision; token: BreakerToken }> {
    const now = this.now();
    const leaseMs = Math.max(this.cfg.probeLeaseMs, minProbeLeaseMs ?? 0);
    const cfg = this.cfgForLease(leaseMs);
    try {
      const a = await this.primary.decide(providerId, now, cfg);
      return {
        decision: a.decision,
        token: {
          providerId,
          store: this.primary,
          generation: a.generation,
          isProbe: a.isProbe,
          isPrimary: true,
          leaseMs,
        },
      };
    } catch (err) {
      this.onError(err);
      const a = await this.fallback.decide(providerId, now, cfg);
      return {
        decision: a.decision,
        token: {
          providerId,
          store: this.fallback,
          generation: a.generation,
          isProbe: a.isProbe,
          isPrimary: false,
          leaseMs,
        },
      };
    }
  }

  /** Store-affine: the completion goes to whichever store admitted the call.
   * `justOpened` is surfaced only for a **primary-store** transition (never on a
   * fallback open, never on a store fault) so `provider_down` alerts are one per
   * shared incident, not per instance. */
  async complete(token: BreakerToken, outcome: BreakerOutcome): Promise<BreakerSettlement> {
    try {
      const res = await token.store.complete(
        token.providerId,
        token.generation,
        outcome,
        this.now(),
        this.cfg,
      );
      return token.isPrimary
        ? { ...res, source: 'primary' }
        : { ...res, justOpened: false, source: 'fallback' };
    } catch (err) {
      this.onError(err);
      // A primary-store FAULT is distinguishable (add-provider-health-signals): it
      // is not a shared-breaker fact, so nothing downstream may treat it as one.
      return {
        justOpened: false,
        generation: token.generation,
        openedAt: 0,
        applied: false,
        seq: 0,
        source: 'fault',
      };
    }
  }

  /** The breaker's clock — exposed so a streaming caller can throttle probe-lease
   * renewals against the same time source the store math uses. */
  nowMs(): number {
    return this.now();
  }

  get probeLeaseMs(): number {
    return this.cfg.probeLeaseMs;
  }

  /** Renew a live half-open probe's lease on the store that admitted it (E4.1).
   * A no-op for a non-probe token. Contains BOTH the store fault and a throwing
   * `onError` hook, so the returned promise NEVER rejects — a fire-and-forget
   * caller (`withBreakerStream`) can never leak an unhandled rejection or stall
   * the stream. */
  async renewProbe(token: BreakerToken): Promise<void> {
    if (!token.isProbe) return;
    try {
      // Renewals extend by the token's GRANTED lease (probe patience) — never
      // the default, which would strand a widened probe mid-legal-silence.
      await token.store.renew(
        token.providerId,
        token.generation,
        this.now(),
        this.cfgForLease(token.leaseMs),
      );
    } catch (err) {
      try {
        this.onError(err);
      } catch {
        /* a renewal must never break the stream — even a throwing onError hook */
      }
    }
  }
}

/**
 * The ONE kind→outcome rule, shared by the thrown-error path and the in-band
 * streamed-error path so the two cannot drift (fix-4xx-error-taxonomy).
 *
 * `credential` (add-subscription-oauth) is strictly NEUTRAL: a revoked grant or IdP
 * outage must neither trip the breaker NOR settle as a success — a success would
 * erase genuine failure counts or close a half-open probe the upstream never earned.
 * `upstream_rejected` joins it on exactly that reasoning: a 4xx we could not
 * classify proves nothing about upstream health, so letting it settle `success`
 * would turn an unrecognized response into a laundering mechanism for a provider's
 * genuine failure history.
 *
 * Every other non-tripping kind PROVES the provider is WORKING — `permission`,
 * `content_policy`, and `policy_block` are decisions from a working provider,
 * exactly like `bad_request` — so they settle as health successes.
 * `oversized_response` is deliberately NOT among them: answering is not the same
 * as working (fix-bad-request-dead-end).
 */
export function outcomeForKind(kind: ProviderErrorKind): BreakerOutcome {
  if (
    kind === 'credential' ||
    kind === 'upstream_rejected' ||
    // fix-bad-request-dead-end: an over-cap body proves the provider sent BYTES, not
    // that it is working. A health success here would close a half-open probe for a
    // flooding upstream (handing it full traffic) or zero a closed record's failures.
    kind === 'oversized_response'
  )
    return 'neutral';
  return breakerImpact(kind) ? 'trip' : 'success';
}

export function outcomeForError(err: unknown): BreakerOutcome {
  if (err instanceof CallCancelledError) return 'neutral';
  if (err instanceof ProviderError) return outcomeForKind(err.kind);
  return 'trip';
}

function isCancellation(err: unknown): boolean {
  return err instanceof CallCancelledError || (err instanceof Error && err.name === 'AbortError');
}

/** Fired once when a completion opens the shared breaker (see `BreakerToken.isPrimary`). */
export type BreakerOpenListener = (
  providerId: string,
  info: { generation: number; openedAt: number },
) => void;

/** Fired with the state OBSERVED at each admission decision (#21 metrics):
 * `skip` ⇒ open, an allowed probe ⇒ half_open, a plain allow ⇒ closed.
 * Best-effort — it must never throw into the call path. */
export type BreakerStateListener = (providerId: string, state: BreakerState) => void;

function notifyState(
  onState: BreakerStateListener | undefined,
  providerId: string,
  decision: BreakerDecision,
  isProbe: boolean,
): void {
  if (!onState) return;
  try {
    onState(providerId, decision === 'skip' ? 'open' : isProbe ? 'half_open' : 'closed');
  } catch {
    /* an observation hook must never affect routing */
  }
}

/** What one attempt's settlement observed (add-provider-health-signals). `kind`
 * is the attempt's classified provider-error kind, or `null` for a genuinely
 * served call (a resolved response, or a stream that reached its terminal stop). */
export interface BreakerSettleInfo {
  readonly outcome: BreakerOutcome;
  readonly kind: ProviderErrorKind | null;
  readonly justOpened: boolean;
  readonly applied: boolean;
  readonly seq: number;
}

/** A PER-ATTEMPT settle hook (add-provider-health-signals): invoked once per
 * dispatched attempt, only for a completion settled on the shared PRIMARY store
 * (never the per-instance fallback, never a store fault). Synchronous and
 * best-effort — it must start any I/O fire-and-forget and never throw into the
 * call path. Carried per attempt (not per chain) so two members of the same
 * provider each observe their own settlement. */
export type BreakerSettleListener = (info: BreakerSettleInfo) => void;

/** Complete + fire `onOpen` on a fresh open, and the attempt's `onSettle` for a
 * primary-store completion. Both hooks are best-effort and MUST NOT throw into
 * the call path. */
async function completeAndNotify(
  breaker: CircuitBreaker,
  token: BreakerToken,
  outcome: BreakerOutcome,
  onOpen: BreakerOpenListener | undefined,
  onSettle?: BreakerSettleListener,
  kind: ProviderErrorKind | null = null,
): Promise<void> {
  const res = await breaker.complete(token, outcome);
  if (res.justOpened && onOpen) {
    try {
      onOpen(token.providerId, { generation: res.generation, openedAt: res.openedAt });
    } catch {
      /* an alert hook must never affect routing */
    }
  }
  if (onSettle && res.source === 'primary') {
    try {
      onSettle({
        outcome,
        kind,
        justOpened: res.justOpened,
        applied: res.applied,
        seq: res.seq,
      });
    } catch {
      /* an observation hook must never affect routing */
    }
  }
}

/** The provider-error kind an attempt failed with (untyped → `unavailable`). */
function kindOf(err: unknown): ProviderErrorKind {
  return err instanceof ProviderError ? err.kind : 'unavailable';
}

/** The internally-throttled, token-closing lease renewal (probe patience): a
 * no-op for non-probe tokens and after settle, so callers can wire it
 * unconditionally. Throttled to ~once per third of the GRANTED lease; the
 * store's own expiry/generation guards make a late renewal a harmless no-op.
 * `t < lastRenewAt` catches a BACKWARD wall-clock step (NTP) — renew at once
 * and re-baseline, so renewals never stall against the store's server clock. */
function makeRenewOnActivity(
  breaker: CircuitBreaker,
  token: BreakerToken,
  isSettled: () => boolean,
): () => void {
  const renewEveryMs = Math.max(1, Math.floor(token.leaseMs / 3));
  let lastRenewAt = breaker.nowMs();
  return (): void => {
    if (!token.isProbe || isSettled()) return;
    const t = breaker.nowMs();
    if (t - lastRenewAt >= renewEveryMs || t < lastRenewAt) {
      lastRenewAt = t;
      void breaker.renewProbe(token);
    }
  };
}

/** Wrap a unary provider call. Health = "did the provider respond": a resolved
 * call or a non-tripping error is success; a tripping error trips; a caller
 * cancellation is neutral — including when the CALLER-gone teardown error
 * reaches us in a normalized provider-error shape (a mid-body abort is
 * converted by the adapters), which `isCallerAbort` disambiguates from
 * system-imposed timeouts that must keep tripping. `onOpen` fires once if this
 * call opens the breaker. The callback receives the admission info (probe
 * patience): `isProbe` to widen the attempt's bounds, and `renewOnActivity` to
 * wire as the call's byte-liveness hook so a healthy long buffered body holds
 * its lease (mirroring the streaming wrapper). `minProbeLeaseMs` floors the
 * lease a probe admission is granted. */
export async function withBreaker<T>(
  breaker: CircuitBreaker,
  providerId: string,
  fn: (admission: BreakerAdmission) => Promise<T>,
  onOpen?: BreakerOpenListener,
  onState?: BreakerStateListener,
  isCallerAbort?: () => boolean,
  minProbeLeaseMs?: number,
  onSettle?: BreakerSettleListener,
): Promise<T> {
  const { decision, token } = await breaker.before(providerId, minProbeLeaseMs);
  notifyState(onState, providerId, decision, token.isProbe);
  if (decision === 'skip') throw new ProviderCircuitOpenError(providerId);
  let settled = false;
  const admission: BreakerAdmission = {
    isProbe: token.isProbe,
    renewOnActivity: makeRenewOnActivity(breaker, token, () => settled),
  };
  try {
    const result = await fn(admission);
    settled = true;
    await completeAndNotify(breaker, token, 'success', onOpen, onSettle, null);
    return result;
  } catch (err) {
    settled = true;
    const outcome = isCallerAbort?.() === true ? 'neutral' : outcomeForError(err);
    await completeAndNotify(breaker, token, outcome, onOpen, onSettle, kindOf(err));
    throw err;
  }
}

/** Wrap a streaming provider call. Owns admission across the whole iteration: a
 * clean EOF WITHOUT a terminal stop reason is a truncation (trip); an observed
 * normalized `error` event is classified, not blanket-tripped; consumer
 * cancellation is neutral. */
export async function* withBreakerStream(
  breaker: CircuitBreaker,
  providerId: string,
  gen: (
    renewOnActivity: () => void,
    admission: BreakerAdmission,
  ) => AsyncGenerator<NormalizedStreamEvent>,
  onOpen?: BreakerOpenListener,
  onState?: BreakerStateListener,
  isCallerAbort?: () => boolean,
  minProbeLeaseMs?: number,
  onSettle?: BreakerSettleListener,
): AsyncGenerator<NormalizedStreamEvent> {
  const { decision, token } = await breaker.before(providerId, minProbeLeaseMs);
  notifyState(onState, providerId, decision, token.isProbe);
  if (decision === 'skip') throw new ProviderCircuitOpenError(providerId);

  let settled = false;
  const settle = async (
    outcome: BreakerOutcome,
    kind: ProviderErrorKind | null = null,
  ): Promise<void> => {
    if (settled) return;
    settled = true;
    await completeAndNotify(breaker, token, outcome, onOpen, onSettle, kind);
  };

  // A half-open probe settles only at stream end, but LLM streams routinely
  // outlive the lease; renew it on stream activity so the probe keeps its
  // generation and its eventual success closes the breaker (E4.1). Fire-and-
  // forget (never awaited) so it adds no token-path latency and cannot stall the
  // stream; throttled to ~once per third of the GRANTED lease (probe patience —
  // renewals extend by the granted duration, never the default) so a fast stream
  // doesn't issue one store op per token. The store's own expiry/generation
  // guards make a late-landing renewal a harmless no-op. `renewOnActivity` hands
  // the SAME throttled renewal to the byte-liveness path (fix-long-call-
  // timeouts): an event-quiet but byte-alive probe (keepalive comments) keeps
  // its single-probe lease instead of expiring it and admitting overlapping
  // probes.
  const renewOnActivity = makeRenewOnActivity(breaker, token, () => settled);
  const admission: BreakerAdmission = { isProbe: token.isProbe, renewOnActivity };

  let sawTerminalStop = false;
  let sawError = false;
  try {
    for await (const ev of gen(renewOnActivity, admission)) {
      if (ev.type === 'message_delta' && ev.stopReason !== undefined) sawTerminalStop = true;
      if (ev.type === 'error') {
        // Settle BEFORE yielding: a commit-gated consumer may `.return()` the
        // generator on seeing the error event, whose `finally` would otherwise
        // settle `neutral` first and let an overload/rate-limit escape untripped.
        sawError = true;
        // Read the adapter's CARRIED kind first (fix-4xx-error-taxonomy) and settle
        // through the shared rule, so a `code`-only marker reaches the breaker with
        // the same kind the chain walk sees — and so a neutral-settling kind stays
        // neutral here instead of being flattened into a health success.
        const evKind = ev.diagnostic?.kind ?? classifyStreamError(ev.error.type);
        await settle(outcomeForKind(evKind), evKind);
      }
      renewOnActivity();
      yield ev;
    }
    if (!sawError) {
      // no terminal stop → truncated (an untyped trip: `unavailable`)
      await (sawTerminalStop ? settle('success', null) : settle('trip', 'unavailable'));
    }
  } catch (err) {
    // Neutrality is authoritative from the caller-abort predicate when supplied:
    // only a genuine client-gone teardown is neutral (invariant, commit 8abd4b6).
    // A system-imposed cancellation (a first/inter-event timeout while the client
    // is still present) is a tripping failure — settle it explicitly rather than
    // via outcomeForError, whose `CallCancelledError → neutral` branch would
    // re-neutralize it (E1.3). With no predicate, keep the prior cancellation-is-
    // neutral behavior.
    const callerGone = isCallerAbort !== undefined ? isCallerAbort() : isCancellation(err);
    if (callerGone) {
      await settle('neutral', kindOf(err));
    } else if (isCancellation(err)) {
      await settle('trip', 'unavailable');
    } else {
      await settle(outcomeForError(err), kindOf(err));
    }
    throw err;
  } finally {
    // Consumer abandoned the generator (early break / .return()) → neutral.
    await settle('neutral');
  }
}
