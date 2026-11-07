import { randomUUID } from 'node:crypto';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
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
  MAX_PARSED_MODELS,
  CallCancelledError,
  ProviderError,
  createProviderAdapter,
  type ConnectionResult,
  type ProviderAdapter,
  type ProviderKind,
  type ModelListing,
  type ProviderModelInfo,
  type ProviderListedPricing,
  type ProviderModelCapabilities,
  type CallContext,
  type PlanCooldown,
  type PlanCooldownStore,
  type PlanUsageProbe,
  type PlanUsageRecorder,
  type PlanUsageStore,
  readPlanUsage as defaultReadPlanUsage,
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
import { clientIdentityView } from './client-identity';
import { PLAN_COOLDOWN_STORE } from '../plan-cooldown/plan-cooldown.tokens';
import {
  PLAN_USAGE_READER,
  PLAN_USAGE_RECORDER,
  PLAN_USAGE_STORE,
} from '../plan-usage/plan-usage.tokens';
import { clearPlanUsageSnapshot } from '../plan-usage/plan-usage-clear';
import { planUsageHook, recorderSink } from '../plan-usage/plan-usage-hook';
import { planUsageSourcesFor } from '../plan-usage/plan-usage-sources';
import {
  toSafePlanUsage,
  type SafePlanUsage,
  type SafePlanUsageRefresh,
} from '../plan-usage/plan-usage-view';
import { keyPresetForRow } from '../subscription-presets/key-presets';
import { normalizeAndGateBaseUrl } from './base-url-gate';

/** The fixed 422 for an endpoint edit on a key-preset row (add-key-subscription-presets). */
export const KEY_PRESET_PINNED_MESSAGE =
  'this provider is pinned by its preset — delete it and reconnect to change its endpoint';

/** `new URL(x).href`, or the raw string when it does not parse (so it never equals a stored,
 * canonical base_url). */
function canonicalHref(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

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
/** add-auto-prune-unlisted-models: how long a model must have stayed continuously unlisted
 * (since its `unlisted_since`) before a successful sync may delete it, when nothing
 * references it and the provider's `auto_prune_unlisted` is on. Elapsed time since the
 * first observed omission, not a count of listings. */
export const UNLISTED_PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** add-key-subscription-presets: the key-preset marker (display only — NON-SECRET). Server-
   * set at connect and never accepted on create/update; the coherence gate
   * (`keyPresetForRow`) decides whether it still binds a preset to this row. */
  keyPreset: string | null;
  credentialExpiresAt: Date | null;
  credentialError: string | null;
  /** Upstream patience overrides (fix-long-call-timeouts); null = inherit. */
  firstByteTimeoutMs: number | null;
  idleTimeoutMs: number | null;
  /** add-auto-prune-unlisted-models: sync deletes unreferenced models unlisted 7+ days. */
  autoPruneUnlisted: boolean;
  /** allow-preset-client-identity: the per-provider switch (off by default). */
  imitateClientIdentity: boolean;
  /** The imitated client's label while imitation is AVAILABLE for this row (kind,
   * valid declaration, pinned endpoint), else null. Never carries header names/values. */
  clientIdentity: { label: string } | null;
  /** classify-plan-quota-errors: the active plan pause, or null. `until` is an ISO-8601
   * string (every other instant on the wire is one). Read only for a row whose region
   * declares a plan-error dialect; null for every other row, a new row and an OAuth row. */
  planCooldown: SafePlanCooldown | null;
  /** add-subscription-quota-display: the plan-usage snapshot (numbers, enums and ISO instants),
   * or null. Read only for a row whose preset declares a usage source and that still matches
   * its pin; null for every other row, a new row and an OAuth `complete` response. */
  planUsage: SafePlanUsage | null;
  /** `{ availableAt }` while the row has an ENABLED usage endpoint (`availableAt` null = a
   * refresh is allowed now), else null. Never carries the endpoint, its dialect or auth. */
  planUsageRefresh: SafePlanUsageRefresh | null;
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

/** The wire view of one active plan cooldown. Never holds a message, credential or request. */
export interface SafePlanCooldown {
  kind: PlanCooldown['kind'];
  until: string;
  untilSource: PlanCooldown['source'];
}

export function toSafePlanCooldown(c: PlanCooldown | null | undefined): SafePlanCooldown | null {
  if (c === null || c === undefined) return null;
  return { kind: c.kind, until: new Date(c.until).toISOString(), untilSource: c.source };
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
  /** add-live-subscription-models: when the provider's listing FIRST stopped
   * offering this model, or null while it is offered. Display + guarded removal
   * only — never a routing input. */
  unlistedSince: Date | null;
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
  /** Models this sync deleted as retired and unreferenced (add-auto-prune-unlisted-models):
   * set on every successful sync, 0 when nothing qualified, the provider's switch is off, or
   * reconciliation was skipped; absent on a failed one. */
  pruned?: number;
}

/** The outcome of an attended "Refresh usage" (add-subscription-quota-display, design D8). A
 * failed read still answers 200 with `ok: false`, the failure's kind and a FIXED message, and a
 * view whose `planUsage` is unchanged. */
export interface PlanUsageRefreshResult {
  ok: boolean;
  kind?: string;
  message?: string;
  provider: SafeProvider;
}

/** `429` for a refresh while its shared cooldown holds. The controller turns `retryAfterSeconds`
 * into the `Retry-After` header; the body carries `availableAt` for the card. */
export class PlanUsageCooldownException extends HttpException {
  constructor(
    readonly retryAfterSeconds: number,
    availableAt: string,
  ) {
    super({ statusCode: 429, message: 'plan usage was refreshed recently', availableAt }, 429);
  }
}

export type PlanUsageReader = typeof defaultReadPlanUsage;

/** Fixed texts for a refresh that failed before or after the read (never an upstream string). */
const REFRESH_MESSAGES = {
  noCredential: 'No credential is stored for this provider, so its usage cannot be read.',
  buildFailed: 'The usage read could not be set up for this provider.',
  superseded: 'The credential changed while usage was being read; refresh again.',
} as const;

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
  // classify-plan-quota-errors (design D4): operator labels for the four dialect-only
  // plan kinds. Each must stay distinct from every other label (the exhaustive surface
  // test asserts uniqueness).
  quota_exhausted: 'plan usage limit reached',
  risk_control: 'provider throttled the account (risk control)',
  plan_entitlement: 'plan does not include this model',
  plan_inactive: 'no active plan for this key',
};

function fixedMessage(kind: string): string {
  return FIXED_MESSAGE[kind] ?? 'provider error';
}

/** The operator-facing label for a provider-error kind. Exported so an exhaustive
 * test over `PROVIDER_ERROR_KINDS` can prove every member has one — this map is
 * `Record<string, …>` with a default, so a missing entry degrades silently rather
 * than failing the build (fix-4xx-error-taxonomy). */
export const toSafeProviderMessage = fixedMessage;

/** The plan-usage half of the view (add-subscription-quota-display). */
export interface PlanUsageView {
  readonly planUsage: SafePlanUsage | null;
  readonly planUsageRefresh: SafePlanUsageRefresh | null;
}

const NO_PLAN_USAGE: PlanUsageView = { planUsage: null, planUsageRefresh: null };

export function toSafe(
  p: ProviderRow,
  clientIdentity: { label: string } | null,
  planCooldown: SafePlanCooldown | null,
  usage: PlanUsageView = NO_PLAN_USAGE,
): SafeProvider {
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
    keyPreset: p.keyPreset,
    credentialExpiresAt: p.credentialExpiresAt,
    credentialError: p.credentialError,
    firstByteTimeoutMs: p.firstByteTimeoutMs,
    idleTimeoutMs: p.idleTimeoutMs,
    autoPruneUnlisted: p.autoPruneUnlisted,
    imitateClientIdentity: p.imitateClientIdentity,
    clientIdentity,
    planCooldown,
    planUsage: usage.planUsage,
    planUsageRefresh: usage.planUsageRefresh,
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
    unlistedSince: m.unlistedSince,
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
  private readonly logger = new Logger(ProvidersService.name);
  private readonly key: string;
  private readonly mode: 'selfhosted' | 'cloud';
  private readonly adapterBuilder: ProviderAdapterBuilder;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(PERSISTENCE_FACILITIES) private readonly facilities: PersistenceFacilities,
    @Inject(PROVIDER_ADAPTER_FACTORY) private readonly factory: ProviderAdapterFactory,
    @Inject(PROVIDERS_RUNTIME) runtime: ProvidersRuntime,
    private readonly oauth: SubscriptionOauthService,
    // classify-plan-quota-errors (design D7/D10): the shared plan-cooldown store, for the
    // view and the lift. Optional so `new ProvidersService(port, facilities, f, rt, oauth)`
    // in test harnesses still compiles; a missing store reads as "no pause".
    @Optional()
    @Inject(PLAN_COOLDOWN_STORE)
    private readonly planCooldowns?: PlanCooldownStore,
    // add-subscription-quota-display (design D6/D8): the shared plan-usage store, its recorder
    // (Test and manual sync offer through it, and a clear teaches it the new generation) and the
    // usage-endpoint reader. All optional for the same reason: hand-wired harnesses still
    // compile, and a missing store reads as "no usage" and refuses a refresh with a 503.
    @Optional()
    @Inject(PLAN_USAGE_STORE)
    private readonly planUsageStore?: PlanUsageStore,
    @Optional()
    @Inject(PLAN_USAGE_RECORDER)
    private readonly planUsageRecorder?: PlanUsageRecorder,
    @Optional()
    @Inject(PLAN_USAGE_READER)
    private readonly planUsageReader?: PlanUsageReader,
  ) {
    this.key = runtime.key;
    this.mode = runtime.mode;
    this.adapterBuilder = new ProviderAdapterBuilder(runtime, oauth);
  }

  /** Whether a loopback `local` provider can be dialled here (selfhosted only) — the
   * scheduled catalog refresh skips local rows elsewhere rather than failing them. */
  get allowsLocalProviders(): boolean {
    return this.mode === 'selfhosted';
  }

  async list(principal: Principal): Promise<SafeProvider[]> {
    const rows = await this.db.providers.list(principal);
    const pauses = await this.readPlanCooldowns(rows);
    const usage = await this.readPlanUsageViews(rows);
    return rows.map((row) => this.safe(row, pauses.get(row.id) ?? null, usage.get(row.id)));
  }

  async get(principal: Principal, id: string): Promise<SafeProvider> {
    const row = await this.db.providers.findById(principal, id);
    if (!row) throw new NotFoundException();
    const pauses = await this.readPlanCooldowns([row]);
    const usage = await this.readPlanUsageViews([row]);
    return this.safe(row, pauses.get(row.id) ?? null, usage.get(row.id));
  }

  /** The safe view with the identity label derived through the one availability lookup. The
   * plan cooldown is a REQUIRED argument so the compiler finds every caller: a row that was
   * just created (or connected through OAuth / a key preset) has no cooldown and passes null.
   * `usage` is absent for a row with no plan-usage source (and for a new row): both fields null. */
  private safe(
    row: ProviderRow,
    planCooldown: SafePlanCooldown | null,
    usage?: PlanUsageView,
  ): SafeProvider {
    return toSafe(
      row,
      clientIdentityView(this.oauth.availableClientIdentity(row)),
      planCooldown,
      usage,
    );
  }

  /** The plan-usage half of every row's view, in ONE batched store read over the rows that have
   * a source (design D8). Rows without a source get no entry and cost no store call; a store
   * fault (or a missing store) never fails the read: the failover store answers from this
   * instance's own record, and anything that still throws reads as no snapshot. A row with an
   * ENABLED usage endpoint always offers its refresh, `availableAt` null until a cooldown holds.
   * Read on dashboard calls only, never on the proxy path. */
  private async readPlanUsageViews(
    rows: readonly ProviderRow[],
  ): Promise<ReadonlyMap<string, PlanUsageView>> {
    const out = new Map<string, PlanUsageView>();
    const ids: string[] = [];
    const refreshable = new Set<string>();
    for (const row of rows) {
      const sources = planUsageSourcesFor(row, this.oauth.identityBindingFor(row));
      if (sources === null) continue;
      ids.push(row.id);
      if (sources.probe?.enabled === true) refreshable.add(row.id);
    }
    if (ids.length === 0) return out;
    let found: Awaited<ReturnType<PlanUsageStore['readMany']>> | undefined;
    const store = this.planUsageStore;
    if (store !== undefined) {
      try {
        found = await store.readMany(ids, [...refreshable]);
      } catch {
        /* the failover store absorbs a fault; anything that still throws reads as no snapshot */
      }
    }
    for (const id of ids) {
      const read = found?.get(id);
      const ends = read?.cooldownEndsAt ?? null;
      out.set(id, {
        planUsage: toSafePlanUsage(read?.snapshot),
        planUsageRefresh: refreshable.has(id)
          ? { availableAt: ends === null ? null : new Date(ends).toISOString() }
          : null,
      });
    }
    return out;
  }

  /** `{ onPlanUsage }` for an ATTENDED call (Test, manual sync) on `row`, or undefined when the
   * row's gate yields no passive dialect or no recorder is wired. `gen` was read BEFORE the row
   * load (design D5). */
  private usageContext(row: ProviderRow, gen: number): CallContext | undefined {
    if (this.planUsageRecorder === undefined) return undefined;
    const dialect = planUsageSourcesFor(row, this.oauth.identityBindingFor(row))?.dialect;
    if (dialect === undefined) return undefined;
    return { onPlanUsage: planUsageHook(recorderSink(this.planUsageRecorder), row.id, gen) };
  }

  /** The snapshot generation this instance knows for a provider, read synchronously before a
   * row load; 0 when unknown (or no recorder). */
  private usageGeneration(id: string): number {
    return this.planUsageRecorder?.generationOf(id) ?? 0;
  }

  /** The active pause of every row whose region declares a plan-error dialect, in ONE
   * `checkMany`. Rows without a dialect, and a missing or still-throwing store, give no entry
   * (the view never answers an error because of the store, design D10). Read on dashboard
   * calls only, never on the proxy path. */
  private async readPlanCooldowns(
    rows: readonly ProviderRow[],
  ): Promise<ReadonlyMap<string, SafePlanCooldown>> {
    const out = new Map<string, SafePlanCooldown>();
    const store = this.planCooldowns;
    if (store === undefined) return out;
    const ids = rows
      .filter((r) => keyPresetForRow(r)?.region.errorDialect !== undefined)
      .map((r) => r.id);
    if (ids.length === 0) return out;
    try {
      const found = await store.checkMany(ids);
      for (const [id, pause] of found) {
        const view = toSafePlanCooldown(pause);
        if (view !== null) out.set(id, view);
      }
    } catch {
      /* the failover store absorbs a fault; anything that still throws reads as no pause */
    }
    return out;
  }

  /**
   * Lift a provider's plan cooldown ("Resume now"). The owner-scoped lookup runs first (404 for
   * another tenant's id; no key is touched), then the SHARED store's `lift`. It throws `503`
   * when the shared store could not be reached, never reporting a lift that did not happen
   * (design D10). Idempotent: an unpaused provider is a success.
   */
  async liftPlanCooldown(principal: Principal, id: string): Promise<void> {
    const row = await this.db.providers.findById(principal, id);
    if (!row) throw new NotFoundException();
    if (this.planCooldowns === undefined) return;
    try {
      await this.planCooldowns.lift(row.id);
    } catch {
      throw new ServiceUnavailableException('could not reach the shared pause store');
    }
  }

  /**
   * "Refresh usage": an attended, owner-scoped read of a key plan's usage endpoint, at most once
   * per shared cooldown (add-subscription-quota-display, design D8). The order is the contract:
   *  1. `findById`, else 404 (invariant 5) — checked FIRST, whatever the store's state;
   *  2. the row's ENABLED usage endpoint, else 422;
   *  3. claim the shared cooldown (`SET NX`): held -> 429 with `Retry-After`, store unreachable ->
   *     503. No call is ever sent on a refusal. The claim returns the snapshot generation;
   *  4. RE-LOAD the row AFTER the claim (a vanished row is 404) and build the config from it, so
   *     a refresh that read a since-replaced key carries an older generation and its merge drops;
   *  5. read through the injected reader; 6. merge `source: 'refresh'` at the claimed generation,
   *     or extend the cooldown on a 429's `Retry-After`;
   *  7. answer with the outcome and the `get` view.
   * It writes no check record, traffic record, breaker state or plan cooldown: it is not a Test.
   */
  async refreshPlanUsage(principal: Principal, id: string): Promise<PlanUsageRefreshResult> {
    const row = await this.db.providers.findById(principal, id);
    if (!row) throw new NotFoundException();
    if (this.enabledProbe(row) === null) {
      throw new UnprocessableEntityException('this provider has no usage endpoint to refresh');
    }
    const store = this.planUsageStore;
    if (store === undefined) {
      throw new ServiceUnavailableException('could not reach the shared usage store');
    }
    let claim: Awaited<ReturnType<PlanUsageStore['claimRefresh']>>;
    try {
      claim = await store.claimRefresh(id);
    } catch {
      throw new ServiceUnavailableException('could not reach the shared usage store');
    }
    if (!claim.claimed) {
      const waitMs = Math.max(0, claim.retryAfterMs);
      throw new PlanUsageCooldownException(
        Math.max(1, Math.ceil(waitMs / 1000)),
        new Date(claim.availableAt).toISOString(),
      );
    }
    // The cooldown is claimed from here on: every outcome below keeps it (a failing endpoint is
    // not called again within the cooldown).
    const fresh = await this.db.providers.findById(principal, id);
    if (!fresh) throw new NotFoundException();
    const probe = this.enabledProbe(fresh);
    if (probe === null) {
      throw new UnprocessableEntityException('this provider has no usage endpoint to refresh');
    }
    const outcome = await this.readAndMerge(principal, fresh, probe, claim.gen);
    return { ...outcome, provider: await this.get(principal, id) };
  }

  /** The row's usage probe when the ONE gate yields one AND it is enabled, else null. */
  private enabledProbe(row: ProviderRow): PlanUsageProbe | null {
    const probe = planUsageSourcesFor(row, this.oauth.identityBindingFor(row))?.probe;
    return probe !== undefined && probe.enabled ? probe : null;
  }

  private async readAndMerge(
    principal: Principal,
    row: ProviderRow,
    probe: PlanUsageProbe,
    gen: number,
  ): Promise<{ ok: boolean; kind?: string; message?: string }> {
    let config: BuiltAdapterConfig['config'];
    try {
      // For a key-preset row this resolves a plain credential and makes no call.
      config = (await this.buildAdapterConfig(principal, row)).config;
    } catch (err) {
      if (err instanceof UnprocessableEntityException) {
        return { ok: false, kind: 'credential', message: REFRESH_MESSAGES.noCredential };
      }
      return { ok: false, kind: 'unavailable', message: REFRESH_MESSAGES.buildFailed };
    }
    const reader = this.planUsageReader ?? defaultReadPlanUsage;
    let result: Awaited<ReturnType<PlanUsageReader>>;
    try {
      result = await reader(config, probe);
    } catch {
      return { ok: false, kind: 'unavailable', message: REFRESH_MESSAGES.buildFailed };
    }
    const store = this.planUsageStore;
    if (!result.ok) {
      // A 429's own back-off is honoured: extend-only, never shorter than the 5-minute claim.
      if (result.retryAfterMs !== undefined && store !== undefined) {
        try {
          await store.extendRefresh(row.id, result.retryAfterMs);
        } catch {
          this.logger.warn('plan usage: extending a refresh cooldown failed; the claim stands');
        }
      }
      return { ok: false, kind: result.kind, message: result.message };
    }
    try {
      const merged = await store?.merge(row.id, result.observation, gen, 'refresh');
      if (merged !== undefined && !merged.applied) {
        // A key rotation (or reconnect) landed while the read was in flight: its data belongs to
        // the replaced credential and was dropped by the generation barrier.
        return { ok: false, kind: 'unavailable', message: REFRESH_MESSAGES.superseded };
      }
    } catch {
      this.logger.warn('plan usage: storing a refreshed snapshot failed');
      return { ok: false, kind: 'unavailable', message: REFRESH_MESSAGES.buildFailed };
    }
    return { ok: true };
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
      // Omit to take the schema default (on).
      ...(dto.autoPruneUnlisted !== undefined ? { autoPruneUnlisted: dto.autoPruneUnlisted } : {}),
    };
    // A new row has no cooldown: null, with no store call.
    return this.safe(await this.db.providers.insert(principal, values), null);
  }

  async update(principal: Principal, id: string, dto: UpdateProviderDto): Promise<SafeProvider> {
    const existing = await this.db.providers.findById(principal, id);
    if (!existing) throw new NotFoundException();

    // Key-preset pin (add-key-subscription-presets, design D7): while `key_preset` is set,
    // the pinned endpoint, protocol and kind never change — delete and reconnect instead.
    // Judged on the CANONICAL `new URL().href` form of a supplied base_url (case and
    // default-port respellings of the pin are not drift; a trailing-slash variant IS drift
    // and gets the 422, because `keyPresetForRow` matches base_url exactly) and BEFORE the
    // SSRF gate, so a drifted PATCH gets the one fixed message and never costs a DNS lookup. Name, timeouts, max-tokens spelling and
    // auto-prune stay editable, and a supplied credential rotates or clears the key as plain
    // and keeps the marker. The OAuth conversion below never runs for such a row: the
    // `provider_key_preset_exclusive` CHECK means `oauthPreset` is null here.
    if (existing.keyPreset !== null) {
      const drifts =
        (dto.baseUrl !== undefined && canonicalHref(dto.baseUrl) !== existing.baseUrl) ||
        (dto.protocol !== undefined && dto.protocol !== existing.protocol) ||
        (dto.kind !== undefined && dto.kind !== existing.kind);
      if (drifts) throw new UnprocessableEntityException(KEY_PRESET_PINNED_MESSAGE);
    }

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

    // allow-preset-client-identity (design D7): `true` only when imitation is AVAILABLE for
    // the row as it will be after this PATCH. Goes through the one lookup (never
    // clientIdentityFor/presetFor directly) so a later key-preset registry is covered
    // without editing this method. A credential-supplying PATCH drops the preset binding
    // (the conversion below), so it is judged with `oauthPreset: null`.
    if (dto.imitateClientIdentity === true) {
      const patchedRow: ProviderRow = {
        ...existing,
        kind: nextKind,
        baseUrl: normalized,
        protocol: dto.protocol ?? existing.protocol,
        ...(dto.credential !== undefined ? { oauthPreset: null } : {}),
      };
      if (this.oauth.availableClientIdentity(patchedRow) === null) {
        throw new UnprocessableEntityException(
          'client identity imitation is not available for this provider',
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
      ...(dto.autoPruneUnlisted !== undefined ? { autoPruneUnlisted: dto.autoPruneUnlisted } : {}),
      ...(dto.imitateClientIdentity !== undefined
        ? { imitateClientIdentity: dto.imitateClientIdentity }
        : {}),
      // Present-but-empty clears; omitted (undefined) preserves the envelope. New
      // plain values are WRAPPED in the typed envelope (forgery-proof by construction).
      ...(dto.credential !== undefined
        ? {
            encryptedCredentials:
              dto.credential === ''
                ? null
                : encryptSecret(serializePlainCredential(dto.credential), this.key),
            ...(isOauthConnected
              ? {
                  oauthPreset: null,
                  credentialExpiresAt: null,
                  credentialError: null,
                  // The identity switch lives and dies with the preset binding. It is
                  // written AFTER the dto spread, so a same-PATCH `true` cannot survive.
                  imitateClientIdentity: false,
                }
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
    // A new credential may belong to another plan or account, so the plan-usage snapshot is
    // discarded and its generation raised (add-subscription-quota-display, design D8) — AFTER the
    // write has committed, so an observation made with the replaced key carries an older
    // generation and is dropped. Only a row that had a usage source has anything to clear, and the
    // refresh cooldown is deliberately kept (re-sending the same key must not skip it). A clear
    // fault is logged and never fails the edit; a token refresh never gets here.
    if (
      incarnationChanges &&
      dto.credential !== undefined &&
      planUsageSourcesFor(existing, this.oauth.identityBindingFor(existing)) !== null
    ) {
      await clearPlanUsageSnapshot(this.planUsageStore, this.planUsageRecorder, id, this.logger);
    }
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
    // A new key may belong to another plan, and the health records already reset on the same
    // edit, so the pause is lifted too (classify-plan-quota-errors, design D10). A lift fault is
    // swallowed with a static line: the edit has succeeded, and the pause then ends by its own
    // expiry or through Resume now.
    if (incarnationChanges && this.planCooldowns !== undefined) {
      try {
        await this.planCooldowns.lift(id);
      } catch {
        this.logger.warn(
          'plan cooldown lift failed after a credential edit; it will expire on its own',
        );
      }
    }
    const pauses = await this.readPlanCooldowns([row]);
    const usage = await this.readPlanUsageViews([row]);
    return this.safe(row, pauses.get(row.id) ?? null, usage.get(row.id));
  }

  async remove(principal: Principal, id: string): Promise<{ deleted: boolean }> {
    // ON DELETE CASCADE removes the provider's models and their routing entries.
    const deleted = await this.db.providers.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    return { deleted };
  }

  async testConnection(principal: Principal, id: string): Promise<ActionResult> {
    // The snapshot generation is read BEFORE the row load (design D5), so an observation this
    // Test makes with a credential replaced mid-flight is dropped by the merge.
    const usageGen = this.usageGeneration(id);
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
    let result = await this.probe(built.adapter, this.usageContext(provider, usageGen));
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
            result = await this.probe(rebuilt.adapter, this.usageContext(fresh, usageGen));
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

  /** The validating call, normalized to a typed result: the adapter's cheap
   * `testConnection()` — the model LISTING for every provider, subscription presets
   * included (add-live-subscription-models), so it names no model and an upstream
   * retirement can never fail it. */
  private async probe(adapter: ProviderAdapter, ctx?: CallContext): Promise<ConnectionResult> {
    try {
      return await adapter.testConnection(ctx);
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

  /**
   * List the provider's models and upsert them, then reconcile which stored models
   * the provider no longer lists (add-live-subscription-models). `recordHealth:false`
   * is the scheduled catalog refresh's mode: a background catalog read is not a
   * check of the provider, so it writes no health record either way.
   */
  async syncModels(
    principal: Principal,
    id: string,
    opts: {
      readonly recordHealth?: boolean;
      /** Capture plan usage from the listing's headers (default true). The scheduled catalog
       * refresh passes false: only traffic and attended actions capture. */
      readonly capturePlanUsage?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ActionResult> {
    const recordHealth = opts.recordHealth ?? true;
    const capturePlanUsage = opts.capturePlanUsage ?? true;
    // Read BEFORE the row load (design D5).
    const usageGen = this.usageGeneration(id);
    // Read LIVE each time (a call, so no stale narrowing): the abort can land at any
    // point — during the listing, or while the rows are being written.
    const aborted = (): boolean => opts.signal?.aborted === true;
    const provider = await this.requireProvider(principal, id);
    let models: ModelListing;
    // add-provider-health-signals: health is written ONLY when an authenticated
    // listing call was made — set once the adapter is built. A build-time credential
    // failure has already recorded its own check under the credential lock, so it
    // writes nothing here.
    let listedWith: ProviderIncarnation | null = null;
    try {
      const built = await this.buildAdapter(principal, provider);
      listedWith = built.incarnation;
      const usageCtx = capturePlanUsage ? this.usageContext(provider, usageGen) : undefined;
      const listCtx: CallContext = {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(usageCtx ?? {}),
      };
      models = await built.adapter.listModels(
        Object.keys(listCtx).length > 0 ? listCtx : undefined,
      );
      // A caller that stopped (the scheduled refresh on shutdown) writes nothing.
      if (aborted()) throw new CallCancelledError();
    } catch (err) {
      if (err instanceof UnprocessableEntityException) throw err; // 422 contract

      const sanitized = this.sanitizeThrow(err);
      if (recordHealth && listedWith !== null) {
        await this.recordCheck(principal, id, sanitized, 'sync', listedWith);
      }
      return sanitized;
    }
    const deduped = new Map<string, ProviderModelInfo>();
    // A blank id names no model — never upserted, and never allowed to make an empty
    // listing look non-empty to the reconciliation below (defense in depth: the
    // adapters' parsers drop them too).
    for (const m of models) if (m.id.trim() !== '') deduped.set(m.id, m);
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
    let pruned = 0;
    let attempts = 0;
    const now = new Date();
    for (const m of deduped.values()) {
      if (attempts >= MAX_SYNCED_MODELS) break;
      // A caller that stopped mid-write (the scheduled refresh's deadline or shutdown)
      // stops upserting here; what landed is idempotent, and the reconciliation below
      // is skipped, so a cancelled sync never flags anything.
      if (aborted()) break;
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
    // Unlisted-model reconciliation (add-live-subscription-models): flag every stored
    // model this listing no longer offers, clear every one it does. Against the FULL
    // deduped listing (a model beyond the upsert cap is still offered), and skipped
    // outright when the listing cannot be trusted to be complete and current — empty
    // (a glitch must not flag a whole catalog), at the parse cap (possibly truncated),
    // or from an endpoint the provider has since moved off.
    // The port re-checks, under the provider's row lock, that the credential and
    // endpoint are still the ones this listing was made with (a reconnect to another
    // account must not have its catalog flagged by the old one's listing).
    if (
      !aborted() &&
      deduped.size > 0 &&
      models.truncated !== true &&
      models.length < MAX_PARSED_MODELS &&
      !endpointMoved
    ) {
      const reconciled = await this.db.models.reconcileListing(
        principal,
        provider.id,
        [...deduped.keys()],
        now,
        listedWith,
      );
      // Prune only after a reconcile that APPLIED (so every trust guard above and the
      // incarnation check already held), while this caller is still live, and when the
      // provider's switch was on at the start of the sync; the port re-checks the switch
      // and the incarnation under the provider's row lock. Housekeeping must never fail a
      // sync that has already succeeded, so a failure here logs and reports zero.
      if (reconciled && provider.autoPruneUnlisted && !aborted()) {
        try {
          pruned = await this.db.models.pruneUnlisted(
            principal,
            provider.id,
            new Date(now.getTime() - UNLISTED_PRUNE_AFTER_MS),
            listedWith,
            aborted,
          );
        } catch {
          this.logger.warn('model catalog: pruning retired models failed');
        }
      }
    }
    const result: ActionResult = {
      ok: true,
      status: 'ok',
      message: 'catalog synced',
      traceId: randomUUID(),
      synced,
      pricesCaptured,
      pruned,
    };
    if (recordHealth && listedWith !== null) {
      await this.recordCheck(principal, id, result, 'sync', listedWith);
    }
    return result;
  }

  /** The scheduled catalog refresh's per-provider action (add-live-subscription-
   * models): exactly the manual sync — listing, upsert, reconciliation — writing no
   * health record. Runs under the provider's own owner. */
  refreshCatalog(principal: Principal, id: string, signal?: AbortSignal): Promise<ActionResult> {
    return this.syncModels(principal, id, {
      recordHealth: false,
      capturePlanUsage: false,
      ...(signal !== undefined ? { signal } : {}),
    });
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
  /** Remove a model the provider no longer lists (add-live-subscription-models).
   * 404 when it is not the principal's (or gone), 409 while the provider still lists
   * it — enforced inside the owner-scoped delete, so a concurrent re-listing wins. */
  async removeUnlistedModel(principal: Principal, id: string): Promise<void> {
    const outcome = await this.db.models.removeUnlisted(principal, id);
    if (outcome === 'not_found') throw new NotFoundException();
    if (outcome === 'listed') {
      throw new ConflictException('the provider still lists this model');
    }
  }

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

  /** The shared gate (`base-url-gate.ts`), bound to this instance's deployment mode. */
  private normalizeAndGateBaseUrl(kind: ProviderKind, baseUrl: string): Promise<string> {
    return normalizeAndGateBaseUrl(this.mode, kind, baseUrl);
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
