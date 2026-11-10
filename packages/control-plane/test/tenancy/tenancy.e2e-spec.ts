import 'reflect-metadata';
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test as NestTest } from '@nestjs/testing';
import request from 'supertest';
import {
  PERSISTENCE_MAINTENANCE,
  PERSISTENCE_PORT,
  userPrincipal,
} from '@polyrouter/shared/server';
import type { PlanCooldownStore } from '@polyrouter/data-plane';
import type {
  AgentInsertInput,
  BatchJobInsertInput,
  PersistenceMaintenance,
  PersistencePort,
  Principal,
  ProviderInsertInput,
  RoutingRuleInsertInput,
  TierInsertInput,
} from '@polyrouter/shared/server';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { ProvidersModule } from '../../src/providers/providers.module';
import {
  PROVIDER_ADAPTER_FACTORY,
  type ProviderAdapterFactory,
} from '../../src/providers/providers.service';
import {
  KEY_PRESET_LOOKUP,
  OPENCODE_GO_PRESET,
  type KeyPresetRegistry,
} from '../../src/subscription-presets/key-presets';
import { PLAN_COOLDOWN_STORE } from '../../src/plan-cooldown/plan-cooldown.module';
import { SubscriptionPresetsModule } from '../../src/subscription-presets/subscription-presets.module';
import { DRIZZLE, PG_POOL } from '../../src/database/database.internal';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabaseMaintenanceModule } from '../../src/database/maintenance.module';
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

const batchJobValues = (): BatchJobInsertInput => ({
  id: `job-${Math.random().toString(36).slice(2, 12)}`,
  agentId: 'agent-1',
  providerId: 'prov-1',
  modelId: 'model-1',
  tierAssigned: null,
  endpoint: '/v1/chat/completions',
  protocol: 'openai_compatible',
  providerKind: 'api_key',
  itemCount: 3,
  estimatedInputTokens: 300,
  priceMode: 'batch',
  inputPriceSnapshot: 1.25,
  outputPriceSnapshot: 5,
  cacheReadPriceSnapshot: null,
  cacheWritePriceSnapshot: null,
  priceVersionId: 'v1',
  priceSource: 'bundled',
  reservedCeilingMicros: 10_000,
  completionWindowMs: 86_400_000,
});

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

  // allow-preset-client-identity: the identity-imitation switch is an owner-scoped write like
  // every other provider column; another tenant's PATCH affects nothing and sees nothing.
  it('another tenant cannot flip a provider’s identity-imitation switch', async () => {
    const bobs = await harness.port.providers.insert(bob.principal, {
      ...providerValues,
      kind: 'subscription',
      oauthPreset: 'stub-identity',
    });
    expect(bobs.imitateClientIdentity).toBe(false);
    expect(
      await harness.port.providers.update(alice.principal, bobs.id, {
        imitateClientIdentity: true,
      }),
    ).toBeNull();
    expect(
      (await harness.port.providers.findById(bob.principal, bobs.id))?.imitateClientIdentity,
    ).toBe(false);
    // The owner's own write lands.
    expect(
      (
        await harness.port.providers.update(bob.principal, bobs.id, {
          imitateClientIdentity: true,
        })
      )?.imitateClientIdentity,
    ).toBe(true);
    expect(await harness.port.providers.remove(bob.principal, bobs.id)).toBe(true);
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
      // add-model-variant-detection: the derived classification is owner-scoped
      // like every other model field — a cross-tenant read must not reveal it,
      // and a cross-tenant write must not set it.
      variant: 'batch',
    });
    expect(model).not.toBeNull();
    expect(model!.variant).toBe('batch');
    expect(await harness.port.models.findById(alice.principal, model!.id)).toBeNull();
    expect(
      await harness.port.models.update(alice.principal, model!.id, { variant: null }),
    ).toBeNull();
    expect((await harness.port.models.findById(bob.principal, model!.id))!.variant).toBe('batch');
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

  // add-auto-prune-unlisted-models: the prune and the rule-target lock are owner-scoped.
  it('another tenant can neither prune my retired models nor target them from a rule', async () => {
    const bobsProvider = await harness.port.providers.insert(bob.principal, providerValues);
    const bobsModel = (await harness.port.models.createForProvider(bob.principal, bobsProvider.id, {
      externalModelId: `bp-${Math.random().toString(36).slice(2, 8)}`,
    }))!;
    await harness.pool.query(
      `UPDATE model SET unlisted_since = now() - interval '30 days' WHERE id = $1`,
      [bobsModel.id],
    );
    const guard = {
      envelope: bobsProvider.encryptedCredentials,
      baseUrl: bobsProvider.baseUrl,
      protocol: bobsProvider.protocol,
    };
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Alice, holding the correct incarnation guard, still prunes nothing of Bob's.
    expect(
      await harness.port.models.pruneUnlisted(
        alice.principal,
        bobsProvider.id,
        cutoff,
        guard,
        () => false,
      ),
    ).toBe(0);
    expect(await harness.port.models.findById(bob.principal, bobsModel.id)).not.toBeNull();

    // Alice cannot point a rule at Bob's model (it reads as gone to her), on insert or update.
    expect(
      await harness.port.routingRules.insertLockingTarget(alice.principal, {
        matchType: 'default',
        target: `model:${bobsModel.id}`,
      }),
    ).toBe('target_gone');
    const hers = await harness.port.routingRules.insert(alice.principal, {
      matchType: 'default',
      target: 'tier:default',
    });
    expect(
      await harness.port.routingRules.updateLockingTarget(alice.principal, hers.id, {
        target: `model:${bobsModel.id}`,
      }),
    ).toBe('target_gone');
    expect((await harness.port.routingRules.findById(alice.principal, hers.id))!.target).toBe(
      'tier:default',
    );

    // Bob prunes his own.
    expect(
      await harness.port.models.pruneUnlisted(
        bob.principal,
        bobsProvider.id,
        cutoff,
        guard,
        () => false,
      ),
    ).toBe(1);
    expect(await harness.port.models.findById(bob.principal, bobsModel.id)).toBeNull();
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

describe('batch jobs are owner-scoped on every surface (add-batch-inference, task 2.3)', () => {
  it('another tenant’s job is a missing job for reads, listings, cancels, and settlement', async () => {
    const jobs = harness.port.batchJobs;
    const mine = await jobs.insert(bob.principal, batchJobValues());
    expect(mine.status).toBe('submitting'); // forced, not caller-assignable
    expect(mine.ownerUserId).toBe(bob.userId);

    // reads
    expect(await jobs.findById(alice.principal, mine.id)).toBeNull();
    expect(await jobs.findById(alice.principal, 'does-not-exist')).toBeNull();
    expect((await jobs.listActive(alice.principal)).map((j) => j.id)).not.toContain(mine.id);
    expect((await jobs.list(alice.principal, { limit: 50 })).rows.map((j) => j.id)).not.toContain(
      mine.id,
    );
    // a cancel intent and a status transition from the wrong tenant touch nothing
    expect(await jobs.update(alice.principal, mine.id, { cancelRequested: true })).toBeNull();
    expect(
      await jobs.update(
        alice.principal,
        mine.id,
        { status: 'failed' },
        { whenStatusIn: ['submitting'] },
      ),
    ).toBeNull();
    expect(
      await jobs.settle(alice.principal, mine.id, {
        status: 'completed',
        completedCount: 3,
        failedCount: 0,
        settledCostMicros: 1,
        terminalAt: new Date(),
      }),
    ).toBeNull();
    const untouched = await jobs.findById(bob.principal, mine.id);
    expect(untouched?.status).toBe('submitting');
    expect(untouched?.cancelRequested).toBe(false);
    expect(untouched?.terminalAt).toBeNull();

    // the owner's own paths work — and the CAS is real
    expect(
      await jobs.update(
        bob.principal,
        mine.id,
        { status: 'failed' },
        { whenStatusIn: ['in_progress'] },
      ),
    ).toBeNull();
    const moved = await jobs.update(
      bob.principal,
      mine.id,
      { status: 'validating', upstreamBatchId: 'up-1' },
      { whenStatusIn: ['submitting'] },
    );
    expect(moved?.status).toBe('validating');
    expect(moved?.upstreamBatchId).toBe('up-1');
  });

  it('the poller’s sweep sees every tenant’s live jobs, each carrying its own owner', async () => {
    const a = await harness.port.batchJobs.insert(alice.principal, batchJobValues());
    const b = await harness.port.batchJobs.insert(bob.principal, batchJobValues());
    const swept = await harness.maintenance.batchJobs.listNonTerminal(1_000);
    const byId = new Map(swept.map((j) => [j.id, j]));
    expect(byId.get(a.id)?.ownerUserId).toBe(alice.userId);
    expect(byId.get(b.id)?.ownerUserId).toBe(bob.userId);
    // The sweep hands out rows, never a by-id read: there is no such method.
    expect(
      (harness.maintenance.batchJobs as unknown as Record<string, unknown>)['findById'],
    ).toBeUndefined();
  });

  // add-provider-health-signals (task 7.1): the OAuth refresh sweep's listing.
  it('the OAuth sweep lists every tenant’s connected providers — id-paged, owner-carrying, nothing secret', async () => {
    // 501 OAuth rows for alice (a third of them with an unknown expiry), plus bob's.
    await harness.pool.query(
      `INSERT INTO provider (id, owner_user_id, name, kind, protocol, base_url, encrypted_credentials,
                             oauth_preset, credential_expires_at)
       SELECT gen_random_uuid(), $1, 'sweep', 'subscription', 'anthropic_compatible',
              'https://1.1.1.1/v1', 'poly-enc:v1:sealed', 'claude',
              CASE WHEN g % 3 = 0 THEN NULL ELSE now() + (g || ' minutes')::interval END
         FROM generate_series(1, 501) AS g`,
      [alice.userId],
    );
    const bobs = await harness.port.providers.insert(bob.principal, {
      name: 'bob-sub',
      kind: 'subscription',
      protocol: 'anthropic_compatible',
      baseUrl: 'https://1.1.1.1/v1',
      encryptedCredentials: 'poly-enc:v1:bob',
      oauthPreset: 'claude',
    });
    // Excluded: errored, cleared, and non-OAuth rows.
    const excluded = [
      await harness.port.providers.insert(alice.principal, {
        name: 'errored',
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://1.1.1.1/v1',
        encryptedCredentials: 'x',
        oauthPreset: 'claude',
        credentialError: 'reauthorize_required',
      }),
      await harness.port.providers.insert(alice.principal, {
        name: 'cleared',
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://1.1.1.1/v1',
        oauthPreset: 'claude',
      }),
      await harness.port.providers.insert(alice.principal, {
        name: 'plain',
        kind: 'api_key',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://1.1.1.1/v1',
        encryptedCredentials: 'x',
      }),
    ].map((r) => r.id);

    const seen: Array<{ id: string; ownerUserId: string; credentialExpiresAt: Date | null }> = [];
    let afterId: string | null = null;
    for (;;) {
      const page = await harness.maintenance.providers.listOauthConnected({ afterId, limit: 100 });
      if (page.length === 0) break;
      for (const row of page) {
        // Only the three non-secret identifying fields — never the envelope.
        expect(Object.keys(row).sort()).toEqual(['credentialExpiresAt', 'id', 'ownerUserId']);
      }
      seen.push(...page);
      afterId = page[page.length - 1]!.id;
    }
    const ids = seen.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // each row exactly once
    const alices = seen.filter((r) => r.ownerUserId === alice.userId);
    expect(alices).toHaveLength(501);
    expect(alices.filter((r) => r.credentialExpiresAt === null)).toHaveLength(167);
    expect(seen.find((r) => r.id === bobs.id)?.ownerUserId).toBe(bob.userId);
    for (const id of excluded) expect(ids).not.toContain(id);
    expect(JSON.stringify(seen)).not.toContain('poly-enc');

    // add-live-subscription-models: the model-catalog refresh's listing — every provider
    // that can list its models (credentialed, or local), minus any awaiting reconnect;
    // identifying fields only, each row exactly once, across owners.
    const catalog: Array<{ id: string; ownerUserId: string }> = [];
    let cAfter: string | null = null;
    for (;;) {
      const page = await harness.maintenance.providers.listCatalogRefreshable({
        afterId: cAfter,
        limit: 100,
        includeLocal: true,
      });
      if (page.length === 0) break;
      for (const row of page) expect(Object.keys(row).sort()).toEqual(['id', 'ownerUserId']);
      catalog.push(...page);
      cAfter = page[page.length - 1]!.id;
    }
    const cIds = catalog.map((r) => r.id);
    expect(new Set(cIds).size).toBe(cIds.length);
    expect(cIds).toContain(excluded[2]); // the plain api_key row: listable
    expect(cIds).not.toContain(excluded[0]); // awaiting reconnect
    expect(cIds).not.toContain(excluded[1]); // no credential
    expect(catalog.find((r) => r.id === bobs.id)?.ownerUserId).toBe(bob.userId);
    expect(JSON.stringify(catalog)).not.toContain('poly-enc');
    // List-only: no by-id read on this surface either.
    expect(
      (harness.maintenance.providers as unknown as Record<string, unknown>)['findById'],
    ).toBeUndefined();
  });
});

/** add-subscription-usage-history (task 1.2): the plan-usage history's port methods against the
 * real database. Samples are owned THROUGH their provider: the sampler's writes are system writes
 * on the maintenance surface, and the history read is owner-scoped. */
describe('plan-usage samples (add-subscription-usage-history, task 1.2)', () => {
  const T = (iso: string): Date => new Date(iso);
  const subscriptionRow = (over: Partial<ProviderInsertInput> = {}): ProviderInsertInput => ({
    name: 'pu-kimi',
    kind: 'subscription',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    keyPreset: 'kimi-code',
    encryptedCredentials: 'poly-enc-stub',
    ...over,
  });
  const sample = (
    providerId: string,
    observedAt: string,
    usedPercent: number | null,
    windowKey = 'account:5h',
  ) => ({
    providerId,
    windowKey,
    usedPercent,
    resetAt: usedPercent === null ? null : T('2026-11-09T15:00:00.000Z'),
    observedAt: T(observedAt),
  });
  const countFor = async (providerId: string): Promise<number> =>
    (
      await harness.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM plan_usage_sample WHERE provider_id = $1',
        [providerId],
      )
    ).rows[0]!.n;

  it('a duplicate observation is skipped, a 101 is refused, and a vanished provider costs only its own samples', async () => {
    const m = harness.maintenance.planUsageSamples;
    const p = await harness.port.providers.insert(alice.principal, subscriptionRow());
    const first = [
      sample(p.id, '2026-11-09T10:05:00.000Z', 12),
      sample(p.id, '2026-11-09T10:20:00.000Z', 14),
      sample(p.id, '2026-11-09T10:05:00.000Z', 3, 'account:weekly'),
    ];
    await expect(m.insertPlanUsageSamples(first)).resolves.toBe(3);
    // The same three again plus one new observation: only the new one lands.
    await expect(
      m.insertPlanUsageSamples([...first, sample(p.id, '2026-11-09T10:35:00.000Z', null)]),
    ).resolves.toBe(1);
    expect(await countFor(p.id)).toBe(4);

    // Out of range: the database refuses it (and the batch with it), and nothing lands.
    await expect(
      m.insertPlanUsageSamples([sample(p.id, '2026-11-09T10:50:00.000Z', 101)]),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    expect(await countFor(p.id)).toBe(4);

    // A provider deleted between the listing and the write: its samples are skipped, the rest
    // land.
    await expect(
      m.insertPlanUsageSamples([
        sample('00000000-0000-4000-8000-000000000000', '2026-11-09T10:50:00.000Z', 5),
        sample(p.id, '2026-11-09T10:50:00.000Z', 15),
      ]),
    ).resolves.toBe(1);
    expect(await countFor(p.id)).toBe(5);
  });

  it('the owner reads per-window spans oldest first, with an unknown percent kept as null; another tenant reads nothing', async () => {
    const m = harness.maintenance.planUsageSamples;
    const p = await harness.port.providers.insert(alice.principal, subscriptionRow());
    await m.insertPlanUsageSamples([
      sample(p.id, '2026-11-09T10:20:00.000Z', 14),
      sample(p.id, '2026-11-09T09:05:00.000Z', 9), // before the 5h span start below
      sample(p.id, '2026-11-09T10:05:00.000Z', null),
      sample(p.id, '2026-11-02T10:05:00.000Z', 30, 'account:weekly'), // older than the fallback
      sample(p.id, '2026-11-08T10:05:00.000Z', 40, 'account:weekly'),
      sample(p.id, '2026-11-09T10:10:00.000Z', 50, 'model:spark'),
    ]);
    const spans = new Map([
      ['account:5h', T('2026-11-09T10:00:00.000Z')],
      ['account:weekly', T('2026-11-05T00:00:00.000Z')],
    ]);
    const read = await harness.port.planUsageSamples.listPlanUsageSamples(
      alice.principal,
      p.id,
      spans,
    );
    expect(read.map((r) => [r.windowKey, r.observedAt.toISOString(), r.usedPercent])).toEqual(
      [
        ['account:5h', '2026-11-09T10:05:00.000Z', null],
        ['account:5h', '2026-11-09T10:20:00.000Z', 14],
        ['account:weekly', '2026-11-08T10:05:00.000Z', 40],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    );
    expect(typeof read.find((r) => r.usedPercent !== null)?.usedPercent).toBe('number');
    expect(read.find((r) => r.usedPercent === 14)?.resetAt?.toISOString()).toBe(
      '2026-11-09T15:00:00.000Z',
    );
    // The fallback adds every OTHER window from its own bound.
    const withOthers = await harness.port.planUsageSamples.listPlanUsageSamples(
      alice.principal,
      p.id,
      spans,
      T('2026-11-09T00:00:00.000Z'),
    );
    expect(withOthers.map((r) => r.windowKey)).toContain('model:spark');
    expect(withOthers.filter((r) => r.windowKey === 'account:weekly')).toHaveLength(1);

    // Another tenant reads nothing, for any argument.
    for (const since of [spans, new Map<string, Date>()]) {
      await expect(
        harness.port.planUsageSamples.listPlanUsageSamples(
          bob.principal,
          p.id,
          since,
          T('2000-01-01T00:00:00.000Z'),
        ),
      ).resolves.toEqual([]);
    }
  });

  it('the prune deletes a bounded batch of expired samples only, and a provider delete cascades', async () => {
    const m = harness.maintenance.planUsageSamples;
    const p = await harness.port.providers.insert(alice.principal, subscriptionRow());
    await m.insertPlanUsageSamples([
      sample(p.id, '2000-01-01T00:00:00.000Z', 1),
      sample(p.id, '2000-01-01T00:15:00.000Z', 2),
      sample(p.id, '2000-01-01T00:30:00.000Z', 3),
      sample(p.id, '2026-11-09T10:05:00.000Z', 4),
    ]);
    const before = T('2001-01-01T00:00:00.000Z');
    // Other suites may have their own expired rows: the bound holds whatever exists.
    await expect(m.prunePlanUsageSamples(before, 1)).resolves.toBe(1);
    let deleted = 0;
    for (let i = 0; i < 100_000; i += 1) {
      const n = await m.prunePlanUsageSamples(before, 2);
      expect(n).toBeLessThanOrEqual(2);
      deleted += n;
      if (n < 2) break;
    }
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await countFor(p.id)).toBe(1); // only the recent sample is left

    await expect(harness.port.providers.remove(alice.principal, p.id)).resolves.toBe(true);
    expect(await countFor(p.id)).toBe(0);
  });

  it('the schedule listing carries preset-bound, switched-on, credentialed rows across owners, and nothing secret', async () => {
    const mine = new Map<string, string>();
    const add = async (label: string, who: TestPrincipal, over: Partial<ProviderInsertInput>) =>
      mine.set(
        (await harness.port.providers.insert(who.principal, subscriptionRow(over))).id,
        label,
      );
    await add('kimi', alice, {});
    await add('bobs-claude', bob, {
      protocol: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com/',
      keyPreset: null,
      oauthPreset: 'claude',
    });
    await add('switched-off', alice, { checkPlanUsage: false });
    await add('reconnect', alice, { credentialError: 'reauthorize_required' });
    await add('no-credential', alice, { encryptedCredentials: null });
    await add('pasted', alice, { keyPreset: null });
    await add('api-key', alice, { kind: 'api_key', keyPreset: null });

    const seen: Array<{ id: string; ownerUserId: string }> = [];
    let afterId: string | null = null;
    for (;;) {
      const page = await harness.maintenance.providers.listPlanUsageScheduled({
        afterId,
        limit: 100,
      });
      if (page.length === 0) break;
      for (const row of page) {
        expect(Object.keys(row).sort()).toEqual([
          'baseUrl',
          'checkPlanUsage',
          'credentialError',
          'id',
          'keyPreset',
          'kind',
          'oauthPreset',
          'ownerUserId',
          'protocol',
        ]);
      }
      seen.push(...page);
      afterId = page[page.length - 1]!.id;
    }
    const labels = seen.filter((r) => mine.has(r.id)).map((r) => mine.get(r.id));
    expect(labels.sort()).toEqual(['bobs-claude', 'kimi']);
    expect(seen.find((r) => mine.get(r.id) === 'bobs-claude')?.ownerUserId).toBe(bob.userId);
    expect(JSON.stringify(seen)).not.toContain('poly-enc');
  });
});

describe('the maintenance token is a real module boundary (add-batch-inference, task 2.2)', () => {
  it('cannot be injected by a module that imports only DatabaseModule', async () => {
    const compile = NestTest.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        { provide: 'PROBE', useFactory: (m: unknown) => m, inject: [PERSISTENCE_MAINTENANCE] },
      ],
    }).compile();
    await expect(compile).rejects.toThrow(/resolve|dependency/i);
  });

  it('resolves for a scheduler module importing the maintenance module, with no raw handle in reach', async () => {
    for (const token of [DRIZZLE, PG_POOL]) {
      const compile = NestTest.createTestingModule({
        imports: [DatabaseMaintenanceModule],
        providers: [{ provide: 'PROBE', useFactory: (raw: unknown) => raw, inject: [token] }],
      }).compile();
      await expect(compile).rejects.toThrow(/resolve|dependency/i);
    }
    const moduleRef = await NestTest.createTestingModule({
      imports: [DatabaseMaintenanceModule],
      providers: [
        {
          provide: 'SCHEDULER',
          useFactory: (m: PersistenceMaintenance) => m,
          inject: [PERSISTENCE_MAINTENANCE],
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const m = app.get<PersistenceMaintenance>('SCHEDULER');
      expect(typeof m.models.classifyVariants).toBe('function');
      expect(typeof m.batchJobs.listNonTerminal).toBe('function');
      expect(typeof m.reservations.pendingMicrosFor).toBe('function');
      expect(typeof m.providers.listOauthConnected).toBe('function');
      expect(typeof m.providers.listCatalogRefreshable).toBe('function');
      expect(typeof m.providers.listPlanUsageScheduled).toBe('function');
      expect(typeof m.planUsageSamples.insertPlanUsageSamples).toBe('function');
      expect(typeof m.planUsageSamples.prunePlanUsageSamples).toBe('function');
      // No member — at any depth — is a query builder or a raw handle.
      for (const surface of [
        m,
        m.models,
        m.batchJobs,
        m.reservations,
        m.providers,
        m.planUsageSamples,
      ]) {
        const rec = surface as unknown as Record<string, unknown>;
        for (const forbidden of ['query', 'execute', 'select', 'transaction', 'insert', 'db']) {
          expect(rec[forbidden]).toBeUndefined();
        }
      }
    } finally {
      await app.close();
    }
  });

  it('the scoped port gained no unscoped method — the classification pass left it', () => {
    const port = harness.port as unknown as Record<string, unknown>;
    expect(port['modelMaintenance']).toBeUndefined();
    expect(typeof harness.port.batchJobs.findById).toBe('function');
    expect(harness.port.batchJobs.findById.length).toBe(2); // (principal, id) — never bare
  });

  it('no controller-bearing (request-handling) module in the application imports the maintenance module', () => {
    // Walk the static module graph by metadata — no boot needed. A module with
    // controllers handles requests; it must reach persistence only through
    // DatabaseModule's scoped port.
    type ModuleLike = (new () => unknown) | { module: new () => unknown; imports?: unknown[] };
    const seen = new Set<unknown>();
    const offenders: string[] = [];
    const visit = (m: ModuleLike): void => {
      const cls = typeof m === 'function' ? m : m.module;
      if (seen.has(cls)) return;
      seen.add(cls);
      const imports = [
        ...((Reflect.getMetadata('imports', cls) as ModuleLike[] | undefined) ?? []),
        ...(typeof m === 'function' ? [] : ((m.imports as ModuleLike[] | undefined) ?? [])),
      ];
      const controllers = (Reflect.getMetadata('controllers', cls) as unknown[] | undefined) ?? [];
      const importsMaintenance = imports.some(
        (i) => (typeof i === 'function' ? i : i.module) === DatabaseMaintenanceModule,
      );
      if (controllers.length > 0 && importsMaintenance) offenders.push(cls.name);
      for (const i of imports) visit(i);
    };
    visit(AppModule);
    expect(seen.size).toBeGreaterThan(10);
    expect(seen.has(DatabaseMaintenanceModule)).toBe(true); // the walk reached it via a scheduler/bootstrap module
    expect(offenders).toEqual([]);
  });
});

// add-key-subscription-presets (task 5.4): the connect endpoint creates an ordinary
// owner-scoped provider row, so another tenant's by-id access is indistinguishable from a
// nonexistent id, over HTTP and at the port.
@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

describe('key-preset connect is tenant-isolated (add-key-subscription-presets, task 5.4)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let factoryCalls = 0;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    process.env['BIND_ADDRESS'] = '127.0.0.1';
    // Enabled only through the lookup override, with the bundled pin (never a shipped flag).
    const registry: KeyPresetRegistry = {
      find: (id) => (id === OPENCODE_GO_PRESET.id ? enabledGo : undefined),
      list: () => [enabledGo],
    };
    const enabledGo = {
      ...OPENCODE_GO_PRESET,
      regions: OPENCODE_GO_PRESET.regions.map((r) => ({ ...r, enabled: true })),
    };
    const moduleRef = await NestTest.createTestingModule({
      imports: [ProvidersModule, SubscriptionPresetsModule],
      providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
    })
      .overrideProvider(PROVIDER_ADAPTER_FACTORY)
      .useValue((() => {
        factoryCalls += 1;
        throw new Error('a cross-tenant action must never build an adapter');
      }) as unknown as ProviderAdapterFactory)
      .overrideProvider(KEY_PRESET_LOOKUP)
      .useValue(registry)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' }, 'http://localhost:3000');
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('tenant B cannot see, read, test, sync, update or delete tenant A’s key-preset row', async () => {
    const created = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', alice.userId)
      .send({ preset: 'opencode-go', credential: 'sk-tenancy-a' });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(created.body.keyPreset).toBe('opencode-go');
    const before = await harness.port.providers.findById(alice.principal, id);
    expect(before?.ownerUserId).toBe(alice.userId);

    // Tenant B: the list excludes it, and every by-id action is a plain 404.
    const asB = (t: request.Test): request.Test => t.set('x-test-user', bob.userId);
    const list = await asB(request(server).get('/api/providers'));
    expect((list.body as Array<{ id: string }>).map((p) => p.id)).not.toContain(id);
    // Built lazily and awaited one at a time: supertest closes the server after each call.
    const attempts: Array<() => request.Test> = [
      () => request(server).get(`/api/providers/${id}`),
      () => request(server).patch(`/api/providers/${id}`).send({ name: 'hijacked' }),
      () => request(server).patch(`/api/providers/${id}`).send({ credential: 'stolen' }),
      () => request(server).delete(`/api/providers/${id}`),
      () => request(server).post(`/api/providers/${id}/test-connection`),
      () => request(server).post(`/api/providers/${id}/sync-models`),
      // add-dismissible-terms-risk 2.3: the acknowledgment is owner-scoped too.
      () => request(server).post(`/api/providers/${id}/terms-risk/acknowledge`),
    ];
    for (const attempt of attempts) expect((await asB(attempt())).status).toBe(404);
    expect(factoryCalls).toBe(0);

    // Port level: invisible to B, untouched for A.
    expect(await harness.port.providers.findById(bob.principal, id)).toBeNull();
    expect(await harness.port.providers.update(bob.principal, id, { name: 'hijacked' })).toBeNull();
    expect(await harness.port.providers.remove(bob.principal, id)).toBe(false);
    const intact = await harness.port.providers.findById(alice.principal, id);
    expect(intact).toMatchObject({ name: 'OpenCode Go', keyPreset: 'opencode-go' });
    expect(intact?.encryptedCredentials).toBe(before?.encryptedCredentials);

    // The owner still reads it; the connect cannot be pointed at another tenant.
    expect(
      (await request(server).get(`/api/providers/${id}`).set('x-test-user', alice.userId)).status,
    ).toBe(200);
    const forged = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', bob.userId)
      .send({ preset: 'opencode-go', credential: 'k', ownerUserId: alice.userId });
    expect(forged.status).toBe(400);
    const bobConnect = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', bob.userId)
      .send({ preset: 'opencode-go', credential: 'sk-tenancy-b' });
    expect(bobConnect.status).toBe(200);
    expect(
      (await harness.port.providers.findById(bob.principal, bobConnect.body.id as string))
        ?.ownerUserId,
    ).toBe(bob.userId);
    expect(
      await harness.port.providers.findById(alice.principal, bobConnect.body.id as string),
    ).toBeNull();
  });

  // add-dismissible-terms-risk task 2.3 (provider-management "Another tenant cannot acknowledge
  // a provider"): another tenant's acknowledge is a plain 404 and records nothing; the owner's
  // own acknowledge lands (invariant 5).
  it('another tenant cannot acknowledge a provider’s terms risk', async () => {
    const created = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', alice.userId)
      .send({ preset: 'opencode-go', credential: 'sk-tenancy-tr' });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(created.body.termsRiskAcknowledgedAt).toBeNull();

    const byBob = await request(server)
      .post(`/api/providers/${id}/terms-risk/acknowledge`)
      .set('x-test-user', bob.userId);
    expect(byBob.status).toBe(404);
    expect(JSON.stringify(byBob.body)).not.toContain(id);
    expect(
      (await harness.port.providers.findById(alice.principal, id))?.termsRiskAcknowledgedAt,
    ).toBeNull();
    // Port level: B's write affects nothing.
    expect(
      await harness.port.providers.update(bob.principal, id, {
        termsRiskAcknowledgedAt: new Date(),
      }),
    ).toBeNull();
    expect(
      (await harness.port.providers.findById(alice.principal, id))?.termsRiskAcknowledgedAt,
    ).toBeNull();

    const byAlice = await request(server)
      .post(`/api/providers/${id}/terms-risk/acknowledge`)
      .set('x-test-user', alice.userId);
    expect(byAlice.status).toBe(200);
    expect(byAlice.body.termsRiskAcknowledgedAt).not.toBeNull();
  });

  // classify-plan-quota-errors task 7.2: the lift is owner-scoped BEFORE it touches a key.
  it('tenant B cannot read or lift tenant A’s plan cooldown, and it survives the attempt', async () => {
    const created = await request(server)
      .post('/api/providers/key-presets/connect')
      .set('x-test-user', alice.userId)
      .send({ preset: 'opencode-go', credential: 'sk-tenancy-cooldown' });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    const store = app.get<PlanCooldownStore>(PLAN_COOLDOWN_STORE);
    await store.record(id, { kind: 'quota_exhausted', default: 15 * 60_000 });

    const asB = (t: request.Test): request.Test => t.set('x-test-user', bob.userId);
    expect((await asB(request(server).get(`/api/providers/${id}`))).status).toBe(404);
    expect((await asB(request(server).delete(`/api/providers/${id}/plan-cooldown`))).status).toBe(
      404,
    );
    const listB = await asB(request(server).get('/api/providers'));
    expect(listB.status).toBe(200);
    expect((listB.body as Array<{ id: string }>).map((p) => p.id)).not.toContain(id);
    // A's cooldown (a key in Redis) is still there after B's attempts.
    expect(await store.check(id)).toMatchObject({ kind: 'quota_exhausted' });

    // The owner's own lift works.
    expect(
      (
        await request(server)
          .delete(`/api/providers/${id}/plan-cooldown`)
          .set('x-test-user', alice.userId)
      ).status,
    ).toBe(204);
    expect(await store.check(id)).toBeNull();
  });
});
