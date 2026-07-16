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
  replaceTierEntries(tierId: string, modelIds: string[]): Promise<TierEntryDto[]>;
  proxyTest(agentKey: string, body: ProxyTestBody): Promise<ChatCompletion>;
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
  replaceTierEntries: (tierId, modelIds) =>
    http<TierEntryDto[]>(
      `${API_BASE}/routing/tiers/${encodeURIComponent(tierId)}/entries`,
      jsonInit('PUT', { modelIds }),
    ),
  proxyTest: (agentKey, body) =>
    http<ChatCompletion>(
      `${PROXY_BASE}/chat/completions`,
      jsonInit('POST', body, { authorization: `Bearer ${agentKey}` }),
    ),
};
