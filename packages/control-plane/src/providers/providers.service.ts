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
  deriveModelKey,
  deriveNativeFamilyKey,
  deriveProviderFamily,
  modelBatchCapable,
  encryptSecret,
  parseModelVariant,
  serializePlainCredential,
  variantForProvider,
  type ModelInsertInput,
  type ModelPatch,
  type PersistenceFacilities,
  type ModelRow,
  type PersistencePort,
  type Principal,
  type ProviderInsertInput,
  type ProviderPatch,
  type ProviderIncarnation,
  type ProviderRow,
} from '@polyrouter/shared/server';
import {
  loadPriceContext,
  toEffectiveCapabilities,
  toEffectivePrice,
  type EffectiveCapabilities,
  type EffectivePrice,
  type ListedCapabilityClaim,
} from '../pricing/model-price-context';
import {
  displayedProviderHealth,
  incarnationOf,
  recordProviderHealth,
  type DisplayedHealth,
} from './provider-health';
import {
  MAX_MODEL_ID_LEN,
  ProviderError,
  createProviderAdapter,
  type ConnectionResult,
  type ProviderAdapter,
  type ProviderKind,
  type ProviderModelInfo,
  type ProviderListedPricing,
  type ProviderModelCapabilities,
  batchFactoryFor,
  type BatchSeamInput,
} from '@polyrouter/data-plane';
import type {
  CreateProviderDto,
  ListModelsQueryDto,
  MaxTokensSpelling,
  UpdateModelPricingDto,
  UpdateProviderDto,
} from './providers.dto';
import {
  AdapterBuildError,
  ProviderAdapterBuilder,
  type BuiltAdapterConfig,
} from './adapter-builder';
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

/** An adapter plus the incarnation (credential envelope + endpoint) it was built
 * against — the guard every health write from a management action carries. */
interface BuiltAdapter {
  readonly adapter: ProviderAdapter;
  readonly incarnation: ProviderIncarnation;
}

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
  /** add-provider-health-signals: the DISPLAYED health — whichever of the check
   * and traffic records was recorded last (computed here, never re-derived by the
   * dashboard). `message` is a fixed operator label, never an upstream message. */
  health: SafeProviderHealth;
  // The two raw records (non-secret). The ordering sequence and the revisions are
  // internal and never exposed.
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  statusSource: string | null;
  statusChangedAt: Date | null;
  trafficState: string | null;
  trafficErrorKind: string | null;
  trafficErrorMessage: string | null;
  trafficAt: Date | null;
}

export interface SafeProviderHealth {
  state: DisplayedHealth['state'];
  kind: string | null;
  message: string | null;
  source: DisplayedHealth['source'];
  at: Date | null;
}

// Effective-price types + resolution live in `pricing/model-price-context` so this
// projection and the proxy's `/v1/models` cannot report different prices for one
// model (expand-models-listing). Re-exported here for existing importers.
export type { EffectivePrice, EffectivePriceSource } from '../pricing/model-price-context';

export interface SafeModel {
  id: string;
  providerId: string;
  externalModelId: string;
  displayName: string | null;
  /** Resolved through the SHARED capability ladder (honest-model-capabilities),
   * not read from the model row — the row's capability columns had no writer at
   * all, so reading them reported the column default as though it were an answer.
   * Tri-state: `true`, `false`, or ABSENT = unknown. */
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  /** Set only when a capability value resolved BELOW the exact catalog key. */
  capabilitiesEstimated?: boolean;
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
  /** Derived aggregator SKU variant (add-model-variant-detection); null = none.
   * `batch` marks a model that prices an async batch tier and cannot serve a
   * synchronous request. */
  variant: string | null;
  /** For a variant row, the SAME provider's model this one prices — null when the
   * variant's base id is not present on that provider (an orphan twin), so a
   * client is never pointed at a model that is not there. */
  baseExternalModelId: string | null;
  /** Whether this model's PROVIDER carries the batch adapter seam, so a chain
   * entry naming it may be reserved for batch (add-batch-mode-routing). Derived
   * server-side from the provider's `kind`, base-URL family, and protocol through
   * the same predicate the batch path uses — never re-derived in the SPA, where a
   * second copy of `deriveProviderFamily` would drift from the price-key
   * derivation it was extracted to keep aligned.
   *
   * REQUIRED, not optional: a producer that omitted it would leave the dashboard
   * unable to tell "not capable" from "not stated", and it gates a control whose
   * absence must be trustworthy. Deliberately NOT on the routing snapshot — that
   * is loaded per synchronous request and does not read providers (invariant 9). */
  batchCapable: boolean;
  /** That model's price resolved in BATCH mode (add-batch-mode-help), in the same
   * shape as `effectivePrice` and flagged `estimated` on the same terms, or null
   * when no batch price resolves from any source. Null is a state to report, never
   * a reason to substitute the synchronous price. */
  batchEffectivePrice: EffectivePrice | null;
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
  // fix-4xx-error-taxonomy. This map is `Record<string, …>` with a default, so a
  // missing entry degrades silently rather than failing the build — the exhaustive
  // test over PROVIDER_ERROR_KINDS is what keeps it complete.
  permission: 'permission denied for this model or region',
  insufficient_funds: 'provider account has insufficient credit',
  content_policy: 'provider refused on content policy',
  policy_block: 'provider denied for legal reasons',
  upstream_rejected: 'provider rejected the request',
  // fix-bad-request-dead-end. Operator-facing, so it uses this map's `provider …`
  // phrasing rather than the client-facing `upstream …` string in PROVIDER_MAP, and it
  // must stay DISTINCT from every other label — the exhaustive surface test asserts
  // uniqueness, not merely presence, and this map degrades silently without it.
  oversized_response: 'provider response exceeded the size limit',
};

function fixedMessage(kind: string): string {
  return FIXED_MESSAGE[kind] ?? 'provider error';
}

/** The operator-facing label for a provider-error kind. Exported so an exhaustive
 * test over `PROVIDER_ERROR_KINDS` can prove every member has one — this map is
 * `Record<string, …>` with a default, so a missing entry degrades silently rather
 * than failing the build (fix-4xx-error-taxonomy). */
export const toSafeProviderMessage = fixedMessage;

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
    health: toSafeHealth(displayedProviderHealth(p)),
    lastErrorKind: p.lastErrorKind,
    lastErrorMessage: p.lastErrorKind !== null ? fixedMessage(p.lastErrorKind) : null,
    statusSource: p.statusSource,
    statusChangedAt: p.statusChangedAt,
    trafficState: p.trafficState,
    trafficErrorKind: p.trafficErrorKind,
    trafficErrorMessage: p.trafficErrorKind !== null ? fixedMessage(p.trafficErrorKind) : null,
    trafficAt: p.trafficAt,
  };
}

function toSafeHealth(h: DisplayedHealth): SafeProviderHealth {
  return {
    state: h.state,
    kind: h.kind,
    message: h.kind !== null ? fixedMessage(h.kind) : null,
    source: h.source,
    at: h.at,
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

/** Map an adapter-surfaced capability CLAIM to the model row's `listed_supports_*`
 * columns (honest-model-capabilities). Same discipline as the listed price above,
 * for the same reason: explicit nulls when the provider states nothing, so the
 * sync upsert **clears** a stale claim rather than letting a claimless response
 * leave an old one attached to the id.
 *
 * Each flag is carried independently — a provider that states vision but is silent
 * on tools leaves the tools column null, never false. This records what the
 * provider CLAIMS; it is never catalog truth and never routing evidence. */
function listedCapabilityColumnsFrom(
  capabilities: ProviderModelCapabilities | undefined,
  now: Date,
): Pick<
  ModelInsertInput,
  | 'listedSupportsTools'
  | 'listedSupportsVision'
  | 'listedSupportsReasoning'
  | 'listedContextWindow'
  | 'listedCapabilitiesCapturedAt'
> {
  if (capabilities === undefined) {
    return {
      listedSupportsTools: null,
      listedSupportsVision: null,
      listedSupportsReasoning: null,
      listedContextWindow: null,
      listedCapabilitiesCapturedAt: null,
    };
  }
  return {
    listedSupportsTools: capabilities.supportsTools ?? null,
    listedSupportsVision: capabilities.supportsVision ?? null,
    listedSupportsReasoning: capabilities.supportsReasoning ?? null,
    listedContextWindow: capabilities.contextWindow ?? null,
    listedCapabilitiesCapturedAt: now,
  };
}

/** The `listed_*` capability claim read back off a model row, in the shape the
 * shared ladder consumes as its last tier (honest-model-capabilities). */
function listedCapabilityClaim(m: ModelRow): ListedCapabilityClaim {
  return {
    supportsTools: m.listedSupportsTools,
    supportsVision: m.listedSupportsVision,
    supportsReasoning: m.listedSupportsReasoning,
    contextWindow: m.listedContextWindow,
  };
}

/**
 * Whether a provider carries the batch adapter seam (add-batch-mode-routing).
 * Delegates to the data plane's SUBMISSION predicate, so the dashboard's control
 * and the batch path can never disagree about what is reservable — the reason
 * this is derived server-side rather than in the SPA.
 */
function providerBatchCapable(p: ProviderRow | undefined): boolean {
  if (p === undefined || p.baseUrl === null) return false;
  // The row's columns are plain text; the predicate's enums are the authority, and
  // an unrecognized value simply matches nothing rather than widening the seam.
  return (
    batchFactoryFor({
      kind: p.kind as BatchSeamInput['kind'],
      protocol: p.protocol as BatchSeamInput['protocol'],
      baseUrl: p.baseUrl,
    }) !== undefined
  );
}

/**
 * A MODEL's batch capability (fix-batch-capability-and-chain-alignment): the
 * provider's seam, plus — on an aggregator family, where batch is a per-model SKU —
 * a batch-priced sibling twin for that model on that provider. The twin index is the
 * one already built for `baseExternalModelId`, so this asks no question the listing
 * had not already answered.
 *
 * The RULE lives in shared (`modelBatchCapable`) because the routing-entry write path
 * applies it too: the flag the dashboard gates its control on and the reservation the
 * API accepts must be the same judgement, or one will offer what the other refuses.
 */
function batchCapableFor(
  m: ModelRow,
  p: ProviderRow | undefined,
  twinByBase: ReadonlyMap<string, ModelRow>,
): boolean {
  if (p === undefined || p.baseUrl === null) return false;
  return modelBatchCapable({
    seam: providerBatchCapable(p),
    billingFamily: deriveProviderFamily(p.baseUrl),
    // Keyed by (provider, BASE external id) — a base model's own id IS that key; a
    // twin looked up by its suffixed id misses, which is right: a non-routable twin
    // is not itself reservable.
    hasBatchTwin: twinByBase.has(`${m.providerId}\u0000${m.externalModelId}`),
  });
}

function toSafeModel(
  m: ModelRow,
  effectivePrice: EffectivePrice | null = null,
  baseExternalModelId: string | null = null,
  batchCapable = false,
  batchEffectivePrice: EffectivePrice | null = null,
  capabilities: EffectiveCapabilities = { estimated: false },
): SafeModel {
  return {
    id: m.id,
    providerId: m.providerId,
    externalModelId: m.externalModelId,
    displayName: m.displayName,
    // Absent, never null/false: an unknown capability must not read as a denial.
    ...(capabilities.contextWindow !== undefined
      ? { contextWindow: capabilities.contextWindow }
      : {}),
    ...(capabilities.supportsTools !== undefined
      ? { supportsTools: capabilities.supportsTools }
      : {}),
    ...(capabilities.supportsVision !== undefined
      ? { supportsVision: capabilities.supportsVision }
      : {}),
    ...(capabilities.supportsReasoning !== undefined
      ? { supportsReasoning: capabilities.supportsReasoning }
      : {}),
    ...(capabilities.estimated ? { capabilitiesEstimated: true } : {}),
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
    variant: m.variant,
    baseExternalModelId,
    batchCapable,
    batchEffectivePrice,
    lastSyncedAt: m.lastSyncedAt,
  };
}

/** The same-provider base id a variant row prices, or null (no variant, or the
 * base model is absent from that provider — never a guess at another provider's
 * row). `siblings` is the id set of the model's OWN provider. */
function baseIdFor(m: ModelRow, siblings: ReadonlySet<string>): string | null {
  if (m.variant === null) return null;
  const parsed = parseModelVariant(m.externalModelId);
  if (parsed === null) return null;
  return siblings.has(parsed.base) ? parsed.base : null;
}

@Injectable()
export class ProvidersService {
  private readonly key: string;
  private readonly mode: 'selfhosted' | 'cloud';
  private readonly adapterBuilder: ProviderAdapterBuilder;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_FACILITIES) private readonly facilities: PersistenceFacilities,
    @Inject(PROVIDER_ADAPTER_FACTORY) private readonly factory: ProviderAdapterFactory,
    @Inject(PROVIDERS_RUNTIME) runtime: ProvidersRuntime,
    private readonly oauth: SubscriptionOauthService,
  ) {
    this.key = runtime.key;
    this.mode = runtime.mode;
    this.adapterBuilder = new ProviderAdapterBuilder(runtime, oauth);
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
        ? {
            encryptedCredentials: encryptSecret(serializePlainCredential(dto.credential), this.key),
          }
        : {}),
      ...(dto.firstByteTimeoutMs !== undefined
        ? { firstByteTimeoutMs: dto.firstByteTimeoutMs }
        : {}),
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
      ...(dto.firstByteTimeoutMs !== undefined
        ? { firstByteTimeoutMs: dto.firstByteTimeoutMs }
        : {}),
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
    // add-provider-health-signals: an edit that changes the provider's INCARNATION
    // (credential, base_url, or protocol) resets its check record to `unknown` and
    // clears its traffic record in the SAME statement — no health observed against
    // the old credential/endpoint is ever displayed for the new one. A supplied
    // credential always changes the incarnation (re-encryption uses a fresh IV).
    const incarnationChanges =
      dto.credential !== undefined ||
      normalized !== existing.baseUrl ||
      (dto.protocol !== undefined && dto.protocol !== existing.protocol);
    const write = (port: PersistencePort): Promise<ProviderRow | null> =>
      incarnationChanges
        ? port.providers.updateResettingHealth(principal, id, patch, 'edit')
        : port.providers.update(principal, id, patch);
    // A credential mutation on an OAuth provider serializes on the same per-provider
    // lock as refresh/reauthorize, so an in-flight refresh's conditional write can
    // never clobber or resurrect this mutation.
    const row =
      isOauthConnected && dto.credential !== undefined
        ? await this.facilities.withAdvisoryLock(credentialLockKey(id), (tx) => write(tx))
        : await write(this.db);
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
    let built: BuiltAdapter;
    try {
      // buildAdapter is inside the sanitize-try: a credential-resolution failure
      // (e.g. reauthorize_required — add-subscription-oauth) must surface as a
      // sanitized action result, not an unhandled 500.
      built = await this.buildAdapter(principal, provider);
    } catch (err) {
      // The 422 client contract (e.g. missing credential) stays a thrown 422 — only
      // adapter/credential-resolution failures become sanitized action results.
      if (err instanceof UnprocessableEntityException) throw err;
      const sanitized = this.sanitizeThrow(err);
      // The Test is the check the user asked for: a build-time credential failure is
      // recorded as ITS result (add-provider-health-signals).
      await this.recordCheck(principal, id, sanitized, 'test', incarnationOf(provider));
      return sanitized;
    }
    let result = await this.probe(provider, built.adapter);
    let probedWith = built.incarnation;
    // add-provider-health-signals: a 401 on an OAuth provider gets ONE rate-limited
    // repair — a forced refresh keyed on the credential the probe used, then ONE
    // re-probe — so Test either fixes a rejected-but-unexpired token or reports
    // reconnect. At most two validating calls; a held claim or an unavailable
    // Redis reports the 401 as-is without contacting the identity provider.
    if (
      !result.ok &&
      result.kind === 'auth' &&
      provider.oauthPreset !== null &&
      built.incarnation.envelope !== null &&
      (await this.oauth.claimTestRepair(id))
    ) {
      const outcome = await this.oauth
        .forceRefresh(principal, id, built.incarnation.envelope, 'test')
        .catch((): 'transient' => 'transient');
      if (outcome === 'reauthorize_required') {
        result = { ok: false, kind: 'credential', message: 'credential needs reauthorization' };
      } else if (outcome === 'refreshed' || outcome === 'adopted') {
        const fresh = await this.db.providers.findById(principal, id);
        if (fresh !== null) {
          try {
            const rebuilt = await this.buildAdapter(principal, fresh);
            probedWith = rebuilt.incarnation;
            result = await this.probe(fresh, rebuilt.adapter);
          } catch (err) {
            if (err instanceof UnprocessableEntityException) throw err;
            const kind = err instanceof ProviderError ? err.kind : 'unavailable';
            result = { ok: false, kind, message: fixedMessage(kind) };
            probedWith = incarnationOf(fresh);
          }
        }
      }
    }
    const sanitized = this.sanitizeConnection(result);
    // Guarded by the incarnation of the LAST probe: a Test that finishes after a
    // reconnect/edit replaced the credential records nothing.
    await this.recordCheck(principal, id, sanitized, 'test', probedWith);
    return sanitized;
  }

  /** The designated validating call, normalized to a typed result: a bundled-model
   * preset's minimal 1-token chat probe (an invalid/revoked credential still
   * surfaces as a typed auth failure and is never masked by the bundled list), or
   * the adapter's cheap `testConnection()`. */
  private async probe(provider: ProviderRow, adapter: ProviderAdapter): Promise<ConnectionResult> {
    const bundledPreset = this.bundledPresetFor(provider);
    try {
      if (bundledPreset !== undefined) {
        await adapter.chat({
          model: bundledPreset.bundledModels?.[0] ?? 'probe',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          params: { maxOutputTokens: 1 },
        });
        return { ok: true, models: bundledPreset.bundledModels?.length ?? 0 };
      }
      return await adapter.testConnection();
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : 'unavailable';
      return { ok: false, kind, message: fixedMessage(kind) };
    }
  }

  /** Record a check result (add-provider-health-signals) — guarded by the
   * incarnation the check ran against; never rejects. */
  private async recordCheck(
    principal: Principal,
    id: string,
    result: ActionResult,
    source: 'test' | 'sync',
    against: ProviderIncarnation,
  ): Promise<void> {
    await recordProviderHealth(
      this.db,
      principal,
      id,
      {
        record: 'check',
        status: result.ok ? 'ok' : 'error',
        kind: result.ok ? null : (result.kind ?? 'unavailable'),
        source,
      },
      against,
    );
  }

  async syncModels(principal: Principal, id: string): Promise<ActionResult> {
    const provider = await this.requireProvider(principal, id);
    const bundledPreset = this.bundledPresetFor(provider);
    let models: ProviderModelInfo[];
    // add-provider-health-signals: health is written ONLY when an authenticated
    // listing call was made — set once the adapter is built. A bundled (metadata-
    // only) sync checks nothing, and a build-time credential failure has already
    // recorded its own check under the credential lock; neither writes here.
    let listedWith: ProviderIncarnation | null = null;
    try {
      if (bundledPreset !== undefined) {
        // Bundled model sourcing: seed the preset's list (preset-sourced, no network) —
        // the credential itself is validated by test-connection's designated probe.
        models = (bundledPreset.bundledModels ?? []).map((m) => ({ id: m }));
      } else {
        const built = await this.buildAdapter(principal, provider);
        listedWith = built.incarnation;
        models = await built.adapter.listModels();
      }
    } catch (err) {
      if (err instanceof UnprocessableEntityException) throw err; // 422 contract

      const sanitized = this.sanitizeThrow(err);
      if (listedWith !== null) await this.recordCheck(principal, id, sanitized, 'sync', listedWith);
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
    // The variant is aggregator-scoped, so it is derived from the SAME endpoint the
    // response came from (add-model-variant-detection). If that endpoint moved
    // mid-flight the response is persisted UNCLASSIFIED as well as priceless — a
    // classification justified by the old family must not attach to the new one.
    const billingFamily =
      endpointMoved || provider.baseUrl === null ? null : deriveProviderFamily(provider.baseUrl);
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
      // Same mid-flight rule as the price and the variant (honest-model-capabilities):
      // a capability claim justified by the OLD endpoint must not attach to the new one.
      const claimed = endpointMoved ? undefined : m.capabilities;
      // Always write the listed_* columns (set from the listed price, or null to CLEAR a
      // stale estimate) — a DISPLAY-only estimate, distinct from the billing user-price
      // columns, never a catalog/cost source (invariant 4).
      const values: ModelInsertInput = {
        externalModelId: m.id,
        lastSyncedAt: now,
        // ALWAYS written (set or cleared), like the listed_* columns: a stale
        // classification must not outlive the id that produced it.
        variant: variantForProvider(billingFamily, m.id)?.variant ?? null,
        ...(displayName !== undefined ? { displayName } : {}),
        ...listedColumnsFrom(pricing, now),
        // ALWAYS written (set or cleared), so a later claimless sync cannot leave
        // a stale capability attached to the id.
        ...listedCapabilityColumnsFrom(claimed, now),
      };
      const row = await this.db.models.upsertForProvider(principal, provider.id, values);
      if (row) {
        synced += 1;
        if (pricing !== undefined) pricesCaptured += 1;
      }
    }
    const result: ActionResult = {
      ok: true,
      status: 'ok',
      message: 'catalog synced',
      traceId: randomUUID(),
      synced,
      pricesCaptured,
    };
    if (listedWith !== null) await this.recordCheck(principal, id, result, 'sync', listedWith);
    return result;
  }

  async listModels(principal: Principal, q: ListModelsQueryDto): Promise<SafeModel[]> {
    // The whole catalog is kept beside the filtered projection: the two indexes below
    // answer "what does this provider's catalog CONTAIN", which a display filter has no
    // standing to narrow (fix-batch-capability-and-chain-alignment). Deriving them from
    // `rows` let `?supportsVision=true` drop a twin whose flags differ from its base's
    // and report a batch-capable model as incapable — for a reason with nothing to do
    // with batch. Same query, so this costs nothing.
    const all = await this.db.models.listForPrincipal(principal);
    let rows = all;
    if (q.providerId !== undefined) rows = rows.filter((r) => r.providerId === q.providerId);
    // The capability filters are applied AFTER resolution, below — like the
    // is_free filter and for the same reason (honest-model-capabilities). Applied
    // to the model row they matched nothing for any tenant, the row's capability
    // columns having never been written by any code path.
    // Resolve each model's effective DISPLAY price through the SHARED bulk context
    // (expand-models-listing): one providers read + ONE key-filtered catalog read —
    // never per-model queries or a full scan — and the same derivation the proxy's
    // `/v1/models` uses, so the two surfaces cannot report different prices.
    const ctx = await loadPriceContext(this.db, principal, rows);
    // Per-provider external-id index: a twin pairs ONLY with a base model on its
    // own provider (add-model-variant-detection).
    const idsByProvider = new Map<string, Set<string>>();
    for (const r of all) {
      const set = idsByProvider.get(r.providerId) ?? new Set<string>();
      set.add(r.externalModelId);
      idsByProvider.set(r.providerId, set);
    }
    // Batch twins indexed by (provider, BASE external id) — the same pairing rule the
    // recorded-cost path uses (add-batch-mode-help task 1.2). The twin's captured rate
    // is the last-resort batch estimate and lives on the TWIN's own row, so resolving
    // batch mode without it reports null for exactly the aggregator models whose batch
    // rate is most often knowable. These rows are already in `rows`, so no query.
    const twinByBase = new Map<string, ModelRow>();
    for (const r of all) {
      if (r.variant !== 'batch') continue;
      const base = parseModelVariant(r.externalModelId)?.base;
      if (base !== undefined) twinByBase.set(`${r.providerId}\u0000${base}`, r);
    }
    let safe = rows.map((r) => {
      const kind = ctx.kindOf(r);
      const catalogRow = ctx.catalogRowOf(r);
      const nativeRow = ctx.nativeRowOf(r);
      return toSafeModel(
        r,
        toEffectivePrice(r, kind, catalogRow, nativeRow),
        baseIdFor(r, idsByProvider.get(r.providerId) ?? new Set()),
        // The providers read inside the context already happened for the display
        // price, so this adds no query — the projection stays bounded (invariant 9).
        batchCapableFor(r, ctx.providerOf(r), twinByBase),
        // Batch mode over the SAME catalog rows (the batch pair lives on the row
        // already fetched), plus the sibling twin's captured rate as the last resort.
        toEffectivePrice(r, kind, catalogRow, nativeRow, {
          twin: twinByBase.get(`${r.providerId}\u0000${r.externalModelId}`) ?? null,
        }),
        // Capability off the SAME catalog rows the price just used — the ladder
        // costs no query of its own. The provider-listed claim joins as the last
        // tier once sync captures it (task 6.5).
        toEffectiveCapabilities(catalogRow, nativeRow, listedCapabilityClaim(r)),
      );
    });
    // The is_free filter applies to the EFFECTIVE price (resolve, then filter), so a
    // catalog-less free-by-listing model still matches (add-provider-price-sync-and-edit).
    if (q.isFree !== undefined) {
      safe = safe.filter((m) => (m.effectivePrice?.isFree ?? false) === q.isFree);
    }
    // Capability filters match the RESOLVED value. Strict equality means an
    // UNKNOWN capability (absent) matches neither `true` nor `false`: unknown is
    // not a negative answer, and a filter that treated it as one would reproduce
    // the defect this change removes, just one layer up.
    if (q.supportsTools !== undefined) {
      safe = safe.filter((m) => m.supportsTools === q.supportsTools);
    }
    if (q.supportsVision !== undefined) {
      safe = safe.filter((m) => m.supportsVision === q.supportsVision);
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
    return toSafeModel(
      updated,
      toEffectivePrice(updated, provider.kind, catalogRow, nativeRow),
      null,
      providerBatchCapable(provider),
      // Single-model read: no sibling set in hand, so the twin estimate is not
      // available here. Catalog and native-family batch rates still resolve.
      toEffectivePrice(updated, provider.kind, catalogRow, nativeRow, { twin: null }),
      // Capabilities resolve on THIS path too, off the rows already fetched for
      // the price: the client optimistically replaces its model from this
      // response, so a `SafeModel` that described the model in the list and not
      // here would make a pricing edit look like a capability regression.
      toEffectiveCapabilities(catalogRow, nativeRow, listedCapabilityClaim(updated)),
    );
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

  /** Build an adapter plus the incarnation it was built against (the envelope
   * the build actually used — see `buildConfigWithCredential`). */
  private async buildAdapter(principal: Principal, provider: ProviderRow): Promise<BuiltAdapter> {
    const built = await this.buildAdapterConfig(principal, provider);
    return {
      adapter: this.factory(built.config),
      incarnation: {
        envelope: built.usedEnvelope,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
      },
    };
  }

  private async buildAdapterConfig(
    principal: Principal,
    provider: ProviderRow,
  ): Promise<BuiltAdapterConfig> {
    // The SAME shared builder the proxy and batch paths use (add-batch-inference
    // D4). Management keeps its call-time SSRF semantics — test-connection reports
    // a refused address through the adapter's typed result rather than a 422 —
    // so the build-time gate is skipped here; the guarded transport still refuses
    // at connect. A missing base_url/credential is this surface's 422.
    try {
      return await this.adapterBuilder.buildConfigWithCredential(principal, provider, {
        defaultMaxOutputTokens: 4096,
        assertAddress: false,
      });
    } catch (err) {
      if (err instanceof AdapterBuildError) {
        throw new UnprocessableEntityException(
          err.reason === 'no_base_url' ? 'provider base_url is required' : err.message,
        );
      }
      throw err;
    }
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
