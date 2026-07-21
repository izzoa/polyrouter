import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { trace, type SpanContext } from '@opentelemetry/api';
import {
  resolveUsage,
  serializeResponseContent,
  type CapturedText,
  type ContentBlock,
  type PartialUsage,
  type ResolvedUsage,
} from '@polyrouter/data-plane';
import type {
  BodyCaptureMode,
  BodyCaptureOverride,
  ModelRow,
  Principal,
  ProviderRow,
} from '@polyrouter/shared/server';
import { shouldPersistBodies } from '../body-capture/effective-mode';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { TRACER_NAME } from '../observability/tracing';
import type { ClientProtocol } from '../proxy/proxy-errors';
import {
  LogWriter,
  type CapturedBodyDraft,
  type DraftPricing,
  type RequestLogDraft,
} from './log-writer';

/** Per-request capture state (add-body-capture), carried on the recording
 * context so EVERY record path — plain, fallback, cascade — makes the persist
 * decision at ONE site (below), at outcome time. `responseBlocks` is a closure
 * over the proxy's per-request state (collector or buffered content). */
export interface RequestCaptureState {
  readonly mode: BodyCaptureMode;
  readonly override: BodyCaptureOverride | null;
  readonly epoch: number;
  readonly capturedAt: Date;
  readonly maxBytes: number;
  readonly request: CapturedText;
  readonly responseBlocks: () => {
    blocks: readonly ContentBlock[];
    truncated: boolean;
  } | null;
}

/** The status recorded on a RequestLog. `fallback` = a later chain member served
 * after a predecessor failed (#12). `cancelled` = the CLIENT aborted (disconnected),
 * which is neither a provider error nor an alertable failure (A-3). */
export type RecordStatus = 'success' | 'error' | 'fallback' | 'cancelled';

/** Everything needed to record a request, captured by the proxy for the SERVED
 * member (which may differ from the primary when a fallback served, #12). */
export interface RecordingContext {
  readonly principal: Principal;
  readonly agentId: string | null;
  /** Client protocol — a #21 metric label, never persisted. */
  readonly protocol: ClientProtocol;
  readonly providerId: string | null;
  /** Provider display name — a #21 metric label, never persisted. */
  readonly providerName: string;
  readonly modelId: string | null;
  readonly tierAssigned: string | null;
  readonly decisionLayer: string;
  /** Human-readable reason, including the fallback trail (#12). */
  readonly routingReason: string;
  /** The header that CHOSE the route (add-routing-header-visibility) — one
   * grouped pair so a value can never be drafted without its name; absent for
   * every non-`header` layer. `value` is null for custom rules (their
   * configured value can be a credential — never recorded). */
  readonly routingHeader?: { readonly name: string; readonly value: string | null };
  /** L1 decision telemetry (add-auto-decision-telemetry) — the request-level
   * verdict; all absent when the layer did not evaluate. */
  readonly structuralBand?: string;
  readonly structuralScore?: number;
  readonly structuralBandSource?: string;
  /** The tenant's calibration epoch at DECISION time (add-auto-threshold-
   * calibration) — the calibrator's freshness stamp; absent when unevaluated. */
  readonly structuralEpoch?: number;
  /** L2 decision telemetry (add-semantic-routing) — the request-level semantic
   * verdict; all four absent when Layer 2 did not evaluate. */
  readonly semanticBand?: string;
  readonly semanticScore?: number;
  readonly semanticSource?: string;
  readonly semanticRevision?: string;
  readonly provider: Pick<ProviderRow, 'baseUrl' | 'kind'>;
  readonly model: Pick<
    ModelRow,
    'externalModelId' | 'inputPricePer1m' | 'outputPricePer1m' | 'isFree'
  >;
  readonly startedAt: number;
  /** Character count of the request body (for the input-token estimate). */
  readonly requestChars: number;
  /** Armed body capture (add-body-capture); absent = nothing is ever stored.
   * The recorder — not the call sites — decides persistence from the outcome.
   * Attempt-ledger rows (`recordAttempt`) deliberately ignore it: only the
   * served exchange is ever captured. */
  readonly capture?: RequestCaptureState;
}

/** Terminal provider-error detail (add-request-error-detail). `providerMessage`
 * arrives pre-sanitized from the capture factory (the adapter layer); the writer
 * re-applies the credential-free scrub defensively. */
export interface RecordedError {
  readonly kind: string;
  readonly status?: number;
  readonly providerMessage?: string;
  readonly requestId?: string;
}

export interface RecordOutcome {
  readonly status: RecordStatus;
  readonly providerUsage?: PartialUsage;
  readonly outputChars: number;
  /** #14 cascade: whether the request escalated cheap→strong. */
  readonly escalated?: boolean;
  /** #14 cascade: the numeric quality score (or null on a fail-open error). */
  readonly qualitySignal?: number | null;
  /** WHY an escalated request escalated (add-auto-threshold-calibration):
   * `quality_gate` = the gate scored the cheap answer bad; `cheap_error` =
   * every other pre-commit escalation. Recorded only with `escalated=true`
   * (the recorder gates centrally — the DB CHECK backstops). */
  readonly escalationSource?: 'quality_gate' | 'cheap_error';
  /** Terminal error detail — persisted ONLY when `status === 'error'` (the
   * recorder centrally discards it otherwise; a served or cancelled request
   * records no provider fault). */
  readonly error?: RecordedError;
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

  constructor(
    private readonly writer: LogWriter,
    private readonly metrics: ProxyMetrics,
  ) {}

  /** Record the served `request_log` row; returns its pre-allocated id. */
  record(ctx: RecordingContext, outcome: RecordOutcome): string {
    const id = randomUUID();
    // #21 `recording.enqueue` span — explicitly the request-path enqueue; the
    // durable batch insert is traced separately in the writer.
    const span = trace.getTracer(TRACER_NAME).startSpan('recording.enqueue', {
      attributes: {
        'polyrouter.status': outcome.status,
        'polyrouter.decision_layer': ctx.decisionLayer,
      },
    });
    try {
      const durationMs = Math.max(0, Date.now() - ctx.startedAt);
      const usage = this.usageOf(ctx, outcome);
      const draft: RequestLogDraft = {
        id,
        principal: ctx.principal,
        agentId: ctx.agentId,
        providerId: ctx.providerId,
        providerName: ctx.providerName,
        modelId: ctx.modelId,
        tierAssigned: ctx.tierAssigned,
        decisionLayer: ctx.decisionLayer,
        routingReason: ctx.routingReason,
        ...(ctx.routingHeader !== undefined ? { routingHeader: ctx.routingHeader } : {}),
        ...(ctx.structuralBand !== undefined ? { structuralBand: ctx.structuralBand } : {}),
        ...(ctx.structuralScore !== undefined ? { structuralScore: ctx.structuralScore } : {}),
        ...(ctx.structuralBandSource !== undefined
          ? { structuralBandSource: ctx.structuralBandSource }
          : {}),
        ...(ctx.structuralEpoch !== undefined ? { structuralEpoch: ctx.structuralEpoch } : {}),
        ...(ctx.semanticBand !== undefined ? { semanticBand: ctx.semanticBand } : {}),
        ...(ctx.semanticScore !== undefined ? { semanticScore: ctx.semanticScore } : {}),
        ...(ctx.semanticSource !== undefined ? { semanticSource: ctx.semanticSource } : {}),
        ...(ctx.semanticRevision !== undefined ? { semanticRevision: ctx.semanticRevision } : {}),
        durationMs,
        status: outcome.status,
        usage,
        pricing: pricingOf(ctx),
        ...(outcome.escalated !== undefined ? { escalated: outcome.escalated } : {}),
        ...(outcome.qualitySignal !== undefined ? { qualitySignal: outcome.qualitySignal } : {}),
        // Provenance only ever rides an escalated row (fail-closed; DB CHECK
        // backstops the same rule).
        ...(outcome.escalated === true && outcome.escalationSource !== undefined
          ? { escalationSource: outcome.escalationSource }
          : {}),
        // Central exclusivity gate (add-request-error-detail): error detail is
        // dropped here unless the row IS an error — belt and suspenders over
        // the call sites.
        ...(outcome.status === 'error' && outcome.error !== undefined
          ? { error: outcome.error }
          : {}),
        ...spanContextOf(),
      };
      // THE capture decision site (add-body-capture): one place, every path.
      const bodies = bodiesFor(ctx, outcome);
      if (bodies !== undefined) draft.bodies = bodies;
      this.writer.enqueue(draft);
      // #21: emitted at ENQUEUE time so traffic stays visible during a DB
      // outage; exactly once per finalized inference request.
      this.metrics.recordRequest(
        ctx.protocol,
        ctx.decisionLayer,
        outcome.status,
        durationMs / 1000,
      );
      this.metrics.recordTokens(
        ctx.providerName,
        ctx.model.externalModelId,
        usage.inputTokens,
        usage.outputTokens,
      );
    } catch (err) {
      // Recording must never affect the request; swallow and log.
      this.logger.warn(`failed to record request log: ${String(err)}`);
    } finally {
      span.end();
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
      const usage = this.usageOf(ctx, outcome);
      this.writer.enqueueAttempt({
        id: randomUUID(),
        requestLogId,
        principal: ctx.principal,
        attemptIndex,
        tierKey: ctx.tierAssigned,
        providerId: ctx.providerId,
        providerName: ctx.providerName,
        modelId: ctx.modelId,
        status: outcome.status,
        usage,
        pricing: pricingOf(ctx),
        ...spanContextOf(),
      });
      // #21: a superseded cascade cheap call consumed real provider tokens —
      // billing counts it, so do token metrics (never `requests_total`).
      this.metrics.recordTokens(
        ctx.providerName,
        ctx.model.externalModelId,
        usage.inputTokens,
        usage.outputTokens,
      );
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

/** Build body drafts when the effective mode says this OUTCOME persists
 * (spec: master kill / override / errors_only matrix). Request always rides
 * when persisting; the response rides when any content assembled — flagged
 * `partial` for a cancelled or post-commit-error termination. */
function bodiesFor(
  ctx: RecordingContext,
  outcome: RecordOutcome,
): CapturedBodyDraft[] | undefined {
  const cap = ctx.capture;
  if (cap === undefined) return undefined;
  const persist = shouldPersistBodies({
    mode: cap.mode,
    override: cap.override,
    status: outcome.status,
    escalated: outcome.escalated === true,
  });
  if (!persist) return undefined;
  const partial = outcome.status === 'cancelled' || outcome.status === 'error';
  const drafts: CapturedBodyDraft[] = [
    {
      direction: 'request',
      content: cap.request.content,
      bytes: cap.request.bytes,
      truncated: cap.request.truncated,
      partial: false, // the request always arrived whole
      epoch: cap.epoch,
      capturedAt: cap.capturedAt,
    },
  ];
  const resp = cap.responseBlocks();
  if (resp !== null && resp.blocks.length > 0) {
    const serialized = serializeResponseContent(resp.blocks, cap.maxBytes);
    drafts.push({
      direction: 'response',
      content: serialized.content,
      bytes: serialized.bytes,
      truncated: serialized.truncated || resp.truncated,
      partial,
      epoch: cap.epoch,
      capturedAt: cap.capturedAt,
    });
  }
  return drafts;
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

/** The active request span's context (for the writer's `recording.write` links,
 * #21). Empty when tracing is off — a no-op span has an invalid context. */
function spanContextOf(): { spanContext?: SpanContext } {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc !== undefined && trace.isSpanContextValid(sc) ? { spanContext: sc } : {};
}
