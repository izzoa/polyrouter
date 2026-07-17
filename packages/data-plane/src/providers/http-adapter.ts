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
  const httpClient =
    deps.httpClient ?? createGuardedHttpClient({ mode: config.mode, providerKind: config.kind });
  const firstByteTimeoutMs = config.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  // Inter-chunk idle deadline for buffered drains (E4.3). Defaults to the
  // first-byte bound; applied to non-streaming reads only (the stream path is
  // bounded by core's per-event timeout).
  const idleTimeoutMs = config.idleTimeoutMs ?? firstByteTimeoutMs;
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
      const { res, dispose } = await openRequest(
        httpClient,
        modelsUrl,
        { method: 'GET', headers: headers(false, false) },
        firstByteTimeoutMs,
        ctx,
        idleTimeoutMs,
      );
      try {
        if (!res.ok) {
          throw classifyResponse(res.status, await res.text(), errMeta(res));
        }
        return spec.parseModels(await res.json());
      } finally {
        dispose();
      }
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

/** Parse a `{ data: [{ id, <displayKey?> }] }` model list into ProviderModelInfo[]. */
export function parseModelList(json: unknown, displayKey?: string): ProviderModelInfo[] {
  const data = typeof json === 'object' && json !== null && 'data' in json ? json.data : undefined;
  if (!Array.isArray(data)) return [];
  const out: ProviderModelInfo[] = [];
  for (const entry of data as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id !== 'string') continue;
    const display = displayKey !== undefined ? rec[displayKey] : undefined;
    out.push({ id, ...(typeof display === 'string' ? { displayName: display } : {}) });
  }
  return out;
}
