/**
 * The plan cooldown store (classify-plan-quota-errors, design D6/D6a). A provider whose plan
 * is exhausted, throttled or inactive is PAUSED until its reset, so the router stops probing
 * a window that cannot answer. One record per provider, `pcd:<providerId>`, holding only
 * `{ kind, until, source }`: never a credential, message text or request content.
 *
 *  - The end is computed on the REDIS SERVER clock inside one Lua script, never from a caller
 *    clock, so instance clock skew cannot move it. A delta-seconds `Retry-After` is passed as a
 *    relative duration and added to the server clock there.
 *  - Writes are extend-only: a pause is never shortened, and its kind changes only with a
 *    later end.
 *  - The key carries `PXAT until`, so expiry ends the pause with no write.
 *  - Every operation is a script through `eval` (the `BreakerRedis` surface), so the bounded
 *    wrapper that races `eval` covers all of them and no raw client call can sit in an offline
 *    queue on the pre-admission hot path.
 *  - `FailoverPlanCooldownStore` is the ONLY place that degrades: a store fault is metered
 *    once and the operation is served from a per-instance record.
 */
import type { BreakerRedis } from './breaker';
import type { PlanWindow } from './plan-errors';

/** The three kinds that pause a provider. `plan_entitlement` is per-model and never pauses. */
export const PLAN_COOLDOWN_KINDS = ['quota_exhausted', 'risk_control', 'plan_inactive'] as const;
export type PlanCooldownKind = (typeof PLAN_COOLDOWN_KINDS)[number];

export function isPlanCooldownKind(kind: string): kind is PlanCooldownKind {
  return (PLAN_COOLDOWN_KINDS as readonly string[]).includes(kind);
}

export type PlanCooldownSource = 'provider' | 'default';

export interface PlanCooldown {
  readonly kind: PlanCooldownKind;
  /** Epoch ms on the store's (Redis server) clock. */
  readonly until: number;
  /** `provider` when the end came from a stated reset, `default` when polyrouter chose it. */
  readonly source: PlanCooldownSource;
}

export interface PlanCooldownConfig {
  /** A past or zero reset must not become a hot loop: the end is at least this far ahead. */
  readonly minMs: number;
  /** A malformed or hostile timestamp can pause a provider for at most this long. */
  readonly maxMs: number;
  /** The pause when no reset is stated (design D4). */
  readonly quotaShortMs: number;
  readonly quotaLongMs: number;
  readonly riskControlMs: number;
  readonly planInactiveMs: number;
}

export const DEFAULT_PLAN_COOLDOWN_CONFIG: PlanCooldownConfig = {
  minMs: 60_000,
  maxMs: 7 * 24 * 60 * 60 * 1000,
  quotaShortMs: 15 * 60_000,
  quotaLongMs: 60 * 60_000,
  riskControlMs: 30 * 60_000,
  planInactiveMs: 60 * 60_000,
};

/** The default pause for a kind (and window, for a quota) when the provider states no reset. */
export function planDefaultMs(
  kind: PlanCooldownKind,
  window: PlanWindow | undefined,
  cfg: PlanCooldownConfig = DEFAULT_PLAN_COOLDOWN_CONFIG,
): number {
  switch (kind) {
    case 'quota_exhausted':
      return window === 'long' ? cfg.quotaLongMs : cfg.quotaShortMs;
    case 'risk_control':
      return cfg.riskControlMs;
    case 'plan_inactive':
      return cfg.planInactiveMs;
  }
}

/** How a pause end is derived. `abs` is an absolute reset instant, `rel` a relative
 * `Retry-After` duration, `default` the kind's own duration. */
export type PlanCooldownInput = { readonly kind: PlanCooldownKind } & (
  { readonly abs: number } | { readonly rel: number } | { readonly default: number }
);

function inputMode(input: PlanCooldownInput): { mode: 'abs' | 'rel' | 'default'; value: number } {
  if ('abs' in input) return { mode: 'abs', value: input.abs };
  if ('rel' in input) return { mode: 'rel', value: input.rel };
  return { mode: 'default', value: input.default };
}

/** Reject what could never be a valid pause before ANY store sees it (a NaN would otherwise
 * reach Lua as a script error). Callers that must not throw catch this. */
function assertValid(input: PlanCooldownInput): void {
  if (!isPlanCooldownKind(input.kind)) throw new RangeError('plan cooldown: not a pausing kind');
  const { mode, value } = inputMode(input);
  if (!Number.isFinite(value)) throw new RangeError('plan cooldown: non-finite input');
  if (mode === 'default' && value <= 0) throw new RangeError('plan cooldown: default must be > 0');
}

/**
 * The pure end maths, the semantic source of truth the Lua script mirrors:
 *  - `abs`:     min(max(abs, now + minMs), now + maxMs)
 *  - `rel`:     min(max(now + rel, now + minMs), now + maxMs)
 *  - `default`: now + default
 * `abs` and `rel` are provider-stated; `default` is polyrouter's own.
 */
export function computeUntil(
  now: number,
  input: PlanCooldownInput,
  cfg: PlanCooldownConfig = DEFAULT_PLAN_COOLDOWN_CONFIG,
): { until: number; source: PlanCooldownSource } {
  assertValid(input);
  const { mode, value } = inputMode(input);
  if (mode === 'default') return { until: Math.floor(now + value), source: 'default' };
  const raw = mode === 'abs' ? value : now + value;
  const until = Math.min(Math.max(raw, now + cfg.minMs), now + cfg.maxMs);
  return { until: Math.floor(until), source: 'provider' };
}

export interface PlanCooldownStore {
  /** The active pause for a provider, or null. */
  check(providerId: string): Promise<PlanCooldown | null>;
  /** Every requested id mapped to its pause or null, in one round trip. */
  checkMany(providerIds: readonly string[]): Promise<ReadonlyMap<string, PlanCooldown | null>>;
  /** Record a pause; extend-only. Resolves to the effective record. */
  record(providerId: string, input: PlanCooldownInput): Promise<PlanCooldown>;
  /** Delete the pause (idempotent). */
  lift(providerId: string): Promise<void>;
}

/** Validate a stored/returned record; anything malformed reads as no pause. */
function parseRecord(raw: unknown): PlanCooldown | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof v['kind'] === 'string' &&
      isPlanCooldownKind(v['kind']) &&
      typeof v['until'] === 'number' &&
      Number.isFinite(v['until']) &&
      (v['source'] === 'provider' || v['source'] === 'default')
    ) {
      return { kind: v['kind'], until: v['until'], source: v['source'] };
    }
  } catch {
    /* a corrupt value reads as no pause */
  }
  return null;
}

/** Per-instance store: the failover's fallback, and in tests the "one simulated Redis". */
export class InMemoryPlanCooldownStore implements PlanCooldownStore {
  private readonly records = new Map<string, PlanCooldown>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly cfg: PlanCooldownConfig = DEFAULT_PLAN_COOLDOWN_CONFIG,
  ) {}

  private live(providerId: string): PlanCooldown | null {
    const rec = this.records.get(providerId);
    if (rec === undefined) return null;
    if (rec.until <= this.now()) {
      this.records.delete(providerId); // expiry ends the pause with no write by a caller
      return null;
    }
    return rec;
  }

  check(providerId: string): Promise<PlanCooldown | null> {
    return Promise.resolve(this.live(providerId));
  }

  checkMany(providerIds: readonly string[]): Promise<ReadonlyMap<string, PlanCooldown | null>> {
    return Promise.resolve(new Map(providerIds.map((id) => [id, this.live(id)] as const)));
  }

  record(providerId: string, input: PlanCooldownInput): Promise<PlanCooldown> {
    try {
      const { until, source } = computeUntil(this.now(), input, this.cfg);
      const cur = this.live(providerId);
      if (cur !== null && until <= cur.until) return Promise.resolve(cur);
      const next: PlanCooldown = { kind: input.kind, until, source };
      this.records.set(providerId, next);
      return Promise.resolve(next);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  lift(providerId: string): Promise<void> {
    this.records.delete(providerId);
    return Promise.resolve();
  }
}

// `now` is the Redis SERVER clock, read inside the script (as the breaker's scripts do), so
// the end never depends on a caller's wall clock. Redis 7 replicates script effects, so a
// TIME read in a writing script is allowed. `until` is a Lua keyword, hence `untilMs`.
const NOW_FROM_SERVER = `local st=redis.call('TIME'); local now=tonumber(st[1])*1000+math.floor(tonumber(st[2])/1000)`;

const RECORD_LUA = `
${NOW_FROM_SERVER}
local mode=ARGV[1]; local v=tonumber(ARGV[2]); local kind=ARGV[3]
local minMs=tonumber(ARGV[4]); local maxMs=tonumber(ARGV[5])
local untilMs; local source='provider'
if mode=='abs' then untilMs=v
elseif mode=='rel' then untilMs=now+v
else untilMs=now+v; source='default' end
if mode~='default' then
  untilMs=math.max(untilMs, now+minMs)
  untilMs=math.min(untilMs, now+maxMs)
end
untilMs=math.floor(untilMs)
local cur=redis.call('GET',KEYS[1])
if cur then
  local ok,rec=pcall(cjson.decode,cur)
  if ok and type(rec)=='table' and type(rec['until'])=='number' and rec['until']>=untilMs then return cur end
end
local val=string.format('{"kind":"%s","until":%.0f,"source":"%s"}',kind,untilMs,source)
redis.call('SET',KEYS[1],val,'PXAT',string.format('%.0f',untilMs))
return val
`;

const CHECK_LUA = `return redis.call('GET',KEYS[1])`;
const CHECK_MANY_LUA = `return redis.call('MGET',unpack(KEYS))`;
const LIFT_LUA = `redis.call('DEL',KEYS[1]); return 1`;

/** MGET keys per script call (Lua `unpack` has a stack bound). */
const CHECK_MANY_CHUNK = 500;

export class RedisPlanCooldownStore implements PlanCooldownStore {
  constructor(
    private readonly redis: BreakerRedis,
    private readonly prefix = 'pcd:',
    private readonly cfg: PlanCooldownConfig = DEFAULT_PLAN_COOLDOWN_CONFIG,
  ) {}

  private key(providerId: string): string {
    return `${this.prefix}${providerId}`;
  }

  async check(providerId: string): Promise<PlanCooldown | null> {
    return parseRecord(await this.redis.eval(CHECK_LUA, 1, this.key(providerId)));
  }

  async checkMany(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlanCooldown | null>> {
    const out = new Map<string, PlanCooldown | null>();
    const ids = [...new Set(providerIds)];
    for (let i = 0; i < ids.length; i += CHECK_MANY_CHUNK) {
      const chunk = ids.slice(i, i + CHECK_MANY_CHUNK);
      const raw = await this.redis.eval(
        CHECK_MANY_LUA,
        chunk.length,
        ...chunk.map((id) => this.key(id)),
      );
      const rows = Array.isArray(raw) ? (raw as unknown[]) : [];
      chunk.forEach((id, idx) => out.set(id, parseRecord(rows[idx])));
    }
    return out;
  }

  async record(providerId: string, input: PlanCooldownInput): Promise<PlanCooldown> {
    assertValid(input);
    const { mode, value } = inputMode(input);
    const raw = await this.redis.eval(
      RECORD_LUA,
      1,
      this.key(providerId),
      mode,
      String(value),
      input.kind,
      this.cfg.minMs,
      this.cfg.maxMs,
    );
    const rec = parseRecord(raw);
    if (rec === null) throw new Error('plan cooldown: store returned no record');
    return rec;
  }

  async lift(providerId: string): Promise<void> {
    await this.redis.eval(LIFT_LUA, 1, this.key(providerId));
  }
}

/**
 * The composite that owns degradation (design D6a). Each operation tries the primary; on a
 * throw or timeout it calls `onError` ONCE and serves from the fallback. `lift` always clears
 * the fallback, and then rethrows if the primary failed, so a caller can never report a lift
 * of the shared pause that did not happen.
 */
export class FailoverPlanCooldownStore implements PlanCooldownStore {
  constructor(
    private readonly primary: PlanCooldownStore,
    private readonly fallback: PlanCooldownStore,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  private report(err: unknown): void {
    try {
      this.onError(err);
    } catch {
      /* a throwing meter must never break the call path */
    }
  }

  async check(providerId: string): Promise<PlanCooldown | null> {
    try {
      return await this.primary.check(providerId);
    } catch (err) {
      this.report(err);
      return this.fallback.check(providerId);
    }
  }

  async checkMany(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlanCooldown | null>> {
    try {
      return await this.primary.checkMany(providerIds);
    } catch (err) {
      this.report(err);
      return this.fallback.checkMany(providerIds);
    }
  }

  async record(providerId: string, input: PlanCooldownInput): Promise<PlanCooldown> {
    assertValid(input); // a malformed input is a caller bug, not a store fault: never metered
    try {
      return await this.primary.record(providerId, input);
    } catch (err) {
      this.report(err);
      return this.fallback.record(providerId, input);
    }
  }

  async lift(providerId: string): Promise<void> {
    let failure: { err: unknown } | null = null;
    try {
      await this.primary.lift(providerId);
    } catch (err) {
      this.report(err);
      failure = { err };
    }
    await this.fallback.lift(providerId);
    if (failure !== null) throw failure.err;
  }
}
