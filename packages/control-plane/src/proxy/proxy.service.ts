import { Inject, Injectable } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  AUTO_ALIAS,
  PERSISTENCE_PORT,
  SsrfError,
  assertUrlSafe,
  decryptSecret,
  resolvePlainCredentialValue,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  ProviderError,
  declaredStructuredOutput,
  getAdapter,
  isRouteError,
  openStreamChain,
  replayBufferedStream,
  resolveRoute,
  runBufferedChain,
  shouldFallback,
  type AttemptFailure,
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
  type RouteEntry,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
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
import {
  ROUTING_CONFIG,
  autoLayerCapability,
  effectiveAutoLayers as computeEffectiveLayers,
  type RoutingConfig,
} from './routing.config';
import {
  RequestRecorder,
  type RecordedError,
  type RecordingContext,
} from '../recording/request-recorder';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { observeAdapter } from '../observability/observe-adapter';
import { TRACER_NAME } from '../observability/tracing';
import { StructuralRouter } from './structural/structural-router';
import { CascadeRouter, type CascadePlan } from './cascade/cascade-router';
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
    'externalModelId' | 'inputPricePer1m' | 'outputPricePer1m' | 'isFree'
  >;
}

/** A resolved fallback chain: lazy attempts + parallel recording metadata. */
interface Bundle {
  readonly attempts: ChainAttempt[];
  readonly meta: AttemptMeta[];
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
  protocol: ClientProtocol;
  routed: NormalizedRequest;
  /** The request's declared machine-parseable-output flag, captured ONCE at
   * preparation — before any upstream call — so the cascade gate's demand can
   * never drift with a shared nested reference (harden-cascade-quality-gate). */
  structuredDemand: boolean;
  created: number;
  attempts: ChainAttempt[];
  meta: AttemptMeta[];
  decision: RouteDecision;
  startedAt: number;
  requestChars: number;
  principal: Principal;
  agentId: string | null;
  cascade?: CascadeBundle;
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
    private readonly recorder: RequestRecorder,
    private readonly metrics: ProxyMetrics,
    private readonly structural: StructuralRouter,
    private readonly cascade: CascadeRouter,
    private readonly producers: NotificationProducers,
    private readonly budgets: BudgetService,
    private readonly oauth: SubscriptionOauthService,
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
      this.recorder.record(this.servedContext(p, result.servedIndex, result.failures), {
        status: result.failures.length > 0 ? 'fallback' : 'success',
        ...(result.response.usage !== undefined ? { providerUsage: result.response.usage } : {}),
        outputChars: countOutputChars(result.response.content),
      });
      return result.wire;
    }
    this.recorder.record(this.failedContext(p, result.failures), {
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
    if (p.cascade !== undefined) return this.cascadeStream(p, p.cascade, signal);

    const result = await openStreamChain(this.breaker, p.attempts, p.client, p.routed, {
      signal,
      firstEventTimeoutMs: this.rt.firstEventTimeoutMs,
      created: p.created,
      ...(p.routed.includeUsage !== undefined ? { includeUsage: p.routed.includeUsage } : {}),
      onOpen: this.onOpenFor(p.principal, p.meta),
      onBreakerState: this.onBreakerStateFor(p.meta),
      isCallerAbort: () => signal.aborted,
    });
    if (result.kind === 'error') {
      this.recorder.record(this.failedContext(p, result.failures), {
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
        this.recorder.record(
          this.servedFrom(
            p,
            c.cheap.meta,
            cheap.servedIndex,
            `cascade: cheap served`,
            score,
            cheap.failures,
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
        signal,
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
          'cascade: client disconnected during cheap attempt',
          null,
          cheap.failures,
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
          `cascade: cheap failed non-retryably (${cheap.error.kind})`,
          null,
          cheap.failures,
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
    return this.escalateBuffered(p, c, null, 0, signal); // cheap failed/timed out — escalate, score 0
  }

  private async escalateBuffered(
    p: Prepared,
    c: CascadeBundle,
    cheapServed: CheapServed | null,
    score: number | null,
    signal: AbortSignal,
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
    if (!result.ok) {
      const requestId = this.recorder.record(
        this.servedFrom(
          p,
          c.escalation.meta,
          0,
          `cascade: escalated, all failed`,
          score,
          result.failures,
        ),
        {
          status: result.callerAborted ? 'cancelled' : 'error',
          outputChars: 0,
          escalated: true,
          qualitySignal: score,
          error: recordedError(result.error),
        },
      );
      // The superseded cheap call was still billed — its ledger row must exist
      // even when every escalation member failed (§7.7, spend completeness).
      if (cheapServed !== null) this.recordCheapAttempt(p, c, requestId, cheapServed);
      if (!result.callerAborted) this.notifyFailed(p.principal); // client hang-up ≠ provider fault (A-3)
      throw toProxyError(result.error);
    }
    const requestId = this.recorder.record(
      this.servedFrom(
        p,
        c.escalation.meta,
        result.servedIndex,
        escalatedReason(c.escalation.meta, result.servedIndex),
        score,
        result.failures,
      ),
      {
        status: result.failures.length > 0 ? 'fallback' : 'success',
        ...(result.response.usage !== undefined ? { providerUsage: result.response.usage } : {}),
        outputChars: countOutputChars(result.response.content),
        escalated: true,
        qualitySignal: score,
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
          const ctx = this.servedFrom(
            p,
            c.cheap.meta,
            cheap.servedIndex,
            `cascade: cheap served`,
            score,
            cheap.failures,
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
      return this.escalateStream(p, c, cheapServed, score, signal);
    }
    if (cheap.callerAborted) {
      // Client disconnected during the cheap leg (pre-commit — no bytes sent). Record
      // one `cancelled` row (§7.5), no escalation, no notifyFailed (A-3/E5.2).
      this.recorder.record(
        this.servedFrom(
          p,
          c.cheap.meta,
          0,
          'cascade: client disconnected during cheap attempt',
          null,
          cheap.failures,
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
          `cascade: cheap failed non-retryably (${cheap.error.kind})`,
          null,
          cheap.failures,
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
    return this.escalateStream(p, c, null, 0, signal);
  }

  private async escalateStream(
    p: Prepared,
    c: CascadeBundle,
    cheapServed: CheapServed | null,
    score: number | null,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<string>> {
    const result = await openStreamChain(this.breaker, c.escalation.attempts, p.client, p.routed, {
      signal,
      firstEventTimeoutMs: this.rt.firstEventTimeoutMs,
      created: p.created,
      ...(p.routed.includeUsage !== undefined ? { includeUsage: p.routed.includeUsage } : {}),
      onOpen: this.onOpenFor(p.principal, c.escalation.meta),
      onBreakerState: this.onBreakerStateFor(c.escalation.meta),
      isCallerAbort: () => signal.aborted,
    });
    if (result.kind === 'error') {
      const requestId = this.recorder.record(
        this.servedFrom(
          p,
          c.escalation.meta,
          0,
          `cascade: escalated, all failed`,
          score,
          result.failures,
        ),
        {
          status: result.callerAborted ? 'cancelled' : 'error',
          outputChars: 0,
          escalated: true,
          qualitySignal: score,
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
      escalatedReason(c.escalation.meta, result.servedIndex),
      score,
      result.failures,
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
  private async effectiveAutoLayers(
    principal: Principal,
  ): Promise<{ structural: boolean; cascade: boolean }> {
    const cap = autoLayerCapability(this.routingConfig);
    // Cascade implies structural, so structural off instance-wide leaves nothing
    // for a preference to gate — skip the read entirely.
    if (!cap.structural) return cap;
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
      return computeEffectiveLayers(cap, pref); // A-45: shared formula (also used by AutoLayersService)
    } catch {
      return cap;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    if (ir.model === AUTO_ALIAS && decision.decisionLayer === 'default') {
      // Per-tenant opt-out (#20): the effective layers are the instance
      // capability masked by the tenant's preference. A disabled layer is
      // skipped; the Layer-0 default then stands (invariant 1).
      const layers = await this.effectiveAutoLayers(principal);
      if (layers.structural) {
        const evaln = await this.structural.evaluate(principal, agentId, ir, snapshot);
        if (evaln.kind === 'route')
          decision = evaln.decision; // Layer 1 confident band
        else if (evaln.kind === 'ambiguous' && layers.cascade) {
          cascadePlan = this.cascade.plan(snapshot); // Layer 3 candidate
        }
        // else: the Layer-0 default decision stands (invariant 1)
      }
    }

    const primary = await this.buildBundle(principal, decision, models, signal);

    let cascade: CascadeBundle | undefined;
    if (cascadePlan !== null) {
      const cheap = await this.buildBundle(principal, cascadePlan.cheap, models, signal);
      const strong = await this.buildBundle(principal, cascadePlan.strong, models, signal);
      // Escalation walks strong then the Layer-0 default (reliable-core rescue).
      if (cheap.attempts.length > 0 && strong.attempts.length + primary.attempts.length > 0) {
        cascade = {
          cheap,
          escalation: {
            attempts: [...strong.attempts, ...primary.attempts],
            meta: [...strong.meta, ...primary.meta],
          },
          cheapTimeoutMs: this.cascade.cheapTimeoutMs,
        };
      }
    }

    if (primary.attempts.length === 0 && cascade === undefined) {
      throw serviceUnavailable('no usable provider for the route');
    }

    return {
      client,
      protocol,
      routed: ir, // the model is retargeted per-attempt inside the walker
      structuredDemand: declaredStructuredOutput(ir),
      created: Math.floor(Date.now() / 1000),
      attempts: primary.attempts,
      meta: primary.meta,
      decision,
      startedAt,
      requestChars,
      principal,
      agentId,
      ...(cascade !== undefined ? { cascade } : {}),
    };
  }

  /** Resolve a decision's chain into lazy attempts + recording meta (owner-scoped
   * loads; adapters built lazily inside the breaker callback, #12). */
  private async buildBundle(
    principal: Principal,
    decision: RouteDecision,
    models: ModelRow[],
    signal: AbortSignal,
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
        },
      });
      attempts.push({
        providerId: t.providerId,
        externalModelId: t.externalModelId,
        buildAdapter: () => this.chainAdapter(principal, provider, signal),
      });
    }
    return { attempts, meta };
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
  ): Promise<ProviderAdapter> {
    let adapter: ProviderAdapter;
    try {
      adapter = await this.buildAdapter(principal, provider);
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
    return this.contextFor(p, servedIndex, failures);
  }

  /** Total-chain failure is recorded against the primary. */
  private failedContext(p: Prepared, failures: readonly AttemptFailure[]): RecordingContext {
    return this.contextFor(p, 0, failures);
  }

  private contextFor(
    p: Prepared,
    metaIndex: number,
    failures: readonly AttemptFailure[],
  ): RecordingContext {
    const m = p.meta[metaIndex]!;
    return {
      principal: p.principal,
      agentId: p.agentId,
      protocol: p.protocol,
      providerId: m.providerId,
      providerName: m.providerName,
      modelId: m.modelId,
      tierAssigned: p.decision.tierKey,
      decisionLayer: p.decision.decisionLayer,
      routingReason: reasonWithTrail(p.decision.routingReason, failures, p.meta),
      provider: { baseUrl: m.providerBaseUrl, kind: m.providerKind },
      model: m.model,
      startedAt: p.startedAt,
      requestChars: p.requestChars,
    };
  }

  /** A cascade recording context for `meta[servedIndex]` (per-member tier + price),
   * `decision_layer='cascade'`, with the score + fallback trail in the reason. */
  private servedFrom(
    p: Prepared,
    meta: readonly AttemptMeta[],
    servedIndex: number,
    baseReason: string,
    score: number | null,
    failures: readonly AttemptFailure[],
  ): RecordingContext {
    const reason = reasonWithTrail(`${baseReason} (q=${fmtQ(score)})`, failures, meta);
    return this.metaContext(p, meta[servedIndex]!, reason);
  }

  private metaContext(p: Prepared, m: AttemptMeta, reason: string): RecordingContext {
    return {
      principal: p.principal,
      agentId: p.agentId,
      protocol: p.protocol,
      providerId: m.providerId,
      providerName: m.providerName,
      modelId: m.modelId,
      tierAssigned: m.tierKey,
      decisionLayer: 'cascade',
      routingReason: reason,
      provider: { baseUrl: m.providerBaseUrl, kind: m.providerKind },
      model: m.model,
      startedAt: p.startedAt,
      requestChars: p.requestChars,
    };
  }

  private async loadSnapshot(
    principal: Principal,
  ): Promise<{ snapshot: RoutingSnapshot; models: ModelRow[] }> {
    const [tiers, rules, models] = await Promise.all([
      this.db.tiers.list(principal),
      this.db.routingRules.list(principal),
      this.db.models.listForPrincipal(principal),
    ]);
    const entriesByTierId = new Map<string, RouteEntry[]>();
    await Promise.all(
      tiers.map(async (t) => {
        const entries = await this.db.routingEntries.listForTier(principal, t.id);
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

  private async buildAdapter(
    principal: Principal,
    provider: ProviderRow,
  ): Promise<ProviderAdapter> {
    if (provider.baseUrl === null) throw serviceUnavailable('provider has no base_url');
    const kind = provider.kind as ProviderKind;
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
        defaultMaxOutputTokens: this.rt.defaultMaxOutputTokens,
        firstByteTimeoutMs: this.rt.firstByteTimeoutMs,
        idleTimeoutMs: this.rt.idleTimeoutMs,
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
      defaultMaxOutputTokens: this.rt.defaultMaxOutputTokens,
      firstByteTimeoutMs: this.rt.firstByteTimeoutMs,
      idleTimeoutMs: this.rt.idleTimeoutMs,
    });
  }
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

/** The routing reason plus a sanitized fallback trail (kind@model — no raw
 * messages) so #11 records why earlier chain members failed (§7.4). */
function reasonWithTrail(
  reason: string,
  failures: readonly AttemptFailure[],
  meta: readonly AttemptMeta[],
): string {
  if (failures.length === 0) return reason;
  const trail = failures
    .map((f) => `${f.error.kind}@${meta[f.index]?.model.externalModelId ?? '?'}`)
    .join(', ');
  return `${reason}; fell back after: ${trail}`;
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
