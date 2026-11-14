// record-route-legs task 5.1: the route record every settle site writes.
//
// The outcome table drives the REAL proxy flows (`completionServed`, `streamServed`,
// `cascadeCompletion`, `cascadeStream`) with the real walkers and breaker over fake
// upstreams, and reads what reached the recorder: the legs, their ends, indexes and
// models, and the projection `escalation_source = quality_gate` exactly when the cheap
// leg's end is `gate_failed` (`cheap_error` for every other escalation). ProxyService is
// built bare, with only the collaborators those flows read (its constructor is not
// widened; the inference-proxy e2e hand-wires it).
import {
  CallCancelledError,
  CircuitBreaker,
  InMemoryBreakerStore,
  ProviderError,
  getAdapter,
  type AttemptFailure,
  type ChainAttempt,
  type NormalizedResponse,
  type NormalizedStreamEvent,
  type ProtocolAdapter,
  type ProviderAdapter,
} from '@polyrouter/data-plane';
import type { RouteLeg } from '@polyrouter/shared';
import { userPrincipal } from '@polyrouter/shared/server';
import { DISABLED_LEARNING_GATE } from '../semantic/classification-source';
import type { RecordOutcome, RecordingContext } from '../recording/request-recorder';
import {
  ProxyService,
  escalationSourceOf,
  commitOffsetMs,
  legEndedMs,
  routeLegsOf,
  type CapacityAnnotations,
  type LegWalk,
} from './proxy.service';

/** What one fake upstream member does when the walk reaches it. */
type Behaviour =
  /** answers (buffered) or streams a clean answer */
  | 'ok'
  /** streams a clean answer, calling `beforeFirstEvent` just before its first event
   * (record-commit-time: the exact-offset tests drive the clock from there) */
  | 'okArm'
  /** a retryable 503 before any answer */
  | 'retryable'
  /** a retryable 503 after 40 ms (record-commit-time: time the next member must include) */
  | 'slowRetryable'
  /** a non-retryable 451 legal denial */
  | 'policy'
  /** a throw no adapter classified: the walker maps it to `unavailable` and stops */
  | 'unclassified'
  /** stalls until the walk's signal fires, then rejects as a pre-headers cancel */
  | 'hangPre'
  /** stalls until the walk's signal fires, then rejects as a post-headers idle */
  | 'hangPost'
  /** stalls until the walk's signal fires, then rejects WITH an upstream status */
  | 'rejectAtAbort'
  /** the client leaves while this member is in flight */
  | 'leave'
  /** streams: commits its first token, then fails mid-stream */
  | 'commitThenFail'
  /** its adapter build outlasts the walk's deadline, so it is reached but never sent */
  | 'slowBuild';

const START: NormalizedStreamEvent = {
  type: 'message_start',
  id: 'm1',
  model: 'x',
  role: 'assistant',
};
const TEXT: NormalizedStreamEvent = { type: 'text_delta', index: 0, text: 'an answer' };
const STOP: NormalizedStreamEvent = { type: 'message_delta', stopReason: 'stop' };
const END: NormalizedStreamEvent = { type: 'message_stop' };

const answer = (model: string): NormalizedResponse => ({
  id: 'r1',
  model,
  content: [{ type: 'text', text: 'an answer' }],
  stopReason: 'stop',
});

const untilAborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal === undefined || signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** Called by an `okArm` member right before it yields its first event. */
let beforeFirstEvent: (() => void) | undefined;

function adapterFor(model: string, b: Behaviour, client: AbortController): ProviderAdapter {
  const fault = async (signal: AbortSignal | undefined): Promise<never> => {
    switch (b) {
      case 'retryable':
        throw new ProviderError('unavailable', 'overloaded', { status: 503 });
      case 'slowRetryable':
        await new Promise((r) => setTimeout(r, 40));
        throw new ProviderError('unavailable', 'overloaded', { status: 503 });
      case 'policy':
        throw new ProviderError('policy_block', 'legal denial', { status: 451 });
      case 'unclassified':
        throw new Error('a throw no adapter classified');
      case 'hangPre':
        await untilAborted(signal);
        throw new CallCancelledError();
      case 'hangPost':
        await untilAborted(signal);
        throw new ProviderError('unavailable', 'idle after headers');
      case 'rejectAtAbort':
        await untilAborted(signal);
        throw new ProviderError('unavailable', 'overloaded', { status: 503 });
      case 'leave':
        queueMicrotask(() => client.abort());
        await untilAborted(signal);
        throw new CallCancelledError();
      default:
        throw new Error(`no fault for ${b}`);
    }
  };
  return {
    protocol: 'openai_compatible',
    chat: (_req: unknown, ctx?: { signal?: AbortSignal }) =>
      b === 'ok' ? Promise.resolve(answer(model)) : fault(ctx?.signal),
    chatStream: async function* (_req: unknown, ctx?: { signal?: AbortSignal }) {
      if (b === 'ok' || b === 'okArm' || b === 'commitThenFail') {
        if (b === 'okArm') beforeFirstEvent?.();
        yield START;
        yield TEXT;
        if (b === 'commitThenFail') throw new ProviderError('unavailable', 'mid-stream');
        yield STOP;
        yield END;
        return;
      }
      await fault(ctx?.signal);
    },
    listModels: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, models: 0 }),
  } as unknown as ProviderAdapter;
}

interface Member {
  readonly attempt: ChainAttempt;
  readonly meta: {
    providerId: string;
    providerName: string;
    modelId: string;
    tierKey: string | null;
    providerBaseUrl: string | null;
    providerKind: string;
    model: {
      externalModelId: string;
      inputPricePer1m: null;
      outputPricePer1m: null;
      isFree: boolean;
      listedInputPricePer1m: null;
      listedOutputPricePer1m: null;
      listedIsFree: null;
    };
  };
}

function chain(prefix: string, behaviours: readonly Behaviour[], client: AbortController) {
  const members: Member[] = behaviours.map((b, i) => {
    const model = `${prefix}-${i}`;
    return {
      attempt: {
        providerId: `prov-${model}`,
        externalModelId: model,
        buildAdapter: () =>
          b === 'slowBuild'
            ? new Promise<ProviderAdapter>((resolve) =>
                setTimeout(() => resolve(adapterFor(model, 'hangPre', client)), 80),
              )
            : Promise.resolve(adapterFor(model, b, client)),
      },
      meta: {
        providerId: `prov-${model}`,
        providerName: `prov-${model}`,
        modelId: `m-${model}`,
        tierKey: prefix,
        providerBaseUrl: 'https://api.example.test/v1',
        providerKind: 'api_key',
        model: {
          externalModelId: model,
          inputPricePer1m: null,
          outputPricePer1m: null,
          isFree: false,
          listedInputPricePer1m: null,
          listedOutputPricePer1m: null,
          listedIsFree: null,
        },
      },
    };
  });
  return { attempts: members.map((m) => m.attempt), meta: members.map((m) => m.meta) };
}

interface Recorded {
  readonly ctx: RecordingContext;
  readonly outcome: RecordOutcome;
}

interface Scenario {
  readonly primary?: readonly Behaviour[];
  readonly cheap?: readonly Behaviour[];
  readonly escalation?: readonly Behaviour[];
  /** The quality gate's verdict on a served cheap answer. */
  readonly escalate?: boolean;
  /** The streamed cheap replay fails to materialize (before any byte). */
  readonly replayFails?: boolean;
  readonly cheapTimeoutMs?: number;
  readonly capacity?: { primary?: CapacityAnnotations; cheap?: CapacityAnnotations };
  /** The client is gone before the walk reaches its first member. */
  readonly leftBeforeStart?: boolean;
}

type Flow = (...args: unknown[]) => Promise<unknown>;

/** Run one request through the real flow and return the one parent row it recorded. */
async function run(mode: 'buffered' | 'streamed', s: Scenario): Promise<Recorded> {
  const client = new AbortController();
  const records: Recorded[] = [];
  const svc = Object.create(ProxyService.prototype) as ProxyService;
  Object.assign(svc, {
    breaker: new CircuitBreaker(new InMemoryBreakerStore()),
    recorder: {
      record: (ctx: RecordingContext, outcome: RecordOutcome) => {
        records.push({ ctx, outcome });
        return ctx.requestId;
      },
      recordAttempt: () => undefined,
    },
    cascade: {
      shouldEscalate: () => ({
        score: s.escalate === true ? 0.1 : 0.9,
        escalate: s.escalate === true,
      }),
    },
    producers: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
    metrics: { breakerOpened: () => undefined, breakerStateObserved: () => undefined },
    rt: { firstEventTimeoutMs: 30_000 },
  });
  const base = getAdapter('openai');
  let replayFailures = s.replayFails === true ? 1 : 0;
  const protocol = Object.assign(Object.create(base) as ProtocolAdapter, {
    streamSerialize: (...args: Parameters<ProtocolAdapter['streamSerialize']>) => {
      if (replayFailures > 0) {
        replayFailures -= 1;
        throw new Error('replay materialization failed');
      }
      return base.streamSerialize(...args);
    },
  });
  const primary = chain('primary', s.primary ?? [], client);
  const cascade =
    s.cheap !== undefined
      ? {
          cheap: chain('cheap', s.cheap, client),
          escalation: chain('strong', s.escalation ?? ['ok'], client),
          cheapTimeoutMs: s.cheapTimeoutMs ?? 60_000,
          scope: null,
        }
      : undefined;
  const p = {
    client: protocol,
    requestId: 'req-1',
    protocol: 'openai',
    routed: { model: 'auto', messages: [], params: {} },
    structuredDemand: false,
    learningGate: DISABLED_LEARNING_GATE,
    learningEvidence: null,
    created: 1_700_000_000,
    attempts: primary.attempts,
    meta: primary.meta,
    decision: {
      tierKey: 'fast',
      decisionLayer: 'header',
      routingReason: 'header tier',
      matchedHeader: null,
      chain: [],
    },
    startedAt: Date.now(),
    requestChars: 10,
    principal: userPrincipal('u1'),
    agentId: null,
    ...(cascade !== undefined ? { cascade } : {}),
    ...(s.capacity !== undefined ? { capacity: s.capacity } : {}),
  };
  const flows = svc as unknown as Record<
    'completionServed' | 'streamServed' | 'cascadeCompletion' | 'cascadeStream',
    Flow
  >;
  const flow =
    cascade !== undefined
      ? mode === 'buffered'
        ? flows.cascadeCompletion
        : flows.cascadeStream
      : mode === 'buffered'
        ? flows.completionServed
        : flows.streamServed;
  if (s.leftBeforeStart === true) client.abort();
  let out: unknown;
  try {
    // The cascade flows take the bundle; the primary flows take only the signal.
    out =
      cascade !== undefined
        ? await flow.call(svc, p, cascade, client.signal)
        : await flow.call(svc, p, client.signal);
  } catch {
    out = undefined; // a failed or cancelled request throws its proxy error
  }
  if (mode === 'streamed' && out !== undefined) {
    // Drain the committed stream so its outcome settles and the row records.
    for await (const frame of out as AsyncGenerator<string>) void frame;
  }
  // a served stream records when its outcome settles
  for (let i = 0; i < 50 && records.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  expect(records).toHaveLength(1);
  return records[0]!;
}

/** A leg without its clock reading (asserted on its own). */
const shape = (l: RouteLeg): Omit<RouteLeg, 'endedMs'> => {
  const { endedMs: _endedMs, ...rest } = l;
  return rest;
};

interface Row {
  readonly name: string;
  readonly scenario: Scenario;
  readonly legs: readonly Omit<RouteLeg, 'endedMs'>[];
  readonly status: RecordOutcome['status'];
  /** `escalationSource` on an escalated row; absent = not escalated. */
  readonly source?: 'quality_gate' | 'cheap_error';
  /** Only for cascade rows: whether the row records `escalated`. */
  readonly cascade?: true;
  /** The trail's entries, as `leg:index:kind` (and `:deadline` for a cut). */
  readonly trail?: readonly string[];
}

const served = (leg: RouteLeg['leg'], servedIndex: number, end: RouteLeg['end'] = 'served') => ({
  leg,
  end,
  servedIndex,
});
const STOP_POLICY = { kind: 'policy_block', status: 451 };

/** The cascade outcomes, valid for both modes (the cheap leg is always buffered). */
const CASCADE_ROWS: readonly Row[] = [
  {
    name: 'kept',
    scenario: { cheap: ['ok'] },
    legs: [served('cheap', 0)],
    status: 'success',
  },
  {
    name: 'kept after a failed cheap member',
    scenario: { cheap: ['retryable', 'ok'] },
    legs: [served('cheap', 1)],
    status: 'fallback',
    trail: ['cheap:0:unavailable'],
  },
  {
    name: 'gate failed',
    scenario: { cheap: ['ok'], escalate: true },
    legs: [served('cheap', 0, 'gate_failed'), served('escalation', 0)],
    status: 'success',
    source: 'quality_gate',
  },
  {
    name: 'cheap exhausted',
    scenario: { cheap: ['retryable'] },
    legs: [{ leg: 'cheap', end: 'exhausted' }, served('escalation', 0)],
    status: 'success',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable'],
  },
  {
    name: 'a deadline before headers',
    scenario: { cheap: ['hangPre'], cheapTimeoutMs: 25 },
    legs: [
      { leg: 'cheap', end: 'deadline', stopped: { index: 0, model: 'cheap-0', sent: true } },
      served('escalation', 0),
    ],
    status: 'success',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable:deadline'],
  },
  {
    name: 'a deadline after headers',
    scenario: { cheap: ['hangPost'], cheapTimeoutMs: 25 },
    legs: [
      { leg: 'cheap', end: 'deadline', stopped: { index: 0, model: 'cheap-0', sent: true } },
      served('escalation', 0),
    ],
    status: 'success',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable:deadline'],
  },
  {
    name: 'a deadline cut on a middle member ends the walk at once',
    scenario: { cheap: ['retryable', 'hangPre', 'ok'], cheapTimeoutMs: 25 },
    legs: [
      { leg: 'cheap', end: 'deadline', stopped: { index: 1, model: 'cheap-1', sent: true } },
      served('escalation', 0),
    ],
    status: 'success',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable', 'cheap:1:unavailable:deadline'],
  },
  {
    name: 'a deadline before the next dispatch',
    scenario: { cheap: ['rejectAtAbort', 'ok'], cheapTimeoutMs: 25 },
    legs: [{ leg: 'cheap', end: 'deadline' }, served('escalation', 0)],
    status: 'success',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable'],
  },
  {
    name: 'policy_block stops the cheap leg (not escalated)',
    scenario: { cheap: ['policy'] },
    legs: [
      {
        leg: 'cheap',
        end: 'stopped',
        stopped: { index: 0, model: 'cheap-0', sent: true, ...STOP_POLICY },
      },
    ],
    status: 'error',
    cascade: true,
  },
  {
    name: 'an unclassified stop escalates',
    scenario: { cheap: ['unclassified'] },
    legs: [
      {
        leg: 'cheap',
        end: 'stopped',
        stopped: { index: 0, model: 'cheap-0', sent: true, kind: 'unavailable' },
      },
      served('escalation', 0),
    ],
    status: 'success',
    source: 'cheap_error',
  },
  {
    name: 'a cancel in the cheap leg',
    scenario: { cheap: ['leave'] },
    legs: [{ leg: 'cheap', end: 'cancelled', stopped: { index: 0, model: 'cheap-0', sent: true } }],
    status: 'cancelled',
    cascade: true,
  },
  {
    name: 'a cancel in the cheap leg after a failed member keeps its trail',
    scenario: { cheap: ['retryable', 'leave'] },
    legs: [{ leg: 'cheap', end: 'cancelled', stopped: { index: 1, model: 'cheap-1', sent: true } }],
    status: 'cancelled',
    cascade: true,
    trail: ['cheap:0:unavailable'],
  },
  {
    name: 'a cancel in the escalation leg',
    scenario: { cheap: ['retryable'], escalation: ['leave'] },
    legs: [
      { leg: 'cheap', end: 'exhausted' },
      { leg: 'escalation', end: 'cancelled', stopped: { index: 0, model: 'strong-0', sent: true } },
    ],
    status: 'cancelled',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable'],
  },
  {
    name: 'a cancel in the escalation leg after a gate failure',
    scenario: { cheap: ['ok'], escalate: true, escalation: ['leave'] },
    legs: [
      served('cheap', 0, 'gate_failed'),
      { leg: 'escalation', end: 'cancelled', stopped: { index: 0, model: 'strong-0', sent: true } },
    ],
    status: 'cancelled',
    source: 'quality_gate',
  },
  {
    name: 'escalation served after a failed strong member',
    scenario: { cheap: ['retryable'], escalation: ['retryable', 'ok'] },
    legs: [{ leg: 'cheap', end: 'exhausted' }, served('escalation', 1)],
    status: 'fallback',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable', 'escalation:0:unavailable'],
  },
  {
    name: 'escalation exhausted',
    scenario: { cheap: ['retryable'], escalation: ['retryable', 'retryable'] },
    legs: [
      { leg: 'cheap', end: 'exhausted' },
      { leg: 'escalation', end: 'exhausted' },
    ],
    status: 'error',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable', 'escalation:0:unavailable', 'escalation:1:unavailable'],
  },
  {
    name: 'escalation stopped',
    scenario: { cheap: ['ok'], escalate: true, escalation: ['retryable', 'policy'] },
    legs: [
      served('cheap', 0, 'gate_failed'),
      {
        leg: 'escalation',
        end: 'stopped',
        stopped: { index: 1, model: 'strong-1', sent: true, ...STOP_POLICY },
      },
    ],
    status: 'error',
    source: 'quality_gate',
    trail: ['escalation:0:unavailable'],
  },
];

/** Outcomes only a streamed request has. */
const STREAMED_CASCADE_ROWS: readonly Row[] = [
  {
    name: 'replay failed after a passing verdict',
    scenario: { cheap: ['ok'], replayFails: true },
    legs: [served('cheap', 0, 'replay_failed'), served('escalation', 0)],
    status: 'success',
    source: 'cheap_error',
  },
  {
    name: 'escalation committed, then failed post-commit',
    scenario: { cheap: ['retryable'], escalation: ['commitThenFail'] },
    legs: [{ leg: 'cheap', end: 'exhausted' }, served('escalation', 0)],
    status: 'error',
    source: 'cheap_error',
    trail: ['cheap:0:unavailable'],
  },
];

const PRIMARY_ROWS: readonly Row[] = [
  {
    name: 'served',
    scenario: { primary: ['ok'] },
    legs: [served('primary', 0)],
    status: 'success',
  },
  {
    name: 'served after a failure',
    scenario: { primary: ['retryable', 'ok'] },
    legs: [served('primary', 1)],
    status: 'fallback',
    trail: ['0:unavailable'],
  },
  {
    name: 'exhausted',
    scenario: { primary: ['retryable', 'retryable'] },
    legs: [{ leg: 'primary', end: 'exhausted' }],
    status: 'error',
    trail: ['0:unavailable', '1:unavailable'],
  },
  {
    name: 'a policy_block at member 1',
    scenario: { primary: ['retryable', 'policy', 'ok'] },
    legs: [
      {
        leg: 'primary',
        end: 'stopped',
        stopped: { index: 1, model: 'primary-1', sent: true, ...STOP_POLICY },
      },
    ],
    status: 'error',
    trail: ['0:unavailable'],
  },
  {
    name: 'a cancel in flight after a failed member',
    scenario: { primary: ['retryable', 'leave'] },
    legs: [
      { leg: 'primary', end: 'cancelled', stopped: { index: 1, model: 'primary-1', sent: true } },
    ],
    status: 'cancelled',
    trail: ['0:unavailable'],
  },
];

const trailOf = (ctx: RecordingContext): string[] =>
  (ctx.attemptFailures ?? []).map((e) =>
    [
      ...(e.leg !== undefined ? [e.leg] : []),
      e.index,
      e.kind,
      ...(e.stopReason ? [e.stopReason] : []),
    ].join(':'),
  );

function assertRow(row: Row, rec: Recorded): void {
  const legs = rec.ctx.routeLegs ?? [];
  expect(legs.map(shape)).toEqual(row.legs);
  expect(rec.outcome.status).toBe(row.status);
  expect(trailOf(rec.ctx)).toEqual(row.trail ?? []);
  // Every leg's clock: a non-negative integer, in execution order.
  for (const l of legs) {
    expect(Number.isInteger(l.endedMs)).toBe(true);
    expect(l.endedMs).toBeGreaterThanOrEqual(0);
  }
  if (legs.length === 2) expect(legs[0]!.endedMs).toBeLessThanOrEqual(legs[1]!.endedMs);
  // The projection: `quality_gate` exactly when the cheap leg ended `gate_failed`,
  // `cheap_error` for every other escalation, nothing on a row that did not escalate.
  if (row.source !== undefined) {
    expect(rec.outcome.escalated).toBe(true);
    expect(rec.outcome.escalationSource).toBe(row.source);
  } else if (row.cascade === true || legs[0]?.leg === 'cheap') {
    expect(rec.outcome.escalated).toBe(false);
    expect(rec.outcome.escalationSource).toBeUndefined();
  }
  if (rec.outcome.escalated === true) {
    expect(legs).toHaveLength(2);
    expect(rec.outcome.escalationSource === 'quality_gate').toBe(legs[0]!.end === 'gate_failed');
  } else {
    expect(legs).toHaveLength(1);
  }
}

describe.each(['buffered', 'streamed'] as const)('route record — cascade outcomes (%s)', (mode) => {
  const rows = mode === 'streamed' ? [...CASCADE_ROWS, ...STREAMED_CASCADE_ROWS] : CASCADE_ROWS;
  it.each(rows.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    assertRow(row, await run(mode, row.scenario));
  });
});

describe.each(['buffered', 'streamed'] as const)('route record — primary outcomes (%s)', (mode) => {
  it.each(PRIMARY_ROWS.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    assertRow(row, await run(mode, row.scenario));
  });
});

describe('route record — a streamed leg ends at commit, whatever the stream does after', () => {
  it('a primary stream that fails after its first token records served and status error', async () => {
    const rec = await run('streamed', { primary: ['retryable', 'commitThenFail'] });
    expect(rec.ctx.routeLegs?.map(shape)).toEqual([served('primary', 1)]);
    expect(rec.outcome.status).toBe('error');
  });

  it('a primary stream the client leaves after commit records served and status cancelled', async () => {
    const client = new AbortController();
    const records: Recorded[] = [];
    const svc = Object.create(ProxyService.prototype) as ProxyService;
    Object.assign(svc, {
      breaker: new CircuitBreaker(new InMemoryBreakerStore()),
      recorder: {
        record: (ctx: RecordingContext, outcome: RecordOutcome) => {
          records.push({ ctx, outcome });
          return ctx.requestId;
        },
      },
      producers: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
      metrics: { breakerOpened: () => undefined, breakerStateObserved: () => undefined },
      rt: { firstEventTimeoutMs: 30_000 },
    });
    const primary = chain('primary', ['ok'], client);
    const p = {
      client: getAdapter('openai'),
      requestId: 'req-1',
      protocol: 'openai',
      routed: { model: 'x', messages: [], params: {} },
      learningGate: DISABLED_LEARNING_GATE,
      learningEvidence: null,
      created: 1,
      attempts: primary.attempts,
      meta: primary.meta,
      decision: {
        tierKey: null,
        decisionLayer: 'explicit',
        routingReason: 'r',
        matchedHeader: null,
      },
      startedAt: Date.now(),
      requestChars: 1,
      principal: userPrincipal('u1'),
      agentId: null,
    };
    const frames = (await (svc as unknown as Record<'streamServed', Flow>).streamServed.call(
      svc,
      p,
      client.signal,
    )) as AsyncGenerator<string>;
    await frames.next(); // the first frame reached the client: committed
    client.abort();
    await frames.return(undefined); // the client stops pulling
    for (let i = 0; i < 50 && records.length === 0; i += 1)
      await new Promise((r) => setImmediate(r));
    expect(records).toHaveLength(1);
    expect(records[0]!.ctx.routeLegs?.map(shape)).toEqual([served('primary', 0)]);
    expect(records[0]!.outcome.status).toBe('cancelled');
    // record-commit-time: the commit happened before the client left, so the cancelled
    // row keeps its commit time.
    expect(records[0]!.ctx.committedMs).toEqual(expect.any(Number));
  });
});

// record-commit-time task 4.1 (design D2): only the two streamed sites whose walk
// committed set the commit time, from the request's start; every other settle site
// leaves it absent, so the row records null.
describe('commit time — set only where a streamed walk committed', () => {
  const commit = (rec: Recorded): number => {
    const ms = rec.ctx.committedMs;
    if (ms === undefined) throw new Error('expected a commit time');
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
    return ms;
  };

  it('a committed primary stream records its offset, no later than its leg’s end', async () => {
    const rec = await run('streamed', { primary: ['ok'] });
    expect(rec.outcome.status).toBe('success');
    expect(commit(rec)).toBeLessThanOrEqual(rec.ctx.routeLegs![0]!.endedMs);
  });

  it('a fallback stream’s offset includes the member that failed before it', async () => {
    const rec = await run('streamed', { primary: ['slowRetryable', 'ok'] });
    expect(rec.outcome.status).toBe('fallback');
    expect(commit(rec)).toBeGreaterThanOrEqual(40);
  });

  it('a stream that fails after commit keeps its commit time on the error row', async () => {
    const rec = await run('streamed', { primary: ['commitThenFail'] });
    expect(rec.outcome.status).toBe('error');
    commit(rec);
  });

  it('a committed escalation’s offset is measured from the start, after its cheap leg', async () => {
    const rec = await run('streamed', { cheap: ['slowRetryable'], escalation: ['ok'] });
    expect(rec.outcome.escalated).toBe(true);
    const cheapEnd = rec.ctx.routeLegs!.find((l) => l.leg === 'cheap')!.endedMs;
    expect(cheapEnd).toBeGreaterThanOrEqual(40);
    expect(commit(rec)).toBeGreaterThanOrEqual(cheapEnd);
  });

  it.each<[string, 'buffered' | 'streamed', Scenario]>([
    ['a buffered serve', 'buffered', { primary: ['ok'] }],
    ['a buffered fallback', 'buffered', { primary: ['retryable', 'ok'] }],
    ['a stream that never committed', 'streamed', { primary: ['policy'] }],
    ['a stream whose members all failed', 'streamed', { primary: ['retryable', 'retryable'] }],
    [
      'a stream whose client left before the walk',
      'streamed',
      { primary: ['ok'], leftBeforeStart: true },
    ],
    ['a kept cheap answer replayed as a stream', 'streamed', { cheap: ['ok'] }],
    ['a buffered escalation', 'buffered', { cheap: ['retryable'], escalation: ['ok'] }],
    [
      'a streamed escalation that never committed',
      'streamed',
      { cheap: ['retryable'], escalation: ['policy'] },
    ],
  ])('%s records no commit time', async (_name, mode, scenario) => {
    const rec = await run(mode, scenario);
    expect(rec.ctx).not.toHaveProperty('committedMs');
  });

  // codex review (record-commit-time, Medium): proxy-http's `aborted` branch can win
  // while a committed stream promise is still resolving; it then calls `.return()` on the
  // frames WITHOUT pulling one. The commit time must already be on the context, so the
  // `cancelled` row keeps it — an implementation that attached it at the first pulled
  // frame would lose it here.
  it('a committed stream released before any frame is pulled keeps its commit time', async () => {
    const client = new AbortController();
    const records: Recorded[] = [];
    const svc = Object.create(ProxyService.prototype) as ProxyService;
    Object.assign(svc, {
      breaker: new CircuitBreaker(new InMemoryBreakerStore()),
      recorder: {
        record: (ctx: RecordingContext, outcome: RecordOutcome) => {
          records.push({ ctx, outcome });
          return ctx.requestId;
        },
      },
      producers: { providerDown: () => undefined, onRequestFailed: () => Promise.resolve() },
      metrics: { breakerOpened: () => undefined, breakerStateObserved: () => undefined },
      rt: { firstEventTimeoutMs: 30_000 },
    });
    const primary = chain('primary', ['ok'], client);
    const p = {
      client: getAdapter('openai'),
      requestId: 'req-1',
      protocol: 'openai',
      routed: { model: 'x', messages: [], params: {} },
      learningGate: DISABLED_LEARNING_GATE,
      learningEvidence: null,
      created: 1,
      attempts: primary.attempts,
      meta: primary.meta,
      decision: {
        tierKey: null,
        decisionLayer: 'explicit',
        routingReason: 'r',
        matchedHeader: null,
      },
      startedAt: Date.now(),
      requestChars: 1,
      principal: userPrincipal('u1'),
      agentId: null,
    };
    const frames = (await (svc as unknown as Record<'streamServed', Flow>).streamServed.call(
      svc,
      p,
      client.signal,
    )) as AsyncGenerator<string>;
    client.abort(); // the client left as the stream promise resolved…
    await frames.return(undefined); // …so proxy-http releases it without pulling a frame
    for (let i = 0; i < 50 && records.length === 0; i += 1)
      await new Promise((r) => setImmediate(r));
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome.status).toBe('cancelled');
    commit(records[0]!);
  });

  // codex implementation review (record-commit-time, Low): pin the EXACT offset. The clock
  // stands still until the member is about to send its first event; from then on every read
  // advances it by 1s, so only the commit gate's own read — the first one after the event —
  // gives 412. A recorder that used the walker's return (`legEndedMs`) or any later read
  // records 1,412 or more.
  it.each<[string, Scenario]>([
    ['a primary stream', { primary: ['okArm'] }],
    ['an escalation stream', { cheap: ['retryable'], escalation: ['okArm'] }],
  ])('%s records the gate’s own clock read, exactly', async (_name, scenario) => {
    const t0 = Date.now();
    let clock = t0;
    let advancing = false;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => {
      const v = clock;
      if (advancing) clock += 1_000;
      return v;
    });
    beforeFirstEvent = () => {
      clock = t0 + 412;
      advancing = true;
    };
    try {
      const rec = await run('streamed', scenario);
      expect(rec.ctx.committedMs).toBe(412);
    } finally {
      spy.mockRestore();
      beforeFirstEvent = undefined;
    }
  });

  it('commitOffsetMs is a non-negative integer from the request start', () => {
    expect(commitOffsetMs(1_000_412, 1_000_000)).toBe(412);
    expect(commitOffsetMs(1_000_412.6, 1_000_000)).toBe(413);
    expect(commitOffsetMs(999_000, 1_000_000)).toBe(0); // a backward clock step clamps to 0
  });
});

// The capacity note and the record read ONE dispatched set (record-route-legs D5): a
// SENT stopper's clamp appears in both, an unsent one's in neither.
describe('route record — clamps and deferrals through a real walk', () => {
  const clampAt1: CapacityAnnotations = {
    deferred: 'output_cap_deferred primary-1(4096<100000)',
    clampByIndex: new Map([[1, 'output_cap_clamped 100000→4096 (primary-1)']]),
    ask: 100_000,
    deferredList: [{ index: 1, model: 'primary-1', reason: 'output_cap', cap: 4_096 }],
    clampTo: new Map([[1, 4_096]]),
  };

  it.each(['buffered', 'streamed'] as const)(
    'a clamped member that stops the walk with a policy_block records its clamp in both (%s)',
    async (mode) => {
      const rec = await run(mode, {
        primary: ['retryable', 'policy'],
        capacity: { primary: clampAt1 },
      });
      expect(rec.ctx.routingReason).toContain('output_cap_clamped 100000→4096 (primary-1)');
      expect(rec.ctx.routeLegs?.[0]).toMatchObject({
        end: 'stopped',
        ask: 100_000,
        deferred: clampAt1.deferredList,
        clamps: [{ index: 1, model: 'primary-1', to: 4_096 }],
      });
    },
  );

  it.each(['buffered', 'streamed'] as const)(
    'a clamped member in flight at a cancel records its clamp in both (%s)',
    async (mode) => {
      const rec = await run(mode, {
        primary: ['retryable', 'leave'],
        capacity: { primary: clampAt1 },
      });
      expect(rec.outcome.status).toBe('cancelled');
      expect(rec.ctx.routingReason).toContain('output_cap_clamped');
      expect(rec.ctx.routeLegs?.[0]?.clamps).toEqual([{ index: 1, model: 'primary-1', to: 4_096 }]);
    },
  );

  const cheapAnn: CapacityAnnotations = {
    deferred: 'output_cap_deferred cheap-1(4096<100000)',
    clampByIndex: new Map([[0, 'output_cap_clamped 100000→4096 (cheap-0)']]),
    ask: 100_000,
    deferredList: [{ index: 1, model: 'cheap-1', reason: 'output_cap', cap: 4_096 }],
    clampTo: new Map([[0, 4_096]]),
  };

  it('a deadline cut of a SENT clamped cheap member keeps the note and the clamp in both', async () => {
    const rec = await run('buffered', {
      cheap: ['hangPre', 'ok'],
      cheapTimeoutMs: 25,
      capacity: { cheap: cheapAnn },
    });
    expect(rec.ctx.routingReason).toContain(
      'cheap[output_cap_deferred cheap-1(4096<100000); output_cap_clamped 100000→4096 (cheap-0)]',
    );
    expect(rec.ctx.routeLegs?.[0]).toMatchObject({
      end: 'deadline',
      ask: 100_000,
      deferred: cheapAnn.deferredList,
      clamps: [{ index: 0, model: 'cheap-0', to: 4_096 }],
    });
  });

  it('an UNSENT clamped stopper records no clamp, and a leg that sent nothing no deferral, in either', async () => {
    // The deadline fires while member 0's adapter is still being built: reached, never sent.
    const rec = await run('buffered', {
      cheap: ['slowBuild', 'ok'],
      cheapTimeoutMs: 10,
      capacity: { cheap: cheapAnn },
    });
    expect(rec.ctx.routeLegs?.[0]).toEqual({
      leg: 'cheap',
      end: 'deadline',
      endedMs: rec.ctx.routeLegs?.[0]?.endedMs,
      stopped: { index: 0, model: 'cheap-0', sent: false },
    });
    expect(rec.ctx.routingReason).not.toContain('cheap[');
    expect(rec.ctx.routingReason).not.toContain('output_cap');
    expect(rec.outcome.escalationSource).toBe('cheap_error');
  });

  it('a client gone before the first send records no deferral and no clamp in either', async () => {
    const rec = await run('buffered', {
      cheap: ['ok'],
      leftBeforeStart: true,
      capacity: { cheap: cheapAnn },
    });
    expect(rec.outcome.status).toBe('cancelled');
    expect(rec.ctx.routeLegs?.map(shape)).toEqual([{ leg: 'cheap', end: 'cancelled' }]);
    expect(rec.ctx.routingReason).not.toContain('output_cap');
  });
});

// The builder itself, over walker-shaped results (design D2/D3/D5).
describe('routeLegsOf', () => {
  const meta = ['a', 'b', 'c'].map((externalModelId) => ({ model: { externalModelId } }));
  const failure = (index: number, over: Partial<AttemptFailure> = {}): AttemptFailure => ({
    index,
    error: new ProviderError('unavailable', 'x', { status: 503 }),
    dispatched: true,
    ...over,
  });
  const ann = (over: Partial<CapacityAnnotations> = {}): CapacityAnnotations => ({
    deferred: 'd',
    clampByIndex: new Map(),
    ask: 100_000,
    deferredList: [],
    clampTo: new Map(),
    ...over,
  });
  const leg = (walk: LegWalk, capacity?: CapacityAnnotations): RouteLeg =>
    routeLegsOf([{ leg: 'primary', walk, meta, capacity, endedMs: 7 }])[0]!;

  it('a served walk records its served member and nothing else', () => {
    expect(leg({ servedIndex: 0, failures: [] })).toEqual({
      leg: 'primary',
      end: 'served',
      endedMs: 7,
      servedIndex: 0,
    });
  });

  it('records the stopper’s kind and status on a stopped end only', () => {
    const policy = new ProviderError('policy_block', 'x', { status: 451 });
    expect(
      leg({ ended: 'stopped', stopped: { index: 2, sent: true }, error: policy, failures: [] })
        .stopped,
    ).toEqual({ index: 2, model: 'c', sent: true, kind: 'policy_block', status: 451 });
    const cut = new ProviderError('unavailable', 'cancelled');
    for (const ended of ['deadline', 'cancelled'] as const) {
      expect(
        leg({ ended, stopped: { index: 1, sent: false }, error: cut, failures: [] }).stopped,
      ).toEqual({ index: 1, model: 'b', sent: false });
    }
    // an unclassified stop has no upstream status: the kind alone
    expect(
      leg({ ended: 'stopped', stopped: { index: 0, sent: true }, error: cut, failures: [] })
        .stopped,
    ).toEqual({ index: 0, model: 'a', sent: true, kind: 'unavailable' });
    // an exhausted walk names no stopper
    expect(leg({ ended: 'exhausted', error: cut, failures: [failure(0)] }).stopped).toBeUndefined();
  });

  it('the ask rides exactly with an output-cap deferral or a clamp', () => {
    const capOnly = ann({
      deferredList: [{ index: 1, model: 'b', reason: 'capability', capabilities: ['vision'] }],
    });
    expect(leg({ servedIndex: 0, failures: [] }, capOnly)).toEqual({
      leg: 'primary',
      end: 'served',
      endedMs: 7,
      servedIndex: 0,
      deferred: capOnly.deferredList,
    });
    const outputCap = ann({
      deferredList: [{ index: 1, model: 'b', reason: 'output_cap', cap: 8 }],
    });
    expect(leg({ servedIndex: 0, failures: [] }, outputCap).ask).toBe(100_000);
    const clamp = ann({ clampTo: new Map([[0, 8]]) });
    expect(leg({ servedIndex: 0, failures: [] }, clamp)).toMatchObject({
      ask: 100_000,
      clamps: [{ index: 0, model: 'a', to: 8 }],
    });
    // a clamp on a member never dispatched is not recorded, so neither is the ask
    expect(leg({ servedIndex: 1, failures: [] }, clamp).ask).toBeUndefined();
  });

  it('a leg that dispatched nothing records neither a deferral nor a clamp', () => {
    const both = ann({
      deferredList: [{ index: 1, model: 'b', reason: 'output_cap', cap: 8 }],
      clampTo: new Map([[1, 8]]),
    });
    const err = new ProviderError('unavailable', 'x');
    // every member skipped
    const skipped = leg(
      {
        ended: 'exhausted',
        error: err,
        failures: [failure(0, { dispatched: false }), failure(1, { dispatched: false })],
      },
      both,
    );
    expect(skipped.deferred).toBeUndefined();
    expect(skipped.clamps).toBeUndefined();
    expect(skipped.ask).toBeUndefined();
    // a cancel before the first send: the reached member was never sent
    const unsent = leg(
      {
        ended: 'cancelled',
        stopped: { index: 1, sent: false },
        error: err,
        failures: [failure(0, { dispatched: false })],
      },
      both,
    );
    expect(unsent).toEqual({
      leg: 'primary',
      end: 'cancelled',
      endedMs: 7,
      stopped: { index: 1, model: 'b', sent: false },
    });
  });

  it('`escalation_source` is the projection of the cheap leg’s disposition', () => {
    expect(escalationSourceOf({ disposition: 'gate_failed' })).toBe('quality_gate');
    expect(escalationSourceOf({ disposition: 'replay_failed' })).toBe('cheap_error');
    expect(escalationSourceOf({})).toBe('cheap_error');
  });

  it('legEndedMs is a non-negative integer from the request start', () => {
    const now = Date.now();
    expect(legEndedMs(now + 10_000)).toBe(0); // a start "in the future" clamps to 0
    const ms = legEndedMs(now - 1_234);
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(1_234);
  });
});
