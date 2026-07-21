import { Inject, Injectable } from '@nestjs/common';
import { labelForOutcome } from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import type { LearningEvidenceSink, RecordOutcome } from '../recording/request-recorder';
import { EvidenceAccumulator } from './evidence-accumulator';
import { SEMANTIC_CONFIG, type SemanticConfig } from './semantic.config';

const DAY_SECONDS = 86_400;

/**
 * The learning-evidence sink (add-semantic-learning task 3.3): the recorder's
 * hook at cascade-settle. Labels the settled outcome (quality-passed → low,
 * quality-gate escalation → high, everything else → nothing) and accumulates the
 * request's embedding into the bounded volatile accumulator, which flushes only
 * a ≥ MIN_COHORT sum to Redis. Bounded-synchronous, never awaits, never throws
 * past the recorder's guard, never persists/logs the vector (invariant 8).
 */
@Injectable()
export class SemanticLearningContributor implements LearningEvidenceSink {
  constructor(
    private readonly accumulator: EvidenceAccumulator,
    @Inject(SEMANTIC_CONFIG) private readonly cfg: SemanticConfig,
  ) {}

  contribute(
    principal: Principal,
    epoch: number,
    evidence: Float32Array,
    revision: string,
    outcome: RecordOutcome,
  ): void {
    const label = labelForOutcome({
      escalated: outcome.escalated ?? false,
      status: outcome.status,
      qualitySignal: outcome.qualitySignal,
      escalationSource: outcome.escalationSource,
    });
    if (label === null) return; // cheap_error / cancelled / fail-open / non-decided → not evidence
    const tenantId = principal.kind === 'user' ? principal.userId : principal.orgId;
    this.accumulator.contribute(
      this.accumulator.tenantHmac(tenantId),
      epoch,
      label,
      revision,
      evidence,
      {
        minCohort: this.cfg.learning.minCohort,
        maxCohorts: this.cfg.learning.maxCohorts,
        ttlSeconds: this.cfg.learning.stateTtlD * DAY_SECONDS,
      },
    );
  }
}
