/**
 * Framework-agnostic proxy engine (#10) + usage capture for recording (#11).
 * Given a resolved #6 `ProviderAdapter`, the client-protocol #5 `ProtocolAdapter`,
 * and the normalized request, it runs the call and translates the reply — with
 * the invariant-3 mid-stream commit boundary in `openStream`, and a side-channel
 * `StreamOutcome`/response so the control plane can record tokens without
 * buffering the body. No HTTP, no DB, no Nest.
 */
import { SsrfError } from '@polyrouter/shared/server';
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
  type BreakerAdmission,
  type BreakerOpenListener,
  type BreakerSettleListener,
  type BreakerStateListener,
  type CircuitBreaker,
  type PlanUsageObservation,
  type ProviderAdapter,
  type ProviderErrorKind,
} from '../providers';
import { terminalErrorFrame } from './stream-error';
import type { BoundedBlockCollector } from './body-capture';
import { responseOutputChars, responseToStreamEvents } from './cascade';

export interface ProxyStreamOptions {
  readonly signal?: AbortSignal;
  /** Bound on EACH upstream event wait (#6 clears its first-byte timer at
   * headers and has no inter-event timer), so a stalled 200 can't hang. */
  readonly firstEventTimeoutMs: number;
  /** MUTABLE per-attempt watchdog bound (probe patience, add-fallback-attempt-
   * detail): consulted at arm AND fire time, so a bound widened after arming —
   * set synchronously when breaker admission reports a probe, before any
   * upstream byte can arrive — re-arms the fired timer for the remainder
   * instead of aborting at the stale value. Absent = the fixed value above. */
  readonly firstEventBound?: { ms: number };
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
  // Prefer the adapter's CARRIED cross-field kind (fix-4xx-error-taxonomy): `wire`
  // is stripped at the adapter stage, so re-deriving from the outward `error.type`
  // alone would silently lose a `code`-only credit / policy / permission marker.
  // The fallback keeps events from adapters that carry no kind working unchanged.
  return new ProviderError(
    ev.diagnostic?.kind ?? classifyStreamError(ev.error.type),
    'upstream stream error',
    {
      ...(ev.diagnostic?.providerMessage !== undefined
        ? { providerMessage: ev.diagnostic.providerMessage }
        : {}),
      ...(ev.diagnostic?.requestId !== undefined ? { requestId: ev.diagnostic.requestId } : {}),
      // fix-bad-request-dead-end: CONSUME the adapter's retained markers, never
      // re-derive them here — the raw wire fields are already gone at this point.
      ...(ev.diagnostic?.markers !== undefined ? { markers: ev.diagnostic.markers } : {}),
    },
  );
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
  streamFactory: (
    signal: AbortSignal,
    onBytes: () => void,
  ) => AsyncGenerator<NormalizedStreamEvent>,
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

  const bound = opts.firstEventBound ?? { ms: opts.firstEventTimeoutMs };
  let first: IteratorResult<NormalizedStreamEvent>;
  try {
    first = await nextWithTimeout(iterator, bound, abort, liveness);
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
 * as stalled, while TRUE byte-silence still trips at exactly the bound. The
 * bound itself is a MUTABLE object consulted at arm and fire time (probe
 * patience): a timer fired at a since-widened bound's stale value re-arms for
 * the remainder instead of aborting. */
async function nextWithTimeout(
  iterator: AsyncIterator<NormalizedStreamEvent>,
  bound: { ms: number },
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
      timer = setTimeout(() => resolve('timeout'), bound.ms - (Date.now() - armedAt));
    });
    const winner = await Promise.race([settled, timed]);
    if (timer) clearTimeout(timer);
    if (winner !== 'timeout') {
      if (!winner.ok) throw winner.e;
      return winner.r;
    }
    // Bound grew since arming (probe patience widened it post-admission):
    // re-arm for the remainder of the CURRENT bound.
    if (armedAt + bound.ms > Date.now()) continue;
    // Deadline fired — bytes since the last arm re-arm the budget from THEIR
    // arrival (deadline = lastByteAt + bound), never extend past it.
    const lastByteAt = liveness?.lastByteAt ?? 0;
    if (lastByteAt > armedAt && lastByteAt + bound.ms > Date.now()) {
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
      replay(
        iterator,
        firstValue,
        opts.firstEventBound ?? { ms: opts.firstEventTimeoutMs },
        abort,
        acc,
        liveness,
      ),
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
  bound: { ms: number },
  abort: AbortController,
  acc: Accumulator,
  liveness?: { lastByteAt: number },
): AsyncGenerator<NormalizedStreamEvent> {
  yield firstValue; // already accumulated by the caller
  for (;;) {
    const r = await nextWithTimeout(iterator, bound, abort, liveness);
    if (r.done) return;
    if (r.value.type === 'error') throw fromErrorEvent(r.value);
    accumulate(acc, r.value);
    yield r.value;
  }
}

// --- fallback chain (#12) ---

/** One member of the fallback chain. The adapter is built LAZILY and INSIDE the
 * breaker callback (see the walkers) so an open circuit skips before any setup —
 * and so the builder can widen the adapter bounds when admission reports a
 * half-open probe (probe patience, add-fallback-attempt-detail). */
export interface ChainAttempt {
  readonly providerId: string;
  readonly externalModelId: string;
  readonly buildAdapter: (admission?: BreakerAdmission) => Promise<ProviderAdapter>;
  /** THIS member's core first/inter-event bound (fix-long-call-timeouts):
   * a fallback chain can mix providers with different patience, so the walker
   * applies each member's own bound. Absent = the chain-wide `opts` value. */
  readonly firstEventTimeoutMs?: number;
  /** THIS member's WIDENED core bound when it runs as the half-open probe
   * (probe patience): widened first-byte + the fixed margin, pre-computed by
   * the bundle builder where the effective bounds live. Absent = no widening. */
  readonly probeFirstEventTimeoutMs?: number;
  /** The lease floor a probe admission of this member is granted (probe
   * patience): widest widened silence bound + settle headroom, so a
   * deliberately patient probe is never reclaimed mid-legal-silence. */
  readonly probeLeaseMs?: number;
  /** Per-attempt output-cap clamp (add-output-cap-guardrails): the two-stage
   * deferral's tail dispatches each member with `maxOutputTokens` clamped to
   * its OWN cap. Absent = the request's value verbatim. */
  readonly maxOutputTokens?: number;
  /** THIS attempt's settle hook (add-provider-health-signals): invoked once when
   * the attempt's breaker completion is settled on the shared primary store. Per
   * attempt, so two members of the same provider each see their own outcome and
   * the hook can close over what that attempt's own build resolved. */
  readonly onSettle?: BreakerSettleListener;
  /** Opt in to the plan-cooldown pause (classify-plan-quota-errors): set by the
   * control plane ONLY for a row whose built config carries a plan-error
   * dialect. The walkers then read the pause before admission and record one
   * after a dispatched plan failure. Absent = zero cooldown-store calls, so a
   * provider without a dialect pays nothing (invariant 9). */
  readonly planCooldown?: true;
  /** THIS attempt's plan-usage callback (add-subscription-quota-display): set by the control
   * plane ONLY for a row whose built config carries a usage dialect, and spread into the call
   * context both walkers build. Per attempt, so a fallback chain gives each member only its
   * own callback; a circuit-open or plan-cooldown skip never reaches the adapter, so invokes
   * none. Absent = the context is exactly what it was before. */
  readonly onPlanUsage?: (obs: PlanUsageObservation) => void;
}

/** Whether a provider could have billed one chain attempt (zero-cost-unbilled-
 * errors). `not_sent`: the request never left the router. `rejected`: the
 * provider answered with an error response (an upstream HTTP status). `uncertain`:
 * the provider may have been working when we stopped. Internal evidence, never
 * persisted — and deliberately NOT `dispatched`, which keeps meaning "circuit-open
 * skip" only so the inspector's "skipped — circuit open" label stays truthful. */
export type AttemptBilling = 'not_sent' | 'rejected' | 'uncertain';

/** Classify ONE attempt from the RAW thrown value plus its mapped ProviderError.
 * Only the catch boundary can tell an SSRF refusal (never connected) from a
 * timeout: `toProviderError` maps both to a status-less `unavailable`. A status is
 * set solely by `classifyResponse` (an upstream non-2xx) and the 3xx redirect
 * refusal, so every locally synthesized error (timeouts, `no output`,
 * `oversized_response`, network faults, in-stream error events) lacks one and
 * stays `uncertain` — a client cancel included, since an attempt was in flight. */
export function attemptBilling(rawErr: unknown, mapped: ProviderError): AttemptBilling {
  if (
    rawErr instanceof ProviderCircuitOpenError ||
    rawErr instanceof SsrfError ||
    mapped.kind === 'credential'
  ) {
    return 'not_sent';
  }
  if (rawErr instanceof CallCancelledError) return 'uncertain';
  if (mapped.status !== undefined) return 'rejected';
  return 'uncertain';
}

export interface AttemptFailure {
  readonly index: number;
  readonly error: ProviderError;
  /** False ONLY for a circuit-open skip — the member was never dispatched
   * upstream, so a clamp reason must not be recorded for it (add-output-cap-
   * guardrails). Captured at the catch boundary where the raw error class is
   * still visible; absent (older callers) reads as dispatched. */
  readonly dispatched?: boolean;
  /** Billing evidence for this attempt (zero-cost-unbilled-errors), captured at
   * the same catch boundary by `attemptBilling`. Absent reads as `uncertain`
   * (`chainBillingEvidence`), so a failure built without it can only keep today's
   * billed behavior. */
  readonly billing?: AttemptBilling;
  /** Set ONLY for a member skipped by a plan cooldown (classify-plan-quota-
   * errors): never dispatched, never admitted by the breaker. The error's kind
   * is the pause's kind and carries no status, so a skip can never record. */
  readonly skip?: 'plan_cooldown';
  /** Set ONLY for a DISPATCHED member the walk's OWN deadline cut off while the
   * caller was still present (keep-cheap-leg-attempt-trail design D3): today only
   * the cascade cheap leg's walk carries a deadline of its own. The error stays the
   * mapped `unavailable`; this records why the member stopped. */
  readonly stop?: 'deadline';
}

/** The billing evidence of ONE chain error result: every pushed failure's class,
 * plus the terminal attempt's when it never entered `failures`. A failure that
 * carries no class counts as `uncertain` (fail-safe: never drops evidence). */
export function chainBillingEvidence(result: {
  readonly failures: readonly AttemptFailure[];
  readonly terminalBilling?: AttemptBilling | undefined;
}): AttemptBilling[] {
  const evidence = result.failures.map((f): AttemptBilling => f.billing ?? 'uncertain');
  if (result.terminalBilling !== undefined) evidence.push(result.terminalBilling);
  return evidence;
}

/** The per-attempt request: the member's model id, plus its clamp when the
 * capacity plan set one (add-output-cap-guardrails). */
function attemptRequest(request: NormalizedRequest, attempt: ChainAttempt): NormalizedRequest {
  const base = { ...request, model: attempt.externalModelId };
  if (attempt.maxOutputTokens === undefined) return base;
  return { ...base, params: { ...base.params, maxOutputTokens: attempt.maxOutputTokens } };
}

/** The failure a plan-cooldown skip pushes (design D8): never thrown, never
 * admitted by the breaker, no status/message/markers (so `recordPlanCooldown`
 * can never mistake it for an upstream answer), billed `not_sent`. */
function planPauseFailure(index: number, kind: ProviderErrorKind): AttemptFailure {
  return {
    index,
    error: new ProviderError(kind, 'provider paused by a plan cooldown'),
    dispatched: false,
    billing: 'not_sent',
    skip: 'plan_cooldown',
  };
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
      /** Billing evidence for the attempt that ended the walk WITHOUT entering
       * `failures` (zero-cost-unbilled-errors): a non-retryable stop carries that
       * attempt's class; an empty chain and a loop-start abort (no member
       * dispatched) carry `not_sent`. Absent after an exhausted walk of dispatched
       * attempts — those are all in `failures`. */
      readonly terminalBilling?: AttemptBilling;
    };

export type StreamChainResult =
  | {
      readonly kind: 'error';
      readonly error: ProviderError;
      readonly failures: readonly AttemptFailure[];
      /** See `BufferedChainResult.callerAborted` — the pre-commit chain equivalent. */
      readonly callerAborted: boolean;
      /** See `BufferedChainResult.terminalBilling`. */
      readonly terminalBilling?: AttemptBilling;
    }
  | (CommittedStream & {
      readonly servedIndex: number;
      readonly failures: readonly AttemptFailure[];
    });

/** A cancelled call: the adapter's `CallCancelledError`, or a raw `AbortError`. */
function isCancellation(err: unknown): boolean {
  return err instanceof CallCancelledError || (err instanceof Error && err.name === 'AbortError');
}

/** Decide on the RAW error whether to walk to the next member. A client
 * cancellation (gone) stops, as do the taxonomy's TWO non-retryable kinds — a
 * `bad_request` (the caller's fault; every member would reject it identically) and
 * a `policy_block` (a 451 legal denial another member might well serve, which is
 * exactly why we must not try). A circuit-open skip, a member build failure, and a
 * retryable ProviderError continue. "Non-retryable" is NOT a synonym for "the
 * caller's fault" (fix-4xx-error-taxonomy). */
export function fallbackEligible(err: unknown): boolean {
  if (isCancellation(err)) return false;
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
        // The abort landed BEFORE the next member was dispatched: nothing in flight
        // for this stop (zero-cost-unbilled-errors).
        terminalBilling: 'not_sent',
      };
    const attempt = attempts[i]!;
    const req = attemptRequest(request, attempt);
    // Plan cooldown (classify-plan-quota-errors): read BEFORE the try and before
    // breaker admission, so a skip never consumes a probe, settles nothing and
    // can never reach the recording catch below. Push and continue, never throw.
    if (attempt.planCooldown) {
      const pause = await breaker.planCooldownFor(attempt.providerId);
      if (pause) {
        const skipped = planPauseFailure(i, pause.kind);
        failures.push(skipped);
        lastError = skipped.error;
        continue;
      }
    }
    // keep-cheap-leg-attempt-trail (design D3): whether THIS member was handed to its
    // adapter, and whether the walk's signal had fired when that call rejected. Both
    // are captured inside the breaker callback: `withBreaker` awaits its own
    // settlement before rethrowing, and a deadline that fires during that await must
    // not relabel an unrelated failure as a deadline cut.
    let sent = false;
    let abortedAtReject = false;
    try {
      // build INSIDE the breaker callback: an open circuit skips before setup,
      // and a probe admission widens the adapter bounds (probe patience). The
      // admission's renewal rides as the call's byte-liveness hook so a healthy
      // long buffered probe body holds its lease.
      const response = await withBreaker(
        breaker,
        attempt.providerId,
        async (admission) => {
          const adapter = await attempt.buildAdapter(admission);
          // A signal that fired during admission or build means the member was never
          // sent: the adapter's own entry check throws before any request leaves.
          sent = !signal.aborted;
          try {
            return await adapter.chat(req, {
              signal,
              onBytes: admission.renewOnActivity,
              ...(attempt.onPlanUsage !== undefined ? { onPlanUsage: attempt.onPlanUsage } : {}),
            });
          } catch (callErr) {
            abortedAtReject = signal.aborted;
            throw callErr;
          }
        },
        ctx.onOpen,
        ctx.onBreakerState,
        ctx.isCallerAbort,
        attempt.probeLeaseMs,
        attempt.onSettle,
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
      // Billing evidence is read HERE too, while the raw class is still visible
      // (zero-cost-unbilled-errors): a non-retryable stop never enters `failures`, so
      // it rides the result as `terminalBilling`.
      const billing = attemptBilling(err, mapped);
      if (attempt.planCooldown) await breaker.recordPlanCooldown(attempt.providerId, mapped);
      // keep-cheap-leg-attempt-trail (design D3): the walk's OWN deadline cut this
      // member off. Only a walk whose signal is not the caller's alone can say so —
      // `isCallerAbort` strictly false (a walk without the predicate never marks) —
      // and only for an in-flight call the abort ended (`uncertain`: a status means
      // the provider answered first; `not_sent` is a local refusal).
      const deadlineCut =
        sent && abortedAtReject && billing === 'uncertain' && ctx.isCallerAbort?.() === false;
      if (!fallbackEligible(err)) {
        // A cut BEFORE response headers surfaces as a cancellation, which never walks
        // on. It enters the trail as the attempt it was, so its billing class rides
        // the entry and the result carries no `terminalBilling` (design D8). Any other
        // non-retryable stop keeps its terminal handling.
        if (deadlineCut && isCancellation(err)) {
          failures.push({ index: i, error: mapped, dispatched: true, billing, stop: 'deadline' });
          return { ok: false, error: mapped, failures, callerAborted: false };
        }
        return {
          ok: false,
          error: mapped,
          failures,
          callerAborted: ctx.isCallerAbort?.() === true,
          terminalBilling: billing,
        };
      }
      failures.push({
        index: i,
        error: mapped,
        dispatched: !(err instanceof ProviderCircuitOpenError),
        billing,
        // A cut AFTER headers (an aborted body drain or SSE read) is already a
        // retryable `unavailable`; the marker says the walk, not the provider, ended it.
        ...(deadlineCut ? { stop: 'deadline' as const } : {}),
      });
      lastError = mapped;
    }
  }
  return {
    ok: false,
    error: lastError,
    failures,
    callerAborted: ctx.isCallerAbort?.() === true,
    // An empty chain dispatched nothing; a walk that ran members has every
    // attempt in `failures` already.
    ...(attempts.length === 0 ? { terminalBilling: 'not_sent' as const } : {}),
  };
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
        // Before the next member was dispatched (zero-cost-unbilled-errors).
        terminalBilling: 'not_sent',
      };
    const attempt = attempts[i]!;
    const req = attemptRequest(request, attempt);
    // Plan cooldown: same pre-admission skip as the buffered walker.
    if (attempt.planCooldown) {
      const pause = await breaker.planCooldownFor(attempt.providerId);
      if (pause) {
        const skipped = planPauseFailure(i, pause.kind);
        failures.push(skipped);
        lastError = skipped.error;
        continue;
      }
    }
    // THIS member's MUTABLE watchdog bound (fix-long-call-timeouts + probe
    // patience): a per-provider override must reach the streaming watchdog even
    // mid-chain, and a probe admission widens the SAME object synchronously —
    // before any upstream byte — so the fired-at-stale-value timer re-arms for
    // the remainder instead of aborting.
    const bound = { ms: attempt.firstEventTimeoutMs ?? opts.firstEventTimeoutMs };
    const result = await openAttemptStream(
      (signal, onBytes) =>
        withBreakerStream(
          breaker,
          attempt.providerId,
          // Byte liveness feeds BOTH watchdogs: core's inter-event deadline
          // (onBytes) and the breaker's half-open probe lease (renewOnActivity)
          // — an event-quiet but byte-alive probe keeps its single-probe lease.
          (renewOnActivity, admission) => {
            if (admission.isProbe && attempt.probeFirstEventTimeoutMs !== undefined) {
              bound.ms = Math.max(bound.ms, attempt.probeFirstEventTimeoutMs);
            }
            return buildThenStream(
              attempt,
              req,
              signal,
              () => {
                onBytes();
                renewOnActivity();
              },
              admission,
            );
          },
          opts.onOpen,
          opts.onBreakerState,
          opts.isCallerAbort,
          attempt.probeLeaseMs,
          attempt.onSettle,
        ),
      client,
      { ...opts, firstEventBound: bound },
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
    // Billing evidence from the RAW error, before it is flattened (zero-cost-
    // unbilled-errors) — see the buffered walker.
    const billing = attemptBilling(result.error, mapped);
    if (attempt.planCooldown) await breaker.recordPlanCooldown(attempt.providerId, mapped);
    // Pre-commit failure: a caller abort is `unavailable` after adapter normalization,
    // so consult the pure client signal at the failure boundary (A-3).
    if (!fallbackEligible(result.error))
      return {
        kind: 'error',
        error: mapped,
        failures,
        callerAborted: opts.isCallerAbort?.() === true,
        terminalBilling: billing,
      };
    failures.push({
      index: i,
      error: mapped,
      dispatched: !(result.error instanceof ProviderCircuitOpenError),
      billing,
    });
    lastError = mapped;
  }
  return {
    kind: 'error',
    error: lastError,
    failures,
    callerAborted: opts.isCallerAbort?.() === true,
    ...(attempts.length === 0 ? { terminalBilling: 'not_sent' as const } : {}),
  };
}

/** Build the adapter (inside the breaker generator, after admission — so a
 * probe admission widens its bounds) then stream. */
async function* buildThenStream(
  attempt: ChainAttempt,
  request: NormalizedRequest,
  signal: AbortSignal,
  onBytes: () => void,
  admission?: BreakerAdmission,
): AsyncGenerator<NormalizedStreamEvent> {
  const adapter = await attempt.buildAdapter(admission);
  yield* adapter.chatStream(request, {
    signal,
    onBytes,
    ...(attempt.onPlanUsage !== undefined ? { onPlanUsage: attempt.onPlanUsage } : {}),
  });
}
