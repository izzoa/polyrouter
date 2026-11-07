/**
 * Plan-error dialects (classify-plan-quota-errors). A subscription preset's region declares
 * one of three dialects; for a non-2xx response other than a 401 the dialect reads the parsed
 * error envelope BEFORE the generic status map, so a flat-rate plan's exhausted window, a
 * risk-control throttle, an inactive plan or a plan that lacks the model each get their own
 * kind instead of the blanket 429 `rate_limit`.
 *
 * Boundaries this module keeps (design D3, D5):
 *  - Structured fields only. A dialect reads `error.code`, `base_resp.status_code` or the
 *    walked `error.message`; it never scans raw body text.
 *  - It takes NO clock. An absolute reset (a body time or an HTTP-date `Retry-After`) is
 *    returned as `resetAt`; a delta-seconds `Retry-After` stays RELATIVE as `retryAfterMs`,
 *    so no instance clock can move a cooldown end (the store adds it to the Redis clock).
 *  - A 401 returns null under every dialect, so it always takes the generic `auth`.
 *  - Trusted bundled data only: the dialect id comes from a preset registry, never from user
 *    input or the host.
 *
 * This file imports only TYPES from `errors.ts` (which imports it at runtime), so there is no
 * runtime cycle.
 */
import type { ProviderErrorKind } from './errors';

/** The closed set of wire formats the data plane knows. Two regions of one preset share one. */
export type PlanErrorDialect = 'zai' | 'minimax' | 'kimi';

/** `short` is a 5-hour or unidentified window; `long` a weekly, monthly, credit or Extra Usage
 * limit. It only chooses the default pause when the provider states no reset (design D5). */
export type PlanWindow = 'short' | 'long';

/** What a dialect knows about WHEN the plan is usable again. Each field is optional and at
 * most one of `resetAt` / `retryAfterMs` is set. */
export interface PlanReset {
  /** An absolute instant (epoch ms): a body time or an HTTP-date `Retry-After`. */
  readonly resetAt?: number;
  /** A RELATIVE duration (ms) from a delta-seconds `Retry-After`. Never converted on a local
   * clock; the cooldown store adds it to the Redis server clock. */
  readonly retryAfterMs?: number;
  readonly window?: PlanWindow;
}

export interface PlanClassification extends PlanReset {
  readonly kind: ProviderErrorKind;
}

/** The response headers a dialect reads. Only `Retry-After`, only when a dialect is set. */
export interface PlanHeaders {
  readonly retryAfter?: string;
}

export interface PlanErrorEntry {
  readonly kind: ProviderErrorKind;
  readonly window?: PlanWindow;
}

const Q_SHORT: PlanErrorEntry = { kind: 'quota_exhausted', window: 'short' };
const Q_LONG: PlanErrorEntry = { kind: 'quota_exhausted', window: 'long' };
const RISK: PlanErrorEntry = { kind: 'risk_control' };
const INACTIVE: PlanErrorEntry = { kind: 'plan_inactive' };
const ENTITLEMENT: PlanErrorEntry = { kind: 'plan_entitlement' };
const RATE: PlanErrorEntry = { kind: 'rate_limit' };
const UNAVAILABLE: PlanErrorEntry = { kind: 'unavailable' };

/**
 * Z.ai (GLM Coding Plan). Source: https://docs.z.ai/api-reference/api-code (read 2026-11-06).
 * Body `{"error":{"code":"<string>","message":...}}`; every code below is documented as HTTP
 * 429. 1308/1316/1318/1320 are the 5-hour (short) windows, 1310/1317/1319/1321 the 7-day or
 * weekly/monthly (long) ones. 1302 (request rate) and 1305 (overload) are listed so their
 * generic TRIPPING semantics are explicit and testable.
 */
export const ZAI_CODES: ReadonlyMap<string, PlanErrorEntry> = new Map<string, PlanErrorEntry>([
  ['1308', Q_SHORT],
  ['1310', Q_LONG],
  ['1316', Q_SHORT],
  ['1317', Q_LONG],
  ['1318', Q_SHORT],
  ['1319', Q_LONG],
  ['1320', Q_SHORT],
  ['1321', Q_LONG],
  ['1313', RISK],
  ['1309', INACTIVE],
  ['1314', INACTIVE],
  ['1315', INACTIVE],
  ['1113', INACTIVE],
  ['1311', ENTITLEMENT],
  ['1302', RATE],
  ['1305', UNAVAILABLE],
]);

/**
 * MiniMax (M Plan). Source: https://platform.minimax.io/docs/api-reference/errorcode (read
 * 2026-11-06). The page gives no HTTP status per code and no envelope for the OpenAI-compatible
 * path [U], so the code is read from the first of `error.code` and `base_resp.status_code`.
 * 2062 means "no active plan" only when querying usage, so it stays a rate limit here.
 */
export const MINIMAX_CODES: ReadonlyMap<number, PlanErrorEntry> = new Map<number, PlanErrorEntry>([
  [2056, Q_SHORT],
  [2067, Q_SHORT],
  [2057, INACTIVE],
  [2061, ENTITLEMENT],
  [2068, ENTITLEMENT],
  [2062, RATE],
  [2064, UNAVAILABLE],
  [2066, UNAVAILABLE],
  [2069, { kind: 'unknown_model' }],
]);

export interface KimiPlanErrorEntry extends PlanErrorEntry {
  readonly status: number;
}

/**
 * Kimi Code. Source: https://www.kimi.com/code/docs/en/kimi-code/error-reference.html (read
 * 2026-11-06). Matched on the PREFIX of the structured message (apostrophes folded to U+0027),
 * gated by status (429 quota/risk/transient texts, 403 tier texts). No message carries a reset.
 * The membership 403 ("We're unable to verify your membership benefits at this time...") is
 * deliberately ABSENT: the page itself says "Wait a moment and retry", so it stays the generic
 * `permission` (design D1).
 */
export const KIMI_MESSAGES: ReadonlyMap<string, KimiPlanErrorEntry> = new Map<
  string,
  KimiPlanErrorEntry
>([
  ["You've reached your 5-hour usage limit", { status: 429, ...Q_SHORT }],
  ["You've reached your weekly (7-day) usage limit", { status: 429, ...Q_LONG }],
  ["You've reached your monthly usage limit", { status: 429, ...Q_LONG }],
  ['Your credit balance is insufficient', { status: 429, ...Q_LONG }],
  ["Your organization's Extra Usage balance has run out", { status: 429, ...Q_LONG }],
  [
    "You've reached the Extra Usage limit set for your account by your organization",
    { status: 429, ...Q_LONG },
  ],
  ["You've reached your concurrent request limit", { status: 429, ...RISK }],
  ["We're receiving too many requests", { status: 429, ...RATE }],
  ['The engine is currently overloaded', { status: 429, ...UNAVAILABLE }],
  ['Your current subscription does not have access to', { status: 403, ...ENTITLEMENT }],
  ['Your current plan supports only', { status: 403, ...ENTITLEMENT }],
]);

/** The zone of Z.ai's `{next_flush_time}` when it states none, as a fixed offset like
 * `+08:00`. `null` until evidence from a captured response or Z.ai documentation exists
 * (tasks 11.1/11.2): a zone-less time is then ignored, never guessed (design D5). */
export const ZAI_FLUSH_TIME_ZONE: string | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first string `message` along the nested `error` chain (the same walk the message
 * factory does; bounded depth). */
function envelopeMessage(envelope: unknown): string | undefined {
  let node: unknown = envelope;
  for (let depth = 0; depth < 4 && isRecord(node); depth += 1) {
    if (typeof node['message'] === 'string') return node['message'];
    node = node['error'];
  }
  return undefined;
}

/** `error.code` as a string (Z.ai documents a string; a number is tolerated). */
function errorCodeString(envelope: unknown): string | undefined {
  if (!isRecord(envelope)) return undefined;
  const err = envelope['error'];
  if (!isRecord(err)) return undefined;
  const code = err['code'];
  if (typeof code === 'string') return code.trim();
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return undefined;
}

/** A number or numeric string, integers only. */
function asCode(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** MiniMax: the first of `error.code` and `base_resp.status_code` that parses. */
function minimaxCode(envelope: unknown): number | undefined {
  if (!isRecord(envelope)) return undefined;
  const err = envelope['error'];
  const fromError = isRecord(err) ? asCode(err['code']) : undefined;
  if (fromError !== undefined) return fromError;
  const base = envelope['base_resp'];
  return isRecord(base) ? asCode(base['status_code']) : undefined;
}

const ZAI_RESET_TAIL = 256;
const ZAI_RESET_CLAUSE = /\bresets? at\s+(.+?)[.\s]*$/i;
const ISO_WITH_ZONE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)\s?(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;

function isoToMs(date: string, time: string, zone: string): number | undefined {
  const z = zone.toUpperCase() === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${date}T${time}${z}`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Z.ai's `{next_flush_time}` from the message's trailing "reset at ..." / "Resets at ..."
 * clause, as an absolute epoch ms. Honoured formats are ISO-8601 with an offset or `Z`, and
 * epoch seconds (10 digits) or milliseconds (13 digits). Anything else, a zone-less date-time
 * included, gives `undefined` unless `zone` (a fixed offset from evidence) is supplied. The
 * result is returned as parsed: clamping is the store's job.
 */
export function parseZaiResetTime(
  message: string | undefined,
  zone: string | null = ZAI_FLUSH_TIME_ZONE,
): number | undefined {
  if (message === undefined) return undefined;
  // The clause is a trailing suffix and a real time is under 40 characters, so only the tail is
  // scanned: a hostile megabyte message cannot make the lazy match backtrack quadratically.
  const clause = ZAI_RESET_CLAUSE.exec(message.trim().slice(-ZAI_RESET_TAIL));
  if (clause === null) return undefined;
  const value = (clause[1] ?? '').trim();
  const withZone = ISO_WITH_ZONE.exec(value);
  if (withZone !== null) return isoToMs(withZone[1]!, withZone[2]!, withZone[3]!);
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  if (/^\d{13}$/.test(value)) return Number(value);
  if (zone !== null && /^[+-]\d{2}:\d{2}$/.test(zone)) {
    const bare = ISO_NO_ZONE.exec(value);
    if (bare !== null) return isoToMs(bare[1]!, bare[2]!, zone);
  }
  return undefined;
}

const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s.+\sGMT$/;

/** `Retry-After`: an HTTP-date is an absolute instant (`resetAt`); delta-seconds stay
 * RELATIVE (`retryAfterMs`) and are never added to a local clock. Anything else is ignored. */
export function parseRetryAfter(
  value: string | undefined,
): { resetAt: number } | { retryAfterMs: number } | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return { retryAfterMs: Number(v) * 1000 };
  if (HTTP_DATE.test(v)) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return { resetAt: ms };
  }
  return undefined;
}

const RETRY_AFTER_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'quota_exhausted',
  'risk_control',
]);

function lookup(
  dialect: PlanErrorDialect,
  status: number,
  envelope: unknown,
): { entry: PlanErrorEntry; message?: string } | null {
  switch (dialect) {
    case 'zai': {
      const code = errorCodeString(envelope);
      const entry = code === undefined ? undefined : ZAI_CODES.get(code);
      if (entry === undefined) return null;
      const message = envelopeMessage(envelope);
      return { entry, ...(message !== undefined ? { message } : {}) };
    }
    case 'minimax': {
      const code = minimaxCode(envelope);
      const entry = code === undefined ? undefined : MINIMAX_CODES.get(code);
      return entry === undefined ? null : { entry };
    }
    case 'kimi': {
      const raw = envelopeMessage(envelope);
      if (raw === undefined) return null;
      const message = raw.replace(/’/g, "'").trimStart();
      for (const [prefix, entry] of KIMI_MESSAGES) {
        if (entry.status === status && message.startsWith(prefix)) return { entry };
      }
      return null;
    }
  }
}

/**
 * Classify a non-2xx response under a dialect. Returns null when the dialect does not
 * recognize it (the caller then applies the generic status map unchanged) and ALWAYS for a
 * 401. Pure and total: no clock, no I/O, never throws on a hostile envelope.
 */
export function classifyPlanError(
  dialect: PlanErrorDialect,
  status: number,
  envelope: unknown,
  headers: PlanHeaders = {},
): PlanClassification | null {
  if (status === 401) return null;
  const hit = lookup(dialect, status, envelope);
  if (hit === null) return null;
  const { entry } = hit;
  let reset: { resetAt: number } | { retryAfterMs: number } | undefined;
  if (entry.kind === 'quota_exhausted' && dialect === 'zai') {
    const at = parseZaiResetTime(hit.message);
    if (at !== undefined) reset = { resetAt: at };
  }
  if (reset === undefined && RETRY_AFTER_KINDS.has(entry.kind)) {
    reset = parseRetryAfter(headers.retryAfter);
  }
  return {
    kind: entry.kind,
    ...(entry.window !== undefined ? { window: entry.window } : {}),
    ...(reset ?? {}),
  };
}
