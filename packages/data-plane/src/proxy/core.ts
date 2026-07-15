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
import {
  CallCancelledError,
  ProviderCircuitOpenError,
  ProviderError,
  classifyStreamError,
  shouldFallback,
  withBreaker,
  withBreakerStream,
  type CircuitBreaker,
  type ProviderAdapter,
} from '../providers';
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

/** A committed stream (first successful event in hand). */
interface CommittedStream {
  readonly kind: 'stream';
  readonly frames: AsyncGenerator<string>;
  readonly outcome: Promise<StreamOutcome>;
}

/** Single-attempt result — the error is the RAW thrown value (or a classified
 * ProviderError for first-event/no-output cases) so the chain can decide
 * fallback-eligibility before mapping for the client. */
type AttemptResult = { readonly kind: 'error'; readonly error: unknown } | CommittedStream;

export type OpenStreamResult =
  { readonly kind: 'error'; readonly error: ProviderError } | CommittedStream;

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

/** Single provider, no fallback (#10 compat) — maps the raw error to a ProviderError. */
export async function openStream(
  provider: ProviderAdapter,
  client: ProtocolAdapter,
  request: NormalizedRequest,
  opts: ProxyStreamOptions,
): Promise<OpenStreamResult> {
  const r = await openAttemptStream(
    (signal) => provider.chatStream(request, { signal }),
    client,
    opts,
  );
  return r.kind === 'error' ? { kind: 'error', error: toProviderError(r.error) } : r;
}

/**
 * Commit-gate ONE attempt. Creates the AbortController first, then builds the
 * generator with that signal (so the first-event timeout can cancel the
 * upstream). Returns the RAW error pre-commit so the chain can classify it.
 */
export async function openAttemptStream(
  streamFactory: (signal: AbortSignal) => AsyncGenerator<NormalizedStreamEvent>,
  client: ProtocolAdapter,
  opts: ProxyStreamOptions,
): Promise<AttemptResult> {
  const abort = new AbortController();
  const onCallerAbort = (): void => abort.abort();
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const iterator = streamFactory(abort.signal)[Symbol.asyncIterator]();
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
    return { kind: 'error', error: err }; // raw — the chain classifies eligibility
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

// --- fallback chain (#12) ---

/** One member of the fallback chain. The adapter is built LAZILY and INSIDE the
 * breaker callback (see the walkers) so an open circuit skips before any setup. */
export interface ChainAttempt {
  readonly providerId: string;
  readonly externalModelId: string;
  readonly buildAdapter: () => Promise<ProviderAdapter>;
}

export interface AttemptFailure {
  readonly index: number;
  readonly error: ProviderError;
}

export type BufferedChainResult =
  | {
      readonly ok: true;
      readonly wire: unknown;
      readonly response: NormalizedResponse;
      readonly servedIndex: number;
      readonly failures: readonly AttemptFailure[];
    }
  | {
      readonly ok: false;
      readonly error: ProviderError;
      readonly failures: readonly AttemptFailure[];
    };

export type StreamChainResult =
  | {
      readonly kind: 'error';
      readonly error: ProviderError;
      readonly failures: readonly AttemptFailure[];
    }
  | (CommittedStream & {
      readonly servedIndex: number;
      readonly failures: readonly AttemptFailure[];
    });

/** Decide on the RAW error whether to walk to the next member. A client
 * cancellation (gone) and a `bad_request` (caller's fault) stop; a circuit-open
 * skip, a member build failure, and a retryable ProviderError continue. */
export function fallbackEligible(err: unknown): boolean {
  if (err instanceof CallCancelledError) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (err instanceof ProviderCircuitOpenError) return true;
  if (err instanceof ProviderError) return shouldFallback(err.kind);
  return false; // unknown → don't retry
}

/** Walk the chain for a non-streaming request. Returns (never throws on
 * exhaustion) so the caller can record the served member or the full failure
 * trail. */
export async function runBufferedChain(
  breaker: CircuitBreaker,
  attempts: readonly ChainAttempt[],
  client: ProtocolAdapter,
  request: NormalizedRequest,
  ctx: { created: number },
  signal: AbortSignal,
): Promise<BufferedChainResult> {
  const failures: AttemptFailure[] = [];
  let lastError: ProviderError = new ProviderError('unavailable', 'no chain members');
  for (let i = 0; i < attempts.length; i += 1) {
    if (signal.aborted)
      return { ok: false, error: new ProviderError('unavailable', 'cancelled'), failures };
    const attempt = attempts[i]!;
    const req: NormalizedRequest = { ...request, model: attempt.externalModelId };
    try {
      // build INSIDE the breaker callback: an open circuit skips before setup.
      const response = await withBreaker(breaker, attempt.providerId, async () => {
        const adapter = await attempt.buildAdapter();
        return adapter.chat(req, { signal });
      });
      return {
        ok: true,
        wire: client.responseOut(response, { created: ctx.created }),
        response,
        servedIndex: i,
        failures,
      };
    } catch (err) {
      const mapped = toProviderError(err);
      if (!fallbackEligible(err)) return { ok: false, error: mapped, failures };
      failures.push({ index: i, error: mapped });
      lastError = mapped;
    }
  }
  return { ok: false, error: lastError, failures };
}

/** Walk the chain for a streaming request, honoring the commit boundary: retry
 * members until the first successful event commits; a post-commit failure is
 * the terminal frame (no swap). */
export async function openStreamChain(
  breaker: CircuitBreaker,
  attempts: readonly ChainAttempt[],
  client: ProtocolAdapter,
  request: NormalizedRequest,
  opts: ProxyStreamOptions,
): Promise<StreamChainResult> {
  const failures: AttemptFailure[] = [];
  let lastError: ProviderError = new ProviderError('unavailable', 'no chain members');
  for (let i = 0; i < attempts.length; i += 1) {
    if (opts.signal?.aborted)
      return { kind: 'error', error: new ProviderError('unavailable', 'cancelled'), failures };
    const attempt = attempts[i]!;
    const req: NormalizedRequest = { ...request, model: attempt.externalModelId };
    const result = await openAttemptStream(
      (signal) =>
        withBreakerStream(breaker, attempt.providerId, () => buildThenStream(attempt, req, signal)),
      client,
      opts,
    );
    if (result.kind === 'stream') {
      return {
        kind: 'stream',
        frames: result.frames,
        outcome: result.outcome,
        servedIndex: i,
        failures,
      };
    }
    const mapped = toProviderError(result.error);
    if (!fallbackEligible(result.error)) return { kind: 'error', error: mapped, failures };
    failures.push({ index: i, error: mapped });
    lastError = mapped;
  }
  return { kind: 'error', error: lastError, failures };
}

/** Build the adapter (inside the breaker generator, after admission) then stream. */
async function* buildThenStream(
  attempt: ChainAttempt,
  request: NormalizedRequest,
  signal: AbortSignal,
): AsyncGenerator<NormalizedStreamEvent> {
  const adapter = await attempt.buildAdapter();
  yield* adapter.chatStream(request, { signal });
}
