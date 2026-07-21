import type { RoutingSnapshot } from '@polyrouter/data-plane';
import type {
  PersistencePort,
  SemanticLearningApplyResult,
  SemanticLearningEventInput,
  SemanticLearningSweepTenant,
} from '@polyrouter/shared/server';
import { dayStamp, redisOccurrence } from './learning-format';
import { resolveLearningEvidenceRevision } from './learning-evidence';
import { runSemanticLearningOccurrence } from './learning.run';
import type { LearningProvenance } from './semantic-classifier.service';
import type { SemanticLearningConfig } from './semantic.config';
import { InMemoryLearningStore } from './testing/in-memory-learning-store';

/**
 * The queue-free sweep occurrence (add-semantic-learning task 4.2), pinned
 * against the in-memory store + a fake persistence port modelling the CAS.
 */

const NOW = Date.parse('2026-07-21T12:00:00Z');
const DAY = dayStamp(NOW);
const unit = (dims: number, hot: number): Float32Array => {
  const v = new Float32Array(dims);
  v[hot] = 1;
  return v;
};
const PROV: LearningProvenance = {
  bundled: { high: unit(8, 0), low: unit(8, 1) },
  embedderId: 'emb-1',
  dims: 8,
  anchorSetId: 'anchors-1',
  extractorVersion: 1,
  highThreshold: 0.15,
  lowThreshold: 0.15,
};
const QUALITY = 0.5;
const EMPTY_SNAPSHOT: RoutingSnapshot = {
  tiers: [],
  entriesByTierId: new Map(),
  rules: [],
  models: [],
};
const REV = resolveLearningEvidenceRevision(EMPTY_SNAPSHOT, PROV, QUALITY);
const CFG: SemanticLearningConfig = {
  minCohort: 8,
  minSamples: 50,
  alpha: 0.2,
  maxDrift: 0.35,
  cooldownH: 24,
  stateTtlD: 30,
  maxCohorts: 4096,
  schedEnabled: true,
  schedCron: '0 3 * * *',
};
const hmacOf = (owner: string): string => `hmac-${owner}`;
const loadSnapshot = (): Promise<RoutingSnapshot> => Promise.resolve(EMPTY_SNAPSHOT);
const silent = { warn: () => {}, log: () => {} };

interface StoredEvent extends SemanticLearningEventInput {
  createdAt: string;
}

/** A fake persistence port modelling the `(epoch, generation)` CAS + audit log. */
function fakeDb(
  tenants: SemanticLearningSweepTenant[],
  opts: { applyOverride?: SemanticLearningApplyResult; seedEvents?: StoredEvent[] } = {},
): { db: PersistencePort; events: StoredEvent[] } {
  const events: StoredEvent[] = [...(opts.seedEvents ?? [])];
  const state = new Map(
    tenants.map((t) => [
      t.ownerUserId,
      { epoch: t.value.semanticLearningEpoch, generation: t.value.semanticLearningGeneration },
    ]),
  );
  const routingSettings = {
    listSemanticLearningEnabled: () => Promise.resolve(tenants),
    recordLearningApply: (
      principal: { userId: string },
      expected: { epoch: number; generation: number },
      event: SemanticLearningEventInput,
    ): Promise<SemanticLearningApplyResult> => {
      if (opts.applyOverride) return Promise.resolve(opts.applyOverride);
      const s = state.get(principal.userId);
      if (s === undefined) return Promise.resolve('stale');
      if (s.epoch === expected.epoch && s.generation === expected.generation) {
        events.push({ ...event, createdAt: new Date(NOW).toISOString() });
        s.generation += 1;
        return Promise.resolve('applied');
      }
      if (s.epoch === event.epoch && s.generation === event.generation) {
        return Promise.resolve('duplicate');
      }
      return Promise.resolve('stale');
    },
    recordLearningDiscard: (
      _principal: { userId: string },
      event: SemanticLearningEventInput,
    ): Promise<boolean> => {
      if (events.some((e) => e.occurrenceId === event.occurrenceId)) return Promise.resolve(false);
      events.push({ ...event, createdAt: new Date(NOW).toISOString() });
      return Promise.resolve(true);
    },
  };
  const semanticLearningEvents = {
    list: (_principal: { userId: string }, limit: number): Promise<StoredEvent[]> =>
      Promise.resolve([...events].reverse().slice(0, limit)),
    lastApply: (_principal: { userId: string }): Promise<StoredEvent | null> =>
      Promise.resolve([...events].reverse().find((e) => e.trigger === 'apply') ?? null),
  };
  return {
    db: { routingSettings, semanticLearningEvents } as unknown as PersistencePort,
    events,
  };
}

function tenant(owner: string, epoch = 0, generation = 0): SemanticLearningSweepTenant {
  return {
    ownerUserId: owner,
    value: {
      structuralEnabled: true,
      cascadeEnabled: true,
      semanticEnabled: true,
      semanticLearningEnabled: true,
      semanticLearningEpoch: epoch,
      semanticLearningGeneration: generation,
      calibrationEnabled: false,
      calibratedHigh: null,
      calibratedLow: null,
      calibratedAnchorHigh: null,
      calibratedAnchorLow: null,
      calibrationEpoch: 0,
    },
  };
}

const run = (db: PersistencePort, store: InMemoryLearningStore) =>
  runSemanticLearningOccurrence(db, store, PROV, loadSnapshot, CFG, QUALITY, hmacOf, NOW, silent);

describe('runSemanticLearningOccurrence', () => {
  it('applies an above-floor tenant: CAS advances the generation, audits, and promotes', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 60);
    const { db, events } = fakeDb([tenant('u1')]);

    const summary = await run(db, store);
    expect(summary).toMatchObject({ tenants: 1, applied: 1, discarded: 0 });
    const applyRow = events.find((e) => e.trigger === 'apply');
    expect(applyRow).toBeDefined();
    expect(applyRow?.generation).toBe(1);
    expect(applyRow?.highSamples).toBe(60);
    // Promoted → the learned state is readable at generation 1.
    expect(
      await store.readActive(hmacOf('u1'), { epoch: 0, generation: 1, revision: REV }),
    ).not.toBeNull();
  });

  it('below-floor is a no-op: no apply, no audit, no active state', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 30); // < 50 floor
    const { db, events } = fakeDb([tenant('u1')]);

    const summary = await run(db, store);
    expect(summary.applied).toBe(0);
    expect(events).toHaveLength(0);
    expect(
      await store.readActive(hmacOf('u1'), { epoch: 0, generation: 1, revision: REV }),
    ).toBeNull();
  });

  it('respects the cooldown: a recent apply blocks a new one', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 60);
    const recentApply: StoredEvent = {
      occurrenceId: 'u1:earlier',
      trigger: 'apply',
      epoch: 0,
      generation: 1,
      reason: 'prior',
      createdAt: new Date(NOW - 3_600_000).toISOString(), // 1h ago, well within 24h cooldown
    };
    const { db, events } = fakeDb([tenant('u1')], { seedEvents: [recentApply] });

    const summary = await run(db, store);
    expect(summary.applied).toBe(0);
    expect(events.filter((e) => e.trigger === 'apply')).toHaveLength(1); // only the seeded one
  });

  it('discards stale-revision evidence (audited) AND applies the current revision', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    store.seedPending(hmacOf('u1'), 0, 'high', 'sha256:stale', DAY, unit(8, 0), 60); // stale
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 60); // current
    const { db, events } = fakeDb([tenant('u1')]);

    const summary = await run(db, store);
    expect(summary.discarded).toBe(1);
    expect(summary.applied).toBe(1);
    expect(events.find((e) => e.trigger === 'discard_revision')).toBeDefined();
    expect(events.find((e) => e.trigger === 'apply')).toBeDefined();
  });

  it('classifier unavailable → whole sweep no-ops', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 60);
    const { db, events } = fakeDb([tenant('u1')]);

    const summary = await runSemanticLearningOccurrence(
      db,
      store,
      null,
      loadSnapshot,
      CFG,
      QUALITY,
      hmacOf,
      NOW,
      silent,
    );
    expect(summary).toEqual({ tenants: 0, applied: 0, discarded: 0, skips: 0 });
    expect(events).toHaveLength(0);
  });

  it('a stale CAS (concurrent revert) skips the promote', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 60);
    const { db } = fakeDb([tenant('u1')], { applyOverride: 'stale' });

    const summary = await run(db, store);
    expect(summary.applied).toBe(0);
    expect(summary.skips).toBe(1);
    // Never promoted — no readable active state.
    expect(
      await store.readActive(hmacOf('u1'), { epoch: 0, generation: 1, revision: REV }),
    ).toBeNull();
  });

  it('crash-after-commit recovery: an already-committed occurrence promotes its stage without re-applying (clink impl High-1)', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    // Simulate the crash: the sweep staged G+1 and Postgres committed the apply,
    // but the process died before the Redis promote. The stage still exists.
    await store.stage(
      hmacOf('u1'),
      redisOccurrence(0, DAY),
      { epoch: 0, generation: 1, revision: REV, centroids: PROV.bundled },
      3600,
    );
    // The settings row is at (0,1) and the apply audit for TODAY exists.
    const committed: StoredEvent = {
      occurrenceId: `u1:${DAY}`,
      trigger: 'apply',
      epoch: 0,
      generation: 1,
      reason: 'apply',
      createdAt: new Date(NOW).toISOString(),
    };
    const { db, events } = fakeDb([tenant('u1', 0, 1)], { seedEvents: [committed] });

    const summary = await run(db, store);
    expect(summary.applied).toBe(0); // recovery does NOT re-apply
    expect(events.filter((e) => e.trigger === 'apply')).toHaveLength(1); // still exactly one audit
    // The stage was promoted — the learned state is now readable.
    expect(
      await store.readActive(hmacOf('u1'), { epoch: 0, generation: 1, revision: REV }),
    ).not.toBeNull();
  });

  it('revert fencing: pre-revert (old-epoch) evidence is inert to the post-revert sweep (clink impl High-3)', async () => {
    const store = new InMemoryLearningStore(() => NOW);
    // Evidence decided under epoch 0 flushes AFTER a revert to epoch 1.
    store.seedPending(hmacOf('u1'), 0, 'high', REV, DAY, unit(8, 0), 60);
    // The tenant is now at epoch 1 (reverted). The sweep rotates only epoch 1.
    const { db, events } = fakeDb([tenant('u1', 1, 0)]);

    const summary = await run(db, store);
    expect(summary.applied).toBe(0); // the epoch-0 evidence is never rotated
    expect(events).toHaveLength(0);
  });
});
