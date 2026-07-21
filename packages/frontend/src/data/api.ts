import type { HarnessType, RuleMatchType } from '@polyrouter/shared';
import { API_BASE, PROXY_BASE } from './catalog';

/**
 * Typed `fetch` layer over the real backend (#18). Everything is same-origin in
 * production and Vite-proxied in dev, so paths are RELATIVE (`/api/...`, `/v1/...`)
 * and cookie auth rides along via `credentials: 'include'`. The proxy plane
 * (`/v1`) instead carries an agent key in `Authorization`. The prototype's
 * `BASE_URL` is display-only (snippets) and is never fetched.
 */

/** Normalized error surfaced to the store from any non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type Mode = 'selfhosted' | 'cloud';

export interface SessionInfo {
  userId: string;
  email: string;
  name: string;
  role: string | null;
  mode: Mode;
}

export interface LoginConfig {
  mode: Mode;
  emailPassword: boolean;
  oauthProviders: string[];
  /** Under invite_only the login gate hides public sign-up (user-administration). */
  registration: 'open' | 'invite_only';
}

/** Whitelisted admin user record (user-administration) — identity fields only. */
export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  role: string | null;
  disabled: boolean;
  createdAt: string;
}

export interface AdminInviteDto {
  id: string;
  email: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface IssuedInviteDto {
  invite: AdminInviteDto;
  /** One-time link carrying the raw token — shown once for copy/manual delivery. */
  link: string;
  emailSent: boolean;
}

export interface RegistrationSettingsDto {
  mode: 'open' | 'invite_only';
  smtpConfigured: boolean;
}

export interface AgentDto {
  id: string;
  name: string;
  harness: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Create/rotate carry the raw key + snippet ONCE — held transiently, never stored. */
export interface AgentReveal extends AgentDto {
  key: string;
  snippet: string;
}

export type ApiProviderKind = 'api_key' | 'subscription' | 'custom' | 'local';
export type ApiProviderProtocol = 'openai_compatible' | 'anthropic_compatible';
export type ProviderStatus = 'unknown' | 'ok' | 'error';

export interface ProviderDto {
  id: string;
  name: string;
  kind: string;
  protocol: string;
  baseUrl: string | null;
  status: string;
  hasCredential: boolean;
  /** Subscription-OAuth display/state metadata (non-secret; add-subscription-oauth). */
  oauthPreset: string | null;
  credentialExpiresAt: string | null;
  credentialError: string | null;
  /** Upstream patience overrides (fix-long-call-timeouts); null = inherit. */
  firstByteTimeoutMs: number | null;
  idleTimeoutMs: number | null;
  createdAt: string;
}

/** The instance timeout defaults (fix-long-call-timeouts) — for honest
 * inherit display in the provider form. */
export interface TimeoutDefaults {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
}

/** An enabled subscription-OAuth preset (server-driven card list). */
export interface OauthPresetDto {
  id: string;
  displayName: string;
}

export interface OauthStartResult {
  sessionId: string;
  authorizeUrl: string;
}

export interface CreateProviderInput {
  name: string;
  kind: ApiProviderKind;
  protocol: ApiProviderProtocol;
  baseUrl: string;
  credential?: string;
  firstByteTimeoutMs?: number | null;
  idleTimeoutMs?: number | null;
}

export interface UpdateProviderInput {
  name?: string;
  kind?: ApiProviderKind;
  protocol?: ApiProviderProtocol;
  baseUrl?: string;
  credential?: string;
  /** Explicit null clears back to inherit; omitted preserves. */
  firstByteTimeoutMs?: number | null;
  idleTimeoutMs?: number | null;
}

/** Provenance of a model's effective display price. `listed` is the display-only
 * provider-listed estimate; the rest are billing-resolver sources. */
export type EffectivePriceSource =
  'model' | 'local' | 'bundled' | 'refresh' | 'manual' | 'native_family' | 'listed';

/** A model's current effective price for display (backend-resolved). `estimated` is
 * true for the `listed` provider estimate and the `native_family` fallback
 * (add-native-price-fallback). Never a billing/cost value. */
export interface EffectivePrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
  isFree: boolean;
  source: EffectivePriceSource;
  estimated: boolean;
}

export interface ModelDto {
  id: string;
  providerId: string;
  externalModelId: string;
  displayName: string | null;
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  isFree: boolean;
  inputPricePer1m: number | null;
  outputPricePer1m: number | null;
  effectivePrice: EffectivePrice | null;
  /** The captured provider-listed channel estimate — always exposed when captured,
   * shown alongside a `native_family` effective price. Display only. */
  listedPrice: {
    inputPricePer1m: number;
    outputPricePer1m: number;
    isFree: boolean;
    capturedAt: string | null;
  } | null;
  lastSyncedAt: string | null;
}

/** Exactly one of these two shapes (enforced server-side, request-shape 422). */
export type ModelPricingInput =
  { isFree: true } | { inputPricePer1m: number; outputPricePer1m: number };

/** Sanitized provider action result — HTTP 200 even on failure; branch on `ok`. */
export interface ActionResult {
  ok: boolean;
  status: 'ok' | 'error';
  kind?: string;
  message: string;
  traceId: string;
  synced?: number;
}

export interface TierDto {
  id: string;
  key: string;
  displayName: string | null;
  description: string | null;
  createdAt: string;
}

export interface TierEntryModel {
  id: string;
  providerId: string;
  externalModelId: string;
  displayName: string | null;
}

export interface TierEntryDto {
  id: string;
  tierId: string;
  modelId: string;
  position: number;
  model: TierEntryModel | null;
}

// --- Config surfaces (#20) — tiers / rules / budgets / channels / auto-layers ---

export interface CreateTierInput {
  key: string;
  displayName?: string;
  description?: string;
}

export interface UpdateTierInput {
  displayName?: string;
  description?: string;
}

/** The CANONICAL routing constants, re-exported from the browser-safe shared
 * root (add-band-target-ui) — the client-side mirror is gone: one source of
 * truth for the cap, the header, and the rule kinds. */
export { MAX_MODELS_PER_TIER, TIER_HEADER_NAME } from '@polyrouter/shared';
export type { RuleMatchType } from '@polyrouter/shared';

export interface RuleDto {
  id: string;
  matchType: string;
  headerName: string;
  headerValue: string | null;
  target: string;
  priority: number;
  createdAt: string;
}

export interface CreateRuleInput {
  matchType: RuleMatchType;
  headerName?: string;
  headerValue?: string;
  target: string;
  priority?: number;
}

export type BudgetScope = 'global' | 'agent';
export type BudgetWindow = 'day' | 'week' | 'month';
export type BudgetAction = 'alert' | 'block';

/** The API view of a budget (no secrets; channel ids as an array). */
export interface BudgetDto {
  id: string;
  name: string;
  scope: string;
  agentId: string | null;
  window: string;
  action: string;
  amount: number;
  notifyChannelIds: string[];
  enabled: boolean;
  createdAt: string;
}

export interface CreateBudgetInput {
  name: string;
  scope: BudgetScope;
  agentId?: string;
  window: BudgetWindow;
  action: BudgetAction;
  amount: number;
  notifyChannelIds?: string[];
  enabled?: boolean;
}

export type UpdateBudgetInput = Partial<CreateBudgetInput>;

export type ChannelKind = 'smtp' | 'apprise';
export type SmtpSecure = 'none' | 'starttls' | 'tls';

/** Notification event types a channel can subscribe to (#15a). Mirrors the
 * server `EVENT_TYPES` (a server-only module the frontend can't import). */
export const EVENT_TYPES = [
  'budget_alert',
  'budget_block',
  'provider_down',
  'request_failures_spike',
  'weekly_spend_summary',
  'test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The channel's safe view — never the decrypted config (invariant 8). */
export interface ChannelDto {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  eventsSubscribed: string[];
  hasConfig: boolean;
  lastTestAt: string | null;
  lastTestStatus: string | null;
}

/** Write-only, kind-specific channel config sent on create/edit; never returned. */
export interface SmtpChannelConfig {
  host: string;
  port: number;
  secure: SmtpSecure;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}
export interface AppriseChannelConfig {
  urls: string[];
}
export type ChannelConfigInput = SmtpChannelConfig | AppriseChannelConfig;

export interface CreateChannelInput {
  name: string;
  kind: ChannelKind;
  enabled?: boolean;
  eventsSubscribed: EventType[];
  config: ChannelConfigInput;
}

export interface UpdateChannelInput {
  name?: string;
  kind?: ChannelKind;
  enabled?: boolean;
  eventsSubscribed?: EventType[];
  config?: ChannelConfigInput;
}

/** Sanitized test-send result — HTTP 200 even on failure; branch on `ok`. */
export interface ChannelTestResult {
  ok: boolean;
  error?: string;
}

/** Effective auto-layer flags + the instance capability (#20). A layer whose
 * `*Available` is false is off instance-wide (`ROUTING_AUTO_LAYERS`). */
export interface AutoLayers {
  structural: boolean;
  cascade: boolean;
  structuralAvailable: boolean;
  cascadeAvailable: boolean;
  /** Threshold-calibration state (add-auto-threshold-calibration): the pair
   * is null when uncalibrated OR inert; effective always reflects what the
   * router actually uses. */
  calibration: {
    enabled: boolean;
    calibratedHigh: number | null;
    calibratedLow: number | null;
    instanceHigh: number;
    instanceLow: number;
    effectiveHigh: number;
    effectiveLow: number;
  };
}

/** One threshold-change audit row — full numeric before/after pairs (never
 * null-as-instance), newest first from the API. */
export interface CalibrationEvent {
  id: string;
  trigger: 'calibrator' | 'revert' | 'rebase';
  oldHigh: number;
  oldLow: number;
  newHigh: number;
  newLow: number;
  anchorHigh: number;
  anchorLow: number;
  windowFrom: string | null;
  windowTo: string | null;
  edge: 'high' | 'low' | null;
  edgeSamples: number | null;
  edgeFailures: number | null;
  reason: string;
  createdAt: string;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ProxyTestBody {
  model: string;
  messages: ChatMessage[];
}

/** Loosely-typed OpenAI completion — enough to render the assistant reply/usage. */
export interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: { message?: { role?: string; content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// --- Analytics (#17 `/api/analytics`) — the safe wire shapes the UI consumes ---

/** ISO `[from, to)` window the analytics reads filter by. */
export interface AnalyticsRangeParams {
  from: string;
  to: string;
}

export type TimeseriesBucket = 'hour' | 'day' | 'week' | 'month';
export type BreakdownDimension = 'model' | 'provider' | 'agent' | 'tier';
/** Served-request status as recorded in the log (fallback/error included). */
export type RequestStatus = 'success' | 'fallback' | 'error' | 'cancelled';

/** `GET /summary` — owner-scoped aggregates over the range. `spend` is USD (both
 * ledgers, µ$-rounded so it reconciles with budgets); free/paid/unpriced classify
 * served requests by cost 0 / >0 / null. */
export interface AnalyticsSummary {
  spend: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  successCount: number;
  fallbackCount: number;
  errorCount: number;
  escalatedCount: number;
  estimatedCount: number;
  freeRequests: number;
  paidRequests: number;
  unpricedRequests: number;
  /** USD portion of `spend` priced by the native-family estimate (component-only). */
  nativeFamilySpend: number;
}

/** `GET /timeseries` — one point per non-empty bucket, ascending. `bucket` is an
 * ISO string (UTC-aligned bucket start). */
export interface TimeseriesPoint {
  bucket: string;
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  errorCount: number;
  fallbackCount: number;
  escalatedCount: number;
}

/** `GET /breakdown` — top-N by spend desc. `key` is the dimension id (`''` for a
 * null dimension); `label` is the owner-scoped human label (null if deleted). */
export interface BreakdownRow {
  key: string;
  label: string | null;
  spend: number;
  requests: number;
}

/** One `GET /requests` row — #17's safe view EXACTLY (no owner columns). Ids,
 * labels, tier, cache tokens, cost, quality signal and all four price snapshots
 * are nullable; `createdAt` is an ISO string; snapshots are $/1M, rendered never
 * recomputed (invariant 4). */
export interface RequestRow {
  id: string;
  createdAt: string;
  agentId: string | null;
  providerId: string | null;
  modelId: string | null;
  tierAssigned: string | null;
  decisionLayer: string;
  routingReason: string;
  /** The header that CHOSE the route (add-routing-header-visibility): name +
   * matched tier key for the built-in header; name with null value for a custom
   * rule (its configured value is never recorded); both null for other layers
   * and legacy rows. */
  routingHeaderName: string | null;
  routingHeaderValue: string | null;
  status: RequestStatus;
  escalated: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputPriceSnapshot: number | null;
  outputPriceSnapshot: number | null;
  cacheReadPriceSnapshot: number | null;
  cacheWritePriceSnapshot: number | null;
  cost: number | null;
  attemptCostMicros: number;
  durationMs: number;
  usageEstimated: boolean;
  /** Served row's snapshot provenance; null = unpriced or predates the column. */
  priceSource: string | null;
  /** True when the served row OR any attempt was priced `native_family`. */
  priceEstimated: boolean;
  qualitySignal: number | null;
  modelLabel: string | null;
  providerLabel: string | null;
  agentLabel: string | null;
  /** L1 decision telemetry (add-auto-decision-telemetry): the structural
   * verdict when the layer evaluated the request; all null otherwise. */
  structuralBand: string | null;
  structuralScore: number | null;
  structuralBandSource: string | null;
  /** L2 decision telemetry (add-semantic-routing): the semantic verdict when
   * Layer 2 evaluated the request; all four null otherwise. */
  semanticBand: string | null;
  semanticScore: number | null;
  semanticSource: string | null;
  semanticRevision: string | null;
  /** Terminal provider-error detail (add-request-error-detail): non-null only on
   * `status='error'` rows recorded after capture landed; all null otherwise. */
  errorKind: string | null;
  errorStatus: number | null;
  errorMessage: string | null;
  errorRequestId: string | null;
  /** add-body-capture: this request has stored bodies (content NEVER rides the
   * listing — the inspector fetches lazily via `requestBodies`). */
  hasBodies: boolean;
}

/** The auto-performance aggregation (add-auto-performance-view) — the AR-3
 * telemetry columns aggregated server-side; savings is a labeled display
 * counterfactual or null (never a fabricated zero). */
export interface AutoPerformance {
  evaluated: number;
  bands: {
    high: { requests: number; declared: number; unroutable: number };
    low: { requests: number; declared: number; unroutable: number };
    ambiguous: { requests: number };
  };
  cascade: {
    requests: number;
    qualityPassed: number;
    qualityUnknown: number;
    failedOrCancelled: number;
    escalated: number;
  };
  fallthrough: number;
  series: { bucket: string; high: number; low: number; ambiguous: number }[];
  telemetrySince: string | null;
  savings: {
    /** Null when zero rows were costable — unknown, never $0. */
    netUsd: number | null;
    grossUsd: number | null;
    excessUsd: number | null;
    rows: number;
    uncostedRows: number;
    basis: { kind: 'tier' | 'model'; label: string; model: string };
  } | null;
}

export interface RequestsPage {
  rows: RequestRow[];
  nextCursor: string | null;
}

/** A `GET /requests` query. `decisionLayers` is sent as a comma-separated `layer`
 * param (the dashboard's multi-value chips); undefined fields are omitted. */
export interface RequestsQuery {
  from: string;
  to: string;
  limit?: number;
  cursor?: string;
  status?: string;
  decisionLayers?: string[];
  escalated?: boolean;
}

/** Micros-exact total request cost = served `cost` (µ$) + this request's attempt
 * ledger (µ$). Integer so it reconciles with summary/budget spend. A null served
 * cost contributes 0 here; the UI distinguishes "unpriced" from `$0.00` upstream. */
export function totalCostMicros(row: { cost: number | null; attemptCostMicros: number }): number {
  return Math.round((row.cost ?? 0) * 1_000_000) + row.attemptCostMicros;
}

/** Format a µ$ integer as a dollar string (per-request precision). */
export function fmtMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/** Owner-scoped label with the documented fallback: label → id → 'unknown'. */
export function labelOf(label: string | null, id: string | null): string {
  return label ?? id ?? 'unknown';
}

/** Catalog status (add-pricing-refresh-ui) — global, non-secret metadata. */
export interface PricingStatus {
  entryCount: number;
  newest: { source: string; validFrom: string; appliedAt: string } | null;
  lastRefresh: { at: string; added: number; skipped: number } | null;
  scheduler: {
    configuredEnabled: boolean;
    modePermitted: boolean;
    effectiveEnabled: boolean;
    cron: string;
  };
}

/** Body-capture settings + status (add-body-capture). */
export interface BodyCaptureStatus {
  mode: 'off' | 'errors_only' | 'all';
  retentionDays: number | null;
  droppedCount: number;
  lastPurgeAt: string | null;
  lastPurgeCount: number;
  available: boolean;
  agents: { id: string; name: string; override: 'always' | 'never' | null }[];
}

/** One decrypted body direction for the inspector's Payload section. */
export interface RequestBodyContent {
  direction: 'request' | 'response';
  content: string;
  bytes: number;
  truncated: boolean;
  partial: boolean;
}

export interface ApiClient {
  me(): Promise<SessionInfo>;
  loginConfig(): Promise<LoginConfig>;
  acceptInvite(input: { token: string; name: string; password: string }): Promise<void>;
  adminListUsers(): Promise<AdminUserDto[]>;
  adminSetRole(userId: string, role: 'admin' | null): Promise<void>;
  adminSetDisabled(userId: string, disabled: boolean): Promise<void>;
  adminDeleteUser(userId: string): Promise<void>;
  adminCreateInvite(email: string): Promise<IssuedInviteDto>;
  adminListInvites(): Promise<AdminInviteDto[]>;
  adminRevokeInvite(inviteId: string): Promise<void>;
  adminGetRegistration(): Promise<RegistrationSettingsDto>;
  adminSetRegistration(mode: 'open' | 'invite_only'): Promise<void>;
  signInEmail(input: { email: string; password: string }): Promise<void>;
  signUpEmail(input: { name: string; email: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  signInSocial(provider: string, callbackURL: string): Promise<{ url: string }>;
  listAgents(): Promise<AgentDto[]>;
  createAgent(input: { name: string; harness: HarnessType }): Promise<AgentReveal>;
  rotateAgentKey(id: string): Promise<AgentReveal>;
  deleteAgent(id: string): Promise<{ deleted: boolean }>;
  listProviders(): Promise<ProviderDto[]>;
  providerTimeoutDefaults(): Promise<TimeoutDefaults>;
  createProvider(input: CreateProviderInput): Promise<ProviderDto>;
  updateProvider(id: string, patch: UpdateProviderInput): Promise<ProviderDto>;
  listOauthPresets(): Promise<OauthPresetDto[]>;
  oauthStart(preset: string, name?: string): Promise<OauthStartResult>;
  /** `pasted` is credential material — sent once, never stored client-side. */
  oauthComplete(sessionId: string, pasted: string): Promise<ProviderDto>;
  oauthReauthorize(providerId: string): Promise<OauthStartResult>;
  deleteProvider(id: string): Promise<{ deleted: boolean }>;
  testProvider(id: string): Promise<ActionResult>;
  syncModels(id: string): Promise<ActionResult>;
  listModels(providerId?: string): Promise<ModelDto[]>;
  updateModelPricing(id: string, body: ModelPricingInput): Promise<ModelDto>;
  listTiers(): Promise<TierDto[]>;
  createTier(input: CreateTierInput): Promise<TierDto>;
  updateTier(id: string, patch: UpdateTierInput): Promise<TierDto>;
  deleteTier(id: string): Promise<{ deleted: boolean }>;
  listTierEntries(tierId: string): Promise<TierEntryDto[]>;
  replaceTierEntries(tierId: string, modelIds: string[]): Promise<TierEntryDto[]>;
  listRules(): Promise<RuleDto[]>;
  createRule(input: CreateRuleInput): Promise<RuleDto>;
  updateRule(id: string, patch: { target: string }): Promise<RuleDto>;
  deleteRule(id: string): Promise<{ deleted: boolean }>;
  getAutoLayers(): Promise<AutoLayers>;
  setAutoLayers(input: {
    structural: boolean;
    cascade: boolean;
    calibration?: boolean;
  }): Promise<AutoLayers>;
  calibrationRevert(): Promise<AutoLayers>;
  calibrationHistory(limit?: number): Promise<CalibrationEvent[]>;
  pricingStatus(): Promise<PricingStatus>;
  pricingRefresh(): Promise<{ added: number }>;
  listBudgets(): Promise<BudgetDto[]>;
  createBudget(input: CreateBudgetInput): Promise<BudgetDto>;
  updateBudget(id: string, patch: UpdateBudgetInput): Promise<BudgetDto>;
  deleteBudget(id: string): Promise<{ deleted: boolean }>;
  listChannels(): Promise<ChannelDto[]>;
  createChannel(input: CreateChannelInput): Promise<ChannelDto>;
  updateChannel(id: string, patch: UpdateChannelInput): Promise<ChannelDto>;
  deleteChannel(id: string): Promise<{ deleted: boolean }>;
  testChannel(id: string): Promise<ChannelTestResult>;
  proxyTest(agentKey: string, body: ProxyTestBody): Promise<ChatCompletion>;
  summary(range: AnalyticsRangeParams): Promise<AnalyticsSummary>;
  autoPerformance(range: AnalyticsRangeParams, bucket: TimeseriesBucket): Promise<AutoPerformance>;
  timeseries(range: AnalyticsRangeParams, bucket: TimeseriesBucket): Promise<TimeseriesPoint[]>;
  breakdown(
    dimension: BreakdownDimension,
    range: AnalyticsRangeParams,
    limit?: number,
  ): Promise<BreakdownRow[]>;
  requests(query: RequestsQuery): Promise<RequestsPage>;
  bodyCaptureStatus(): Promise<BodyCaptureStatus>;
  bodyCaptureUpdate(patch: {
    mode?: 'off' | 'errors_only' | 'all';
    retentionDays?: number | null;
    keepForever?: boolean;
  }): Promise<BodyCaptureStatus>;
  bodyCapturePurge(): Promise<{ purged: number }>;
  bodyCaptureSetOverride(agentId: string, override: 'always' | 'never' | null): Promise<void>;
  requestBodies(requestId: string): Promise<RequestBodyContent[]>;
  deleteRequestBodies(requestId: string): Promise<void>;
}

/** Build a `?a=b&…` query string, omitting undefined params and joining an array
 * (`decisionLayers`) as a comma list. Empty string when there is nothing to send. */
type QueryValue = string | number | boolean | readonly string[] | undefined;
function queryString(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      sp.set(key, value.join(','));
    } else {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function pickString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' ? v : null;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = res.statusText || 'error';
  let message = res.statusText || `HTTP ${String(res.status)}`;
  try {
    const text = await res.text();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        // Nest envelope is { statusCode, error, message }; Better Auth is { code, message }.
        code = pickString(rec, 'error') ?? pickString(rec, 'code') ?? code;
        const m = rec['message'];
        if (typeof m === 'string') message = m;
        else if (Array.isArray(m)) {
          message = m.filter((x): x is string => typeof x === 'string').join(', ') || message;
        }
      }
    }
  } catch {
    // Non-JSON error body — keep the status line.
  }
  return new ApiError(res.status, code, message);
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;
  return parsed as T;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init });
  if (!res.ok) throw await toApiError(res);
  return readJson<T>(res);
}

function jsonInit(
  method: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** The production client. Injectable so tests can swap a `FakeApiClient`. */
export const realClient: ApiClient = {
  me: () => http<SessionInfo>(`${API_BASE}/me`),
  loginConfig: () => http<LoginConfig>(`${API_BASE}/login-config`),
  acceptInvite: (input) => http<void>(`${API_BASE}/invites/accept`, jsonInit('POST', input)),
  adminListUsers: () => http<AdminUserDto[]>(`${API_BASE}/admin/users`),
  adminSetRole: (userId, role) =>
    http<void>(`${API_BASE}/admin/users/${userId}/role`, jsonInit('PATCH', { role })),
  adminSetDisabled: (userId, disabled) =>
    http<void>(`${API_BASE}/admin/users/${userId}/disabled`, jsonInit('PATCH', { disabled })),
  adminDeleteUser: (userId) =>
    http<void>(`${API_BASE}/admin/users/${userId}`, { method: 'DELETE' }),
  adminCreateInvite: (email) =>
    http<IssuedInviteDto>(`${API_BASE}/admin/invites`, jsonInit('POST', { email })),
  adminListInvites: () => http<AdminInviteDto[]>(`${API_BASE}/admin/invites`),
  adminRevokeInvite: (inviteId) =>
    http<void>(`${API_BASE}/admin/invites/${inviteId}`, { method: 'DELETE' }),
  adminGetRegistration: () =>
    http<RegistrationSettingsDto>(`${API_BASE}/admin/settings/registration`),
  adminSetRegistration: (mode) =>
    http<{ mode: string }>(
      `${API_BASE}/admin/settings/registration`,
      jsonInit('PUT', { mode }),
    ).then(() => undefined),
  signInEmail: (input) => http<void>(`${API_BASE}/auth/sign-in/email`, jsonInit('POST', input)),
  signUpEmail: (input) => http<void>(`${API_BASE}/auth/sign-up/email`, jsonInit('POST', input)),
  signOut: () => http<void>(`${API_BASE}/auth/sign-out`, jsonInit('POST', {})),
  signInSocial: (provider, callbackURL) =>
    http<{ url: string }>(
      `${API_BASE}/auth/sign-in/social`,
      jsonInit('POST', { provider, callbackURL }),
    ),
  listAgents: () => http<AgentDto[]>(`${API_BASE}/agents`),
  createAgent: (input) => http<AgentReveal>(`${API_BASE}/agents`, jsonInit('POST', input)),
  rotateAgentKey: (id) =>
    http<AgentReveal>(
      `${API_BASE}/agents/${encodeURIComponent(id)}/rotate-key`,
      jsonInit('POST', {}),
    ),
  deleteAgent: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  listProviders: () => http<ProviderDto[]>(`${API_BASE}/providers`),
  providerTimeoutDefaults: () => http<TimeoutDefaults>(`${API_BASE}/providers/timeout-defaults`),
  createProvider: (input) => http<ProviderDto>(`${API_BASE}/providers`, jsonInit('POST', input)),
  updateProvider: (id, patch) =>
    http<ProviderDto>(`${API_BASE}/providers/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),
  listOauthPresets: () => http<OauthPresetDto[]>(`${API_BASE}/providers/oauth/presets`),
  oauthStart: (preset, name) =>
    http<OauthStartResult>(
      `${API_BASE}/providers/oauth/start`,
      jsonInit('POST', name !== undefined ? { preset, name } : { preset }),
    ),
  oauthComplete: (sessionId, pasted) =>
    http<ProviderDto>(
      `${API_BASE}/providers/oauth/complete`,
      jsonInit('POST', { sessionId, pasted }),
    ),
  oauthReauthorize: (providerId) =>
    http<OauthStartResult>(
      `${API_BASE}/providers/oauth/reauthorize/${encodeURIComponent(providerId)}`,
      jsonInit('POST', {}),
    ),
  deleteProvider: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  testProvider: (id) =>
    http<ActionResult>(
      `${API_BASE}/providers/${encodeURIComponent(id)}/test-connection`,
      jsonInit('POST', {}),
    ),
  syncModels: (id) =>
    http<ActionResult>(
      `${API_BASE}/providers/${encodeURIComponent(id)}/sync-models`,
      jsonInit('POST', {}),
    ),
  listModels: (providerId) =>
    http<ModelDto[]>(
      `${API_BASE}/models${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ''}`,
    ),
  updateModelPricing: (id, body) =>
    http<ModelDto>(`${API_BASE}/models/${encodeURIComponent(id)}`, jsonInit('PATCH', body)),
  listTiers: () => http<TierDto[]>(`${API_BASE}/routing/tiers`),
  createTier: (input) => http<TierDto>(`${API_BASE}/routing/tiers`, jsonInit('POST', input)),
  updateTier: (id, patch) =>
    http<TierDto>(`${API_BASE}/routing/tiers/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),
  deleteTier: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/routing/tiers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  listTierEntries: (tierId) =>
    http<TierEntryDto[]>(`${API_BASE}/routing/tiers/${encodeURIComponent(tierId)}/entries`),
  replaceTierEntries: (tierId, modelIds) =>
    http<TierEntryDto[]>(
      `${API_BASE}/routing/tiers/${encodeURIComponent(tierId)}/entries`,
      jsonInit('PUT', { modelIds }),
    ),
  listRules: () => http<RuleDto[]>(`${API_BASE}/routing/rules`),
  createRule: (input) => http<RuleDto>(`${API_BASE}/routing/rules`, jsonInit('POST', input)),
  updateRule: (id, patch) =>
    http<RuleDto>(`${API_BASE}/routing/rules/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),
  deleteRule: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/routing/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  getAutoLayers: () => http<AutoLayers>(`${API_BASE}/routing/auto-layers`),
  setAutoLayers: (input) =>
    http<AutoLayers>(`${API_BASE}/routing/auto-layers`, jsonInit('PUT', input)),
  calibrationRevert: () =>
    http<AutoLayers>(`${API_BASE}/routing/calibration/revert`, { method: 'POST' }),
  pricingStatus: () => http<PricingStatus>(`${API_BASE}/pricing/status`),
  pricingRefresh: () =>
    http<{ added: number }>(`${API_BASE}/pricing/refresh`, jsonInit('POST', { source: 'litellm' })),
  calibrationHistory: (limit) =>
    http<CalibrationEvent[]>(
      `${API_BASE}/routing/calibration/history${limit !== undefined ? `?limit=${String(limit)}` : ''}`,
    ),
  listBudgets: () => http<BudgetDto[]>(`${API_BASE}/budgets`),
  createBudget: (input) => http<BudgetDto>(`${API_BASE}/budgets`, jsonInit('POST', input)),
  updateBudget: (id, patch) =>
    http<BudgetDto>(`${API_BASE}/budgets/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),
  deleteBudget: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/budgets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  listChannels: () => http<ChannelDto[]>(`${API_BASE}/notification-channels`),
  createChannel: (input) =>
    http<ChannelDto>(`${API_BASE}/notification-channels`, jsonInit('POST', input)),
  updateChannel: (id, patch) =>
    http<ChannelDto>(
      `${API_BASE}/notification-channels/${encodeURIComponent(id)}`,
      jsonInit('PATCH', patch),
    ),
  deleteChannel: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/notification-channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  testChannel: (id) =>
    http<ChannelTestResult>(
      `${API_BASE}/notification-channels/${encodeURIComponent(id)}/test`,
      jsonInit('POST', {}),
    ),
  proxyTest: (agentKey, body) =>
    http<ChatCompletion>(
      `${PROXY_BASE}/chat/completions`,
      jsonInit('POST', body, { authorization: `Bearer ${agentKey}` }),
    ),
  summary: (range) =>
    http<AnalyticsSummary>(
      `${API_BASE}/analytics/summary${queryString({ from: range.from, to: range.to })}`,
    ),
  autoPerformance: (range, bucket) =>
    http<AutoPerformance>(
      `${API_BASE}/analytics/auto${queryString({ from: range.from, to: range.to, bucket })}`,
    ),
  timeseries: (range, bucket) =>
    http<TimeseriesPoint[]>(
      `${API_BASE}/analytics/timeseries${queryString({ from: range.from, to: range.to, bucket })}`,
    ),
  breakdown: (dimension, range, limit) =>
    http<BreakdownRow[]>(
      `${API_BASE}/analytics/breakdown${queryString({ dimension, from: range.from, to: range.to, limit })}`,
    ),
  requests: (query) =>
    http<RequestsPage>(
      `${API_BASE}/analytics/requests${queryString({
        from: query.from,
        to: query.to,
        limit: query.limit,
        cursor: query.cursor,
        status: query.status,
        layer: query.decisionLayers,
        escalated: query.escalated,
      })}`,
    ),
  bodyCaptureStatus: () => http<BodyCaptureStatus>(`${API_BASE}/body-capture`),
  bodyCaptureUpdate: (patch) =>
    http<BodyCaptureStatus>(`${API_BASE}/body-capture`, jsonInit('PATCH', patch)),
  bodyCapturePurge: () =>
    http<{ purged: number }>(`${API_BASE}/body-capture/purge`, jsonInit('POST', {})),
  bodyCaptureSetOverride: async (agentId, override) => {
    await http<{ ok: true }>(
      `${API_BASE}/body-capture/agents/${encodeURIComponent(agentId)}/override`,
      jsonInit('PATCH', { override }),
    );
  },
  requestBodies: (requestId) =>
    http<RequestBodyContent[]>(
      `${API_BASE}/analytics/requests/${encodeURIComponent(requestId)}/bodies`,
    ),
  deleteRequestBodies: async (requestId) => {
    await http<{ ok: true }>(
      `${API_BASE}/analytics/requests/${encodeURIComponent(requestId)}/bodies`,
      { method: 'DELETE' },
    );
  },
};
