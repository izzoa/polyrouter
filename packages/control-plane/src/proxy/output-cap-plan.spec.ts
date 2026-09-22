import type { AttemptFailure, ChainAttempt } from '@polyrouter/data-plane';
import {
  capacitySuffix,
  cappedDefault,
  planWalkedChain,
  resolveCatalogFacts,
  withCapacity,
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

  it('no annotation (or nothing dispatched to note) → null', () => {
    expect(capacitySuffix(null, undefined, 0, [])).toBeNull();
    expect(capacitySuffix(null, { deferred: null, clampByIndex: new Map() }, 0, [])).toBeNull();
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
