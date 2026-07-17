import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  SsrfError,
  assertUrlSafe,
  decryptSecret,
  encryptSecret,
  type ModelInsertInput,
  type ModelPatch,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderInsertInput,
  type ProviderPatch,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  MAX_MODEL_ID_LEN,
  ProviderError,
  createProviderAdapter,
  type ConnectionResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderKind,
  type ProviderProtocol,
  type ProviderModelInfo,
} from '@polyrouter/data-plane';
import type {
  CreateProviderDto,
  ListModelsQueryDto,
  UpdateModelPricingDto,
  UpdateProviderDto,
} from './providers.dto';

export type ProviderAdapterFactory = typeof createProviderAdapter;
export const PROVIDER_ADAPTER_FACTORY = 'polyrouter:provider-adapter-factory';

/** Write-time ingestion bounds for `sync-models` (E11.1). A `base_url` is
 * address-safe but its response is untrusted, so a single sync must not flood the
 * `models` table. Cap the row count and per-field lengths before upserting. The
 * id-length bound is shared with the data-plane parse guard (`MAX_MODEL_ID_LEN`),
 * which also skips over-long/duplicate ids before its own cap; this write-time skip
 * is defense-in-depth for any adapter path that bypasses `parseModelList`. */
const MAX_SYNCED_MODELS = 2_000;
const MAX_MODEL_NAME_LEN = 512;

/** Resolved config the service needs (encryption key + runtime mode). Provided
 * by the module via `loadProvidersConfig`; injected directly in unit tests. */
export interface ProvidersRuntime {
  readonly key: string;
  readonly mode: 'selfhosted' | 'cloud';
}
export const PROVIDERS_RUNTIME = 'polyrouter:providers-runtime';

export interface SafeProvider {
  id: string;
  name: string;
  kind: string;
  protocol: string;
  baseUrl: string | null;
  status: string;
  hasCredential: boolean;
  createdAt: Date;
}

export interface SafeModel {
  id: string;
  providerId: string;
  externalModelId: string;
  displayName: string | null;
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  isFree: boolean;
  // User-editable model-own prices (#18 §7.7) — null when unpriced; the top of
  // `resolveModelPrice`'s precedence for custom/local models.
  inputPricePer1m: number | null;
  outputPricePer1m: number | null;
  lastSyncedAt: Date | null;
}

/** Sanitized action result — a fixed public message keyed on `{kind,status}`
 * plus an INTERNAL traceId. Never the adapter's raw message, thrown error,
 * config, upstream request id, or credential. */
export interface ActionResult {
  ok: boolean;
  status: 'ok' | 'error';
  kind?: string;
  message: string;
  traceId: string;
  synced?: number;
}

const FIXED_MESSAGE: Record<string, string> = {
  auth: 'authentication failed',
  rate_limit: 'provider rate limited',
  unavailable: 'provider unavailable',
  bad_request: 'invalid request to provider',
  unknown_model: 'model not found',
};

function fixedMessage(kind: string): string {
  return FIXED_MESSAGE[kind] ?? 'provider error';
}

function toSafe(p: ProviderRow): SafeProvider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    status: p.status,
    hasCredential: p.encryptedCredentials !== null,
    createdAt: p.createdAt,
  };
}

function toSafeModel(m: ModelRow): SafeModel {
  return {
    id: m.id,
    providerId: m.providerId,
    externalModelId: m.externalModelId,
    displayName: m.displayName,
    contextWindow: m.contextWindow,
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    supportsReasoning: m.supportsReasoning,
    isFree: m.isFree,
    inputPricePer1m: m.inputPricePer1m,
    outputPricePer1m: m.outputPricePer1m,
    lastSyncedAt: m.lastSyncedAt,
  };
}

@Injectable()
export class ProvidersService {
  private readonly key: string;
  private readonly mode: 'selfhosted' | 'cloud';

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PROVIDER_ADAPTER_FACTORY) private readonly factory: ProviderAdapterFactory,
    @Inject(PROVIDERS_RUNTIME) runtime: ProvidersRuntime,
  ) {
    this.key = runtime.key;
    this.mode = runtime.mode;
  }

  async list(principal: Principal): Promise<SafeProvider[]> {
    return (await this.db.providers.list(principal)).map(toSafe);
  }

  async get(principal: Principal, id: string): Promise<SafeProvider> {
    const row = await this.db.providers.findById(principal, id);
    if (!row) throw new NotFoundException();
    return toSafe(row);
  }

  async create(principal: Principal, dto: CreateProviderDto): Promise<SafeProvider> {
    const baseUrl = await this.normalizeAndGateBaseUrl(dto.kind, dto.baseUrl);
    const values: ProviderInsertInput = {
      name: dto.name,
      kind: dto.kind,
      protocol: dto.protocol,
      baseUrl,
      ...(dto.credential !== undefined && dto.credential !== ''
        ? { encryptedCredentials: encryptSecret(dto.credential, this.key) }
        : {}),
    };
    return toSafe(await this.db.providers.insert(principal, values));
  }

  async update(principal: Principal, id: string, dto: UpdateProviderDto): Promise<SafeProvider> {
    const existing = await this.db.providers.findById(principal, id);
    if (!existing) throw new NotFoundException();

    const nextKind = (dto.kind ?? existing.kind) as ProviderKind;
    const nextBaseUrl = dto.baseUrl ?? existing.baseUrl;
    if (nextBaseUrl === null) {
      throw new UnprocessableEntityException('provider base_url is required');
    }
    const normalized = await this.normalizeAndGateBaseUrl(nextKind, nextBaseUrl);

    const patch: ProviderPatch = {
      baseUrl: normalized,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
      ...(dto.protocol !== undefined ? { protocol: dto.protocol } : {}),
      // Present-but-empty clears; omitted (undefined) preserves the envelope.
      ...(dto.credential !== undefined
        ? {
            encryptedCredentials:
              dto.credential === '' ? null : encryptSecret(dto.credential, this.key),
          }
        : {}),
    };
    const row = await this.db.providers.update(principal, id, patch);
    if (!row) throw new NotFoundException();
    // A model-own price left over from a custom/local kind would display for a now
    // catalog-priced provider (the resolver already ignores it — E5.4); clear it for
    // GET /api/models consistency when the kind leaves custom/local.
    const leftUserPriced =
      (existing.kind === 'custom' || existing.kind === 'local') &&
      (nextKind === 'api_key' || nextKind === 'subscription');
    if (leftUserPriced) await this.db.models.clearPricingForProvider(principal, id);
    return toSafe(row);
  }

  async remove(principal: Principal, id: string): Promise<{ deleted: boolean }> {
    // ON DELETE CASCADE removes the provider's models and their routing entries.
    const deleted = await this.db.providers.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    return { deleted };
  }

  async testConnection(principal: Principal, id: string): Promise<ActionResult> {
    const provider = await this.requireProvider(principal, id);
    const adapter = this.buildAdapter(provider);
    let result: ConnectionResult;
    try {
      result = await adapter.testConnection();
    } catch (err) {
      const sanitized = this.sanitizeThrow(err);
      await this.db.providers.update(principal, id, { status: 'error' });
      return sanitized;
    }
    const sanitized = this.sanitizeConnection(result);
    await this.db.providers.update(principal, id, { status: sanitized.ok ? 'ok' : 'error' });
    return sanitized;
  }

  async syncModels(principal: Principal, id: string): Promise<ActionResult> {
    const provider = await this.requireProvider(principal, id);
    const adapter = this.buildAdapter(provider);
    let models: ProviderModelInfo[];
    try {
      models = await adapter.listModels();
    } catch (err) {
      const sanitized = this.sanitizeThrow(err);
      await this.db.providers.update(principal, id, { status: 'error' });
      return sanitized;
    }
    const deduped = new Map<string, ProviderModelInfo>();
    for (const m of models) deduped.set(m.id, m);
    // Bound ingestion (E11.1): cap the number of upserts and skip/truncate over-long
    // fields before writing, so a pathological (but address-safe) response can't
    // flood the models table. Skip — not truncate — an over-long id: a truncated id
    // is a *wrong* id, and two distinct long ids could collide on (provider_id, id).
    // `attempts` bounds DB round-trips (a skipped id doesn't consume the budget).
    let synced = 0;
    let attempts = 0;
    for (const m of deduped.values()) {
      if (attempts >= MAX_SYNCED_MODELS) break;
      if (m.id.length > MAX_MODEL_ID_LEN) continue;
      attempts += 1;
      const displayName =
        m.displayName !== undefined ? m.displayName.slice(0, MAX_MODEL_NAME_LEN) : undefined;
      const values: ModelInsertInput = {
        externalModelId: m.id,
        lastSyncedAt: new Date(),
        ...(displayName !== undefined ? { displayName } : {}),
      };
      const row = await this.db.models.upsertForProvider(principal, provider.id, values);
      if (row) synced += 1;
    }
    await this.db.providers.update(principal, id, { status: 'ok' });
    return { ok: true, status: 'ok', message: 'catalog synced', traceId: randomUUID(), synced };
  }

  async listModels(principal: Principal, q: ListModelsQueryDto): Promise<SafeModel[]> {
    let rows = await this.db.models.listForPrincipal(principal);
    if (q.providerId !== undefined) rows = rows.filter((r) => r.providerId === q.providerId);
    if (q.isFree !== undefined) rows = rows.filter((r) => r.isFree === q.isFree);
    if (q.supportsTools !== undefined)
      rows = rows.filter((r) => r.supportsTools === q.supportsTools);
    if (q.supportsVision !== undefined) {
      rows = rows.filter((r) => r.supportsVision === q.supportsVision);
    }
    return rows.map(toSafeModel);
  }

  /**
   * Set a custom/local model's user-entered prices (#18 §7.7). Owner-scoped
   * (models owned through their provider — invariant 5). Rejects known-provider
   * kinds because model-own price is the top of `resolveModelPrice`'s precedence
   * and would otherwise bypass the bundled catalog. Validates the REQUEST SHAPE
   * (fields present in the body, not merged with the existing row): exactly one
   * of `{ isFree:true }` or `{ inputPricePer1m, outputPricePer1m }` (both
   * present). Editing the current price never rewrites historical cost — the
   * recorder snapshots prices at completion (invariant 4).
   */
  async updateModelPricing(
    principal: Principal,
    id: string,
    dto: UpdateModelPricingDto,
  ): Promise<SafeModel> {
    const model = await this.db.models.findById(principal, id);
    if (!model) throw new NotFoundException();
    const provider = await this.db.providers.findById(principal, model.providerId);
    if (!provider) throw new NotFoundException();
    if (provider.kind !== 'custom' && provider.kind !== 'local') {
      throw new UnprocessableEntityException(
        'prices can only be set for custom or local models; known-provider prices come from the catalog',
      );
    }
    const hasInput = dto.inputPricePer1m !== undefined;
    const hasOutput = dto.outputPricePer1m !== undefined;
    let patch: ModelPatch;
    if (dto.isFree === true && !hasInput && !hasOutput) {
      patch = { inputPricePer1m: 0, outputPricePer1m: 0, isFree: true };
    } else if (hasInput && hasOutput && dto.isFree === undefined) {
      patch = {
        inputPricePer1m: dto.inputPricePer1m,
        outputPricePer1m: dto.outputPricePer1m,
        isFree: false,
      };
    } else {
      throw new UnprocessableEntityException(
        'provide exactly one of { isFree: true } or both { inputPricePer1m, outputPricePer1m }',
      );
    }
    const updated = await this.db.models.update(principal, id, patch);
    if (!updated) throw new NotFoundException();
    return toSafeModel(updated);
  }

  // --- internals ---

  private async requireProvider(principal: Principal, id: string): Promise<ProviderRow> {
    const provider = await this.db.providers.findById(principal, id);
    if (!provider) throw new NotFoundException();
    if (provider.baseUrl === null) {
      throw new UnprocessableEntityException('provider base_url is required');
    }
    // Re-gate the stored base_url before any outbound action (defense in depth).
    await this.normalizeAndGateBaseUrl(provider.kind as ProviderKind, provider.baseUrl);
    return provider;
  }

  private buildAdapter(provider: ProviderRow): ProviderAdapter {
    return this.factory(this.buildAdapterConfig(provider));
  }

  private buildAdapterConfig(provider: ProviderRow): ProviderConfig {
    if (provider.baseUrl === null) {
      throw new UnprocessableEntityException('provider base_url is required');
    }
    const kind = provider.kind as ProviderKind;
    let credential = '';
    if (provider.encryptedCredentials !== null) {
      credential = decryptSecret(provider.encryptedCredentials, this.key);
    } else if (kind !== 'local') {
      throw new UnprocessableEntityException('provider has no credential');
    }
    return {
      protocol: provider.protocol as ProviderProtocol,
      baseUrl: provider.baseUrl,
      credential,
      kind,
      mode: this.mode,
      defaultMaxOutputTokens: 4096,
    };
  }

  /** Reject userinfo/query/fragment, SSRF-gate the address with the per-kind
   * context, reject local outside self-host, and return the normalized URL. */
  private async normalizeAndGateBaseUrl(kind: ProviderKind, baseUrl: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new UnprocessableEntityException('invalid base_url');
    }
    if (url.username !== '' || url.password !== '') {
      throw new UnprocessableEntityException('base_url must not contain embedded credentials');
    }
    if (url.search !== '' || url.hash !== '') {
      throw new UnprocessableEntityException('base_url must not contain a query or fragment');
    }
    if (kind === 'local' && this.mode !== 'selfhosted') {
      throw new UnprocessableEntityException('local providers require MODE=selfhosted');
    }
    try {
      await assertUrlSafe(url.href, { context: { mode: this.mode, providerKind: kind } });
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new UnprocessableEntityException('base_url failed SSRF validation');
      }
      throw err;
    }
    return url.href;
  }

  private sanitizeConnection(result: ConnectionResult): ActionResult {
    if (result.ok) {
      return { ok: true, status: 'ok', message: 'connection ok', traceId: randomUUID() };
    }
    return {
      ok: false,
      status: 'error',
      kind: result.kind,
      message: fixedMessage(result.kind),
      traceId: randomUUID(),
    };
  }

  private sanitizeThrow(err: unknown): ActionResult {
    const kind = err instanceof ProviderError ? err.kind : 'unavailable';
    return {
      ok: false,
      status: 'error',
      kind,
      message: fixedMessage(kind),
      traceId: randomUUID(),
    };
  }
}
