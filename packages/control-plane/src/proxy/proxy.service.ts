import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ATTEMPT_FAILURES_MAX, type AttemptFailureEntry } from '@polyrouter/shared';
import {
  AUTO_ALIAS,
  PERSISTENCE_PORT,
  SsrfError,
  assertUrlSafe,
  decryptSecret,
  deriveModelKey,
  resolvePlainCredentialValue,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderRow,
  type RoutingSettingsValue,
  WORKLOAD_NONE,
} from '@polyrouter/shared/server';
import {
  BoundedBlockCollector,
  ProviderError,
  declaredStructuredOutput,
  getAdapter,
  isRouteError,
  openStreamChain,
  participatingAsk,
  planOutputCaps,
  replayBufferedStream,
  resolveRoute,
  runBufferedChain,
  probePatienceOf,
  serializeClientRequest,
  shouldFallback,
  type AttemptFailure,
  type BreakerAdmission,
  type BreakerOpenListener,
  type BreakerStateListener,
  type ChainAttempt,
  type CircuitBreaker,
  type ContentBlock,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProtocolAdapter,
  type ProviderAdapter,
  type ProviderKind,
  type ProviderProtocol,
  type RouteDecision,
  type RoutingSnapshot,
  type StructuralVerdict,
  type WorkloadVerdict,
} from '@polyrouter/data-plane';
import { providerMaxTokensQuirks, type MaxTokensSpelling } from '../providers/providers.dto';
import type { ClientProtocol } from './proxy-errors';
import {
  badRequest,
  budgetBlocked,
  budgetEnforcementUnavailable,
  providerErrorToProxy,
  routeError,
  serviceUnavailable,
  toProxyError,
} from './proxy-errors';
import {
  PROXY_ADAPTER_FACTORY,
  PROXY_BREAKER,
  PROXY_RUNTIME,
  type ProxyAdapterFactory,
  type ProxyRuntime,
} from './proxy.config';
import { CALIBRATION_RAILS, type CalibrationRails } from '../calibration/calibration.config';
import {
  ROUTING_CONFIG,
  autoLayerCapability,
  effectiveAutoLayers as computeEffectiveLayers,
  effectiveThresholds,
  type RoutingConfig,
} from './routing.config';
import {
  RequestRecorder,
  type RecordedError,
  type RecordingContext,
  type RequestCaptureState,
} from '../recording/request-recorder';
import { InflightRegistry, type InflightEntry } from '../inflight/inflight-registry';
import { BodyCaptureService } from '../body-capture/body-capture.service';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { observeAdapter } from '../observability/observe-adapter';
import { TRACER_NAME } from '../observability/tracing';
import { loadRoutingSnapshot } from './routing-snapshot';
import { StructuralRouter } from './structural/structural-router';
import { CascadeRouter, type CascadePlan } from './cascade/cascade-router';
import { SemanticRouter, type SemanticVerdict } from '../semantic/semantic-router';
import { WorkloadRouter } from './workload/workload-router';
import { SemanticClassifierService } from '../semantic/semantic-classifier.service';
import { DISABLED_LEARNING_GATE, type LearningGate } from '../semantic/classification-source';
import { resolveLearningEvidenceRevision } from '../semantic/learning-evidence';
import { NotificationProducers } from '../producers/notification-producers';
import { BudgetService, BudgetEnforcementUnavailableError } from '../budgets/budget-service';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';

/** Per-chain-member recording metadata (parallel to the attempts). */
interface AttemptMeta {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  /** The tier this member belongs to (its own — a cascade escalation chain mixes
   * strong + default members, so provenance is per-member, #14). */
  readonly tierKey: string | null;
  readonly providerBaseUrl: string | null;
  readonly providerKind: string;
  readonly model: Pick<
    ModelRow,
    | 'externalModelId'
    | 'inputPricePer1m'
    | 'outputPricePer1m'
    | 'isFree'
    | 'listedInputPricePer1m'
    | 'listedOutputPricePer1m'
    | 'listedIsFree'
  >;
}

/** A resolved fallback chain: lazy attempts + parallel recording metadata. */
interface Bundle {
  readonly attempts: ChainAttempt[];
  readonly meta: AttemptMeta[];
}

/** Per-walked-chain capacity annotations (add-output-cap-guardrails): the
 * plan-time deferral string plus a clamp string per EFFECTIVE attempt index.
 * Clamps are recorded only for attempts actually dispatched (`capacitySuffix`). */
interface CapacityAnnotations {
  readonly deferred: string | null;
  readonly clampByIndex: ReadonlyMap<number, string>;
}

/** Late-bound cap lookup (add-output-cap-guardrails): `buildBundle`'s adapter
 * closures capture this ref BEFORE the batched cap resolution runs; dispatch
 * happens after, so the closure reads the populated map. */
interface CapsRef {
  current: ReadonlyMap<string, number>;
}

/** Cascade orchestration state (#14): the cheap chain + the escalation chain
 * (`strong ++ default`, so a down strong tier still rescues to the reliable core). */
interface CascadeBundle {
  readonly cheap: Bundle;
  readonly escalation: Bundle;
  readonly cheapTimeoutMs: number;
}

/** The served cheap response, for a per-call ledger row when it is escalated. */
interface CheapServed {
  readonly response: NormalizedResponse;
  readonly servedIndex: number;
}

interface Prepared {
  client: ProtocolAdapter;
  /** Row id pre-allocated at admission (add-inflight-requests): shared by the
   * served request_log row and the in-flight registry entry. */
  requestId: string;
  /** Set after the in-flight `mark` (add-inflight-requests); invoked by the
   * recorder at settle to clear the entry + stop its lease. */
  onSettle?: () => void;
  protocol: ClientProtocol;
  routed: NormalizedRequest;
  /** The request's declared machine-parseable-output flag, captured ONCE at
   * preparation — before any upstream call — so the cascade gate's demand can
   * never drift with a shared nested reference (harden-cascade-quality-gate). */
  structuredDemand: boolean;
  /** Layer 1's verdict when it EVALUATED this request (add-auto-decision-
   * telemetry) — recorded on every parent request_log row; undefined when the
   * layer did not run (non-auto, disabled, degradation). */
  structuralVerdict?: StructuralVerdict;
  /** The tenant's calibration epoch at decision time (add-auto-threshold-
   * calibration) — set exactly when the verdict is (evaluated requests). */
  structuralEpoch?: number;
  /** Layer 2's verdict when it EVALUATED this request (add-semantic-routing) —
   * recorded on every parent row alongside the structural verdict; undefined
   * when L2 did not run or faulted (fail-open never fabricates telemetry). */
  semanticVerdict?: SemanticVerdict;
  /** The workload verdict when the structural layer EVALUATED the request
   * (add-workload-telemetry) — recorded on every parent row beside the
   * structural/semantic verdicts; undefined when Layer 1 did not run or the
   * workload classifier faulted (degradation never fabricates telemetry). */
  workloadVerdict?: WorkloadVerdict;
  /** The decision-time learning gate + the L2-ambiguous request's IN-MEMORY
   * embedding (add-semantic-learning D1/D3). The gate is default-disabled; the
   * evidence is present ONLY for the L2-ambiguous slice. Both reach the recorder's
   * learning contributor via `servedFrom()` alone — NEVER a persisted field or
   * log — and the vector is dropped after contribution (invariant 8). */
  learningGate: LearningGate;
  learningEvidence: Float32Array | null;
  created: number;
  attempts: ChainAttempt[];
  meta: AttemptMeta[];
  decision: RouteDecision;
  startedAt: number;
  requestChars: number;
  principal: Principal;
  agentId: string | null;
  cascade?: CascadeBundle;
  /** Capacity annotations per WALKED chain (add-output-cap-guardrails):
   * `primary` for the non-cascade walk; `cheap`/`escalation` for cascade legs.
   * Absent = no planning engaged (no valid ask, client-named, or nothing to note). */
  capacity?: {
    readonly primary?: CapacityAnnotations;
    readonly cheap?: CapacityAnnotations;
    readonly escalation?: CapacityAnnotations;
  };
  /** Armed body capture (add-body-capture): present ONLY when the effective
   * mode can persist for this request (off / agent-never never allocate).
   * Mutable content slots — the served path fills exactly one. */
  capture?: {
    readonly state: RequestCaptureState;
    readonly collector: BoundedBlockCollector;
    buffered?: readonly ContentBlock[];
  };
}

/** Deadline for the per-tenant auto-layer preference read (#20). Generous: the
 * routing snapshot loads immediately before, so the pool is already proven live
 * — only a genuine hang trips this, and it degrades to the capability default
 * rather than stalling the request (invariant 1). */
const ROUTING_SETTINGS_READ_TIMEOUT_MS = 1_000;

/** Assistant output characters (text + tool name/args) for a usage estimate. */
function countOutputChars(content: readonly ContentBlock[]): number {
  let n = 0;
  for (const b of content) {
    if (b.type === 'text') n += b.text.length;
    else if (b.type === 'tool_use') {
      n += b.name.length + ('inputRaw' in b ? b.inputRaw.length : JSON.stringify(b.input).length);
    }
  }
  return n;
}

/**
 * Proxy orchestration (#10 Layer 0, #13 structural, #14 cascade). Loads the
 * tenant's owned config, resolves the route, decrypts the provider credential
 * (#7), builds the #6 adapter, and delegates the call/translation to `ProxyCore`.
 * The controllers own the HTTP pump; this owns everything up to it.
 */
@Injectable()
export class ProxyService {
  private readonly key: string;
  private readonly mode: 'selfhosted' | 'cloud';

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PROXY_RUNTIME) private readonly rt: ProxyRuntime,
    @Inject(PROXY_ADAPTER_FACTORY) private readonly factory: ProxyAdapterFactory,
    @Inject(PROXY_BREAKER) private readonly breaker: CircuitBreaker,
    @Inject(ROUTING_CONFIG) private readonly routingConfig: RoutingConfig,
    @Inject(CALIBRATION_RAILS) private readonly calibrationRails: CalibrationRails,
    private readonly recorder: RequestRecorder,
    private readonly metrics: ProxyMetrics,
    private readonly structural: StructuralRouter,
    private readonly cascade: CascadeRouter,
    private readonly semantic: SemanticRouter,
    private readonly semanticClassifier: SemanticClassifierService,
    private readonly workload: WorkloadRouter,
    private readonly producers: NotificationProducers,
    private readonly budgets: BudgetService,
    private readonly oauth: SubscriptionOauthService,
    private readonly bodyCapture: BodyCaptureService,
    // OPTIONAL (add-inflight-requests): the live-presence registry. Absent (a
    // harness that assembles the proxy without it) ⇒ no presence is published and
    // NOTHING else changes — the feature is strictly additive (invariant 1).
    @Optional() private readonly inflight?: InflightRegistry,
  ) {
    this.key = rt.key;
    this.mode = rt.mode;
  }

  /** Block-budget gate (#16). Reject a request at/over a `block` budget BEFORE any
   * routing/upstream work — streaming throws pre-commit so it renders cleanly. A
   * fail-closed enforcement fault maps to 503; the read is bounded, never stalls. */
  private async enforceBudgets(principal: Principal, agentId: string | null): Promise<void> {
    let hit;
    try {
      hit = await this.budgets.checkBlocked(principal, agentId);
    } catch (err) {
      if (err instanceof BudgetEnforcementUnavailableError) throw budgetEnforcementUnavailable();
      throw err;
    }
    if (hit !== null) {
      this.budgets.notifyBlocked(principal, hit); // fire-and-forget
      throw budgetBlocked(hit);
    }
  }

  /** A per-request breaker-open listener that emits `provider_down` (#15b) for
   * the tripped provider, owner = the request principal, plus the #21 open
   * transition counter. Fire-and-forget. */
  private onOpenFor(principal: Principal, meta: AttemptMeta[]): BreakerOpenListener {
    const owner = principal.kind === 'user' ? principal.userId : principal.orgId;
    return (providerId) => {
      const m = meta.find((x) => x.providerId === providerId);
      if (m) {
        this.producers.providerDown(providerId, m.providerName, owner);
        this.metrics.breakerOpened(m.providerName);
      }
    };
  }

  /** #21: set the breaker-state gauge from the state observed at each admission
   * decision (provider id → display name via this request's chain meta). */
  private onBreakerStateFor(meta: AttemptMeta[]): BreakerStateListener {
    return (providerId, state) => {
      const m = meta.find((x) => x.providerId === providerId);
      if (m) this.metrics.breakerStateObserved(m.providerName, state);
    };
  }

  /** Fire-and-forget failure-spike check for a recorded chain error (#15b). */
  private notifyFailed(principal: Principal): void {
    void this.producers.onRequestFailed(principal);
  }

  /** Non-streaming: walk the fallback chain (or the cascade); return the served
   * member's wire and record it (#11/#12/#14). */
  async completion(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    agentId: string | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.enforceBudgets(principal, agentId);
    const p = await this.prepare(principal, protocol, wireBody, headers, agentId, signal);
    // Publish in-flight presence (add-inflight-requests): fire-and-forget after
    // routing, settled via `onSettle` when the parent row records. The catch is a
    // backstop for an unexpected throw that bypassed record().
    const lease = this.beginInflight(p);
    try {
      return await this.completionServed(p, signal);
    } catch (err) {
      lease.settle();
      throw err;
    }
  }

  /** Buffered served flow (extracted so the in-flight lease can wrap it). */
  private async completionServed(p: Prepared, signal: AbortSignal): Promise<unknown> {
    if (p.cascade !== undefined) return this.cascadeCompletion(p, p.cascade, signal);

    const result = await runBufferedChain(
      this.breaker,
      p.attempts,
      p.client,
      p.routed,
      {
        created: p.created,
        onOpen: this.onOpenFor(p.principal, p.meta),
        onBreakerState: this.onBreakerStateFor(p.meta),
        isCallerAbort: () => signal.aborted,
      },
      signal,
    );
    if (result.ok) {
      if (p.capture !== undefined) p.capture.buffered = result.response.content;
      this.recorder.record(this.servedContext(p, result.servedIndex, result.failures), {
        status: result.failures.length > 0 ? 'fallback' : 'success',
        ...(result.response.usage !== undefined ? { providerUsage: result.response.usage } : {}),
        outputChars: countOutputChars(result.response.content),
      });
      return result.wire;
    }
    this.recorder.record(this.failedContext(p, result.failures, result.error), {
      status: result.callerAborted ? 'cancelled' : 'error',
      outputChars: 0,
      error: recordedError(result.error),
    });
    if (!result.callerAborted) this.notifyFailed(p.principal);
    throw toProxyError(result.error);
  }

  /** Streaming: walk the chain (or the cascade) to the first committed member;
   * record when the stream outcome settles (a post-commit error → `status=error`). */
  async stream(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    signal: AbortSignal,
    agentId: string | null,
  ): Promise<AsyncGenerator<string>> {
    await this.enforceBudgets(principal, agentId);
    const p = await this.prepare(principal, protocol, wireBody, headers, agentId, signal);
    const lease = this.beginInflight(p);
    try {
      return await this.streamServed(p, signal);
    } catch (err) {
      lease.settle();
      throw err;
    }
  }

  /** Streaming served flow (extracted so the in-flight lease can wrap it; the lease
   * settles via `onSettle` when the stream outcome resolves, i.e. at drain end). */
  private async streamServed(p: Prepared, signal: AbortSignal): Promise<AsyncGenerator<string>> {
    if (p.cascade !== undefined) return this.cascadeStream(p, p.cascade, signal);

    const result = await openStreamChain(this.breaker, p.attempts, p.client, p.routed, {
      signal,
      firstEventTimeoutMs: this.rt.firstEventTimeoutMs,
      created: p.created,
      ...(p.routed.includeUsage !== undefined ? { includeUsage: p.routed.includeUsage } : {}),
      onOpen: this.onOpenFor(p.principal, p.meta),
      onBreakerState: this.onBreakerStateFor(p.meta),
      isCallerAbort: () => signal.aborted,
      ...(p.capture !== undefined ? { contentCollector: p.capture.collector } : {}),
    });
    if (result.kind === 'error') {
      this.recorder.record(this.failedContext(p, result.failures, result.error), {
        status: result.callerAborted ? 'cancelled' : 'error',
        outputChars: 0,
        error: recordedError(result.error),
      });
      if (!result.callerAborted) this.notifyFailed(p.principal);
      throw providerErrorToProxy(result.error);
    }
    const ctx = this.servedContext(p, result.servedIndex, result.failures);
    const fellBack = result.failures.length > 0;
    void result.outcome.then((o) => {
      this.recorder.record(ctx, {
        // Post-commit precedence: a committed stream that later fails is `error` — but a
        // CLIENT disconnect is `cancelled`, decided from the outcome's causal
        // `callerAborted` (captured at teardown), not a mutable signal that a late
        // disconnect during drain could flip on a genuine provider failure (A-3).
        status:
          o.status === 'error'
            ? o.callerAborted
              ? 'cancelled'
              : 'error'
            : fellBack
              ? 'fallback'
              : 'success',
        providerUsage: o.usage,
        outputChars: o.outputChars,
        ...(o.error !== undefined ? { error: recordedError(o.error) } : {}),
      });
      if (o.status === 'error' && !o.callerAborted) this.notifyFailed(p.principal);
    });
    return result.frames;
  }

  /** Models + tier keys + `auto`, in the OpenAI list shape. */
  async listModels(
    principal: Principal,
  ): Promise<{ object: 'list'; data: { id: string; object: 'model'; owned_by: string }[] }> {
    const [models, tiers] = await Promise.all([
      this.db.models.listForPrincipal(principal),
      this.db.tiers.list(principal),
    ]);
    const seen = new Map<string, string>(); // external id → count for ambiguity
    for (const m of models) seen.set(m.externalModelId, (seen.get(m.externalModelId) ?? '') + '.');
    const ids: string[] = ['auto', ...tiers.map((t) => t.key)];
    for (const m of models) {
      ids.push(`${m.providerId}:${m.externalModelId}`); // always-routable qualified id
      if ((seen.get(m.externalModelId) ?? '').length === 1) ids.push(m.externalModelId); // bare only if unique
    }
    return {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: 'polyrouter' })),
    };
  }

  // --- cascade (Layer 3, #14) ---

  /** Buffered cascade: run the cheap tier buffered (under a deadline), gate, then
   * deliver the cheap answer or escalate `strong ++ default`. */
  private async cascadeCompletion(
    p: Prepared,
    c: CascadeBundle,
    signal: AbortSignal,
  ): Promise<unknown> {
    const cheap = await runBufferedChain(
      this.breaker,
      c.cheap.attempts,
      p.client,
      p.routed,
      {
        created: p.created,
        onOpen: this.onOpenFor(p.principal, c.cheap.meta),
        onBreakerState: this.onBreakerStateFor(c.cheap.meta),
        // PURE client signal: a cheap-DEADLINE abort must still trip (a
        // chronically slow cheap provider keeps being routed around).
        isCallerAbort: () => signal.aborted,
      },
      AbortSignal.any([signal, AbortSignal.timeout(c.cheapTimeoutMs)]),
    );
    if (cheap.ok) {
      const { score, escalate } = this.cascade.shouldEscalate(cheap.response, p.structuredDemand);
      if (!escalate) {
        if (p.capture !== undefined) p.capture.buffered = cheap.response.content;
        this.recorder.record(
          this.servedFrom(
            p,
            c.cheap.meta,
            cheap.servedIndex,
            withCapacity(
              `cascade: cheap served`,
              capacitySuffix('cheap', p.capacity?.cheap, cheap.servedIndex, cheap.failures),
            ),
            score,
            cheap.failures,
            attemptTrailEntries(
              [{ failures: cheap.failures, meta: c.cheap.meta, leg: 'cheap' }],
              null,
            ),
          ),
          {
            status: cheap.failures.length > 0 ? 'fallback' : 'success',
            ...(cheap.response.usage !== undefined ? { providerUsage: cheap.response.usage } : {}),
            outputChars: countOutputChars(cheap.response.content),
            escalated: false,
            qualitySignal: score,
          },
        );
        return cheap.wire;
      }
      return this.escalateBuffered(
        p,
        c,
        { response: cheap.response, servedIndex: cheap.servedIndex },
        score,
        'quality_gate',
        signal,
        // The EXECUTED cheap chain's capacity reasons ride the parent row even
        // when escalation supersedes it (a superseded clamp stays on record).
        capacitySuffix('cheap', p.capacity?.cheap, cheap.servedIndex, cheap.failures),
        // The served-then-superseded cheap leg's pre-serve failures survive
        // escalation on the parent trail (add-fallback-attempt-detail).
        cheap.failures,
      );
    }
    if (cheap.callerAborted) {
      // Client disconnected during the cheap leg — record one `cancelled` row for spend/
      // inspector completeness (§7.5), do NOT escalate, and do NOT notifyFailed (a
      // client disconnect is breaker-neutral, not a provider fault) (A-3/E5.2).
      this.recorder.record(
        this.servedFrom(
          p,
          c.cheap.meta,
          0,
          withCapacity(
            'cascade: client disconnected during cheap attempt',
            capacitySuffix('cheap', p.capacity?.cheap, null, cheap.failures),
          ),
          null,
          cheap.failures,
          attemptTrailEntries(
            [{ failures: cheap.failures, meta: c.cheap.meta, leg: 'cheap' }],
            null,
          ),
        ),
        { status: 'cancelled', outputChars: 0, escalated: false, qualitySignal: null },
      );
      throw toProxyError(cheap.error);
    }
    if (!shouldFallback(cheap.error.kind)) {
      // A non-retryable cheap failure (a `bad_request` — the client's request is
      // malformed) will fail the expensive tier too; surface it instead of wasting
      // an escalation (A-21). Record one error row, no escalation, no notifyFailed.
      this.recorder.record(
        this.servedFrom(
          p,
          c.cheap.meta,
          0,
          withCapacity(
            `cascade: cheap failed non-retryably (${cheap.error.kind})`,
            capacitySuffix('cheap', p.capacity?.cheap, null, cheap.failures),
          ),
          null,
          cheap.failures,
          // The non-retryable terminal never enters `failures`, so no entry is
          // marked terminal (identity mismatch by construction).
          attemptTrailEntries(
            [{ failures: cheap.failures, meta: c.cheap.meta, leg: 'cheap' }],
            cheap.error,
          ),
        ),
        {
          status: 'error',
          outputChars: 0,
          escalated: false,
          qualitySignal: null,
          // The non-retryable failure never enters `failures` — the detail
          // source is the cheap attempt's OWN error (add-request-error-detail).
          error: recordedError(cheap.error),
        },
      );
      throw toProxyError(cheap.error);
    }
    // Cheap failed/timed out — provider fault, never quality evidence.
    return this.escalateBuffered(
      p,
      c,
      null,
      0,
      'cheap_error',
      signal,
      capacitySuffix('cheap', p.capacity?.cheap, null, cheap.failures),
      cheap.failures,
    );
  }

  private async escalateBuffered(
    p: Prepared,
    c: CascadeBundle,
    cheapServed: CheapServed | null,
    score: number | null,
    source: 'quality_gate' | 'cheap_error',
    signal: AbortSignal,
    cheapCapacity: string | null,
    /** The executed cheap leg's pre-commit failures (add-fallback-attempt-
     * detail): today's reason strings drop them; the parent trail must not. */
    cheapFailures: readonly AttemptFailure[],
  ): Promise<unknown> {
    const result = await runBufferedChain(
      this.breaker,
      c.escalation.attempts,
      p.client,
      p.routed,
      {
        created: p.created,
        onOpen: this.onOpenFor(p.principal, c.escalation.meta),
        onBreakerState: this.onBreakerStateFor(c.escalation.meta),
        isCallerAbort: () => signal.aborted,
      },
      signal,
    );
    const trailLegs: AttemptTrailLeg[] = [
      { failures: cheapFailures, meta: c.cheap.meta, leg: 'cheap' },
      { failures: result.failures, meta: c.escalation.meta, leg: 'escalation' },
    ];
    if (!result.ok) {
      const requestId = this.recorder.record(
        this.servedFrom(
          p,
          c.escalation.meta,
          0,
          withCapacity(
            `cascade: escalated, all failed`,
            cheapCapacity,
            capacitySuffix('esc', p.capacity?.escalation, null, result.failures),
          ),
          score,
          result.failures,
          attemptTrailEntries(trailLegs, result.error),
        ),
        {
          status: result.callerAborted ? 'cancelled' : 'error',
          outputChars: 0,
          escalated: true,
          qualitySignal: score,
          escalationSource: source,
          error: recordedError(result.error),
        },
      );
      // The superseded cheap call was still billed — its ledger row must exist
      // even when every escalation member failed (§7.7, spend completeness).
      if (cheapServed !== null) this.recordCheapAttempt(p, c, requestId, cheapServed);
      if (!result.callerAborted) this.notifyFailed(p.principal); // client hang-up ≠ provider fault (A-3)
      throw toProxyError(result.error);
    }
    if (p.capture !== undefined) p.capture.buffered = result.response.content;
    const requestId = this.recorder.record(
      this.servedFrom(
        p,
        c.escalation.meta,
        result.servedIndex,
        withCapacity(
          escalatedReason(c.escalation.meta, result.servedIndex),
          cheapCapacity,
          capacitySuffix('esc', p.capacity?.escalation, result.servedIndex, result.failures),
        ),
        score,
        result.failures,
        attemptTrailEntries(trailLegs, null),
      ),
      {
        status: result.failures.length > 0 ? 'fallback' : 'success',
        ...(result.response.usage !== undefined ? { providerUsage: result.response.usage } : {}),
        outputChars: countOutputChars(result.response.content),
        escalated: true,
        qualitySignal: score,
        escalationSource: source,
      },
    );
    if (cheapServed !== null) this.recordCheapAttempt(p, c, requestId, cheapServed);
    return result.wire;
  }

  /** Streaming cascade: cheap buffered → gate → replay the cheap answer or stream
   * the escalation live. Only one tier ever reaches the client (invariant 3). */
  private async cascadeStream(
    p: Prepared,
    c: CascadeBundle,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<string>> {
    const cheap = await runBufferedChain(
      this.breaker,
      c.cheap.attempts,
      p.client,
      p.routed,
      {
        created: p.created,
        onOpen: this.onOpenFor(p.principal, c.cheap.meta),
        onBreakerState: this.onBreakerStateFor(c.cheap.meta),
        // PURE client signal: a cheap-DEADLINE abort must still trip (a
        // chronically slow cheap provider keeps being routed around).
        isCallerAbort: () => signal.aborted,
      },
      AbortSignal.any([signal, AbortSignal.timeout(c.cheapTimeoutMs)]),
    );
    if (cheap.ok) {
      const { score, escalate } = this.cascade.shouldEscalate(cheap.response, p.structuredDemand);
      const cheapServed: CheapServed = { response: cheap.response, servedIndex: cheap.servedIndex };
      if (!escalate) {
        const replay = await replayBufferedStream(p.client, cheap.response, {
          created: p.created,
          ...(p.routed.includeUsage !== undefined ? { includeUsage: p.routed.includeUsage } : {}),
        });
        if (replay.kind === 'stream') {
          if (p.capture !== undefined) p.capture.buffered = cheap.response.content;
          const ctx = this.servedFrom(
            p,
            c.cheap.meta,
            cheap.servedIndex,
            withCapacity(
              `cascade: cheap served`,
              capacitySuffix('cheap', p.capacity?.cheap, cheap.servedIndex, cheap.failures),
            ),
            score,
            cheap.failures,
            attemptTrailEntries(
              [{ failures: cheap.failures, meta: c.cheap.meta, leg: 'cheap' }],
              null,
            ),
          );
          const fellBack = cheap.failures.length > 0;
          void replay.outcome.then((o) =>
            this.recorder.record(ctx, {
              // A client disconnect during replay is `cancelled`, not a provider fault
              // (the cheap answer was valid); causal `callerAborted` from the outcome (A-3).
              status:
                o.status === 'error'
                  ? o.callerAborted
                    ? 'cancelled'
                    : 'error'
                  : fellBack
                    ? 'fallback'
                    : 'success',
              ...(cheap.response.usage !== undefined
                ? { providerUsage: cheap.response.usage }
                : {}),
              outputChars: countOutputChars(cheap.response.content),
              escalated: false,
              qualitySignal: score,
            }),
          );
          return replay.frames;
        }
        // replay materialization failed before any byte → safe to escalate.
      }
      // Provenance (add-auto-threshold-calibration): reaching here with a
      // PASSING verdict means the replay failed — an infrastructure fault,
      // never quality evidence (r2-High-2).
      return this.escalateStream(
        p,
        c,
        cheapServed,
        score,
        escalate ? 'quality_gate' : 'cheap_error',
        signal,
        capacitySuffix('cheap', p.capacity?.cheap, cheap.servedIndex, cheap.failures),
        cheap.failures,
      );
    }
    if (cheap.callerAborted) {
      // Client disconnected during the cheap leg (pre-commit — no bytes sent). Record
      // one `cancelled` row (§7.5), no escalation, no notifyFailed (A-3/E5.2).
      this.recorder.record(
        this.servedFrom(
          p,
          c.cheap.meta,
          0,
          withCapacity(
            'cascade: client disconnected during cheap attempt',
            capacitySuffix('cheap', p.capacity?.cheap, null, cheap.failures),
          ),
          null,
          cheap.failures,
          attemptTrailEntries(
            [{ failures: cheap.failures, meta: c.cheap.meta, leg: 'cheap' }],
            null,
          ),
        ),
        { status: 'cancelled', outputChars: 0, escalated: false, qualitySignal: null },
      );
      throw providerErrorToProxy(cheap.error);
    }
    if (!shouldFallback(cheap.error.kind)) {
      // A non-retryable cheap failure (bad_request) won't succeed on the strong tier
      // either — surface it instead of escalating (A-21). Pre-commit: no bytes sent.
      this.recorder.record(
        this.servedFrom(
          p,
          c.cheap.meta,
          0,
          withCapacity(
            `cascade: cheap failed non-retryably (${cheap.error.kind})`,
            capacitySuffix('cheap', p.capacity?.cheap, null, cheap.failures),
          ),
          null,
          cheap.failures,
          // The non-retryable terminal never enters `failures` — no marker.
          attemptTrailEntries(
            [{ failures: cheap.failures, meta: c.cheap.meta, leg: 'cheap' }],
            cheap.error,
          ),
        ),
        {
          status: 'error',
          outputChars: 0,
          escalated: false,
          qualitySignal: null,
          // The non-retryable failure never enters `failures` — the detail
          // source is the cheap attempt's OWN error (add-request-error-detail).
          error: recordedError(cheap.error),
        },
      );
      throw providerErrorToProxy(cheap.error);
    }
    // retryable cheap failure
    return this.escalateStream(
      p,
      c,
      null,
      0,
      'cheap_error',
      signal,
      capacitySuffix('cheap', p.capacity?.cheap, null, cheap.failures),
      cheap.failures,
    );
  }

  private async escalateStream(
    p: Prepared,
    c: CascadeBundle,
    cheapServed: CheapServed | null,
    score: number | null,
    source: 'quality_gate' | 'cheap_error',
    signal: AbortSignal,
    cheapCapacity: string | null,
    /** The executed cheap leg's pre-commit failures (add-fallback-attempt-
     * detail) — aggregated ahead of the escalation leg on the parent trail. */
    cheapFailures: readonly AttemptFailure[],
  ): Promise<AsyncGenerator<string>> {
    const result = await openStreamChain(this.breaker, c.escalation.attempts, p.client, p.routed, {
      signal,
      firstEventTimeoutMs: this.rt.firstEventTimeoutMs,
      created: p.created,
      ...(p.routed.includeUsage !== undefined ? { includeUsage: p.routed.includeUsage } : {}),
      onOpen: this.onOpenFor(p.principal, c.escalation.meta),
      onBreakerState: this.onBreakerStateFor(c.escalation.meta),
      isCallerAbort: () => signal.aborted,
      ...(p.capture !== undefined ? { contentCollector: p.capture.collector } : {}),
    });
    const trailLegs: AttemptTrailLeg[] = [
      { failures: cheapFailures, meta: c.cheap.meta, leg: 'cheap' },
      { failures: result.failures, meta: c.escalation.meta, leg: 'escalation' },
    ];
    if (result.kind === 'error') {
      const requestId = this.recorder.record(
        this.servedFrom(
          p,
          c.escalation.meta,
          0,
          withCapacity(
            `cascade: escalated, all failed`,
            cheapCapacity,
            capacitySuffix('esc', p.capacity?.escalation, null, result.failures),
          ),
          score,
          result.failures,
          attemptTrailEntries(trailLegs, result.error),
        ),
        {
          status: result.callerAborted ? 'cancelled' : 'error',
          outputChars: 0,
          escalated: true,
          qualitySignal: score,
          escalationSource: source,
          error: recordedError(result.error),
        },
      );
      // The superseded cheap call was still billed — ledger it even on total
      // escalation failure (§7.7, spend completeness).
      if (cheapServed !== null) this.recordCheapAttempt(p, c, requestId, cheapServed);
      if (!result.callerAborted) this.notifyFailed(p.principal); // client hang-up ≠ provider fault (A-3)
      throw providerErrorToProxy(result.error);
    }
    const ctx = this.servedFrom(
      p,
      c.escalation.meta,
      result.servedIndex,
      withCapacity(
        escalatedReason(c.escalation.meta, result.servedIndex),
        cheapCapacity,
        capacitySuffix('esc', p.capacity?.escalation, result.servedIndex, result.failures),
      ),
      score,
      result.failures,
      attemptTrailEntries(trailLegs, null),
    );
    const fellBack = result.failures.length > 0;
    void result.outcome.then((o) => {
      const requestId = this.recorder.record(ctx, {
        // A CLIENT disconnect is `cancelled`, not a provider fault — from the outcome's
        // causal `callerAborted`, robust to a late disconnect during drain (A-3).
        status:
          o.status === 'error'
            ? o.callerAborted
              ? 'cancelled'
              : 'error'
            : fellBack
              ? 'fallback'
              : 'success',
        providerUsage: o.usage,
        outputChars: o.outputChars,
        escalated: true,
        qualitySignal: score,
        escalationSource: source,
        ...(o.error !== undefined ? { error: recordedError(o.error) } : {}),
      });
      if (o.status === 'error' && !o.callerAborted) this.notifyFailed(p.principal);
      if (cheapServed !== null) this.recordCheapAttempt(p, c, requestId, cheapServed);
    });
    return result.frames;
  }

  /** Ledger row for the superseded cheap call (its own price/usage), #14. */
  private recordCheapAttempt(
    p: Prepared,
    c: CascadeBundle,
    requestLogId: string,
    cheapServed: CheapServed,
  ): void {
    const m = c.cheap.meta[cheapServed.servedIndex];
    if (m === undefined) return;
    this.recorder.recordAttempt(
      requestLogId,
      this.metaContext(p, m, `cascade: cheap attempt (escalated)`),
      {
        status: 'success',
        ...(cheapServed.response.usage !== undefined
          ? { providerUsage: cheapServed.response.usage }
          : {}),
        outputChars: countOutputChars(cheapServed.response.content),
      },
      0,
    );
  }

  // --- internals ---

  /** The tenant's effective auto layers (#20): the boot capability masked by the
   * owner-scoped preference (absent → inherit-on). Read lazily, only on an
   * `auto`→default request. A settings-read fault must NOT fail or stall the
   * request (invariant 1) — a throw, rejection, OR a never-settling read all
   * degrade to the raw instance capability (the read is deadline-bounded). */
  private async effectiveAutoLayers(principal: Principal): Promise<{
    structural: boolean;
    cascade: boolean;
    semantic: boolean;
    settings: RoutingSettingsValue | null;
  }> {
    // Capability = the boot flags masked by the WHOLE classifier readiness for
    // semantic (add-semantic-routing) — flag ∧ embedder ∧ centroids.
    const cap = autoLayerCapability(this.routingConfig, this.semanticClassifier.available);
    // Cascade/semantic imply structural, so structural off instance-wide leaves
    // nothing for a preference to gate — skip the read entirely.
    if (!cap.structural) return { ...cap, settings: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pref = await Promise.race([
        this.db.routingSettings.get(principal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('routing-settings read timeout')),
            ROUTING_SETTINGS_READ_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      // A-45: shared formula (also used by AutoLayersService). The raw row
      // rides along so calibrated thresholds + the epoch stamp reuse this ONE
      // read (add-auto-threshold-calibration — zero additional hot-path I/O).
      return { ...computeEffectiveLayers(cap, pref), settings: pref };
    } catch {
      return { ...cap, settings: null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The decision-time learning gate (add-semantic-learning D3, task 2.2),
   * computed from the SAME settings read + snapshot the layers used — no extra
   * hot-path I/O. Fail-CLOSED: a missing row, learning-off tenant, or unavailable
   * classifier ⇒ disabled (bundled). Only reached when semantic is effective. */
  private learningGate(
    settings: RoutingSettingsValue | null,
    snapshot: RoutingSnapshot,
  ): LearningGate {
    const prov = this.semantic.provenance;
    if (settings === null || !settings.semanticLearningEnabled || prov === null) {
      return DISABLED_LEARNING_GATE;
    }
    return {
      enabled: true,
      epoch: settings.semanticLearningEpoch,
      generation: settings.semanticLearningGeneration,
      evidenceRevision: resolveLearningEvidenceRevision(
        snapshot,
        prov,
        this.routingConfig.cascade.qualityThreshold,
      ),
    };
  }

  private async prepare(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    agentId: string | null,
    signal: AbortSignal,
  ): Promise<Prepared> {
    // #21 `routing` span: covers route resolution, the structural/cascade
    // evaluation, and chain building. A no-op when tracing is off.
    const span = trace.getTracer(TRACER_NAME).startSpan('routing');
    try {
      const p = await this.resolvePlan(principal, protocol, wireBody, headers, agentId, signal);
      span.setAttributes({
        'polyrouter.decision_layer': p.decision.decisionLayer,
        'polyrouter.tier': p.decision.tierKey ?? '',
        'polyrouter.model': p.meta[0]?.model.externalModelId ?? '',
        'polyrouter.cascade': p.cascade !== undefined,
      });
      return p;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  private async resolvePlan(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    agentId: string | null,
    signal: AbortSignal,
  ): Promise<Prepared> {
    const startedAt = Date.now();
    // Pre-allocate the row id at admission so the in-flight registry entry and the
    // eventual request_log row share it (add-inflight-requests).
    const requestId = randomUUID();
    // n>1 is rejected before normalization (the IR is n=1 and discards `n`), so
    // its explanatory message isn't overwritten by the generic body-parse catch
    // below. OpenAI-only: Anthropic has no `n` (E2.10).
    if (protocol === 'openai' && typeof wireBody === 'object' && wireBody !== null) {
      const n = (wireBody as { n?: unknown }).n;
      if (typeof n === 'number' && n > 1) {
        throw badRequest('n>1 is not supported; the router returns a single choice');
      }
    }
    const client = getAdapter(protocol);
    let ir: NormalizedRequest;
    try {
      ir = client.requestIn(wireBody);
    } catch {
      throw badRequest('invalid request body');
    }
    const requestChars = safeChars(wireBody);

    const { snapshot, models } = await this.loadSnapshot(principal);
    let decision = resolveRoute(snapshot, {
      modelField: ir.model,
      headers: normalizeHeaders(headers),
    });
    if (isRouteError(decision)) throw routeError(decision.error);

    // Auto routing (#13/#14) refines an `auto` request that fell through to the
    // default tier; explicit models and header tiers already won in Layer 0.
    let cascadePlan: CascadePlan | null = null;
    let structuralVerdict: StructuralVerdict | undefined;
    let structuralEpoch: number | undefined;
    let semanticVerdict: SemanticVerdict | undefined;
    let workloadVerdict: WorkloadVerdict | undefined;
    let learningGate: LearningGate = DISABLED_LEARNING_GATE;
    let learningEvidence: Float32Array | null = null;
    if (ir.model === AUTO_ALIAS && decision.decisionLayer === 'default') {
      // Per-tenant opt-out (#20): the effective layers are the instance
      // capability masked by the tenant's preference. A disabled layer is
      // skipped; the Layer-0 default then stands (invariant 1).
      const layers = await this.effectiveAutoLayers(principal);
      if (layers.structural) {
        // Per-tenant calibrated thresholds (add-auto-threshold-calibration):
        // resolved from the SAME settings read as the layer gates, degrade-
        // shaped (any invalid/stale pair → instance defaults).
        const thresholds = effectiveThresholds(
          this.routingConfig.structural,
          layers.settings,
          this.calibrationRails,
        );
        // Layer 1 CLASSIFICATION (band + workload verdicts) — no target lookup
        // yet (add-workload-routing D2): the workload stage runs between
        // classification and band resolution, so a claim pre-empts the band.
        const classified = await this.structural.classify(principal, agentId, ir, thresholds);
        // Workload stage (add-workload-routing D3): a confident workload class
        // with a resolvable `auto_workload` target CLAIMS the request before
        // band targets / L2 / cascade. Its own try/catch — a fault is
        // "unclaimed" (invariant 1). `none` never claims.
        let claimed: RouteDecision | null = null;
        if (
          classified.kind === 'classified' &&
          classified.workload !== undefined &&
          classified.workload.class !== WORKLOAD_NONE
        ) {
          try {
            claimed = this.workload.claim(snapshot, classified.workload);
          } catch {
            claimed = null; // degrade to the unclaimed flow — never fail or stall
          }
        }
        // Telemetry commit is ATOMIC (add-workload-routing D2/D3): the three
        // verdict locals are set only after a successful claim or a non-skip
        // band resolution; a band-resolution `skip` leaves all three unset
        // (null columns incl. structural_epoch — today's whole-evaluate semantics).
        const evaln =
          claimed !== null
            ? ({ kind: 'skip' } as const) // band NEVER resolved for a claimed request
            : this.structural.resolveBand(snapshot, classified);
        if (claimed !== null && classified.kind === 'classified') {
          decision = claimed; // decision_layer 'workload' — no band, no L2, no cascade
          structuralVerdict = classified.verdict;
          structuralEpoch = layers.settings?.calibrationEpoch ?? 0;
          if (classified.workload !== undefined) workloadVerdict = classified.workload;
        } else if (evaln.kind !== 'skip') {
          // Telemetry (add-auto-decision-telemetry): every EVALUATED request
          // records its verdict — including ambiguous/unroutable fall-throughs.
          structuralVerdict = evaln.verdict;
          structuralEpoch = layers.settings?.calibrationEpoch ?? 0;
          // Workload telemetry (add-workload-telemetry): the verdict rides the
          // same evaluation; absent when the workload classifier faulted.
          if (evaln.workload !== undefined) workloadVerdict = evaln.workload;
        }
        if (claimed !== null) {
          // claimed — nothing below runs
        } else if (evaln.kind === 'route') {
          decision = evaln.decision; // Layer 1 confident band
        } else if (evaln.kind === 'ambiguous') {
          // Layer 2 (semantic) refines ONLY the L1-ambiguous slice (add-
          // semantic-routing D1). A confident L2 band routes; a still-
          // ambiguous or unroutable L2 verdict hands to cascade/default. Every
          // L2 fault degrades to exactly today's L1-ambiguous flow.
          const gate = layers.semantic
            ? this.learningGate(layers.settings, snapshot)
            : DISABLED_LEARNING_GATE;
          const sem = layers.semantic
            ? await this.semantic.evaluate(principal, ir, snapshot, gate, { signal })
            : ({ kind: 'skip' } as const);
          if (sem.kind !== 'skip') semanticVerdict = sem.verdict;
          // The vector + gate for the learning contributor ride Prepared, set ONLY
          // for the L2-ambiguous slice (add-semantic-learning D1/D3) — the exact
          // requests whose cascade outcome becomes a weak label.
          if (sem.kind === 'ambiguous') {
            learningGate = gate;
            learningEvidence = sem.evidence;
          }
          if (sem.kind === 'route') {
            decision = sem.decision; // Layer 2 confident band — never cascades
          } else if (sem.kind === 'unroutable') {
            // A CONFIDENT L2 band whose target is missing/empty: the verdict
            // stands (recorded), the Layer-0 default serves — it does NOT
            // cascade (mirrors L1's unroutable; clink r2 High-1).
          } else if (layers.cascade) {
            // Only a still-AMBIGUOUS verdict or a SKIP (L2 not evaluated /
            // faulted) hands to the existing cascade candidate.
            cascadePlan = this.cascade.plan(snapshot);
          }
          // else: the Layer-0 default decision stands (invariant 1)
        }
        // else: the Layer-0 default decision stands (invariant 1)
      }
    }

    const capsRef: CapsRef = { current: new Map() };
    let primary = await this.buildBundle(principal, decision, models, signal, capsRef);

    let cascadeRaw: { cheap: Bundle; strong: Bundle } | null = null;
    if (cascadePlan !== null) {
      cascadeRaw = {
        cheap: await this.buildBundle(principal, cascadePlan.cheap, models, signal, capsRef),
        strong: await this.buildBundle(principal, cascadePlan.strong, models, signal, capsRef),
      };
    }

    // Output-cap capacity planning (add-output-cap-guardrails): resolve KNOWN
    // caps once (exact keys only, ONE batched read, fail-open to unknown), then
    // plan each WALKED chain. A client-named concrete model is fenced (provider
    // parity); an absent ask still resolves caps so the synthesized Anthropic
    // default can be capped to the dispatched model's limit (the closures in
    // `capsRef` read the populated map lazily at dispatch time).
    const clientNamed = decision.decisionLayer === 'explicit' && decision.tierKey === null;
    const planAsk = clientNamed ? null : participatingAsk(ir.params.maxOutputTokens);
    if (planAsk !== null || ir.params.maxOutputTokens === undefined) {
      const allMeta = [
        ...primary.meta,
        ...(cascadeRaw !== null ? [...cascadeRaw.cheap.meta, ...cascadeRaw.strong.meta] : []),
      ];
      capsRef.current = await resolveOutputCaps(
        (keys, at) => this.db.pricing.priceAtMany(keys, at),
        allMeta,
        new Date(startedAt),
      );
    }

    let cascade: CascadeBundle | undefined;
    let capacity: Prepared['capacity'];
    if (cascadeRaw !== null) {
      const { cheap, strong } = cascadeRaw;
      // Escalation walks strong then the Layer-0 default (reliable-core rescue).
      if (cheap.attempts.length > 0 && strong.attempts.length + primary.attempts.length > 0) {
        const escalationRaw: Bundle = {
          attempts: [...strong.attempts, ...primary.attempts],
          meta: [...strong.meta, ...primary.meta],
        };
        if (planAsk !== null) {
          // Plan per WALKED chain: the cheap chain and the CONCATENATED
          // strong-then-default escalation — never a source bundle alone.
          const cheapPlan = planWalkedChain(cheap, planAsk, capsRef.current);
          const escPlan = planWalkedChain(escalationRaw, planAsk, capsRef.current);
          cascade = {
            cheap: cheapPlan.bundle,
            escalation: escPlan.bundle,
            cheapTimeoutMs: this.cascade.cheapTimeoutMs,
          };
          if (cheapPlan.capacity !== undefined || escPlan.capacity !== undefined) {
            capacity = {
              ...(cheapPlan.capacity !== undefined ? { cheap: cheapPlan.capacity } : {}),
              ...(escPlan.capacity !== undefined ? { escalation: escPlan.capacity } : {}),
            };
          }
        } else {
          cascade = {
            cheap,
            escalation: escalationRaw,
            cheapTimeoutMs: this.cascade.cheapTimeoutMs,
          };
        }
      }
    }
    if (cascade === undefined && planAsk !== null) {
      const plan = planWalkedChain(primary, planAsk, capsRef.current);
      primary = plan.bundle;
      if (plan.capacity !== undefined) capacity = { primary: plan.capacity };
    }

    if (primary.attempts.length === 0 && cascade === undefined) {
      throw serviceUnavailable('no usable provider for the route');
    }

    // Fall-through transparency (add-auto-decision-telemetry / add-semantic-
    // routing): keyed on the FINAL construction (`cascade === undefined` — a
    // resolved plan whose bundles failed to materialize falls through too,
    // never the earlier plan-null check). The gate carries the ORDERED L1→L2
    // classification trail onto a default fall-through reason; the cascade
    // path threads the same trail through its own recorder construction.
    decision = withFallthroughSuffix(
      decision,
      structuralVerdict,
      semanticVerdict,
      cascade !== undefined,
    );

    // Body capture (add-body-capture): arm ONLY when the effective state can
    // persist (off / agent-never allocate nothing — the master kill). The
    // request is serialized NOW (media-stripped, capped); the response slot is
    // filled by whichever path serves; the recorder decides persistence at
    // outcome time from this state.
    const capCtx = await this.bodyCapture.contextFor(principal, agentId);
    let capture: Prepared['capture'];
    if (capCtx.mode !== 'off' && capCtx.override !== 'never') {
      const collector = new BoundedBlockCollector(this.bodyCapture.maxBytes);
      capture = {
        state: {
          mode: capCtx.mode,
          override: capCtx.override,
          epoch: capCtx.epoch,
          capturedAt: new Date(),
          maxBytes: this.bodyCapture.maxBytes,
          request: serializeClientRequest(wireBody, this.bodyCapture.maxBytes),
          responseBlocks: () => {
            if (collector.hasContent)
              return { blocks: collector.blocks(), truncated: collector.truncated };
            const b = capture?.buffered;
            return b !== undefined ? { blocks: b, truncated: false } : null;
          },
        },
        collector,
      };
    }

    return {
      client,
      requestId,
      protocol,
      routed: ir, // the model is retargeted per-attempt inside the walker
      structuredDemand: declaredStructuredOutput(ir),
      ...(structuralVerdict !== undefined ? { structuralVerdict } : {}),
      ...(structuralEpoch !== undefined ? { structuralEpoch } : {}),
      ...(semanticVerdict !== undefined ? { semanticVerdict } : {}),
      ...(workloadVerdict !== undefined ? { workloadVerdict } : {}),
      learningGate,
      learningEvidence,
      created: Math.floor(Date.now() / 1000),
      attempts: primary.attempts,
      meta: primary.meta,
      decision,
      startedAt,
      requestChars,
      principal,
      agentId,
      ...(cascade !== undefined ? { cascade } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      ...(capture !== undefined ? { capture } : {}),
    };
  }

  /** Resolve a decision's chain into lazy attempts + recording meta (owner-scoped
   * loads; adapters built lazily inside the breaker callback, #12). */
  private async buildBundle(
    principal: Principal,
    decision: RouteDecision,
    models: ModelRow[],
    signal: AbortSignal,
    capsRef: CapsRef,
  ): Promise<Bundle> {
    const attempts: ChainAttempt[] = [];
    const meta: AttemptMeta[] = [];
    for (const t of decision.chain) {
      const provider = await this.db.providers.findById(principal, t.providerId);
      const model = models.find((m) => m.id === t.modelId);
      if (!provider || !model) continue;
      meta.push({
        providerId: t.providerId,
        providerName: provider.name,
        modelId: t.modelId,
        tierKey: decision.tierKey,
        providerBaseUrl: provider.baseUrl,
        providerKind: provider.kind,
        model: {
          externalModelId: model.externalModelId,
          inputPricePer1m: model.inputPricePer1m,
          outputPricePer1m: model.outputPricePer1m,
          isFree: model.isFree,
          // The captured provider-listed estimate feeds the resolver's last-resort
          // fallback for recorded cost (record-listed-price-fallback).
          listedInputPricePer1m: model.listedInputPricePer1m,
          listedOutputPricePer1m: model.listedOutputPricePer1m,
          listedIsFree: model.listedIsFree,
        },
      });
      const bounds = this.effectiveBounds(provider);
      // THIS member's probe patience (add-fallback-attempt-detail O1-C):
      // widened bounds + the lease its probe admission must be granted —
      // pre-computed HERE, where the effective (override-resolved) bounds live.
      const patience = probePatienceOf({
        firstByteTimeoutMs: bounds.firstByteTimeoutMs,
        idleTimeoutMs: bounds.idleTimeoutMs,
        eventMarginMs: this.rt.firstEventTimeoutMs - this.rt.firstByteTimeoutMs,
      });
      attempts.push({
        providerId: t.providerId,
        externalModelId: t.externalModelId,
        // The cap is read LAZILY at dispatch (capsRef is populated after the
        // bundle builds) so polyrouter's own synthesized Anthropic default can
        // be capped to THIS member's known limit (add-output-cap-guardrails).
        // A probe admission widens the adapter bounds (probe patience).
        buildAdapter: (admission?: BreakerAdmission) => {
          const key =
            provider.baseUrl !== null ? deriveModelKey(provider.baseUrl, t.externalModelId) : null;
          return this.chainAdapter(
            principal,
            provider,
            signal,
            key !== null ? capsRef.current.get(key) : undefined,
            admission?.isProbe === true,
          );
        },
        // THIS member's stream watchdog bound (fix-long-call-timeouts): a
        // per-provider override must reach core even mid-chain beside
        // un-overridden members.
        firstEventTimeoutMs: bounds.streamEventTimeoutMs,
        probeFirstEventTimeoutMs: patience.firstEventTimeoutMs,
        probeLeaseMs: patience.leaseMs,
      });
    }
    return { attempts, meta };
  }

  /** Effective per-provider timeout bounds (fix-long-call-timeouts):
   * `override ?? instance default`, with the core stream bound derived at the
   * SAME fixed margin above the effective first-byte bound (E1.3 — the
   * adapter's typed timer must keep winning pre-headers races). */
  private effectiveBounds(provider: Pick<ProviderRow, 'firstByteTimeoutMs' | 'idleTimeoutMs'>): {
    firstByteTimeoutMs: number;
    idleTimeoutMs: number;
    streamEventTimeoutMs: number;
  } {
    const margin = this.rt.firstEventTimeoutMs - this.rt.firstByteTimeoutMs;
    const firstByteTimeoutMs = provider.firstByteTimeoutMs ?? this.rt.firstByteTimeoutMs;
    return {
      firstByteTimeoutMs,
      idleTimeoutMs: provider.idleTimeoutMs ?? this.rt.idleTimeoutMs,
      streamEventTimeoutMs: firstByteTimeoutMs + margin,
    };
  }

  /** Build a chain member's adapter; a setup failure (SSRF/config/decrypt)
   * becomes a classified, fallback-eligible ProviderError (skipped + trips the
   * breaker so it's skipped fast next time), counted per provider (#21) — EXCEPT a
   * `credential`-kind failure (add-subscription-oauth: revoked OAuth grant / IdP
   * outage), which passes through as-is: fallback-eligible but breaker-NEUTRAL,
   * because credential state is not upstream provider health. The built adapter is
   * wrapped with the `upstream` span + metrics decorator. */
  private async chainAdapter(
    principal: Principal,
    provider: ProviderRow,
    signal: AbortSignal,
    maxOutputCap?: number,
    probe = false,
  ): Promise<ProviderAdapter> {
    let adapter: ProviderAdapter;
    try {
      adapter = await this.buildAdapter(principal, provider, maxOutputCap, probe);
    } catch (err) {
      this.metrics.upstreamSetupFailed(provider.name);
      if (err instanceof ProviderError && err.kind === 'credential') throw err;
      throw new ProviderError('unavailable', 'provider setup failed');
    }
    return observeAdapter(adapter, {
      provider: provider.name,
      clientAborted: () => signal.aborted,
      metrics: this.metrics,
    });
  }

  private servedContext(
    p: Prepared,
    servedIndex: number,
    failures: readonly AttemptFailure[],
  ): RecordingContext {
    // No terminal error: a served context's later post-commit failure never
    // enters `failures`, so its per-attempt trail carries no terminal marker.
    return this.contextFor(p, servedIndex, servedIndex, failures, null);
  }

  /** Total-chain failure is recorded against the primary. `terminalError` is the
   * chain result's own error — the entry-composer marks the matching tail entry
   * (exhaustion) and leaves a non-retryable stop unmarked (identity mismatch). */
  private failedContext(
    p: Prepared,
    failures: readonly AttemptFailure[],
    terminalError: unknown,
  ): RecordingContext {
    return this.contextFor(p, 0, null, failures, terminalError);
  }

  private contextFor(
    p: Prepared,
    metaIndex: number,
    servedIndex: number | null,
    failures: readonly AttemptFailure[],
    terminalError: unknown,
  ): RecordingContext {
    const m = p.meta[metaIndex]!;
    const trailEntries = attemptTrailEntries([{ failures, meta: p.meta }], terminalError);
    return {
      ...(trailEntries.length > 0 ? { attemptFailures: trailEntries } : {}),
      principal: p.principal,
      requestId: p.requestId,
      ...(p.onSettle !== undefined ? { onSettle: p.onSettle } : {}),
      agentId: p.agentId,
      protocol: p.protocol,
      providerId: m.providerId,
      providerName: m.providerName,
      modelId: m.modelId,
      ...verdictFields(p),
      tierAssigned: p.decision.tierKey,
      decisionLayer: p.decision.decisionLayer,
      routingReason: withCapacity(
        reasonWithTrail(p.decision.routingReason, failures, p.meta),
        capacitySuffix(null, p.capacity?.primary, servedIndex, failures),
      ),
      // The header that chose the route (add-routing-header-visibility); the
      // cascade context (metaContext) never carries one by construction.
      ...(p.decision.matchedHeader !== null ? { routingHeader: p.decision.matchedHeader } : {}),
      ...(p.capture !== undefined ? { capture: p.capture.state } : {}),
      provider: { baseUrl: m.providerBaseUrl, kind: m.providerKind },
      model: m.model,
      startedAt: p.startedAt,
      requestChars: p.requestChars,
    };
  }

  /** A cascade recording context for `meta[servedIndex]` (per-member tier + price),
   * `decision_layer='cascade'`, with the score + fallback trail in the reason.
   * The ordered L1→L2 classification trail is APPENDED (add-semantic-routing):
   * a cascaded request reached cascade THROUGH those verdicts, so its reason
   * carries them as a `; `-joined suffix — the same convention
   * `withFallthroughSuffix` uses for a default fall-through (clink set-Med-2). */
  private servedFrom(
    p: Prepared,
    meta: readonly AttemptMeta[],
    servedIndex: number,
    baseReason: string,
    score: number | null,
    failures: readonly AttemptFailure[],
    /** The leg-qualified per-attempt trail (add-fallback-attempt-detail),
     * composed at the call site so escalation rows aggregate BOTH executed
     * legs (cheap first) — the recorder persists it only on error rows. */
    attemptTrail: readonly AttemptFailureEntry[],
  ): RecordingContext {
    const reason = reasonWithTrail(`${baseReason} (q=${fmtQ(score)})`, failures, meta);
    const trail = classificationTrail(p);
    const ctx: RecordingContext = {
      ...this.metaContext(p, meta[servedIndex]!, trail === '' ? reason : `${reason}; ${trail}`),
      ...(attemptTrail.length > 0 ? { attemptFailures: attemptTrail } : {}),
    };
    // The learning vector rides the SERVED context ONLY (add-semantic-learning
    // D1/3.1) — the recorder's sink contributes it at settle, then drops it.
    if (p.learningEvidence === null) return ctx;
    return {
      ...ctx,
      learning: {
        evidence: p.learningEvidence,
        enabled: p.learningGate.enabled,
        epoch: p.learningGate.epoch,
        revision: p.learningGate.evidenceRevision,
      },
    };
  }

  private metaContext(p: Prepared, m: AttemptMeta, reason: string): RecordingContext {
    return {
      principal: p.principal,
      requestId: p.requestId,
      ...(p.onSettle !== undefined ? { onSettle: p.onSettle } : {}),
      agentId: p.agentId,
      protocol: p.protocol,
      providerId: m.providerId,
      providerName: m.providerName,
      modelId: m.modelId,
      tierAssigned: m.tierKey,
      decisionLayer: 'cascade',
      routingReason: reason,
      ...verdictFields(p),
      ...(p.capture !== undefined ? { capture: p.capture.state } : {}),
      provider: { baseUrl: m.providerBaseUrl, kind: m.providerKind },
      model: m.model,
      startedAt: p.startedAt,
      requestChars: p.requestChars,
    };
  }

  /** Publish live presence for an admitted request (add-inflight-requests) and arm
   * its settle hook — the ONE admit-write site, after `prepare()` and before any
   * cascade delegation. Fire-and-forget; a no-op lease when the registry is absent. */
  private beginInflight(p: Prepared): { settle: () => void } {
    const lease = this.inflight?.mark(p.principal, this.inflightEntryOf(p)) ?? {
      settle: (): void => undefined,
    };
    p.onSettle = () => lease.settle();
    return lease;
  }

  /** The in-flight entry for this request (add-inflight-requests): the FIRST
   * planned member of the bundle that executes first — the cheap bundle for a
   * cascade, the primary chain otherwise. A best-effort label; the durable row
   * corrects a fallback/escalation/breaker-skip. */
  private inflightEntryOf(p: Prepared): InflightEntry {
    const m = (p.cascade?.cheap.meta ?? p.meta)[0];
    return {
      requestId: p.requestId,
      startedAt: p.startedAt,
      decisionLayer: p.cascade !== undefined ? 'cascade' : p.decision.decisionLayer,
      tierAssigned: m?.tierKey ?? null,
      modelLabel: m?.model.externalModelId ?? null,
      providerLabel: m?.providerName ?? null,
      protocol: p.protocol,
    };
  }

  private loadSnapshot(
    principal: Principal,
  ): Promise<{ snapshot: RoutingSnapshot; models: ModelRow[] }> {
    // Extracted to a shared loader so the learning sweep builds each tenant's
    // snapshot through the EXACT same code the hot path does (revision parity).
    return loadRoutingSnapshot(this.db, principal);
  }

  /** The adapter bounds for this call (probe patience, add-fallback-attempt-
   * detail): a half-open probe runs with the member's effective bounds widened
   * ×2 (capped at the ceiling) — first-byte, independently-resolved idle, and
   * the derived stream bound — so the dispatcher backstops derive above the
   * WIDENED typed bounds and the layer ordering holds. Non-probe calls keep
   * their exact effective bounds. */
  private callBounds(
    provider: Pick<ProviderRow, 'firstByteTimeoutMs' | 'idleTimeoutMs'>,
    probe: boolean,
  ): { firstByteTimeoutMs: number; idleTimeoutMs: number; streamEventTimeoutMs: number } {
    const bounds = this.effectiveBounds(provider);
    if (!probe) return bounds;
    const patience = probePatienceOf({
      firstByteTimeoutMs: bounds.firstByteTimeoutMs,
      idleTimeoutMs: bounds.idleTimeoutMs,
      eventMarginMs: this.rt.firstEventTimeoutMs - this.rt.firstByteTimeoutMs,
    });
    return {
      firstByteTimeoutMs: patience.firstByteTimeoutMs,
      idleTimeoutMs: patience.idleTimeoutMs,
      streamEventTimeoutMs: patience.firstEventTimeoutMs,
    };
  }

  private async buildAdapter(
    principal: Principal,
    provider: ProviderRow,
    maxOutputCap?: number,
    probe = false,
  ): Promise<ProviderAdapter> {
    if (provider.baseUrl === null) throw serviceUnavailable('provider has no base_url');
    // Defensive synthesized default (add-output-cap-guardrails): where the IR
    // omits maxOutputTokens the Anthropic adapter synthesizes max_tokens from
    // this default — capped to the dispatched model's KNOWN limit so
    // polyrouter's own default can never doom the request. Only polyrouter's
    // synthesized value is corrected; a client value always passes through.
    const defaultMaxOutputTokens = cappedDefault(this.rt.defaultMaxOutputTokens, maxOutputCap);
    const kind = provider.kind as ProviderKind;
    // Resolve the outbound token-cap spelling to the data-plane quirk — the SAME
    // helper providers.service uses, so proxy and test-connection never diverge
    // (add-max-tokens-spelling). Inert for non-`openai_compatible` protocols.
    const quirks = providerMaxTokensQuirks(
      provider.protocol,
      kind,
      provider.maxTokensSpelling as MaxTokensSpelling,
    );
    try {
      await assertUrlSafe(provider.baseUrl, { context: { mode: this.mode, providerKind: kind } });
    } catch (err) {
      if (err instanceof SsrfError) throw serviceUnavailable('provider address rejected');
      throw err;
    }
    // Subscription providers resolve through the subscription-oauth seam: it unwraps a
    // plain paste, or refreshes an OAuth token (pre-request only — invariant 3) and
    // supplies authScheme/oauthBeta. Credential failures are ProviderError('credential')
    // — fallback-eligible, breaker-neutral (chainAdapter passes them through).
    if (kind === 'subscription' && provider.encryptedCredentials !== null) {
      const r = await this.oauth.resolveCredential(principal, provider);
      return this.factory({
        protocol: provider.protocol as ProviderProtocol,
        baseUrl: provider.baseUrl,
        credential: r.credential,
        kind,
        mode: this.mode,
        authScheme: r.authScheme,
        ...(r.oauthBeta !== undefined ? { oauthBeta: r.oauthBeta } : {}),
        ...(r.oauthAccountId !== undefined ? { oauthAccountId: r.oauthAccountId } : {}),
        ...(r.probeModel !== undefined ? { probeModel: r.probeModel } : {}),
        ...(quirks !== undefined ? { quirks } : {}),
        defaultMaxOutputTokens,
        ...this.callBounds(provider, probe),
      });
    }
    let credential = '';
    if (provider.encryptedCredentials !== null) {
      // Plain path: unwrap the typed envelope (legacy raw passes through). OAuth
      // envelopes resolve through the subscription-oauth seam above instead.
      credential = resolvePlainCredentialValue(
        decryptSecret(provider.encryptedCredentials, this.key),
      );
    } else if (kind !== 'local') {
      throw serviceUnavailable('provider has no credential');
    }
    return this.factory({
      protocol: provider.protocol as ProviderProtocol,
      baseUrl: provider.baseUrl,
      credential,
      kind,
      mode: this.mode,
      ...(quirks !== undefined ? { quirks } : {}),
      defaultMaxOutputTokens,
      ...this.callBounds(provider, probe),
    });
  }
}

/** The fall-through reason suffix (add-auto-decision-telemetry), PURE and
 * unit-pinned: applied ONLY when the layer evaluated (`verdict`), the Layer-0
 * default ultimately stands, and NO cascade was finally constructed. The
 * caller keys `hasCascade` on the FINAL bundle (`cascade !== undefined`). */
export function withFallthroughSuffix(
  decision: RouteDecision,
  verdict: StructuralVerdict | undefined,
  semantic: SemanticVerdict | undefined,
  hasCascade: boolean,
): RouteDecision {
  // Only a DEFAULT fall-through with no cascade gets the trail suffix (a
  // cascade decision carries its own recorder-built trail; a semantic-routed
  // decision is not `default`). The trail is ORDERED L1→L2: the structural
  // verdict first, then the semantic verdict when Layer 2 evaluated.
  if (decision.decisionLayer !== 'default' || hasCascade) return decision;
  const parts: string[] = [];
  if (verdict !== undefined) parts.push(verdict.reason);
  if (semantic !== undefined) parts.push(semantic.reason);
  if (parts.length === 0) return decision;
  return { ...decision, routingReason: `${decision.routingReason}; ${parts.join('; ')}` };
}

/** The request-level L1 verdict as recording-context fields (add-auto-
 * decision-telemetry): every parent request_log row of an evaluated request
 * carries the same band/score/source; absent verdict = all null. */
function verdictFields(p: Prepared): {
  structuralBand?: string;
  structuralScore?: number;
  structuralBandSource?: string;
  structuralEpoch?: number;
  semanticBand?: string;
  semanticScore?: number;
  semanticSource?: string;
  semanticRevision?: string;
  workloadClass?: string;
  workloadScore?: number;
  workloadSource?: string;
  workloadRevision?: string;
} {
  const v = p.structuralVerdict;
  const s = p.semanticVerdict;
  const w = p.workloadVerdict;
  return {
    ...(v !== undefined
      ? {
          structuralBand: v.band,
          structuralScore: v.score,
          structuralBandSource: v.declared ? 'declared' : 'threshold',
          // Decision-time freshness stamp (add-auto-threshold-calibration).
          ...(p.structuralEpoch !== undefined ? { structuralEpoch: p.structuralEpoch } : {}),
        }
      : {}),
    // Layer 2 telemetry (add-semantic-routing): the four columns travel
    // together — recorded on every parent row of an L2-evaluated request.
    ...(s !== undefined
      ? {
          semanticBand: s.band,
          semanticScore: s.score,
          semanticSource: s.source,
          semanticRevision: s.revision,
        }
      : {}),
    // Workload telemetry (add-workload-telemetry): the four columns travel
    // together — recorded on every parent row of an evaluated request.
    ...(w !== undefined
      ? {
          workloadClass: w.class,
          workloadScore: w.score,
          workloadSource: w.source,
          workloadRevision: w.revision,
        }
      : {}),
  };
}

/** Terminal-error detail for the recorder (add-request-error-detail): the
 * ProviderError's taxonomy fields verbatim — `providerMessage` is already
 * factory-sanitized at the capture layer. The recorder persists it only on
 * `status='error'` rows (central exclusivity gate). */
function recordedError(err: ProviderError): RecordedError {
  return {
    kind: err.kind,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.providerMessage !== undefined ? { providerMessage: err.providerMessage } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  };
}

/** The ordered L1→L2 classification trail as a reason fragment (add-semantic-
 * routing): the structural verdict reason, then the semantic verdict reason,
 * `; `-joined — the same ordering `withFallthroughSuffix` appends to a default
 * fall-through. Empty when neither layer evaluated. Numbers-only (invariant 8). */
function classificationTrail(p: Prepared): string {
  const parts: string[] = [];
  if (p.structuralVerdict !== undefined) parts.push(p.structuralVerdict.reason);
  if (p.semanticVerdict !== undefined) parts.push(p.semanticVerdict.reason);
  return parts.join('; ');
}

/** The routing reason plus a sanitized fallback trail (kind@model — no raw
 * messages) so #11 records why earlier chain members failed (§7.4). A member
 * skipped by an open circuit breaker — never dispatched upstream — records
 * `skip@model` (add-fallback-attempt-detail): a pseudo-token deliberately
 * outside the provider-error taxonomy, so a never-contacted member cannot
 * impersonate an upstream failure. Absent `dispatched` reads as dispatched. */
export function reasonWithTrail(
  reason: string,
  failures: readonly AttemptFailure[],
  meta: readonly AttemptMeta[],
): string {
  if (failures.length === 0) return reason;
  const trail = failures
    .map(
      (f) =>
        `${f.dispatched === false ? 'skip' : f.error.kind}@${meta[f.index]?.model.externalModelId ?? '?'}`,
    )
    .join(', ');
  return `${reason}; fell back after: ${trail}`;
}

/** One executed leg's walk record, paired for entry composition. Structural
 * (not `AttemptMeta`) so tests can build minimal fixtures. */
export interface AttemptTrailLeg {
  readonly failures: readonly AttemptFailure[];
  readonly meta: ReadonlyArray<{
    readonly providerId: string;
    readonly model: { readonly externalModelId: string };
  }>;
  readonly leg?: 'cheap' | 'escalation';
}

/** Compose the per-attempt failure metadata for #11 (add-fallback-attempt-
 * detail): every executed leg's pre-commit failures/skips in execution order,
 * leg-relative indices, bounded at {@link ATTEMPT_FAILURES_MAX}. The terminal
 * marker is set by IDENTITY — the FINAL leg's entry whose error IS the chain
 * result's terminal error. That is true only on whole-chain exhaustion (the
 * walker's `lastError` is the pushed tail's own instance); a non-retryable
 * stop's or a post-commit stream failure's terminal error never enters the
 * failure list, so no entry matches and none is marked. */
export function attemptTrailEntries(
  legs: readonly AttemptTrailLeg[],
  terminalError: unknown,
): AttemptFailureEntry[] {
  const entries: AttemptFailureEntry[] = [];
  for (let li = 0; li < legs.length; li += 1) {
    const { failures, meta, leg } = legs[li]!;
    const last = li === legs.length - 1;
    for (const f of failures) {
      const m = meta[f.index];
      entries.push({
        index: f.index,
        providerId: m?.providerId ?? null,
        model: m?.model.externalModelId ?? '?',
        kind: f.error.kind,
        ...(f.error.status !== undefined ? { status: f.error.status } : {}),
        dispatched: f.dispatched !== false,
        ...(leg !== undefined ? { leg } : {}),
        ...(last && terminalError !== null && f.error === terminalError ? { terminal: true } : {}),
      });
    }
  }
  return entries.slice(0, ATTEMPT_FAILURES_MAX);
}

/** Plan ONE walked chain (add-output-cap-guardrails): the two-stage deferral
 * over atomically-paired attempts+meta, plus the recorded annotations. Tail
 * members get a per-attempt clamped copy (their OWN cap); clamp strings are
 * keyed by EFFECTIVE index and only recorded for dispatched attempts
 * (`capacitySuffix`). Caps resolve by the EXACT catalog key only. */
export function planWalkedChain(
  bundle: Bundle,
  ask: number,
  caps: ReadonlyMap<string, number>,
): { bundle: Bundle; capacity: CapacityAnnotations | undefined } {
  const inputs = bundle.attempts.map((attempt, i) => {
    const meta = bundle.meta[i]!;
    const key =
      meta.providerBaseUrl !== null
        ? deriveModelKey(meta.providerBaseUrl, meta.model.externalModelId)
        : null;
    return {
      member: { attempt, meta },
      cap: key !== null ? (caps.get(key) ?? null) : null,
      label: meta.model.externalModelId,
    };
  });
  const plan = planOutputCaps(inputs, ask);
  const attempts: ChainAttempt[] = [];
  const meta: AttemptMeta[] = [];
  const clampByIndex = new Map<number, string>();
  plan.members.forEach((m, i) => {
    meta.push(m.member.meta);
    if (m.clampTo === undefined) {
      attempts.push(m.member.attempt);
    } else {
      attempts.push({ ...m.member.attempt, maxOutputTokens: m.clampTo });
      clampByIndex.set(i, `output_cap_clamped ${ask}→${m.clampTo} (${m.label})`);
    }
  });
  const deferred =
    plan.deferred.length > 0
      ? `output_cap_deferred ${plan.deferred.map((d) => `${d.label}(${d.cap}<${ask})`).join(', ')}`
      : null;
  const capacity =
    deferred !== null || clampByIndex.size > 0 ? { deferred, clampByIndex } : undefined;
  return { bundle: { attempts, meta }, capacity };
}

/** The recorded capacity suffix for one EXECUTED walked chain: the plan-time
 * deferrals plus the clamps of attempts actually dispatched — the served
 * member and non-circuit-skip failures. A tail member skipped by an open
 * circuit (or never reached) records NO clamp; a non-retryable TERMINAL
 * failure after a clamped dispatch is the accepted under-record (the walker
 * surfaces no terminal index — never an over-record). */
export function capacitySuffix(
  leg: 'cheap' | 'esc' | null,
  ann: CapacityAnnotations | undefined,
  servedIndex: number | null,
  failures: readonly AttemptFailure[],
): string | null {
  if (ann === undefined) return null;
  const parts: string[] = [];
  if (ann.deferred !== null) parts.push(ann.deferred);
  const dispatched = new Set<number>();
  if (servedIndex !== null) dispatched.add(servedIndex);
  for (const f of failures) if (f.dispatched !== false) dispatched.add(f.index);
  for (const [i, s] of ann.clampByIndex) if (dispatched.has(i)) parts.push(s);
  if (parts.length === 0) return null;
  const joined = parts.join('; ');
  return leg === null ? joined : `${leg}[${joined}]`;
}

/** The synthesized Anthropic `max_tokens` default, capped to a KNOWN model
 * limit (add-output-cap-guardrails): unknown or larger cap → the configured
 * default unchanged. Applies on every path, client-named included — there is
 * no client value to preserve when the IR omits the ask. */
export function cappedDefault(configuredDefault: number, knownCap: number | undefined): number {
  return knownCap !== undefined ? Math.min(configuredDefault, knownCap) : configuredDefault;
}

/** Append capacity suffixes to a reason (null suffixes drop out). */
export function withCapacity(reason: string, ...suffixes: (string | null)[]): string {
  const present = suffixes.filter((s): s is string => s !== null);
  return present.length === 0 ? reason : `${reason}; ${present.join('; ')}`;
}

/** EXACT-key output caps for the given members in ONE `priceAtMany` batch
 * (add-output-cap-guardrails): dedupe the derived keys across ALL walked
 * chains, one read at one instant. Fail-open: any rejection degrades every cap
 * to unknown — capacity discovery never fails an otherwise routable request
 * (invariant 1). No native-family fallback, no model-row source, no cache, and
 * NO bespoke deadline (the read shares the snapshot loads' pool posture). */
export async function resolveOutputCaps(
  priceAtMany: (
    keys: readonly string[],
    at: Date,
  ) => Promise<readonly { modelKey: string; maxOutputTokens: number | null }[]>,
  metas: readonly { providerBaseUrl: string | null; model: { externalModelId: string } }[],
  at: Date,
): Promise<ReadonlyMap<string, number>> {
  const keys = new Set<string>();
  for (const m of metas) {
    if (m.providerBaseUrl === null) continue;
    const key = deriveModelKey(m.providerBaseUrl, m.model.externalModelId);
    if (key !== null) keys.add(key);
  }
  if (keys.size === 0) return new Map();
  try {
    const rows = await priceAtMany([...keys], at);
    const caps = new Map<string, number>();
    for (const r of rows) {
      const cap = r.maxOutputTokens;
      if (cap !== null && Number.isInteger(cap) && cap > 0) caps.set(r.modelKey, cap);
    }
    return caps;
  } catch {
    return new Map(); // fail-open (spec'd): all caps unknown, request routes as today
  }
}

/** `cascade: escalated cheap→<served-tier>` (names the tier that actually served,
 * `default` on a reliable-core rescue). */
function escalatedReason(meta: readonly AttemptMeta[], servedIndex: number): string {
  return `cascade: escalated cheap→${meta[servedIndex]?.tierKey ?? 'model'}`;
}

function fmtQ(score: number | null): string {
  return score === null ? 'n/a' : score.toFixed(2);
}

/** Rough request size for the input-token estimate; never throws. */
function safeChars(body: unknown): number {
  try {
    return JSON.stringify(body)?.length ?? 0;
  } catch {
    return 0;
  }
}

function normalizeHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
