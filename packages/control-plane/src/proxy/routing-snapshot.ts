import { type RouteEntry, type RoutingSnapshot } from '@polyrouter/data-plane';
import { type ModelRow, type PersistencePort, type Principal } from '@polyrouter/shared/server';

/**
 * Load a tenant's `RoutingSnapshot` (the immutable routing view the resolver
 * reads) from the persistence port. Extracted from `ProxyService.loadSnapshot`
 * so the hot path AND the semantic-learning sweep build the snapshot through the
 * SAME code — the sweep resolves each tenant's `auto_low` chain to compute its
 * learning-evidence revision, and that revision MUST byte-match the one the hot
 * path (task 2.2's `LearningGate`) computes from resolvePlan's snapshot, or the
 * accumulator's pending buckets and the sweep's rotate never share a revision.
 * One loader, no divergence. Returns the raw `models` too (the proxy needs them
 * for adapter construction; the sweep ignores them).
 */
export async function loadRoutingSnapshot(
  db: PersistencePort,
  principal: Principal,
): Promise<{ snapshot: RoutingSnapshot; models: ModelRow[] }> {
  const [tiers, rules, models] = await Promise.all([
    db.tiers.list(principal),
    db.routingRules.list(principal),
    db.models.listForPrincipal(principal),
  ]);
  const entriesByTierId = new Map<string, RouteEntry[]>();
  await Promise.all(
    tiers.map(async (t) => {
      const entries = await db.routingEntries.listForTier(principal, t.id);
      entriesByTierId.set(
        t.id,
        entries.map((e) => ({ modelId: e.modelId, position: e.position })),
      );
    }),
  );
  const snapshot: RoutingSnapshot = {
    tiers: tiers.map((t) => ({ id: t.id, key: t.key })),
    entriesByTierId,
    rules: rules.map((r) => ({
      id: r.id,
      matchType: r.matchType,
      headerName: r.headerName,
      headerValue: r.headerValue,
      target: r.target,
      priority: r.priority,
      createdAt: r.createdAt,
    })),
    models: models.map((m) => ({
      id: m.id,
      providerId: m.providerId,
      externalModelId: m.externalModelId,
    })),
  };
  return { snapshot, models };
}
