import { ATTEMPT_FAILURES_MAX } from '@polyrouter/shared';
import { ProviderError, type AttemptFailure } from '@polyrouter/data-plane';
import {
  attemptTrailEntries,
  cheapCancelOutcome,
  reasonWithTrail,
  type AttemptTrailLeg,
} from './proxy.service';

const err = (kind: ConstructorParameters<typeof ProviderError>[0], status?: number) =>
  new ProviderError(kind, `${kind} fixture`, status !== undefined ? { status } : {});

const fail = (index: number, error: ProviderError, dispatched?: boolean): AttemptFailure => ({
  index,
  error,
  ...(dispatched !== undefined ? { dispatched } : {}),
});

const metaOf = (...models: string[]) =>
  models.map((externalModelId) => ({
    providerId: `prov-${externalModelId}`,
    model: { externalModelId },
  }));

describe('reasonWithTrail (add-fallback-attempt-detail)', () => {
  const meta = metaOf('a', 'b', 'c') as unknown as Parameters<typeof reasonWithTrail>[2];

  it('renders dispatched failures as kind@model and circuit-open skips as skip@model', () => {
    const failures = [
      fail(0, err('unavailable', 529)),
      fail(1, err('unavailable'), false), // circuit-open skip — never dispatched
      fail(2, err('rate_limit', 429), true),
    ];
    expect(reasonWithTrail('r', failures, meta)).toBe(
      'r; fell back after: unavailable@a, skip@b, rate_limit@c',
    );
  });

  it('reads an absent dispatched flag as dispatched (legacy callers)', () => {
    expect(reasonWithTrail('r', [fail(0, err('auth'))], meta)).toBe('r; fell back after: auth@a');
  });

  it('leaves a trail-free reason untouched', () => {
    expect(reasonWithTrail('r', [], meta)).toBe('r');
  });
});

describe('attemptTrailEntries (add-fallback-attempt-detail)', () => {
  it('records kind, upstream status only when one existed, and the dispatched flag', () => {
    const meta = metaOf('a', 'b');
    const entries = attemptTrailEntries(
      [{ failures: [fail(0, err('unavailable', 529)), fail(1, err('unavailable'), false)], meta }],
      null,
    );
    expect(entries).toEqual([
      {
        index: 0,
        providerId: 'prov-a',
        model: 'a',
        kind: 'unavailable',
        status: 529,
        dispatched: true,
      },
      { index: 1, providerId: 'prov-b', model: 'b', kind: 'unavailable', dispatched: false },
    ]);
  });

  it('marks terminal by IDENTITY on the final leg tail (whole-chain exhaustion)', () => {
    const meta = metaOf('a', 'b');
    const terminal = err('unavailable');
    const entries = attemptTrailEntries(
      [{ failures: [fail(0, err('unavailable')), fail(1, terminal, false)], meta }],
      terminal,
    );
    expect(entries[0]!.terminal).toBeUndefined();
    expect(entries[1]!.terminal).toBe(true);
  });

  it('marks NO entry for a non-retryable stop (terminal never entered the list)', () => {
    const meta = metaOf('a');
    const entries = attemptTrailEntries(
      [{ failures: [fail(0, err('unavailable'))], meta }],
      err('bad_request', 400), // the stop's own error — a different instance
    );
    expect(entries.some((e) => e.terminal === true)).toBe(false);
  });

  it('aggregates cascade legs in execution order with leg-relative indices, terminal on the FINAL leg only', () => {
    const cheapMeta = metaOf('cheap-a', 'cheap-b');
    const escMeta = metaOf('strong-a');
    const escTerminal = err('unavailable');
    // Same instance appearing in the CHEAP leg must not be marked — only the
    // final leg's tail can be the chain's terminal error.
    const legs: AttemptTrailLeg[] = [
      {
        failures: [fail(0, escTerminal), fail(1, err('rate_limit', 429))],
        meta: cheapMeta,
        leg: 'cheap',
      },
      { failures: [fail(0, escTerminal)], meta: escMeta, leg: 'escalation' },
    ];
    const entries = attemptTrailEntries(legs, escTerminal);
    expect(entries.map((e) => [e.leg, e.index, e.model])).toEqual([
      ['cheap', 0, 'cheap-a'],
      ['cheap', 1, 'cheap-b'],
      ['escalation', 0, 'strong-a'],
    ]);
    expect(entries.map((e) => e.terminal === true)).toEqual([false, false, true]);
  });

  it('contains no free-text field anywhere in the structure', () => {
    const entries = attemptTrailEntries(
      [{ failures: [fail(0, err('unavailable', 500))], meta: metaOf('a') }],
      null,
    );
    const allowed = new Set([
      'index',
      'providerId',
      'model',
      'kind',
      'status',
      'dispatched',
      'leg',
      'terminal',
    ]);
    for (const e of entries) for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true);
  });

  it('bounds the list at ATTEMPT_FAILURES_MAX', () => {
    const n = ATTEMPT_FAILURES_MAX + 8;
    const meta = metaOf(...Array.from({ length: n }, (_, i) => `m${String(i)}`));
    const failures = Array.from({ length: n }, (_, i) => fail(i, err('unavailable')));
    expect(attemptTrailEntries([{ failures, meta }], null)).toHaveLength(ATTEMPT_FAILURES_MAX);
  });
});

describe('cheapCancelOutcome (zero-cost-unbilled-errors)', () => {
  // A client abort during the cascade's cheap leg: billed unless the walk provably
  // dispatched nothing. Both the buffered and the streamed cancel site build their
  // outcome here, so these cases pin both.
  it('records not billed when the abort lands before any cheap member is dispatched', () => {
    expect(cheapCancelOutcome({ failures: [], terminalBilling: 'not_sent' })).toEqual({
      status: 'cancelled',
      outputChars: 0,
      escalated: false,
      qualitySignal: null,
      unbilledWalk: true,
    });
  });

  it('records not billed when earlier members were skipped or rejected and the abort preceded the next dispatch', () => {
    const failures = [
      { ...fail(0, err('unavailable'), false), billing: 'not_sent' as const },
      { ...fail(1, err('rate_limit', 429), true), billing: 'rejected' as const },
    ];
    expect(cheapCancelOutcome({ failures, terminalBilling: 'not_sent' }).unbilledWalk).toBe(true);
  });

  it('stays billed when the abort lands while an attempt is in flight', () => {
    expect(cheapCancelOutcome({ failures: [], terminalBilling: 'uncertain' }).unbilledWalk).toBe(
      false,
    );
  });

  it('stays billed when a rejected member is followed by an in-flight abort', () => {
    // The uncertain terminal sits AFTER a not-billed failure: one uncertain attempt anywhere
    // in the walk keeps the row billed.
    const failures = [{ ...fail(0, err('rate_limit', 429), true), billing: 'rejected' as const }];
    expect(cheapCancelOutcome({ failures, terminalBilling: 'uncertain' }).unbilledWalk).toBe(false);
  });

  it('stays billed when no evidence is available (fail-safe)', () => {
    expect(cheapCancelOutcome({ failures: [] }).unbilledWalk).toBe(false);
  });
});
