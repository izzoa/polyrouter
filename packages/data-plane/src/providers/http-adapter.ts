/**
 * Shared HTTP provider adapter. Both protocols differ only in endpoint paths,
 * auth headers, the #5 translate adapter, and the models-list shape; everything
 * else — JSON encode/decode, streaming, timeout/cancellation, error mapping —
 * lives here. Consumes #5's IR; defines no response shape (invariant 2).
 */
import { APP_NAME, OPENROUTER_HOST, PROJECT_URL } from '@polyrouter/shared';
import { SsrfError } from '@polyrouter/shared/server';
import type { UpstreamProtocolAdapter } from '../proxy/translate';
import type {
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStreamEvent,
} from '../proxy/translate';
import {
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_MODEL_ID_LEN,
  MAX_PARSED_MODELS,
  type CallContext,
  type ConnectionResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderModelInfo,
  type ProviderProtocol,
} from './adapter';
import {
  CallCancelledError,
  ProviderError,
  captureProviderMessage,
  classifyNetworkError,
  classifyResponse,
  classifyStreamError,
  sanitizeRequestId,
} from './errors';
import {
  createGuardedHttpClient,
  joinUrl,
  openRequest,
  readSseChunks,
  type HttpClient,
  type HttpResponse,
} from './http';

export interface HttpAdapterSpec {
  readonly protocol: ProviderProtocol;
  readonly translate: UpstreamProtocolAdapter;
  readonly chatPath: string;
  /** Optional (add-chatgpt-responses): a protocol without a models endpoint omits BOTH
   * `modelsPath` and `parseModels` — `listModels()` then rejects with a typed,
   * non-tripping error (never an implicit empty list), and `testConnection()` uses
   * `probeRequest` instead of aliasing `listModels()`. */
  readonly modelsPath?: string;
  authHeaders(credential: string): Record<string, string>;
  parseModels?(json: unknown): ProviderModelInfo[];
  /** The designated validating probe for a models-less protocol: a minimal chat
   * request (1 max token) whose model comes from TRUSTED preset-registry data. */
  readonly probeRequest?: NormalizedRequest;
  /** Optional cursor pagination for the models endpoint (e.g. Anthropic's
   * `has_more` + `last_id`). When present, `listModels` follows pages — appending
   * `param=<cursor>` — until `nextCursor` returns null; when absent it fetches once. */
  readonly modelsPagination?: {
    readonly param: string;
    nextCursor(pageJson: unknown): string | null;
  };
}

/** Bound the pagination follow so a hostile/buggy always-`has_more` endpoint (or a
 * cursor that never advances) cannot loop unboundedly; combined with the total
 * `MAX_PARSED_MODELS` cap below it hard-limits the crawl. */
const MAX_MODEL_PAGES = 50;

/** Append a query param, preserving any existing query string. The cursor is
 * provider-supplied, so it is URL-encoded (no injection into the request line). */
function appendQuery(url: string, param: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(param)}=${encodeURIComponent(value)}`;
}

export interface AdapterDeps {
  readonly httpClient?: HttpClient;
}

function errMeta(res: HttpResponse): { requestId?: string } {
  // Strict allowlist (add-request-error-detail): an arbitrary response-header
  // value is never copied verbatim into error metadata.
  const id = sanitizeRequestId(
    res.headers.get('x-request-id') ??
      res.headers.get('request-id') ??
      res.headers.get('anthropic-request-id'),
  );
  return id !== undefined ? { requestId: id } : {};
}

/**
 * Adapter-stage sanitizer (add-request-error-detail): consume each error event's
 * RAW `diagnostic.wire` through the sanitizing factory — the credential lives
 * HERE, so the mandatory exact-credential redaction is possible only here — and
 * yield events carrying ONLY the branded sanitized message (+ the allowlisted
 * response-header request id). No event leaves the adapter with raw wire text.
 * Synthetic events (truncated/incomplete — no `wire`) pass through untouched.
 */
async function* sanitizeStreamErrors(
  events: AsyncGenerator<NormalizedStreamEvent>,
  secrets: readonly string[],
  requestId: string | undefined,
): AsyncGenerator<NormalizedStreamEvent> {
  for await (const ev of events) {
    if (ev.type !== 'error' || ev.diagnostic?.wire === undefined) {
      yield ev;
      continue;
    }
    const wire = ev.diagnostic.wire;
    // Conservative kind (r3-High-1): classify EVERY available field — a generic
    // wire type must not launder a `code=invalid_request_error` into the
    // operational-verbatim path. (The factory re-checks markers itself; this is
    // the belt to its suspenders.)
    const kinds = [wire.type, wire.code, ev.error.type]
      .filter((v): v is string => typeof v === 'string')
      .map(classifyStreamError);
    const providerMessage = captureProviderMessage(
      { source: 'stream-wire', ...wire },
      {
        kind: kinds.includes('bad_request') ? 'bad_request' : (kinds[0] ?? 'unavailable'),
        secrets,
      },
    );
    yield {
      type: 'error',
      error: ev.error,
      diagnostic: {
        ...(providerMessage !== null ? { providerMessage } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      },
    };
  }
}

/** Pass typed errors through; wrap everything unexpected as a network fault.
 * Never inspects the credential. */
function rethrowTyped(err: unknown): never {
  if (
    err instanceof ProviderError ||
    err instanceof CallCancelledError ||
    err instanceof SsrfError
  ) {
    throw err;
  }
  throw classifyNetworkError(err);
}

/**
 * OpenRouter app-attribution headers (add-openrouter-attribution). Returned ONLY when
 * `baseUrl`'s host is exactly `OPENROUTER_HOST` (a single trailing FQDN dot normalized away,
 * so `openrouter.ai.` still matches; an exact match, so a spoofed `…openrouter.ai.evil.com`
 * does not). Guarded: an unparseable URL yields `{}` and never throws — request-time SSRF/URL
 * validation is unaffected. The header names are distinct from `Authorization`/`x-api-key`, so
 * attribution can never combine with or displace authentication regardless of merge order.
 */
export function openRouterAttributionHeaders(baseUrl: string): Record<string, string> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/\.$/, '');
  } catch {
    return {};
  }
  return host === OPENROUTER_HOST
    ? { 'HTTP-Referer': PROJECT_URL, 'X-OpenRouter-Title': APP_NAME }
    : {};
}

/** Fixed headroom the dispatcher timeouts sit ABOVE the typed bounds — undici
 * must only ever be a backstop, never the binding constraint (E1.3, one layer
 * down; fix-long-call-timeouts). */
export const DISPATCHER_MARGIN_MS = 5_000;

/** Ceiling stand-in for core's stream bound when the caller didn't supply it:
 * first-byte + the config schema's maximum event margin (60s) — always ≥ the
 * real derived bound, so undici can never beat the typed stream watchdog. */
const MAX_EVENT_MARGIN_MS = 60_000;

/** Derive the dispatcher's explicit timeouts from the effective typed bounds
 * (fix-long-call-timeouts). Headers must clear the first-byte timer; body (a
 * socket-level inter-chunk timer shared by BOTH paths) must clear the wider of
 * the buffered idle bound and the stream first/inter-event bound. Pure —
 * unit-tested directly. */
export function dispatcherTimeouts(
  firstByteTimeoutMs: number,
  idleTimeoutMs: number,
  streamEventTimeoutMs?: number,
): { headersTimeoutMs: number; bodyTimeoutMs: number } {
  const streamBound = streamEventTimeoutMs ?? firstByteTimeoutMs + MAX_EVENT_MARGIN_MS;
  return {
    headersTimeoutMs: firstByteTimeoutMs + DISPATCHER_MARGIN_MS,
    bodyTimeoutMs: Math.max(idleTimeoutMs, streamBound) + DISPATCHER_MARGIN_MS,
  };
}

export function createHttpProviderAdapter(
  config: ProviderConfig,
  deps: AdapterDeps,
  spec: HttpAdapterSpec,
): ProviderAdapter {
  const firstByteTimeoutMs = config.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  // Inter-chunk idle deadline for buffered drains (E4.3). Defaults to the
  // first-byte bound; applied to non-streaming reads only (the stream path is
  // bounded by core's per-event timeout).
  const idleTimeoutMs = config.idleTimeoutMs ?? firstByteTimeoutMs;
  // Byte cap on buffered (non-streaming) drains (E11.1); streaming is exempt. Also
  // handed to the default guarded client so a stream request's buffered *error*
  // body honors the same cap (not just the 10 MiB backstop).
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const dispatcher = dispatcherTimeouts(
    firstByteTimeoutMs,
    idleTimeoutMs,
    config.streamEventTimeoutMs,
  );
  const httpClient =
    deps.httpClient ??
    createGuardedHttpClient({
      mode: config.mode,
      providerKind: config.kind,
      maxResponseBytes,
      headersTimeoutMs: dispatcher.headersTimeoutMs,
      bodyTimeoutMs: dispatcher.bodyTimeoutMs,
    });
  const chatUrl = joinUrl(config.baseUrl, spec.chatPath);
  const modelsUrl = spec.modelsPath !== undefined ? joinUrl(config.baseUrl, spec.modelsPath) : null;
  // Computed once — base_url is fixed per adapter (add-openrouter-attribution).
  const attribution = openRouterAttributionHeaders(config.baseUrl);

  const headers = (json: boolean, sse: boolean): Record<string, string> => ({
    ...attribution, // spread first (lowest); safety is by distinct names, not precedence
    ...(config.extraHeaders ?? {}),
    ...spec.authHeaders(config.credential),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(sse ? { Accept: 'text/event-stream' } : {}),
  });

  async function chat(request: NormalizedRequest, ctx?: CallContext): Promise<NormalizedResponse> {
    try {
      const body = JSON.stringify(spec.translate.requestOut({ ...request, stream: false }));
      const { res, dispose } = await openRequest(
        httpClient,
        chatUrl,
        { method: 'POST', headers: headers(true, false), body },
        firstByteTimeoutMs,
        ctx,
        idleTimeoutMs,
        maxResponseBytes,
      );
      try {
        if (!res.ok) {
          throw classifyResponse(res.status, await res.text(), errMeta(res), [config.credential]);
        }
        return spec.translate.responseIn(await res.json());
      } finally {
        dispose();
      }
    } catch (err) {
      rethrowTyped(err);
    }
  }

  async function* chatStream(
    request: NormalizedRequest,
    ctx?: CallContext,
  ): AsyncGenerator<NormalizedStreamEvent> {
    let opened;
    try {
      const body = JSON.stringify(spec.translate.requestOut({ ...request, stream: true }));
      opened = await openRequest(
        httpClient,
        chatUrl,
        { method: 'POST', headers: headers(true, true), body },
        firstByteTimeoutMs,
        ctx,
      );
    } catch (err) {
      rethrowTyped(err);
    }
    const { res, dispose } = opened;
    try {
      if (!res.ok) {
        throw classifyResponse(res.status, await res.text(), errMeta(res), [config.credential]);
      }
      // Adapter-stage error-detail sanitization (add-request-error-detail): THIS
      // layer holds the credential, so raw wire fields must not leave it.
      yield* sanitizeStreamErrors(
        spec.translate.streamParse(readSseChunks(res, ctx?.onBytes)),
        [config.credential],
        errMeta(res).requestId,
      );
    } catch (err) {
      rethrowTyped(err);
    } finally {
      dispose();
    }
  }

  async function listModels(ctx?: CallContext): Promise<ProviderModelInfo[]> {
    if (modelsUrl === null || spec.parseModels === undefined) {
      // Explicitly unsupported (never an implicit empty list); bad_request is
      // non-tripping and non-fallback — a deliberate "this surface does not exist".
      throw new ProviderError('bad_request', 'model listing is not supported for this provider');
    }
    try {
      const all: ProviderModelInfo[] = [];
      const seen = new Set<string>(); // dedup ids across pages
      const seenCursors = new Set<string>(); // detect a stuck/cycling cursor
      let cursor: string | null = null;
      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const url =
          cursor === null
            ? modelsUrl
            : appendQuery(modelsUrl, spec.modelsPagination!.param, cursor);
        const { res, dispose } = await openRequest(
          httpClient,
          url,
          { method: 'GET', headers: headers(false, false) },
          firstByteTimeoutMs,
          ctx,
          idleTimeoutMs,
          maxResponseBytes,
        );
        try {
          if (!res.ok) {
            throw classifyResponse(res.status, await res.text(), errMeta(res), [config.credential]);
          }
          const json = await res.json();
          for (const m of spec.parseModels(json)) {
            if (all.length >= MAX_PARSED_MODELS) return all; // total cap across pages
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            all.push(m);
          }
          // No pagination hook → single-page provider (e.g. OpenAI): done after one fetch.
          if (spec.modelsPagination === undefined) return all;
          // Cap reached exactly at a page boundary: stop HERE so a `has_more` doesn't
          // fetch (and possibly fail on) a page we'd discard anyway.
          if (all.length >= MAX_PARSED_MODELS) return all;
          const next = spec.modelsPagination.nextCursor(json);
          // Done, or a stuck/repeating cursor (a buggy/hostile endpoint) — stop rather
          // than issue redundant requests until the page bound.
          if (next === null || seenCursors.has(next)) return all;
          seenCursors.add(next);
          cursor = next;
        } finally {
          dispose();
        }
      }
      return all; // page-count safety bound reached — return what we have (bounded)
    } catch (err) {
      rethrowTyped(err);
    }
  }

  async function testConnection(ctx?: CallContext): Promise<ConnectionResult> {
    try {
      if (spec.modelsPath === undefined) {
        if (spec.probeRequest === undefined) {
          throw new ProviderError('credential', 'no validating probe configured');
        }
        // The designated 1-token probe: a revoked/invalid credential surfaces as a
        // typed auth failure exactly like any other action — never masked.
        await chat(spec.probeRequest, ctx);
        return { ok: true, models: 0 };
      }
      const models = await listModels(ctx);
      return { ok: true, models: models.length };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, kind: err.kind, message: err.message };
      if (err instanceof CallCancelledError) {
        return { ok: false, kind: 'unavailable', message: 'call cancelled' };
      }
      if (err instanceof SsrfError) return { ok: false, kind: 'unavailable', message: err.message };
      return { ok: false, kind: 'unavailable', message: 'connection failed' };
    }
  }

  return { protocol: spec.protocol, chat, chatStream, listModels, testConnection };
}

const PER_MILLION = 1_000_000;

/** Parse a USD amount that a provider may send as a number or a decimal string
 * (OpenRouter sends per-token USD as strings). Empty/non-numeric/non-finite → undefined. */
function toUsdNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Parse an OpenRouter-style `pricing` extension into a per-1M USD DISPLAY estimate
 * (add-provider-price-sync-and-edit) — NEVER a billing source (invariant 4). Reads only
 * the per-token `prompt`/`completion` rates (×1e6); every other charge dimension
 * (`request`/`image`/reasoning/web-search) is ignored for the displayed rate. Defensive:
 * a missing, non-finite, or negative prompt/completion omits the whole block (never a
 * wrong number). `isFree` is set ONLY when EVERY monetary field the provider lists parses
 * to zero — so a zero-token model with a per-request/image charge is `$0`, not free.
 */
function parseListedPricing(rec: Record<string, unknown>): ProviderModelInfo['pricing'] {
  const pricing = rec['pricing'];
  if (typeof pricing !== 'object' || pricing === null) return undefined;
  const p = pricing as Record<string, unknown>;
  const prompt = toUsdNumber(p['prompt']);
  const completion = toUsdNumber(p['completion']);
  if (prompt === undefined || completion === undefined || prompt < 0 || completion < 0) {
    return undefined; // input+output must both resolve non-negative, else omit the block
  }
  let allZero = true;
  for (const v of Object.values(p)) {
    const n = toUsdNumber(v);
    if (n === undefined || n !== 0) {
      allZero = false; // an unparseable or non-zero dimension means freeness is not proven
      break;
    }
  }
  const rawInput = prompt * PER_MILLION;
  const rawOutput = completion * PER_MILLION;
  // Guard the scaling itself: a huge per-token value can overflow to Infinity (which
  // would serialize to JSON null / reach the DB as a bad value) — omit rather than emit it.
  if (!Number.isFinite(rawInput) || !Number.isFinite(rawOutput)) return undefined;
  // Normalize the ×1e6 float noise at the boundary (0.0000002 × 1e6 =
  // 0.19999999999999998): 12 significant digits preserves every real price and
  // stores the clean value ("0.2"), not the artifact.
  return {
    inputPricePer1m: Number(rawInput.toPrecision(12)),
    outputPricePer1m: Number(rawOutput.toPrecision(12)),
    ...(allZero ? { isFree: true } : {}),
  };
}

/**
 * Parse a `{ data: [{ id, <displayKey?> }] }` model list into ProviderModelInfo[].
 * Skips entries with a non-string, over-long (`> MAX_MODEL_ID_LEN`), or duplicate
 * id **before** counting toward `MAX_PARSED_MODELS` (E11.1) — so a flood of junk or
 * repeated ids from an address-safe-but-hostile endpoint can't consume the parse
 * budget and starve out the legitimate ids that follow. An OpenRouter-style per-model
 * `pricing` block, when present, is parsed into an optional per-1M USD display estimate
 * (aggregators carry it; native OpenAI/Anthropic do not, so it stays absent).
 */
export function parseModelList(json: unknown, displayKey?: string): ProviderModelInfo[] {
  const data = typeof json === 'object' && json !== null && 'data' in json ? json.data : undefined;
  if (!Array.isArray(data)) return [];
  const out: ProviderModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of data as unknown[]) {
    if (out.length >= MAX_PARSED_MODELS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id !== 'string') continue;
    if (id.length > MAX_MODEL_ID_LEN) continue; // skip before it consumes the cap
    if (seen.has(id)) continue; // dedup before the cap: a repeat can't starve valids
    seen.add(id);
    const display = displayKey !== undefined ? rec[displayKey] : undefined;
    const pricing = parseListedPricing(rec);
    out.push({
      id,
      ...(typeof display === 'string' ? { displayName: display } : {}),
      ...(pricing !== undefined ? { pricing } : {}),
    });
  }
  return out;
}
