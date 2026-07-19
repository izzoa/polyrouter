import { ApiError } from '../data/api';
import type {
  ActionResult,
  AdminInviteDto,
  AdminUserDto,
  IssuedInviteDto,
  RegistrationSettingsDto,
  AgentDto,
  AgentReveal,
  AnalyticsRangeParams,
  AnalyticsSummary,
  ApiClient,
  AutoLayers,
  BreakdownDimension,
  BreakdownRow,
  BudgetDto,
  ChannelDto,
  ChannelTestResult,
  ChatCompletion,
  CreateBudgetInput,
  CreateChannelInput,
  CreateProviderInput,
  CreateRuleInput,
  CreateTierInput,
  LoginConfig,
  ModelDto,
  ModelPricingInput,
  ProviderDto,
  ProxyTestBody,
  RequestRow,
  RequestsPage,
  RequestsQuery,
  RequestStatus,
  RuleDto,
  SessionInfo,
  TierDto,
  TierEntryDto,
  TimeseriesBucket,
  TimeseriesPoint,
  UpdateBudgetInput,
  UpdateChannelInput,
  UpdateProviderInput,
  UpdateTierInput,
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
  registration: 'open',
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
  adminUsers?: AdminUserDto[];
  adminInvites?: AdminInviteDto[];
  registration?: RegistrationSettingsDto;
  session?: SessionInfo | null;
  meFailure?: ApiError | null;
  loginConfig?: LoginConfig;
  agents?: AgentDto[];
  providers?: ProviderDto[];
  models?: Record<string, ModelDto[]>;
  tiers?: TierDto[];
  tierEntries?: Record<string, TierEntryDto[]>;
  rules?: RuleDto[];
  budgets?: BudgetDto[];
  channels?: ChannelDto[];
  autoLayers?: AutoLayers;
  channelTestResult?: ChannelTestResult;
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
    effectivePrice: null,
    lastSyncedAt: NOW,
  };
}

/** In-memory ApiClient double: records every call, mutates like the real backend
 * on CRUD, and exposes mutable fields tests flip mid-flow (e.g. me() failures). */
/** A queued, test-controllable async response (resolve/reject on demand). */
interface DeferredCall<T> {
  settle: (mode: 'resolve' | 'reject') => void;
  input: T;
}

export class FakeApiClient implements ApiClient {
  calls: string[] = [];
  callLog: { method: string; args: unknown[] }[] = [];

  // When set, `replaceTierEntries` / `setAutoLayers` return promises the test
  // settles out of order (via the queues below) to exercise write serialization.
  deferTierWrites = false;
  tierWriteQueue: DeferredCall<{ tierId: string; modelIds: string[] }>[] = [];
  deferAutoLayers = false;
  autoLayersQueue: DeferredCall<{ structural: boolean; cascade: boolean }>[] = [];

  // When `gateReads` is set, config GET reads snapshot state at call time and then
  // WAIT for `openGate()` — so a test can land a mutation mid-load and assert the
  // loader's (now-stale) result is discarded (stale-loader-overwrite guards).
  gateReads = false;
  private gateResolvers: (() => void)[] = [];
  private gate(): Promise<void> {
    if (!this.gateReads) return Promise.resolve();
    return new Promise<void>((resolve) => this.gateResolvers.push(resolve));
  }
  openGate(): void {
    const resolvers = this.gateResolvers;
    this.gateResolvers = [];
    for (const r of resolvers) r();
  }

  session: SessionInfo | null;
  meFailure: ApiError | null;
  loginConfigResult: LoginConfig;
  adminUsers: AdminUserDto[];
  adminInvites: AdminInviteDto[];
  registration: RegistrationSettingsDto;
  /** When set, adminSetRole rejects with a 409 carrying this message (last-admin refusal). */
  adminSetRoleFailure: string | null = null;
  agents: AgentDto[];
  providers: ProviderDto[];
  models: Record<string, ModelDto[]>;
  tiers: TierDto[];
  tierEntries: Record<string, TierEntryDto[]>;
  rules: RuleDto[];
  budgets: BudgetDto[];
  channels: ChannelDto[];
  autoLayers: AutoLayers;
  channelTestResult: ChannelTestResult;
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
    this.adminUsers = opts.adminUsers ?? [];
    this.adminInvites = opts.adminInvites ?? [];
    this.registration = opts.registration ?? { mode: 'open', smtpConfigured: false };
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
    this.tierEntries = opts.tierEntries ?? {};
    this.rules = opts.rules ?? [];
    this.budgets = opts.budgets ?? [];
    this.channels = opts.channels ?? [];
    this.autoLayers = opts.autoLayers ?? {
      structural: true,
      cascade: true,
      structuralAvailable: true,
      cascadeAvailable: true,
    };
    this.channelTestResult = opts.channelTestResult ?? { ok: true };
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

  acceptInvite(input: { token: string; name: string; password: string }): Promise<void> {
    this.record('acceptInvite', input.token);
    if (input.token === 'expired-or-bad') {
      return Promise.reject(new ApiError(400, 'Bad Request', 'invalid or expired invite'));
    }
    return Promise.resolve();
  }

  adminListUsers(): Promise<AdminUserDto[]> {
    this.record('adminListUsers');
    return Promise.resolve([...this.adminUsers]);
  }

  adminSetRole(userId: string, role: 'admin' | null): Promise<void> {
    this.record('adminSetRole', userId, role);
    if (this.adminSetRoleFailure !== null) {
      return Promise.reject(new ApiError(409, 'Conflict', this.adminSetRoleFailure));
    }
    this.adminUsers = this.adminUsers.map((u) => (u.id === userId ? { ...u, role } : u));
    return Promise.resolve();
  }

  adminSetDisabled(userId: string, disabled: boolean): Promise<void> {
    this.record('adminSetDisabled', userId, disabled);
    this.adminUsers = this.adminUsers.map((u) => (u.id === userId ? { ...u, disabled } : u));
    return Promise.resolve();
  }

  adminDeleteUser(userId: string): Promise<void> {
    this.record('adminDeleteUser', userId);
    this.adminUsers = this.adminUsers.filter((u) => u.id !== userId);
    return Promise.resolve();
  }

  adminCreateInvite(email: string): Promise<IssuedInviteDto> {
    this.record('adminCreateInvite', email);
    const invite: AdminInviteDto = {
      id: `inv-${String(this.adminInvites.length + 1)}`,
      email,
      tokenPrefix: 'faketoken123',
      createdAt: NOW,
      // Relative to the real clock so the UI's pending/expired split sees it as pending.
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      consumedAt: null,
    };
    this.adminInvites = [invite, ...this.adminInvites];
    return Promise.resolve({
      invite,
      link: `http://localhost:3001/accept-invite#token=faketoken123-raw`,
      emailSent: this.registration.smtpConfigured,
    });
  }

  adminListInvites(): Promise<AdminInviteDto[]> {
    this.record('adminListInvites');
    return Promise.resolve([...this.adminInvites]);
  }

  adminRevokeInvite(inviteId: string): Promise<void> {
    this.record('adminRevokeInvite', inviteId);
    this.adminInvites = this.adminInvites.filter((i) => i.id !== inviteId);
    return Promise.resolve();
  }

  adminGetRegistration(): Promise<RegistrationSettingsDto> {
    this.record('adminGetRegistration');
    return Promise.resolve({ ...this.registration });
  }

  adminSetRegistration(mode: 'open' | 'invite_only'): Promise<void> {
    this.record('adminSetRegistration', mode);
    this.registration = { ...this.registration, mode };
    return Promise.resolve();
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
      oauthPreset: null,
      credentialExpiresAt: null,
      credentialError: null,
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

  /** Subscription-OAuth wizard endpoints (add-subscription-oauth). */
  oauthPresets: import('../data/api').OauthPresetDto[] = [
    { id: 'claude', displayName: 'Claude Pro / Max' },
    { id: 'chatgpt', displayName: 'ChatGPT Plus / Pro' },
  ];
  oauthCompleteRejects: ApiError | null = null;

  listOauthPresets(): Promise<import('../data/api').OauthPresetDto[]> {
    this.record('listOauthPresets');
    return Promise.resolve(this.oauthPresets);
  }

  oauthStart(preset: string, name?: string): Promise<import('../data/api').OauthStartResult> {
    this.record('oauthStart', preset, name);
    return Promise.resolve({
      sessionId: `sess-${preset}`,
      authorizeUrl: `https://idp.example/authorize?state=st-${preset}`,
    });
  }

  oauthComplete(sessionId: string, pasted: string): Promise<ProviderDto> {
    this.record('oauthComplete', sessionId, pasted);
    if (this.oauthCompleteRejects) return Promise.reject(this.oauthCompleteRejects);
    // Mirror the backend: the row is pinned to the session's preset — the ChatGPT
    // preset creates an `openai_responses` row (add-chatgpt-responses).
    const chatgpt = sessionId === 'sess-chatgpt';
    const provider: ProviderDto = {
      id: this.nextId('prov'),
      name: chatgpt ? 'ChatGPT Plus / Pro' : 'Claude Pro / Max',
      kind: 'subscription',
      protocol: chatgpt ? 'openai_responses' : 'anthropic_compatible',
      baseUrl: chatgpt ? 'https://chatgpt.com/' : 'https://api.anthropic.com',
      status: 'unknown',
      hasCredential: true,
      oauthPreset: chatgpt ? 'chatgpt' : 'claude',
      credentialExpiresAt: NOW,
      credentialError: null,
      createdAt: NOW,
    };
    this.providers = [...this.providers, provider];
    return Promise.resolve(provider);
  }

  oauthReauthorize(providerId: string): Promise<import('../data/api').OauthStartResult> {
    this.record('oauthReauthorize', providerId);
    return Promise.resolve({
      sessionId: `sess-re-${providerId}`,
      authorizeUrl: `https://idp.example/authorize?state=st-re`,
    });
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
    const snapshot =
      providerId === undefined
        ? Object.values(this.models).flat()
        : [...(this.models[providerId] ?? [])];
    return this.gate().then(() => snapshot);
  }

  updateModelPricing(id: string, body: ModelPricingInput): Promise<ModelDto> {
    this.record('updateModelPricing', id, body);
    for (const [pid, list] of Object.entries(this.models)) {
      const model = list.find((m) => m.id === id);
      if (model) {
        const updated: ModelDto =
          'isFree' in body
            ? {
                ...model,
                isFree: true,
                inputPricePer1m: 0,
                outputPricePer1m: 0,
                effectivePrice: {
                  inputPricePer1m: 0,
                  outputPricePer1m: 0,
                  isFree: true,
                  source: 'model',
                  estimated: false,
                },
              }
            : {
                ...model,
                isFree: false,
                inputPricePer1m: body.inputPricePer1m,
                outputPricePer1m: body.outputPricePer1m,
                effectivePrice: {
                  inputPricePer1m: body.inputPricePer1m,
                  outputPricePer1m: body.outputPricePer1m,
                  isFree: false,
                  source: 'model',
                  estimated: false,
                },
              };
        this.models[pid] = list.map((m) => (m.id === id ? updated : m));
        return Promise.resolve(updated);
      }
    }
    return Promise.reject(new ApiError(404, 'Not Found', 'model not found'));
  }

  listTiers(): Promise<TierDto[]> {
    this.record('listTiers');
    const snapshot = [...this.tiers];
    return this.gate().then(() => snapshot);
  }

  createTier(input: CreateTierInput): Promise<TierDto> {
    this.record('createTier', input);
    const tier: TierDto = {
      id: this.nextId('tier'),
      key: input.key,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
      createdAt: NOW,
    };
    this.tiers = [...this.tiers, tier];
    this.tierEntries[tier.id] = [];
    return Promise.resolve(tier);
  }

  updateTier(id: string, patch: UpdateTierInput): Promise<TierDto> {
    this.record('updateTier', id, patch);
    const existing = this.tiers.find((t) => t.id === id);
    if (!existing) return Promise.reject(new ApiError(404, 'Not Found', 'tier not found'));
    const updated: TierDto = {
      ...existing,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    };
    this.tiers = this.tiers.map((t) => (t.id === id ? updated : t));
    return Promise.resolve(updated);
  }

  deleteTier(id: string): Promise<{ deleted: boolean }> {
    this.record('deleteTier', id);
    this.tiers = this.tiers.filter((t) => t.id !== id);
    const rest: Record<string, TierEntryDto[]> = {};
    for (const [k, v] of Object.entries(this.tierEntries)) if (k !== id) rest[k] = v;
    this.tierEntries = rest;
    return Promise.resolve({ deleted: true });
  }

  listTierEntries(tierId: string): Promise<TierEntryDto[]> {
    this.record('listTierEntries', tierId);
    const snapshot = (this.tierEntries[tierId] ?? []).map((e) => ({ ...e }));
    return this.gate().then(() => snapshot);
  }

  private buildTierEntries(tierId: string, modelIds: string[]): TierEntryDto[] {
    const allModels = Object.values(this.models).flat();
    return modelIds.map((modelId, position) => {
      const m = allModels.find((x) => x.id === modelId);
      return {
        id: `entry-${tierId}-${String(position)}`,
        tierId,
        modelId,
        position,
        model: m
          ? {
              id: m.id,
              providerId: m.providerId,
              externalModelId: m.externalModelId,
              displayName: m.displayName,
            }
          : null,
      };
    });
  }

  replaceTierEntries(tierId: string, modelIds: string[]): Promise<TierEntryDto[]> {
    this.record('replaceTierEntries', tierId, modelIds);
    const entries = this.buildTierEntries(tierId, modelIds);
    if (!this.deferTierWrites) {
      this.tierEntries[tierId] = entries;
      return Promise.resolve(entries.map((e) => ({ ...e })));
    }
    return new Promise<TierEntryDto[]>((resolve, reject) => {
      this.tierWriteQueue.push({
        input: { tierId, modelIds },
        settle: (mode) => {
          if (mode === 'resolve') {
            this.tierEntries[tierId] = entries;
            resolve(entries.map((e) => ({ ...e })));
          } else {
            reject(new ApiError(500, 'Internal', 'tier write failed'));
          }
        },
      });
    });
  }

  listRules(): Promise<RuleDto[]> {
    this.record('listRules');
    const snapshot = [...this.rules];
    return this.gate().then(() => snapshot);
  }

  createRule(input: CreateRuleInput): Promise<RuleDto> {
    this.record('createRule', input);
    const rule: RuleDto = {
      id: this.nextId('rule'),
      matchType: input.matchType,
      headerName: input.headerName ?? 'x-polyrouter-tier',
      headerValue: input.headerValue ?? null,
      target: input.target,
      priority: input.priority ?? 0,
      createdAt: NOW,
    };
    this.rules = [...this.rules, rule];
    return Promise.resolve(rule);
  }

  deleteRule(id: string): Promise<{ deleted: boolean }> {
    this.record('deleteRule', id);
    this.rules = this.rules.filter((r) => r.id !== id);
    return Promise.resolve({ deleted: true });
  }

  getAutoLayers(): Promise<AutoLayers> {
    this.record('getAutoLayers');
    const snapshot = { ...this.autoLayers };
    return this.gate().then(() => snapshot);
  }

  private applyAutoLayers(input: { structural: boolean; cascade: boolean }): AutoLayers {
    // Mirror the server: cascade implies structural; effective = available × pref.
    const structuralEnabled = input.structural || input.cascade;
    this.autoLayers = {
      structuralAvailable: this.autoLayers.structuralAvailable,
      cascadeAvailable: this.autoLayers.cascadeAvailable,
      structural: this.autoLayers.structuralAvailable && structuralEnabled,
      cascade: this.autoLayers.cascadeAvailable && input.cascade,
    };
    return { ...this.autoLayers };
  }

  setAutoLayers(input: { structural: boolean; cascade: boolean }): Promise<AutoLayers> {
    this.record('setAutoLayers', input);
    if (!this.deferAutoLayers) return Promise.resolve(this.applyAutoLayers(input));
    return new Promise<AutoLayers>((resolve, reject) => {
      this.autoLayersQueue.push({
        input,
        settle: (mode) => {
          if (mode === 'resolve') resolve(this.applyAutoLayers(input));
          else reject(new ApiError(500, 'Internal', 'auto-layers write failed'));
        },
      });
    });
  }

  listBudgets(): Promise<BudgetDto[]> {
    this.record('listBudgets');
    const snapshot = [...this.budgets];
    return this.gate().then(() => snapshot);
  }

  createBudget(input: CreateBudgetInput): Promise<BudgetDto> {
    this.record('createBudget', input);
    if (input.scope === 'agent' && (input.agentId === undefined || input.agentId === '')) {
      return Promise.reject(
        new ApiError(422, 'Unprocessable Entity', 'an agent-scoped budget requires an agentId'),
      );
    }
    const budget: BudgetDto = {
      id: this.nextId('budget'),
      name: input.name,
      scope: input.scope,
      agentId: input.scope === 'agent' ? (input.agentId ?? null) : null,
      window: input.window,
      action: input.action,
      amount: input.amount,
      notifyChannelIds: input.notifyChannelIds ?? [],
      enabled: input.enabled ?? true,
      createdAt: NOW,
    };
    this.budgets = [...this.budgets, budget];
    return Promise.resolve(budget);
  }

  updateBudget(id: string, patch: UpdateBudgetInput): Promise<BudgetDto> {
    this.record('updateBudget', id, patch);
    const existing = this.budgets.find((b) => b.id === id);
    if (!existing) return Promise.reject(new ApiError(404, 'Not Found', 'budget not found'));
    const scope = patch.scope ?? existing.scope;
    const agentId = patch.agentId !== undefined ? patch.agentId : existing.agentId;
    if (scope === 'agent' && (agentId === null || agentId === undefined || agentId === '')) {
      return Promise.reject(
        new ApiError(422, 'Unprocessable Entity', 'an agent-scoped budget requires an agentId'),
      );
    }
    const updated: BudgetDto = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.window !== undefined ? { window: patch.window } : {}),
      ...(patch.action !== undefined ? { action: patch.action } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.notifyChannelIds !== undefined ? { notifyChannelIds: patch.notifyChannelIds } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      scope,
      agentId: scope === 'agent' ? (agentId ?? null) : null,
    };
    this.budgets = this.budgets.map((b) => (b.id === id ? updated : b));
    return Promise.resolve(updated);
  }

  deleteBudget(id: string): Promise<{ deleted: boolean }> {
    this.record('deleteBudget', id);
    this.budgets = this.budgets.filter((b) => b.id !== id);
    return Promise.resolve({ deleted: true });
  }

  listChannels(): Promise<ChannelDto[]> {
    this.record('listChannels');
    const snapshot = [...this.channels];
    return this.gate().then(() => snapshot);
  }

  createChannel(input: CreateChannelInput): Promise<ChannelDto> {
    this.record('createChannel', input);
    const channel: ChannelDto = {
      id: this.nextId('chan'),
      name: input.name,
      kind: input.kind,
      enabled: input.enabled ?? true,
      eventsSubscribed: [...input.eventsSubscribed],
      hasConfig: true,
      lastTestAt: null,
      lastTestStatus: null,
    };
    this.channels = [...this.channels, channel];
    return Promise.resolve(channel);
  }

  updateChannel(id: string, patch: UpdateChannelInput): Promise<ChannelDto> {
    this.record('updateChannel', id, patch);
    const existing = this.channels.find((c) => c.id === id);
    if (!existing) return Promise.reject(new ApiError(404, 'Not Found', 'channel not found'));
    // Mirror the backend: changing kind requires a new config for the new kind.
    if (patch.kind !== undefined && patch.kind !== existing.kind && patch.config === undefined) {
      return Promise.reject(
        new ApiError(422, 'Unprocessable Entity', 'changing kind requires a new config'),
      );
    }
    const updated: ChannelDto = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.eventsSubscribed !== undefined
        ? { eventsSubscribed: [...patch.eventsSubscribed] }
        : {}),
      ...(patch.config !== undefined ? { hasConfig: true } : {}),
    };
    this.channels = this.channels.map((c) => (c.id === id ? updated : c));
    return Promise.resolve(updated);
  }

  deleteChannel(id: string): Promise<{ deleted: boolean }> {
    this.record('deleteChannel', id);
    this.channels = this.channels.filter((c) => c.id !== id);
    return Promise.resolve({ deleted: true });
  }

  testChannel(id: string): Promise<ChannelTestResult> {
    this.record('testChannel', id);
    const result = this.channelTestResult;
    const status = result.ok ? 'success' : `failed:${result.error ?? 'error'}`;
    this.channels = this.channels.map((c) =>
      c.id === id ? { ...c, lastTestAt: NOW, lastTestStatus: status } : c,
    );
    return Promise.resolve({ ...result });
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
