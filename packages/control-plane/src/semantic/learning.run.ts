import { Logger } from '@nestjs/common';
import {
  cosineDistance,
  evidenceMean,
  foldBothLabels,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import {
  userPrincipal,
  type PersistencePort,
  type Principal,
  type SemanticLearningSweepTenant,
} from '@polyrouter/shared/server';
import { dayStamp, redisOccurrence } from './learning-format';
import { resolveLearningEvidenceRevision } from './learning-evidence';
import type { LearningStore } from './learning-store';
import type { LearningProvenance } from './semantic-classifier.service';
import type { SemanticLearningConfig } from './semantic.config';

/**
 * One semantic-learning sweep (add-semantic-learning task 4.2), extracted
 * queue-free for direct unit testing (the calibration precedent). Per
 * learning-enabled tenant, in order:
 *   1. Compute the current learning-evidence revision from the tenant's snapshot.
 *   2. DISCARD PASS (D9, "Both"): delete stale-revision pending + active, audit
 *      `discard_revision` (no generation bump).
 *   3. APPLY PASS: cooldown-gated. Rotate current-revision pending (min-samples
 *      inside rotate), fold onto the active-or-bundled centroids (EMA + spherical
 *      drift), stage G+1, CAS+audit in Postgres, then promote the Redis stage.
 * Crash-atomic: Postgres is authoritative; the promote is idempotent and runs
 * only after the commit; a concurrent revert makes the CAS fail (`stale`) and no
 * promote happens. A failing tenant is logged (secret-free) and the sweep
 * continues (invariant 11 analog).
 */
export interface LearningOccurrenceSummary {
  tenants: number;
  applied: number;
  discarded: number;
  skips: number;
}

/** Derive a tenant's Redis HMAC digest from its owner id (same derivation the
 * hot-path accumulator uses, so keys match). */
export type TenantHmac = (ownerUserId: string) => string;

/** Per-tenant snapshot loader (the shared `loadRoutingSnapshot`, principal-bound). */
export type SnapshotLoader = (principal: Principal) => Promise<RoutingSnapshot>;

const HOUR_MS = 3_600_000;
const DAY_SECONDS = 86_400;

export async function runSemanticLearningOccurrence(
  db: PersistencePort,
  store: LearningStore,
  provenance: LearningProvenance | null,
  loadSnapshot: SnapshotLoader,
  cfg: SemanticLearningConfig,
  qualityThreshold: number,
  tenantHmac: TenantHmac,
  now: number,
  logger: Pick<Logger, 'warn' | 'log'> = new Logger('SemanticLearning'),
): Promise<LearningOccurrenceSummary> {
  const summary: LearningOccurrenceSummary = { tenants: 0, applied: 0, discarded: 0, skips: 0 };
  // Layer 2 unavailable ⇒ no bundled centroids to fold against ⇒ nothing to do.
  if (provenance === null) {
    logger.log('semantic learning sweep: classifier unavailable — no-op');
    return summary;
  }

  let tenants: SemanticLearningSweepTenant[];
  try {
    tenants = await db.routingSettings.listSemanticLearningEnabled();
  } catch (err) {
    logger.warn(`semantic learning enumeration failed: ${String((err as Error).message)}`);
    return summary;
  }
  summary.tenants = tenants.length;

  for (const t of tenants) {
    try {
      await sweepTenant(
        db,
        store,
        provenance,
        loadSnapshot,
        cfg,
        qualityThreshold,
        tenantHmac,
        now,
        t,
        summary,
      );
    } catch (err) {
      summary.skips += 1;
      logger.warn(`semantic learning skipped a tenant: ${String((err as Error).message)}`);
    }
  }
  logger.log(
    `semantic learning sweep: tenants=${String(summary.tenants)} applied=${String(summary.applied)} discarded=${String(summary.discarded)} skips=${String(summary.skips)}`,
  );
  return summary;
}

async function sweepTenant(
  db: PersistencePort,
  store: LearningStore,
  provenance: LearningProvenance,
  loadSnapshot: SnapshotLoader,
  cfg: SemanticLearningConfig,
  qualityThreshold: number,
  tenantHmac: TenantHmac,
  now: number,
  t: SemanticLearningSweepTenant,
  summary: LearningOccurrenceSummary,
): Promise<void> {
  const principal = userPrincipal(t.ownerUserId);
  const v = t.value;
  const hmac = tenantHmac(t.ownerUserId);
  const epoch = v.semanticLearningEpoch;
  const day = dayStamp(now);
  // Redis occurrence: epoch-scoped + NO raw owner (clink impl Med-5 / D8, and a
  // mid-day revert's new epoch can't resume the old epoch's work key).
  const redisOcc = redisOccurrence(epoch, day);
  // Postgres audit occurrence: owner-scoped (the table is), globally unique.
  const pgOcc = `${t.ownerUserId}:${day}`;
  const stateTtl = cfg.stateTtlD * DAY_SECONDS;

  const snapshot = await loadSnapshot(principal);
  const revision = resolveLearningEvidenceRevision(snapshot, provenance, qualityThreshold);

  // --- Discard pass (D9): this epoch's stale-revision pending + active reconciled.
  const discarded = await store.discardStaleRevisions(hmac, epoch, revision);
  if (discarded.pendingDiscarded > 0 || discarded.activeDiscarded) {
    const ok = await db.routingSettings.recordLearningDiscard(principal, {
      // Revision-specific (clink impl Med-4) so distinct same-day config changes
      // each audit rather than collapsing.
      occurrenceId: `${pgOcc}:discard:${revision.slice(-16)}`,
      trigger: 'discard_revision',
      epoch,
      generation: v.semanticLearningGeneration,
      reason: `discard_revision; pending=${String(discarded.pendingDiscarded)}; active=${discarded.activeDiscarded ? '1' : '0'}`,
    });
    if (ok) summary.discarded += 1;
  }

  // --- Crash recovery + cooldown from a TARGETED last-apply (clink impl High-1/Med-6).
  const lastApply = await db.semanticLearningEvents.lastApply(principal);
  if (lastApply !== null && lastApply.occurrenceId === pgOcc) {
    // Today's occurrence already committed — idempotently promote its (possibly
    // unpromoted) stage at the AUDITED coordinates, self-healing a crash between
    // the Postgres commit and the Redis promote. A revert since then deleted the
    // stage, so promote is a clean no-op.
    await store.promote(
      hmac,
      redisOccurrence(lastApply.epoch, day),
      { epoch: lastApply.epoch, generation: lastApply.generation },
      stateTtl,
    );
    return;
  }
  if (lastApply !== null && Date.parse(lastApply.createdAt) > now - cfg.cooldownH * HOUR_MS) return;

  // --- Apply pass: rotate (min-samples inside) → fold → stage → CAS → promote.
  const evidence = await store.rotate(hmac, redisOcc, {
    epoch,
    revision,
    windowDays: cfg.stateTtlD,
    minSamples: cfg.minSamples,
    workTtlSeconds: DAY_SECONDS, // an occurrence completes same-day
  });
  const freshHigh =
    evidence.high === null ? null : evidenceMean(evidence.high.sum, evidence.high.count);
  const freshLow =
    evidence.low === null ? null : evidenceMean(evidence.low.sum, evidence.low.count);
  if (freshHigh === null && freshLow === null) return; // below floor / nothing → no-op, no audit

  const active = await store.readActive(hmac, {
    epoch,
    generation: v.semanticLearningGeneration,
    revision,
  });
  const bundled = provenance.bundled;
  const staged = foldBothLabels(bundled, active, freshHigh, freshLow, cfg.alpha, cfg.maxDrift);
  const nextGen = v.semanticLearningGeneration + 1;

  await store.stage(
    hmac,
    redisOcc,
    { epoch, generation: nextGen, revision, centroids: staged },
    stateTtl,
  );

  const highDrift = cosineDistance(bundled.high, staged.high);
  const lowDrift = cosineDistance(bundled.low, staged.low);
  const result = await db.routingSettings.recordLearningApply(
    principal,
    { epoch, generation: v.semanticLearningGeneration },
    {
      occurrenceId: pgOcc,
      trigger: 'apply',
      epoch,
      generation: nextGen,
      highSamples: evidence.high?.count ?? 0,
      lowSamples: evidence.low?.count ?? 0,
      highDrift,
      lowDrift,
      highSimilarity: active === null ? null : 1 - cosineDistance(active.high, staged.high),
      lowSimilarity: active === null ? null : 1 - cosineDistance(active.low, staged.low),
      reason: `apply; high=${String(evidence.high?.count ?? 0)}; low=${String(evidence.low?.count ?? 0)}; drift=${highDrift.toFixed(4)}/${lowDrift.toFixed(4)}`,
    },
  );

  if (result === 'stale') {
    summary.skips += 1; // a concurrent revert/apply won — do NOT promote a superseded stage
    return;
  }
  // 'applied' or 'duplicate' (crash-after-commit): promote is idempotent + monotonic.
  await store.promote(hmac, redisOcc, { epoch, generation: nextGen }, stateTtl);
  if (result === 'applied') summary.applied += 1;
}
