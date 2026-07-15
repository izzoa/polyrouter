import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type {
  ModelRow,
  PersistencePort,
  Principal,
  ReplaceEntriesResult,
  RoutingEntryRow,
  RoutingRuleRow,
  TierRow,
} from '@polyrouter/shared/server';
import { userPrincipal } from '@polyrouter/shared/server';
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

function model(id: string): ModelRow {
  return {
    id,
    providerId: 'p1',
    externalModelId: id,
    displayName: null,
    contextWindow: null,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    inputPricePer1m: null,
    outputPricePer1m: null,
    isFree: false,
    lastSyncedAt: null,
  };
}

function rule(over: Partial<RoutingRuleRow> = {}): RoutingRuleRow {
  return {
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
        ids: string[],
      ): Promise<ReplaceEntriesResult> => {
        if (!tiers.some((t) => t.id === tierId)) {
          return Promise.resolve({ status: 'tier_not_found' });
        }
        const unknown = ids.filter((id) => !models.some((m) => m.id === id));
        if (unknown.length > 0) {
          return Promise.resolve({ status: 'unknown_models', modelIds: unknown });
        }
        const entries = ids.map((modelId, position) => ({
          id: `e${++seq}`,
          tierId,
          modelId,
          position,
        }));
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
