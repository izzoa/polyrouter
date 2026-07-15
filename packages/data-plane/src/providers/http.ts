/**
 * The SSRF-guarded HTTP seam. It deliberately does NOT use #4's `guardedFetch`:
 * that helper awaits `dispatcher.close()` in a `finally` before returning, and a
 * graceful close waits for the in-flight body — so an open SSE response would
 * hang it and no body would reach the stream parser. Instead we compose #4's
 * exported primitives (`assertUrlSafe` + `createGuardedDispatcher`) with undici's
 * own version-matched `fetch`, reject redirects, and tie the dispatcher's
 * lifetime to the response body (closed on end/error/cancel; immediately if
 * bodyless). Ownership is exactly-once: every pre-return failure path closes the
 * dispatcher itself, and once a body is handed back the wrapper owns cleanup.
 */
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  SsrfError,
  assertUrlSafe,
  createGuardedDispatcher,
  type UrlGuardOptions,
} from '@polyrouter/shared/server';
import type { CallContext, RuntimeMode, ProviderKind } from './adapter';
import { CallCancelledError, ProviderError } from './errors';

export interface HttpInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** Minimal structural response — satisfied by a global `Response` and by our
 * test fakes; keeps the seam free of undici-vs-global `Response` type friction. */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type HttpClient = (url: string, init: HttpInit) => Promise<HttpResponse>;

export interface GuardedClientOptions {
  readonly mode: RuntimeMode;
  readonly providerKind: ProviderKind;
  /** Injected in tests to drive connect-time (rebinding) refusal. */
  readonly resolve?: (hostname: string) => Promise<string[]>;
}

function guardOptions(o: GuardedClientOptions): UrlGuardOptions {
  return {
    context: { mode: o.mode, providerKind: o.providerKind },
    ...(o.resolve !== undefined ? { resolve: o.resolve } : {}),
  };
}

async function drainText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Wrap the upstream body so the dispatcher closes exactly once when the body
 * ends, errors, or is cancelled. Bodyless responses close immediately. */
function bindDispatcherToBody(res: Response, dispatcher: Dispatcher): HttpResponse {
  const upstream: ReadableStream<Uint8Array> | null = res.body;
  let closePromise: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    if (closePromise === undefined) closePromise = dispatcher.close().catch(() => undefined);
    return closePromise;
  };
  if (upstream === null) {
    void closeOnce();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      body: null,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    };
  }
  const reader = upstream.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          void closeOnce();
          return;
        }
        controller.enqueue(result.value);
      } catch (err) {
        controller.error(err);
        void closeOnce();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await closeOnce();
    },
  });
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    body: wrapped,
    text: () => drainText(wrapped),
    json: async () => JSON.parse(await drainText(wrapped)) as unknown,
  };
}

export function createGuardedHttpClient(options: GuardedClientOptions): HttpClient {
  const opts = guardOptions(options);
  return async (url, init) => {
    // Name-time gate (scheme/format + resolved-IP); may throw before any dispatcher exists.
    await assertUrlSafe(url, opts);
    const dispatcher = createGuardedDispatcher(opts);
    let res: Response;
    try {
      res = await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        redirect: 'manual',
        dispatcher,
      });
    } catch (err) {
      await dispatcher.close().catch(() => undefined);
      if (err instanceof TypeError && err.cause instanceof SsrfError) throw err.cause;
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      throw new ProviderError(
        'unavailable',
        `provider redirected (${String(res.status)}) — configure the canonical endpoint`,
        { status: res.status },
      );
    }
    return bindDispatcherToBody(res, dispatcher);
  };
}

/** Decode an SSE byte body into string chunks through ONE persistent decoder so
 * a multibyte UTF-8 character split across chunk boundaries is not corrupted.
 * (#5's `sseFrames` reassembles the frames.) */
export async function* readSseChunks(res: HttpResponse): AsyncGenerator<string> {
  const body = res.body;
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    // On an early consumer cancel, propagate cancellation so the wrapped body
    // closes the guarded dispatcher (no leaked connection).
    await reader.cancel().catch(() => undefined);
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

export interface OpenedRequest {
  readonly res: HttpResponse;
  /** Tear down the caller-abort wiring; call when the call/stream completes. */
  readonly dispose: () => void;
}

/**
 * Open a request with a first-byte timeout composed with the caller's signal.
 * The timeout aborts if no response headers arrive in time; it is disarmed once
 * headers arrive, so it never becomes an overall stream deadline. Caller-abort
 * stays wired for the body's lifetime (a mid-stream caller cancel aborts the
 * request) and is surfaced as `CallCancelledError` (breaker-neutral).
 */
export async function openRequest(
  httpClient: HttpClient,
  url: string,
  init: Omit<HttpInit, 'signal'>,
  firstByteTimeoutMs: number,
  ctx?: CallContext,
): Promise<OpenedRequest> {
  // A signal already aborted before we attach the listener would never fire it,
  // so the call would start anyway; honor it up front (a fallback walk aborts
  // during breaker admission / adapter build).
  if (ctx?.signal?.aborted) throw new CallCancelledError();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, firstByteTimeoutMs);
  const onCallerAbort = (): void => ctl.abort();
  ctx?.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const dispose = (): void => {
    ctx?.signal?.removeEventListener('abort', onCallerAbort);
  };
  try {
    const res = await httpClient(url, { ...init, signal: ctl.signal });
    clearTimeout(timer); // disarm: headers arrived (first byte)
    return { res, dispose };
  } catch (err) {
    clearTimeout(timer);
    if (ctx?.signal?.aborted) {
      dispose();
      throw new CallCancelledError();
    }
    if (timedOut) {
      dispose();
      throw new ProviderError('unavailable', 'provider first-byte timeout');
    }
    dispose();
    throw err;
  }
}
