/**
 * Shared HTTP provider adapter. Both protocols differ only in endpoint paths,
 * auth headers, the #5 translate adapter, and the models-list shape; everything
 * else — JSON encode/decode, streaming, timeout/cancellation, error mapping —
 * lives here. Consumes #5's IR; defines no response shape (invariant 2).
 */
import { SsrfError } from '@polyrouter/shared/server';
import type { ProtocolAdapter } from '../proxy/translate';
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
  classifyNetworkError,
  classifyResponse,
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
  readonly translate: ProtocolAdapter;
  readonly chatPath: string;
  readonly modelsPath: string;
  authHeaders(credential: string): Record<string, string>;
  parseModels(json: unknown): ProviderModelInfo[];
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
  const id =
    res.headers.get('x-request-id') ??
    res.headers.get('request-id') ??
    res.headers.get('anthropic-request-id');
  return id !== null ? { requestId: id } : {};
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
  const httpClient =
    deps.httpClient ??
    createGuardedHttpClient({ mode: config.mode, providerKind: config.kind, maxResponseBytes });
  const chatUrl = joinUrl(config.baseUrl, spec.chatPath);
  const modelsUrl = joinUrl(config.baseUrl, spec.modelsPath);

  const headers = (json: boolean, sse: boolean): Record<string, string> => ({
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
          throw classifyResponse(res.status, await res.text(), errMeta(res));
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
        throw classifyResponse(res.status, await res.text(), errMeta(res));
      }
      yield* spec.translate.streamParse(readSseChunks(res));
    } catch (err) {
      rethrowTyped(err);
    } finally {
      dispose();
    }
  }

  async function listModels(ctx?: CallContext): Promise<ProviderModelInfo[]> {
    try {
      const all: ProviderModelInfo[] = [];
      const seen = new Set<string>(); // dedup ids across pages
      const seenCursors = new Set<string>(); // detect a stuck/cycling cursor
      let cursor: string | null = null;
      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const url = cursor === null ? modelsUrl : appendQuery(modelsUrl, spec.modelsPagination!.param, cursor);
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
            throw classifyResponse(res.status, await res.text(), errMeta(res));
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

/**
 * Parse a `{ data: [{ id, <displayKey?> }] }` model list into ProviderModelInfo[].
 * Skips entries with a non-string, over-long (`> MAX_MODEL_ID_LEN`), or duplicate
 * id **before** counting toward `MAX_PARSED_MODELS` (E11.1) — so a flood of junk or
 * repeated ids from an address-safe-but-hostile endpoint can't consume the parse
 * budget and starve out the legitimate ids that follow.
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
    out.push({ id, ...(typeof display === 'string' ? { displayName: display } : {}) });
  }
  return out;
}
