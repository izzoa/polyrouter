import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { resolveUsage, type PartialUsage } from '@polyrouter/data-plane';
import type { ModelRow, Principal, ProviderRow } from '@polyrouter/shared/server';
import { LogWriter, type RequestLogDraft } from './log-writer';

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
}

/**
 * Builds a metadata-only request-log draft and enqueues it (#11). Fire-and-forget:
 * does NO DB work (no price lookup here — the writer resolves price under bounded
 * concurrency) and NEVER throws into the caller or the request path.
 */
@Injectable()
export class RequestRecorder {
  private readonly logger = new Logger(RequestRecorder.name);

  constructor(private readonly writer: LogWriter) {}

  record(ctx: RecordingContext, outcome: RecordOutcome): void {
    try {
      const usage = resolveUsage({
        ...(outcome.providerUsage !== undefined ? { providerUsage: outcome.providerUsage } : {}),
        requestChars: ctx.requestChars,
        outputChars: outcome.outputChars,
      });
      const draft: RequestLogDraft = {
        id: randomUUID(),
        principal: ctx.principal,
        agentId: ctx.agentId,
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        tierAssigned: ctx.tierAssigned,
        decisionLayer: ctx.decisionLayer,
        routingReason: ctx.routingReason,
        durationMs: Math.max(0, Date.now() - ctx.startedAt),
        status: outcome.status,
        usage,
        pricing: {
          externalModelId: ctx.model.externalModelId,
          modelInputPricePer1m: ctx.model.inputPricePer1m,
          modelOutputPricePer1m: ctx.model.outputPricePer1m,
          modelIsFree: ctx.model.isFree,
          providerBaseUrl: ctx.provider.baseUrl,
          providerKind: ctx.provider.kind,
          at: new Date(), // request-completion time — used for the immutable price lookup
        },
      };
      this.writer.enqueue(draft);
    } catch (err) {
      // Recording must never affect the request; swallow and log.
      this.logger.warn(`failed to record request log: ${String(err)}`);
    }
  }
}
