import { Test as NestTest } from '@nestjs/testing';
import { PERSISTENCE_PORT } from '@polyrouter/shared/server';
import type {
  AgentInsertInput,
  PersistencePort,
  Principal,
  ProviderInsertInput,
  RoutingRuleInsertInput,
  TierInsertInput,
} from '@polyrouter/shared/server';
import { DRIZZLE, PG_POOL } from '../../src/database/database.internal';
import { DatabaseModule } from '../../src/database/database.module';
import { TenancyHarness, type TestPrincipal } from './harness';

/** Cross-tenant/IDOR regression suite (tenant-isolation DoD): another
 * principal's rows are indistinguishable from nonexistent ones, for reads and
 * writes alike, across every owned resource wired in this change. */

let harness: TenancyHarness;
let alice: TestPrincipal;
let bob: TestPrincipal;

beforeAll(async () => {
  harness = await TenancyHarness.create();
  alice = await harness.createTestPrincipal('alice');
  bob = await harness.createTestPrincipal('bob');
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

interface OwnedCase {
  name: string;
  create: (p: Principal) => Promise<{ id: string }>;
  findById: (p: Principal, id: string) => Promise<unknown>;
  update: (p: Principal, id: string) => Promise<unknown>;
  remove: (p: Principal, id: string) => Promise<boolean>;
}

const agentValues: AgentInsertInput = {
  name: 'a',
  apiKeyHash: 'hash',
  apiKeyPrefix: `poly_${Math.random().toString(36).slice(2, 8)}`,
  harnessType: 'curl',
};
const providerValues: ProviderInsertInput = {
  name: 'p',
  kind: 'api_key',
  protocol: 'openai_compatible',
};
const ruleValues: RoutingRuleInsertInput = {
  matchType: 'header',
  headerValue: 'heavy',
  target: 'tier heavy',
};

function ownedCases(port: () => PersistencePort): OwnedCase[] {
  return [
    {
      name: 'agent',
      create: (p) =>
        port().agents.insert(p, {
          ...agentValues,
          apiKeyPrefix: `poly_${Math.random().toString(36).slice(2, 10)}`,
        }),
      findById: (p, id) => port().agents.findById(p, id),
      update: (p, id) => port().agents.update(p, id, { name: 'hijacked' }),
      remove: (p, id) => port().agents.remove(p, id),
    },
    {
      name: 'provider',
      create: (p) => port().providers.insert(p, providerValues),
      findById: (p, id) => port().providers.findById(p, id),
      update: (p, id) => port().providers.update(p, id, { name: 'hijacked' }),
      remove: (p, id) => port().providers.remove(p, id),
    },
    {
      name: 'tier',
      create: (p) =>
        port().tiers.insert(p, { key: `t-${Math.random().toString(36).slice(2, 10)}` }),
      findById: (p, id) => port().tiers.findById(p, id),
      update: (p, id) => port().tiers.update(p, id, { displayName: 'hijacked' }),
      remove: (p, id) => port().tiers.remove(p, id),
    },
    {
      name: 'routing_rule',
      create: (p) => port().routingRules.insert(p, ruleValues),
      findById: (p, id) => port().routingRules.findById(p, id),
      update: (p, id) => port().routingRules.update(p, id, { target: 'hijacked' }),
      remove: (p, id) => port().routingRules.remove(p, id),
    },
  ];
}

describe('tenant isolation across owned resources', () => {
  it('cross-tenant reads and mutations fail closed for every owned resource', async () => {
    for (const c of ownedCases(() => harness.port)) {
      const row = await c.create(bob.principal);

      // reads: A cannot see B's row — identical to a nonexistent id
      expect(await c.findById(alice.principal, row.id)).toBeNull();
      expect(await c.findById(alice.principal, 'does-not-exist')).toBeNull();

      // mutations: zero rows affected, victim unchanged
      expect(await c.update(alice.principal, row.id)).toBeNull();
      expect(await c.remove(alice.principal, row.id)).toBe(false);
      const untouched = await c.findById(bob.principal, row.id);
      expect(untouched).not.toBeNull();
      expect(JSON.stringify(untouched)).not.toContain('hijacked');

      // same-tenant paths succeed
      expect(await c.findById(bob.principal, row.id)).not.toBeNull();
      expect(await c.remove(bob.principal, row.id)).toBe(true);
    }
  });

  it('list() only returns the principal’s rows', async () => {
    const a = await harness.port.providers.insert(alice.principal, providerValues);
    const b = await harness.port.providers.insert(bob.principal, providerValues);
    const aliceList = await harness.port.providers.list(alice.principal);
    expect(aliceList.map((r) => r.id)).toContain(a.id);
    expect(aliceList.map((r) => r.id)).not.toContain(b.id);
  });

  it('forged owners cannot survive insert or update', async () => {
    const forged = await harness.port.tiers.insert(alice.principal, {
      key: `forge-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: bob.userId,
      orgId: 'org-x',
    } as TierInsertInput);
    expect(forged.ownerUserId).toBe(alice.userId);
    expect(forged.orgId).toBeNull();

    const updated = await harness.port.tiers.update(alice.principal, forged.id, {
      ownerUserId: bob.userId,
      id: 'new-id',
      displayName: 'renamed',
    } as never);
    expect(updated?.id).toBe(forged.id);
    expect(updated?.ownerUserId).toBe(alice.userId);
    expect(updated?.displayName).toBe('renamed');
  });

  it('cross-tenant parenting fails closed (models via providers)', async () => {
    const bobsProvider = await harness.port.providers.insert(bob.principal, providerValues);

    // A cannot create a model under B's provider
    const stolen = await harness.port.models.createForProvider(alice.principal, bobsProvider.id, {
      externalModelId: 'gpt-x',
    });
    expect(stolen).toBeNull();

    // B can; A cannot see, update, or delete it — and providerId is immutable
    const model = await harness.port.models.createForProvider(bob.principal, bobsProvider.id, {
      externalModelId: `m-${Math.random().toString(36).slice(2, 8)}`,
    });
    expect(model).not.toBeNull();
    expect(await harness.port.models.findById(alice.principal, model!.id)).toBeNull();
    expect(
      await harness.port.models.update(alice.principal, model!.id, { displayName: 'x' }),
    ).toBeNull();
    expect(await harness.port.models.remove(alice.principal, model!.id)).toBe(false);

    const alicesProvider = await harness.port.providers.insert(alice.principal, providerValues);
    const repointed = await harness.port.models.update(bob.principal, model!.id, {
      providerId: alicesProvider.id,
      displayName: 'kept',
    } as never);
    expect(repointed?.providerId).toBe(bobsProvider.id);
    expect(repointed?.displayName).toBe('kept');
  });

  it('cross-tenant parenting fails closed (routing entries via tiers + models)', async () => {
    const bobsTier = await harness.port.tiers.insert(bob.principal, {
      key: `bt-${Math.random().toString(36).slice(2, 8)}`,
    });
    const bobsProvider = await harness.port.providers.insert(bob.principal, providerValues);
    const bobsModel = await harness.port.models.createForProvider(bob.principal, bobsProvider.id, {
      externalModelId: `bm-${Math.random().toString(36).slice(2, 8)}`,
    });
    const alicesTier = await harness.port.tiers.insert(alice.principal, {
      key: `at-${Math.random().toString(36).slice(2, 8)}`,
    });

    // A's tier + B's model → rejected; B's tier + anything, requested by A → rejected
    expect(
      await harness.port.routingEntries.add(alice.principal, {
        tierId: alicesTier.id,
        modelId: bobsModel!.id,
        position: 0,
      }),
    ).toBeNull();
    expect(
      await harness.port.routingEntries.add(alice.principal, {
        tierId: bobsTier.id,
        modelId: bobsModel!.id,
        position: 0,
      }),
    ).toBeNull();

    // B links B's tier to B's model — fine; A cannot touch the entry
    const entry = await harness.port.routingEntries.add(bob.principal, {
      tierId: bobsTier.id,
      modelId: bobsModel!.id,
      position: 0,
    });
    expect(entry).not.toBeNull();
    expect(await harness.port.routingEntries.setPosition(alice.principal, entry!.id, 1)).toBeNull();
    expect(await harness.port.routingEntries.remove(alice.principal, entry!.id)).toBe(false);
    expect((await harness.port.routingEntries.listForTier(bob.principal, bobsTier.id)).length).toBe(
      1,
    );
  });

  it('privileged facilities hand out a scoped port, never a raw handle', async () => {
    const result = await harness.facilities.withTransaction(async (tx) => {
      const surface = tx as unknown as Record<string, unknown>;
      expect(surface['query']).toBeUndefined();
      expect(surface['execute']).toBeUndefined();
      expect(surface['select']).toBeUndefined();
      expect(surface['transaction']).toBeUndefined();
      // the scoped port works inside the transaction
      const tier = await tx.tiers.insert(alice.principal, {
        key: `tx-${Math.random().toString(36).slice(2, 8)}`,
      });
      return tier.ownerUserId;
    });
    expect(result).toBe(alice.userId);

    const count = await harness.facilities.withAdvisoryLock(4711, async (tx) => tx.users.count());
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('raw drizzle/pool providers cannot be injected outside the database module', async () => {
    for (const token of [DRIZZLE, PG_POOL]) {
      const compile = NestTest.createTestingModule({
        imports: [DatabaseModule],
        providers: [{ provide: 'PROBE', useFactory: (raw: unknown) => raw, inject: [token] }],
      }).compile();
      await expect(compile).rejects.toThrow(/resolve|dependency/i);
    }
  });

  it('the persistence seam resolves by the shared token alone', async () => {
    // A consumer knowing ONLY @polyrouter/shared/server — the exact pattern
    // the data-plane (#10/#11) uses without importing control-plane.
    const moduleRef = await NestTest.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        {
          provide: 'CONSUMER',
          useFactory: (port: PersistencePort) => port,
          inject: [PERSISTENCE_PORT],
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const consumer = app.get<PersistencePort>('CONSUMER');
      expect(typeof consumer.agents.findById).toBe('function');
      expect((consumer as unknown as Record<string, unknown>)['execute']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
