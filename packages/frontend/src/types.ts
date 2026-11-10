import type { HarnessType } from '@polyrouter/shared';
import type {
  BudgetAction,
  BudgetScope,
  BudgetWindow,
  ChannelKind,
  EventType,
  Mode,
  ModelDto,
  PlanCooldownDto,
  PlanUsageDto,
  PlanUsageRefreshDto,
  ProviderHealthDto,
  SmtpSecure,
} from './data/api';

export type Page =
  | 'overview'
  | 'requests'
  | 'batches'
  | 'costs'
  | 'agents'
  | 'providers'
  | 'routing'
  | 'limits'
  | 'settings'
  | 'users'
  | 'setup';

export type Theme = 'light' | 'dark';
export type Range = '24h' | '7d' | '30d';
/** Which tab of the Routing page is showing: `tiers` (Tiers & headers — the
 * Layer-0 chains and header rules) or `auto` (Auto routing) — redesign-auto-routing-pipeline.
 * In-memory only: the hash grammar is `#/routing` with no suffix, so a full
 * reload lands on `tiers`. */
export type RoutingSection = 'tiers' | 'auto';
export type RequestFilter = 'all' | 'explicit' | 'auto' | 'fallback' | 'escalated';

/** How a request was RUN, orthogonal to how it was routed (add-batch-inference).
 * `sync` is every request served on the wire; `batch` is a settled batch item. */
export type RequestMode = 'all' | 'sync' | 'batch';
/** The dashboard's harness type IS the canonical shared one (single source). */
export type Harness = HarnessType;
export type ProviderKindId = 'api' | 'sub' | 'custom' | 'local';
export type ModalKind =
  'newAgent' | 'keyReveal' | 'newProvider' | 'editProvider' | 'newLimit' | 'channel';

/** One row of a spend/cost breakdown (BarRows). */
export interface SpendDatum {
  n: string;
  v: number;
  fv?: number;
  free?: boolean;
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
  /** Subscription-OAuth state (non-secret): the connected preset, the token's display
   * expiry, and the durable 'reauthorize_required' condition. */
  oauthPreset: string | null;
  /** add-key-subscription-presets: the key preset this row was connected from (a non-secret
   * marker), or null. Never set together with `oauthPreset`. */
  keyPreset: string | null;
  credentialExpiresAt: string | null;
  credentialError: string | null;
  /** Upstream patience overrides (fix-long-call-timeouts); null = inherit. */
  firstByteTimeoutMs: number | null;
  idleTimeoutMs: number | null;
  /** add-auto-prune-unlisted-models: whether a sync deletes this provider's unreferenced
   * models once they have stayed unlisted for seven days. */
  autoPruneUnlisted: boolean;
  /** allow-preset-client-identity: whether this provider sends its preset's declared client
   * identity, and the imitated client's label when one is available (null = none, so the
   * edit modal shows no switch). */
  imitateClientIdentity: boolean;
  clientIdentity: { label: string } | null;
  /** classify-plan-quota-errors: the active plan pause (the kind, the end as an ISO-8601
   * instant, and who chose it), or null. */
  planCooldown: PlanCooldownDto | null;
  /** add-subscription-quota-display: the plan's usage snapshot (null: nothing observed, or no
   * source) and whether a Refresh usage is on offer with its cooldown end (null: no endpoint). */
  planUsage: PlanUsageDto | null;
  planUsageRefresh: PlanUsageRefreshDto | null;
  /** add-subscription-usage-history: whether the usage schedule reads this provider's usage
   * endpoint (on by default; meaningful only where `planUsageRefresh` is non-null). */
  checkPlanUsage: boolean;
  createdAt: string;
  /** add-provider-health-signals: the server-computed displayed health (the most
   * recently recorded of the check and live-traffic records). */
  health: ProviderHealthDto;
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
  registration: 'open' | 'invite_only';
}

/** Auth-gate machine: loader → login → error(retry) → shell; `invite` is the
 * public accept-invite page (rendered without a session). */
export type AuthView = 'loading' | 'gate' | 'ready' | 'error' | 'invite';

/** The add-provider form, reused by the Providers modal and onboarding step 2.
 * `openai_responses` appears ONLY when the form was seeded from an OAuth-connected
 * ChatGPT row (read-only display; edits submit name-only) — the create UI never
 * offers it (connect-only protocol). */
export interface ProviderForm {
  name: string;
  kind: ProviderKindId;
  protocol: 'openai_compatible' | 'anthropic_compatible' | 'openai_responses';
  baseUrl: string;
  credential: string;
  /** Patience overrides in SECONDS as text (fix-long-call-timeouts); blank =
   * inherit the instance default (shown as the field placeholder). */
  firstByteTimeoutS: string;
  idleTimeoutS: string;
}

/** The create/edit budget form (#20 Limits page). `id` null = create. `amount`
 * is a text field (parsed on save); an agent-scoped budget needs an `agentId`
 * (surfaced as an inline 422 from the server otherwise). */
export type MeteringBasis = 'cash' | 'notional';

export interface BudgetForm {
  id: string | null;
  name: string;
  scope: BudgetScope;
  agentId: string;
  window: BudgetWindow;
  action: BudgetAction;
  /** What the budget meters: `cash` (money owed) or `notional` (also counts prepaid
   * subscription usage at API rates). */
  meteringBasis: MeteringBasis;
  amount: string;
  notifyChannelIds: string[];
  enabled: boolean;
  busy: boolean;
  error: string | null;
}

/** The create/edit notification-channel form (#20 Settings). Kind-specific config
 * is WRITE-ONLY — never populated from the server (invariant 8). On edit, leaving
 * the config fields blank patches name/enabled/events without touching secrets. */
export interface ChannelForm {
  id: string | null;
  name: string;
  kind: ChannelKind;
  /** The channel's stored kind (edit only); a change from this requires a full new
   * config, since the old config belongs to the old kind's schema. */
  originalKind: ChannelKind | null;
  events: EventType[];
  smtpHost: string;
  smtpPort: string;
  smtpSecure: SmtpSecure;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpTo: string;
  appriseUrls: string;
  busy: boolean;
  error: string | null;
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
  /** Fingerprint (JSON of the built API input) of the form that created `providerId`,
   * so a retry with the SAME input reuses the provider (no duplicate) but an edited form
   * creates a fresh one — compared input-to-input, immune to server-side URL canonicalization. */
  provInput: string | null;
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
