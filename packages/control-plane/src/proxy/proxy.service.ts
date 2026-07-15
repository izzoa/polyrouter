import { Inject, Injectable } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  SsrfError,
  assertUrlSafe,
  decryptSecret,
  type PersistencePort,
  type Principal,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  getAdapter,
  openStream,
  resolveRoute,
  runBuffered,
  isRouteError,
  type NormalizedRequest,
  type ProtocolAdapter,
  type ProviderAdapter,
  type ProviderKind,
  type ProviderProtocol,
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
  PROXY_RUNTIME,
  type ProxyAdapterFactory,
  type ProxyRuntime,
} from './proxy.config';

interface Prepared {
  adapter: ProviderAdapter;
  client: ProtocolAdapter;
  routed: NormalizedRequest;
  created: number;
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
  ) {
    this.key = rt.key;
    this.mode = rt.mode;
  }

  /** Non-streaming: returns the client-wire response body. */
  async completion(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
  ): Promise<unknown> {
    const { adapter, client, routed, created } = await this.prepare(
      principal,
      protocol,
      wireBody,
      headers,
    );
    try {
      return await runBuffered(adapter, client, routed, { created });
    } catch (err) {
      throw toProxyError(err);
    }
  }

  /** Streaming: returns the client-SSE frame generator (throws a mapped
   * ProxyError on a pre-commit failure, before any byte is written). */
  async stream(
    principal: Principal,
    protocol: ClientProtocol,
    wireBody: unknown,
    headers: NodeJS.Dict<string | string[]>,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<string>> {
    const { adapter, client, routed, created } = await this.prepare(
      principal,
      protocol,
      wireBody,
      headers,
    );
    const result = await openStream(adapter, client, routed, {
      signal,
      firstEventTimeoutMs: this.rt.firstByteTimeoutMs,
      created,
    });
    if (result.kind === 'error') throw providerErrorToProxy(result.error);
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
  ): Promise<Prepared> {
    const client = getAdapter(protocol);
    let ir: NormalizedRequest;
    try {
      ir = client.requestIn(wireBody);
    } catch {
      throw badRequest('invalid request body');
    }

    const snapshot = await this.loadSnapshot(principal);
    const decision = resolveRoute(snapshot, {
      modelField: ir.model,
      headers: normalizeHeaders(headers),
    });
    if (isRouteError(decision)) throw routeError(decision.error);

    const provider = await this.db.providers.findById(principal, decision.providerId);
    if (!provider) throw serviceUnavailable('routing target provider is unavailable');
    const adapter = await this.buildAdapter(provider);

    const routed: NormalizedRequest = { ...ir, model: decision.externalModelId };
    return { adapter, client, routed, created: Math.floor(Date.now() / 1000) };
  }

  private async loadSnapshot(principal: Principal): Promise<RoutingSnapshot> {
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
    return {
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

function normalizeHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
