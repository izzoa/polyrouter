import { ApiError } from '../data/api';
import type {
  ActionResult,
  AgentDto,
  AgentReveal,
  ApiClient,
  ChatCompletion,
  CreateProviderInput,
  LoginConfig,
  ModelDto,
  ModelPricingInput,
  ProviderDto,
  ProxyTestBody,
  SessionInfo,
  TierDto,
  TierEntryDto,
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
}
