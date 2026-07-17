// E4.3: a buffered upstream read that stalls after headers is bound by an
// inter-chunk idle deadline (`config.idleTimeoutMs`), failing with a tripping,
// fallback-eligible `unavailable` error instead of hanging on undici's ~300s
// body timeout. The idle failure trips the breaker; a genuine caller abort during
// the same buffered read stays neutral.
import { createOpenaiProviderAdapter } from './openai-adapter';
import {
  CircuitBreaker,
  InMemoryBreakerStore,
  withBreaker,
  type BreakerConfig,
} from './breaker';
import { ProviderCircuitOpenError, ProviderError } from './errors';
import type { HttpClient, HttpResponse } from './http';
import type { NormalizedRequest } from '../proxy/translate';

const IDLE_MS = 40;
const config = {
  protocol: 'openai_compatible' as const,
  baseUrl: 'https://api.openai.example/v1',
  credential: 'sk-secret',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
  firstByteTimeoutMs: 5_000, // headers arrive instantly from the fake; won't fire
  idleTimeoutMs: IDLE_MS,
};

const request: NormalizedRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A 200 response whose body emits one chunk then stalls forever — the classic
 * "headers then wedged body". Optionally errors its read when `signal` aborts
 * (simulating undici honoring the abort) for the caller-cancel case. */
function stallingResponse(signal?: AbortSignal): HttpResponse {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = (): void =>
        controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    },
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(enc('{"partial":')); // one chunk, then...
        return undefined;
      }
      return new Promise<void>(() => {}); // ...never resolves (stall)
    },
  });
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body,
    text: () => Promise.resolve('overridden-by-guard'),
    json: () => Promise.resolve({}),
  };
}

function adapterWith(responder: (signal?: AbortSignal) => HttpResponse): ReturnType<typeof createOpenaiProviderAdapter> {
  const client: HttpClient = (_url, init) => Promise.resolve(responder(init.signal));
  return createOpenaiProviderAdapter(config, { httpClient: client });
}

describe('E4.3 — buffered idle deadline', () => {
  it('a stalled buffered chat fails `unavailable` within the idle bound (not a 300s hang)', async () => {
    const adapter = adapterWith(() => stallingResponse());
    const started = Date.now();
    await expect(adapter.chat(request)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'unavailable',
    });
    expect(Date.now() - started).toBeLessThan(2_000); // bounded, not undici's ~300s
  });

  it('a stalled listModels is bounded the same way (all buffered reads, not just chat)', async () => {
    const adapter = adapterWith(() => stallingResponse());
    await expect(adapter.listModels()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('a body that completes within the idle bound still succeeds (no false trip)', async () => {
    // A normal JSON body streams and closes promptly — the guard never fires.
    const ok = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const client: HttpClient = () =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc(JSON.stringify(ok)));
            c.close();
          },
        }),
        text: () => Promise.resolve(JSON.stringify(ok)),
        json: () => Promise.resolve(ok),
      });
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const res = await adapter.chat(request);
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('E4.3 — the idle failure trips the breaker; a caller abort stays neutral', () => {
  const cfg: BreakerConfig = { threshold: 1, cooldownMs: 60_000, probeLeaseMs: 200, stateTtlMs: 60_000 };

  it('an idle-timeout is a tripping failure (breaker opens)', async () => {
    const adapter = adapterWith(() => stallingResponse());
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    // Client present (predicate false): a system-imposed idle timeout must trip.
    await expect(
      withBreaker(breaker, 'p', () => adapter.chat(request), undefined, undefined, () => false),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    // threshold 1 → open now; a follow-up is skipped.
    await expect(
      withBreaker(breaker, 'p', () => Promise.resolve('x')),
    ).rejects.toBeInstanceOf(ProviderCircuitOpenError);
  });

  it('a genuine caller abort during the buffered body read stays neutral', async () => {
    const ctl = new AbortController();
    const adapter = adapterWith((signal) => stallingResponse(signal));
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { config: cfg });
    // Abort the caller shortly after the read parks (well before the idle bound).
    const timer = setTimeout(() => ctl.abort(), 10);
    await expect(
      withBreaker(
        breaker,
        'p2',
        () => adapter.chat(request, { signal: ctl.signal }),
        undefined,
        undefined,
        () => ctl.signal.aborted, // the client actually went away
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    clearTimeout(timer);
    // Neutral: threshold-1 breaker still admits (never tripped by a client disconnect).
    await expect(withBreaker(breaker, 'p2', () => Promise.resolve('x'))).resolves.toBe('x');
  });
});
