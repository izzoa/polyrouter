// Boot classification pass (add-model-variant-detection, tasks 2.3/2.4; the pass
// moved under the PERSISTENCE_MAINTENANCE token in add-batch-inference D19).
// Runs against the real dev database because the pass IS a database join — a
// faked port would prove nothing about the thing that could go wrong (rows
// classified from the wrong provider, or a second run rewriting the world).
import {
  deriveProviderFamily,
  variantForProvider,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { TenancyHarness } from '../tenancy/harness';

/** The exact derivation the bootstrap passes in — asserted here, not re-implemented. */
const derive = ({
  providerBaseUrl,
  externalModelId,
}: {
  providerBaseUrl: string | null;
  externalModelId: string;
}): string | null =>
  variantForProvider(
    providerBaseUrl === null ? null : deriveProviderFamily(providerBaseUrl),
    externalModelId,
  )?.variant ?? null;

describe('variant classification boot pass', () => {
  let h: TenancyHarness;
  let port: PersistencePort;
  let alice: Principal;
  let bob: Principal;

  const seedProvider = async (
    principal: Principal,
    baseUrl: string,
    modelIds: readonly string[],
  ): Promise<string[]> => {
    const provider = await port.providers.insert(principal, {
      name: `p-${baseUrl}`,
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl,
      encryptedCredentials: 'x',
    });
    const ids: string[] = [];
    for (const externalModelId of modelIds) {
      const row = await port.models.createForProvider(principal, provider.id, {
        externalModelId,
      });
      ids.push(row!.id);
    }
    return ids;
  };

  const variantOf = async (principal: Principal, id: string): Promise<string | null> =>
    (await port.models.findById(principal, id))?.variant ?? null;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'selfhosted';
    h = await TenancyHarness.create();
    port = h.port;
    alice = (await h.createTestPrincipal('variant-alice')).principal;
    bob = (await h.createTestPrincipal('variant-bob')).principal;
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  });

  it('classifies existing rows without a re-sync, scoped to aggregator families', async () => {
    const [twin, base] = await seedProvider(alice, 'https://openrouter.ai/api/v1', [
      'openai/gpt-6-astra:batch',
      'openai/gpt-6-astra',
    ]);
    // Same id shape on a NON-aggregator host: must stay unclassified and routable.
    const [custom] = await seedProvider(alice, 'https://1.1.1.1/v1', ['openai/gpt-6-astra:batch']);

    const first = await h.maintenance.models.classifyVariants(derive);

    expect(await variantOf(alice, twin!)).toBe('batch');
    expect(await variantOf(alice, base!)).toBeNull();
    expect(await variantOf(alice, custom!)).toBeNull();
    expect(first.updated).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — a second run over a converged database writes nothing', async () => {
    // Executed twice in ONE fixture on purpose: a two-BOOT check would prove
    // nothing, since Drizzle journals the migration and never re-runs it.
    await h.maintenance.models.classifyVariants(derive);
    const second = await h.maintenance.models.classifyVariants(derive);
    expect(second.updated).toBe(0);
    expect(second.scanned).toBeGreaterThan(0);
  });

  it('derives every row from its OWN provider — no cross-tenant bleed', async () => {
    // Bob owns an aggregator provider; Alice owns a custom one serving the SAME id.
    const [bobTwin] = await seedProvider(bob, 'https://openrouter.ai/api/v1', [
      'anthropic/claude-opus-5:batch',
    ]);
    const [aliceLookalike] = await seedProvider(alice, 'https://2.2.2.2/v1', [
      'anthropic/claude-opus-5:batch',
    ]);

    await h.maintenance.models.classifyVariants(derive);

    expect(await variantOf(bob, bobTwin!)).toBe('batch');
    // If the pass classified by id alone (or by any other tenant's provider),
    // this row would be wrongly blocked.
    expect(await variantOf(alice, aliceLookalike!)).toBeNull();
  });
});
