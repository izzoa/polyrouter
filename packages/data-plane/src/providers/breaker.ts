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

export interface Admission {
  readonly decision: BreakerDecision;
  readonly generation: number;
  readonly isProbe: boolean;
}

export interface BreakerStore {
  decide(providerId: string, now: number, cfg: BreakerConfig): Promise<Admission>;
  complete(
    providerId: string,
    generation: number,
    outcome: BreakerOutcome,
    now: number,
    cfg: BreakerConfig,
  ): Promise<void>;
}

/** In-memory store: the read-compute-write is synchronous (single-threaded JS),
 * so it is atomic. Two breakers sharing one instance = two instances, one store. */
export class InMemoryBreakerStore implements BreakerStore {
  private readonly records = new Map<string, BreakerRecord>();

  decide(providerId: string, now: number, cfg: BreakerConfig): Promise<Admission> {
    const rec = this.records.get(providerId) ?? INITIAL_RECORD;
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
  ): Promise<void> {
    const rec = this.records.get(providerId) ?? INITIAL_RECORD;
    this.records.set(providerId, applyComplete(rec, generation, outcome, now, cfg));
    return Promise.resolve();
  }
}

/** The subset of ioredis used by the Redis store (structurally satisfied by an
 * ioredis `Redis`). Keeps the breaker decoupled from a concrete client. */
export interface BreakerRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const DECIDE_LUA = `
local now=tonumber(ARGV[1]); local cooldown=tonumber(ARGV[2]); local lease=tonumber(ARGV[3]); local ttl=tonumber(ARGV[4])
local h=redis.call('HMGET',KEYS[1],'state','failures','openedAt','generation','probeExpiresAt')
local state=h[1] or 'closed'
local failures=tonumber(h[2] or '0'); local openedAt=tonumber(h[3] or '0'); local generation=tonumber(h[4] or '0'); local probeExp=tonumber(h[5] or '0')
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
local now=tonumber(ARGV[1]); local tokenGen=tonumber(ARGV[2]); local outcome=ARGV[3]; local threshold=tonumber(ARGV[4]); local ttl=tonumber(ARGV[5])
local h=redis.call('HMGET',KEYS[1],'state','failures','openedAt','generation','probeExpiresAt')
local state=h[1] or 'closed'
local failures=tonumber(h[2] or '0'); local openedAt=tonumber(h[3] or '0'); local generation=tonumber(h[4] or '0'); local probeExp=tonumber(h[5] or '0')
if tokenGen~=generation then return 0 end
if outcome=='neutral' then return 0 end
if outcome=='success' then
  if state=='half_open' then state='closed'; failures=0; openedAt=0; generation=generation+1; probeExp=0
  elseif state=='closed' then failures=0 end
else
  if state=='half_open' then state='open'; failures=0; openedAt=now; generation=generation+1; probeExp=0
  elseif state=='closed' then failures=failures+1; if failures>=threshold then state='open'; failures=0; openedAt=now; generation=generation+1; probeExp=0 end end
end
redis.call('HMSET',KEYS[1],'state',state,'failures',failures,'openedAt',openedAt,'generation',generation,'probeExpiresAt',probeExp)
redis.call('PEXPIRE',KEYS[1],ttl)
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

  async decide(providerId: string, now: number, cfg: BreakerConfig): Promise<Admission> {
    const res = (await this.redis.eval(
      DECIDE_LUA,
      1,
      this.key(providerId),
      now,
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
    now: number,
    cfg: BreakerConfig,
  ): Promise<void> {
    await this.redis.eval(
      COMPLETE_LUA,
      1,
      this.key(providerId),
      now,
      generation,
      outcome,
      cfg.threshold,
      cfg.stateTtlMs,
    );
  }
}

export interface BreakerToken {
  readonly providerId: string;
  readonly store: BreakerStore;
  readonly generation: number;
  readonly isProbe: boolean;
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

  async before(providerId: string): Promise<{ decision: BreakerDecision; token: BreakerToken }> {
    const now = this.now();
    try {
      const a = await this.primary.decide(providerId, now, this.cfg);
      return {
        decision: a.decision,
        token: { providerId, store: this.primary, generation: a.generation, isProbe: a.isProbe },
      };
    } catch (err) {
      this.onError(err);
      const a = await this.fallback.decide(providerId, now, this.cfg);
      return {
        decision: a.decision,
        token: { providerId, store: this.fallback, generation: a.generation, isProbe: a.isProbe },
      };
    }
  }

  /** Store-affine: the completion goes to whichever store admitted the call. */
  async complete(token: BreakerToken, outcome: BreakerOutcome): Promise<void> {
    try {
      await token.store.complete(token.providerId, token.generation, outcome, this.now(), this.cfg);
    } catch (err) {
      this.onError(err);
    }
  }
}

function outcomeForError(err: unknown): BreakerOutcome {
  if (err instanceof CallCancelledError) return 'neutral';
  if (err instanceof ProviderError) return breakerImpact(err.kind) ? 'trip' : 'success';
  return 'trip';
}

function isCancellation(err: unknown): boolean {
  return err instanceof CallCancelledError || (err instanceof Error && err.name === 'AbortError');
}

/** Wrap a unary provider call. Health = "did the provider respond": a resolved
 * call or a non-tripping error is success; a tripping error trips; a caller
 * cancellation is neutral. */
export async function withBreaker<T>(
  breaker: CircuitBreaker,
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { decision, token } = await breaker.before(providerId);
  if (decision === 'skip') throw new ProviderCircuitOpenError(providerId);
  try {
    const result = await fn();
    await breaker.complete(token, 'success');
    return result;
  } catch (err) {
    await breaker.complete(token, outcomeForError(err));
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
  gen: () => AsyncGenerator<NormalizedStreamEvent>,
): AsyncGenerator<NormalizedStreamEvent> {
  const { decision, token } = await breaker.before(providerId);
  if (decision === 'skip') throw new ProviderCircuitOpenError(providerId);

  let settled = false;
  const settle = async (outcome: BreakerOutcome): Promise<void> => {
    if (settled) return;
    settled = true;
    await breaker.complete(token, outcome);
  };

  let sawTerminalStop = false;
  let streamErrorKind: ReturnType<typeof classifyStreamError> | undefined;
  try {
    for await (const ev of gen()) {
      if (ev.type === 'message_delta' && ev.stopReason !== undefined) sawTerminalStop = true;
      if (ev.type === 'error') streamErrorKind = classifyStreamError(ev.error.type);
      yield ev;
    }
    if (streamErrorKind !== undefined) {
      await settle(breakerImpact(streamErrorKind) ? 'trip' : 'success');
    } else {
      await settle(sawTerminalStop ? 'success' : 'trip'); // no terminal stop → truncated
    }
  } catch (err) {
    await settle(isCancellation(err) ? 'neutral' : outcomeForError(err));
    throw err;
  } finally {
    // Consumer abandoned the generator (early break / .return()) → neutral.
    await settle('neutral');
  }
}
