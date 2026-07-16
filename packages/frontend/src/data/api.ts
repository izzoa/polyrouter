import type { HarnessType } from '@polyrouter/shared';
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
  createdAt: string;
}

export interface CreateProviderInput {
  name: string;
  kind: ApiProviderKind;
  protocol: ApiProviderProtocol;
  baseUrl: string;
  credential?: string;
}

export interface UpdateProviderInput {
  name?: string;
  kind?: ApiProviderKind;
  protocol?: ApiProviderProtocol;
  baseUrl?: string;
  credential?: string;
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

/** Client-side mirror of the server tier cap (§7.4) and the tier header (§7.2).
 * Re-declared here because the frontend cannot import `@polyrouter/shared/server`
 * (the module-boundary lint forbids it), where the canonical constants live. */
export const MAX_MODELS_PER_TIER = 5;
export const TIER_HEADER_NAME = 'x-polyrouter-tier';

/** Rule match types the proxy (#10) understands. The dashboard authors `header`
 * rules; the auto-band / default kinds are surfaced read-only. */
export type RuleMatchType = 'header' | 'default' | 'auto_high' | 'auto_low';

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
export type RequestStatus = 'success' | 'fallback' | 'error';

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
  qualitySignal: number | null;
  modelLabel: string | null;
  providerLabel: string | null;
  agentLabel: string | null;
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

export interface ApiClient {
  me(): Promise<SessionInfo>;
  loginConfig(): Promise<LoginConfig>;
  signInEmail(input: { email: string; password: string }): Promise<void>;
  signUpEmail(input: { name: string; email: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  signInSocial(provider: string, callbackURL: string): Promise<{ url: string }>;
  listAgents(): Promise<AgentDto[]>;
  createAgent(input: { name: string; harness: HarnessType }): Promise<AgentReveal>;
  rotateAgentKey(id: string): Promise<AgentReveal>;
  deleteAgent(id: string): Promise<{ deleted: boolean }>;
  listProviders(): Promise<ProviderDto[]>;
  createProvider(input: CreateProviderInput): Promise<ProviderDto>;
  updateProvider(id: string, patch: UpdateProviderInput): Promise<ProviderDto>;
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
  deleteRule(id: string): Promise<{ deleted: boolean }>;
  getAutoLayers(): Promise<AutoLayers>;
  setAutoLayers(input: { structural: boolean; cascade: boolean }): Promise<AutoLayers>;
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
  timeseries(range: AnalyticsRangeParams, bucket: TimeseriesBucket): Promise<TimeseriesPoint[]>;
  breakdown(
    dimension: BreakdownDimension,
    range: AnalyticsRangeParams,
    limit?: number,
  ): Promise<BreakdownRow[]>;
  requests(query: RequestsQuery): Promise<RequestsPage>;
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
  createProvider: (input) => http<ProviderDto>(`${API_BASE}/providers`, jsonInit('POST', input)),
  updateProvider: (id, patch) =>
    http<ProviderDto>(`${API_BASE}/providers/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),
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
  deleteRule: (id) =>
    http<{ deleted: boolean }>(`${API_BASE}/routing/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  getAutoLayers: () => http<AutoLayers>(`${API_BASE}/routing/auto-layers`),
  setAutoLayers: (input) =>
    http<AutoLayers>(`${API_BASE}/routing/auto-layers`, jsonInit('PUT', input)),
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
};
