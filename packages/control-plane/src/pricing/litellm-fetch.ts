/**
 * SSRF-guarded fetch of the live LiteLLM pricing JSON (#8, §7.7). Uses #4's
 * exported `assertUrlSafe` + `createGuardedDispatcher` + undici's own `fetch`
 * (NOT the auto-closing `guardedFetch`, which can hang on a ~MB body before it
 * drains). Hard limits: no loopback exception (providerKind unset), 3xx
 * rejected, an AbortSignal timeout, and a streaming max-body-size cap. On any
 * failure the body is cancelled and the dispatcher closed before throwing.
 */
import { fetch as undiciFetch } from 'undici';
import {
  SsrfError,
  assertUrlSafe,
  createGuardedDispatcher,
  type UrlGuardOptions,
} from '@polyrouter/shared/server';

export interface LiteLlmFetchOptions {
  readonly mode: 'selfhosted' | 'cloud';
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Injected in tests to drive connect-time (rebinding) refusal. */
  readonly resolve?: (hostname: string) => Promise<string[]>;
}

export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('pricing refresh: response exceeds the max size cap');
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchLiteLlmCatalog(
  url: string,
  opts: LiteLlmFetchOptions,
): Promise<unknown> {
  const guard: UrlGuardOptions = {
    context: { mode: opts.mode }, // providerKind unset → NO loopback exception
    ...(opts.resolve !== undefined ? { resolve: opts.resolve } : {}),
  };
  await assertUrlSafe(url, guard);
  const dispatcher = createGuardedDispatcher(guard);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await undiciFetch(url, {
        method: 'GET',
        redirect: 'manual',
        dispatcher,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof TypeError && err.cause instanceof SsrfError) throw err.cause;
      throw err;
    }
    if (res.status >= 300) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`pricing refresh: unexpected status ${String(res.status)}`);
    }
    const text = await readCapped(res.body, opts.maxBytes);
    return JSON.parse(text) as unknown; // bounded parse; no content-type requirement
  } finally {
    clearTimeout(timer);
    await dispatcher.close().catch(() => undefined);
  }
}
