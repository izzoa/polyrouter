import type { HarnessType } from '@polyrouter/shared';
import type { Mode, ModelDto } from './data/api';

export type Page =
  | 'overview'
  | 'requests'
  | 'costs'
  | 'agents'
  | 'providers'
  | 'routing'
  | 'limits'
  | 'settings'
  | 'setup';

export type Theme = 'light' | 'dark';
export type Range = '24h' | '7d' | '30d';
export type RequestFilter = 'all' | 'explicit' | 'auto' | 'fallback' | 'escalated';
export type ModelTag = 'sub' | 'local' | null;
/** The dashboard's harness type IS the canonical shared one (single source). */
export type Harness = HarnessType;
export type LimitWindow = 'day' | 'week' | 'month';
export type LimitAction = 'alert' | 'block';
export type ProviderKindId = 'api' | 'sub' | 'custom' | 'local';
export type ModalKind = 'newAgent' | 'keyReveal' | 'newProvider' | 'newLimit';

/** One row of a spend/cost breakdown (BarRows). */
export interface SpendDatum {
  n: string;
  v: number;
  fv?: number;
  free?: boolean;
}

export interface Tier {
  key: string;
  desc: string;
  chain: string[];
}

export interface HeaderRule {
  id: number;
  value: string;
  target: string;
}

/** Real provider health (#18) — the prototype's 'warn'/circuit copy is gone. */
export type ProviderStatus = 'unknown' | 'ok' | 'error';

/** Aligned to the backend `SafeProvider` (#7). Credentials are write-only —
 * only `hasCredential` is ever known client-side. */
export interface Provider {
  id: string;
  name: string;
  /** API kind: 'api_key' | 'subscription' | 'custom' | 'local'. */
  kind: string;
  protocol: string;
  baseUrl: string | null;
  status: ProviderStatus;
  hasCredential: boolean;
  createdAt: string;
}

/** Aligned to the backend `SafeModel` (#7/#18). Prices are null when unpriced. */
export type Model = ModelDto;

/** Aligned to the backend `SafeAgent` (#3). No key/hash is ever listed. */
export interface Agent {
  id: string;
  name: string;
  harness: Harness;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Dashboard session identity, from `GET /api/me`. */
export interface SessionInfo {
  userId: string;
  email: string;
  name: string;
  role: string | null;
  mode: Mode;
}

/** Login-gate capabilities, from the public `GET /api/login-config`. */
export interface LoginConfig {
  mode: Mode;
  emailPassword: boolean;
  oauthProviders: string[];
}

/** Auth-gate machine: loader → login → error(retry) → shell. */
export type AuthView = 'loading' | 'gate' | 'ready' | 'error';

/** The add-provider form, reused by the Providers modal and onboarding step 2. */
export interface ProviderForm {
  name: string;
  kind: ProviderKindId;
  protocol: 'openai_compatible' | 'anthropic_compatible';
  baseUrl: string;
  credential: string;
}

export interface Limit {
  id: number;
  scope: string;
  threshold: number;
  window: LimitWindow;
  action: LimitAction;
  current: number;
  note: string;
}

export type ChannelKind = 'smtp' | 'apprise';

export interface Channel {
  id: number;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  detail: string;
  last: string;
  lastOk: boolean | null;
  testing: boolean;
}

/** Failure-aware onboarding state machine (#18 §7). Each step stops and surfaces
 * a clear error on failure; the minted key is shown once and cleared on
 * completion / error / sign-out. */
export interface OnboardingState {
  step: 1 | 2 | 3;
  // Step 1 — mint an agent key.
  name: string;
  harness: Harness;
  agentId: string | null;
  /** Raw minted key — transient, never persisted; needed by step-3 verify. */
  key: string;
  snippet: string;
  done1: boolean;
  busy1: boolean;
  error1: string | null;
  // Step 2 — connect a provider, sync models, assign the first to `default`.
  prov: ProviderForm;
  providerId: string | null;
  assignedModel: string | null;
  done2: boolean;
  busy2: boolean;
  error2: string | null;
  // Step 3 — verify a real `auto` completion through the proxy.
  busy3: boolean;
  error3: string | null;
  verifyReply: string | null;
  verifyModel: string | null;
}
