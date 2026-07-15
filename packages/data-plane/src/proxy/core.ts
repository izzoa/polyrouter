/**
 * Framework-agnostic proxy engine (#10) + usage capture for recording (#11).
 * Given a resolved #6 `ProviderAdapter`, the client-protocol #5 `ProtocolAdapter`,
 * and the normalized request, it runs the call and translates the reply — with
 * the invariant-3 mid-stream commit boundary in `openStream`, and a side-channel
 * `StreamOutcome`/response so the control plane can record tokens without
 * buffering the body. No HTTP, no DB, no Nest.
 */
import {
  mergePartialUsage,
  type ProtocolAdapter,
  type NormalizedRequest,
  type NormalizedResponse,
  type NormalizedStreamEvent,
  type PartialUsage,
} from './translate';
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

/** Captured usage for #11, resolved exactly once when the stream finishes. */
export interface StreamOutcome {
  readonly status: 'success' | 'error';
  readonly usage: PartialUsage;
  readonly outputChars: number;
}

export interface BufferedResult {
  readonly wire: unknown;
  readonly response: NormalizedResponse;
}

export type OpenStreamResult =
  | { readonly kind: 'error'; readonly error: ProviderError }
  | {
      readonly kind: 'stream';
      readonly frames: AsyncGenerator<string>;
      readonly outcome: Promise<StreamOutcome>;
    };

const MID_STREAM_MESSAGE = 'the upstream model failed mid-stream';

function toProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError('unavailable', 'upstream request failed');
}

function fromErrorEvent(ev: Extract<NormalizedStreamEvent, { type: 'error' }>): ProviderError {
  return new ProviderError(classifyStreamError(ev.error.type), 'upstream stream error');
}

/** Non-streaming: returns the client wire body AND the IR response (for #11 usage). */
export async function runBuffered(
  provider: ProviderAdapter,
  client: ProtocolAdapter,
  request: NormalizedRequest,
  ctx: { created: number },
): Promise<BufferedResult> {
  const response = await provider.chat(request);
  return { wire: client.responseOut(response, { created: ctx.created }), response };
}

interface Accumulator {
  usage: PartialUsage;
  outputChars: number;
}

/** Fold a streamed IR event into the running usage/output totals (#11). */
function accumulate(acc: Accumulator, ev: NormalizedStreamEvent): void {
  switch (ev.type) {
    case 'message_start':
    case 'message_delta':
      if (ev.usage !== undefined) acc.usage = mergePartialUsage(acc.usage, ev.usage);
      break;
    case 'text_delta':
      acc.outputChars += ev.text.length;
      break;
    case 'tool_use_start':
      acc.outputChars += ev.name.length;
      break;
    case 'tool_use_delta':
      acc.outputChars += ev.partialJson.length;
      break;
    default:
      break;
  }
}

/**
 * Commit-gated stream. Resolves BEFORE the client is committed: `{kind:'error'}`
 * if the upstream throws, times out, produces nothing, or yields an error event
 * first. Otherwise `{kind:'stream'}` with a frame generator and an `outcome`
 * promise that settles exactly once — success on a clean end, error on a
 * mid-stream failure OR a consumer `return()` (client disconnect), even before
 * the first `next()`.
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
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    abort.abort();
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

  const acc: Accumulator = { usage: {}, outputChars: 0 };
  accumulate(acc, first.value);

  // Resolve-once outcome, held OUTSIDE the generator so a pre-`next()` return()
  // (immediate client disconnect) still settles it — a generator's `finally`
  // does not run when return() precedes its first next().
  let settled = false;
  let resolveOutcome!: (o: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>((resolve) => (resolveOutcome = resolve));
  const settle = (status: 'success' | 'error'): void => {
    if (settled) return;
    settled = true;
    resolveOutcome({ status, usage: acc.usage, outputChars: acc.outputChars });
  };

  const inner = buildFrames(client, iterator, first.value, opts, abort, acc, cleanup, settle);
  const frames = wrapWithSettle(inner, cleanup, () => settle('error'));
  return { kind: 'stream', frames, outcome };
}

/** Wrap the frame generator so a consumer `return()`/`throw()` — including one
 * before the first `next()` — settles the outcome (error) and runs cleanup. */
function wrapWithSettle(
  inner: AsyncGenerator<string>,
  cleanup: () => Promise<void>,
  onEarlyEnd: () => void,
): AsyncGenerator<string> {
  const wrapper: AsyncGenerator<string> = {
    next: () => inner.next(), // frame stream takes no next() values
    async return() {
      onEarlyEnd();
      await cleanup();
      return inner.return(undefined);
    },
    throw: (e: unknown) => inner.throw(e),
    [Symbol.asyncIterator]() {
      return wrapper;
    },
    async [Symbol.asyncDispose]() {
      await wrapper.return(undefined);
    },
  };
  return wrapper;
}

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
    await nextP.catch(() => undefined);
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
  acc: Accumulator,
  cleanup: () => Promise<void>,
  settle: (status: 'success' | 'error') => void,
): AsyncGenerator<string> {
  let clean = false;
  try {
    for await (const frame of client.streamSerialize(
      replay(iterator, firstValue, opts.firstEventTimeoutMs, abort, acc),
      { created: opts.created },
    )) {
      yield frame;
    }
    clean = true; // reached the terminator ([DONE] / message_stop)
  } catch {
    yield terminalErrorFrame(client.protocol, MID_STREAM_MESSAGE);
  } finally {
    settle(clean ? 'success' : 'error');
    await cleanup();
  }
}

async function* replay(
  iterator: AsyncIterator<NormalizedStreamEvent>,
  firstValue: NormalizedStreamEvent,
  ms: number,
  abort: AbortController,
  acc: Accumulator,
): AsyncGenerator<NormalizedStreamEvent> {
  yield firstValue; // already accumulated by the caller
  for (;;) {
    const r = await nextWithTimeout(iterator, ms, abort);
    if (r.done) return;
    if (r.value.type === 'error') throw fromErrorEvent(r.value);
    accumulate(acc, r.value);
    yield r.value;
  }
}
