/**
 * Framework-agnostic proxy engine (#10). Given a resolved #6 `ProviderAdapter`,
 * the client-protocol #5 `ProtocolAdapter`, and the normalized request, it runs
 * the call and translates the reply — with the invariant-3 mid-stream commit
 * boundary encapsulated in `openStream`. No HTTP, no DB, no Nest; the control
 * plane loads config, decrypts credentials, and pumps the frames to Express.
 */
import type { ProtocolAdapter, NormalizedRequest, NormalizedStreamEvent } from './translate';
import { ProviderError, classifyStreamError, type ProviderAdapter } from '../providers';
import { terminalErrorFrame } from './stream-error';

export interface ProxyStreamOptions {
  readonly signal?: AbortSignal;
  /** Bound on EACH upstream event wait (#6 clears its first-byte timer at
   * headers and has no inter-event timer), so a stalled 200 can't hang. */
  readonly firstEventTimeoutMs: number;
  /** Unix seconds for OpenAI `created` when the IR lacks it. */
  readonly created: number;
}

export type OpenStreamResult =
  | { readonly kind: 'error'; readonly error: ProviderError }
  | { readonly kind: 'stream'; readonly frames: AsyncGenerator<string> };

/** A generic, sanitized message for a committed-stream failure. */
const MID_STREAM_MESSAGE = 'the upstream model failed mid-stream';

function toProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError('unavailable', 'upstream request failed');
}

/** Map an in-band IR error event to a typed, sanitized ProviderError so the
 * status (429/502/400/404/503) survives — never the raw upstream message. */
function fromErrorEvent(ev: Extract<NormalizedStreamEvent, { type: 'error' }>): ProviderError {
  return new ProviderError(classifyStreamError(ev.error.type), 'upstream stream error');
}

/** Non-streaming: call the provider and serialize the IR to the client wire. */
export async function runBuffered(
  provider: ProviderAdapter,
  client: ProtocolAdapter,
  request: NormalizedRequest,
  ctx: { created: number },
): Promise<unknown> {
  const ir = await provider.chat(request);
  return client.responseOut(ir, { created: ctx.created });
}

/**
 * Commit-gated stream. Resolves BEFORE the client is committed: `{kind:'error'}`
 * if the upstream throws, times out, produces nothing, or yields an error event
 * first (nothing written yet — the caller returns a clean HTTP error). Otherwise
 * `{kind:'stream'}` with a frame generator that re-emits the buffered first event
 * and continues; a later failure is written as a sanitized terminal error frame,
 * never a model swap. An internal AbortController (composed with the caller's
 * signal) lets a timeout actually cancel the upstream, and every pre-commit exit
 * cancels the iterator.
 */
export async function openStream(
  provider: ProviderAdapter,
  client: ProtocolAdapter,
  request: NormalizedRequest,
  opts: ProxyStreamOptions,
): Promise<OpenStreamResult> {
  const abort = new AbortController();
  const onCallerAbort = (): void => abort.abort();
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const iterator = provider.chatStream(request, { signal: abort.signal })[Symbol.asyncIterator]();
  const cleanup = async (): Promise<void> => {
    abort.abort(); // cancel the upstream so a pending next() settles before return()
    opts.signal?.removeEventListener('abort', onCallerAbort);
    try {
      await iterator.return?.(undefined);
    } catch {
      // best-effort; the dispatcher release runs in the generator's finally.
    }
  };

  let first: IteratorResult<NormalizedStreamEvent>;
  try {
    first = await nextWithTimeout(iterator, opts.firstEventTimeoutMs, abort);
  } catch (err) {
    await cleanup();
    return { kind: 'error', error: toProviderError(err) };
  }
  if (first.done) {
    await cleanup();
    return {
      kind: 'error',
      error: new ProviderError('unavailable', 'upstream produced no output'),
    };
  }
  if (first.value.type === 'error') {
    await cleanup();
    return { kind: 'error', error: fromErrorEvent(first.value) };
  }

  const frames = buildFrames(client, iterator, first.value, opts, abort, cleanup);
  return { kind: 'stream', frames };
}

/**
 * `iterator.next()` bounded by `ms`. On timeout it aborts the (composed)
 * controller — which cancels the undici request so the pending `next()` settles
 * — then throws. Structured so the losing promise never becomes an unhandled
 * rejection, and so `iterator.return()` afterwards can't queue behind a
 * never-settling `next()`.
 */
async function nextWithTimeout(
  iterator: AsyncIterator<NormalizedStreamEvent>,
  ms: number,
  abort: AbortController,
): Promise<IteratorResult<NormalizedStreamEvent>> {
  const nextP = iterator.next();
  const settled = nextP.then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const winner = await Promise.race([settled, timed]);
  if (timer) clearTimeout(timer);
  if (winner === 'timeout') {
    abort.abort();
    await nextP.catch(() => undefined); // let the aborted read settle
    throw new ProviderError('unavailable', 'upstream event timeout');
  }
  if (!winner.ok) throw winner.e;
  return winner.r;
}

async function* buildFrames(
  client: ProtocolAdapter,
  iterator: AsyncIterator<NormalizedStreamEvent>,
  firstValue: NormalizedStreamEvent,
  opts: ProxyStreamOptions,
  abort: AbortController,
  cleanup: () => Promise<void>,
): AsyncGenerator<string> {
  try {
    for await (const frame of client.streamSerialize(
      replay(iterator, firstValue, opts.firstEventTimeoutMs, abort),
      { created: opts.created },
    )) {
      yield frame;
    }
    // Clean completion — #5 already emitted the protocol terminator ([DONE] /
    // message_stop) because a message_stop event reached it.
  } catch {
    // A mid-stream failure propagated out of replay() BEFORE any terminator
    // (message_stop was never forwarded), so no terminator was emitted; emit a
    // sanitized terminal error frame in its place. Never a model swap.
    yield terminalErrorFrame(client.protocol, MID_STREAM_MESSAGE);
  } finally {
    await cleanup();
  }
}

/**
 * Re-emit the buffered first event, then forward the rest (each bounded by the
 * per-event timeout). A mid-stream error — the upstream throwing OR yielding an
 * IR `error` event — is turned into a THROW so it propagates out of
 * `streamSerialize` before its terminator; `buildFrames` catches it and writes
 * the terminal error frame. `message_stop` passes through for a clean close.
 */
async function* replay(
  iterator: AsyncIterator<NormalizedStreamEvent>,
  firstValue: NormalizedStreamEvent,
  ms: number,
  abort: AbortController,
): AsyncGenerator<NormalizedStreamEvent> {
  yield firstValue;
  for (;;) {
    const r = await nextWithTimeout(iterator, ms, abort);
    if (r.done) return;
    if (r.value.type === 'error') throw fromErrorEvent(r.value);
    yield r.value;
  }
}
