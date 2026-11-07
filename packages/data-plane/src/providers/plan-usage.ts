/**
 * Plan-usage parsers (add-subscription-quota-display, design D3/D4). Pure functions that turn
 * the quota metadata a subscription provider already sends on a reply into a normalized
 * `PlanUsageObservation`: numbers and enums only, never a header or body string (invariant 8).
 *
 * Sources, read 2026-11-06:
 *  - `anthropic_unified` (Claude Pro/Max). Header names and units come from the Claude Code
 *    2.1.319 parser (npm `@anthropic-ai/claude-code-darwin-arm64@2.1.319`, build 2026-11-05;
 *    strings read, never run) and the wire capture in anthropics/claude-code#12829 (reset
 *    1764554400 = 2025-12-01). The family is documented by nobody, so it is read through an
 *    allowlist and its absence means "no data".
 *  - `codex` (ChatGPT Plus/Pro). `openai/codex@4688e49` `codex-api/src/rate_limits.rs`: the
 *    `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}` family, the legacy
 *    `-reset-after-seconds` of rust-v0.46.0, the `x-<limit>-primary-*` model buckets and the two
 *    credit flags. A window counts only as Codex counts it (see `parseCodex`).
 *  - `opencode_go` (OpenCode Go). The docs example for `usage.opencode.billing_source`
 *    (opencode.ai/docs/go, read 2026-11-06). Body-borne, so it is read beside translation
 *    (design D4/FD2), never in the IR.
 *
 * Boundaries this module keeps:
 *  - It takes NO global clock: the callers inject `now`, so tests pin it.
 *  - Absence is unknown. A malformed field drops alone; nothing ever defaults to 0%.
 *  - Nothing here is a limit-reached signal (design FD10): the Claude `-status` header is a
 *    presence gate only, and `x-codex-rate-limit-reached-type` is never read.
 *  - No raw value is copied except an allowlisted scope name.
 *  - It never throws on hostile input. The adapter additionally contains every call (D2).
 */

/** The closed set of usage wire formats the data plane knows (design D1). */
export type PlanUsageDialect = 'anthropic_unified' | 'codex' | 'opencode_go';

export const PLAN_USAGE_DIALECTS: readonly PlanUsageDialect[] = [
  'anthropic_unified',
  'codex',
  'opencode_go',
];

export type PlanUsageSpan = '5h' | 'daily' | 'weekly' | 'monthly' | 'annual';

/** `atMs` is an absolute instant; `inMs` is RELATIVE and anchored on the shared store's clock at
 * the merge, so an instance clock can never move it (spec "A legacy relative reset"). */
export type PlanUsageReset = { readonly atMs: number } | { readonly inMs: number };

/** `extra_usage` is stated; `extra_usage_possible` is an inference (ChatGPT credits); `plan` is
 * the plan; `null` means "this observation says nothing about billing", never "the plan". */
export type PlanUsageBilling = 'plan' | 'extra_usage' | 'extra_usage_possible';

export interface PlanUsageWindow {
  /** Stable merge key: one stored window per key. */
  readonly key: string;
  readonly group: 'account' | 'model';
  readonly span: PlanUsageSpan | null;
  /** The window's length when known, otherwise null. */
  readonly minutes: number | null;
  /** An allowlisted display name (a scoped weekly window, a model bucket), otherwise null. */
  readonly scope: string | null;
  /** Whole percent, 0-100; null when the source gave none (read as `unknown`, never 0%). */
  readonly usedPercent: number | null;
  readonly reset: PlanUsageReset | null;
}

export interface PlanUsageObservation {
  readonly windows: readonly PlanUsageWindow[];
  readonly billing: PlanUsageBilling | null;
}

/** The slice of a response's headers a parser needs. `forEach` is optional (design D2): only the
 * Codex model-bucket discovery uses it, and a fake without it just finds no buckets. */
export interface UsageHeaders {
  get(name: string): string | null;
  forEach?(callback: (value: string, name: string) => void): void;
}

// ---------------------------------------------------------------------------------------------
// Common rules (design D3): every passive and endpoint parser shares these.
// ---------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
/** The slack either side of a window when judging a reset's plausibility. */
export const RESET_SLACK_MS = 10 * MINUTE_MS;
/** The bound for a window of unknown length. */
export const UNKNOWN_WINDOW_MAX_MS = 400 * 24 * 60 * MINUTE_MS;
/** The longest window length kept as `minutes` (an annual window plus a day). */
const MAX_WINDOW_MINUTES = 366 * 24 * 60;

/** A named span's length in minutes (monthly counts as 31 days, annual as 366). */
export const SPAN_MINUTES: Readonly<Record<PlanUsageSpan, number>> = {
  '5h': 300,
  daily: 1440,
  weekly: 10_080,
  monthly: 31 * 1440,
  annual: 366 * 1440,
};

/** The plain decimal grammar: no sign, exponent or hex form. Applied to a trimmed value. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** Trim, then an empty or whitespace-only value is absent. */
export function cleanValue(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim();
  return t === '' ? null : t;
}

/**
 * A finite non-negative decimal number from a header or JSON-string value, or null. A sign,
 * an exponent (`1e12`), a hex form (`0x10`) or anything else is absent; `Number('')` is never
 * reached, so an empty value can never become 0.
 */
export function parseDecimal(raw: string | null | undefined): number | null {
  const t = cleanValue(raw);
  if (t === null || !DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Whole percent, clamped to at most 100 (the grammar already excludes negatives). */
export function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** A window's length in ms: its `minutes`, else its span, else 400 days (design D3). */
export function windowLengthMs(span: PlanUsageSpan | null, minutes: number | null): number {
  if (minutes !== null) return minutes * MINUTE_MS;
  if (span !== null) return SPAN_MINUTES[span] * MINUTE_MS;
  return UNKNOWN_WINDOW_MAX_MS;
}

/** `[now - 10 min, now + L + 10 min]`, or null (the reset becomes unknown, the window stays). */
export function plausibleResetAt(
  atMs: number,
  span: PlanUsageSpan | null,
  minutes: number | null,
  now: number,
): PlanUsageReset | null {
  if (!Number.isFinite(atMs)) return null;
  const length = windowLengthMs(span, minutes);
  return atMs >= now - RESET_SLACK_MS && atMs <= now + length + RESET_SLACK_MS ? { atMs } : null;
}

/** A relative reset must lie in `[0, L + 10 min]`. */
export function plausibleResetIn(
  inMs: number,
  span: PlanUsageSpan | null,
  minutes: number | null,
): PlanUsageReset | null {
  if (!Number.isFinite(inMs)) return null;
  return inMs >= 0 && inMs <= windowLengthMs(span, minutes) + RESET_SLACK_MS ? { inMs } : null;
}

/** A reset in epoch SECONDS (rounded, as Claude Code rounds it), bounded by plausibility. A
 * value in milliseconds in a seconds field lands far beyond the bound and is dropped. */
export function resetFromEpochSeconds(
  raw: string | null | undefined,
  span: PlanUsageSpan | null,
  minutes: number | null,
  now: number,
): PlanUsageReset | null {
  const n = parseDecimal(raw);
  if (n === null) return null;
  return plausibleResetAt(Math.round(n) * 1000, span, minutes, now);
}

/** The named span a window length falls within (the Codex TUI's +-5% match), or null. */
export function bucketOf(minutes: number): PlanUsageSpan | null {
  // The Codex TUI's match: within 5% of a named length.
  const named: readonly (readonly [number, PlanUsageSpan])[] = [
    [300, '5h'],
    [1440, 'daily'],
    [10_080, 'weekly'],
    [43_200, 'monthly'],
    [525_600, 'annual'],
  ];
  for (const [target, span] of named) {
    if (Math.abs(minutes - target) <= target * 0.05) return span;
  }
  return null;
}

/** Two account windows can land on one key (both Codex slots weekly): keep the fuller one. */
export function dedupeByKey(windows: readonly PlanUsageWindow[]): PlanUsageWindow[] {
  const byKey = new Map<string, PlanUsageWindow>();
  for (const w of windows) {
    const seen = byKey.get(w.key);
    if (seen === undefined || (w.usedPercent ?? -1) > (seen.usedPercent ?? -1)) byKey.set(w.key, w);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------------------------
// anthropic_unified
// ---------------------------------------------------------------------------------------------

const CLAUDE_PREFIX = 'anthropic-ratelimit-unified-';

/** The ONLY header names the Claude parser reads (a spy test pins this set). */
const CLAUDE_WINDOWS: readonly {
  readonly header: string;
  readonly key: string;
  readonly span: PlanUsageSpan;
  readonly scope: string | null;
}[] = [
  { header: '5h', key: 'account:5h', span: '5h', scope: null },
  { header: '7d', key: 'account:weekly', span: 'weekly', scope: null },
  // The separate weekly "Fable" window, the label Claude Code 2.1.319 uses.
  { header: '7d_oi', key: 'account:weekly:Fable', span: 'weekly', scope: 'Fable' },
];

/**
 * Claude Pro/Max. Read exactly `-status` (a presence gate only), `-<p>-utilization` (a 0-1
 * fraction) and `-<p>-reset` (epoch seconds) for `5h`, `7d`, `7d_oi`, and `-overage-in-use`.
 * No `-status` header means the limiter did not run: the whole observation is null, never
 * `allowed` and never 0% (Claude Code's own `le()` reads a missing status as allowed; this
 * parser deliberately does not). Billing: `overage-in-use: true` is `extra_usage`; with the
 * status header present anything else is `plan`.
 */
export function parseAnthropicUnified(
  headers: UsageHeaders,
  now: number,
): PlanUsageObservation | null {
  if (cleanValue(headers.get(`${CLAUDE_PREFIX}status`)) === null) return null;

  const windows: PlanUsageWindow[] = [];
  for (const w of CLAUDE_WINDOWS) {
    const utilization = parseDecimal(headers.get(`${CLAUDE_PREFIX}${w.header}-utilization`));
    const minutes = SPAN_MINUTES[w.span];
    const reset = resetFromEpochSeconds(
      headers.get(`${CLAUDE_PREFIX}${w.header}-reset`),
      w.span,
      minutes,
      now,
    );
    const usedPercent = utilization === null ? null : clampPercent(utilization * 100);
    // A window with neither a usable percent nor a usable reset says nothing; drop it.
    if (usedPercent === null && reset === null) continue;
    windows.push({
      key: w.key,
      group: 'account',
      span: w.span,
      minutes,
      scope: w.scope,
      usedPercent,
      reset,
    });
  }

  const overage = cleanValue(headers.get(`${CLAUDE_PREFIX}overage-in-use`));
  const billing: PlanUsageBilling = overage?.toLowerCase() === 'true' ? 'extra_usage' : 'plan';
  return { windows, billing };
}

// ---------------------------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------------------------

const CODEX_BUCKET_NAME = /^x-([a-z0-9-]{1,40})-primary-used-percent$/;
const CODEX_SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;
const MAX_CODEX_BUCKETS = 8;

/** true/false/1/0 (case-insensitive), as Codex parses its credit flags. */
function parseFlag(raw: string | null): boolean | null {
  const t = cleanValue(raw)?.toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return null;
}

interface RawCodexSlot {
  readonly usedPercent: number;
  readonly minutes: number | null;
  readonly reset: PlanUsageReset | null;
}

/**
 * Read one `x-<family>-<slot>-*` window as Codex counts it [V `rate_limits.rs:57-102`]: its
 * used percent parses, and at least one of used != 0, window minutes != 0 or a `reset-at` is
 * present. An all-zero slot with no `reset-at` is no window, never a 0% window.
 */
function readCodexSlot(
  headers: UsageHeaders,
  prefix: string,
  now: number,
): (RawCodexSlot & { readonly span: PlanUsageSpan | null }) | null {
  const used = parseDecimal(headers.get(`${prefix}-used-percent`));
  if (used === null) return null;
  const rawMinutes = parseDecimal(headers.get(`${prefix}-window-minutes`));
  const rawResetAt = headers.get(`${prefix}-reset-at`);
  // A `reset-at` that does not parse is as good as absent (it neither makes the slot count nor
  // blocks the legacy `reset-after-seconds` fallback).
  const hasResetAt = parseDecimal(rawResetAt) !== null;
  const counts = used !== 0 || (rawMinutes !== null && rawMinutes !== 0) || hasResetAt;
  if (!counts) return null;

  const rounded = rawMinutes === null ? null : Math.round(rawMinutes);
  const minutes = rounded !== null && rounded > 0 && rounded <= MAX_WINDOW_MINUTES ? rounded : null;
  const span = minutes === null ? null : bucketOf(minutes);

  let reset: PlanUsageReset | null = null;
  if (hasResetAt) {
    reset = resetFromEpochSeconds(rawResetAt, span, minutes, now);
  } else {
    const legacy = parseDecimal(headers.get(`${prefix}-reset-after-seconds`));
    if (legacy !== null) reset = plausibleResetIn(Math.round(legacy) * 1000, span, minutes);
  }
  return { usedPercent: clampPercent(used), minutes, reset, span };
}

export function accountKey(span: PlanUsageSpan | null, minutes: number | null): string {
  if (span !== null) return `account:${span}`;
  return minutes !== null ? `account:m${String(minutes)}` : 'account:unsized';
}

/**
 * ChatGPT Plus/Pro. Windows are labelled by LENGTH (the +-5% match on 300, 1440, 10080, 43200
 * and 525600 minutes), never by slot, so a Pro account's lone weekly window in the primary slot
 * reads weekly. Each `x-<limit>-primary-used-percent` family other than `codex` becomes a model
 * bucket (primary slot only, at most eight, scoped by an allowlisted `limit-name`). The two
 * credit flags are read (both required, as Codex does); the balance never is.
 *
 * Billing only on a 2xx with at least one account window: `extra_usage_possible` when an
 * account window is at 100% and credits exist, `plan` when every account window is below 100,
 * else null. `x-codex-rate-limit-reached-type` is never read (FD10). No counted window at all
 * is null: Codex's always-present default snapshot is deliberately not ported.
 */
export function parseCodex(
  headers: UsageHeaders,
  status: number,
  now: number,
): PlanUsageObservation | null {
  const account: PlanUsageWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const s = readCodexSlot(headers, `x-codex-${slot}`, now);
    if (s === null) continue;
    account.push({
      key: accountKey(s.span, s.minutes),
      group: 'account',
      span: s.span,
      minutes: s.minutes,
      scope: null,
      usedPercent: s.usedPercent,
      reset: s.reset,
    });
  }

  // Model buckets: discover families by NAME only (the callback never touches a value).
  const families = new Set<string>();
  headers.forEach?.((_value, name) => {
    const m = CODEX_BUCKET_NAME.exec(name.toLowerCase());
    if (m?.[1] !== undefined && m[1] !== 'codex') families.add(m[1]);
  });
  const buckets: PlanUsageWindow[] = [];
  for (const family of [...families].sort()) {
    if (buckets.length >= MAX_CODEX_BUCKETS) break;
    const s = readCodexSlot(headers, `x-${family}-primary`, now);
    if (s === null) continue;
    const id = family.replace(/-/g, '_');
    const name = cleanValue(headers.get(`x-${family}-limit-name`));
    buckets.push({
      key: `model:${id}`,
      group: 'model',
      span: s.span,
      minutes: s.minutes,
      scope: name !== null && CODEX_SCOPE_NAME.test(name) ? name : id,
      usedPercent: s.usedPercent,
      reset: s.reset,
    });
  }

  const accountWindows = dedupeByKey(account);
  if (accountWindows.length === 0 && buckets.length === 0) return null;

  let billing: PlanUsageBilling | null = null;
  if (status >= 200 && status < 300 && accountWindows.length > 0) {
    const hasCredits = parseFlag(headers.get('x-codex-credits-has-credits'));
    const unlimited = parseFlag(headers.get('x-codex-credits-unlimited'));
    const creditsKnown = hasCredits !== null && unlimited !== null;
    const full = accountWindows.some((w) => (w.usedPercent ?? 0) >= 100);
    if (full && creditsKnown && (hasCredits || unlimited)) billing = 'extra_usage_possible';
    else if (!full) billing = 'plan';
  }
  return { windows: [...accountWindows, ...buckets], billing };
}

// ---------------------------------------------------------------------------------------------
// Header dispatch
// ---------------------------------------------------------------------------------------------

/** Parse a response's headers under a header-borne dialect. `opencode_go` is body-borne
 * (`readOpencodeBillingFromJson`, `tapUsageFrames`), so it yields null here. */
export function parsePlanUsageHeaders(
  dialect: PlanUsageDialect,
  res: { readonly status: number; readonly headers: UsageHeaders },
  now: number,
): PlanUsageObservation | null {
  switch (dialect) {
    case 'anthropic_unified':
      return parseAnthropicUnified(res.headers, now);
    case 'codex':
      return parseCodex(res.headers, res.status, now);
    case 'opencode_go':
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// opencode_go (design D4)
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `usage.opencode.billing_source`: `go` and `go-plus` are the plan, `balance` is extra usage
 * billing the account balance, anything else is ignored. `allowance` is never read (it is a
 * per-request dollar delta with no denominator and no reset, FD1). An observation here has no
 * window.
 */
export function readOpencodeBillingFromJson(json: unknown): PlanUsageObservation | null {
  if (!isRecord(json)) return null;
  const usage = json['usage'];
  if (!isRecord(usage)) return null;
  const opencode = usage['opencode'];
  if (!isRecord(opencode)) return null;
  const source = opencode['billing_source'];
  if (source === 'go' || source === 'go-plus') return { windows: [], billing: 'plan' };
  if (source === 'balance') return { windows: [], billing: 'extra_usage' };
  return null;
}

/** The unterminated-line cap. Past it the tap disables itself for the stream. */
export const MAX_TAP_LINE_BYTES = 64 * 1024;

/**
 * Whether a line is over the cap in UTF-8 BYTES. The byte count is never below the string length
 * and each UTF-16 unit is at most 3 bytes, so an ASCII-sized line is decided by length alone and
 * only a line that could be over in bytes is measured.
 */
const overCap = (s: string): boolean =>
  s.length > MAX_TAP_LINE_BYTES ||
  (s.length * 3 > MAX_TAP_LINE_BYTES && Buffer.byteLength(s, 'utf8') > MAX_TAP_LINE_BYTES);

/**
 * A pass-through tap over an SSE string stream. It yields every chunk UNCHANGED and in order, so
 * it can never alter or reorder what the translator sees (it reads each chunk's complete lines
 * just before passing the chunk on, because the last usage frame may share a chunk with the
 * terminator the consumer stops at). It keeps only the current
 * unterminated line (capped at 64 KiB; past the cap it disables itself, without an error), and
 * only a complete `data:` line that mentions `"billing_source"` is `JSON.parse`d, inside a
 * try/catch. The last mapped frame wins; its observation is reported ONCE, when the stream
 * finishes or is abandoned. `onFrame` is contained: it can never throw into the stream.
 */
export async function* tapUsageFrames(
  chunks: AsyncIterable<string>,
  onFrame: (obs: PlanUsageObservation) => void,
): AsyncGenerator<string> {
  let buffer = '';
  let disabled = false;
  let last: PlanUsageObservation | null = null;

  const readLine = (raw: string): void => {
    if (disabled) return;
    if (overCap(raw)) {
      disabled = true;
      return;
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:') || !line.includes('"billing_source"')) return;
    try {
      const obs = readOpencodeBillingFromJson(JSON.parse(line.slice(5).trim()) as unknown);
      if (obs !== null) last = obs;
    } catch {
      // A malformed frame is contained: the stream goes on untouched.
    }
  };

  try {
    for await (const chunk of chunks) {
      // Scan BEFORE yielding. A consumer may stop reading at the stream's terminator
      // (`[DONE]`), and the final usage frame commonly shares a chunk with it: scanning after the
      // yield would never run for that chunk. The scan is synchronous and cheap (only a complete
      // `data:` line that mentions `billing_source` is parsed), and the chunk is yielded
      // UNCHANGED, so translate sees identical bytes either way.
      if (!disabled) {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          readLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
        if (overCap(buffer)) {
          disabled = true;
          buffer = '';
        }
        if (disabled) buffer = '';
      }
      yield chunk;
    }
    // A final line with no trailing newline.
    if (!disabled && buffer !== '') readLine(buffer);
  } finally {
    if (last !== null) {
      try {
        onFrame(last);
      } catch {
        // Contained.
      }
    }
  }
}
