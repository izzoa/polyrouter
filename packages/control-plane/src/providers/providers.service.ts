import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
  SsrfError,
  assertUrlSafe,
  credentialLockKey,
  decryptSecret,
  deriveModelKey,
  deriveNativeFamilyKey,
  encryptSecret,
  resolveModelPrice,
  resolvePlainCredentialValue,
  serializePlainCredential,
  type ModelInsertInput,
  type ModelPatch,
  type ModelPriceRow,
  type PersistenceFacilities,
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
  type ProviderListedPricing,
} from '@polyrouter/data-plane';
import type {
  CreateProviderDto,
  ListModelsQueryDto,
  MaxTokensSpelling,
  UpdateModelPricingDto,
  UpdateProviderDto,
} from './providers.dto';
import { providerMaxTokensQuirks } from './providers.dto';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';

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
  /** Outbound token-cap spelling (add-max-tokens-spelling): `auto` (kind-derived) or
   * the literal OpenAI wire field. Meaningful only for `openai_compatible` providers. */
  maxTokensSpelling: MaxTokensSpelling;
  hasCredential: boolean;
  // Subscription-OAuth display/state metadata (add-subscription-oauth) — NON-SECRET;
  // never token material. `credentialError` is the durable 'reauthorize_required' state.
  oauthPreset: string | null;
  credentialExpiresAt: Date | null;
  credentialError: string | null;
  /** Upstream patience overrides (fix-long-call-timeouts); null = inherit. */
  firstByteTimeoutMs: number | null;
  idleTimeoutMs: number | null;
  createdAt: Date;
}

/** The provenance of an `EffectivePrice` — the billing-resolver sources plus the
 * display-only `listed` estimate (add-provider-price-sync-and-edit). */
export type EffectivePriceSource =
  | 'model'
  | 'local'
  | 'bundled'
  | 'refresh'
  | 'manual'
  | 'native_family'
  | 'listed';

/** A model's current effective price for DISPLAY (add-provider-price-sync-and-edit).
 * Resolved read-time: the pure billing resolver first, then the per-provider `listed`
 * estimate ONLY when billing is unknown. `estimated` is true only for the `listed`
 * fallback. This is never a billing/cost value — historical RequestLog cost is the
 * request-time snapshot and is unaffected (invariant 4). */
export interface EffectivePrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
  isFree: boolean;
  source: EffectivePriceSource;
  estimated: boolean;
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
  // The current effective price for display (billing resolver → listed estimate →
  // null), resolved on every path that returns a SafeModel. Display only.
  effectivePrice: EffectivePrice | null;
  /** The captured provider-listed channel estimate, ALWAYS exposed when captured
   * (add-native-price-fallback) — so the UI can show the channel's own figure
   * alongside a `native_family` recorded-cost estimate. Display only, never a
   * billing source. */
  listedPrice: {
    inputPricePer1m: number;
    outputPricePer1m: number;
    isFree: boolean;
    capturedAt: Date | null;
  } | null;
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
  // Count of models for which a provider-listed DISPLAY estimate was stored this sync
  // (add-provider-price-sync-and-edit). Display only — never billing.
  pricesCaptured?: number;
}

const FIXED_MESSAGE: Record<string, string> = {
  auth: 'authentication failed',
  // add-subscription-oauth: a credential-resolution failure (revoked OAuth grant /
  // identity-provider outage) — surfaced distinctly so the dashboard can offer
  // reauthorize instead of a generic provider error.
  credential: 'credential needs reauthorization',
  rate_limit: 'provider rate limited',
  unavailable: 'provider unavailable',
  bad_request: 'invalid request to provider',
  unknown_model: 'model not found',
};

function fixedMessage(kind: string): string {
  return FIXED_MESSAGE[kind] ?? 'provider error';
}

export function toSafe(p: ProviderRow): SafeProvider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    status: p.status,
    maxTokensSpelling: p.maxTokensSpelling as MaxTokensSpelling,
    hasCredential: p.encryptedCredentials !== null,
    oauthPreset: p.oauthPreset,
    credentialExpiresAt: p.credentialExpiresAt,
    credentialError: p.credentialError,
    firstByteTimeoutMs: p.firstByteTimeoutMs,
    idleTimeoutMs: p.idleTimeoutMs,
    createdAt: p.createdAt,
  };
}

/** Map an adapter-surfaced listed price to the model row's `listed_*` DISPLAY-estimate
 * columns (add-provider-price-sync-and-edit). Returns explicit nulls when there is no
 * price, so the sync upsert **clears** any stale estimate (present-with-null). Never the
 * billing user-price columns. */
function listedColumnsFrom(
  pricing: ProviderListedPricing | undefined,
  now: Date,
): Pick<
  ModelInsertInput,
  'listedInputPricePer1m' | 'listedOutputPricePer1m' | 'listedIsFree' | 'listedPriceCapturedAt'
> {
  if (pricing === undefined) {
    return {
      listedInputPricePer1m: null,
      listedOutputPricePer1m: null,
      listedIsFree: null,
      listedPriceCapturedAt: null,
    };
  }
  return {
    listedInputPricePer1m: pricing.inputPricePer1m,
    listedOutputPricePer1m: pricing.outputPricePer1m,
    listedIsFree: pricing.isFree ?? false,
    listedPriceCapturedAt: now,
  };
}

/** Resolve a model's effective DISPLAY price (add-provider-price-sync-and-edit): the pure
 * billing resolver first (model-own for custom/local → local-free → catalog), and ONLY when
 * that is unknown, the per-provider `listed` estimate (flagged `estimated`). Display only —
 * this never recomputes historical cost (invariant 4). The caller supplies the catalog row
 * it already resolved for the model's derived key. */
function toEffectivePrice(
  model: ModelRow,
  providerKind: string,
  catalogRow: ModelPriceRow | null,
  nativeCatalogRow: ModelPriceRow | null = null,
): EffectivePrice | null {
  const snap = resolveModelPrice(
    {
      providerKind,
      modelInputPricePer1m: model.inputPricePer1m,
      modelOutputPricePer1m: model.outputPricePer1m,
      modelIsFree: model.isFree,
    },
    catalogRow,
    nativeCatalogRow,
  );
  if (snap !== null) {
    return {
      inputPricePer1m: snap.inputPricePer1m,
      outputPricePer1m: snap.outputPricePer1m,
      isFree: snap.isFree,
      source: snap.source,
      // The native-family fallback is an adjacent channel's rate — an estimate.
      estimated: snap.source === 'native_family',
    };
  }
  // Billing unknown → fall back to the per-provider listed estimate (display only).
  if (model.listedInputPricePer1m !== null && model.listedOutputPricePer1m !== null) {
    return {
      inputPricePer1m: model.listedInputPricePer1m,
      outputPricePer1m: model.listedOutputPricePer1m,
      isFree: model.listedIsFree ?? false,
      source: 'listed',
      estimated: true,
    };
  }
  return null;
}

function toSafeModel(m: ModelRow, effectivePrice: EffectivePrice | null = null): SafeModel {
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
    effectivePrice,
    listedPrice:
      m.listedInputPricePer1m !== null && m.listedOutputPricePer1m !== null
        ? {
            inputPricePer1m: m.listedInputPricePer1m,
            outputPricePer1m: m.listedOutputPricePer1m,
            isFree: m.listedIsFree ?? false,
            capturedAt: m.listedPriceCapturedAt,
          }
        : null,
    lastSyncedAt: m.lastSyncedAt,
  };
}

@Injectable()
export class ProvidersService {
  private readonly key: string;
  private readonly mode: 'selfhosted' | 'cloud';

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_FACILITIES) private readonly facilities: PersistenceFacilities,
    @Inject(PROVIDER_ADAPTER_FACTORY) private readonly factory: ProviderAdapterFactory,
    @Inject(PROVIDERS_RUNTIME) runtime: ProvidersRuntime,
    private readonly oauth: SubscriptionOauthService,
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
      // Every NEW write stores the typed envelope; plain input is WRAPPED so a pasted
      // marker-lookalike can never forge an OAuth credential (add-subscription-oauth).
      ...(dto.credential !== undefined && dto.credential !== ''
        ? { encryptedCredentials: encryptSecret(serializePlainCredential(dto.credential), this.key) }
        : {}),
      ...(dto.firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs: dto.firstByteTimeoutMs } : {}),
      ...(dto.idleTimeoutMs !== undefined ? { idleTimeoutMs: dto.idleTimeoutMs } : {}),
      // Mapped by hand (like every field here) — omit to take the schema `auto` default.
      ...(dto.maxTokensSpelling !== undefined ? { maxTokensSpelling: dto.maxTokensSpelling } : {}),
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

    // The Responses protocol runs ONLY on its OAuth envelope (the account id lives
    // there) — a pasted credential can never work, and the SO-1 conversion path would
    // clear `oauth_preset` and leave a row that cannot be reauthorized (wedged). So
    // credential rotate/clear is rejected outright on these rows: Reauthorize renews;
    // delete + reconnect starts over (add-chatgpt-responses, r3 finding 3).
    if (existing.protocol === 'openai_responses' && dto.credential !== undefined) {
      throw new UnprocessableEntityException(
        'this provider works only with its OAuth sign-in — reauthorize it, or delete it and reconnect',
      );
    }
    // OAuth coherence (add-subscription-oauth): while the OAuth envelope is retained,
    // the preset-pinned endpoint/kind must not drift from the token's issuer — reject
    // base_url/protocol/kind changes (name-only edits fine). Supplying a credential
    // (rotate or clear) converts the provider to an ordinary pasted-credential one, so
    // the OAuth metadata is cleared in the same write (it never outlives the envelope).
    const isOauthConnected = existing.oauthPreset !== null;
    if (isOauthConnected && dto.credential === undefined) {
      const drifts =
        normalized !== existing.baseUrl ||
        (dto.protocol !== undefined && dto.protocol !== existing.protocol) ||
        (dto.kind !== undefined && dto.kind !== existing.kind);
      if (drifts) {
        throw new UnprocessableEntityException(
          'this provider is OAuth-connected; reauthorize it or remove the stored credential before changing its endpoint, protocol, or kind',
        );
      }
    }

    const patch: ProviderPatch = {
      baseUrl: normalized,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
      ...(dto.protocol !== undefined ? { protocol: dto.protocol } : {}),
      // Timeout overrides (fix-long-call-timeouts): explicit null clears to
      // inherit; omitted preserves.
      ...(dto.firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs: dto.firstByteTimeoutMs } : {}),
      ...(dto.idleTimeoutMs !== undefined ? { idleTimeoutMs: dto.idleTimeoutMs } : {}),
      // Omitted preserves the stored value (an explicit null was already rejected at the DTO).
      ...(dto.maxTokensSpelling !== undefined ? { maxTokensSpelling: dto.maxTokensSpelling } : {}),
      // Present-but-empty clears; omitted (undefined) preserves the envelope. New
      // plain values are WRAPPED in the typed envelope (forgery-proof by construction).
      ...(dto.credential !== undefined
        ? {
            encryptedCredentials:
              dto.credential === ''
                ? null
                : encryptSecret(serializePlainCredential(dto.credential), this.key),
            ...(isOauthConnected
              ? { oauthPreset: null, credentialExpiresAt: null, credentialError: null }
              : {}),
          }
        : {}),
    };
    // A credential mutation on an OAuth provider serializes on the same per-provider
    // lock as refresh/reauthorize, so an in-flight refresh's conditional write can
    // never clobber or resurrect this mutation.
    const row =
      isOauthConnected && dto.credential !== undefined
        ? await this.facilities.withAdvisoryLock(credentialLockKey(id), (tx) =>
            tx.providers.update(principal, id, patch),
          )
        : await this.db.providers.update(principal, id, patch);
    if (!row) throw new NotFoundException();
    // A model-own price left over from a custom/local kind would display for a now
    // catalog-priced provider (the resolver already ignores it — E5.4); clear it for
    // GET /api/models consistency when the kind leaves custom/local.
    const leftUserPriced =
      (existing.kind === 'custom' || existing.kind === 'local') &&
      (nextKind === 'api_key' || nextKind === 'subscription');
    if (leftUserPriced) await this.db.models.clearPricingForProvider(principal, id);
    // A provider-listed DISPLAY estimate captured from the PRIOR endpoint must not linger
    // after a base_url/protocol change (add-provider-price-sync-and-edit); the next sync
    // repopulates it. Compare the normalized new base_url to the stored one.
    const endpointChanged =
      normalized !== existing.baseUrl ||
      (dto.protocol !== undefined && dto.protocol !== existing.protocol);
    if (endpointChanged) await this.db.models.clearListedPricingForProvider(principal, id);
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
    const bundledPreset = this.bundledPresetFor(provider);
    let result: ConnectionResult;
    try {
      // buildAdapter is inside the sanitize-try: a credential-resolution failure
      // (e.g. reauthorize_required — add-subscription-oauth) must surface as a
      // sanitized action result, not an unhandled 500.
      const adapter = await this.buildAdapter(principal, provider);
      if (bundledPreset !== undefined) {
        // Bundled model sourcing (add-subscription-oauth): the models endpoint is not
        // available under this preset, so the DESIGNATED validating call is a minimal
        // 1-token chat probe — an invalid/revoked credential still surfaces as a typed
        // auth failure and is never masked by the bundled list.
        await adapter.chat({
          model: bundledPreset.bundledModels?.[0] ?? 'probe',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          params: { maxOutputTokens: 1 },
        });
        result = { ok: true, models: bundledPreset.bundledModels?.length ?? 0 };
      } else {
        result = await adapter.testConnection();
      }
    } catch (err) {
      // The 422 client contract (e.g. missing credential) stays a thrown 422 — only
      // adapter/credential-resolution failures become sanitized action results.
      if (err instanceof UnprocessableEntityException) throw err;
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
    const bundledPreset = this.bundledPresetFor(provider);
    let models: ProviderModelInfo[];
    try {
      if (bundledPreset !== undefined) {
        // Bundled model sourcing: seed the preset's list (preset-sourced, no network) —
        // the credential itself is validated by test-connection's designated probe.
        models = (bundledPreset.bundledModels ?? []).map((m) => ({ id: m }));
      } else {
        const adapter = await this.buildAdapter(principal, provider);
        models = await adapter.listModels();
      }
    } catch (err) {
      if (err instanceof UnprocessableEntityException) throw err; // 422 contract

      const sanitized = this.sanitizeThrow(err);
      await this.db.providers.update(principal, id, { status: 'error' });
      return sanitized;
    }
    const deduped = new Map<string, ProviderModelInfo>();
    for (const m of models) deduped.set(m.id, m);
    // A concurrent edit could have changed the endpoint while `listModels()` was in
    // flight; a listed price captured from the OLD endpoint must not be persisted for the
    // new one. Re-read and, if base_url/protocol moved, treat the response as priceless
    // (still sync the model rows; the next sync against the new endpoint repopulates). This
    // narrows the race to the tiny window between this read and the write; the estimate is
    // display-only and self-heals, so a residual is harmless.
    const current = await this.db.providers.findById(principal, id);
    const endpointMoved =
      current === null ||
      current.baseUrl !== provider.baseUrl ||
      current.protocol !== provider.protocol;
    // Bound ingestion (E11.1): cap the number of upserts and skip/truncate over-long
    // fields before writing, so a pathological (but address-safe) response can't
    // flood the models table. Skip — not truncate — an over-long id: a truncated id
    // is a *wrong* id, and two distinct long ids could collide on (provider_id, id).
    // `attempts` bounds DB round-trips (a skipped id doesn't consume the budget).
    let synced = 0;
    let pricesCaptured = 0;
    let attempts = 0;
    const now = new Date();
    for (const m of deduped.values()) {
      if (attempts >= MAX_SYNCED_MODELS) break;
      if (m.id.length > MAX_MODEL_ID_LEN) continue;
      attempts += 1;
      const displayName =
        m.displayName !== undefined ? m.displayName.slice(0, MAX_MODEL_NAME_LEN) : undefined;
      const pricing = endpointMoved ? undefined : m.pricing;
      // Always write the listed_* columns (set from the listed price, or null to CLEAR a
      // stale estimate) — a DISPLAY-only estimate, distinct from the billing user-price
      // columns, never a catalog/cost source (invariant 4).
      const values: ModelInsertInput = {
        externalModelId: m.id,
        lastSyncedAt: now,
        ...(displayName !== undefined ? { displayName } : {}),
        ...listedColumnsFrom(pricing, now),
      };
      const row = await this.db.models.upsertForProvider(principal, provider.id, values);
      if (row) {
        synced += 1;
        if (pricing !== undefined) pricesCaptured += 1;
      }
    }
    await this.db.providers.update(principal, id, { status: 'ok' });
    return {
      ok: true,
      status: 'ok',
      message: 'catalog synced',
      traceId: randomUUID(),
      synced,
      pricesCaptured,
    };
  }

  async listModels(principal: Principal, q: ListModelsQueryDto): Promise<SafeModel[]> {
    let rows = await this.db.models.listForPrincipal(principal);
    if (q.providerId !== undefined) rows = rows.filter((r) => r.providerId === q.providerId);
    if (q.supportsTools !== undefined)
      rows = rows.filter((r) => r.supportsTools === q.supportsTools);
    if (q.supportsVision !== undefined) {
      rows = rows.filter((r) => r.supportsVision === q.supportsVision);
    }
    // Resolve each model's effective DISPLAY price. Need the owning provider (kind +
    // base_url) and the catalog version in effect now. One providers read + ONE
    // key-filtered catalog read (priceAtMany) — never per-model queries or a full scan.
    const providers = await this.db.providers.list(principal);
    const provById = new Map(providers.map((p) => [p.id, p]));
    const keyByModel = new Map<string, string>();
    const nativeKeyByModel = new Map<string, string>();
    const keys = new Set<string>();
    for (const r of rows) {
      const prov = provById.get(r.providerId);
      if (prov === undefined || prov.baseUrl === null) continue;
      const key = deriveModelKey(prov.baseUrl, r.externalModelId);
      if (key !== null) {
        keyByModel.set(r.id, key);
        keys.add(key);
        // Native-family fallback keys ride the SAME batch (derived up front — no
        // follow-up query per exact-key miss; add-native-price-fallback).
        const nativeKey = deriveNativeFamilyKey(
          key.slice(0, key.indexOf(':')),
          r.externalModelId,
        );
        if (nativeKey !== null) {
          nativeKeyByModel.set(r.id, nativeKey);
          keys.add(nativeKey);
        }
      }
    }
    const catalog = await this.db.pricing.priceAtMany([...keys], new Date());
    const catByKey = new Map(catalog.map((c) => [c.modelKey, c]));
    let safe = rows.map((r) => {
      const kind = provById.get(r.providerId)?.kind ?? 'custom';
      const key = keyByModel.get(r.id);
      const nativeKey = nativeKeyByModel.get(r.id);
      const catalogRow = key !== undefined ? (catByKey.get(key) ?? null) : null;
      const nativeRow = nativeKey !== undefined ? (catByKey.get(nativeKey) ?? null) : null;
      return toSafeModel(r, toEffectivePrice(r, kind, catalogRow, nativeRow));
    });
    // The is_free filter applies to the EFFECTIVE price (resolve, then filter), so a
    // catalog-less free-by-listing model still matches (add-provider-price-sync-and-edit).
    if (q.isFree !== undefined) {
      safe = safe.filter((m) => (m.effectivePrice?.isFree ?? false) === q.isFree);
    }
    return safe;
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
    // Resolve effectivePrice on this path too — the client optimistically replaces its
    // model from this response, so it must carry a consistent effective price (no refetch).
    const key =
      provider.baseUrl !== null ? deriveModelKey(provider.baseUrl, updated.externalModelId) : null;
    const now = new Date();
    const catalogRow = key !== null ? await this.db.pricing.priceAt(key, now) : null;
    let nativeRow = null;
    if (key !== null && catalogRow === null) {
      const nativeKey = deriveNativeFamilyKey(
        key.slice(0, key.indexOf(':')),
        updated.externalModelId,
      );
      if (nativeKey !== null) nativeRow = await this.db.pricing.priceAt(nativeKey, now);
    }
    return toSafeModel(updated, toEffectivePrice(updated, provider.kind, catalogRow, nativeRow));
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

  /** The provider's OAuth preset when it declares bundled model sourcing. */
  private bundledPresetFor(provider: ProviderRow) {
    const preset = this.oauth.presetFor(provider);
    return preset !== undefined && preset.modelsSource === 'bundled' ? preset : undefined;
  }

  private async buildAdapter(
    principal: Principal,
    provider: ProviderRow,
  ): Promise<ProviderAdapter> {
    return this.factory(await this.buildAdapterConfig(principal, provider));
  }

  private async buildAdapterConfig(
    principal: Principal,
    provider: ProviderRow,
  ): Promise<ProviderConfig> {
    if (provider.baseUrl === null) {
      throw new UnprocessableEntityException('provider base_url is required');
    }
    const kind = provider.kind as ProviderKind;
    // Resolve the per-provider outbound token-cap spelling to the data-plane quirk
    // (add-max-tokens-spelling) — the SAME helper the proxy hot path uses, so both
    // paths agree. Inert (undefined) for non-`openai_compatible` protocols.
    const quirks = providerMaxTokensQuirks(
      provider.protocol,
      kind,
      provider.maxTokensSpelling as MaxTokensSpelling,
    );
    // Subscription providers resolve through the subscription-oauth seam: a plain
    // paste unwraps; an OAuth envelope refreshes pre-request and supplies
    // authScheme/oauthBeta — so test-connection exercises the REAL token path.
    if (kind === 'subscription' && provider.encryptedCredentials !== null) {
      const r = await this.oauth.resolveCredential(principal, provider);
      return {
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
        defaultMaxOutputTokens: 4096,
      };
    }
    let credential = '';
    if (provider.encryptedCredentials !== null) {
      // Plain path only: unwraps the typed envelope (legacy raw strings pass through).
      // OAuth envelopes never reach here — subscription providers resolve through the
      // subscription-oauth seam (which refreshes and supplies authScheme/oauthBeta).
      credential = resolvePlainCredentialValue(
        decryptSecret(provider.encryptedCredentials, this.key),
      );
    } else if (kind !== 'local') {
      throw new UnprocessableEntityException('provider has no credential');
    }
    return {
      protocol: provider.protocol as ProviderProtocol,
      baseUrl: provider.baseUrl,
      credential,
      kind,
      mode: this.mode,
      ...(quirks !== undefined ? { quirks } : {}),
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
