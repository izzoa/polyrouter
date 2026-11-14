import { ProviderError, type AttemptFailure, type ChainAttempt } from '@polyrouter/data-plane';
import {
  capacitySuffix,
  cappedDefault,
  dispatchedIndexes,
  planWalkedChain,
  resolveCatalogFacts,
  routeLegsOf,
  withCapacity,
  type CapacityAnnotations,
  type LegWalk,
} from './proxy.service';

const attempt = (externalModelId: string): ChainAttempt => ({
  providerId: `prov-${externalModelId}`,
  externalModelId,
  buildAdapter: () => Promise.reject(new Error('unused')),
});
const meta = (externalModelId: string, providerBaseUrl: string | null) => ({
  providerId: `prov-${externalModelId}`,
  providerName: 'p',
  modelId: `m-${externalModelId}`,
  tierKey: 'fast',
  providerBaseUrl,
  providerKind: 'api_key',
  model: {
    externalModelId,
    inputPricePer1m: null,
    outputPricePer1m: null,
    isFree: false,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: null,
  },
});
const bundleOf = (...members: [string, string | null][]) => ({
  attempts: members.map(([id]) => attempt(id)),
  meta: members.map(([id, url]) => meta(id, url)),
});
const OPENAI = 'https://api.openai.com/v1';
/** The facts map planWalkedChain reads. Capability was folded into the SAME map
 * (honest-model-capabilities), so a cap-only fixture wraps each number — every
 * test body below is unchanged, which is the point: a request that demands no
 * capability plans exactly as it did before. */
const caps = (entries: [string, number][]) => new Map(entries.map(([k, cap]) => [k, { cap }]));

describe('planWalkedChain (add-output-cap-guardrails)', () => {
  it('defers via the EXACT catalog key, reorders attempts AND meta atomically, clamps the tail copy', () => {
    const bundle = bundleOf(['small-model', OPENAI], ['big-model', OPENAI]);
    const { bundle: planned, capacity } = planWalkedChain(
      bundle,
      100_000,
      caps([
        ['openai:small-model', 16_384],
        ['openai:big-model', 200_000],
      ]),
    );
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['big-model', 'small-model']);
    expect(planned.meta.map((m) => m.model.externalModelId)).toEqual(['big-model', 'small-model']);
    // pairing fence: meta[i] describes attempts[i] after the reorder
    planned.attempts.forEach((a, i) =>
      expect(planned.meta[i]!.model.externalModelId).toBe(a.externalModelId),
    );
    expect(planned.attempts[0]!.maxOutputTokens).toBeUndefined();
    expect(planned.attempts[1]!.maxOutputTokens).toBe(16_384);
    // the ORIGINAL bundle's attempt object is untouched (clamp is a copy)
    expect(bundle.attempts[0]!.maxOutputTokens).toBeUndefined();
    expect(capacity?.deferred).toBe('output_cap_deferred small-model(16384<100000)');
    expect(capacity?.clampByIndex.get(1)).toBe('output_cap_clamped 100000→16384 (small-model)');
  });

  it('an unmappable host and a missing catalog key are unknown — never planned against', () => {
    const { bundle: planned, capacity } = planWalkedChain(
      bundleOf(['custom-model', 'https://my-custom-host.example'], ['unlisted', OPENAI]),
      100_000,
      caps([]),
    );
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['custom-model', 'unlisted']);
    expect(planned.attempts.every((a) => a.maxOutputTokens === undefined)).toBe(true);
    expect(capacity).toBeUndefined();
  });

  it('a null providerBaseUrl is unknown', () => {
    const { capacity } = planWalkedChain(
      bundleOf(['no-url-model', null]),
      100_000,
      caps([['openai:no-url-model', 8]]), // even a key collision cannot apply without a URL
    );
    expect(capacity).toBeUndefined();
  });

  it('escalation planned POST-concatenation: strong-insufficient + default-capable → no clamp', () => {
    const escalationRaw = bundleOf(['strong-model', OPENAI], ['default-model', OPENAI]);
    const { bundle: planned, capacity } = planWalkedChain(
      escalationRaw,
      100_000,
      caps([
        ['openai:strong-model', 16_384],
        ['openai:default-model', 200_000],
      ]),
    );
    // The capable default member heads the walk; strong defers clamped behind it —
    // the strong bundle ALONE being insufficient never triggers an all-clamp.
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual([
      'default-model',
      'strong-model',
    ]);
    expect(planned.attempts[0]!.maxOutputTokens).toBeUndefined();
    expect(planned.attempts[1]!.maxOutputTokens).toBe(16_384);
    expect(capacity?.deferred).toContain('strong-model');
  });

  it('an all-insufficient chain keeps CONFIGURED order, per-member clamps, no deferral string', () => {
    const { bundle: planned, capacity } = planWalkedChain(
      bundleOf(['a-model', OPENAI], ['b-model', OPENAI]),
      100_000,
      caps([
        ['openai:a-model', 4_096],
        ['openai:b-model', 16_384],
      ]),
    );
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['a-model', 'b-model']);
    expect(planned.attempts.map((a) => a.maxOutputTokens)).toEqual([4_096, 16_384]);
    expect(capacity?.deferred).toBeNull();
    expect(capacity?.clampByIndex.size).toBe(2);
  });
});

describe('planWalkedChain — capability composed in (honest-model-capabilities)', () => {
  /** A facts map carrying capability alongside (or instead of) a cap. */
  const facts = (
    entries: [string, { cap?: number; supportsVision?: boolean; supportsTools?: boolean }][],
  ) => new Map(entries);

  it('defers a member the catalog states cannot serve the demand, and records why', () => {
    const bundle = bundleOf(['text-only', OPENAI], ['multimodal', OPENAI]);
    const { bundle: planned, capacity } = planWalkedChain(
      bundle,
      null, // no output-cap ask at all — capability plans on its own
      facts([
        ['openai:text-only', { supportsVision: false }],
        ['openai:multimodal', { supportsVision: true }],
      ]),
      ['vision'],
    );
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['multimodal', 'text-only']);
    // Meta rides with its attempt (the atomic pairing fence).
    expect(planned.meta.map((m) => m.model.externalModelId)).toEqual(['multimodal', 'text-only']);
    expect(capacity?.deferred).toBe('capability_deferred text-only(vision)');
    expect(capacity?.clampByIndex.size).toBe(0); // a capability deferral never clamps
  });

  it('leaves an UNKNOWN member exactly where its owner configured it', () => {
    const bundle = bundleOf(['unknown', OPENAI], ['capable', OPENAI]);
    const { bundle: planned, capacity } = planWalkedChain(
      bundle,
      null,
      facts([['openai:capable', { supportsVision: true }]]), // 'unknown' has no row
      ['vision'],
    );
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['unknown', 'capable']);
    expect(capacity).toBeUndefined(); // nothing to record
  });

  it('never defers on an estimate — only the EXACT key is evidence', () => {
    // The facts map is built from exact keys only (`resolveCatalogFacts`), so a
    // member described solely by a native-family row or a provider claim simply
    // is not in it — and therefore keeps its place.
    const bundle = bundleOf(['aggregated', 'https://openrouter.ai/api/v1'], ['other', OPENAI]);
    const { bundle: planned } = planWalkedChain(bundle, null, facts([]), ['vision']);
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['aggregated', 'other']);
  });

  it('orders capability ahead of capacity and records BOTH reasons', () => {
    const bundle = bundleOf(['short-cap', OPENAI], ['no-vision', OPENAI], ['fine', OPENAI]);
    const { bundle: planned, capacity } = planWalkedChain(
      bundle,
      100_000,
      facts([
        ['openai:short-cap', { cap: 4_096, supportsVision: true }],
        ['openai:no-vision', { cap: 200_000, supportsVision: false }],
        ['openai:fine', { cap: 200_000, supportsVision: true }],
      ]),
      ['vision'],
    );
    // `fine` (group 1), `short-cap` clamped (group 2), `no-vision` (group 3):
    // a member that can answer BRIEFLY outranks one that cannot answer at all.
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual([
      'fine',
      'short-cap',
      'no-vision',
    ]);
    expect(capacity?.deferred).toBe(
      'output_cap_deferred short-cap(4096<100000); capability_deferred no-vision(vision)',
    );
    expect(capacity?.clampByIndex.get(1)).toBe('output_cap_clamped 100000→4096 (short-cap)');
  });

  it('records nothing when every member is short — nothing was deferred behind anything', () => {
    const bundle = bundleOf(['a', OPENAI], ['b', OPENAI]);
    const { bundle: planned, capacity } = planWalkedChain(
      bundle,
      null,
      facts([
        ['openai:a', { supportsVision: false }],
        ['openai:b', { supportsVision: false }],
      ]),
      ['vision'],
    );
    // Configured order, both still dispatched: capability never shortens a chain.
    expect(planned.attempts.map((a) => a.externalModelId)).toEqual(['a', 'b']);
    expect(capacity).toBeUndefined();
  });

  it('demands each capability independently', () => {
    const bundle = bundleOf(['no-tools', OPENAI], ['no-vision', OPENAI]);
    const f = facts([
      ['openai:no-tools', { supportsTools: false, supportsVision: true }],
      ['openai:no-vision', { supportsTools: true, supportsVision: false }],
    ]);
    // A tools-only request defers only the tool-less member…
    expect(
      planWalkedChain(bundle, null, f, ['tools']).bundle.attempts.map((a) => a.externalModelId),
    ).toEqual(['no-vision', 'no-tools']);
    // …and a request demanding BOTH finds neither member able, so configured order holds.
    const both = planWalkedChain(bundle, null, f, ['tools', 'vision']);
    expect(both.bundle.attempts.map((a) => a.externalModelId)).toEqual(['no-tools', 'no-vision']);
    expect(both.capacity).toBeUndefined();
  });
});

describe('capacitySuffix — dispatched-only clamp recording', () => {
  const ann = {
    deferred: 'output_cap_deferred x(8<100)',
    clampByIndex: new Map([
      [1, 'output_cap_clamped 100→8 (x)'],
      [2, 'output_cap_clamped 100→4 (y)'],
    ]),
  };
  const fail = (index: number, dispatched?: boolean): AttemptFailure => ({
    index,
    error: Object.assign(new Error('e'), { kind: 'unavailable' }) as never,
    ...(dispatched !== undefined ? { dispatched } : {}),
  });

  it('records the served clamp and dispatched-failure clamps; a circuit skip records none', () => {
    // index 1 circuit-skipped (dispatched:false), index 2 served
    expect(capacitySuffix(null, ann, 2, [fail(0), fail(1, false)])).toBe(
      'output_cap_deferred x(8<100); output_cap_clamped 100→4 (y)',
    );
  });

  it('a whole-chain failure keeps deferrals + dispatched clamps; leg labels wrap', () => {
    expect(capacitySuffix('cheap', ann, null, [fail(1, true)])).toBe(
      'cheap[output_cap_deferred x(8<100); output_cap_clamped 100→8 (x)]',
    );
    expect(capacitySuffix('esc', ann, null, [fail(0)])).toBe('esc[output_cap_deferred x(8<100)]');
  });

  // keep-cheap-leg-attempt-trail (design D7): a member the cheap deadline cut off was
  // SENT with its clamp, so the clamp is recorded like any dispatched failure's — the
  // walker now hands that member over as a failure (it used to vanish before headers).
  it('a deadline-cut cheap member records its clamp; a circuit-skipped one still does not', () => {
    const cut: AttemptFailure = { ...fail(1), dispatched: true, stop: 'deadline' };
    expect(capacitySuffix('cheap', ann, null, [fail(0), cut])).toBe(
      'cheap[output_cap_deferred x(8<100); output_cap_clamped 100→8 (x)]',
    );
    expect(capacitySuffix('cheap', ann, null, [fail(0), fail(1, false)])).toBe(
      'cheap[output_cap_deferred x(8<100)]',
    );
  });

  it('no annotation (or nothing dispatched to note) → null', () => {
    expect(capacitySuffix(null, undefined, 0, [])).toBeNull();
    expect(capacitySuffix(null, { deferred: null, clampByIndex: new Map() }, 0, [])).toBeNull();
  });
});

// record-route-legs task 4.1: the plan keeps its structure beside its strings, keyed by
// the EFFECTIVE index the trail uses. The strings above are pinned byte-for-byte.
describe('planWalkedChain — the plan as structure (record-route-legs)', () => {
  const facts = (
    entries: [string, { cap?: number; supportsVision?: boolean; supportsTools?: boolean }][],
  ) => new Map(entries);

  it('an output-cap deferral: its effective index, model and cap, the ask, and the tail clamp', () => {
    const { capacity } = planWalkedChain(
      bundleOf(['small-model', OPENAI], ['big-model', OPENAI]),
      100_000,
      caps([
        ['openai:small-model', 16_384],
        ['openai:big-model', 200_000],
      ]),
    );
    expect(capacity?.deferred).toBe('output_cap_deferred small-model(16384<100000)');
    expect(capacity?.ask).toBe(100_000);
    expect(capacity?.deferredList).toEqual([
      { index: 1, model: 'small-model', reason: 'output_cap', cap: 16_384 },
    ]);
    expect([...capacity!.clampTo]).toEqual([[1, 16_384]]);
  });

  it('a capability deferral: the capabilities it lacks, no clamp', () => {
    const { capacity } = planWalkedChain(
      bundleOf(['text-only', OPENAI], ['multimodal', OPENAI]),
      null,
      facts([
        ['openai:text-only', { supportsVision: false }],
        ['openai:multimodal', { supportsVision: true }],
      ]),
      ['vision'],
    );
    expect(capacity?.deferred).toBe('capability_deferred text-only(vision)');
    expect(capacity?.ask).toBeNull();
    expect(capacity?.deferredList).toEqual([
      { index: 1, model: 'text-only', reason: 'capability', capabilities: ['vision'] },
    ]);
    expect(capacity?.clampTo.size).toBe(0);
  });

  it('a member deferred for both reasons is listed twice at one index, capability first', () => {
    const { bundle: planned, capacity } = planWalkedChain(
      bundleOf(['both', OPENAI], ['fine', OPENAI]),
      100_000,
      facts([
        ['openai:both', { cap: 4_096, supportsVision: false, supportsTools: false }],
        ['openai:fine', { cap: 200_000, supportsVision: true, supportsTools: true }],
      ]),
      ['tools', 'vision'],
    );
    expect(planned.meta.map((m) => m.model.externalModelId)).toEqual(['fine', 'both']);
    expect(capacity?.deferred).toBe(
      'output_cap_deferred both(4096<100000); capability_deferred both(tools+vision)',
    );
    expect(capacity?.deferredList).toEqual([
      { index: 1, model: 'both', reason: 'capability', capabilities: ['tools', 'vision'] },
      { index: 1, model: 'both', reason: 'output_cap', cap: 4_096 },
    ]);
    expect([...capacity!.clampTo]).toEqual([[1, 4_096]]);
  });

  it('a clamp with no deferral (an all-insufficient chain) keeps each member’s own cap', () => {
    const { capacity } = planWalkedChain(
      bundleOf(['a-model', OPENAI], ['b-model', OPENAI]),
      100_000,
      caps([
        ['openai:a-model', 4_096],
        ['openai:b-model', 16_384],
      ]),
    );
    expect(capacity?.deferredList).toEqual([]);
    expect([...capacity!.clampTo]).toEqual([
      [0, 4_096],
      [1, 16_384],
    ]);
    expect(capacity?.ask).toBe(100_000);
  });

  it('indexes follow the EFFECTIVE order across the capability groups, sorted by index', () => {
    const { bundle: planned, capacity } = planWalkedChain(
      bundleOf(['both', OPENAI], ['short', OPENAI], ['clamped', OPENAI], ['fine', OPENAI]),
      100_000,
      facts([
        ['openai:both', { cap: 4_096, supportsVision: false }],
        ['openai:short', { cap: 200_000, supportsVision: false }],
        ['openai:clamped', { cap: 4_096, supportsVision: true }],
        ['openai:fine', { cap: 200_000, supportsVision: true }],
      ]),
      ['vision'],
    );
    const order = planned.meta.map((m) => m.model.externalModelId);
    expect(order).toEqual(['fine', 'clamped', 'short', 'both']);
    expect(capacity?.deferredList.map((d) => [d.index, d.model, d.reason])).toEqual([
      [1, 'clamped', 'output_cap'],
      [2, 'short', 'capability'],
      [3, 'both', 'capability'],
      [3, 'both', 'output_cap'],
    ]);
    for (const d of capacity!.deferredList) expect(order[d.index]).toBe(d.model);
    expect([...capacity!.clampTo.keys()]).toEqual([1, 3]);
  });

  it('the record carries the ask only beside an output-cap fact', () => {
    const served: LegWalk = { servedIndex: 0, failures: [] };
    const leg = (
      capacity: CapacityAnnotations | undefined,
      meta: readonly { model: { externalModelId: string } }[],
    ) => routeLegsOf([{ leg: 'primary', walk: served, meta, capacity, endedMs: 1 }])[0]!;
    // a capability-only deferral on a request that DID ask: no ask recorded
    const capOnly = planWalkedChain(
      bundleOf(['text-only', OPENAI], ['multimodal', OPENAI]),
      1_000,
      facts([['openai:text-only', { supportsVision: false }]]),
      ['vision'],
    );
    expect(capOnly.capacity?.ask).toBe(1_000);
    const capLeg = leg(capOnly.capacity, capOnly.bundle.meta);
    expect(capLeg.deferred).toHaveLength(1);
    expect(capLeg.ask).toBeUndefined();
    // an output-cap deferral: the ask rides with it
    const outputCap = planWalkedChain(
      bundleOf(['small-model', OPENAI], ['big-model', OPENAI]),
      100_000,
      caps([['openai:small-model', 16_384]]),
    );
    expect(leg(outputCap.capacity, outputCap.bundle.meta).ask).toBe(100_000);
  });
});

// record-route-legs task 4.2: ONE dispatched set feeds the reason's capacity note and the
// record's clamps and deferrals, so the two never disagree.
describe('one dispatched set — the capacity note and the route record agree', () => {
  const meta = ['a', 'b', 'c'].map((externalModelId) => ({ model: { externalModelId } }));
  const ann: CapacityAnnotations = {
    deferred: 'output_cap_deferred c(8<100)',
    clampByIndex: new Map([[1, 'output_cap_clamped 100→4 (b)']]),
    ask: 100,
    deferredList: [{ index: 2, model: 'c', reason: 'output_cap', cap: 8 }],
    clampTo: new Map([[1, 4]]),
  };
  const err = (kind: 'unavailable' | 'policy_block', status?: number) =>
    new ProviderError(kind, 'x', status !== undefined ? { status } : {});
  const failed = (index: number, dispatched = true): AttemptFailure => ({
    index,
    error: err('unavailable', 503),
    dispatched,
  });
  /** The reason's note and the record's leg for ONE unserved walk. */
  const both = (walk: Extract<LegWalk, { ended: unknown }>) => ({
    note: capacitySuffix(null, ann, null, walk.failures, walk.stopped),
    leg: routeLegsOf([{ leg: 'primary', walk, meta, capacity: ann, endedMs: 0 }])[0]!,
  });

  it('a SENT policy_block stopper’s clamp appears in the reason and the record', () => {
    const { note, leg } = both({
      ended: 'stopped',
      stopped: { index: 1, sent: true },
      error: err('policy_block', 451),
      failures: [failed(0)],
    });
    expect(note).toBe('output_cap_deferred c(8<100); output_cap_clamped 100→4 (b)');
    expect(leg.clamps).toEqual([{ index: 1, model: 'b', to: 4 }]);
    expect(leg.deferred).toEqual(ann.deferredList); // a never-reached member's deferral too
    expect(leg.ask).toBe(100);
  });

  it('an in-flight cancelled member’s clamp appears in both', () => {
    const { note, leg } = both({
      ended: 'cancelled',
      stopped: { index: 1, sent: true },
      error: err('unavailable'),
      failures: [failed(0)],
    });
    expect(note).toContain('output_cap_clamped 100→4 (b)');
    expect(leg.clamps).toEqual([{ index: 1, model: 'b', to: 4 }]);
  });

  it('an UNSENT stopper’s clamp appears in neither', () => {
    const { note, leg } = both({
      ended: 'deadline',
      stopped: { index: 1, sent: false },
      error: err('unavailable'),
      failures: [failed(0)],
    });
    expect(note).toBe('output_cap_deferred c(8<100)'); // member 0 was dispatched
    expect(leg.clamps).toBeUndefined();
    expect(leg.deferred).toEqual(ann.deferredList);
  });

  it('a deadline-cut member is one dispatched member, its clamp recorded once', () => {
    const cut: AttemptFailure = { ...failed(1), stop: 'deadline' };
    const { note, leg } = both({
      ended: 'deadline',
      stopped: { index: 1, sent: true },
      error: cut.error,
      failures: [failed(0), cut],
    });
    expect(note).toBe('output_cap_deferred c(8<100); output_cap_clamped 100→4 (b)');
    expect(leg.clamps).toEqual([{ index: 1, model: 'b', to: 4 }]);
  });

  it('a leg whose every member was skipped records no deferral in either', () => {
    const { note, leg } = both({
      ended: 'exhausted',
      error: err('unavailable'),
      failures: [failed(0, false), failed(1, false), failed(2, false)],
    });
    expect(note).toBeNull(); // today's note carried the deferral unconditionally
    expect(leg).toEqual({ leg: 'primary', end: 'exhausted', endedMs: 0 });
  });

  it('a leg cut before its first send records no deferral in either', () => {
    for (const walk of [
      { ended: 'cancelled' as const, error: err('unavailable'), failures: [] },
      {
        ended: 'deadline' as const,
        stopped: { index: 0, sent: false },
        error: err('unavailable'),
        failures: [],
      },
    ]) {
      const { note, leg } = both(walk);
      expect(note).toBeNull();
      expect(leg.deferred).toBeUndefined();
      expect(leg.clamps).toBeUndefined();
      expect(leg.ask).toBeUndefined();
    }
  });

  it('dispatchedIndexes: served, dispatched failures and a sent stopper; never a skip', () => {
    expect([...dispatchedIndexes(2, [failed(0), failed(1, false)], undefined)].sort()).toEqual([
      0, 2,
    ]);
    expect([...dispatchedIndexes(null, [], { index: 1, sent: true })]).toEqual([1]);
    expect(dispatchedIndexes(null, [failed(0, false)], { index: 1, sent: false }).size).toBe(0);
  });
});

describe('withCapacity', () => {
  it('appends present suffixes and drops nulls', () => {
    expect(withCapacity('base', null, 'cheap[a]', null, 'esc[b]')).toBe('base; cheap[a]; esc[b]');
    expect(withCapacity('base', null, null)).toBe('base');
  });
});

describe('cappedDefault — the synthesized Anthropic default respects a smaller known cap', () => {
  it('caps below, keeps at/above and unknown', () => {
    expect(cappedDefault(4096, 2048)).toBe(2048); // smaller known cap wins
    expect(cappedDefault(4096, 4096)).toBe(4096);
    expect(cappedDefault(4096, 64_000)).toBe(4096); // larger cap → default unchanged
    expect(cappedDefault(4096, undefined)).toBe(4096); // unknown → unchanged (invariant 1)
  });
});

describe('resolveCatalogFacts — one batched read, fail-open (add-output-cap-guardrails; widened by honest-model-capabilities)', () => {
  const AT = new Date('2026-08-20T00:00:00Z');
  const metas = (...pairs: [string, string | null][]) =>
    pairs.map(([id, url]) => ({ providerBaseUrl: url, model: { externalModelId: id } }));

  it('dedupes exact keys across chains and issues exactly ONE read', async () => {
    const calls: (readonly string[])[] = [];
    const priceAtMany = (keys: readonly string[]) => {
      calls.push(keys);
      return Promise.resolve([
        { modelKey: 'openai:gpt-4o', maxOutputTokens: 16_384 },
        { modelKey: 'openai:capless', maxOutputTokens: null },
      ]);
    };
    // The same member appears in primary AND escalation (cascade concat) — one key.
    const caps = await resolveCatalogFacts(
      priceAtMany,
      metas(['gpt-4o', OPENAI], ['gpt-4o', OPENAI], ['capless', OPENAI], ['x', null]),
      AT,
    );
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(['openai:capless', 'openai:gpt-4o']);
    expect(caps.get('openai:gpt-4o')?.cap).toBe(16_384);
    // A null cap is UNKNOWN: the row is present (it carries the model's other
    // facts) but contributes no cap, so nothing can defer on it.
    expect(caps.get('openai:capless')?.cap).toBeUndefined();
  });

  it('a lookup rejection fails OPEN — every cap unknown, nothing thrown', async () => {
    const caps = await resolveCatalogFacts(
      () => Promise.reject(new Error('db down')),
      metas(['gpt-4o', OPENAI]),
      AT,
    );
    expect(caps.size).toBe(0);
  });

  it('an asynchronous (deferred-tick) rejection is caught before planning continues', async () => {
    const caps = await resolveCatalogFacts(
      () =>
        new Promise((_, reject) => {
          setImmediate(() => reject(new Error('late')));
        }),
      metas(['gpt-4o', OPENAI]),
      AT,
    );
    expect(caps.size).toBe(0); // no unhandled rejection; identity outcome
  });

  it('projects capability off the SAME rows, dropping null as unknown', async () => {
    // honest-model-capabilities: three more columns on rows the cap read already
    // fetched — one query, not two, and only an ASSERTED boolean survives.
    let reads = 0;
    const caps = await resolveCatalogFacts(
      (keys: readonly string[]) => {
        reads += 1;
        expect([...keys].sort()).toEqual(['openai:asserts', 'openai:silent']);
        return Promise.resolve([
          {
            modelKey: 'openai:asserts',
            maxOutputTokens: 16_384,
            supportsTools: true,
            supportsVision: false,
          },
          {
            modelKey: 'openai:silent',
            maxOutputTokens: null,
            supportsTools: null,
            supportsVision: null,
          },
        ]);
      },
      metas(['asserts', OPENAI], ['silent', OPENAI]),
      AT,
    );
    expect(reads).toBe(1); // capability added no query
    expect(caps.get('openai:asserts')).toEqual({
      cap: 16_384,
      supportsTools: true,
      supportsVision: false, // the asserted negative is what defers a member
    });
    // Silence reaches the planner as nothing at all, so it can never defer.
    expect(caps.get('openai:silent')).toEqual({});
  });

  it('no derivable keys → no read at all', async () => {
    let called = false;
    const caps = await resolveCatalogFacts(
      () => {
        called = true;
        return Promise.resolve([]);
      },
      metas(['m', null], ['m2', 'https://unknown-host.example']),
      AT,
    );
    expect(called).toBe(false);
    expect(caps.size).toBe(0);
  });
});
