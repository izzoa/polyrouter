import { Inject, Injectable } from '@nestjs/common';
import {
  AUTO_ALIAS,
  PERSISTENCE_PORT,
  SsrfError,
  assertUrlSafe,
  decryptSecret,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  ProviderError,
  getAdapter,
  isRouteError,
  openStreamChain,
  replayBufferedStream,
  resolveRoute,
  runBufferedChain,
  type AttemptFailure,
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
import { RequestRecorder, type RecordingContext } from '../recording/request-recorder';
import { StructuralRouter } from './structural/structural-router';
import { CascadeRouter, type CascadePlan } from './cascade/cascade-router';

/** Per-chain-member recording metadata (parallel to the attempts). */
interface AttemptMeta {
  readonly providerId: string;
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
  routed: NormalizedRequest;
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
    private readonly recorder: RequestRecorder,
    private readonly structural: StructuralRouter,
    private readonly cascade: CascadeRouter,
  ) {
    this.key = rt.key;
    this.mode = rt.mode;
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
    const p = await this.prepare(principal, protocol, wireBody, headers, agentId);
    if (p.cascade !== undefined) return this.cascadeCompletion(p, p.cascade, signal);

    const result = await runBufferedChain(
      this.breaker,
      p.attempts,
      p.client,
      p.routed,
      { created: p.created },
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
      status: 'error',
      outputChars: 0,
    });
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
    const p = await this.prepare(principal, protocol, wireBody, headers, agentId);
    if (p.cascade !== undefined) return this.cascadeStream(p, p.cascade, signal);

    const result = await openStreamChain(this.breaker, p.attempts, p.client, p.routed, {
      signal,
      firstEventTimeoutMs: this.rt.firstByteTimeoutMs,
      created: p.created,
    });
    if (result.kind === 'error') {
      this.recorder.record(this.failedContext(p, result.failures), {
        status: 'error',
        outputChars: 0,
      });
      throw providerErrorToProxy(result.error);
    }
    const ctx = this.servedContext(p, result.servedIndex, result.failures);
    const fellBack = result.failures.length > 0;
    void result.outcome.then((o) =>
      this.recorder.record(ctx, {
        // Post-commit precedence: a committed stream that later fails is `error`.
        status: o.status === 'error' ? 'error' : fellBack ? 'fallback' : 'success',
        providerUsage: o.usage,
        outputChars: o.outputChars,
      }),
    );
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
      { created: p.created },
      AbortSignal.any([signal, AbortSignal.timeout(c.cheapTimeoutMs)]),
    );
    if (cheap.ok) {
      const { score, escalate } = this.cascade.shouldEscalate(cheap.response);
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
    if (signal.aborted) throw toProxyError(cheap.error); // client disconnected — do not escalate
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
      { created: p.created },
      signal,
    );
    if (!result.ok) {
      this.recorder.record(
        this.servedFrom(
          p,
          c.escalation.meta,
          0,
          `cascade: escalated, all failed`,
          score,
          result.failures,
        ),
        { status: 'error', outputChars: 0, escalated: true, qualitySignal: score },
      );
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
      { created: p.created },
      AbortSignal.any([signal, AbortSignal.timeout(c.cheapTimeoutMs)]),
    );
    if (cheap.ok) {
      const { score, escalate } = this.cascade.shouldEscalate(cheap.response);
      const cheapServed: CheapServed = { response: cheap.response, servedIndex: cheap.servedIndex };
      if (!escalate) {
        const replay = await replayBufferedStream(p.client, cheap.response, { created: p.created });
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
              status: o.status === 'error' ? 'error' : fellBack ? 'fallback' : 'success',
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
    if (signal.aborted) throw providerErrorToProxy(cheap.error);
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
      firstEventTimeoutMs: this.rt.firstByteTimeoutMs,
      created: p.created,
    });
    if (result.kind === 'error') {
      this.recorder.record(
        this.servedFrom(
          p,
          c.escalation.meta,
          0,
          `cascade: escalated, all failed`,
          score,
          result.failures,
        ),
        { status: 'error', outputChars: 0, escalated: true, qualitySignal: score },
      );
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
        status: o.status === 'error' ? 'error' : fellBack ? 'fallback' : 'success',
        providerUsage: o.usage,
        outputChars: o.outputChars,
        escalated: true,
        qualitySignal: score,
      });
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

  private async prepare(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    agentId: string | null,
  ): Promise<Prepared> {
    const startedAt = Date.now();
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
      const evaln = await this.structural.evaluate(principal, agentId, ir, snapshot);
      if (evaln.kind === 'route')
        decision = evaln.decision; // Layer 1 confident band
      else if (evaln.kind === 'ambiguous' && this.cascade.enabled) {
        cascadePlan = this.cascade.plan(snapshot); // Layer 3 candidate
      }
      // else: the Layer-0 default decision stands (invariant 1)
    }

    const primary = await this.buildBundle(principal, decision, models);

    let cascade: CascadeBundle | undefined;
    if (cascadePlan !== null) {
      const cheap = await this.buildBundle(principal, cascadePlan.cheap, models);
      const strong = await this.buildBundle(principal, cascadePlan.strong, models);
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
      routed: ir, // the model is retargeted per-attempt inside the walker
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
  ): Promise<Bundle> {
    const attempts: ChainAttempt[] = [];
    const meta: AttemptMeta[] = [];
    for (const t of decision.chain) {
      const provider = await this.db.providers.findById(principal, t.providerId);
      const model = models.find((m) => m.id === t.modelId);
      if (!provider || !model) continue;
      meta.push({
        providerId: t.providerId,
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
        buildAdapter: () => this.chainAdapter(provider),
      });
    }
    return { attempts, meta };
  }

  /** Build a chain member's adapter; a setup failure (SSRF/credential/decrypt)
   * becomes a classified, fallback-eligible ProviderError (skipped + trips the
   * breaker so it's skipped fast next time). */
  private async chainAdapter(provider: ProviderRow): Promise<ProviderAdapter> {
    try {
      return await this.buildAdapter(provider);
    } catch {
      throw new ProviderError('unavailable', 'provider setup failed');
    }
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
      providerId: m.providerId,
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
      providerId: m.providerId,
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

  private async buildAdapter(provider: ProviderRow): Promise<ProviderAdapter> {
    if (provider.baseUrl === null) throw serviceUnavailable('provider has no base_url');
    const kind = provider.kind as ProviderKind;
    try {
      await assertUrlSafe(provider.baseUrl, { context: { mode: this.mode, providerKind: kind } });
    } catch (err) {
      if (err instanceof SsrfError) throw serviceUnavailable('provider address rejected');
      throw err;
    }
    let credential = '';
    if (provider.encryptedCredentials !== null) {
      credential = decryptSecret(provider.encryptedCredentials, this.key);
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
    });
  }
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
