/**
 * The plan-usage snapshot store and its coalescing recorder (add-subscription-quota-display,
 * design D5/D6). One snapshot per provider holds the parsed usage windows and the billing state:
 * numbers and enums only, never a header or body string, a credential, an account id or any
 * personal data (invariant 8). It is DISPLAY data: nothing here routes, blocks or prices.
 *
 *  - Keys (provider ids are UUIDs, so a key never names another tenant's row): `pu:<id>` the
 *    snapshot JSON, `pur:<id>` the refresh cooldown, `pug:<id>` the snapshot GENERATION, a
 *    non-secret integer that only a clear raises.
 *  - Every instant is taken on the REDIS SERVER clock inside one Lua script (`TIME`), never from
 *    a caller clock, and every operation is a script through `BreakerRedis.eval`, so the bounded
 *    wrapper that races `eval` covers all of them (invariant 10).
 *  - The pure `mergeSnapshot` below is the semantic source of truth. `InMemoryPlanUsageStore`
 *    runs it directly; `MERGE_LUA` mirrors it line for line, and a real-Redis parity suite pins
 *    the two together.
 *  - `FailoverPlanUsageStore` is the ONLY place that degrades. A store fault is metered once and
 *    the operation is served from a per-instance record, EXCEPT the refresh claim and extension,
 *    which throw so the endpoint answers 503: a per-instance cooldown would let N instances send
 *    N reads, the burst the shared cooldown exists to prevent.
 *  - `PlanUsageRecorder` sits in front on the hot path. `offer` is synchronous and never throws,
 *    and a request that changes nothing makes no store call (invariant 9).
 */
import type { BreakerRedis } from './breaker';
import {
  RESET_SLACK_MS,
  windowLengthMs,
  type PlanUsageBilling,
  type PlanUsageObservation,
  type PlanUsageSpan,
  type PlanUsageWindow,
} from './plan-usage';

// ---------------------------------------------------------------------------------------------
// Types and limits
// ---------------------------------------------------------------------------------------------

/** `traffic` merges per window key; `refresh` is an authoritative read that replaces the windows. */
export type PlanUsageSource = 'traffic' | 'refresh';

export interface StoredPlanUsageWindow {
  readonly key: string;
  readonly group: 'account' | 'model';
  readonly span: PlanUsageSpan | null;
  readonly minutes: number | null;
  readonly scope: string | null;
  readonly usedPercent: number | null;
  /** Absolute epoch ms on the store clock, or null when the reset is unknown. */
  readonly resetMs: number | null;
  /** When THIS figure was observed, on the store clock. A window a later write did not carry
   * keeps its older time (design D5, per-figure times). */
  readonly observedAt: number;
  readonly source: PlanUsageSource;
}

export interface StoredPlanUsageBilling {
  readonly state: PlanUsageBilling;
  readonly observedAt: number;
}

export interface PlanUsageSnapshot {
  readonly windows: readonly StoredPlanUsageWindow[];
  readonly billing: StoredPlanUsageBilling | null;
}

export interface PlanUsageMergeResult {
  /** False only when the write carried a generation older than the store's: nothing was
   * written, and `gen` is the generation the caller should learn. */
  readonly applied: boolean;
  readonly gen: number;
}

export interface PlanUsageRefreshClaim {
  readonly claimed: boolean;
  /** Absolute end of the refresh cooldown on the store clock (a claim's own end when claimed). */
  readonly availableAt: number;
  /** The snapshot generation at the claim, read atomically with it. */
  readonly gen: number;
  /** The cooldown that remains, measured on the store clock (0 when none holds). A caller's
   * `Retry-After` comes from this, never from `availableAt - its own clock`, so clock skew
   * between an app instance and the store cannot shift it. */
  readonly retryAfterMs: number;
}

export interface PlanUsageRead {
  readonly snapshot: PlanUsageSnapshot | null;
  /** Absolute end of the refresh cooldown, or null when none holds (or it was not asked for). */
  readonly cooldownEndsAt: number | null;
}

export interface PlanUsageStore {
  /** Merge an observation made at generation `gen`. NEVER used to clear. */
  merge(
    providerId: string,
    obs: PlanUsageObservation,
    gen: number,
    source: PlanUsageSource,
  ): Promise<PlanUsageMergeResult>;
  /** The snapshots of `providerIds`, and the refresh cooldown of those also in `withCooldown`. */
  readMany(
    providerIds: readonly string[],
    withCooldown?: readonly string[],
  ): Promise<ReadonlyMap<string, PlanUsageRead>>;
  /** `SET pur NX` for the refresh cooldown, returning the generation atomically. */
  claimRefresh(providerId: string): Promise<PlanUsageRefreshClaim>;
  /** Extend-only: the cooldown becomes `clamp(retryAfterMs, 5 min, 1 h)` from now, never shorter. */
  extendRefresh(providerId: string, retryAfterMs: number): Promise<void>;
  /** Delete the snapshot and RAISE its generation. Never touches the refresh cooldown. Resolves
   * to the new generation. */
  clear(providerId: string): Promise<number>;
}

export const PLAN_USAGE_LIMITS = {
  maxWindows: 12,
  maxModelBuckets: 8,
  /** A window whose reset passed more than this long ago is pruned. */
  pruneAfterMs: 24 * 3_600_000,
  /** Resets within this of each other are "the same reset": the higher percent wins. */
  sameResetMs: 60_000,
  minTtlMs: 3_600_000,
  maxTtlMs: 32 * 86_400_000,
  /** The TTL of a snapshot with no dated reset. */
  undatedTtlMs: 24 * 3_600_000,
  /** The generation key outlives the snapshot it guards (at most 32 days). */
  generationTtlMs: 40 * 86_400_000,
  refreshCooldownMs: 5 * 60_000,
  refreshMinMs: 5 * 60_000,
  refreshMaxMs: 3_600_000,
} as const;

const KEY_PREFIX = { snapshot: 'pu:', cooldown: 'pur:', generation: 'pug:' } as const;

const SPANS: ReadonlySet<string> = new Set(['5h', 'daily', 'weekly', 'monthly', 'annual']);
const BILLINGS: ReadonlySet<string> = new Set(['plan', 'extra_usage', 'extra_usage_possible']);
const MAX_KEY_LEN = 96;
const MAX_SCOPE_LEN = 48;
const MAX_MINUTES = 366 * 24 * 60;

// ---------------------------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------------------------

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Validate and normalize an observation BEFORE any store sees it, so a hostile or malformed value
 * can never reach a Lua script as an error. Structural faults throw a `RangeError` (a caller bug,
 * never a store fault): more than 12 windows, a bad key or group, an unknown billing state. A
 * malformed numeric field drops alone (null), and a percent is clamped to 0-100.
 */
export function sanitizeObservation(obs: PlanUsageObservation): PlanUsageObservation {
  const rawWindows: unknown = obs.windows;
  if (!Array.isArray(rawWindows)) throw new RangeError('plan usage: windows must be a list');
  if (obs.windows.length > PLAN_USAGE_LIMITS.maxWindows) {
    throw new RangeError('plan usage: more than 12 windows in one observation');
  }
  if (obs.billing !== null && !BILLINGS.has(obs.billing)) {
    throw new RangeError('plan usage: unknown billing state');
  }
  const windows = obs.windows.map((w): PlanUsageWindow => {
    if (typeof w.key !== 'string' || w.key === '' || w.key.length > MAX_KEY_LEN) {
      throw new RangeError('plan usage: bad window key');
    }
    if (w.group !== 'account' && w.group !== 'model') {
      throw new RangeError('plan usage: bad window group');
    }
    const minutes = finiteOrNull(w.minutes);
    const percent = finiteOrNull(w.usedPercent);
    let reset: PlanUsageWindow['reset'] = null;
    if (w.reset !== null && w.reset !== undefined) {
      if ('atMs' in w.reset && Number.isFinite(w.reset.atMs)) {
        reset = { atMs: Math.round(w.reset.atMs) };
      } else if ('inMs' in w.reset && Number.isFinite(w.reset.inMs)) {
        reset = { inMs: Math.round(w.reset.inMs) };
      }
    }
    return {
      key: w.key,
      group: w.group,
      span: w.span !== null && SPANS.has(w.span) ? w.span : null,
      minutes:
        minutes !== null && Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_MINUTES
          ? minutes
          : null,
      scope:
        typeof w.scope === 'string' && w.scope !== '' && w.scope.length <= MAX_SCOPE_LEN
          ? w.scope
          : null,
      usedPercent: percent === null ? null : Math.min(100, Math.max(0, Math.round(percent))),
      reset,
    };
  });
  return { windows, billing: obs.billing };
}

function assertGeneration(gen: number): void {
  if (!Number.isInteger(gen) || gen < 0) throw new RangeError('plan usage: bad generation');
}

/** The wire form handed to `MERGE_LUA`: absent fields are omitted, never null. */
function wireOf(obs: PlanUsageObservation): string {
  return JSON.stringify({
    windows: obs.windows.map((w) => ({
      key: w.key,
      group: w.group,
      ...(w.span !== null ? { span: w.span } : {}),
      ...(w.minutes !== null ? { minutes: w.minutes } : {}),
      ...(w.scope !== null ? { scope: w.scope } : {}),
      ...(w.usedPercent !== null ? { usedPercent: w.usedPercent } : {}),
      ...(w.reset !== null && 'atMs' in w.reset ? { atMs: w.reset.atMs } : {}),
      ...(w.reset !== null && 'inMs' in w.reset ? { inMs: w.reset.inMs } : {}),
    })),
    ...(obs.billing !== null ? { billing: obs.billing } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// The pure merge (semantic source of truth; MERGE_LUA mirrors it)
// ---------------------------------------------------------------------------------------------

/** A reset on the store clock: an `{ inMs }` reset is anchored on `now`, and the D3 plausibility
 * bound is re-applied, so a seconds-for-milliseconds slip or a hostile value can never pin a
 * window for centuries. */
function resolveReset(w: PlanUsageWindow, now: number): number | null {
  let at: number | null = null;
  if (w.reset !== null) {
    if ('atMs' in w.reset) at = w.reset.atMs;
    else if (w.reset.inMs >= 0) at = now + w.reset.inMs;
  }
  if (at === null) return null;
  const length = windowLengthMs(w.span, w.minutes);
  return at >= now - RESET_SLACK_MS && at <= now + length + RESET_SLACK_MS ? at : null;
}

function storedFrom(
  w: PlanUsageWindow,
  resetMs: number | null,
  now: number,
  source: PlanUsageSource,
): StoredPlanUsageWindow {
  return {
    key: w.key,
    group: w.group,
    span: w.span,
    minutes: w.minutes,
    scope: w.scope,
    usedPercent: w.usedPercent,
    resetMs,
    observedAt: now,
    source,
  };
}

/** Later reset first (a null reset counts as earliest), then key ascending: a strict total order. */
function byLaterReset(a: StoredPlanUsageWindow, b: StoredPlanUsageWindow): number {
  const ar = a.resetMs ?? -1;
  const br = b.resetMs ?? -1;
  if (ar !== br) return br - ar;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Merge a sanitized observation into a snapshot at store-clock `now` (design D5 steps 3-8).
 * Returns the new snapshot, or null when it holds neither a window nor a billing state (the
 * record is then deleted).
 *
 * `traffic`, per window key: an absent or reset-passed stored window is replaced; a dated input
 * replaces an undated stored one; an undated input replaces only an undated one and never
 * displaces a dated, unexpired window; a reset more than 60 s later replaces; within 60 s the
 * higher percent wins; an earlier reset is a stale observation and is dropped. A replaced or
 * updated window takes `observedAt = now`.
 * `refresh`: the windows are replaced wholesale and billing is never touched.
 * Billing: a non-null state is taken only from an observation that carries no window, or that
 * applied at least one window and had none dropped as an earlier-reset (stale) one, so a delayed
 * pre-reset `extra_usage` never overwrites a post-reset `plan`, even when another of its windows
 * still shares the stored reset. A null billing keeps the stored state.
 * Bound: windows whose reset passed over 24 h ago are pruned; at most 8 model buckets and 12
 * windows are kept, the latest resets first.
 */
export function mergeSnapshot(
  prev: PlanUsageSnapshot | null,
  obs: PlanUsageObservation,
  source: PlanUsageSource,
  now: number,
): PlanUsageSnapshot | null {
  const byKey = new Map<string, StoredPlanUsageWindow>();
  for (const w of prev?.windows ?? []) byKey.set(w.key, w);
  let billing = prev?.billing ?? null;
  let applied = false;
  let stale = false;

  if (source === 'refresh') {
    byKey.clear();
    for (const w of obs.windows)
      byKey.set(w.key, storedFrom(w, resolveReset(w, now), now, 'refresh'));
    // A refresh never touches billing.
  } else {
    for (const w of obs.windows) {
      const reset = resolveReset(w, now);
      const stored = byKey.get(w.key);
      const storedReset = stored?.resetMs ?? null;
      if (stored === undefined || (storedReset !== null && storedReset <= now)) {
        byKey.set(w.key, storedFrom(w, reset, now, 'traffic'));
        applied = true;
      } else if (reset === null) {
        if (storedReset === null) {
          byKey.set(w.key, storedFrom(w, null, now, 'traffic'));
          applied = true;
        }
        // else: an undated input never displaces a dated, unexpired window (dropped).
      } else if (storedReset === null || reset > storedReset + PLAN_USAGE_LIMITS.sameResetMs) {
        byKey.set(w.key, storedFrom(w, reset, now, 'traffic'));
        applied = true;
      } else if (reset >= storedReset - PLAN_USAGE_LIMITS.sameResetMs) {
        // The same reset: keep the window, take the higher percent.
        const percent =
          stored.usedPercent === null
            ? w.usedPercent
            : w.usedPercent === null
              ? stored.usedPercent
              : Math.max(stored.usedPercent, w.usedPercent);
        byKey.set(w.key, { ...stored, usedPercent: percent, observedAt: now, source: 'traffic' });
        applied = true;
      } else {
        // An earlier reset is a stale observation: the window is dropped, and so is its billing.
        stale = true;
      }
    }
    if (obs.billing !== null && (obs.windows.length === 0 || (applied && !stale))) {
      billing = { state: obs.billing, observedAt: now };
    }
  }

  // Bound and prune.
  const live = [...byKey.values()]
    .filter((w) => !(w.resetMs !== null && w.resetMs < now - PLAN_USAGE_LIMITS.pruneAfterMs))
    .sort(byLaterReset);
  let modelCount = 0;
  const kept: StoredPlanUsageWindow[] = [];
  for (const w of live) {
    if (w.group === 'model') {
      if (modelCount >= PLAN_USAGE_LIMITS.maxModelBuckets) continue;
      modelCount += 1;
    }
    kept.push(w);
  }
  const windows = kept
    .slice(0, PLAN_USAGE_LIMITS.maxWindows)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (windows.length === 0 && billing === null) return null;
  return { windows, billing };
}

/** The record's expiry: the latest dated reset plus 1 h, clamped to [now + 1 h, now + 32 d], or
 * now + 24 h when no window has a dated reset. */
export function snapshotExpiresAt(snapshot: PlanUsageSnapshot, now: number): number {
  let latest: number | null = null;
  for (const w of snapshot.windows) {
    if (w.resetMs !== null && (latest === null || w.resetMs > latest)) latest = w.resetMs;
  }
  if (latest === null) return now + PLAN_USAGE_LIMITS.undatedTtlMs;
  return Math.min(
    Math.max(latest + 3_600_000, now + PLAN_USAGE_LIMITS.minTtlMs),
    now + PLAN_USAGE_LIMITS.maxTtlMs,
  );
}

function clampRefreshMs(retryAfterMs: number): number {
  return Math.min(
    Math.max(retryAfterMs, PLAN_USAGE_LIMITS.refreshMinMs),
    PLAN_USAGE_LIMITS.refreshMaxMs,
  );
}

/** A stored or returned snapshot, validated field by field; anything malformed reads as none. */
export function parseSnapshot(raw: unknown): PlanUsageSnapshot | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    // An empty Lua table encodes as `{}`: tolerate a non-array `windows` as no windows.
    const rawWindows = Array.isArray(v['windows']) ? (v['windows'] as unknown[]) : [];
    const windows: StoredPlanUsageWindow[] = [];
    for (const item of rawWindows) {
      if (typeof item !== 'object' || item === null) continue;
      const w = item as Record<string, unknown>;
      const key = w['key'];
      const group = w['group'];
      const observedAt = finiteOrNull(w['observedAt']);
      const source = w['source'];
      if (typeof key !== 'string' || (group !== 'account' && group !== 'model')) continue;
      if (observedAt === null || (source !== 'traffic' && source !== 'refresh')) continue;
      const span = w['span'];
      const scope = w['scope'];
      windows.push({
        key,
        group,
        span: typeof span === 'string' && SPANS.has(span) ? (span as PlanUsageSpan) : null,
        minutes: finiteOrNull(w['minutes']),
        scope: typeof scope === 'string' ? scope : null,
        usedPercent: finiteOrNull(w['usedPercent']),
        resetMs: finiteOrNull(w['resetMs']),
        observedAt,
        source,
      });
    }
    let billing: StoredPlanUsageBilling | null = null;
    const b = v['billing'];
    if (typeof b === 'object' && b !== null) {
      const state = (b as Record<string, unknown>)['state'];
      const at = finiteOrNull((b as Record<string, unknown>)['observedAt']);
      if (typeof state === 'string' && BILLINGS.has(state) && at !== null) {
        billing = { state: state as PlanUsageBilling, observedAt: at };
      }
    }
    if (windows.length === 0 && billing === null) return null;
    return { windows, billing };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// In-memory store (the failover's fallback; mirrors the Lua)
// ---------------------------------------------------------------------------------------------

interface MemoryRecord {
  snapshot: PlanUsageSnapshot;
  expiresAt: number;
}

const MEMORY_SWEEP_AT = 1_000;

export class InMemoryPlanUsageStore implements PlanUsageStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly generations = new Map<string, number>();
  private readonly cooldownEnds = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(providerId: string): MemoryRecord | null {
    const rec = this.records.get(providerId);
    if (rec === undefined) return null;
    if (rec.expiresAt <= this.now()) {
      this.records.delete(providerId);
      return null;
    }
    return rec;
  }

  private sweep(): void {
    if (this.records.size < MEMORY_SWEEP_AT) return;
    for (const id of [...this.records.keys()]) this.live(id);
    const t = this.now();
    for (const [id, end] of this.cooldownEnds) if (end <= t) this.cooldownEnds.delete(id);
  }

  /** The generation (test and failover visibility). */
  generation(providerId: string): number {
    return this.generations.get(providerId) ?? 0;
  }

  /** The record's expiry on this store's clock, or null (test visibility of the TTL bounds). */
  expiresAt(providerId: string): number | null {
    return this.live(providerId)?.expiresAt ?? null;
  }

  merge(
    providerId: string,
    obs: PlanUsageObservation,
    gen: number,
    source: PlanUsageSource,
  ): Promise<PlanUsageMergeResult> {
    try {
      assertGeneration(gen);
      const clean = sanitizeObservation(obs);
      const current = this.generation(providerId);
      if (gen < current) return Promise.resolve({ applied: false, gen: current });
      if (gen > current) this.generations.set(providerId, gen);
      const now = this.now();
      const next = mergeSnapshot(this.live(providerId)?.snapshot ?? null, clean, source, now);
      if (next === null) this.records.delete(providerId);
      else
        this.records.set(providerId, { snapshot: next, expiresAt: snapshotExpiresAt(next, now) });
      this.sweep();
      return Promise.resolve({ applied: true, gen: this.generation(providerId) });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  readMany(
    providerIds: readonly string[],
    withCooldown: readonly string[] = [],
  ): Promise<ReadonlyMap<string, PlanUsageRead>> {
    const cooldown = new Set(withCooldown);
    const t = this.now();
    const out = new Map<string, PlanUsageRead>();
    for (const id of providerIds) {
      const end = cooldown.has(id) ? (this.cooldownEnds.get(id) ?? 0) : 0;
      out.set(id, {
        snapshot: this.live(id)?.snapshot ?? null,
        cooldownEndsAt: end > t ? end : null,
      });
    }
    return Promise.resolve(out);
  }

  claimRefresh(providerId: string): Promise<PlanUsageRefreshClaim> {
    const t = this.now();
    const gen = this.generation(providerId);
    const end = this.cooldownEnds.get(providerId) ?? 0;
    if (end > t) {
      return Promise.resolve({ claimed: false, availableAt: end, gen, retryAfterMs: end - t });
    }
    const next = t + PLAN_USAGE_LIMITS.refreshCooldownMs;
    this.cooldownEnds.set(providerId, next);
    return Promise.resolve({
      claimed: true,
      availableAt: next,
      gen,
      retryAfterMs: PLAN_USAGE_LIMITS.refreshCooldownMs,
    });
  }

  extendRefresh(providerId: string, retryAfterMs: number): Promise<void> {
    if (!Number.isFinite(retryAfterMs)) {
      return Promise.reject(new RangeError('plan usage: non-finite retry-after'));
    }
    const t = this.now();
    const target = t + clampRefreshMs(retryAfterMs);
    const end = this.cooldownEnds.get(providerId) ?? 0;
    if (end < target) this.cooldownEnds.set(providerId, target);
    return Promise.resolve();
  }

  clear(providerId: string): Promise<number> {
    this.records.delete(providerId);
    // One above the higher of its own and the last one it saw (a higher write raises its own).
    const gen = this.generation(providerId) + 1;
    this.generations.set(providerId, gen);
    return Promise.resolve(gen);
  }
}

// ---------------------------------------------------------------------------------------------
// Redis store
// ---------------------------------------------------------------------------------------------

// `now` is the Redis SERVER clock, read inside the script (as the breaker's and the plan
// cooldown's scripts do), so no caller clock can move an instant. Redis 7 replicates script
// effects, so a TIME read in a writing script is allowed.
const NOW_FROM_SERVER = `local st=redis.call('TIME'); local now=tonumber(st[1])*1000+math.floor(tonumber(st[2])/1000)`;

/**
 * KEYS: pu, pug. ARGV: observation JSON, generation, source ('traffic' | 'refresh'). Mirrors
 * `mergeSnapshot` and the generation barrier (design D5, steps 1-9). Returns `{applied, gen}`.
 * Every comparison guards nulls explicitly: an absent field is simply `nil` and is never
 * compared, so no `nil` comparison can raise inside the script. The 14-digit precision of
 * `cjson.encode` holds every instant here (13-digit epoch ms).
 */
export const MERGE_LUA = `
${NOW_FROM_SERVER}
local MAXW=12; local MAXM=8
local SAMEMS=60000; local PRUNEMS=86400000; local SLACK=600000
local MINTTL=3600000; local MAXTTL=2764800000; local UNDATEDTTL=86400000
local GENTTL=3456000000
local SPAN={['5h']=300,daily=1440,weekly=10080,monthly=44640,annual=527040}
local genRaw=redis.call('GET',KEYS[2]); local curGen=0
if genRaw then curGen=tonumber(genRaw) or 0 end
local inGen=tonumber(ARGV[2]) or 0
if inGen<curGen then return {0,curGen} end
if inGen>curGen then
  redis.call('SET',KEYS[2],string.format('%.0f',inGen),'PX',GENTTL); curGen=inGen
end
local okI,input=pcall(cjson.decode,ARGV[1])
if not okI or type(input)~='table' then return {0,curGen} end
local inWins=input.windows
if type(inWins)~='table' then inWins={} end
if #inWins>MAXW then return {0,curGen} end
local function winLen(w)
  if w.minutes then return w.minutes*60000 end
  if w.span and SPAN[w.span] then return SPAN[w.span]*60000 end
  return 400*86400000
end
local function resolveReset(w)
  local r=nil
  if w.atMs then r=w.atMs
  elseif w.inMs then if w.inMs>=0 then r=now+w.inMs end end
  if r==nil then return nil end
  if r<now-SLACK or r>now+winLen(w)+SLACK then return nil end
  return r
end
local function fresh(w,r,src)
  return {key=w.key,group=w.group,span=w.span,minutes=w.minutes,scope=w.scope,usedPercent=w.usedPercent,resetMs=r,observedAt=now,source=src}
end
local stored={}
local raw=redis.call('GET',KEYS[1])
if raw then
  local okS,rec=pcall(cjson.decode,raw)
  if okS and type(rec)=='table' then stored=rec end
end
local byKey={}
if type(stored.windows)=='table' then
  for _,w in ipairs(stored.windows) do
    if type(w)=='table' and type(w.key)=='string' then byKey[w.key]=w end
  end
end
local billing=nil
if type(stored.billing)=='table' and type(stored.billing.state)=='string' then billing=stored.billing end
local source=ARGV[3]
local applied=false
local stale=false
if source=='refresh' then
  byKey={}
  for _,iw in ipairs(inWins) do byKey[iw.key]=fresh(iw,resolveReset(iw),'refresh') end
else
  for _,iw in ipairs(inWins) do
    local r=resolveReset(iw)
    local s=byKey[iw.key]
    local sr=nil
    if s then sr=s.resetMs end
    if s==nil or (sr~=nil and sr<=now) then
      byKey[iw.key]=fresh(iw,r,'traffic'); applied=true
    elseif r==nil then
      if sr==nil then byKey[iw.key]=fresh(iw,nil,'traffic'); applied=true end
    elseif sr==nil or r>sr+SAMEMS then
      byKey[iw.key]=fresh(iw,r,'traffic'); applied=true
    elseif r>=sr-SAMEMS then
      local p=s.usedPercent; local q=iw.usedPercent; local m
      if p==nil then m=q elseif q==nil then m=p else m=math.max(p,q) end
      s.usedPercent=m; s.observedAt=now; s.source='traffic'; applied=true
    else
      stale=true
    end
  end
  if input.billing and (#inWins==0 or (applied and not stale)) then
    billing={state=input.billing,observedAt=now}
  end
end
local list={}
for _,w in pairs(byKey) do
  if not (w.resetMs and w.resetMs<now-PRUNEMS) then list[#list+1]=w end
end
table.sort(list,function(a,b)
  local ar=a.resetMs or -1; local br=b.resetMs or -1
  if ar~=br then return ar>br end
  return a.key<b.key
end)
local kept={}; local modelN=0
for _,w in ipairs(list) do
  if w.group=='model' then
    if modelN<MAXM then modelN=modelN+1; kept[#kept+1]=w end
  else kept[#kept+1]=w end
end
local final={}
for i=1,math.min(#kept,MAXW) do final[#final+1]=kept[i] end
table.sort(final,function(a,b) return a.key<b.key end)
if curGen>0 then redis.call('PEXPIRE',KEYS[2],GENTTL) end
if #final==0 and billing==nil then redis.call('DEL',KEYS[1]); return {1,curGen} end
local latest=nil
for _,w in ipairs(final) do
  if w.resetMs and (latest==nil or w.resetMs>latest) then latest=w.resetMs end
end
local exp
if latest==nil then exp=now+UNDATEDTTL
else exp=math.min(math.max(latest+3600000,now+MINTTL),now+MAXTTL) end
redis.call('SET',KEYS[1],cjson.encode({windows=final,billing=billing}),'PXAT',string.format('%.0f',exp))
return {1,curGen}
`;

/**
 * KEYS: the chunk's pu keys, then the pur keys of the rows that have a probe. ARGV[1] is the
 * number of pu keys. Returns `{ snapshots, cooldownEnds }`: one `MGET` over the pu keys, and for
 * each pur key its absolute end on the server clock (0 when none holds).
 */
export const READ_MANY_LUA = `
${NOW_FROM_SERVER}
local n=tonumber(ARGV[1])
local pu={}
for i=1,n do pu[i]=KEYS[i] end
local snaps=redis.call('MGET',unpack(pu))
local ends={}
for i=n+1,#KEYS do
  local p=redis.call('PTTL',KEYS[i])
  if p>0 then ends[#ends+1]=now+p else ends[#ends+1]=0 end
end
return {snaps,ends}
`;

/** KEYS: pur, pug. ARGV[1]: the cooldown in ms. `SET NX`, with the generation read atomically. */
export const CLAIM_REFRESH_LUA = `
${NOW_FROM_SERVER}
local ms=tonumber(ARGV[1])
local g=redis.call('GET',KEYS[2]); local gen=0
if g then gen=tonumber(g) or 0 end
local ok=redis.call('SET',KEYS[1],'1','PX',string.format('%.0f',ms),'NX')
if ok then return {1,now+ms,gen,ms} end
local p=redis.call('PTTL',KEYS[1])
if p>0 then return {0,now+p,gen,p} end
return {0,now,gen,0}
`;

/** KEYS: pur. ARGV: retry-after ms, min ms, max ms. Extend-only, from the server clock. */
export const EXTEND_REFRESH_LUA = `
${NOW_FROM_SERVER}
local target=math.min(math.max(tonumber(ARGV[1]),tonumber(ARGV[2])),tonumber(ARGV[3]))
local p=redis.call('PTTL',KEYS[1])
if p<0 or p<target then redis.call('SET',KEYS[1],'1','PX',string.format('%.0f',target)) end
return now+target
`;

/** KEYS: pu, pug. Delete the snapshot and raise the generation; never touch the cooldown. */
export const CLEAR_LUA = `
redis.call('DEL',KEYS[1])
local gen=redis.call('INCR',KEYS[2])
redis.call('PEXPIRE',KEYS[2],${String(PLAN_USAGE_LIMITS.generationTtlMs)})
return gen
`;

/** `unpack` has a stack bound; keep each script call's key count modest. */
const READ_MANY_CHUNK = 250;

function numberAt(reply: unknown, index: number): number {
  const v = Array.isArray(reply) ? (reply as unknown[])[index] : undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error('plan usage: store returned a malformed reply');
  }
  return n;
}

export class RedisPlanUsageStore implements PlanUsageStore {
  constructor(private readonly redis: BreakerRedis) {}

  private snapshotKey(id: string): string {
    return `${KEY_PREFIX.snapshot}${id}`;
  }
  private cooldownKey(id: string): string {
    return `${KEY_PREFIX.cooldown}${id}`;
  }
  private generationKey(id: string): string {
    return `${KEY_PREFIX.generation}${id}`;
  }

  async merge(
    providerId: string,
    obs: PlanUsageObservation,
    gen: number,
    source: PlanUsageSource,
  ): Promise<PlanUsageMergeResult> {
    assertGeneration(gen);
    const clean = sanitizeObservation(obs);
    const reply = await this.redis.eval(
      MERGE_LUA,
      2,
      this.snapshotKey(providerId),
      this.generationKey(providerId),
      wireOf(clean),
      gen,
      source,
    );
    return { applied: numberAt(reply, 0) === 1, gen: numberAt(reply, 1) };
  }

  async readMany(
    providerIds: readonly string[],
    withCooldown: readonly string[] = [],
  ): Promise<ReadonlyMap<string, PlanUsageRead>> {
    const out = new Map<string, PlanUsageRead>();
    const ids = [...new Set(providerIds)];
    const cooldown = new Set(withCooldown);
    for (let i = 0; i < ids.length; i += READ_MANY_CHUNK) {
      const chunk = ids.slice(i, i + READ_MANY_CHUNK);
      const probed = chunk.filter((id) => cooldown.has(id));
      const reply = await this.redis.eval(
        READ_MANY_LUA,
        chunk.length + probed.length,
        ...chunk.map((id) => this.snapshotKey(id)),
        ...probed.map((id) => this.cooldownKey(id)),
        chunk.length,
      );
      const parts = Array.isArray(reply) ? (reply as unknown[]) : [];
      const snaps = Array.isArray(parts[0]) ? (parts[0] as unknown[]) : [];
      const ends = Array.isArray(parts[1]) ? (parts[1] as unknown[]) : [];
      chunk.forEach((id, idx) => {
        const probeIdx = probed.indexOf(id);
        const rawEnd = probeIdx === -1 ? 0 : Number(ends[probeIdx]);
        out.set(id, {
          snapshot: parseSnapshot(snaps[idx]),
          // The script already turned PTTL into an absolute server-clock end (0 = no cooldown).
          cooldownEndsAt: Number.isFinite(rawEnd) && rawEnd > 0 ? rawEnd : null,
        });
      });
    }
    return out;
  }

  async claimRefresh(providerId: string): Promise<PlanUsageRefreshClaim> {
    const reply = await this.redis.eval(
      CLAIM_REFRESH_LUA,
      2,
      this.cooldownKey(providerId),
      this.generationKey(providerId),
      PLAN_USAGE_LIMITS.refreshCooldownMs,
    );
    return {
      claimed: numberAt(reply, 0) === 1,
      availableAt: numberAt(reply, 1),
      gen: numberAt(reply, 2),
      retryAfterMs: numberAt(reply, 3),
    };
  }

  async extendRefresh(providerId: string, retryAfterMs: number): Promise<void> {
    if (!Number.isFinite(retryAfterMs)) throw new RangeError('plan usage: non-finite retry-after');
    await this.redis.eval(
      EXTEND_REFRESH_LUA,
      1,
      this.cooldownKey(providerId),
      Math.round(retryAfterMs),
      PLAN_USAGE_LIMITS.refreshMinMs,
      PLAN_USAGE_LIMITS.refreshMaxMs,
    );
  }

  async clear(providerId: string): Promise<number> {
    const reply = await this.redis.eval(
      CLEAR_LUA,
      2,
      this.snapshotKey(providerId),
      this.generationKey(providerId),
    );
    const n = typeof reply === 'string' ? Number(reply) : reply;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error('plan usage: store returned a malformed reply');
    }
    return n;
  }
}

// ---------------------------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------------------------

export interface FailoverPlanUsageOptions {
  /** Delay before the one retry of a failed primary clear (default 5 s). */
  readonly clearRetryMs?: number;
  /** Schedules the retry (default: an unref'd timer, so it never holds the process open). */
  readonly schedule?: (fn: () => void, ms: number) => void;
  /** A fixed, secret-free log line (the final failed clear). */
  readonly log?: (message: string) => void;
}

function defaultSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
}

/**
 * The composite that owns degradation (design D5, classify D6a). `merge` and `readMany` fall back
 * to the per-instance store on a primary fault, metered once through `onError`. `claimRefresh`
 * and `extendRefresh` do NOT fall back: they throw, so the endpoint answers 503 rather than let
 * each instance keep its own cooldown. `clear` clears the fallback first (raising its generation,
 * so failing over and back never resurrects a cleared snapshot), then the primary; a primary
 * failure is retried ONCE, off the request, and then logged.
 */
export class FailoverPlanUsageStore implements PlanUsageStore {
  private readonly clearRetryMs: number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly log: (message: string) => void;

  constructor(
    private readonly primary: PlanUsageStore,
    private readonly fallback: PlanUsageStore,
    private readonly onError: (err: unknown) => void = () => undefined,
    opts: FailoverPlanUsageOptions = {},
  ) {
    this.clearRetryMs = opts.clearRetryMs ?? 5_000;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.log = opts.log ?? (() => undefined);
  }

  private report(err: unknown): void {
    try {
      this.onError(err);
    } catch {
      /* a throwing meter must never break the call path */
    }
  }

  async merge(
    providerId: string,
    obs: PlanUsageObservation,
    gen: number,
    source: PlanUsageSource,
  ): Promise<PlanUsageMergeResult> {
    // A malformed input is a caller bug, not a store fault: never metered, never degraded.
    assertGeneration(gen);
    const clean = sanitizeObservation(obs);
    try {
      return await this.primary.merge(providerId, clean, gen, source);
    } catch (err) {
      this.report(err);
      return this.fallback.merge(providerId, clean, gen, source);
    }
  }

  async readMany(
    providerIds: readonly string[],
    withCooldown: readonly string[] = [],
  ): Promise<ReadonlyMap<string, PlanUsageRead>> {
    try {
      return await this.primary.readMany(providerIds, withCooldown);
    } catch (err) {
      this.report(err);
      return this.fallback.readMany(providerIds, withCooldown);
    }
  }

  // The refresh claim and extension never degrade: the fault is metered once and rethrown, so
  // the endpoint answers 503 and no per-instance cooldown can let N instances send N reads.
  async claimRefresh(providerId: string): Promise<PlanUsageRefreshClaim> {
    try {
      return await this.primary.claimRefresh(providerId);
    } catch (err) {
      this.report(err);
      throw err;
    }
  }

  async extendRefresh(providerId: string, retryAfterMs: number): Promise<void> {
    try {
      await this.primary.extendRefresh(providerId, retryAfterMs);
    } catch (err) {
      this.report(err);
      throw err;
    }
  }

  async clear(providerId: string): Promise<number> {
    const fallbackGen = await this.fallback.clear(providerId);
    try {
      return await this.primary.clear(providerId);
    } catch (err) {
      this.report(err);
      this.schedule(() => {
        this.primary.clear(providerId).catch(() => {
          try {
            this.log('plan usage: clearing a provider snapshot failed after one retry');
          } catch {
            /* a throwing logger must never surface */
          }
        });
      }, this.clearRetryMs);
      return fallbackGen;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The recorder (the hot-path gate, invariant 9)
// ---------------------------------------------------------------------------------------------

export interface PlanUsageRecorderOptions {
  readonly now?: () => number;
  /** The LRU bound of the in-process signature map (default 10 000). */
  readonly maxEntries?: number;
  /** An unchanged observation is still written once per this interval (default 60 s). */
  readonly heartbeatMs?: number;
}

interface RecorderEntry {
  signature: string | null;
  lastWriteAt: number;
  gen: number;
}

/** The change signature: per window the key, whole percent and reset minute (an `{ inMs }` reset
 * by the minute bucket of its duration), then the billing state. */
function signatureOf(obs: PlanUsageObservation): string {
  const parts = obs.windows.map((w) => {
    const reset =
      w.reset === null
        ? '-'
        : 'atMs' in w.reset
          ? `a${String(Math.floor(w.reset.atMs / 60_000))}`
          : `i${String(Math.round(w.reset.inMs / 60_000))}`;
    const percent = w.usedPercent === null ? '-' : String(Math.round(w.usedPercent));
    return `${w.key}|${percent}|${reset}`;
  });
  return `${parts.join(';')}#${obs.billing ?? '-'}`;
}

/**
 * Coalesces observations in front of a store. `offer` is synchronous and never throws; it calls
 * `void store.merge(...)` only when the signature differs from the one this instance last wrote
 * for the provider, or 60 s have passed (the heartbeat that keeps a window's `as of` honest). A
 * request that changes nothing therefore makes no store call. The map is bounded and LRU; each
 * entry caches the provider's last known generation, which `generationOf` returns (0 when
 * unknown) for the next attempt to carry.
 */
export class PlanUsageRecorder {
  private readonly entries = new Map<string, RecorderEntry>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly store: PlanUsageStore,
    opts: PlanUsageRecorderOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.heartbeatMs = opts.heartbeatMs ?? 60_000;
  }

  /** The cached generation for a provider, or 0 when this instance has not learned one. Reads
   * only; never creates an entry. */
  generationOf(providerId: string): number {
    return this.entries.get(providerId)?.gen ?? 0;
  }

  /** This instance cleared the provider: remember the new generation and forget the signature,
   * so the next observation is written at once. */
  noteCleared(providerId: string, gen: number): void {
    try {
      const entry = this.touch(providerId);
      entry.gen = Math.max(0, Math.floor(gen));
      entry.signature = null;
    } catch {
      /* never throws */
    }
  }

  offer(providerId: string, obs: PlanUsageObservation, gen: number): void {
    try {
      const entry = this.touch(providerId);
      const signature = signatureOf(obs);
      const t = this.now();
      if (entry.signature === signature && t - entry.lastWriteAt < this.heartbeatMs) return;
      entry.signature = signature;
      entry.lastWriteAt = t;
      void this.store.merge(providerId, obs, gen, 'traffic').then(
        (result) => {
          if (!result.applied) {
            // Another credential generation is current: learn it, and write the next one at once.
            entry.gen = result.gen;
            if (entry.signature === signature) entry.signature = null;
          } else if (result.gen > entry.gen) {
            entry.gen = result.gen;
          }
        },
        () => {
          // A rejected merge is swallowed (display data): the heartbeat retries it.
        },
      );
    } catch {
      /* offer never throws: capture can never break a request */
    }
  }

  /** Find or create an entry, marking it most recently used and evicting beyond the bound. */
  private touch(providerId: string): RecorderEntry {
    let entry = this.entries.get(providerId);
    if (entry === undefined) {
      entry = { signature: null, lastWriteAt: 0, gen: 0 };
    } else {
      this.entries.delete(providerId);
    }
    this.entries.set(providerId, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return entry;
  }
}
