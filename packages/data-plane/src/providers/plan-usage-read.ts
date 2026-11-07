/**
 * The attended plan-usage read (add-subscription-quota-display, design D7): one guarded, bounded
 * GET to a preset-pinned usage endpoint, parsed defensively into the same numbers-and-enums
 * `PlanUsageObservation` the passive parsers produce.
 *
 * What this module is, and is not:
 *  - It is NOT an adapter method and it is not a model call. It builds its headers FROM SCRATCH:
 *    the credential in the probe's declared form, `Accept: application/json`, and polyrouter's own
 *    honest User-Agent (set through the shared `withUserAgent` helper, never a literal). It never
 *    reads `config.extraHeaders`, so a preset's imitation identity is never sent on a usage read,
 *    whatever the provider's switch (FD3).
 *  - Egress goes through `createGuardedHttpClient` + `openRequest` (http.ts) only: the SSRF guard,
 *    the byte bound and the honest-UA backstop are inherited, and no new egress primitive exists.
 *  - GET only, no body, no redirect followed, a 64 KiB cap and a 10 s deadline.
 *  - Every failure is a typed result with a FIXED message. No header, body text or credential is
 *    ever copied into a result (invariant 8): parsers read known field names and keep numbers.
 *
 * Sources, read 2026-11-06 (Plans/Subscription-quota-research.md, `## active`). Each endpoint
 * ships DISABLED until its live runbook passes (tasks 9.x); the shapes below are the reference
 * clients' [V code] and carry [U] items the runbook resolves:
 *  - `minimax_remains`: MiniMax M Plan FAQ "How can I check M Plan usage?" and MiniMax-AI/cli
 *    (`src/utils/quota.ts`, `types/api.ts:352-368`, fixture `test/fixtures/quota-response.json`,
 *    @38aba5f). `*_remaining_percent` and `*_status` [V in the CLI], their presence on an API-key
 *    response [U].
 *  - `kimi_usages`: MoonshotAI/kimi-code `packages/oauth/src/managed-usage.ts` @bb0c66a and
 *    CodexBar `KimiUsageFetcher.swift` @b3b4d56. `used_ratio` is stuck at 0 (kimi-code#3908), so
 *    only the counters are read.
 *  - `zai_quota_limit`: zai-org/zai-coding-plugins `query-usage.mjs` @64cebff, CodexBar `zai.js`
 *    and oh-my-pi `zai.ts`. The unit enum is undocumented: only 3 (hours) and 6 (weeks) are read.
 *  - `opencode_go_usage`: anomalyco/opencode `packages/core/src/usage-limits.ts:156-188`
 *    (PR #58694, merged 2026-10-24).
 */
import { SsrfError, POLYROUTER_USER_AGENT, withUserAgent } from '@polyrouter/shared/server';
import type { ProviderConfig } from './adapter';
import { CallCancelledError, ProviderError, type ProviderErrorKind } from './errors';
import { createGuardedHttpClient, openRequest, type HttpClient } from './http';
import { parseRetryAfter } from './plan-errors';
import {
  RESET_SLACK_MS,
  SPAN_MINUTES,
  accountKey,
  bucketOf,
  cleanValue,
  clampPercent,
  dedupeByKey,
  parseDecimal,
  plausibleResetAt,
  windowLengthMs,
  type PlanUsageObservation,
  type PlanUsageReset,
  type PlanUsageSpan,
  type PlanUsageWindow,
} from './plan-usage';

/** The closed set of usage-endpoint parsers (design D7). */
export type PlanUsageParserId =
  'minimax_remains' | 'kimi_usages' | 'zai_quota_limit' | 'opencode_go_usage';

export const PLAN_USAGE_PARSER_IDS: readonly PlanUsageParserId[] = [
  'minimax_remains',
  'kimi_usages',
  'zai_quota_limit',
  'opencode_go_usage',
];

/** A key-preset region's usage endpoint: a bundled same-origin constant (design D7). */
export interface PlanUsageProbe {
  readonly url: string;
  /** `bearer` sends `Authorization: Bearer <key>`; `raw` sends `Authorization: <key>`. */
  readonly auth: 'bearer' | 'raw';
  readonly parser: PlanUsageParserId;
  /** Ships `false` until the region's live runbook passes. The caller gates on it; the read
   * itself performs no gate, so a parser is testable against fixtures. */
  readonly enabled: boolean;
}

export type PlanUsageReadResult =
  | { readonly ok: true; readonly observation: PlanUsageObservation }
  | {
      readonly ok: false;
      readonly kind: ProviderErrorKind;
      /** FIXED text, never derived from the response or the credential. */
      readonly message: string;
      /** A 429's `Retry-After`, kept RELATIVE (never added to a stored instant). */
      readonly retryAfterMs?: number;
    };

export interface PlanUsageReadDeps {
  /** Tests inject a fake transport; the default is the SSRF-guarded client. */
  readonly httpClient?: HttpClient;
  /** Injected into the default guarded client to drive connect-time refusal in tests. */
  readonly resolve?: (hostname: string) => Promise<string[]>;
  readonly now?: () => number;
  /** The read's deadline; defaults to 10 s. */
  readonly timeoutMs?: number;
}

export const USAGE_READ_TIMEOUT_MS = 10_000;
/** The body cap: a usage payload is a few hundred bytes. */
export const USAGE_READ_MAX_BYTES = 64 * 1024;
/** Headroom the dispatcher's own timeouts sit above the typed deadline (a backstop only). */
const DISPATCHER_HEADROOM_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// Fixed messages
// ---------------------------------------------------------------------------------------------

export const USAGE_MESSAGES = {
  rejected: 'The provider rejected the credential for its usage endpoint.',
  refused: 'The usage read was refused; the key may lack access to the usage endpoint.',
  // Kimi has answered 403 for 5-hour and weekly exhaustion (kimi-code#3908, #3951), so a 403 is
  // never worded as a rejected key or a rejected User-Agent.
  refusedKimi:
    'The usage read was refused: the plan may be used up, or the key may lack access to usage.',
  refusedOpencodeGo:
    'The usage read was refused: the key has no Go plan, or lacks the Usage › Read permission.',
  notFound: 'The usage endpoint was not found.',
  rateLimited: 'The usage endpoint is rate limiting reads.',
  unavailable: 'The usage endpoint is unavailable.',
  unexpectedStatus: 'The usage endpoint returned an unexpected status.',
  unreadable: 'The usage endpoint returned an unreadable response.',
  unrecognised: 'The usage endpoint returned nothing this version can read.',
  noPlanUsage: 'No plan usage is available for this key.',
  planInactive: 'The provider reports no active plan for this key.',
  apiError: 'The usage endpoint reported an error.',
  timedOut: 'The usage endpoint did not answer in time.',
  oversized: 'The usage endpoint returned an oversized response.',
  redirected: 'The usage endpoint redirected, which is refused.',
  addressRefused: 'The usage endpoint address was refused.',
  unreachable: 'The usage endpoint could not be reached.',
} as const;

function fail(
  kind: ProviderErrorKind,
  message: string,
  retryAfterMs?: number,
): Extract<PlanUsageReadResult, { ok: false }> {
  return {
    ok: false,
    kind,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Value helpers (design D3 common rules, applied to JSON values)
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-negative finite number from a JSON number or a plain-decimal string; else null. A sign,
 * an exponent, a hex form or anything else is absent, and an empty value is never 0. */
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string') return parseDecimal(v);
  return null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A reset from an ISO-8601 instant. The plausibility bound still applies. */
function resetFromIso(
  raw: unknown,
  span: PlanUsageSpan | null,
  minutes: number | null,
  now: number,
): PlanUsageReset | null {
  if (typeof raw !== 'string') return null;
  const t = cleanValue(raw);
  if (t === null || !ISO_INSTANT.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? plausibleResetAt(ms, span, minutes, now) : null;
}

/** A reset from epoch MILLISECONDS (a number or a plain-decimal string). */
function resetFromEpochMs(
  raw: unknown,
  span: PlanUsageSpan | null,
  minutes: number | null,
  now: number,
): PlanUsageReset | null {
  const n = numOf(raw);
  return n === null ? null : plausibleResetAt(Math.round(n), span, minutes, now);
}

/** Kimi's `resetTime`: an ISO instant, or a plain epoch number whose unit is read from its size
 * (seconds below 1e11, else milliseconds). The plausibility bound catches a wrong guess. */
function resetFromIsoOrEpoch(
  raw: unknown,
  span: PlanUsageSpan | null,
  minutes: number | null,
  now: number,
): PlanUsageReset | null {
  const n = numOf(raw);
  if (n === null) return resetFromIso(raw, span, minutes, now);
  const ms = n < 1e11 ? Math.round(n) * 1000 : Math.round(n);
  return plausibleResetAt(ms, span, minutes, now);
}

function windowOf(
  key: string,
  span: PlanUsageSpan | null,
  minutes: number | null,
  usedPercent: number | null,
  reset: PlanUsageReset | null,
): PlanUsageWindow {
  return { key, group: 'account', span, minutes, scope: null, usedPercent, reset };
}

/** The result of a parser: windows, or a typed failure. */
type Parsed =
  { readonly windows: readonly PlanUsageWindow[] } | Extract<PlanUsageReadResult, { ok: false }>;

// ---------------------------------------------------------------------------------------------
// minimax_remains
// ---------------------------------------------------------------------------------------------

/** MiniMax's own status enum: 1 normal, 2 exhausted, 3 unlimited / not in the plan. */
const MINIMAX_STATUS_UNLIMITED = 3;
const MINIMAX_NO_ACTIVE_PLAN = 2062;

function minimaxWindow(
  row: Json,
  names: {
    readonly remaining: string;
    readonly status: string;
    readonly end: string;
  },
  span: PlanUsageSpan,
  now: number,
): PlanUsageWindow | null {
  // A window whose status is 3 is unlimited or not in the plan: it has no meaningful percent.
  if (numOf(row[names.status]) === MINIMAX_STATUS_UNLIMITED) return null;
  const minutes = SPAN_MINUTES[span];
  const remaining = numOf(row[names.remaining]);
  // A remaining value over 100 reads UNKNOWN, never used 0% (design D7): MiniMax's own CLI shows
  // remaining up to about 150% on boosted plans, beside `weekly_boost_permille`, whose meaning
  // task 9.4 has not pinned. `weekly_boost_permille` is therefore not read.
  const usedPercent = remaining !== null && remaining <= 100 ? clampPercent(100 - remaining) : null;
  const reset = resetFromEpochMs(row[names.end], span, minutes, now);
  if (remaining === null && reset === null) return null;
  return windowOf(accountKey(span, minutes), span, minutes, usedPercent, reset);
}

function parseMinimaxRemains(json: unknown, now: number): Parsed {
  if (!isRecord(json)) return fail('unavailable', USAGE_MESSAGES.unrecognised);
  const base = json['base_resp'];
  const rawCode = isRecord(base) ? base['status_code'] : undefined;
  const code = typeof rawCode === 'number' ? rawCode : numOf(rawCode);
  // Requires status_code === 0. A rejected key still answers HTTP 200 with a non-zero code.
  if (code !== 0) {
    return code === MINIMAX_NO_ACTIVE_PLAN
      ? fail('plan_inactive', USAGE_MESSAGES.planInactive)
      : fail('unavailable', USAGE_MESSAGES.apiError);
  }
  const rows = json['model_remains'];
  if (!Array.isArray(rows)) return fail('unavailable', USAGE_MESSAGES.unrecognised);

  // A bucket outside the plan shows totals 0 and status 3 on BOTH windows (MiniMax-AI/cli#173):
  // those rows are skipped.
  const usable = rows
    .filter(isRecord)
    .filter(
      (r) =>
        !(
          numOf(r['current_interval_status']) === MINIMAX_STATUS_UNLIMITED &&
          numOf(r['current_weekly_status']) === MINIMAX_STATUS_UNLIMITED
        ),
    );
  // The text model row ("MiniMax-M*"); else the first usable row.
  const row =
    usable.find(
      (r) => typeof r['model_name'] === 'string' && /^minimax-m/i.test(r['model_name']),
    ) ?? usable[0];
  if (row === undefined) return fail('plan_inactive', USAGE_MESSAGES.noPlanUsage);

  const windows = [
    minimaxWindow(
      row,
      {
        remaining: 'current_interval_remaining_percent',
        status: 'current_interval_status',
        end: 'end_time',
      },
      '5h',
      now,
    ),
    minimaxWindow(
      row,
      {
        remaining: 'current_weekly_remaining_percent',
        status: 'current_weekly_status',
        end: 'weekly_end_time',
      },
      'weekly',
      now,
    ),
  ].filter((w): w is PlanUsageWindow => w !== null);
  return { windows };
}

// ---------------------------------------------------------------------------------------------
// kimi_usages
// ---------------------------------------------------------------------------------------------

const KIMI_UNIT_MINUTES: Readonly<Record<string, number>> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1440,
  TIME_UNIT_WEEK: 10_080,
  TIME_UNIT_MONTH: 43_200,
};

/** `{limit, used, remaining, resetTime}`, counters numeric or string, deriving a missing count.
 * `used_ratio` is never read (it is stuck at 0, kimi-code#3908). */
function kimiCounters(
  detail: unknown,
  span: PlanUsageSpan | null,
  minutes: number | null,
  now: number,
): { usedPercent: number | null; reset: PlanUsageReset | null } | null {
  if (!isRecord(detail)) return null;
  const limit = numOf(detail['limit']);
  const used = numOf(detail['used']);
  const remaining = numOf(detail['remaining']);
  let usedPercent: number | null = null;
  if (limit !== null && limit > 0) {
    // `remaining` above `limit` is not a count we can read: it never derives a 0%.
    const derived = remaining !== null && remaining <= limit ? limit - remaining : null;
    const consumed = used ?? derived;
    if (consumed !== null) usedPercent = clampPercent((consumed / limit) * 100);
  }
  const reset = resetFromIsoOrEpoch(detail['resetTime'], span, minutes, now);
  if (usedPercent === null && reset === null) return null;
  return { usedPercent, reset };
}

function parseKimiUsages(json: unknown, now: number): Parsed {
  if (!isRecord(json)) return fail('unavailable', USAGE_MESSAGES.unrecognised);
  // An account without a Kimi Code plan gets `{}`: "no plan usage", never 0%.
  if (Object.keys(json).length === 0) return fail('plan_inactive', USAGE_MESSAGES.noPlanUsage);

  const windows: PlanUsageWindow[] = [];
  const limits = json['limits'];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!isRecord(entry)) continue;
      const w = entry['window'];
      let minutes: number | null = null;
      if (isRecord(w)) {
        const duration = numOf(w['duration']);
        const unit =
          typeof w['timeUnit'] === 'string' ? KIMI_UNIT_MINUTES[w['timeUnit']] : undefined;
        if (duration !== null && duration > 0 && unit !== undefined) {
          const m = Math.round(duration * unit);
          minutes = m > 0 && m <= 366 * 1440 ? m : null;
        }
      }
      const span = minutes === null ? null : bucketOf(minutes);
      const counters = kimiCounters(entry['detail'], span, minutes, now);
      if (counters === null) continue;
      windows.push(
        windowOf(accountKey(span, minutes), span, minutes, counters.usedPercent, counters.reset),
      );
    }
  }

  // The `usage` summary is an UNLABELLED window (span and minutes null) until task 9.5 pins which
  // span it represents: only legacy tiers keep a weekly summary, so a "weekly" label could lie.
  const summary = kimiCounters(json['usage'], null, null, now);
  if (summary !== null) {
    windows.push(windowOf('account:summary', null, null, summary.usedPercent, summary.reset));
  }

  const deduped = dedupeByKey(windows);
  if (deduped.length === 0) return fail('unavailable', USAGE_MESSAGES.unrecognised);
  return { windows: deduped };
}

// ---------------------------------------------------------------------------------------------
// zai_quota_limit
// ---------------------------------------------------------------------------------------------

/** FD7: only these two units are read. Both reference clients agree on them; they disagree on 5
 * (minute vs month) and on the day value, so those rows are ignored rather than guessed. */
const ZAI_UNIT_MINUTES: Readonly<Record<number, number>> = { 3: 60, 6: 10_080 };

function parseZaiQuotaLimit(json: unknown, now: number): Parsed {
  if (!isRecord(json)) return fail('unavailable', USAGE_MESSAGES.unrecognised);
  if (json['success'] !== true || numOf(json['code']) !== 200) {
    return fail('unavailable', USAGE_MESSAGES.apiError);
  }
  const data = json['data'];
  const limits = isRecord(data) ? data['limits'] : undefined;
  if (!Array.isArray(limits)) return fail('unavailable', USAGE_MESSAGES.unrecognised);

  const windows: PlanUsageWindow[] = [];
  for (const row of limits) {
    if (!isRecord(row)) continue;
    const unit = numOf(row['unit']);
    const perUnit = unit === null ? undefined : ZAI_UNIT_MINUTES[unit];
    const number = numOf(row['number']);
    if (perUnit === undefined || number === null || number <= 0) continue;
    const minutes = Math.round(number * perUnit);
    if (minutes <= 0 || minutes > 366 * 1440) continue;
    const span = bucketOf(minutes);
    const percentage = numOf(row['percentage']);
    const usedPercent = percentage === null ? null : clampPercent(percentage);
    // A tighter bound than the common one (design D7): a reset more than the window's length plus
    // one minute ahead is discarded, as CodexBar does, and NEVER re-zoned.
    let reset: PlanUsageReset | null = null;
    const at = numOf(row['nextResetTime']);
    if (at !== null) {
      const ms = Math.round(at);
      if (ms >= now - RESET_SLACK_MS && ms <= now + windowLengthMs(span, minutes) + 60_000) {
        reset = { atMs: ms };
      }
    }
    if (usedPercent === null && reset === null) continue;
    windows.push(windowOf(accountKey(span, minutes), span, minutes, usedPercent, reset));
  }
  const deduped = dedupeByKey(windows);
  if (deduped.length === 0) return fail('plan_inactive', USAGE_MESSAGES.noPlanUsage);
  return { windows: deduped };
}

// ---------------------------------------------------------------------------------------------
// opencode_go_usage
// ---------------------------------------------------------------------------------------------

const OPENCODE_WINDOWS: readonly { readonly name: string; readonly span: PlanUsageSpan }[] = [
  { name: 'rolling', span: '5h' },
  { name: 'weekly', span: 'weekly' },
  { name: 'monthly', span: 'monthly' },
];

function parseOpencodeGoUsage(json: unknown, now: number): Parsed {
  if (!isRecord(json)) return fail('unavailable', USAGE_MESSAGES.unrecognised);
  const usage = json['usage'];
  if (!isRecord(usage)) return fail('unavailable', USAGE_MESSAGES.unrecognised);
  const windows: PlanUsageWindow[] = [];
  for (const { name, span } of OPENCODE_WINDOWS) {
    const w = usage[name];
    if (!isRecord(w)) continue;
    const minutes = SPAN_MINUTES[span];
    const percent = numOf(w['percent']);
    const usedPercent = percent === null ? null : clampPercent(percent);
    const reset = resetFromIso(w['resetsAt'], span, minutes, now);
    if (usedPercent === null && reset === null) continue;
    windows.push(windowOf(accountKey(span, minutes), span, minutes, usedPercent, reset));
  }
  if (windows.length === 0) return fail('plan_inactive', USAGE_MESSAGES.noPlanUsage);
  return { windows };
}

/** Parse a usage endpoint's JSON body. Pure and total: it never throws on hostile input. */
export function parsePlanUsageBody(
  parser: PlanUsageParserId,
  json: unknown,
  now: number,
): PlanUsageReadResult {
  let parsed: Parsed;
  try {
    switch (parser) {
      case 'minimax_remains':
        parsed = parseMinimaxRemains(json, now);
        break;
      case 'kimi_usages':
        parsed = parseKimiUsages(json, now);
        break;
      case 'zai_quota_limit':
        parsed = parseZaiQuotaLimit(json, now);
        break;
      case 'opencode_go_usage':
        parsed = parseOpencodeGoUsage(json, now);
        break;
    }
  } catch {
    return fail('unavailable', USAGE_MESSAGES.unreadable);
  }
  if ('ok' in parsed) return parsed;
  // A refresh never changes billing: an endpoint read says nothing about it.
  return { ok: true, observation: { windows: parsed.windows, billing: null } };
}

// ---------------------------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------------------------

function refusal403(parser: PlanUsageParserId): string {
  switch (parser) {
    case 'kimi_usages':
      return USAGE_MESSAGES.refusedKimi;
    case 'opencode_go_usage':
      return USAGE_MESSAGES.refusedOpencodeGo;
    default:
      return USAGE_MESSAGES.refused;
  }
}

function statusFailure(
  status: number,
  parser: PlanUsageParserId,
  retryAfter: string | null,
  now: number,
): Extract<PlanUsageReadResult, { ok: false }> {
  if (status === 401) return fail('auth', USAGE_MESSAGES.rejected);
  if (status === 403) return fail('permission', refusal403(parser));
  if (status === 404) return fail('unavailable', USAGE_MESSAGES.notFound);
  if (status === 429) {
    const parsed = parseRetryAfter(retryAfter?.slice(0, 64));
    const retryAfterMs =
      parsed === undefined
        ? undefined
        : 'retryAfterMs' in parsed
          ? parsed.retryAfterMs
          : Math.max(0, parsed.resetAt - now);
    return fail('rate_limit', USAGE_MESSAGES.rateLimited, retryAfterMs);
  }
  if (status >= 500) return fail('unavailable', USAGE_MESSAGES.unavailable);
  return fail('unavailable', USAGE_MESSAGES.unexpectedStatus);
}

/**
 * One attended read of a key plan's usage endpoint. Never throws: every outcome is a typed
 * result. The credential is sent only in the `Authorization` header and appears in no result.
 */
export async function readPlanUsage(
  config: ProviderConfig,
  probe: PlanUsageProbe,
  deps: PlanUsageReadDeps = {},
): Promise<PlanUsageReadResult> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? USAGE_READ_TIMEOUT_MS;
  const httpClient =
    deps.httpClient ??
    createGuardedHttpClient({
      mode: config.mode,
      providerKind: config.kind,
      maxResponseBytes: USAGE_READ_MAX_BYTES,
      headersTimeoutMs: timeoutMs + DISPATCHER_HEADROOM_MS,
      bodyTimeoutMs: timeoutMs + DISPATCHER_HEADROOM_MS,
      ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
    });

  // Built from scratch (design D7, FD3): never `config.extraHeaders`, so a declared imitation
  // identity cannot ride a usage read. The User-Agent is set through the shared helper.
  const headers = withUserAgent(
    {
      Authorization: probe.auth === 'raw' ? config.credential : `Bearer ${config.credential}`,
      Accept: 'application/json',
    },
    POLYROUTER_USER_AGENT,
  );

  // An overall deadline on top of the first-byte and idle bounds, so a slow drip cannot outlast it.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let dispose: (() => void) | undefined;
  try {
    const opened = await openRequest(
      httpClient,
      probe.url,
      { method: 'GET', headers },
      timeoutMs,
      { signal: deadline.signal },
      timeoutMs,
      USAGE_READ_MAX_BYTES,
    );
    dispose = opened.dispose;
    const res = opened.res;
    if (!res.ok) {
      const failure = statusFailure(
        res.status,
        probe.parser,
        res.headers.get('retry-after'),
        now(),
      );
      // The error body is never read; cancel it so the guarded connection closes.
      await res.body?.cancel().catch(() => undefined);
      return failure;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'oversized_response') {
        return fail('oversized_response', USAGE_MESSAGES.oversized);
      }
      if (
        deadline.signal.aborted ||
        err instanceof ProviderError ||
        err instanceof CallCancelledError
      ) {
        return fail('unavailable', USAGE_MESSAGES.timedOut);
      }
      return fail('unavailable', USAGE_MESSAGES.unreadable);
    }
    return parsePlanUsageBody(probe.parser, json, now());
  } catch (err) {
    if (err instanceof SsrfError) return fail('unavailable', USAGE_MESSAGES.addressRefused);
    if (err instanceof ProviderError) {
      if (err.kind === 'oversized_response') {
        return fail('oversized_response', USAGE_MESSAGES.oversized);
      }
      const status = err.status;
      if (status !== undefined && status >= 300 && status < 400) {
        return fail('unavailable', USAGE_MESSAGES.redirected);
      }
      return fail('unavailable', USAGE_MESSAGES.timedOut);
    }
    if (err instanceof CallCancelledError) return fail('unavailable', USAGE_MESSAGES.timedOut);
    return fail('unavailable', USAGE_MESSAGES.unreachable);
  } finally {
    clearTimeout(timer);
    dispose?.();
  }
}
