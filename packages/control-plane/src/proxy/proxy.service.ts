import { Inject, Injectable } from '@nestjs/common';
import {
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
  resolveRoute,
  runBufferedChain,
  type AttemptFailure,
  type ChainAttempt,
  type CircuitBreaker,
  type ContentBlock,
  type NormalizedRequest,
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

/** Per-chain-member recording metadata (parallel to the attempts). */
interface AttemptMeta {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerBaseUrl: string | null;
  readonly providerKind: string;
  readonly model: Pick<
    ModelRow,
    'externalModelId' | 'inputPricePer1m' | 'outputPricePer1m' | 'isFree'
  >;
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
 * Layer-0 proxy orchestration (#10). Loads the tenant's owned config, resolves
 * the route (data-plane engine), decrypts the provider credential (#7), builds
 * the #6 adapter, and delegates the call/translation to `ProxyCore`. The
 * controllers own the HTTP pump; this owns everything up to it.
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
  ) {
    this.key = rt.key;
    this.mode = rt.mode;
  }

  /** Non-streaming: walk the fallback chain; return the served member's wire and
   * record it (#11/#12). `signal` aborts the walk on client disconnect. */
  async completion(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    agentId: string | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    const p = await this.prepare(principal, protocol, wireBody, headers, agentId);
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

  /** Streaming: walk the chain to the first committed member; record the served
   * member when the stream outcome settles (a post-commit error → `status=error`). */
  async stream(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    signal: AbortSignal,
    agentId: string | null,
  ): Promise<AsyncGenerator<string>> {
    const p = await this.prepare(principal, protocol, wireBody, headers, agentId);
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
    const decision = resolveRoute(snapshot, {
      modelField: ir.model,
      headers: normalizeHeaders(headers),
    });
    if (isRouteError(decision)) throw routeError(decision.error);

    // Build the attempt chain in the CONFIGURED order (no reorder). Provider/model
    // metadata is loaded now (ownership-scoped, cheap); the adapter is built lazily
    // INSIDE the breaker callback so an open/broken later member can't fail a
    // healthy primary and an open circuit skips before any setup work.
    const attempts: ChainAttempt[] = [];
    const meta: AttemptMeta[] = [];
    for (const t of decision.chain) {
      const provider = await this.db.providers.findById(principal, t.providerId);
      const model = models.find((m) => m.id === t.modelId);
      if (!provider || !model) continue;
      meta.push({
        providerId: t.providerId,
        modelId: t.modelId,
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
    if (attempts.length === 0) throw serviceUnavailable('no usable provider for the route');

    return {
      client,
      routed: ir, // the model is retargeted per-attempt inside the walker
      created: Math.floor(Date.now() / 1000),
      attempts,
      meta,
      decision,
      startedAt,
      requestChars,
      principal,
      agentId,
    };
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
