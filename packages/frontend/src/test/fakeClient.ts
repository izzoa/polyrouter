import { ApiError } from '../data/api';
import type {
  ActionResult,
  AgentDto,
  AgentReveal,
  AnalyticsRangeParams,
  AnalyticsSummary,
  ApiClient,
  BreakdownDimension,
  BreakdownRow,
  ChatCompletion,
  CreateProviderInput,
  LoginConfig,
  ModelDto,
  ModelPricingInput,
  ProviderDto,
  ProxyTestBody,
  RequestRow,
  RequestsPage,
  RequestsQuery,
  RequestStatus,
  SessionInfo,
  TierDto,
  TierEntryDto,
  TimeseriesBucket,
  TimeseriesPoint,
  UpdateProviderInput,
} from '../data/api';

export const DEFAULT_SESSION: SessionInfo = {
  userId: 'u1',
  email: 'admin@localhost',
  name: 'Admin',
  role: 'admin',
  mode: 'selfhosted',
};

export const DEFAULT_LOGIN_CONFIG: LoginConfig = {
  mode: 'selfhosted',
  emailPassword: true,
  oauthProviders: [],
};

const NOW = '2026-07-15T00:00:00.000Z';

export const DEFAULT_SUMMARY: AnalyticsSummary = {
  spend: 12.5,
  requests: 30,
  inputTokens: 120_000,
  outputTokens: 45_000,
  cacheReadTokens: 3_000,
  cacheWriteTokens: 1_500,
  successCount: 24,
  fallbackCount: 4,
  errorCount: 2,
  escalatedCount: 6,
  estimatedCount: 3,
  freeRequests: 8,
  paidRequests: 20,
  unpricedRequests: 2,
};

export const DEFAULT_TIMESERIES: TimeseriesPoint[] = [
  {
    bucket: '2026-07-15T00:00:00.000Z',
    requests: 5,
    spend: 2,
    inputTokens: 20_000,
    outputTokens: 8_000,
    errorCount: 0,
    fallbackCount: 1,
    escalatedCount: 1,
  },
  {
    bucket: '2026-07-15T01:00:00.000Z',
    requests: 8,
    spend: 3.5,
    inputTokens: 32_000,
    outputTokens: 12_000,
    errorCount: 1,
    fallbackCount: 0,
    escalatedCount: 2,
  },
  {
    bucket: '2026-07-15T02:00:00.000Z',
    requests: 6,
    spend: 2.4,
    inputTokens: 24_000,
    outputTokens: 9_000,
    errorCount: 0,
    fallbackCount: 2,
    escalatedCount: 1,
  },
  {
    bucket: '2026-07-15T03:00:00.000Z',
    requests: 11,
    spend: 4.6,
    inputTokens: 44_000,
    outputTokens: 16_000,
    errorCount: 1,
    fallbackCount: 1,
    escalatedCount: 2,
  },
];

function defaultBreakdown(): Record<BreakdownDimension, BreakdownRow[]> {
  return {
    model: [
      { key: 'model-0', label: 'Model 0', spend: 6.2, requests: 12 },
      { key: 'model-1', label: 'Model 1', spend: 3.1, requests: 8 },
      { key: 'model-2', label: 'Model 2', spend: 1.9, requests: 6 },
    ],
    provider: [
      { key: 'prov-0', label: 'Provider 0', spend: 7.4, requests: 16 },
      { key: 'prov-1', label: 'Provider 1', spend: 5.1, requests: 14 },
    ],
    agent: [
      { key: 'agent-0', label: 'agent-0', spend: 5.0, requests: 11 },
      { key: 'agent-1', label: 'agent-1', spend: 4.2, requests: 10 },
      { key: '', label: null, spend: 3.3, requests: 9 },
    ],
    tier: [{ key: 'default', label: 'default', spend: 12.5, requests: 30 }],
  };
}

/** A deterministic corpus (newest-first by `createdAt`) with a spread of layers,
 * statuses, escalation, estimated usage, null costs and price snapshots — enough
 * to exercise pagination + server-side filtering + the inspector's distinctions. */
export function buildRequestRows(n: number): RequestRow[] {
  const layers = ['explicit', 'header', 'default', 'structural', 'cascade'];
  const statuses: RequestStatus[] = ['success', 'success', 'fallback', 'error'];
  const base = Date.parse(NOW);
  const rows: RequestRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const layer = layers[i % layers.length] ?? 'explicit';
    const status = statuses[i % statuses.length] ?? 'success';
    const unpriced = i % 6 === 0;
    const free = !unpriced && i % 5 === 0;
    rows.push({
      id: `req-${String(i).padStart(3, '0')}`,
      createdAt: new Date(base - i * 60_000).toISOString(),
      agentId: `agent-${String(i % 3)}`,
      providerId: `prov-${String(i % 2)}`,
      modelId: `model-${String(i % 4)}`,
      tierAssigned: i % 5 === 0 ? null : 'default',
      decisionLayer: layer,
      routingReason: `reason for ${layer} #${String(i)}`,
      status,
      escalated: layer === 'cascade',
      inputTokens: 100 + i * 3,
      outputTokens: 40 + i,
      cacheReadTokens: i % 4 === 0 ? null : i,
      cacheWriteTokens: i % 3 === 0 ? null : i * 2,
      inputPriceSnapshot: unpriced ? null : free ? 0 : 1.5,
      outputPriceSnapshot: unpriced ? null : free ? 0 : 6,
      cacheReadPriceSnapshot: i % 4 === 0 ? null : 0.3,
      cacheWritePriceSnapshot: i % 3 === 0 ? null : 0.6,
      cost: unpriced ? null : free ? 0 : 0.001 * (i + 1),
      attemptCostMicros: i % 7 === 0 ? 250 : 0,
      durationMs: 500 + i * 10,
      usageEstimated: i % 8 === 0,
      qualitySignal: i % 3 === 0 ? null : 0.7,
      modelLabel: `Model ${String(i % 4)}`,
      providerLabel: `Provider ${String(i % 2)}`,
      agentLabel: `agent-${String(i % 3)}`,
    });
  }
  return rows;
}

export interface FakeOptions {
  session?: SessionInfo | null;
  meFailure?: ApiError | null;
  loginConfig?: LoginConfig;
  agents?: AgentDto[];
  providers?: ProviderDto[];
  models?: Record<string, ModelDto[]>;
  tiers?: TierDto[];
  testResult?: ActionResult;
  syncResult?: ActionResult;
  proxyResult?: ChatCompletion;
  proxyFailure?: ApiError | null;
  summary?: AnalyticsSummary;
  timeseries?: TimeseriesPoint[];
  breakdown?: Record<BreakdownDimension, BreakdownRow[]>;
  requestRows?: RequestRow[];
  /** When set, every analytics read rejects (exercise the error/retry states). */
  analyticsFailure?: ApiError | null;
}

function okResult(synced?: number): ActionResult {
  return synced === undefined
    ? { ok: true, status: 'ok', message: 'connection ok', traceId: 't' }
    : { ok: true, status: 'ok', message: 'catalog synced', traceId: 't', synced };
}

function fakeModel(providerId: string, n: number): ModelDto {
  return {
    id: `model-${providerId}-${String(n)}`,
    providerId,
    externalModelId: `fake-model-${String(n)}`,
    displayName: `Fake Model ${String(n)}`,
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    isFree: false,
    inputPricePer1m: null,
    outputPricePer1m: null,
    lastSyncedAt: NOW,
  };
}

/** In-memory ApiClient double: records every call, mutates like the real backend
 * on CRUD, and exposes mutable fields tests flip mid-flow (e.g. me() failures). */
export class FakeApiClient implements ApiClient {
  calls: string[] = [];
  callLog: { method: string; args: unknown[] }[] = [];

  session: SessionInfo | null;
  meFailure: ApiError | null;
  loginConfigResult: LoginConfig;
  agents: AgentDto[];
  providers: ProviderDto[];
  models: Record<string, ModelDto[]>;
  tiers: TierDto[];
  testResult: ActionResult;
  syncResult: ActionResult;
  proxyResult: ChatCompletion;
  proxyFailure: ApiError | null;
  summaryResult: AnalyticsSummary;
  timeseriesResult: TimeseriesPoint[];
  breakdownResult: Record<BreakdownDimension, BreakdownRow[]>;
  requestRows: RequestRow[];
  analyticsFailure: ApiError | null;

  private seq = 0;

  constructor(opts: FakeOptions = {}) {
    this.session = opts.session === undefined ? DEFAULT_SESSION : opts.session;
    this.meFailure = opts.meFailure ?? null;
    this.loginConfigResult = opts.loginConfig ?? DEFAULT_LOGIN_CONFIG;
    this.agents = opts.agents ?? [];
    this.providers = opts.providers ?? [];
    this.models = opts.models ?? {};
    this.tiers = opts.tiers ?? [
      {
        id: 'tier-default',
        key: 'default',
        displayName: 'Default',
        description: null,
        createdAt: NOW,
      },
    ];
    this.testResult = opts.testResult ?? okResult();
    this.syncResult = opts.syncResult ?? okResult(2);
    this.proxyResult = opts.proxyResult ?? {
      id: 'cmpl-1',
      model: 'fake-model-0',
      choices: [{ message: { role: 'assistant', content: 'routing works' } }],
    };
    this.proxyFailure = opts.proxyFailure ?? null;
    this.summaryResult = opts.summary ?? DEFAULT_SUMMARY;
    this.timeseriesResult = opts.timeseries ?? DEFAULT_TIMESERIES;
    this.breakdownResult = opts.breakdown ?? defaultBreakdown();
    this.requestRows = opts.requestRows ?? buildRequestRows(30);
    this.analyticsFailure = opts.analyticsFailure ?? null;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push(method);
    this.callLog.push({ method, args });
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq)}`;
  }

  /** Args of the most recent call to `method`, or undefined. */
  lastArgs(method: string): unknown[] | undefined {
    for (let i = this.callLog.length - 1; i >= 0; i -= 1) {
      if (this.callLog[i]?.method === method) return this.callLog[i]?.args;
    }
    return undefined;
  }

  countOf(method: string): number {
    return this.calls.filter((m) => m === method).length;
  }

  me(): Promise<SessionInfo> {
    this.record('me');
    if (this.meFailure) return Promise.reject(this.meFailure);
    if (!this.session) return Promise.reject(new ApiError(401, 'Unauthorized', 'Unauthorized'));
    return Promise.resolve(this.session);
  }

  loginConfig(): Promise<LoginConfig> {
    this.record('loginConfig');
    return Promise.resolve(this.loginConfigResult);
  }

  signInEmail(input: { email: string; password: string }): Promise<void> {
    this.record('signInEmail', input);
    this.meFailure = null;
    this.session = this.session ?? DEFAULT_SESSION;
    return Promise.resolve();
  }

  signUpEmail(input: { name: string; email: string; password: string }): Promise<void> {
    this.record('signUpEmail', input);
    this.meFailure = null;
    this.session = { ...DEFAULT_SESSION, email: input.email, name: input.name };
    return Promise.resolve();
  }

  signOut(): Promise<void> {
    this.record('signOut');
    // Loopback auto-login: the session survives sign-out (me() stays 200).
    return Promise.resolve();
  }

  signInSocial(provider: string, callbackURL: string): Promise<{ url: string }> {
    this.record('signInSocial', provider, callbackURL);
    return Promise.resolve({
      url: `https://oauth.example/${provider}?cb=${encodeURIComponent(callbackURL)}`,
    });
  }

  listAgents(): Promise<AgentDto[]> {
    this.record('listAgents');
    return Promise.resolve([...this.agents]);
  }

  createAgent(input: { name: string; harness: string }): Promise<AgentReveal> {
    this.record('createAgent', input);
    const key = `poly_${this.nextId('key').replace('-', '')}xxxxxxxxxxxxxxxxxxxx`;
    const agent: AgentDto = {
      id: this.nextId('agent'),
      name: input.name,
      harness: input.harness,
      prefix: key.slice(0, 9),
      lastUsedAt: null,
      createdAt: NOW,
    };
    this.agents = [agent, ...this.agents];
    return Promise.resolve({ ...agent, key, snippet: `# snippet for ${key}` });
  }

  rotateAgentKey(id: string): Promise<AgentReveal> {
    this.record('rotateAgentKey', id);
    const existing = this.agents.find((a) => a.id === id);
    if (!existing) return Promise.reject(new ApiError(404, 'Not Found', 'agent not found'));
    const key = `poly_${this.nextId('key').replace('-', '')}yyyyyyyyyyyyyyyyyyyy`;
    const updated: AgentDto = { ...existing, prefix: key.slice(0, 9) };
    this.agents = this.agents.map((a) => (a.id === id ? updated : a));
    return Promise.resolve({ ...updated, key, snippet: `# snippet for ${key}` });
  }

  deleteAgent(id: string): Promise<{ deleted: boolean }> {
    this.record('deleteAgent', id);
    this.agents = this.agents.filter((a) => a.id !== id);
    return Promise.resolve({ deleted: true });
  }

  listProviders(): Promise<ProviderDto[]> {
    this.record('listProviders');
    return Promise.resolve([...this.providers]);
  }

  createProvider(input: CreateProviderInput): Promise<ProviderDto> {
    this.record('createProvider', input);
    const provider: ProviderDto = {
      id: this.nextId('prov'),
      name: input.name,
      kind: input.kind,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      status: 'unknown',
      hasCredential: input.credential !== undefined && input.credential !== '',
      createdAt: NOW,
    };
    this.providers = [...this.providers, provider];
    return Promise.resolve(provider);
  }

  updateProvider(id: string, patch: UpdateProviderInput): Promise<ProviderDto> {
    this.record('updateProvider', id, patch);
    const existing = this.providers.find((p) => p.id === id);
    if (!existing) return Promise.reject(new ApiError(404, 'Not Found', 'provider not found'));
    const updated: ProviderDto = { ...existing, ...patch };
    this.providers = this.providers.map((p) => (p.id === id ? updated : p));
    return Promise.resolve(updated);
  }

  deleteProvider(id: string): Promise<{ deleted: boolean }> {
    this.record('deleteProvider', id);
    this.providers = this.providers.filter((p) => p.id !== id);
    const rest: Record<string, ModelDto[]> = {};
    for (const [k, v] of Object.entries(this.models)) if (k !== id) rest[k] = v;
    this.models = rest;
    return Promise.resolve({ deleted: true });
  }

  testProvider(id: string): Promise<ActionResult> {
    this.record('testProvider', id);
    return Promise.resolve(this.testResult);
  }

  syncModels(id: string): Promise<ActionResult> {
    this.record('syncModels', id);
    const result = this.syncResult;
    if (result.ok && (result.synced ?? 0) > 0 && this.models[id] === undefined) {
      this.models[id] = Array.from({ length: result.synced ?? 0 }, (_v, i) => fakeModel(id, i));
    }
    return Promise.resolve(result);
  }

  listModels(providerId?: string): Promise<ModelDto[]> {
    this.record('listModels', providerId);
    if (providerId === undefined) return Promise.resolve(Object.values(this.models).flat());
    return Promise.resolve([...(this.models[providerId] ?? [])]);
  }

  updateModelPricing(id: string, body: ModelPricingInput): Promise<ModelDto> {
    this.record('updateModelPricing', id, body);
    for (const [pid, list] of Object.entries(this.models)) {
      const model = list.find((m) => m.id === id);
      if (model) {
        const updated: ModelDto =
          'isFree' in body
            ? { ...model, isFree: true, inputPricePer1m: 0, outputPricePer1m: 0 }
            : {
                ...model,
                isFree: false,
                inputPricePer1m: body.inputPricePer1m,
                outputPricePer1m: body.outputPricePer1m,
              };
        this.models[pid] = list.map((m) => (m.id === id ? updated : m));
        return Promise.resolve(updated);
      }
    }
    return Promise.reject(new ApiError(404, 'Not Found', 'model not found'));
  }

  listTiers(): Promise<TierDto[]> {
    this.record('listTiers');
    return Promise.resolve([...this.tiers]);
  }

  replaceTierEntries(tierId: string, modelIds: string[]): Promise<TierEntryDto[]> {
    this.record('replaceTierEntries', tierId, modelIds);
    return Promise.resolve(
      modelIds.map((modelId, position) => ({
        id: `entry-${String(position)}`,
        tierId,
        modelId,
        position,
        model: null,
      })),
    );
  }

  proxyTest(agentKey: string, body: ProxyTestBody): Promise<ChatCompletion> {
    this.record('proxyTest', agentKey, body);
    if (this.proxyFailure) return Promise.reject(this.proxyFailure);
    return Promise.resolve(this.proxyResult);
  }

  summary(range: AnalyticsRangeParams): Promise<AnalyticsSummary> {
    this.record('summary', range);
    if (this.analyticsFailure) return Promise.reject(this.analyticsFailure);
    return Promise.resolve(this.summaryResult);
  }

  timeseries(range: AnalyticsRangeParams, bucket: TimeseriesBucket): Promise<TimeseriesPoint[]> {
    this.record('timeseries', range, bucket);
    if (this.analyticsFailure) return Promise.reject(this.analyticsFailure);
    return Promise.resolve([...this.timeseriesResult]);
  }

  breakdown(
    dimension: BreakdownDimension,
    range: AnalyticsRangeParams,
    limit?: number,
  ): Promise<BreakdownRow[]> {
    this.record('breakdown', dimension, range, limit);
    if (this.analyticsFailure) return Promise.reject(this.analyticsFailure);
    return Promise.resolve((this.breakdownResult[dimension] ?? []).slice(0, limit ?? 10));
  }

  /** Honors the frozen `cursor` + server-side `status`/`escalated`/`decisionLayers`
   * so pagination + filtering are testable. `nextCursor` is the last row's id when
   * more rows remain; the next page starts strictly after it (no dupes/skips). */
  requests(query: RequestsQuery): Promise<RequestsPage> {
    this.record('requests', query);
    if (this.analyticsFailure) return Promise.reject(this.analyticsFailure);
    let rows = this.requestRows;
    if (query.status !== undefined) rows = rows.filter((r) => r.status === query.status);
    if (query.escalated !== undefined) rows = rows.filter((r) => r.escalated === query.escalated);
    if (query.decisionLayers !== undefined) {
      const layers = query.decisionLayers;
      rows = rows.filter((r) => layers.includes(r.decisionLayer));
    }
    const startIdx =
      query.cursor !== undefined ? rows.findIndex((r) => r.id === query.cursor) + 1 : 0;
    const limit = query.limit ?? 50;
    const page = rows.slice(startIdx, startIdx + limit);
    const last = page[page.length - 1];
    const nextCursor = startIdx + limit < rows.length && last !== undefined ? last.id : null;
    return Promise.resolve({ rows: page, nextCursor });
  }
}
