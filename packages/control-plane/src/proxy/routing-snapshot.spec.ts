/** The routing snapshot's load shape (add-batch-mode-routing task 2.2/2.3). */

import { loadRoutingSnapshot } from './routing-snapshot';
import type { PersistencePort, Principal } from '@polyrouter/shared/server';

describe('loadRoutingSnapshot', () => {
  const principal = { userId: 'u1', orgId: null } as unknown as Principal;
  const build = (entryMode?: string) => {
    const touched: string[] = [];
    const port = {
      tiers: {
        list: () => {
          touched.push('tiers');
          return Promise.resolve([{ id: 't1', key: 'default' }]);
        },
      },
      routingRules: {
        list: () => {
          touched.push('rules');
          return Promise.resolve([]);
        },
      },
      models: {
        listForPrincipal: () => {
          touched.push('models');
          return Promise.resolve([
            { id: 'm1', providerId: 'p1', externalModelId: 'gpt-4o', variant: null },
          ]);
        },
      },
      routingEntries: {
        listForTier: () => {
          touched.push('entries');
          return Promise.resolve([
            entryMode === undefined
              ? { modelId: 'm1', position: 0 }
              : { modelId: 'm1', position: 0, mode: entryMode },
          ]);
        },
      },
      providers: {
        list: () => {
          touched.push('providers');
          return Promise.resolve([]);
        },
        findById: () => {
          touched.push('providers');
          return Promise.resolve(null);
        },
      },
    } as unknown as PersistencePort;
    return { port, touched };
  };

  it("carries each entry's mode through to the resolver", async () => {
    const { port } = build('batch');
    const { snapshot } = await loadRoutingSnapshot(port, principal);
    expect(snapshot.entriesByTierId.get('t1')).toEqual([
      { modelId: 'm1', position: 0, mode: 'batch' },
    ]);
  });

  it('reads a pre-migration row as unreserved rather than undefined', async () => {
    // The column is NOT NULL with a default, so this is only reachable from a stale
    // read — but `mode` is REQUIRED on RouteEntry, and an undefined there would make
    // the resolver's reservation check silently false.
    const { port } = build(undefined);
    const { snapshot } = await loadRoutingSnapshot(port, principal);
    expect(snapshot.entriesByTierId.get('t1')?.[0]?.mode).toBe('any');
  });

  it('issues NO provider query — the synchronous hot path must not pay for one', async () => {
    // Invariant 9. `batchCapable` is a provider-derived field and lives on the
    // dashboard's model DTO for exactly this reason: putting it on the snapshot
    // would add a providers read to every proxied request, for a value synchronous
    // resolution never consults (it needs only `entry.mode` and `model.variant`).
    const { port, touched } = build('any');
    await loadRoutingSnapshot(port, principal);
    expect(touched).not.toContain('providers');
    expect(new Set(touched)).toEqual(new Set(['tiers', 'rules', 'models', 'entries']));
  });
});
