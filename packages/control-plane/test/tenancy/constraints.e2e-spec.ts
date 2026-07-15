import type { ModelRow, ProviderInsertInput } from '@polyrouter/shared/server';
import { TenancyHarness, type TestPrincipal } from './harness';

/** Database-enforced constraints (database-schema DoD): the §7.4 five-total
 * cap survives NULLs, races, and out-of-range positions; catalog sync is
 * idempotent; default-tier provisioning is race-safe. */

let harness: TenancyHarness;
let owner: TestPrincipal;

beforeAll(async () => {
  harness = await TenancyHarness.create();
  owner = await harness.createTestPrincipal('constraints');
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

const providerValues: ProviderInsertInput = {
  name: 'p',
  kind: 'api_key',
  protocol: 'openai_compatible',
};

async function makeModels(count: number): Promise<ModelRow[]> {
  const provider = await harness.port.providers.insert(owner.principal, providerValues);
  const rows: ModelRow[] = [];
  for (let i = 0; i < count; i++) {
    const row = await harness.port.models.createForProvider(owner.principal, provider.id, {
      externalModelId: `m-${String(i)}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (!row) throw new Error('model creation failed unexpectedly');
    rows.push(row);
  }
  return rows;
}

describe('schema constraints', () => {
  it('caps a tier at five models total — sixth, out-of-range, and NULL positions are rejected', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `cap-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(7);
    for (let position = 0; position < 5; position++) {
      const entry = await harness.port.routingEntries.add(owner.principal, {
        tierId: tier.id,
        modelId: models[position]!.id,
        position,
      });
      expect(entry).not.toBeNull();
    }
    // sixth entry: every position 0–4 is taken (unique) and 5 is out of range (CHECK)
    await expect(
      harness.port.routingEntries.add(owner.principal, {
        tierId: tier.id,
        modelId: models[5]!.id,
        position: 5,
      }),
    ).rejects.toThrow();
    await expect(
      harness.port.routingEntries.add(owner.principal, {
        tierId: tier.id,
        modelId: models[5]!.id,
        position: 0,
      }),
    ).rejects.toThrow();
    // NULL position cannot sneak past the cap (NOT NULL column)
    await expect(
      harness.pool.query(
        'INSERT INTO routing_entry (id, tier_id, model_id, position) VALUES ($1, $2, $3, NULL)',
        [crypto.randomUUID(), tier.id, models[6]!.id],
      ),
    ).rejects.toThrow(/null/i);
  });

  it('holds the cap under concurrent inserts', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `race-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(8);
    const attempts = await Promise.allSettled(
      models.map((m, i) =>
        harness.port.routingEntries.add(owner.principal, {
          tierId: tier.id,
          modelId: m.id,
          // eight racers over five legal slots — at most five can win
          position: i % 5,
        }),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled' && a.value !== null).length;
    expect(won).toBeLessThanOrEqual(5);
    const entries = await harness.port.routingEntries.listForTier(owner.principal, tier.id);
    expect(entries.length).toBeLessThanOrEqual(5);
  });

  it('rejects duplicate (provider_id, external_model_id) pairs', async () => {
    const provider = await harness.port.providers.insert(owner.principal, providerValues);
    const first = await harness.port.models.createForProvider(owner.principal, provider.id, {
      externalModelId: 'dup-model',
    });
    expect(first).not.toBeNull();
    await expect(
      harness.port.models.createForProvider(owner.principal, provider.id, {
        externalModelId: 'dup-model',
      }),
    ).rejects.toThrow();
  });

  it('ensureDefaultTier is idempotent and race-safe: exactly one default tier', async () => {
    const fresh = await harness.createTestPrincipal('default-tier');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => harness.port.ensureDefaultTier(fresh.principal)),
    );
    const ids = new Set(results.map((t) => t.id));
    expect(ids.size).toBe(1);
    const again = await harness.port.ensureDefaultTier(fresh.principal);
    expect(again.id).toBe(results[0]!.id);
    const rows = await harness.pool.query(
      `SELECT count(*)::int AS n FROM tier WHERE owner_user_id = $1 AND key = 'default'`,
      [fresh.userId],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});
