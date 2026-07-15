import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { resolveUsage, type PartialUsage, type ResolvedUsage } from '@polyrouter/data-plane';
import type { ModelRow, Principal, ProviderRow } from '@polyrouter/shared/server';
import { LogWriter, type DraftPricing, type RequestLogDraft } from './log-writer';

/** The status recorded on a RequestLog. `fallback` = a later chain member served
 * after a predecessor failed (#12). */
export type RecordStatus = 'success' | 'error' | 'fallback';

/** Everything needed to record a request, captured by the proxy for the SERVED
 * member (which may differ from the primary when a fallback served, #12). */
export interface RecordingContext {
  readonly principal: Principal;
  readonly agentId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly tierAssigned: string | null;
  readonly decisionLayer: string;
  /** Human-readable reason, including the fallback trail (#12). */
  readonly routingReason: string;
  readonly provider: Pick<ProviderRow, 'baseUrl' | 'kind'>;
  readonly model: Pick<
    ModelRow,
    'externalModelId' | 'inputPricePer1m' | 'outputPricePer1m' | 'isFree'
  >;
  readonly startedAt: number;
  /** Character count of the request body (for the input-token estimate). */
  readonly requestChars: number;
}

export interface RecordOutcome {
  readonly status: RecordStatus;
  readonly providerUsage?: PartialUsage;
  readonly outputChars: number;
  /** #14 cascade: whether the request escalated cheap→strong. */
  readonly escalated?: boolean;
  /** #14 cascade: the numeric quality score (or null on a fail-open error). */
  readonly qualitySignal?: number | null;
}

/**
 * Builds a metadata-only request-log draft and enqueues it (#11). Fire-and-forget:
 * does NO DB work (no price lookup here — the writer resolves price under bounded
 * concurrency) and NEVER throws into the caller or the request path. For cascade
 * (#14), `record` returns the request id so `recordAttempt` can link a per-call
 * ledger row for a superseded cheap attempt.
 */
@Injectable()
export class RequestRecorder {
  private readonly logger = new Logger(RequestRecorder.name);

  constructor(private readonly writer: LogWriter) {}

  /** Record the served `request_log` row; returns its pre-allocated id. */
  record(ctx: RecordingContext, outcome: RecordOutcome): string {
    const id = randomUUID();
    try {
      const draft: RequestLogDraft = {
        id,
        principal: ctx.principal,
        agentId: ctx.agentId,
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        tierAssigned: ctx.tierAssigned,
        decisionLayer: ctx.decisionLayer,
        routingReason: ctx.routingReason,
        durationMs: Math.max(0, Date.now() - ctx.startedAt),
        status: outcome.status,
        usage: this.usageOf(ctx, outcome),
        pricing: pricingOf(ctx),
        ...(outcome.escalated !== undefined ? { escalated: outcome.escalated } : {}),
        ...(outcome.qualitySignal !== undefined ? { qualitySignal: outcome.qualitySignal } : {}),
      };
      this.writer.enqueue(draft);
    } catch (err) {
      // Recording must never affect the request; swallow and log.
      this.logger.warn(`failed to record request log: ${String(err)}`);
    }
    return id;
  }

  /** Record an additional billable call (a superseded cheap cascade attempt) as a
   * `request_attempt` ledger row linked to `requestLogId`. */
  recordAttempt(
    requestLogId: string,
    ctx: RecordingContext,
    outcome: RecordOutcome,
    attemptIndex: number,
  ): void {
    try {
      this.writer.enqueueAttempt({
        id: randomUUID(),
        requestLogId,
        principal: ctx.principal,
        attemptIndex,
        tierKey: ctx.tierAssigned,
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        status: outcome.status,
        usage: this.usageOf(ctx, outcome),
        pricing: pricingOf(ctx),
      });
    } catch (err) {
      this.logger.warn(`failed to record request attempt: ${String(err)}`);
    }
  }

  private usageOf(ctx: RecordingContext, outcome: RecordOutcome): ResolvedUsage {
    return resolveUsage({
      ...(outcome.providerUsage !== undefined ? { providerUsage: outcome.providerUsage } : {}),
      requestChars: ctx.requestChars,
      outputChars: outcome.outputChars,
    });
  }
}

function pricingOf(ctx: RecordingContext): DraftPricing {
  return {
    externalModelId: ctx.model.externalModelId,
    modelInputPricePer1m: ctx.model.inputPricePer1m,
    modelOutputPricePer1m: ctx.model.outputPricePer1m,
    modelIsFree: ctx.model.isFree,
    providerBaseUrl: ctx.provider.baseUrl,
    providerKind: ctx.provider.kind,
    at: new Date(), // request-completion time — used for the immutable price lookup
  };
}
