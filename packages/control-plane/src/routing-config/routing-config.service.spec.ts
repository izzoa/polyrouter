import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type {
  ModelRow,
  PersistencePort,
  Principal,
  ReplaceEntriesResult,
  RoutingEntryRow,
  RoutingRuleRow,
  TierRow,
  ReplaceEntryInput,
} from '@polyrouter/shared/server';
import { replaceEntryModelId, userPrincipal } from '@polyrouter/shared/server';
import { RoutingConfigService } from './routing-config.service';

const P: Principal = userPrincipal('u1');

function tier(key: string, over: Partial<TierRow> = {}): TierRow {
  return {
    id: over.id ?? `t_${key}`,
    ownerUserId: 'u1',
    orgId: null,
    key,
    displayName: null,
    description: null,
    createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function model(id: string, variant: string | null = null, externalModelId?: string): ModelRow {
  return {
    id,
    providerId: 'p1',
    externalModelId: externalModelId ?? id,
    displayName: null,
    // capability columns dropped from the model row (honest-model-capabilities)
    inputPricePer1m: null,
    outputPricePer1m: null,
    isFree: false,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: null,
    listedPriceCapturedAt: null,
    listedSupportsTools: null,
    listedSupportsVision: null,
    listedSupportsReasoning: null,
    listedContextWindow: null,
    listedCapabilitiesCapturedAt: null,
    variant,
    lastSyncedAt: null,
  };
}

function rule(over: Partial<RoutingRuleRow> = {}): RoutingRuleRow {
  return {
    workloadClass: null,
    id: over.id ?? 'r1',
    ownerUserId: 'u1',
    orgId: null,
    matchType: 'header',
    headerName: 'x-polyrouter-tier',
    headerValue: 'fast',
    target: 'tier:default',
    priority: 0,
    createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/** In-memory port covering exactly what the service touches. */
function makePort(seed: { tiers: TierRow[]; models: ModelRow[]; rules?: RoutingRuleRow[] }) {
  const tiers = [...seed.tiers];
  const models = [...seed.models];
  const rules = [...(seed.rules ?? [])];
  const entriesByTier = new Map<string, RoutingEntryRow[]>();
  let seq = 0;
  const port = {
    tiers: {
      list: () => Promise.resolve([...tiers]),
      findById: (_p: Principal, id: string) =>
        Promise.resolve(tiers.find((t) => t.id === id) ?? null),
      insert: (_p: Principal, values: { key: string; displayName?: string }) => {
        if (tiers.some((t) => t.key === values.key)) {
          return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
        }
        const row = tier(values.key, {
          id: `t_new${++seq}`,
          displayName: values.displayName ?? null,
        });
        tiers.push(row);
        return Promise.resolve(row);
      },
      update: (_p: Principal, id: string, patch: Partial<TierRow>) => {
        const t = tiers.find((x) => x.id === id);
        if (!t) return Promise.resolve(null);
        Object.assign(t, patch);
        return Promise.resolve(t);
      },
      remove: (_p: Principal, id: string) => {
        const i = tiers.findIndex((t) => t.id === id);
        if (i < 0) return Promise.resolve(false);
        tiers.splice(i, 1);
        return Promise.resolve(true);
      },
    },
    routingRules: {
      list: () => Promise.resolve([...rules]),
      findById: (_p: Principal, id: string) =>
        Promise.resolve(rules.find((r) => r.id === id) ?? null),
      insert: (_p: Principal, values: Partial<RoutingRuleRow>) => {
        const row = rule({ ...values, id: `r_new${++seq}` });
        rules.push(row);
        return Promise.resolve(row);
      },
      update: (_p: Principal, id: string, patch: Partial<RoutingRuleRow>) => {
        const r = rules.find((x) => x.id === id);
        if (!r) return Promise.resolve(null);
        Object.assign(r, patch);
        return Promise.resolve(r);
      },
      remove: (_p: Principal, id: string) => {
        const i = rules.findIndex((r) => r.id === id);
        if (i < 0) return Promise.resolve(false);
        rules.splice(i, 1);
        return Promise.resolve(true);
      },
    },
    // The seam check reads providers (add-batch-mode-routing): a batch-capable
    // OpenRouter provider by default, so the existing cases are unaffected.
    providers: {
      list: () =>
        Promise.resolve([
          {
            id: 'p1',
            kind: 'api_key',
            protocol: 'openai_compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
          },
        ]),
    },
    models: {
      listForPrincipal: () => Promise.resolve([...models]),
      findById: (_p: Principal, id: string) =>
        Promise.resolve(models.find((m) => m.id === id) ?? null),
    },
    routingEntries: {
      listForTier: (_p: Principal, tierId: string) =>
        Promise.resolve(
          entriesByTier.get(tierId)?.map((e) => ({ ...e })) ?? ([] as RoutingEntryRow[]),
        ),
      replaceForTier: (
        _p: Principal,
        tierId: string,
        ordered: readonly ReplaceEntryInput[],
      ): Promise<ReplaceEntriesResult> => {
        if (!tiers.some((t) => t.id === tierId)) {
          return Promise.resolve({ status: 'tier_not_found' });
        }
        const ids = ordered.map(replaceEntryModelId);
        const unknown = ids.filter((id) => !models.some((m) => m.id === id));
        if (unknown.length > 0) {
          return Promise.resolve({ status: 'unknown_models', modelIds: unknown });
        }
        // Mirrors the real port: a member that does not STATE a mode keeps the one
        // already stored for that model in this tier (add-batch-mode-routing D11).
        const prior = new Map(
          (entriesByTier.get(tierId) ?? []).map((e) => [e.modelId, e.mode] as const),
        );
        const entries = ordered.map((e, position) => {
          const modelId = replaceEntryModelId(e);
          const stated = typeof e === 'string' ? undefined : e.mode;
          return {
            id: `e${++seq}`,
            tierId,
            modelId,
            position,
            mode: stated ?? prior.get(modelId) ?? 'any',
          };
        });
        entriesByTier.set(tierId, entries);
        return Promise.resolve({ status: 'ok', entries });
      },
    },
  };
  return { port: port as unknown as PersistencePort, tiers, rules };
}

function svcWith(seed: Parameters<typeof makePort>[0]) {
  const built = makePort(seed);
  return { svc: new RoutingConfigService(built.port), ...built };
}

describe('RoutingConfigService — tiers', () => {
  it('rejects the reserved `auto` key and a duplicate key', async () => {
    const { svc } = svcWith({ tiers: [tier('default')], models: [] });
    await expect(svc.createTier(P, { key: 'auto' })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(svc.createTier(P, { key: 'default' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a tier and never writes a key on update (key immutable)', async () => {
    const { svc } = svcWith({ tiers: [tier('default')], models: [] });
    const created = await svc.createTier(P, { key: 'fast', displayName: 'Fast' });
    // UpdateTierDto has no `key`; even a stray field is ignored by the typed patch.
    const updated = await svc.updateTier(P, created.id, {
      displayName: 'Renamed',
    } as never);
    expect(updated.key).toBe('fast');
    expect(updated.displayName).toBe('Renamed');
  });

  it('forbids deleting the default tier but allows others', async () => {
    const { svc } = svcWith({ tiers: [tier('default'), tier('fast')], models: [] });
    await expect(svc.deleteTier(P, 't_default')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(svc.deleteTier(P, 't_fast')).resolves.toEqual({ deleted: true });
  });
});

describe('RoutingConfigService — entries', () => {
  const seed = { tiers: [tier('default')], models: [model('m1'), model('m2'), model('m3')] };

  it('rejects over-cap and duplicate model lists before touching the DB', async () => {
    const { svc } = svcWith(seed);
    await expect(
      svc.replaceEntries(P, 't_default', ['m1', 'm2', 'm3', 'm1', 'm2', 'm3']),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(svc.replaceEntries(P, 't_default', ['m1', 'm1'])).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps tier_not_found → 404 and unknown_models → 422', async () => {
    const { svc } = svcWith(seed);
    await expect(svc.replaceEntries(P, 'nope', ['m1'])).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.replaceEntries(P, 't_default', ['ghost'])).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('assigns positions 0..N-1 in order', async () => {
    const { svc } = svcWith(seed);
    const entries = await svc.replaceEntries(P, 't_default', ['m2', 'm1']);
    expect(entries.map((e) => [e.position, e.modelId])).toEqual([
      [0, 'm2'],
      [1, 'm1'],
    ]);
  });
});

describe('non-routable targets are refused at write time (add-model-variant-detection)', () => {
  const twin = model('m_twin', 'batch', 'openai/gpt-6-astra:batch');
  const seed = () => ({ tiers: [tier('default')], models: [model('m1'), twin] });

  it('rejects a tier-entry PUT naming a batch-only model, naming the base id', async () => {
    const { svc } = svcWith(seed());
    await expect(svc.replaceEntries(P, 't_default', ['m1', 'm_twin'])).rejects.toThrow(
      /batch-priced variant/,
    );
    await expect(svc.replaceEntries(P, 't_default', ['m1', 'm_twin'])).rejects.toThrow(
      /openai\/gpt-6-astra/,
    );
  });

  it('rejects the whole list even when the offending member was already stored', async () => {
    // A PUT is a full replacement: accepting it would re-affirm an unservable member.
    const { svc } = svcWith(seed());
    await expect(svc.replaceEntries(P, 't_default', ['m_twin'])).rejects.toThrow(
      /batch-priced variant/,
    );
  });

  it('rejects a rule whose model: target is batch-only, but not a tier: target', async () => {
    const { svc } = svcWith(seed());
    await expect(
      svc.createRule(P, { matchType: 'default', target: 'model:m_twin' }),
    ).rejects.toThrow(/batch-priced variant/);
    await expect(
      svc.createRule(P, { matchType: 'default', target: 'tier:default' }),
    ).resolves.toBeDefined();
  });

  it('still accepts a routable model target', async () => {
    const { svc } = svcWith(seed());
    await expect(svc.replaceEntries(P, 't_default', ['m1'])).resolves.toBeDefined();
  });
});

describe('RoutingConfigService — rules', () => {
  const seed = () => ({ tiers: [tier('default'), tier('fast')], models: [model('m1')] });

  it('validates target existence and structure', async () => {
    const { svc } = svcWith(seed());
    await expect(
      svc.createRule(P, { matchType: 'header', headerValue: 'x', target: 'tier:ghost' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      svc.createRule(P, { matchType: 'header', headerValue: 'x', target: 'bogus' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const ok = await svc.createRule(P, {
      matchType: 'header',
      headerValue: 'x',
      target: 'model:m1',
    });
    expect(ok.target).toBe('model:m1');
  });

  it('requires header_value for header rules and normalizes header_name', async () => {
    const { svc } = svcWith(seed());
    await expect(
      svc.createRule(P, { matchType: 'header', target: 'tier:fast' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const created = await svc.createRule(P, {
      matchType: 'header',
      headerName: 'X-My-Header',
      headerValue: 'v',
      target: 'tier:fast',
    });
    expect(created.headerName).toBe('x-my-header');
  });

  it('validates the effective merged row on PATCH', async () => {
    const { svc } = svcWith({
      ...seed(),
      rules: [rule({ id: 'r1', matchType: 'default', headerValue: null, target: 'tier:default' })],
    });
    // default → header without a header_value must be rejected.
    await expect(svc.updateRule(P, 'r1', { matchType: 'header' })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    // Supplying the value in the same PATCH is accepted.
    await expect(
      svc.updateRule(P, 'r1', { matchType: 'header', headerValue: 'go' }),
    ).resolves.toMatchObject({ matchType: 'header', headerValue: 'go' });
  });

  it('lists rules in priority-desc, created-asc, id-asc order', async () => {
    const { svc } = svcWith({
      ...seed(),
      rules: [
        rule({ id: 'b', priority: 1, createdAt: new Date('2026-01-02T00:00:00Z') }),
        rule({ id: 'a', priority: 1, createdAt: new Date('2026-01-01T00:00:00Z') }),
        rule({ id: 'c', priority: 5, createdAt: new Date('2026-01-03T00:00:00Z') }),
      ],
    });
    const ids = (await svc.listRules(P)).map((r) => r.id);
    expect(ids).toEqual(['c', 'a', 'b']);
  });
});

describe('entry mode at write time (add-batch-mode-routing tasks 4.1/4.2/4.3)', () => {
  // A provider set the tests can steer: `p1` is batch-capable, `p2` is not.
  type Prov = { id: string; kind: string; protocol: string; baseUrl: string | null };
  const withProviders = (provs: Prov[]) => {
    const built = svcWith({ tiers: [tier('t1')], models: [model('m1'), model('m2')] });
    (built.port as unknown as { providers: { list: () => Promise<Prov[]> } }).providers = {
      list: () => Promise.resolve(provs),
    };
    return built;
  };
  const setProviders = (built: { port: unknown }, provs: Prov[]): void => {
    (built.port as { providers: { list: () => Promise<Prov[]> } }).providers = {
      list: () => Promise.resolve(provs),
    };
  };
  // NATIVE, deliberately: these tests are about the provider SEAM, and on a native
  // family the seam settles batchability on its own. An aggregator would additionally
  // need a per-model twin (fix-batch-capability-and-chain-alignment), which is the
  // subject of its own describe below.
  const CAPABLE = {
    id: 'p1',
    kind: 'api_key',
    protocol: 'anthropic_compatible',
    baseUrl: 'https://api.anthropic.com',
  };
  const LOCAL = {
    id: 'p1',
    kind: 'local',
    protocol: 'openai_compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
  };

  it('stores a stated mode, and defaults a model the tier did not hold', async () => {
    const { svc } = withProviders([CAPABLE]);
    const out = await svc.replaceEntries(P, 't_t1', [
      { modelId: 'm1', mode: 'batch' },
      { modelId: 'm2' },
    ]);
    expect(out.map((e) => [e.modelId, e.mode])).toEqual([
      ['m1', 'batch'],
      ['m2', 'any'],
    ]);
  });

  it('refuses a reservation whose provider has no batch API, naming the model', async () => {
    const { svc } = withProviders([LOCAL]);
    await expect(svc.replaceEntries(P, 't_t1', [{ modelId: 'm1', mode: 'batch' }])).rejects.toThrow(
      /cannot be reserved for batch/,
    );
    // The same list unreserved is fine — the refusal is about the reservation, not
    // about the model being unusable.
    await expect(svc.replaceEntries(P, 't_t1', [{ modelId: 'm1' }])).resolves.toBeDefined();
  });

  it('lets a tenant UNRESERVE an entry whose provider has since lost its seam', async () => {
    // The deadlock this exemption exists to prevent: the entry is stored as `batch`,
    // the provider no longer qualifies, and a PUT resubmits every entry — so a
    // blanket check would refuse every edit to that tier, leaving the tenant no way
    // out but deleting the model.
    const built = withProviders([CAPABLE]);
    const { svc } = built;
    await svc.replaceEntries(P, 't_t1', [{ modelId: 'm1', mode: 'batch' }]);

    setProviders(built, [LOCAL]);
    // Retaining it is refused...
    await expect(svc.replaceEntries(P, 't_t1', [{ modelId: 'm1', mode: 'batch' }])).rejects.toThrow(
      /cannot be reserved for batch/,
    );
    // ...and so is a bare-id write, because omitting the mode PRESERVES `batch`.
    await expect(svc.replaceEntries(P, 't_t1', ['m1'])).rejects.toThrow(
      /cannot be reserved for batch/,
    );
    // But moving it to `any` always succeeds, which is the way out.
    const out = await svc.replaceEntries(P, 't_t1', [{ modelId: 'm1', mode: 'any' }]);
    expect(out.map((e) => e.mode)).toEqual(['any']);
  });

  it('still refuses the same model at two modes as a duplicate', async () => {
    const { svc } = withProviders([CAPABLE]);
    await expect(
      svc.replaceEntries(P, 't_t1', [
        { modelId: 'm1', mode: 'batch' },
        { modelId: 'm1', mode: 'any' },
      ]),
    ).rejects.toThrow(/duplicates/);
  });
});

// The write path answers batch-capability with the SAME shared rule the dashboard's
// control is gated on (fix-batch-capability-and-chain-alignment). Without this the
// endpoint accepted exactly the reservation the interface had stopped offering, and the
// tenant met it as a refused submission — or, under a block budget, as a job discarded
// for having no computable ceiling.
describe('a reservation on an aggregator needs a batch tier for THAT model', () => {
  const AGG = {
    id: 'p1',
    kind: 'api_key',
    protocol: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  };
  const NATIVE = {
    id: 'p1',
    kind: 'api_key',
    protocol: 'anthropic_compatible',
    baseUrl: 'https://api.anthropic.com',
  };
  // `m-sku` is sold with a batch tier (its `:batch` twin is the aggregator's record of
  // that); `m-bare` is not. Same provider, same seam. `m-elsewhere:batch` proves the
  // pairing is by BASE ID and not merely "this provider has some twin".
  const build = (provs: { id: string; kind: string; protocol: string; baseUrl: string }[]) => {
    const built = svcWith({
      tiers: [tier('t1')],
      models: [
        model('m-sku', null, 'openai/gpt-6-astra'),
        model('m-twin', 'batch', 'openai/gpt-6-astra:batch'),
        model('m-bare', null, 'minimax/minimax-m3'),
        model('m-other-twin', 'batch', 'deepseek/deepseek-v4:batch'),
      ],
    });
    (built.port as unknown as { providers: { list: () => Promise<unknown[]> } }).providers = {
      list: () => Promise.resolve(provs),
    };
    return built;
  };

  it('accepts the model with a twin and refuses the one without, naming it', async () => {
    const { svc } = build([AGG]);
    await expect(
      svc.replaceEntries(P, 't_t1', [{ modelId: 'm-sku', mode: 'batch' }]),
    ).resolves.toMatchObject([{ modelId: 'm-sku', mode: 'batch' }]);
    await expect(
      svc.replaceEntries(P, 't_t1', [{ modelId: 'm-bare', mode: 'batch' }]),
    ).rejects.toThrow(/"minimax\/minimax-m3" cannot be reserved for batch/);
  });

  it('says WHY it refused — the provider has the API, this model has no tier', async () => {
    const { svc } = build([AGG]);
    // Distinct from the seam refusal: telling a tenant with a working OpenRouter key
    // that "its provider has no batch API" describes a configuration they do not have.
    await expect(
      svc.replaceEntries(P, 't_t1', [{ modelId: 'm-bare', mode: 'batch' }]),
    ).rejects.toThrow(/publishes no batch tier for this model/);
  });

  it('accepts a native model with no published batch rate at all', async () => {
    // The check that must NOT be "a batch price resolved": Anthropic publishes none.
    const { svc } = build([NATIVE]);
    await expect(
      svc.replaceEntries(P, 't_t1', [{ modelId: 'm-bare', mode: 'batch' }]),
    ).resolves.toMatchObject([{ modelId: 'm-bare', mode: 'batch' }]);
  });

  it('lets a tenant unreserve an entry whose model lost its batch tier', async () => {
    // Capability now tracks the CATALOG, so a sync that drops a twin is a second way to
    // reach the state the seam-loss exemption exists for. Same escape hatch.
    const built = build([AGG]);
    await built.svc.replaceEntries(P, 't_t1', [{ modelId: 'm-sku', mode: 'batch' }]);
    (built.port as unknown as { models: { listForPrincipal: () => Promise<unknown[]> } }).models = {
      listForPrincipal: () =>
        Promise.resolve([model('m-sku', null, 'openai/gpt-6-astra'), model('m-bare')]),
    };
    // Retaining it — including through a bare-id reorder, which PRESERVES `batch` — is
    // refused...
    await expect(built.svc.replaceEntries(P, 't_t1', ['m-sku'])).rejects.toThrow(
      /cannot be reserved for batch/,
    );
    // ...and unreserving is always reachable.
    await expect(
      built.svc.replaceEntries(P, 't_t1', [{ modelId: 'm-sku', mode: 'any' }]),
    ).resolves.toMatchObject([{ modelId: 'm-sku', mode: 'any' }]);
  });

  it('never claims a twin it does not have: a twin for a DIFFERENT model does not count', async () => {
    // `deepseek/deepseek-v4:batch` is on this very provider. Keying the evidence by
    // provider alone — or by "any twin exists" — would have made `m-bare` reservable.
    const { svc } = build([AGG]);
    await expect(
      svc.replaceEntries(P, 't_t1', [{ modelId: 'm-bare', mode: 'batch' }]),
    ).rejects.toThrow(/cannot be reserved for batch/);
  });
});
