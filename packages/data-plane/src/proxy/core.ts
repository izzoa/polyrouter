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
  type BreakerOpenListener,
  type BreakerStateListener,
  type CircuitBreaker,
  type ProviderAdapter,
} from '../providers';
import { terminalErrorFrame } from './stream-error';
import type { BoundedBlockCollector } from './body-capture';
import { responseOutputChars, responseToStreamEvents } from './cascade';

export interface ProxyStreamOptions {
  readonly signal?: AbortSignal;
  /** Bound on EACH upstream event wait (#6 clears its first-byte timer at
   * headers and has no inter-event timer), so a stalled 200 can't hang. */
  readonly firstEventTimeoutMs: number;
  /** Unix seconds for OpenAI `created` when the IR lacks it. */
  readonly created: number;
  /** Client opted into the terminal usage chunk (OpenAI `stream_options.include_usage`, A-7). */
  readonly includeUsage?: boolean;
  /** Fire-and-forget hook when a provider's shared breaker opens (#15b provider_down). */
  readonly onOpen?: BreakerOpenListener;
  /** Bounded response assembly (add-body-capture) — present only when the
   * request's capture is armed; safe to share across chain attempts (only the
   * committed one ever emits content events). */
  readonly contentCollector?: BoundedBlockCollector;
  /** Best-effort state observation at each admission decision (#21 metrics). */
  readonly onBreakerState?: BreakerStateListener;
  /** True when the CLIENT went away — a caller-abort teardown is breaker-neutral
   * even in converted provider-error shape; system timeouts keep tripping. */
  readonly isCallerAbort?: () => boolean;
}

/** Captured usage for #11, resolved exactly once when the stream finishes. */
export interface StreamOutcome {
  readonly status: 'success' | 'error';
  /** True when the stream ended for a NON-provider reason — the caller/consumer went
   * away (client disconnect) or the stream was torn down by the system — captured at
   * termination time, not re-derived from a mutable signal later. Lets the recorder
   * mark a client abort `cancelled` (not a provider `error`) without mislabeling a
   * genuine provider failure whose client merely disconnected during drain (A-3). */
  readonly callerAborted: boolean;
  readonly usage: PartialUsage;
  readonly outputChars: number;
  /** The provider failure that terminated a COMMITTED stream (add-request-error-
   * detail) — the same error that produced the terminal frame, captured at
   * teardown. Absent on success and on caller-abort teardowns. */
  readonly error?: ProviderError;
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
  // Core reads ONLY the adapter-sanitized diagnostic (add-request-error-detail).
  // The IR types `providerMessage` with the SanitizedMessage brand itself, so
  // the value flows factory → adapter → here with no cast anywhere.
  return new ProviderError(classifyStreamError(ev.error.type), 'upstream stream error', {
    ...(ev.diagnostic?.providerMessage !== undefined
      ? { providerMessage: ev.diagnostic.providerMessage }
      : {}),
    ...(ev.diagnostic?.requestId !== undefined ? { requestId: ev.diagnostic.requestId } : {}),
  });
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
  /** Optional bounded content assembly (add-body-capture) — armed per request
   * by the caller; fed every event, retention stops at its byte cap. */
  collector?: BoundedBlockCollector;
}

/** Fold a streamed IR event into the running usage/output totals (#11). */
function accumulate(acc: Accumulator, ev: NormalizedStreamEvent): void {
  acc.collector?.onEvent(ev);
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
    (signal, onBytes) => provider.chatStream(request, { signal, onBytes }),
    client,
    opts,
  );
  return r.kind === 'error' ? { kind: 'error', error: toProviderError(r.error) } : r;
}

/**
 * Replay a fully-buffered response as a client stream (#14 cascade pass). The SSE
 * frames are PRE-MATERIALIZED before any byte is committed, so a synthesis /
 * serialization failure returns `{ kind: 'failed' }` and the caller can escalate
 * safely (a valid cheap answer never becomes a client error). Usage / outputChars
 * come from the buffered response (the billed call), NOT client-delivery progress;
 * the outcome carries only the delivery status (a disconnect → `error`).
 */
export async function replayBufferedStream(
  client: ProtocolAdapter,
  response: NormalizedResponse,
  ctx: { created: number; includeUsage?: boolean },
): Promise<{ kind: 'failed' } | CommittedStream> {
  let materialized: string[];
  try {
    materialized = [];
    for await (const frame of client.streamSerialize(arrayGen(responseToStreamEvents(response)), {
      created: ctx.created,
      ...(ctx.includeUsage !== undefined ? { includeUsage: ctx.includeUsage } : {}),
    })) {
      materialized.push(frame);
    }
  } catch {
    return { kind: 'failed' }; // nothing committed → caller escalates
  }
  const usage: PartialUsage = response.usage ?? {};
  const outputChars = responseOutputChars(response.content);
  let settled = false;
  let resolveOutcome!: (o: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>((resolve) => (resolveOutcome = resolve));
  const settle = (status: 'success' | 'error', callerAborted: boolean): void => {
    if (settled) return;
    settled = true;
    resolveOutcome({ status, callerAborted, usage, outputChars });
  };
  // eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator by contract; frames are pre-materialized
  const inner = (async function* (): AsyncGenerator<string> {
    for (const f of materialized) yield f;
    settle('success', false);
  })();
  const frames = wrapWithSettle(
    inner,
    async () => {
      /* nothing to abort — the source is already buffered */
    },
    // The only way a pre-materialized replay ends non-clean is the CONSUMER stopping
    // pulling (client disconnect) — a caller abort, never a provider fault (A-3).
    () => settle('error', true),
  );
  return { kind: 'stream', frames, outcome };
}

// eslint-disable-next-line @typescript-eslint/require-await -- AsyncIterable by contract for streamSerialize
async function* arrayGen(
  events: readonly NormalizedStreamEvent[],
): AsyncGenerator<NormalizedStreamEvent> {
  for (const e of events) yield e;
}

/** Per-attempt byte-liveness token (fix-long-call-timeouts): the adapter's
 * `onBytes` marks it; `nextWithTimeout` extends its deadline from the mark.
 * One token per attempt — a settled attempt's stale callback marks an object
 * nothing consults anymore (inert by construction). */
interface LivenessToken {
  lastByteAt: number;
}

/**
 * Commit-gate ONE attempt. Creates the AbortController first, then builds the
 * generator with that signal (so the first-event timeout can cancel the
 * upstream). Returns the RAW error pre-commit so the chain can classify it.
 */
export async function openAttemptStream(
  streamFactory: (signal: AbortSignal, onBytes: () => void) => AsyncGenerator<NormalizedStreamEvent>,
  client: ProtocolAdapter,
  opts: ProxyStreamOptions,
): Promise<AttemptResult> {
  const abort = new AbortController();
  const onCallerAbort = (): void => abort.abort();
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const liveness: LivenessToken = { lastByteAt: 0 };
  const markBytes = (): void => {
    liveness.lastByteAt = Date.now();
  };
  const iterator = streamFactory(abort.signal, markBytes)[Symbol.asyncIterator]();
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
    first = await nextWithTimeout(iterator, opts.firstEventTimeoutMs, abort, liveness);
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

  const acc: Accumulator = {
    usage: {},
    outputChars: 0,
    ...(opts.contentCollector !== undefined ? { collector: opts.contentCollector } : {}),
  };
  accumulate(acc, first.value);

  // Resolve-once outcome, held OUTSIDE the generator so a pre-`next()` return()
  // (immediate client disconnect) still settles it — a generator's `finally`
  // does not run when return() precedes its first next().
  let settled = false;
  let resolveOutcome!: (o: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>((resolve) => (resolveOutcome = resolve));
  const settle = (
    status: 'success' | 'error',
    callerAborted: boolean,
    error?: ProviderError,
  ): void => {
    if (settled) return;
    settled = true;
    resolveOutcome({
      status,
      callerAborted,
      usage: acc.usage,
      outputChars: acc.outputChars,
      ...(error !== undefined ? { error } : {}),
    });
  };

  const inner = buildFrames(
    client,
    iterator,
    first.value,
    opts,
    abort,
    acc,
    cleanup,
    settle,
    liveness,
  );
  // A consumer `return()` before the generator settles is the client going away — a
  // caller abort, not a provider fault (A-3).
  const frames = wrapWithSettle(inner, cleanup, () => settle('error', true));
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

/** Await the next event under a RE-ARMABLE deadline (fix-long-call-timeouts):
 * each upstream byte arrival (the liveness mark) restarts the full budget, so a
 * keepalive-fed stream with a long gap between parsed events is never aborted
 * as stalled, while TRUE byte-silence still trips at exactly `ms`. */
async function nextWithTimeout(
  iterator: AsyncIterator<NormalizedStreamEvent>,
  ms: number,
  abort: AbortController,
  liveness?: { lastByteAt: number },
): Promise<IteratorResult<NormalizedStreamEvent>> {
  const nextP = iterator.next();
  const settled = nextP.then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  let armedAt = Date.now();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms - (Date.now() - armedAt));
    });
    const winner = await Promise.race([settled, timed]);
    if (timer) clearTimeout(timer);
    if (winner !== 'timeout') {
      if (!winner.ok) throw winner.e;
      return winner.r;
    }
    // Deadline fired — bytes since the last arm re-arm the budget from THEIR
    // arrival (deadline = lastByteAt + ms), never extend past it.
    const lastByteAt = liveness?.lastByteAt ?? 0;
    if (lastByteAt > armedAt && lastByteAt + ms > Date.now()) {
      armedAt = lastByteAt;
      continue;
    }
    abort.abort();
    await nextP.catch(() => undefined);
    throw new ProviderError('unavailable', 'upstream event timeout');
  }
}

async function* buildFrames(
  client: ProtocolAdapter,
  iterator: AsyncIterator<NormalizedStreamEvent>,
  firstValue: NormalizedStreamEvent,
  opts: ProxyStreamOptions,
  abort: AbortController,
  acc: Accumulator,
  cleanup: () => Promise<void>,
  settle: (status: 'success' | 'error', callerAborted: boolean, error?: ProviderError) => void,
  liveness?: { lastByteAt: number },
): AsyncGenerator<string> {
  let clean = false;
  let callerAborted = false;
  try {
    for await (const frame of client.streamSerialize(
      replay(iterator, firstValue, opts.firstEventTimeoutMs, abort, acc, liveness),
      {
        created: opts.created,
        ...(opts.includeUsage !== undefined ? { includeUsage: opts.includeUsage } : {}),
      },
    )) {
      yield frame;
    }
    clean = true; // reached the terminator ([DONE] / message_stop)
  } catch (err) {
    // Capture WHY the stream errored and SETTLE the outcome HERE — at teardown, before
    // yielding the terminal frame. The pure client signal being aborted now means the
    // CALLER tore this down; anything else is a provider/timeout fault that must stay
    // `error`. Settling before the yield is load-bearing: a consumer `return()` during
    // the terminal-frame suspension would otherwise reach `onEarlyEnd` and settle
    // `callerAborted=true` first, mislabeling a genuine provider failure (A-3). The
    // outcome carries the classified failure so the recorder can persist its detail
    // (add-request-error-detail) — omitted on a caller abort (no provider fault).
    callerAborted = opts.isCallerAbort?.() === true;
    settle('error', callerAborted, callerAborted ? undefined : toProviderError(err));
    yield terminalErrorFrame(client.protocol, MID_STREAM_MESSAGE);
  } finally {
    // On the clean path this settles success; on the error path the catch already
    // settled (resolve-once guard makes this a no-op) — so the causal value wins.
    settle(clean ? 'success' : 'error', callerAborted);
    await cleanup();
  }
}

async function* replay(
  iterator: AsyncIterator<NormalizedStreamEvent>,
  firstValue: NormalizedStreamEvent,
  ms: number,
  abort: AbortController,
  acc: Accumulator,
  liveness?: { lastByteAt: number },
): AsyncGenerator<NormalizedStreamEvent> {
  yield firstValue; // already accumulated by the caller
  for (;;) {
    const r = await nextWithTimeout(iterator, ms, abort, liveness);
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
  /** THIS member's core first/inter-event bound (fix-long-call-timeouts):
   * a fallback chain can mix providers with different patience, so the walker
   * applies each member's own bound. Absent = the chain-wide `opts` value. */
  readonly firstEventTimeoutMs?: number;
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
      /** The CALLER aborted (client gone) — captured deterministically at the point the
       * chain gave up, not re-derived from a mutable signal later. Lets the recorder
       * mark it `cancelled` (not a provider `error`) without racing a late disconnect
       * that lands during breaker persistence after a genuine provider failure (A-3). */
      readonly callerAborted: boolean;
    };

export type StreamChainResult =
  | {
      readonly kind: 'error';
      readonly error: ProviderError;
      readonly failures: readonly AttemptFailure[];
      /** See `BufferedChainResult.callerAborted` — the pre-commit chain equivalent. */
      readonly callerAborted: boolean;
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
  ctx: {
    created: number;
    onOpen?: BreakerOpenListener;
    onBreakerState?: BreakerStateListener;
    isCallerAbort?: () => boolean;
  },
  signal: AbortSignal,
): Promise<BufferedChainResult> {
  const failures: AttemptFailure[] = [];
  let lastError: ProviderError = new ProviderError('unavailable', 'no chain members');
  for (let i = 0; i < attempts.length; i += 1) {
    if (signal.aborted)
      // The loop-STOP is on the composite signal (a cheap-tier DEADLINE must halt the
      // chain too), but `callerAborted` is only true for a real CLIENT abort — the pure
      // predicate. A deadline abort stays escalation-eligible, not `cancelled` (A-3).
      return {
        ok: false,
        error: new ProviderError('unavailable', 'cancelled'),
        failures,
        callerAborted: ctx.isCallerAbort?.() === true,
      };
    const attempt = attempts[i]!;
    const req: NormalizedRequest = { ...request, model: attempt.externalModelId };
    try {
      // build INSIDE the breaker callback: an open circuit skips before setup.
      const response = await withBreaker(
        breaker,
        attempt.providerId,
        async () => {
          const adapter = await attempt.buildAdapter();
          return adapter.chat(req, { signal });
        },
        ctx.onOpen,
        ctx.onBreakerState,
        ctx.isCallerAbort,
      );
      return {
        ok: true,
        wire: client.responseOut(response, { created: ctx.created }),
        response,
        servedIndex: i,
        failures,
      };
    } catch (err) {
      const mapped = toProviderError(err);
      // A caller abort is normalized by the adapters into `unavailable`, so it is
      // indistinguishable from a real provider outage by error alone — the pure client
      // signal (what the breaker also trusts) is the discriminator, read HERE at the
      // failure boundary rather than re-derived later at record time (A-3).
      if (!fallbackEligible(err))
        return {
          ok: false,
          error: mapped,
          failures,
          callerAborted: ctx.isCallerAbort?.() === true,
        };
      failures.push({ index: i, error: mapped });
      lastError = mapped;
    }
  }
  return { ok: false, error: lastError, failures, callerAborted: ctx.isCallerAbort?.() === true };
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
      // Stop on the composite signal, but flag `callerAborted` only for a real client
      // abort (pure predicate) — a cheap-tier deadline stays escalation-eligible (A-3).
      return {
        kind: 'error',
        error: new ProviderError('unavailable', 'cancelled'),
        failures,
        callerAborted: opts.isCallerAbort?.() === true,
      };
    const attempt = attempts[i]!;
    const req: NormalizedRequest = { ...request, model: attempt.externalModelId };
    const result = await openAttemptStream(
      (signal, onBytes) =>
        withBreakerStream(
          breaker,
          attempt.providerId,
          // Byte liveness feeds BOTH watchdogs: core's inter-event deadline
          // (onBytes) and the breaker's half-open probe lease (renewOnActivity)
          // — an event-quiet but byte-alive probe keeps its single-probe lease.
          (renewOnActivity) =>
            buildThenStream(attempt, req, signal, () => {
              onBytes();
              renewOnActivity();
            }),
          opts.onOpen,
          opts.onBreakerState,
          opts.isCallerAbort,
        ),
      client,
      // THIS member's bound (fix-long-call-timeouts): a per-provider override
      // must reach the streaming watchdog even mid-chain.
      attempt.firstEventTimeoutMs !== undefined
        ? { ...opts, firstEventTimeoutMs: attempt.firstEventTimeoutMs }
        : opts,
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
    // Pre-commit failure: a caller abort is `unavailable` after adapter normalization,
    // so consult the pure client signal at the failure boundary (A-3).
    if (!fallbackEligible(result.error))
      return {
        kind: 'error',
        error: mapped,
        failures,
        callerAborted: opts.isCallerAbort?.() === true,
      };
    failures.push({ index: i, error: mapped });
    lastError = mapped;
  }
  return {
    kind: 'error',
    error: lastError,
    failures,
    callerAborted: opts.isCallerAbort?.() === true,
  };
}

/** Build the adapter (inside the breaker generator, after admission) then stream. */
async function* buildThenStream(
  attempt: ChainAttempt,
  request: NormalizedRequest,
  signal: AbortSignal,
  onBytes: () => void,
): AsyncGenerator<NormalizedStreamEvent> {
  const adapter = await attempt.buildAdapter();
  yield* adapter.chatStream(request, { signal, onBytes });
}
