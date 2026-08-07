import { connectionSnippet, isHarnessType, type HarnessType } from '@polyrouter/shared';
import {
  createEventStream,
  type EventSourceFactory,
  type EventStreamHandle,
  type StreamHealth,
} from '../data/eventStream';
import { untrack } from 'solid-js';
import { layerZ as zForIndex, supersededByDialog, type LayerEntry, type LayerKind, type LayerToken } from '../a11y';
import { createStore, produce, type SetStoreFunction } from 'solid-js/store';
import { DEFAULT_PAGE, hashForPage, pageFromHash } from './route';
import { filterToRequestParams } from '../data/analytics';
import {
  EVENT_TYPES,
  type AdminInviteDto,
  type AdminUserDto,
  type RegistrationSettingsDto,
  isApiError,
  MAX_MODELS_PER_TIER,
  realClient,
  TIER_HEADER_NAME,
  type AgentDto,
  type AnalyticsSummary,
  type ApiClient,
  type ApiProviderKind,
  type AutoLayers,
  type BreakdownMetric,
  type BreakdownRow,
  type BudgetDto,
  type ChannelConfigInput,
  type ChannelDto,
  type ChannelTestResult,
  type CreateBudgetInput,
  type CreateProviderInput,
  type UpdateProviderInput,
  type ModelPricingInput,
  type OauthPresetDto,
  type ProviderDto,
  type AutoPerformance,
  type CalibrationEvent,
  type SemanticLearningStatus,
  type PricingStatus,
  type BodyCaptureStatus,
  type RequestBodyContent,
  type InflightSnapshot,
  type RequestRow,
  type RuleDto,
  type TierDto,
  type TierEntryDto,
  type TimeseriesPoint,
  type UpdateBudgetInput,
  type UpdateChannelInput,
} from '../data/api';
import {
  applySettled,
  applyStarted,
  applyStreamSnapshot,
  emptyStream,
  inflightDisplay,
  type InflightDisplayRow,
  reconcile as reconcileInflightState,
  type StreamState,
} from '../data/inflight';
import { effectiveRuleOrder } from '../data/bandTargets';
import { BASE_URL } from '../data/catalog';
import { rangeToParams } from '../data/range';
import type {
  Agent,
  AuthView,
  BudgetForm,
  ChannelForm,
  Harness,
  LoginConfig,
  Model,
  ModalKind,
  OnboardingState,
  Page,
  Provider,
  ProviderForm,
  ProviderKindId,
  ProviderStatus,
  Range,
  RequestFilter,
  SessionInfo,
  Theme,
} from '../types';

/** Rows fetched per page of the requests list / "Load more". */
const REQUEST_PAGE_SIZE = 25;
/** Cost breakdown dimensions the dashboard renders (the tier dimension is unused). */
type CostDimension = 'model' | 'provider' | 'agent';

/** Frozen window for the requests list — appends reuse it so a moving clock never
 * shifts the range and skips/duplicates boundary rows. */
export interface RequestWindow {
  from: string;
  to: string;
  filter: RequestFilter;
}

export interface AppState {
  // chrome / navigation
  page: Page;
  theme: Theme;
  /** The sidebar setup-guide card was dismissed (persisted per browser). */
  setupDismissed: boolean;
  range: Range;
  /** Auto-performance section (add-auto-performance-view), Routing-local range. */
  autoPerf: {
    data: AutoPerformance | null;
    loaded: boolean;
    error: string | null;
    range: Range;
  };
  reqFilter: RequestFilter;
  selId: string | null;
  toast: string | null;
  modal: ModalKind | null;

  /** Narrow-width navigation (phase1-responsive-dashboard-layout). Below the locked
   * `narrow` threshold the sidebar collapses to an icon rail; this is the user-driven
   * expanded state, which overlays the page content. It is UI state, not layout — the
   * layout adaptation itself is declarative CSS. */
  /** Open overlay layers, most-recently-registered LAST — the registry the arbiter
   * resolves "topmost" from (centralize-overlay-layering). Not reactive-rendered; held
   * here so one fact drives keyboard, pointer and paint order. */
  layers: LayerEntry[];

  navExpanded: boolean;
  /** The account menu's open state, lifted out of `UserMenu` so overlay layering can be
   * decided by STATE rather than by document-listener registration order (the contract
   * `dialogKeyboard` states). The account menu lives inside the expanded nav, so the nav's
   * Escape handling must stand down while the menu owns the key. */
  accountMenuOpen: boolean;

  // auth / account (realized)
  authView: AuthView;
  authError: string | null;
  authBusy: boolean;
  session: SessionInfo | null;
  loginConfig: LoginConfig | null;

  // realized data slices — initialize EMPTY, loaded from the API on `ready`
  agents: Agent[];
  agentsError: string | null;
  /** Per-agent recent (24h) request count + spend, keyed by agent id — the `agent`
   * analytics breakdown, loaded on the Agents page. `agentStatsLoaded` distinguishes a
   * genuine zero (loaded, no activity) from unavailable (not loaded / load failed). */
  agentStats: Record<string, { requests: number; spend: number }>;
  agentStatsLoaded: boolean;
  providers: Provider[];
  providersError: string | null;
  models: Record<string, Model[]>;

  // user administration (admin-only Users page + public accept-invite)
  ua: {
    users: AdminUserDto[];
    invites: AdminInviteDto[];
    reg: RegistrationSettingsDto | null;
    loading: boolean;
    error: string | null;
    inviteEmail: string;
    inviteBusy: boolean;
    /** Shown once after issuing: the copyable link + whether email went out. */
    issued: { email: string; link: string; emailSent: boolean } | null;
  };
  /** Raw invite token captured from /accept-invite (scrubbed from the URL). */
  inviteToken: string | null;
  /** Accept-invite form. */
  ai: { name: string; password: string; busy: boolean; error: string | null };

  // realized modal/form state
  na: { name: string; harness: Harness; busy: boolean; error: string | null };
  // Shared by the create AND edit provider modals. `editingId` set ⇒ edit mode (submit
  // PATCHes). `hadCredential`/`clearCredential` drive the write-only credential UX: blank
  // preserves the stored key, the explicit clear sends an empty credential.
  np: ProviderForm & {
    busy: boolean;
    error: string | null;
    editingId: string | null;
    hadCredential: boolean;
    clearCredential: boolean;
    /** The kind the provider had when edit opened — so the "prices will be cleared"
     * warning fires only on a real transition into api_key/subscription. */
    origKind: ProviderKindId;
    /** Set when editing an OAuth-connected row (add-chatgpt-responses): endpoint/
     * kind/protocol are preset-pinned server-side, so the edit submits a NAME-ONLY
     * patch (credential rotate/clear still follows the SO-1 rules) and the modal
     * renders those fields read-only. */
    oauthPreset: string | null;
  };
  /** Transient key-reveal — raw key/snippet live here ONLY, never persisted. */
  kr: { title: string; key: string; snippet: string; harness: Harness };
  /** Subscription-OAuth connect wizard (add-subscription-oauth). `active` holds the
   * server-minted session; `pasted` is credential material — cleared after submit,
   * never persisted. */
  ow: {
    presets: OauthPresetDto[];
    active: {
      preset: string;
      sessionId: string;
      authorizeUrl: string;
      reauthorizeProviderId: string | null;
    } | null;
    pasted: string;
    busy: boolean;
    error: string | null;
    /** "Other subscription (advanced)" — the classic paste form instead of a preset. */
    advanced: boolean;
  };

  // Observe (analytics) slices — fetched from /api/analytics (#17). Each carries
  // loading + error; a per-shared-slice `generation` guard discards stale replies.
  analyticsSummary: AnalyticsSummary | null;
  analyticsSummaryLoading: boolean;
  analyticsSummaryError: string | null;
  analyticsSeries: TimeseriesPoint[];
  analyticsSeriesLoading: boolean;
  analyticsSeriesError: string | null;
  analyticsBreakdown: { model: BreakdownRow[]; provider: BreakdownRow[]; agent: BreakdownRow[] };
  analyticsBreakdownLoading: boolean;
  analyticsBreakdownError: string | null;
  /** What the Costs breakdown panels are ranked by. ONE selection for all three: three
   * independent metric states on one screen is more machinery than the question deserves,
   * and re-ranking model/provider/agent together is what makes the comparison legible. */
  breakdownMetric: BreakdownMetric;
  /** The `{range, metric}` the loaded rows actually belong to.
   *
   * Rows stay on screen while a refetch is in flight, so without this a flip of the
   * selector would relabel dollar values under a "tokens" heading until the new response
   * landed. The panel renders only when this matches the current selection. */
  breakdownLoadedFor: { range: Range; metric: BreakdownMetric } | null;
  /** Overview's unfiltered first-6 — independent of the Requests page's window. */
  recentRequests: RequestRow[];
  recentRequestsLoading: boolean;
  recentRequestsError: string | null;
  /** add-inflight-requests: live in-flight rows merged above the recent list. */
  inflightRows: InflightDisplayRow[];
  /** Live-view transport health (phase2-add-dashboard-event-stream). */
  streamHealth: StreamHealth;
  requestList: RequestRow[];
  requestListLoading: boolean;
  requestListError: string | null;
  requestCursor: string | null;
  requestWindow: RequestWindow | null;
  /** Set when an append STARTS (add-requests-freshness). Not on commit: while "Load more"
   * is in flight a commit-time flag still reads false, so a poll or nudge could reset the
   * list, discard the append, and silently undo the click the user just made. */
  requestsPaged: boolean;
  /** Requests newer than the frozen window, for the "N new" disclosure. `atLeast` when the
   * probe hit its cap; `unknown` when it failed — a failed probe must not read as "nothing
   * new", which would present a stale list as current. */
  requestsNew: { count: number; atLeast: boolean; unknown: boolean } | null;

  // Routing config (#20) — loaded on the Routing page mount. `tierEntries` is the
  // (optimistic) ordered chain per tier id; `confirmedEntries` is the last
  // server-CONFIRMED order per tier (the rollback target); `allModels` feeds the
  // picker + labels/prices.
  routingTiers: TierDto[];
  tierEntries: Record<string, TierEntryDto[]>;
  confirmedEntries: Record<string, string[]>;
  allModels: Model[];
  rules: RuleDto[];
  /** Band-targets section state (add-band-target-ui): PER-BAND busy +
   * row-scoped errors, and the section-level UNVERIFIED flag (a write landed
   * or may have landed but verification failed — display can't claim truth). */
  bt: {
    busy: { auto_high: boolean; auto_low: boolean };
    errors: { auto_high: string | null; auto_low: string | null };
    unverified: boolean;
  };
  autoLayers: AutoLayers | null;
  /** Threshold-calibration history (add-auto-threshold-calibration). */
  calHistory: { rows: CalibrationEvent[]; loaded: boolean; error: string | null };
  /** L2 semantic-learning card state (add-semantic-dashboard). */
  semLearn: { status: SemanticLearningStatus | null; loaded: boolean; error: string | null };
  /** Pricing-catalog panel state (add-pricing-refresh-ui). */
  pc: {
    status: PricingStatus | null;
    loaded: boolean;
    loadError: string | null;
    refreshError: string | null;
    busy: boolean;
  };
  /** Instance timeout defaults (fix-long-call-timeouts) — provider-form
   * placeholders; null until fetched. */
  tdefaults: { firstByteTimeoutMs: number; idleTimeoutMs: number } | null;
  /** Body-capture card state (add-body-capture). */
  bc: {
    status: BodyCaptureStatus | null;
    loaded: boolean;
    error: string | null;
    busy: boolean;
  };
  /** Inspector Payload section (add-body-capture): the SELECTED request's
   * lazily-fetched bodies; null until expanded, cleared on re-select. */
  selBodies: { rows: RequestBodyContent[] | null; loading: boolean; error: string | null };
  routingLoading: boolean;
  routingError: string | null;
  /** New header-rule form: a tier-header value routed to a target tier key. */
  rf: { value: string; target: string; busy: boolean; error: string | null };
  /** New-tier form. */
  tf: { key: string; displayName: string; busy: boolean; error: string | null };

  // Budgets (#20) — Limits page.
  budgets: BudgetDto[];
  budgetsLoading: boolean;
  budgetsError: string | null;
  bf: BudgetForm;

  // Notification channels (#20) — Settings page (also feeds the budget notify
  // picker). `channelTests` holds the last inline test-send result per channel;
  // `channelTesting` is the per-channel test-send in-flight guard (no double-fire).
  channels: ChannelDto[];
  channelsLoading: boolean;
  channelsError: string | null;
  channelTests: Record<string, ChannelTestResult>;
  channelTesting: Record<string, boolean>;
  /** Per-channel enable-toggle in-flight guard (coalesce rapid clicks). */
  channelToggling: Record<string, boolean>;
  cf: ChannelForm;

  // onboarding (realized, failure-aware)
  ob: OnboardingState;
}

export interface ProviderKindDef {
  id: ProviderKindId;
  name: string;
  desc: string;
  field: string;
  ph: string;
}

export const PROVIDER_KINDS: ProviderKindDef[] = [
  {
    id: 'api',
    name: 'API key',
    desc: 'OpenAI, Anthropic, DeepSeek, Groq… pay per token',
    field: 'API key',
    ph: 'sk-…',
  },
  {
    id: 'sub',
    name: 'Subscription',
    desc: 'Reuse ChatGPT Plus / Claude Max quota (check ToS)',
    field: 'Session credential',
    ph: 'paste from provider',
  },
  {
    // `field`/`ph` label the CREDENTIAL input — the Base URL has its own dedicated
    // field in the form (a 'Base URL' value here would label the key field wrongly).
    id: 'custom',
    name: 'Custom endpoint',
    desc: 'Any OpenAI/Anthropic-compatible base URL',
    field: 'API key',
    ph: 'sk-… or bearer token',
  },
  {
    id: 'local',
    name: 'Local',
    desc: 'Ollama, LM Studio, llama.cpp — free, on this box',
    field: 'API key',
    ph: 'usually empty for local runtimes',
  },
];

const UI_TO_API_KIND: Record<ProviderKindId, ApiProviderKind> = {
  api: 'api_key',
  sub: 'subscription',
  custom: 'custom',
  local: 'local',
};

/** API provider kind → the prototype's UI kind id. */
export function apiKindToUi(kind: string): ProviderKindId {
  return kind === 'api_key'
    ? 'api'
    : kind === 'subscription'
      ? 'sub'
      : kind === 'local'
        ? 'local'
        : 'custom';
}

/** Human label for a stored (API) provider kind. */
export function providerKindLabel(kind: string): string {
  return kind === 'api_key'
    ? 'API key'
    : kind === 'subscription'
      ? 'subscription'
      : kind === 'custom'
        ? 'custom endpoint'
        : kind === 'local'
          ? 'local'
          : kind;
}

/** True for provider kinds whose model prices the user edits directly (#18 §7.7). */
export function isPriceEditableKind(kind: string): boolean {
  return kind === 'custom' || kind === 'local';
}

/** Delegates to the canonical shared snippet builder (spec §2.1). Server-returned
 * snippets are preferred; this is a display fallback. */
export function snippetFor(harness: HarnessType, key: string): string {
  return connectionSnippet(harness, BASE_URL, key);
}

function toHarness(value: string): Harness {
  return isHarnessType(value) ? value : 'curl';
}

function asStatus(value: string): ProviderStatus {
  return value === 'ok' || value === 'error' ? value : 'unknown';
}

function toAgent(a: AgentDto): Agent {
  return {
    id: a.id,
    name: a.name,
    harness: toHarness(a.harness),
    prefix: a.prefix,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
  };
}

function toProvider(p: ProviderDto): Provider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    status: asStatus(p.status),
    hasCredential: p.hasCredential,
    oauthPreset: p.oauthPreset,
    credentialExpiresAt: p.credentialExpiresAt,
    credentialError: p.credentialError,
    firstByteTimeoutMs: p.firstByteTimeoutMs,
    idleTimeoutMs: p.idleTimeoutMs,
    createdAt: p.createdAt,
  };
}

function errMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unexpected error';
}

function emptyProviderForm(): ProviderForm {
  return {
    name: '',
    kind: 'api',
    protocol: 'openai_compatible',
    baseUrl: '',
    credential: '',
    firstByteTimeoutS: '',
    idleTimeoutS: '',
  };
}

/** Fresh create/edit-provider modal state (shared `np`). */
/** Persisted per browser, like the theme — storage failures just mean no persistence. */
function readSetupDismissed(): boolean {
  try {
    return localStorage.getItem('polyrouter-setup-dismissed') === '1';
  } catch {
    return false;
  }
}

function emptyNp(): AppState['np'] {
  return {
    ...emptyProviderForm(),
    busy: false,
    error: null,
    editingId: null,
    hadCredential: false,
    clearCredential: false,
    origKind: 'api',
    oauthPreset: null,
  };
}

/** Parse a patience field (SECONDS text) → ms; '' = absent; invalid/out-of-range
 * throws the inline-error message (fix-long-call-timeouts). */
function parseTimeoutS(raw: string, label: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw new Error(`${label} must be a whole number of seconds between 1 and 3600`);
  }
  return n * 1000;
}

function buildProviderInput(form: ProviderForm): CreateProviderInput {
  if (form.protocol === 'openai_responses') {
    // Unreachable: the connect-only protocol appears only on edit-seeded forms,
    // never in the create UI — and the server would reject it anyway.
    throw new Error('ChatGPT providers are created through the subscription connect flow');
  }
  const firstByteTimeoutMs = parseTimeoutS(form.firstByteTimeoutS, 'First-byte patience');
  const idleTimeoutMs = parseTimeoutS(form.idleTimeoutS, 'Idle patience');
  const base: CreateProviderInput = {
    name: form.name.trim(),
    kind: UI_TO_API_KIND[form.kind],
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    ...(firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  };
  const credential = form.credential.trim();
  return credential ? { ...base, credential } : base;
}

function emptyKeyReveal(): AppState['kr'] {
  return { title: '', key: '', snippet: '', harness: 'openai_sdk' };
}

function emptyBudgetForm(): BudgetForm {
  return {
    id: null,
    name: '',
    scope: 'global',
    agentId: '',
    window: 'day',
    action: 'alert',
    // New budgets meter money owed; existing ones were migrated to `notional` so their
    // enforcement did not change under them (split-subscription-spend).
    meteringBasis: 'cash',
    amount: '10.00',
    notifyChannelIds: [],
    enabled: true,
    busy: false,
    error: null,
  };
}

/** Populate the budget form from an existing budget (edit), or empty (create). */
function budgetFormFrom(b: BudgetDto): BudgetForm {
  return {
    id: b.id,
    name: b.name,
    scope: b.scope === 'agent' ? 'agent' : 'global',
    agentId: b.agentId ?? '',
    window: b.window === 'week' ? 'week' : b.window === 'month' ? 'month' : 'day',
    action: b.action === 'block' ? 'block' : 'alert',
    meteringBasis: b.meteringBasis === 'notional' ? 'notional' : 'cash',
    amount: String(b.amount),
    notifyChannelIds: [...b.notifyChannelIds],
    enabled: b.enabled,
    busy: false,
    error: null,
  };
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

function emptyChannelForm(): ChannelForm {
  return {
    id: null,
    name: '',
    kind: 'smtp',
    originalKind: null,
    events: ['budget_alert', 'budget_block'],
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: 'starttls',
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    smtpTo: '',
    appriseUrls: '',
    busy: false,
    error: null,
  };
}

/** Populate the channel form for edit — config fields stay BLANK (write-only,
 * invariant 8); the existing kind + events are prefilled. */
function channelFormFrom(c: ChannelDto): ChannelForm {
  const form = emptyChannelForm();
  const kind: ChannelForm['kind'] = c.kind === 'apprise' ? 'apprise' : 'smtp';
  return {
    ...form,
    id: c.id,
    name: c.name,
    kind,
    originalKind: kind,
    events: c.eventsSubscribed.filter((e): e is ChannelForm['events'][number] =>
      EVENT_TYPE_SET.has(e),
    ),
  };
}

function splitList(v: string): string[] {
  return v
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build the write-only channel config from the form. On EDIT of the SAME kind with
 * all config fields blank, returns `config: null` so the stored secret is left
 * untouched (invariant 8). On CREATE — or on an edit that CHANGES the kind — a
 * complete config for the (new) kind is required (the old config belongs to the old
 * kind's schema; the backend re-validates config against `kind`). */
function buildChannelConfig(f: ChannelForm): {
  error: string | null;
  config: ChannelConfigInput | null;
} {
  const kindChanged = f.id !== null && f.originalKind !== null && f.kind !== f.originalKind;
  const blankPreserve = f.id !== null && !kindChanged;
  if (f.kind === 'smtp') {
    const host = f.smtpHost.trim();
    const from = f.smtpFrom.trim();
    const user = f.smtpUser.trim();
    const to = splitList(f.smtpTo);
    const anyProvided =
      host !== '' || from !== '' || user !== '' || f.smtpPass !== '' || to.length > 0;
    if (blankPreserve && !anyProvided) return { error: null, config: null };
    const port = Number(f.smtpPort);
    if (host === '' || from === '' || to.length === 0 || !Number.isFinite(port) || port <= 0) {
      return {
        error: kindChanged
          ? 'Changing the kind to SMTP requires a full host, port, from address, and recipient'
          : 'SMTP needs a host, port, from address, and at least one recipient',
        config: null,
      };
    }
    return {
      error: null,
      config: {
        host,
        port,
        secure: f.smtpSecure,
        ...(user !== '' ? { user } : {}),
        ...(f.smtpPass !== '' ? { pass: f.smtpPass } : {}),
        from,
        to,
      },
    };
  }
  const urls = splitList(f.appriseUrls);
  if (blankPreserve && urls.length === 0) return { error: null, config: null };
  if (urls.length === 0) {
    return {
      error: kindChanged
        ? 'Changing the kind to Apprise requires at least one URL'
        : 'Add at least one Apprise URL',
      config: null,
    };
  }
  return { error: null, config: { urls } };
}

function initialOnboarding(): OnboardingState {
  return {
    step: 1,
    name: 'my-agent',
    harness: 'openai_sdk',
    agentId: null,
    key: '',
    snippet: '',
    done1: false,
    busy1: false,
    error1: null,
    prov: emptyProviderForm(),
    providerId: null,
    provInput: null,
    assignedModel: null,
    done2: false,
    busy2: false,
    error2: null,
    busy3: false,
    error3: null,
    verifyReply: null,
    verifyModel: null,
  };
}

function initialState(): AppState {
  return {
    page: 'overview',
    theme: 'light',
    setupDismissed: readSetupDismissed(),
    range: '24h',
    autoPerf: { data: null, loaded: false, error: null, range: '7d' },
    reqFilter: 'all',
    selId: null,
    toast: null,
    modal: null,
    layers: [],
    navExpanded: false,
    accountMenuOpen: false,

    authView: 'loading',
    authError: null,
    authBusy: false,
    session: null,
    loginConfig: null,

    agents: [],
    agentsError: null,
    agentStats: {},
    agentStatsLoaded: false,
    providers: [],
    providersError: null,
    models: {},

    ua: {
      users: [],
      invites: [],
      reg: null,
      loading: false,
      error: null,
      inviteEmail: '',
      inviteBusy: false,
      issued: null,
    },
    inviteToken: null,
    ai: { name: '', password: '', busy: false, error: null },

    na: { name: '', harness: 'openai_sdk', busy: false, error: null },
    np: emptyNp(),
    ow: { presets: [], active: null, pasted: '', busy: false, error: null, advanced: false },
    kr: emptyKeyReveal(),

    analyticsSummary: null,
    analyticsSummaryLoading: false,
    analyticsSummaryError: null,
    analyticsSeries: [],
    analyticsSeriesLoading: false,
    analyticsSeriesError: null,
    analyticsBreakdown: { model: [], provider: [], agent: [] },
    analyticsBreakdownLoading: false,
    analyticsBreakdownError: null,
    breakdownMetric: 'spend',
    breakdownLoadedFor: null,
    recentRequests: [],
    recentRequestsLoading: false,
    recentRequestsError: null,
    inflightRows: [],
    streamHealth: 'polling',
    requestList: [],
    requestListLoading: false,
    requestListError: null,
    requestCursor: null,
    requestWindow: null,
    requestsPaged: false,
    requestsNew: null,

    routingTiers: [],
    tierEntries: {},
    confirmedEntries: {},
    allModels: [],
    rules: [],
    bt: {
      busy: { auto_high: false, auto_low: false },
      errors: { auto_high: null, auto_low: null },
      unverified: false,
    },
    autoLayers: null,
    calHistory: { rows: [], loaded: false, error: null },
    semLearn: { status: null, loaded: false, error: null },
    pc: { status: null, loaded: false, loadError: null, refreshError: null, busy: false },
    tdefaults: null,
    bc: { status: null, loaded: false, error: null, busy: false },
    selBodies: { rows: null, loading: false, error: null },
    routingLoading: false,
    routingError: null,
    rf: { value: '', target: '', busy: false, error: null },
    tf: { key: '', displayName: '', busy: false, error: null },

    budgets: [],
    budgetsLoading: false,
    budgetsError: null,
    bf: emptyBudgetForm(),

    channels: [],
    channelsLoading: false,
    channelsError: null,
    channelTests: {},
    channelTesting: {},
    channelToggling: {},
    cf: emptyChannelForm(),

    ob: initialOnboarding(),
  };
}

export interface AppStore {
  state: AppState;
  setState: SetStoreFunction<AppState>;
  // navigation & chrome
  go: (page: Page) => void;
  /** Start URL routing (add-dashboard-hash-routing): captures the requested
   * page from the fragment and subscribes the browser-navigation listeners.
   * Owned by `App`'s lifecycle, NOT the store constructor — production has one
   * store while the test suites build many, so a constructor-attached global
   * listener would leak handlers across tests. Returns its unsubscribe.
   * Inert on the public `accept-invite` route (that fragment holds a secret). */
  startRouting: () => () => void;
  /** Browser-originated transition: back/forward, a manually edited URL, or
   * admitting a held page. NEVER pushes; replaces ONLY to canonicalize an
   * unrecognized or unauthorized location. Idempotent. */
  applyLocation: () => void;
  toggleTheme: () => void;
  dismissSetupGuide: () => void;
  /** Narrow-width nav overlay. Collapsing also closes the account menu inside it. */
  /** Register an overlay layer; returns its token. Opening a `dialog` supersedes every
   * transient not opened from it. */
  registerLayer: (opts: {
    kind: LayerKind;
    root: () => HTMLElement | undefined;
    onDismiss: () => void;
  }) => LayerToken;
  /** Remove by TOKEN, from anywhere in the registry. Idempotent. */
  removeLayer: (token: LayerToken) => void;
  /** Paint order for a registered layer, derived from the SAME ordering the keyboard uses.
   * Returns the base band for an unregistered token so a surface rendering before its
   * effect runs is never invisible. */
  layerZ: (token: LayerToken) => { backdrop: number; surface: number };
  setNavExpanded: (open: boolean) => void;
  setAccountMenuOpen: (open: boolean) => void;
  setRange: (range: Range) => void;
  /** Refetches; it does not re-sort. See `loadBreakdowns`. */
  setBreakdownMetric: (metric: BreakdownMetric) => void;
  /** Auto-performance section (add-auto-performance-view): Routing-local range. */
  loadAutoPerf: () => Promise<void>;
  setAutoPerfRange: (range: Range) => void;
  /** Threshold calibration (add-auto-threshold-calibration). */
  /** Pricing catalog (add-pricing-refresh-ui). */
  loadPricingStatus: () => Promise<void>;
  runPricingRefresh: () => Promise<void>;
  /** Body capture (add-body-capture). */
  loadBodyCapture: () => Promise<void>;
  setBodyCaptureMode: (mode: 'off' | 'errors_only' | 'all') => Promise<void>;
  setBodyCaptureRetention: (retentionDays: number | null) => Promise<void>;
  purgeBodies: () => Promise<void>;
  setAgentBodyOverride: (agentId: string, override: 'always' | 'never' | null) => Promise<void>;
  loadSelectedBodies: (id: string) => Promise<void>;
  deleteSelectedBodies: (id: string) => Promise<void>;
  setCalibration: (on: boolean) => Promise<void>;
  revertCalibration: () => Promise<void>;
  loadCalHistory: () => Promise<void>;
  setSemanticLearning: (on: boolean) => Promise<void>;
  revertSemanticLearning: () => Promise<void>;
  loadSemanticLearning: () => Promise<void>;
  setFilter: (filter: RequestFilter) => void;
  select: (id: string | null) => void;
  say: (msg: string) => void;
  clearToast: () => void;
  copy: (txt: string, msg?: string) => void;
  // observe (analytics, realized)
  loadOverview: () => Promise<void>;
  loadCosts: () => Promise<void>;
  loadRecentRequests: () => Promise<void>;
  loadInflight: () => Promise<void>;
  /** Dashboard event stream (phase2-add-dashboard-event-stream): the app shell opens
   * it while visible + live and closes it when hidden, releasing its slot in the
   * SHARED per-origin connection pool rather than merely pausing a timer. */
  connectStream: () => void;
  disconnectStream: () => void;
  /** Test seam: inject a transport factory before connecting. */
  setStreamFactory: (factory: EventSourceFactory) => void;
  /** Aggregate refresh through the shared poll+nudge budget. `force` is the mandatory
   * hidden→visible catch-up, which the floor must never suppress. */
  requestAggregateRefresh: (load: () => Promise<void>, force?: boolean) => Promise<void>;
  loadRequests: (reset: boolean) => Promise<void>;
  /** Refresh page 1, or probe for the disclosure if the user is paging. */
  refreshRequestsPage: () => Promise<void>;
  // auth / account
  bootstrap: () => Promise<void>;
  retry: () => Promise<void>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signUp: (input: { name: string; email: string; password: string }) => Promise<void>;
  oauth: (provider: string) => Promise<void>;
  signOut: () => Promise<void>;

  // user administration (admin-only Users page) + public accept-invite
  loadUserAdmin: () => Promise<void>;
  uaCreateInvite: () => Promise<void>;
  uaRevokeInvite: (inviteId: string) => Promise<void>;
  uaSetRole: (userId: string, role: 'admin' | null) => Promise<void>;
  uaSetDisabled: (userId: string, disabled: boolean) => Promise<void>;
  uaDeleteUser: (userId: string) => Promise<void>;
  uaSetRegistration: (mode: 'open' | 'invite_only') => Promise<void>;
  acceptInvite: () => Promise<void>;
  // agents (realized)
  loadAgents: () => Promise<void>;
  loadAgentStats: () => Promise<void>;
  createAgent: () => Promise<void>;
  rotateKey: (agent: Agent) => Promise<void>;
  deleteAgent: (agent: Agent) => Promise<void>;
  // providers (realized)
  loadProviders: () => Promise<void>;
  /** Instance timeout defaults for the provider form (fix-long-call-timeouts). */
  loadTimeoutDefaults: () => Promise<void>;
  addProvider: () => Promise<void>;
  /** Open the shared provider modal in edit mode, prefilled from `p`. */
  openEditProvider: (p: Provider) => void;
  /** Subscription-OAuth wizard (add-subscription-oauth). */
  loadOauthPresets: () => Promise<void>;
  startOauthConnect: (preset: string) => Promise<void>;
  startOauthReauthorize: (p: Provider) => Promise<void>;
  completeOauthConnect: () => Promise<void>;
  cancelOauthConnect: () => void;
  testProviderById: (id: string) => Promise<void>;
  syncProvider: (id: string) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  loadModels: (providerId: string) => Promise<void>;
  setModelPrice: (providerId: string, modelId: string, body: ModelPricingInput) => Promise<void>;
  // modals
  openModal: (modal: ModalKind) => void;
  closeModal: () => void;
  // routing config (#20)
  loadRouting: () => Promise<void>;
  moveTierEntry: (tierId: string, from: number, to: number) => void;
  commitTierOrder: (tierId: string) => Promise<void>;
  /** Hold this tier's visible chain against async server state for the drag's duration. */
  beginTierDrag: (tierId: string) => void;
  /** Resolve a hold. `changed` commits the user's order and drops deferred state;
   *  `unchanged` applies deferred state without writing; `abandon` discards both
   *  (page teardown, tier deletion, sign-out) — a boolean cannot express that third case. */
  endTierDrag: (tierId: string, outcome: 'changed' | 'unchanged' | 'abandon') => void;
  addTierModel: (tierId: string, modelId: string) => void;
  removeTierModel: (tierId: string, modelId: string) => void;
  setPrimaryTierModel: (tierId: string, modelId: string) => void;
  createTier: () => Promise<void>;
  deleteTier: (tierId: string) => Promise<void>;
  createRule: () => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  /** Band targets (add-band-target-ui). */
  setBandTarget: (band: 'auto_high' | 'auto_low', target: string) => Promise<void>;
  clearBand: (band: 'auto_high' | 'auto_low') => Promise<void>;
  cleanShadowed: (band: 'auto_high' | 'auto_low') => Promise<void>;
  retryRulesReconcile: () => Promise<void>;
  toggleAutoLayer: (layer: 'structural' | 'cascade' | 'semantic') => Promise<void>;
  // limits (#20)
  loadLimits: () => Promise<void>;
  openBudget: (budget?: BudgetDto) => void;
  saveBudget: () => Promise<void>;
  deleteBudget: (id: string) => Promise<void>;
  // notifications (#20)
  loadChannels: () => Promise<void>;
  openChannel: (channel?: ChannelDto) => void;
  saveChannel: () => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;
  toggleChannelEnabled: (channel: ChannelDto) => Promise<void>;
  testChannelById: (id: string) => Promise<void>;
  // onboarding (realized)
  obGo: (step: 1 | 2 | 3) => void;
  obCreateAgent: () => Promise<void>;
  obConnectProvider: () => Promise<void>;
  obVerify: () => Promise<void>;
  obFinish: () => void;
}

/** Monotonic layer tokens. Module-level so tokens stay unique across the many stores the
 * test suites construct — a token must never collide with one from another store. */
let nextLayerToken = 1;

export function createAppStore(client: ApiClient = realClient): AppStore {
  const [state, setState] = createStore<AppState>(initialState());
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  // Monotonic stamp for auto-performance loads (r3-High-1 race guard).
  let autoPerfSeq = 0;

  const say = (msg: string): void => {
    clearTimeout(toastTimer);
    setState('toast', msg);
    toastTimer = setTimeout(() => setState('toast', null), 1800);
  };

  // Shared error funnel (E12.1). A 401 after we've reached `ready` means the session
  // expired mid-session: re-probe via `bootstrap()` (which re-gates to login and
  // reloads login-config) instead of stranding the shell where every action fails
  // and the poll paints a permanent, unretryable error. The `ready` guard prevents
  // recursion — during bootstrap `authView` is `loading`, on the gate it's `gate`.
  // `bootstrap` is declared later in this closure but only ever CALLED here at event
  // time (well after init), so there is no temporal-dead-zone hazard.
  const err = (e: unknown): string => {
    if (isApiError(e) && e.status === 401 && state.authView === 'ready') void bootstrap();
    return errMessage(e);
  };

  // Keeps the `=> void` signature (onClick handlers stay void), but the clipboard
  // write is now authoritative (E12.2): on a non-secure origin `navigator.clipboard`
  // is undefined and on failure the write rejects — either way we toast a distinct
  // failure, never a false "Copied", so a user doesn't dismiss the shown-once key
  // reveal believing a copy that never happened.
  const copy = (txt: string, msg?: string): void => {
    void (async () => {
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(txt);
        say(msg ?? 'Copied');
      } catch {
        say('Copy failed — select the text manually');
      }
    })();
  };

  // --- realized loaders ---

  const loadAgents = async (): Promise<void> => {
    try {
      const rows = await client.listAgents();
      setState({ agents: rows.map(toAgent), agentsError: null });
    } catch (e) {
      setState('agentsError', err(e));
    }
  };

  /** Per-agent recent (24h) requests + spend from the `agent` analytics breakdown (A-29).
   * Requests the API cap (100 rows) so it isn't limited to the default top-10-by-spend.
   * Best-effort: a failure leaves `agentStatsLoaded` false so the UI shows `—` (unknown)
   * rather than presenting missing data as a measured zero — the agent list still renders. */
  const loadAgentStats = async (): Promise<void> => {
    setState('agentStatsLoaded', false); // a failed (re)load shows `—`, never stale figures
    try {
      const now = Date.now();
      const range = {
        from: new Date(now - 86_400_000).toISOString(),
        to: new Date(now).toISOString(),
      };
      const rows = await client.breakdown('agent', range, 100);
      setState(
        produce((s) => {
          const next: Record<string, { requests: number; spend: number }> = {};
          for (const r of rows) next[r.key] = { requests: r.requests, spend: r.spend };
          s.agentStats = next;
          s.agentStatsLoaded = true;
        }),
      );
    } catch {
      /* non-fatal — the agent list still renders; rows show `—` (not a false zero) */
    }
  };

  const loadProviders = async (): Promise<void> => {
    try {
      const rows = await client.listProviders();
      setState({ providers: rows.map(toProvider), providersError: null });
    } catch (e) {
      setState('providersError', err(e));
    }
  };

  const loadOauthPresets = async (): Promise<void> => {
    try {
      const presets = await client.listOauthPresets();
      setState('ow', 'presets', presets);
    } catch {
      setState('ow', 'presets', []); // no enabled presets ≡ cards hidden
    }
  };

  const loadModels = async (providerId: string): Promise<void> => {
    try {
      const rows = await client.listModels(providerId);
      setState('models', providerId, rows);
    } catch (e) {
      say(err(e));
    }
  };

  // --- config (#20): routing / limits / notifications loaders + helpers ---

  // Per-tier single-flight write coordination. `tierDesired` holds the LATEST
  // desired ordered modelIds per tier; `tierInFlight` marks a tier whose drain loop
  // is running. Writes are serialized per tier — one PUT at a time, always sending
  // the latest desired order — so overlapping edits can't lose a newer edit or roll
  // back across a later success. Rollback restores `confirmedEntries` (the last
  // SERVER-confirmed order), never a mid-drag optimistic order (blockers #1/#2).
  // Orders are generation-tagged: a queued order belongs to the identity that queued it,
  // so an old principal's write can never be sent (or applied) under a new session.
  const tierDesired = new Map<string, { modelIds: string[]; gen: number }>();
  const tierInFlight = new Set<string>();
  // ── Drag hold (fix-tier-chain-drag-reorder) ────────────────────────────────────────
  // `<For>` is keyed by reference, so ANY write that installs fresh server objects
  // disposes and rebuilds every row — destructive mid-drag. While a tier is held, writes
  // to its VISIBLE state are deferred as an immutable snapshot (never a thunk: a thunk
  // would re-read live state at apply time and could paint something never suppressed).
  // The confirmed baseline is server truth and keeps updating regardless.
  let dragHold: string | null = null;
  const tierPending = new Map<string, TierEntryDto[]>();
  const isHeld = (tierId: string): boolean => dragHold === tierId;
  /** Paint a deferred snapshot, unless the tier has since been deleted. */
  const applyPending = (tierId: string): void => {
    const pending = tierPending.get(tierId);
    tierPending.delete(tierId);
    if (pending === undefined || deletedTiers.has(tierId)) return;
    if (state.tierEntries[tierId] === undefined) return; // tier no longer present
    setState('tierEntries', tierId, pending);
  };
  const dropPending = (tierId: string): void => void tierPending.delete(tierId);

  // Auto-layer single-flight: serialize `setAutoLayers` so rapid toggles apply in
  // order, sending the latest desired state; roll back to the last confirmed view.
  let autoLayersDesired: {
    structural: boolean;
    cascade: boolean;
    semantic?: boolean;
    semanticLearning?: boolean;
  } | null = null;
  let autoLayersInFlight = false;
  let autoLayersConfirmed: AutoLayers | null = null;

  // Per-domain mutation sequences (the #19 generation-guard pattern applied to
  // load-vs-mutation): every config mutation bumps its domain counter; each loader
  // captures the counter before its GET(s) and discards its (now-stale) result if a
  // mutation raced in during the load — the optimistic/confirmed state is newer.
  let routingSeq = 0;
  let budgetsSeq = 0;
  let channelsSeq = 0;
  // Identity generation (add-auto-threshold-calibration r3-High-1): bumped on
  // sign-out and on session replacement, so identity-scoped routing/telemetry
  // caches can neither survive an account change nor be repopulated by an
  // in-flight response captured under the previous principal.
  let identityGen = 0;
  const bumpRouting = (): void => {
    routingSeq += 1;
  };
  // Dedicated LATEST-WINS rules generation (add-band-target-ui r2-High-1):
  // bumped when a reconcile (or a full routing load) STARTS; only the newest
  // committer wins. The domain-wide routingSeq cannot order concurrent rule
  // re-lists (any tier mutation bumps it), so rules convergence gets its own
  // counter. A SUPERSEDED run never reports success of its own (r3-High-1) —
  // it defers to the newest run's outcome, so `unverified` can only be
  // cleared by a reconcile that actually committed.
  let rulesGen = 0;
  let newestReconcile: Promise<'committed' | 'failed'> | null = null;
  const reconcileRules = (): Promise<'committed' | 'failed'> => {
    const gen = ++rulesGen;
    const idGen = identityGen;
    const holder: { run: Promise<'committed' | 'failed'> | null } = { run: null };
    const run: Promise<'committed' | 'failed'> = (async () => {
      let outcome: 'committed' | 'failed';
      try {
        const rows = await client.listRules();
        if (gen !== rulesGen || idGen !== identityGen) {
          outcome = 'failed'; // superseded — resolved below via the newest run
        } else {
          setState('rules', rows);
          setState('bt', 'unverified', false);
          outcome = 'committed';
        }
      } catch {
        outcome = 'failed';
      }
      // Superseded (a newer run started): our own result is meaningless —
      // report the NEWEST authoritative outcome instead (finite chain: each
      // hop awaits a strictly newer run).
      if (gen !== rulesGen && newestReconcile !== null && newestReconcile !== holder.run) {
        return newestReconcile;
      }
      return outcome;
    })();
    holder.run = run;
    newestReconcile = run;
    return run;
  };

  const resetIdentityScoped = (): void => {
    identityGen += 1;
    // Overlay state is identity-scoped: an expanded narrow-width nav that outlives a
    // sign-out would greet the next session with a scrim over `inert` content.
    setState('navExpanded', false);
    setState('accountMenuOpen', false);
    bumpRouting(); // discard in-flight routing loads captured under the old principal
    // The tier writer's bookkeeping is identity-scoped too: a queued order, a tombstone
    // or a deferred drag snapshot from the previous principal must never be sent or
    // painted under the new session. `tierInFlight` is not cleared — its drain loop owns
    // it and self-clears; the generation check makes those completions inert.
    tierDesired.clear();
    deletedTiers.clear();
    tierPending.clear();
    dragHold = null;
    rulesGen += 1; // an old account's in-flight rules reconcile can never commit (r3-High-2)
    // Live-view state is identity-scoped too (phase1-tune-dashboard-polling): the fold
    // state is closure-held, and the settle handoff's durable refresh is guarded only by
    // its SLICE generation (which orders requests *within* one identity and cannot detect
    // an identity change). Clear both, and invalidate `recent` so a refresh started under
    // the previous owner can never commit under the new one. At an identity boundary
    // tenant isolation overrides handoff continuity — dropping a row mid-settling-grace
    // is correct and required.
    inflightState = emptyStream();
    bump('recent');
    // The REQUEST VIEW crosses the boundary too (fix-request-view-identity-scope): the
    // paginated list with its cursor and frozen window, and — the part that matters most —
    // the inspector's cached payloads, which hold prompt and response TEXT.
    //
    // This `bump` is the ONLY thing stopping an in-flight `loadRequests` from committing
    // under the next account: that loader carries a slice token, which cannot see an
    // identity change on its own. Do not remove it.
    //
    // Bumping alone is not enough either — a superseded loader's `finally` is inert by
    // design, so the loading and error indicators must be reset here or the page latches a
    // spinner it can never clear. `reqFilter` is deliberately kept: a display preference,
    // not another owner's data.
    bump('requests');
    bump('newRows');
    // The Observe aggregates cross the boundary too (fix-analytics-identity-scope): spend
    // totals, the timeseries and the cost breakdowns are as much one account's data as its
    // request rows. Invalidate them AND clear what they populated — guarding the in-flight
    // response alone would leave the previous account's spend on screen — and normalise
    // their indicators, since a superseded slice's completion path is inert by design.
    bump('summary');
    bump('series');
    bump('breakdown');
    setState(
      produce((s) => {
        s.inflightRows = [];
        s.recentRequests = [];
        s.analyticsSummary = null;
        s.analyticsSummaryLoading = false;
        s.analyticsSummaryError = null;
        s.analyticsSeries = [];
        s.analyticsSeriesLoading = false;
        s.analyticsSeriesError = null;
        s.analyticsBreakdown = { model: [], provider: [], agent: [] };
        s.analyticsBreakdownLoading = false;
        s.analyticsBreakdownError = null;
        s.recentRequestsLoading = false;
        s.requestList = [];
        s.requestCursor = null;
        s.requestWindow = null;
        s.requestListLoading = false;
        s.requestListError = null;
        // Freshness state belongs to one owner and one frozen window.
        s.requestsPaged = false;
        s.requestsNew = null;
        s.selId = null;
        s.selBodies = { rows: null, loading: false, error: null };
        s.streamHealth = 'polling';
        s.autoLayers = null;
        s.calHistory = { rows: [], loaded: false, error: null };
        s.semLearn = { status: null, loaded: false, error: null };
        s.autoPerf = { data: null, loaded: false, error: null, range: '7d' };
        s.bt = {
          busy: { auto_high: false, auto_low: false },
          errors: { auto_high: null, auto_low: null },
          unverified: false,
        };
        s.pc = { status: null, loaded: false, loadError: null, refreshError: null, busy: false };
      }),
    );
  };
  const bumpBudgets = (): void => {
    budgetsSeq += 1;
  };
  const bumpChannels = (): void => {
    channelsSeq += 1;
  };
  // Tombstoned tier ids — a delete retires any queued/in-flight writer so a late PUT
  // response can't resurrect the tier's snapshot or raise a misleading 404 toast.
  const deletedTiers = new Set<string>();

  const loadRouting = async (): Promise<void> => {
    setState({ routingLoading: true, routingError: null });
    // Capture the mutation counter BEFORE the GETs; if any routing mutation lands
    // while we load, this GET saw the old config and must be discarded (else it
    // would restore stale visible state AND the stale rollback baseline).
    const seq = routingSeq;
    // A full routing load is an authoritative rules read too (r3-High-2): it
    // joins the rules generation so an in-flight reconcile can't overwrite it
    // (or vice versa), and its successful commit counts as verification.
    const rGen = ++rulesGen;
    try {
      // Providers ride along so the Routing page can label its model groups by
      // provider name even when the Providers page was never visited.
      const [tiers, models, rules, autoLayers, providerRows] = await Promise.all([
        client.listTiers(),
        client.listModels(),
        client.listRules(),
        client.getAutoLayers(),
        client.listProviders(),
      ]);
      const entries = await Promise.all(tiers.map((t) => client.listTierEntries(t.id)));
      if (routingSeq !== seq) return; // a mutation raced in — keep the newer state
      setState(
        produce((s) => {
          s.routingTiers = tiers;
          s.allModels = models;
          if (rGen === rulesGen) {
            s.rules = rules;
            s.bt.unverified = false; // an authoritative full read verified the truth
          }
          s.autoLayers = autoLayers;
          s.providers = providerRows.map(toProvider);
          // A refresh rebuilds every chain — which would rip the rows out from under a
          // live drag. The held tier keeps its visible order; its loaded list is deferred
          // and applied when the drag ends. Everything else loads normally, and the
          // confirmed baseline always tracks server truth.
          const held = dragHold;
          const heldVisible = held !== null ? s.tierEntries[held] : undefined;
          s.tierEntries = {};
          s.confirmedEntries = {};
          tiers.forEach((t, i) => {
            const list = entries[i] ?? [];
            s.confirmedEntries[t.id] = list.map((e) => e.modelId);
            if (t.id === held && heldVisible !== undefined) {
              s.tierEntries[t.id] = heldVisible;
              tierPending.set(t.id, list);
            } else {
              s.tierEntries[t.id] = list;
            }
          });
          // The held tier is GONE from an authoritative load — deleted by another
          // session. Preserving entries for a tier the load no longer lists would strand
          // an orphan array for a card that is no longer rendered, so abandon the drag
          // outright and let the load apply in full.
          if (held !== null && !tiers.some((t) => t.id === held)) {
            dragHold = null;
            tierPending.delete(held);
            tierDesired.delete(held);
            // Tombstone it exactly as a local delete would: an authoritative load saying
            // the tier is gone must also make a late `dragend` a no-op rather than PUT a
            // chain to a tier that no longer exists.
            deletedTiers.add(held);
          }
        }),
      );
      autoLayersConfirmed = autoLayers;
    } catch (e) {
      if (routingSeq === seq) setState('routingError', err(e));
    } finally {
      setState('routingLoading', false);
    }
  };

  const modelEntryInfo = (modelId: string): TierEntryDto['model'] => {
    const m = state.allModels.find((x) => x.id === modelId);
    return m
      ? {
          id: m.id,
          providerId: m.providerId,
          externalModelId: m.externalModelId,
          displayName: m.displayName,
        }
      : null;
  };

  const buildEntries = (tierId: string, modelIds: string[]): TierEntryDto[] =>
    modelIds.map((modelId, position) => ({
      id: `pending-${tierId}-${modelId}`,
      tierId,
      modelId,
      position,
      model: modelEntryInfo(modelId),
    }));

  const currentModelIds = (tierId: string): string[] =>
    (state.tierEntries[tierId] ?? []).map((e) => e.modelId);

  /** Apply an ordered chain optimistically (immediate UI), then schedule a
   * serialized PUT that sends the latest desired order. */
  const applyTierOrder = (tierId: string, modelIds: string[]): void => {
    setState('tierEntries', tierId, buildEntries(tierId, modelIds));
    scheduleTierWrite(tierId, modelIds);
  };

  const scheduleTierWrite = (tierId: string, modelIds: string[]): void => {
    if (deletedTiers.has(tierId)) return; // tombstoned — no writes for a deleted tier
    bumpRouting(); // a mutation is starting — invalidate any in-flight loadRouting
    tierDesired.set(tierId, { modelIds, gen: identityGen });
    if (!tierInFlight.has(tierId)) void drainTierWrites(tierId);
  };

  const drainTierWrites = async (tierId: string): Promise<void> => {
    tierInFlight.add(tierId);
    try {
      while (tierDesired.has(tierId)) {
        const queued = tierDesired.get(tierId);
        tierDesired.delete(tierId);
        if (queued === undefined) continue;
        // An order queued by a PREVIOUS principal must never be sent under this session.
        // Skipping only the state writes would not be enough: the send itself happens
        // below, and the loop keeps draining.
        if (queued.gen !== identityGen) continue;
        const gen = queued.gen;
        try {
          const entries = await client.replaceTierEntries(tierId, queued.modelIds);
          if (gen !== identityGen) continue; // identity changed mid-flight — inert
          if (deletedTiers.has(tierId)) continue; // deleted mid-flight — don't resurrect
          bumpRouting();
          setState(
            'confirmedEntries',
            tierId,
            entries.map((e) => e.modelId),
          );
          // Reconcile the visible chain to the server truth ONLY when no newer edit
          // is queued — else the newer optimistic state stays and the next PUT wins.
          // A live drag counts as a queued edit: defer rather than repaint under it.
          if (!tierDesired.has(tierId)) {
            if (isHeld(tierId)) tierPending.set(tierId, entries);
            else setState('tierEntries', tierId, entries);
          }
        } catch (e) {
          if (gen !== identityGen) continue; // stale: no state write AND no toast
          if (deletedTiers.has(tierId)) continue; // deleted — no misleading 404 toast
          // Roll back to the last CONFIRMED order (never the failed optimistic one),
          // and only when no newer edit is queued. Read the baseline HERE, after the
          // await — a value captured before it can be older than a reconcile that
          // landed while this PUT was in flight, and would then overwrite it.
          if (!tierDesired.has(tierId)) {
            const rollback = buildEntries(tierId, [...(state.confirmedEntries[tierId] ?? [])]);
            if (isHeld(tierId)) tierPending.set(tierId, rollback);
            else setState('tierEntries', tierId, rollback);
          }
          say(err(e));
        }
      }
    } finally {
      tierInFlight.delete(tierId);
    }
  };

  const scheduleAutoLayers = (desired: {
    structural: boolean;
    cascade: boolean;
    semantic?: boolean;
    semanticLearning?: boolean;
  }): void => {
    bumpRouting(); // an auto-layer mutation is starting — invalidate in-flight loads
    autoLayersDesired = desired;
    if (!autoLayersInFlight) void drainAutoLayers();
  };

  const drainAutoLayers = async (): Promise<void> => {
    autoLayersInFlight = true;
    try {
      while (autoLayersDesired !== null) {
        const desired = autoLayersDesired;
        autoLayersDesired = null;
        const confirmed = autoLayersConfirmed;
        try {
          const next = await client.setAutoLayers(desired);
          bumpRouting();
          autoLayersConfirmed = next;
          if (autoLayersDesired === null) setState('autoLayers', next);
        } catch (e) {
          if (autoLayersDesired === null && confirmed !== null) {
            setState('autoLayers', confirmed);
          }
          say(err(e));
        }
      }
    } finally {
      autoLayersInFlight = false;
    }
    // Any layer mutation can change L2 effectiveness (a dependency-down clears
    // learning server-side); refresh the card so it never shows a stale enabled/
    // source (clink change-4 Med-3). Guarded on capability so non-semantic
    // instances never fetch. All auto-layer writes serialize through this drain,
    // so semantic-learning toggles ride the same queue (clink change-4 Med-2).
    if (autoLayersConfirmed?.semanticAvailable === true) void loadSemanticLearning();
  };

  const loadCalHistory = async (): Promise<void> => {
    const gen = identityGen;
    try {
      const rows = await client.calibrationHistory();
      if (gen !== identityGen) return; // a different account signed in mid-flight
      setState('calHistory', { rows, loaded: true, error: null });
    } catch (e) {
      if (gen !== identityGen) return;
      setState('calHistory', (c) => ({ ...c, loaded: true, error: err(e) }));
    }
  };

  const loadSemanticLearning = async (): Promise<void> => {
    const gen = identityGen;
    try {
      const status = await client.semanticLearningStatus();
      if (gen !== identityGen) return; // a different account signed in mid-flight
      setState('semLearn', { status, loaded: true, error: null });
    } catch (e) {
      if (gen !== identityGen) return;
      setState('semLearn', (c) => ({ ...c, loaded: true, error: err(e) }));
    }
  };

  const loadPricingStatus = async (): Promise<void> => {
    const gen = identityGen;
    try {
      const status = await client.pricingStatus();
      if (gen !== identityGen) return;
      setState('pc', (c) => ({ ...c, status, loaded: true, loadError: null }));
    } catch (e) {
      if (gen !== identityGen) return;
      setState('pc', (c) => ({ ...c, loaded: true, loadError: err(e) }));
    }
  };

  const runPricingRefresh = async (): Promise<void> => {
    if (state.pc.busy) return; // single-flight
    // Identity captured BEFORE the POST: every completion-side write below is
    // guarded, so a sign-out/replacement mid-flight discards the effects
    // entirely (add-pricing-refresh-ui r1-Med-5).
    const gen = identityGen;
    setState('pc', (c) => ({ ...c, busy: true, refreshError: null }));
    try {
      const { added } = await client.pricingRefresh();
      if (gen !== identityGen) return;
      say(added > 0 ? `+${String(added)} price versions` : '+0 — no changes');
      await loadPricingStatus();
      if (gen !== identityGen) return;
      setState('pc', 'busy', false);
    } catch (e) {
      if (gen !== identityGen) return;
      // The REFRESH failed — its retry is the Refresh button itself, never a
      // status GET masquerading as one (r3-Med-4).
      setState('pc', (c) => ({ ...c, busy: false, refreshError: err(e) }));
    }
  };

  const loadAutoPerf = async (): Promise<void> => {
    // Race guard (r3-High-1): stamp each request; commit only if it is still
    // the newest AND the selected range hasn't moved — a slow older response
    // must never be labeled as the newly selected range.
    const requested = state.autoPerf.range;
    const seq = ++autoPerfSeq;
    const gen = identityGen; // never label another account's data (r3-High-1)
    const { from, to, bucket } = rangeToParams(requested, Date.now());
    try {
      const data = await client.autoPerformance({ from, to }, bucket);
      if (seq !== autoPerfSeq || gen !== identityGen || state.autoPerf.range !== requested) return;
      setState('autoPerf', { data, loaded: true, error: null, range: requested });
    } catch (e) {
      if (seq !== autoPerfSeq || gen !== identityGen || state.autoPerf.range !== requested) return;
      setState('autoPerf', 'error', err(e));
      setState('autoPerf', 'loaded', true);
    }
  };

  const loadTimeoutDefaults = async (): Promise<void> => {
    if (state.tdefaults !== null) return; // instance-constant — fetch once
    try {
      const d = await client.providerTimeoutDefaults();
      setState('tdefaults', d);
    } catch {
      // Placeholder-only data — the form falls back to neutral copy.
    }
  };

  const loadBodyCapture = async (): Promise<void> => {
    const gen = identityGen;
    try {
      const status = await client.bodyCaptureStatus();
      if (gen !== identityGen) return;
      setState('bc', { status, loaded: true, error: null, busy: false });
    } catch (e) {
      if (gen !== identityGen) return;
      setState('bc', (c) => ({ ...c, loaded: true, error: err(e), busy: false }));
    }
  };

  /** One guarded mutation runner for the capture card (single-flight). */
  const bcMutate = async (fn: () => Promise<unknown>, okMsg?: string): Promise<void> => {
    if (state.bc.busy) return;
    const gen = identityGen;
    setState('bc', (c) => ({ ...c, busy: true, error: null }));
    try {
      await fn();
      if (gen !== identityGen) return;
      if (okMsg !== undefined) say(okMsg);
      await loadBodyCapture();
    } catch (e) {
      if (gen !== identityGen) return;
      setState('bc', (c) => ({ ...c, busy: false, error: err(e) }));
    }
  };

  const setBodyCaptureMode = (mode: 'off' | 'errors_only' | 'all'): Promise<void> =>
    bcMutate(
      () => client.bodyCaptureUpdate({ mode }),
      mode === 'off' ? 'Body capture off' : 'Body capture on',
    );

  const setBodyCaptureRetention = (retentionDays: number | null): Promise<void> =>
    bcMutate(() =>
      client.bodyCaptureUpdate(
        retentionDays === null ? { retentionDays: null, keepForever: true } : { retentionDays },
      ),
    );

  const purgeBodies = (): Promise<void> =>
    bcMutate(async () => {
      const { purged } = await client.bodyCapturePurge();
      say(`Purged ${String(purged)} stored bod${purged === 1 ? 'y' : 'ies'}`);
    });

  const setAgentBodyOverride = (
    agentId: string,
    override: 'always' | 'never' | null,
  ): Promise<void> => bcMutate(() => client.bodyCaptureSetOverride(agentId, override));

  const loadSelectedBodies = async (id: string): Promise<void> => {
    const gen = identityGen;
    setState('selBodies', { rows: null, loading: true, error: null });
    try {
      const rows = await client.requestBodies(id);
      if (gen !== identityGen || state.selId !== id) return; // stale expand
      setState('selBodies', { rows, loading: false, error: null });
    } catch (e) {
      if (gen !== identityGen || state.selId !== id) return;
      setState('selBodies', { rows: null, loading: false, error: err(e) });
    }
  };

  const deleteSelectedBodies = async (id: string): Promise<void> => {
    const gen = identityGen;
    try {
      await client.deleteRequestBodies(id);
      if (gen !== identityGen) return;
      say('Payloads deleted');
      setState('selBodies', { rows: null, loading: false, error: null });
      // The row's flag clears so the section disappears (data-driven gate).
      setState('requestList', (rows) =>
        rows.map((r) => (r.id === id ? { ...r, hasBodies: false } : r)),
      );
      setState('recentRequests', (rows) =>
        rows.map((r) => (r.id === id ? { ...r, hasBodies: false } : r)),
      );
    } catch (e) {
      if (gen !== identityGen) return;
      setState('selBodies', (c) => ({ ...c, error: err(e) }));
    }
  };

  const loadLimits = async (): Promise<void> => {
    setState({ budgetsLoading: true, budgetsError: null });
    // Guard each list independently: a budget mutation must not discard the channel
    // refresh (and vice versa) — only the raced domain is stale.
    const bSeq = budgetsSeq;
    const cSeq = channelsSeq;
    try {
      const [budgets, channels] = await Promise.all([client.listBudgets(), client.listChannels()]);
      setState(
        produce((s) => {
          if (budgetsSeq === bSeq) s.budgets = budgets;
          if (channelsSeq === cSeq) s.channels = channels;
        }),
      );
    } catch (e) {
      if (budgetsSeq === bSeq) setState('budgetsError', err(e));
    } finally {
      setState('budgetsLoading', false);
    }
  };

  const loadChannels = async (): Promise<void> => {
    setState({ channelsLoading: true, channelsError: null });
    const cSeq = channelsSeq;
    try {
      const channels = await client.listChannels();
      if (channelsSeq === cSeq) setState('channels', channels); // discard if a mutation raced in
    } catch (e) {
      if (channelsSeq === cSeq) setState('channelsError', err(e));
    } finally {
      setState('channelsLoading', false);
    }
  };

  // --- observe (analytics) loaders ---

  // A monotonic generation PER SHARED mutable slice: whichever loader writes a
  // slice bumps its counter and applies its response only if still current, so a
  // stale (old-range) reply can't overwrite newer state — last-writer-wins across
  // pages (loadOverview/loadCosts share `summary` + the model breakdown).
  // `newRows` is the freshness probe's OWN generation (add-requests-freshness). Sharing
  // `requests` would let a probe cancel an append (or the reverse), and would let a late
  // probe restore the pill after the user had already clicked it or changed filters.
  const generation = { summary: 0, series: 0, breakdown: 0, recent: 0, requests: 0, newRows: 0 };
  type SliceKey = keyof typeof generation;
  const bump = (key: SliceKey): number => (generation[key] += 1);
  const isCurrent = (key: SliceKey, token: number): boolean => generation[key] === token;

  /** Run a single-slice fetch with loading/error + the stale-response guard.
   *
   * Identity-aware HERE rather than at each call site (fix-analytics-identity-scope). The
   * slice token orders responses within one identity — its comment above says as much: it
   * exists so a stale *old-range* reply cannot overwrite newer state — and by construction
   * cannot observe an account change.
   *
   * Be precise about what this line does and does not do. For every slice that exists today
   * it is **unreachable**: `resetIdentityScoped` bumps all four, and `identityGen += 1`
   * happens inside it, so the token check alone already rejects a response that crosses the
   * boundary — degrading this check leaves every test passing. It is kept because this is a
   * SHARED runner: a slice added later and not bumped at the boundary would otherwise be
   * unprotected, and being safe by default is worth one line. It is deliberately not
   * presented as tested, because it cannot be from outside this closure.
   */
  async function runSlice<T>(
    key: SliceKey,
    setLoading: (v: boolean) => void,
    setError: (v: string | null) => void,
    fetchFn: () => Promise<T>,
    apply: (data: T) => void,
  ): Promise<void> {
    const idGen = identityGen;
    const token = bump(key);
    const current = (): boolean => isCurrent(key, token) && idGen === identityGen;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFn();
      if (!current()) return;
      apply(data);
    } catch (e) {
      if (!current()) return;
      setError(err(e));
    } finally {
      if (current()) setLoading(false);
    }
  }

  const currentRange = (): { from: string; to: string; bucket: 'hour' | 'day' } =>
    rangeToParams(state.range, Date.now());

  const loadSummary = (range: { from: string; to: string }): Promise<void> =>
    runSlice(
      'summary',
      (v) => setState('analyticsSummaryLoading', v),
      (v) => setState('analyticsSummaryError', v),
      () => client.summary(range),
      (data) => setState('analyticsSummary', data),
    );

  // The breakdowns are one shared slice (Overview loads `model`; Costs loads all
  // three) — one generation so a stale reply is discarded wholesale.
  const loadBreakdowns = async (
    dims: CostDimension[],
    /** Overview passes `spend` EXPLICITLY: it shares this slice with Costs and must stay
     * spend-only, rather than inheriting whatever the Costs panels last selected. */
    metric: BreakdownMetric = 'spend',
  ): Promise<void> => {
    const { from, to } = currentRange();
    const range = { from, to };
    // Snapshot the axes BEFORE awaiting — a reply must be attributed to the selection it
    // was made under, not to whatever is selected when it lands.
    const forKey = { range: state.range, metric };
    const token = bump('breakdown');
    setState({ analyticsBreakdownLoading: true, analyticsBreakdownError: null });
    try {
      const results = await Promise.all(dims.map((d) => client.breakdown(d, range, undefined, metric)));
      if (!isCurrent('breakdown', token)) return;
      setState(
        produce((s) => {
          dims.forEach((d, i) => {
            s.analyticsBreakdown[d] = results[i] ?? [];
          });
          s.breakdownLoadedFor = forKey;
        }),
      );
    } catch (e) {
      if (!isCurrent('breakdown', token)) return;
      setState('analyticsBreakdownError', err(e));
    } finally {
      if (isCurrent('breakdown', token)) setState('analyticsBreakdownLoading', false);
    }
  };

  // add-inflight-requests: the live-view fold state is closure-held; only the
  // derived display array `inflightRows` lives in the reactive store.
  // ONE fold state for both drivers (phase2-add-dashboard-event-stream): the stream
  // and the poll must never diverge, so the appliers and the poll fold share it.
  let inflightState: StreamState = emptyStream();

  /** Fold-application epoch (add-requests-inflight-band).
   *
   * `loadInflight` captures this on START and refuses to commit if it has moved, so a
   * snapshot that lost the race cannot overwrite newer state. It is bumped by BOTH a newer
   * load and any stream mutation, because the two write the same fold: a poll still in
   * flight can land after an `onStarted`/`onSettled`/`onSnapshot` and undo it — the likelier
   * collision of the two on a healthy stream, where the stream is the continuous driver and
   * the poll is only reconciliation.
   *
   * `createPoller`'s single-flight is per instance, so it does not span a navigation: with
   * a second page mounting the poller, Overview's pending request outliving its unmount is
   * an ordinary occurrence rather than a remount edge case. */
  let inflightEpoch = 0;
  const bumpInflight = (): void => {
    inflightEpoch += 1;
  };
  const recentIdSet = (): ReadonlySet<string> => new Set(state.recentRequests.map((r) => r.id));
  const reconcileInflightDisplay = (): void => {
    const ids = recentIdSet();
    inflightState = { ...inflightState, ...reconcileInflightState(inflightState, ids) };
    setState('inflightRows', inflightDisplay(inflightState, ids));
  };

  const loadRecentRequests = async (): Promise<void> => {
    const { from, to } = currentRange();
    await runSlice(
      'recent',
      (v) => setState('recentRequestsLoading', v),
      (v) => setState('recentRequestsError', v),
      () => client.requests({ from, to, limit: 6 }),
      (page) => {
        setState('recentRequests', page.rows);
        reconcileInflightDisplay(); // durable rows arrived → drop covered live rows
      },
    );
  };

  /** Poll the live in-flight snapshot (add-inflight-requests). Any error degrades to
   * an unavailable snapshot — retain cached rows, never settle on it. */
  const loadInflight = async (): Promise<void> => {
    // Identity guard (phase1-tune-dashboard-polling): the fold applies EVERY response
    // unconditionally, so without this a response captured under the previous owner
    // could commit under the new one (invariant 5). Same discipline as the routing and
    // rules loaders.
    const idGen = identityGen;
    // Captured BEFORE awaiting: what this response is allowed to commit against.
    const epoch = ++inflightEpoch;
    let snap: InflightSnapshot;
    try {
      snap = await client.inflight();
    } catch {
      snap = { items: [], available: false, truncated: false };
    }
    if (idGen !== identityGen) return; // a different account signed in mid-flight
    // A newer load, or ANY stream mutation, has since written the fold. Applying this
    // snapshot now would resurrect rows that settled or settle rows that just started.
    if (epoch !== inflightEpoch) return;
    const ids = recentIdSet();
    const { next, refresh } = applyStreamSnapshot(inflightState, snap, ids, Date.now());
    inflightState = next;
    setState('inflightRows', inflightDisplay(next, ids));
    if (refresh) void loadRecentRequests(); // a settle was observed → durable refresh
  };

  /**
   * The SHARED aggregate-refresh budget (phase2-add-dashboard-event-stream).
   *
   * A nudge must not ADD to the analytics poll — it CONSUMES the next scheduled one, so
   * the COMBINED poll+nudge rate can never exceed the poll cadence. Routing both through
   * one floored gate is what makes that a property rather than a hope: a burst of 10k
   * settles cannot turn into a query storm. `force` is the mandatory hidden→visible
   * catch-up, which must never be suppressed.
   */
  const AGGREGATE_FLOOR_MS = 15_000;
  let lastAggregateAt = 0;
  const requestAggregateRefresh = async (
    load: () => Promise<void>,
    force = false,
  ): Promise<void> => {
    const t = Date.now();
    // `force` is phase 1's mandatory hidden→visible catch-up: it RESETS the shared
    // floor, so a nudge racing a visibility transition can neither fetch while hidden
    // nor suppress the catch-up.
    if (!force && t - lastAggregateAt < AGGREGATE_FLOOR_MS) return;
    lastAggregateAt = t;
    await load();
  };
  /** The loader for whichever aggregate page is on screen, or null elsewhere. */
  /** Requests newer than the frozen window (add-requests-freshness).
   *
   * `[window.to, now)`, exactly complementary to the list's `[window.from, window.to)` —
   * the API's range is half-open (`createdAt >= from AND createdAt < to`), so a row created
   * at precisely `window.to` is excluded from the list and counted here, once. Carries the
   * window's FROZEN filter, or it would count rows the filtered list would never show.
   *
   * Its own generation, so it can never cancel a list load or be restored by a late reply
   * after the user acted. It writes only `requestsNew` — never the list's own
   * loading/error/cursor/window. */
  const NEW_ROWS_CAP = 50;
  const probeNewRequests = async (): Promise<void> => {
    const window = state.requestWindow;
    if (window === null) return;
    const now = new Date().toISOString();
    // Never probe an inverted or empty range (clock skew, or an immediate re-probe).
    if (now <= window.to) return;
    const idGen = identityGen;
    const token = bump('newRows');
    const current = (): boolean => isCurrent('newRows', token) && idGen === identityGen;
    try {
      const page = await client.requests({
        from: window.to,
        to: now,
        limit: NEW_ROWS_CAP,
        ...filterToRequestParams(window.filter),
      });
      if (!current()) return;
      setState('requestsNew', {
        count: page.rows.length,
        // "more than this" comes from the CURSOR, not a full page: a page of exactly CAP
        // rows is not proof that more exist.
        atLeast: page.nextCursor !== null,
        unknown: false,
      });
    } catch {
      if (!current()) return;
      // A failed probe must NOT read as "nothing new" — that would present a stale list as
      // current, which is the thing this feature exists to prevent.
      setState('requestsNew', { count: 0, atLeast: false, unknown: true });
    }
  };

  /**
   * What the Requests page does when the shared budget offers it a refresh.
   *
   * Not `loadRequests(true)` directly: this seam is called by both the poll and the
   * `analytics.invalidated` nudge, and the right action depends on whether the user is in a
   * paging session. Wiring the reset in would let a nudge discard pages they asked for.
   */
  const refreshRequestsPage = async (): Promise<void> => {
    if (state.requestsPaged) return probeNewRequests();
    return loadRequests(true);
  };

  const currentAggregateLoader = (): (() => Promise<void>) | null =>
    state.page === 'costs'
      ? loadCosts
      : state.page === 'overview'
        ? loadOverview
        : // Returned `null` before add-requests-freshness, which is why the
          // `analytics.invalidated` nudge was silently dropped on the Requests page.
          state.page === 'requests'
          ? refreshRequestsPage
          : null;
  /** A nudge NEVER fetches while hidden — the stream is closed then anyway, and phase
   * 1's single catch-up owns the return. */
  const onAnalyticsNudge = (): void => {
    const load = currentAggregateLoader();
    if (load === null) return;
    // CANCELLED, not queued: the stream is closed while hidden anyway, and phase 1's
    // single mandatory catch-up on return covers the staleness.
    if (globalThis.document?.visibilityState === 'hidden') return;
    void requestAggregateRefresh(load);
  };

  /** A cheap authorization probe for stream failures: on success nothing changes (no
   * shell remount, no flicker); only a real `401` escalates to the full re-gate. */
  const probeSession = async (): Promise<void> => {
    try {
      await client.me();
    } catch (e) {
      if (isApiError(e) && e.status === 401) await bootstrap();
    }
  };

  // --- dashboard event stream ---
  let stream: EventStreamHandle | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let streamFactory: EventSourceFactory | undefined;

  const stopReconcile = (): void => {
    if (reconcileTimer !== undefined) {
      clearInterval(reconcileTimer);
      reconcileTimer = undefined;
    }
  };

  const disconnectStream = (): void => {
    stopReconcile();
    stream?.close();
    stream = null;
    setState('streamHealth', 'polling');
  };

  const connectStream = (): void => {
    if (stream !== null) return;
    // Every handler is bound to the identity generation: a frame from the previous
    // owner is DISCARDED, never folded (invariant 5).
    const idGen = identityGen;
    const fresh = (): boolean => idGen === identityGen;
    const handle = createEventStream({
      ...(streamFactory === undefined ? {} : { factory: streamFactory }),
      onSnapshot: (snap) => {
        if (!fresh()) return;
        bumpInflight(); // supersede any poll still in flight
        const ids = recentIdSet();
        const { next, refresh } = applyStreamSnapshot(inflightState, snap, ids, Date.now());
        inflightState = next;
        setState('inflightRows', inflightDisplay(next, ids));
        if (refresh) void loadRecentRequests();
      },
      onStarted: (row) => {
        if (!fresh()) return;
        bumpInflight();
        const ids = recentIdSet();
        inflightState = applyStarted(inflightState, row, ids, Date.now());
        setState('inflightRows', inflightDisplay(inflightState, ids));
      },
      onSettled: (id) => {
        if (!fresh()) return;
        bumpInflight();
        const { next, refresh } = applySettled(inflightState, id, Date.now());
        inflightState = next;
        setState('inflightRows', inflightDisplay(next, recentIdSet()));
        // An explicit settle is POSITIVE evidence — no waiting for a poll interval.
        if (refresh) void loadRecentRequests();
      },
      onInvalidated: () => {
        if (!fresh()) return;
        onAnalyticsNudge();
      },
      onResync: () => {
        if (!fresh()) return;
        // Drop delta state and re-establish authoritatively. The settling bridge is
        // preserved by the applier, so a resync mid-handoff never blinks a row.
        void loadInflight();
      },
      onUnexpectedFailure: () => {
        // A native EventSource reports no status or reason, so an auth-driven close is
        // indistinguishable from any other failure — probe unconditionally, which is
        // what makes the mid-session re-gate reliable. Use the LIGHT probe: a full
        // bootstrap would flip `authView` to 'loading' and remount the whole shell on
        // every transient stream hiccup.
        void probeSession();
      },
      onHealth: (h) => {
        if (fresh()) setState('streamHealth', h);
      },
      onReconcileMs: (ms) => {
        // While streaming, verify CONTENT (not just liveness) on a bounded low-rate
        // read: publication is best-effort, so a dropped started/settled must
        // self-correct rather than leave a heart-beating stream showing a wrong set.
        stopReconcile();
        reconcileTimer = setInterval(() => {
          if (fresh() && stream?.health() === 'live') void loadInflight();
        }, ms);
        reconcileTimer.unref?.();
      },
    });
    stream = handle;
  };

  const loadOverview = async (): Promise<void> => {
    const { from, to, bucket } = currentRange();
    const range = { from, to };
    await Promise.all([
      loadSummary(range),
      runSlice(
        'series',
        (v) => setState('analyticsSeriesLoading', v),
        (v) => setState('analyticsSeriesError', v),
        () => client.timeseries(range, bucket),
        (data) => setState('analyticsSeries', data),
      ),
      loadBreakdowns(['model'], 'spend'),
      loadRecentRequests(),
    ]);
  };

  const loadCosts = async (): Promise<void> => {
    const { from, to } = currentRange();
    await Promise.all([
      loadSummary({ from, to }),
      loadBreakdowns(['model', 'provider', 'agent'], state.breakdownMetric),
    ]);
  };

  /** Switching the metric REFETCHES rather than re-sorting: the server returns a top-N, so
   * the rows for one metric are not the rows for the other. */
  const setBreakdownMetric = (metric: BreakdownMetric): void => {
    if (state.breakdownMetric === metric) return;
    setState('breakdownMetric', metric);
    void loadBreakdowns(['model', 'provider', 'agent'], metric);
  };

  // On `reset` FREEZE {from,to}+filter into `requestWindow` and fetch page 1; on
  // append reuse the frozen window + cursor (never re-derive the range from the
  // clock). Window/list/cursor update atomically on success, so a failed reset
  // keeps the last-good page consistent with its cursor.
  const loadRequests = async (reset: boolean): Promise<void> => {
    if (!reset && (state.requestWindow === null || state.requestCursor === null)) return;
    // The slice token orders requests WITHIN one identity — it stops an older page-1 load
    // overwriting a newer one — and by construction cannot observe an identity change. What
    // makes it identity-safe is that `resetIdentityScoped` BUMPS it
    // (fix-request-view-identity-scope): removing that bump silently re-opens a hole where a
    // list begun as one account commits under the next. Guarded by
    // `requestViewIdentity.test.tsx`, which fails if it goes.
    const token = bump('requests');
    const current = (): boolean => isCurrent('requests', token);
    setState({ requestListLoading: true, requestListError: null });
    try {
      if (reset) {
        // A reset ends the paging session and retires any pending disclosure.
        setState({ requestsPaged: false, requestsNew: null });
        const { from, to } = currentRange();
        const window: RequestWindow = { from, to, filter: state.reqFilter };
        const page = await client.requests({
          from,
          to,
          limit: REQUEST_PAGE_SIZE,
          ...filterToRequestParams(window.filter),
        });
        if (!current()) return;
        setState(
          produce((s) => {
            s.requestWindow = window;
            s.requestList = page.rows;
            s.requestCursor = page.nextCursor;
          }),
        );
      } else {
        const window = state.requestWindow;
        const cursor = state.requestCursor;
        if (window === null || cursor === null) return;
        // Marked HERE, before awaiting: a freshness refresh landing mid-append must see a
        // paging session in progress and stand down, or it would discard this very call.
        setState('requestsPaged', true);
        const page = await client.requests({
          from: window.from,
          to: window.to,
          limit: REQUEST_PAGE_SIZE,
          cursor,
          ...filterToRequestParams(window.filter),
        });
        if (!current()) return;
        setState(
          produce((s) => {
            s.requestList = [...s.requestList, ...page.rows];
            s.requestCursor = page.nextCursor;
          }),
        );
      }
    } catch (e) {
      if (!isCurrent('requests', token)) return;
      if (!current()) return;
      setState('requestListError', err(e));
    } finally {
      if (current()) setState('requestListLoading', false);
    }
  };

  // --- URL routing (add-dashboard-hash-routing) ---

  /** Pages gated on a predicate over the CURRENT state. A URL must not reach a
   * surface the chrome hides: the Users area is admin-only
   * (`user-administration`), enforced today only by the sidebar omitting its
   * nav entry — which a fragment walks straight around. Generic by design, so
   * a future gated page inherits the rule by adding one entry. */
  const PAGE_ALLOWED: Partial<Record<Page, () => boolean>> = {
    users: () => state.session?.role === 'admin',
  };
  const pageAllowed = (page: Page): boolean => PAGE_ALLOWED[page]?.() ?? true;

  /** The page requested by URL but not yet adjudicated. Held (not rendered)
   * until the authorization probe resolves, so a gated surface never mounts on
   * a guess. Retained across the login gate — authenticating re-runs
   * `bootstrap`, which adjudicates again — and cleared once decided. */
  let heldPage: Page | null = null;
  /** False on the public accept-invite route: the router never runs there, so
   * it can neither parse the token fragment as a page nor write over it. */
  let routingActive = false;

  /** Write the canonical fragment for `page` IN PLACE, and only when it differs.
   * `replaceState` edits the current entry, so it never disturbs the forward
   * stack — which is why browser-originated transitions may use it. */
  const canonicalize = (page: Page): void => {
    if (!routingActive) return;
    const want = hashForPage(page);
    if (globalThis.location.hash !== want) {
      globalThis.history.replaceState(null, '', want);
    }
  };

  /** Set the page and clear the page-local selection. Both directions share
   * this, so a record inspector opened on one page is never left open over
   * another however the change arrived. */
  const setPage = (page: Page): void => {
    if (state.page !== page || state.selId !== null) setState({ page, selId: null });
  };

  /** APP-originated transition (nav click, onboarding reset). May write
   * history: pushes on a real change, replaces when already on that page so
   * repeat clicks accumulate nothing. */
  const navigate = (page: Page): void => {
    const target = pageAllowed(page) ? page : DEFAULT_PAGE;
    if (routingActive) {
      const want = hashForPage(target);
      if (target === state.page) globalThis.history.replaceState(null, '', want);
      else globalThis.history.pushState(null, '', want);
    }
    setPage(target);
  };

  /** BROWSER-originated transition. Never pushes. Writes nothing when the
   * location is recognized AND admitted; replaces only to canonicalize an
   * unrecognized or unauthorized one. Idempotent, so `hashchange` and
   * `popstate` both firing for one traversal is harmless. */
  function applyLocation(): void {
    if (!routingActive) return;
    const want = pageFromHash(globalThis.location.hash);
    if (want === null) {
      setPage(DEFAULT_PAGE);
      canonicalize(DEFAULT_PAGE);
      return;
    }
    // Unresolved authorization: hold rather than decide. `bootstrap` will
    // adjudicate once a session (or its absence) is known.
    if (state.authView !== 'ready') {
      heldPage = want;
      return;
    }
    if (!pageAllowed(want)) {
      setPage(DEFAULT_PAGE);
      canonicalize(DEFAULT_PAGE);
      return;
    }
    setPage(want); // recognized + admitted → no history write at all
  }

  /** Adjudicate a held (or currently-rendered) page against the resolved
   * session, just before the shell renders. Three states, not two:
   * unresolved/unauthenticated retains (handled by not calling this), admitted
   * lands with no history write, denied is replaced with the default. Also
   * re-runs on every identity change, so an admin's Users page is not left
   * rendered after re-authenticating as a non-admin. */
  const adjudicateRoute = (): void => {
    const target = heldPage ?? state.page;
    heldPage = null;
    if (!routingActive) {
      // No URL to reconcile (accept-invite): still enforce the predicate.
      if (!pageAllowed(target)) setPage(DEFAULT_PAGE);
      return;
    }
    if (pageAllowed(target)) {
      setPage(target);
      canonicalize(target); // no-op when the fragment already matches
    } else {
      setPage(DEFAULT_PAGE);
      canonicalize(DEFAULT_PAGE);
    }
  };

  function startRouting(): () => void {
    // The accept-invite fragment carries a SECRET that `bootstrap` scrubs. The
    // router does not start here at all: it never parses that fragment as a
    // page and never writes over it.
    if (globalThis.location.pathname === '/accept-invite') return () => undefined;
    routingActive = true;
    heldPage = pageFromHash(globalThis.location.hash);
    const onNav = (): void => applyLocation();
    globalThis.addEventListener('hashchange', onNav);
    globalThis.addEventListener('popstate', onNav);
    return () => {
      globalThis.removeEventListener('hashchange', onNav);
      globalThis.removeEventListener('popstate', onNav);
      routingActive = false;
      heldPage = null;
    };
  }

  // --- auth bootstrap / gate ---

  const bootstrap = async (): Promise<void> => {
    // Public accept-invite page: the token travels in the URL FRAGMENT (never
    // sent to the server, so no access-log/Referer exposure). Capture it, scrub
    // it from the URL immediately, and render WITHOUT a session.
    if (globalThis.location.pathname === '/accept-invite') {
      const token = new URLSearchParams(globalThis.location.hash.replace(/^#/, '')).get('token');
      globalThis.history.replaceState(null, '', '/accept-invite');
      setState({ inviteToken: token, authView: 'invite', authError: null });
      return;
    }
    setState({ authView: 'loading', authError: null });
    let session: SessionInfo;
    try {
      session = await client.me();
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        // Clear identity-scoped state EAGERLY, while we still have the previous
        // session (phase1-tune-dashboard-polling). The detect-a-change reset below
        // requires a non-null previous session — so once this branch nulls it, a
        // later sign-in as a DIFFERENT user is undetectable and `identityGen` would
        // never bump, leaving the old owner's cached rows and in-flight responses
        // able to commit under the new one.
        if (state.session !== null) resetIdentityScoped();
        let cfg: LoginConfig | null = null;
        try {
          cfg = await client.loginConfig();
        } catch {
          // keep cfg null — the gate renders email/password without OAuth buttons
        }
        setState({ session: null, loginConfig: cfg, authView: 'gate' });
      } else {
        setState({ authView: 'error', authError: err(e) });
      }
      return;
    }
    // A DIFFERENT principal than the one whose data is cached → hard reset of
    // identity-scoped slices before anything renders (r3-High-1).
    if (state.session !== null && state.session.userId !== session.userId) {
      resetIdentityScoped();
    }
    setState('session', session);
    await Promise.all([loadAgents(), loadProviders()]);
    // Adjudicate the requested/current page BEFORE the shell renders: `App`
    // gates `Shell` on `authView === 'ready'`, so deciding first means a gated
    // surface never mounts, not even for a frame. Re-runs on every successful
    // probe, which is also every identity change.
    adjudicateRoute();
    setState({ authView: 'ready', authError: null });
  };

  const runEmailAuth = async (fn: () => Promise<void>): Promise<void> => {
    setState({ authBusy: true, authError: null });
    try {
      await fn();
      await bootstrap();
    } catch (e) {
      setState('authError', err(e));
    } finally {
      setState('authBusy', false);
    }
  };

  // --- user administration (admin-only) + accept-invite ---

  const loadUserAdmin = async (): Promise<void> => {
    setState('ua', { loading: true, error: null });
    try {
      const [users, invites, reg] = await Promise.all([
        client.adminListUsers(),
        client.adminListInvites(),
        client.adminGetRegistration(),
      ]);
      setState('ua', { users, invites, reg, loading: false });
    } catch (e) {
      setState('ua', { loading: false, error: err(e) });
    }
  };

  /** Shared shape for the mutate-then-reload admin actions. */
  const uaMutate = async (fn: () => Promise<void>): Promise<void> => {
    setState('ua', 'error', null);
    try {
      await fn();
      await loadUserAdmin();
    } catch (e) {
      setState('ua', 'error', err(e));
    }
  };

  const uaCreateInvite = async (): Promise<void> => {
    if (state.ua.inviteBusy) return;
    const email = state.ua.inviteEmail.trim();
    if (email === '') {
      setState('ua', 'error', 'enter an email to invite');
      return;
    }
    setState('ua', { inviteBusy: true, error: null });
    try {
      const res = await client.adminCreateInvite(email);
      setState('ua', {
        inviteBusy: false,
        inviteEmail: '',
        issued: { email: res.invite.email, link: res.link, emailSent: res.emailSent },
      });
      await loadUserAdmin();
    } catch (e) {
      setState('ua', { inviteBusy: false, error: err(e) });
    }
  };

  const acceptInvite = async (): Promise<void> => {
    if (state.ai.busy) return;
    const token = state.inviteToken;
    if (token === null || token === '') {
      setState('ai', 'error', 'this invite link is missing its token — ask for a fresh link');
      return;
    }
    setState('ai', { busy: true, error: null });
    try {
      await client.acceptInvite({ token, name: state.ai.name.trim(), password: state.ai.password });
      // The accept response set the session cookie; boot fresh as a signed-in user.
      globalThis.location.assign('/');
    } catch (e) {
      setState('ai', { busy: false, error: err(e) });
    }
  };

  // --- store shape ---

  return {
    state,
    setState,

    go: (page) => navigate(page),
    startRouting,
    applyLocation,
    toggleTheme: () => {
      const theme: Theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset['theme'] = theme;
      try {
        localStorage.setItem('polyrouter-theme', theme);
      } catch {
        // storage unavailable — theme just won't persist
      }
      setState('theme', theme);
    },
    dismissSetupGuide: () => {
      try {
        localStorage.setItem('polyrouter-setup-dismissed', '1');
      } catch {
        // storage unavailable — the dismissal just won't survive a reload
      }
      setState('setupDismissed', true);
    },
    registerLayer: ({ kind, root, onDismiss }) => {
      const token = nextLayerToken++;
      // UNTRACKED read. `useLayer` calls this from a `createEffect`; reading `state.layers`
      // tracked would make that effect depend on the very array it is about to write,
      // re-running it forever. The registry is a side-effect target here, never an input.
      const current = untrack(() => state.layers);
      // A dialog asserts isolation, so any transient not opened FROM it is superseded —
      // otherwise a page-level menu stays above a modal opened after it.
      if (kind === 'dialog') {
        for (const t of supersededByDialog(current)) t.onDismiss();
      }
      setState('layers', (ls) => [
        ...ls.filter((l) => l.token !== token),
        { token, kind, root, onDismiss },
      ]);
      return token;
    },
    layerZ: (token) => {
      const i = state.layers.findIndex((l) => l.token === token);
      return zForIndex(i < 0 ? 0 : i);
    },
    removeLayer: (token) => {
      // By token, from anywhere — a layer beneath an open one can be removed, and a pop()
      // would take the wrong entry.
      setState('layers', (ls) => ls.filter((l) => l.token !== token));
    },
    setNavExpanded: (open) => {
      // Collapsing the nav takes the account menu with it: the menu lives inside the
      // expanded panel, so leaving it "open" behind a collapsed rail would strand a
      // dismissible surface with nothing to dismiss it.
      setState('navExpanded', open);
      if (!open) setState('accountMenuOpen', false);
    },
    setAccountMenuOpen: (open) => setState('accountMenuOpen', open),
    setRange: (range) => setState('range', range),
    setBreakdownMetric,
    loadAutoPerf,
    setAutoPerfRange: (range) => {
      // Clear stale data so the section shows Loading for the new range, never
      // old-range numbers under a new-range selector (r3-High-1) — then fetch
      // it HERE (the mount-time load only covers page visits).
      setState('autoPerf', { range, loaded: false, data: null, error: null });
      void loadAutoPerf();
    },
    setFilter: (reqFilter) => {
      setState('reqFilter', reqFilter);
      void loadRequests(true);
    },
    select: (id) =>
      setState({ selId: id, selBodies: { rows: null, loading: false, error: null } }),
    say,
    clearToast: () => {
      clearTimeout(toastTimer);
      setState('toast', null);
    },
    copy,

    loadOverview,
    loadCosts,
    loadRecentRequests,
    loadInflight,
    connectStream,
    disconnectStream,
    setStreamFactory: (factory: EventSourceFactory) => {
      streamFactory = factory;
    },
    requestAggregateRefresh,
    loadRequests,
    refreshRequestsPage,

    bootstrap,
    retry: bootstrap,
    loadUserAdmin,
    uaCreateInvite,
    uaRevokeInvite: (inviteId) => uaMutate(() => client.adminRevokeInvite(inviteId)),
    uaSetRole: (userId, role) => uaMutate(() => client.adminSetRole(userId, role)),
    uaSetDisabled: async (userId, disabled) => {
      // Self-disable revokes THIS session server-side: don't reload the admin
      // data (it would just 401) — reboot to the login gate.
      if (disabled && userId === state.session?.userId) {
        setState('ua', 'error', null);
        try {
          await client.adminSetDisabled(userId, disabled);
          globalThis.location.assign('/');
        } catch (e) {
          setState('ua', 'error', err(e));
        }
        return;
      }
      await uaMutate(() => client.adminSetDisabled(userId, disabled));
    },
    uaDeleteUser: async (userId) => {
      // Deleting yourself removes the account under this session — reboot.
      if (userId === state.session?.userId) {
        setState('ua', 'error', null);
        try {
          await client.adminDeleteUser(userId);
          globalThis.location.assign('/');
        } catch (e) {
          setState('ua', 'error', err(e));
        }
        return;
      }
      await uaMutate(() => client.adminDeleteUser(userId));
    },
    uaSetRegistration: (mode) => uaMutate(() => client.adminSetRegistration(mode)),
    acceptInvite,
    signIn: (input) => runEmailAuth(() => client.signInEmail(input)),
    signUp: (input) => runEmailAuth(() => client.signUpEmail(input)),
    oauth: async (provider) => {
      setState({ authBusy: true, authError: null });
      try {
        // Fixed SPA path — better-auth restricts callbackURL to trustedOrigins, so
        // no open redirect. Dev caveat: OAuth callback cookies are host-only, so a
        // dev round-trip needs BETTER_AUTH_URL and DASHBOARD_ORIGIN on the SAME host
        // (set BETTER_AUTH_URL to the dashboard host, or run Vite on 127.0.0.1).
        const callbackURL = `${globalThis.location.origin}/`;
        const { url } = await client.signInSocial(provider, callbackURL);
        // A bare POST does not begin OAuth — the browser must navigate to `url`.
        try {
          globalThis.location.assign(url);
        } catch {
          // non-navigable environment (tests) — nothing else to do
        }
      } catch (e) {
        setState({ authError: err(e), authBusy: false });
      }
    },
    signOut: async () => {
      // Clear ALL raw agent keys first — reveal + onboarding secrets — plus the
      // provider-retry identity, so a different account can't reuse this run's provider (A-26).
      // Same for identity-scoped admin state: the user list and any one-time
      // invite link must not survive into the next account's session.
      setState(
        produce((s) => {
          s.kr = emptyKeyReveal();
          s.ob.key = '';
          s.ob.snippet = '';
          s.ob.providerId = null;
          s.ob.provInput = null;
          s.modal = null;
          s.ua = {
            users: [],
            invites: [],
            reg: null,
            loading: false,
            error: null,
            inviteEmail: '',
            inviteBusy: false,
            issued: null,
          };
          s.inviteToken = null;
          s.ai = { name: '', password: '', busy: false, error: null };
        }),
      );
      resetIdentityScoped(); // calibration/telemetry caches never outlive the account (r3-High-1)
      try {
        await client.signOut();
      } catch {
        // ignore — bootstrap decides the resulting view (loopback stays ready)
      }
      await bootstrap();
    },

    loadAgents,
    loadAgentStats,
    createAgent: async () => {
      if (state.na.busy) return; // single-flight — no double-submit duplicates (A-27)
      const name = state.na.name.trim();
      if (!name) {
        setState('na', 'error', 'Name is required');
        return;
      }
      setState('na', { busy: true, error: null });
      try {
        const reveal = await client.createAgent({ name, harness: state.na.harness });
        setState(
          produce((s) => {
            s.agents = [toAgent(reveal), ...s.agents];
            s.kr = {
              title: `Key minted — ${reveal.name}`,
              key: reveal.key,
              snippet: reveal.snippet,
              harness: toHarness(reveal.harness),
            };
            s.modal = 'keyReveal';
            s.na = { name: '', harness: 'openai_sdk', busy: false, error: null };
          }),
        );
      } catch (e) {
        setState('na', { busy: false, error: err(e) });
      }
    },
    rotateKey: async (agent) => {
      try {
        const reveal = await client.rotateAgentKey(agent.id);
        setState(
          produce((s) => {
            const idx = s.agents.findIndex((a) => a.id === agent.id);
            if (idx >= 0) s.agents[idx] = toAgent(reveal);
            s.kr = {
              title: `New key — ${reveal.name}`,
              key: reveal.key,
              snippet: reveal.snippet,
              harness: toHarness(reveal.harness),
            };
            s.modal = 'keyReveal';
          }),
        );
      } catch (e) {
        say(err(e));
      }
    },
    deleteAgent: async (agent) => {
      try {
        await client.deleteAgent(agent.id);
        setState('agents', (list) => list.filter((a) => a.id !== agent.id));
        say(`Agent ${agent.name} deleted`);
      } catch (e) {
        say(err(e));
      }
    },

    loadProviders,
    loadTimeoutDefaults,
    addProvider: async () => {
      if (state.np.busy) return; // single-flight — no double-submit duplicates (A-27)
      const form = state.np;
      if (!form.name.trim()) {
        setState('np', 'error', 'Name is required');
        return;
      }
      if (!form.baseUrl.trim()) {
        setState('np', 'error', 'Base URL is required');
        return;
      }
      setState('np', { busy: true, error: null });
      const editingId = form.editingId;
      try {
        if (editingId !== null) {
          // Edit: PATCH the merged config. Credential follows the write-only contract —
          // blank PRESERVES the stored key (omit), the explicit clear sends '' (clear),
          // a typed value rotates it. Never send '' implicitly.
          // An OAuth-connected row's endpoint/kind/protocol are preset-pinned (the
          // server 422s any drift, and a Responses row's protocol isn't even in the
          // public enum) — submit a NAME-ONLY patch for those rows.
          const patch: UpdateProviderInput =
            form.oauthPreset !== null
              ? {
                  // OAuth rows pin endpoint/kind/protocol server-side; name AND the
                  // patience overrides are freely editable (fix-long-call-timeouts
                  // impl-Med-2 — silently discarding a rendered field is a lie).
                  name: form.name.trim(),
                  firstByteTimeoutMs:
                    parseTimeoutS(form.firstByteTimeoutS, 'First-byte patience') ?? null,
                  idleTimeoutMs: parseTimeoutS(form.idleTimeoutS, 'Idle patience') ?? null,
                }
              : {
                  name: form.name.trim(),
                  kind: UI_TO_API_KIND[form.kind],
                  // The connect-only protocol is not in the public enum — omit it
                  // (unchangeable anyway) so a rename still works on such a row.
                  ...(form.protocol !== 'openai_responses' ? { protocol: form.protocol } : {}),
                  baseUrl: form.baseUrl.trim(),
                  // Patience: blank = clear to inherit (explicit null), value = set
                  // (fix-long-call-timeouts).
                  firstByteTimeoutMs:
                    parseTimeoutS(form.firstByteTimeoutS, 'First-byte patience') ?? null,
                  idleTimeoutMs: parseTimeoutS(form.idleTimeoutS, 'Idle patience') ?? null,
                };
          const typed = form.credential.trim();
          if (form.clearCredential) patch.credential = '';
          else if (typed) patch.credential = typed;
          const updated = await client.updateProvider(editingId, patch);
          setState(
            produce((s) => {
              s.providers = s.providers.map((p) => (p.id === editingId ? toProvider(updated) : p));
              s.np = emptyNp();
              s.modal = null;
            }),
          );
          say(`Provider ${updated.name} updated`);
          return;
        }
        const created = await client.createProvider(buildProviderInput(form));
        setState(
          produce((s) => {
            s.providers = [...s.providers, toProvider(created)];
            s.np = emptyNp();
            s.modal = null;
          }),
        );
        say(`Provider ${created.name} added — test the connection & sync models`);
      } catch (e) {
        setState('np', { busy: false, error: err(e) });
      }
    },
    openEditProvider: (p) => {
      setState({
        modal: 'editProvider',
        np: {
          name: p.name,
          kind: apiKindToUi(p.kind),
          protocol: p.protocol as ProviderForm['protocol'],
          baseUrl: p.baseUrl ?? '',
          credential: '',
          busy: false,
          error: null,
          editingId: p.id,
          hadCredential: p.hasCredential,
          clearCredential: false,
          origKind: apiKindToUi(p.kind),
          oauthPreset: p.oauthPreset,
          firstByteTimeoutS: p.firstByteTimeoutMs === null ? '' : String(p.firstByteTimeoutMs / 1000),
          idleTimeoutS: p.idleTimeoutMs === null ? '' : String(p.idleTimeoutMs / 1000),
        },
      });
      void loadTimeoutDefaults();
    },

    loadOauthPresets,
    startOauthConnect: async (preset) => {
      if (state.ow.busy) return;
      setState('ow', { busy: true, error: null });
      try {
        const name = state.np.name.trim();
        const start = await client.oauthStart(preset, name === '' ? undefined : name);
        setState('ow', {
          busy: false,
          pasted: '',
          active: {
            preset,
            sessionId: start.sessionId,
            authorizeUrl: start.authorizeUrl,
            reauthorizeProviderId: null,
          },
        });
      } catch (e) {
        setState('ow', { busy: false, error: err(e) });
      }
    },
    startOauthReauthorize: async (p) => {
      if (state.ow.busy) return;
      setState({ modal: 'newProvider', np: { ...emptyNp(), kind: 'sub' } });
      setState('ow', { busy: true, error: null, presets: state.ow.presets });
      try {
        const start = await client.oauthReauthorize(p.id);
        setState('ow', {
          busy: false,
          pasted: '',
          active: {
            preset: p.oauthPreset ?? '',
            sessionId: start.sessionId,
            authorizeUrl: start.authorizeUrl,
            reauthorizeProviderId: p.id,
          },
        });
      } catch (e) {
        setState('ow', { busy: false, error: err(e) });
      }
    },
    completeOauthConnect: async () => {
      const ow = state.ow;
      if (ow.busy || ow.active === null) return;
      const pasted = ow.pasted.trim();
      // Client-side mirror of the backend contract: both accepted forms carry state.
      // A bare code gets guidance without a round-trip.
      if (!/^https?:\/\//i.test(pasted) && !pasted.includes('#')) {
        // Credential material is cleared on EVERY completion attempt, including this
        // client-side rejection.
        setState('ow', {
          pasted: '',
          error: 'paste the full redirect URL or the code#state string shown after signing in',
        });
        return;
      }
      setState('ow', { busy: true, error: null });
      const isReauthorize = ow.active.reauthorizeProviderId !== null;
      try {
        const dto = await client.oauthComplete(ow.active.sessionId, pasted);
        setState(
          produce((s) => {
            const provider = toProvider(dto);
            s.providers = isReauthorize
              ? s.providers.map((x) => (x.id === provider.id ? provider : x))
              : [...s.providers, provider];
            s.ow = {
              presets: s.ow.presets,
              active: null,
              pasted: '',
              busy: false,
              error: null,
              advanced: false,
            };
            s.modal = null;
          }),
        );
        say(
          isReauthorize
            ? `${dto.name} reconnected — tokens will auto-refresh`
            : `${dto.name} connected — sync models to start routing`,
        );
      } catch (e) {
        // The pasted value is credential material — cleared after every submit attempt.
        setState('ow', { busy: false, pasted: '', error: err(e) });
      }
    },
    cancelOauthConnect: () => {
      if (state.ow.busy) return;
      setState('ow', { active: null, pasted: '', error: null });
    },
    testProviderById: async (id) => {
      try {
        const result = await client.testProvider(id);
        setState('providers', (p) => p.id === id, 'status', result.status);
        say(result.ok ? 'Connection ok' : `Connection failed — ${result.message}`);
      } catch (e) {
        say(err(e));
      }
    },
    syncProvider: async (id) => {
      try {
        const result = await client.syncModels(id);
        setState('providers', (p) => p.id === id, 'status', result.status);
        if (result.ok) {
          await loadModels(id);
          say(`Synced ${String(result.synced ?? 0)} models`);
        } else {
          say(`Sync failed — ${result.message}`);
        }
      } catch (e) {
        say(err(e));
      }
    },
    deleteProvider: async (id) => {
      try {
        await client.deleteProvider(id);
        setState(
          produce((s) => {
            s.providers = s.providers.filter((p) => p.id !== id);
            delete s.models[id];
          }),
        );
        say('Provider deleted');
      } catch (e) {
        say(err(e));
      }
    },
    loadModels,
    setModelPrice: async (providerId, modelId, body) => {
      try {
        const updated = await client.updateModelPricing(modelId, body);
        setState('models', providerId, (list) =>
          (list ?? []).map((m) => (m.id === modelId ? updated : m)),
        );
        say('Price updated');
      } catch (e) {
        say(err(e));
      }
    },

    openModal: (modal) => {
      if (modal === 'newProvider') void loadTimeoutDefaults();
      if (modal === 'newAgent') {
        setState({ modal, na: { name: '', harness: 'openai_sdk', busy: false, error: null } });
      } else if (modal === 'newProvider') {
        setState({ modal, np: emptyNp() });
        setState('ow', { active: null, pasted: '', busy: false, error: null, advanced: false });
        void loadOauthPresets();
      } else {
        setState('modal', modal);
      }
    },
    closeModal: () => {
      // Don't dismiss a modal while its save is in flight — a cancel→reopen→save
      // would let the first completion reset the newer modal (busy-dismissal a11y).
      if (
        (state.modal === 'newLimit' && state.bf.busy) ||
        (state.modal === 'channel' && state.cf.busy) ||
        ((state.modal === 'newProvider' || state.modal === 'editProvider') &&
          (state.np.busy || state.ow.busy))
      ) {
        return;
      }
      setState(
        produce((s) => {
          s.kr = emptyKeyReveal();
          s.np.busy = false;
          s.np.error = null;
          // Abandon any open connect wizard (its server session simply expires); the
          // pasted value is credential material and never survives the modal.
          s.ow = {
            presets: s.ow.presets,
            active: null,
            pasted: '',
            busy: false,
            error: null,
            advanced: false,
          };
          s.modal = null;
        }),
      );
    },

    loadRouting,
    moveTierEntry: (tierId, from, to) => {
      setState(
        produce((s) => {
          const list = s.tierEntries[tierId];
          if (!list) return;
          const [moved] = list.splice(from, 1);
          if (moved === undefined) return;
          list.splice(to, 0, moved);
          list.forEach((e, i) => {
            e.position = i;
          });
        }),
      );
    },
    // The chain is already reordered locally by `moveTierEntry` during the drag;
    // on drop, schedule a single serialized PUT of the current order.
    commitTierOrder: (tierId) => {
      scheduleTierWrite(tierId, currentModelIds(tierId));
      return Promise.resolve();
    },
    beginTierDrag: (tierId) => {
      // A drag is a single pointer, so at most one tier is ever held. Replacing the hold
      // must RESOLVE the previous one — leaving its snapshot pending would strand that
      // tier's visible state until its next write.
      if (dragHold !== null && dragHold !== tierId) applyPending(dragHold);
      dragHold = tierId;
    },
    endTierDrag: (tierId, outcome) => {
      // Only the drag that CURRENTLY owns the hold may complete. Anything that abandons a
      // drag out from under the component (sign-out, tier deletion, a refresh that dropped
      // the tier, a drag starting elsewhere) clears the hold — and the still-live pointer
      // drag will then fire its own drop/dragend afterwards. Without this guard that late
      // completion falls into the `changed` branch and schedules a write for an abandoned
      // drag, which is exactly what "abandoned means no-op" forbids.
      if (dragHold !== tierId) return;
      dragHold = null;
      if (outcome === 'abandon' || deletedTiers.has(tierId)) {
        dropPending(tierId);
        return;
      }
      if (outcome === 'changed') {
        // The user's post-drag order is newer intent than a response to a request they
        // already superseded — the same rule the `tierDesired` guard encodes.
        dropPending(tierId);
        scheduleTierWrite(tierId, currentModelIds(tierId));
        return;
      }
      applyPending(tierId); // unchanged: converge to server truth, issue no write
    },
    addTierModel: (tierId, modelId) => {
      const ids = currentModelIds(tierId);
      if (ids.includes(modelId)) return;
      if (ids.length >= MAX_MODELS_PER_TIER) {
        say(`Max ${String(MAX_MODELS_PER_TIER)} models per tier`);
        return;
      }
      applyTierOrder(tierId, [...ids, modelId]);
    },
    removeTierModel: (tierId, modelId) => {
      applyTierOrder(
        tierId,
        currentModelIds(tierId).filter((id) => id !== modelId),
      );
    },
    setPrimaryTierModel: (tierId, modelId) => {
      const ids = currentModelIds(tierId);
      if (ids[0] === modelId || !ids.includes(modelId)) return;
      applyTierOrder(tierId, [modelId, ...ids.filter((id) => id !== modelId)]);
    },
    createTier: async () => {
      if (state.tf.busy) return; // single-flight — no double-submit duplicates (A-27)
      const key = state.tf.key.trim();
      if (!key) {
        setState('tf', 'error', 'Key is required');
        return;
      }
      setState('tf', { busy: true, error: null });
      try {
        const displayName = state.tf.displayName.trim();
        const tier = await client.createTier({ key, ...(displayName ? { displayName } : {}) });
        bumpRouting(); // invalidate any in-flight loadRouting that predates this tier
        setState(
          produce((s) => {
            s.routingTiers = [...s.routingTiers, tier];
            s.tierEntries[tier.id] = [];
            s.confirmedEntries[tier.id] = [];
            s.tf = { key: '', displayName: '', busy: false, error: null };
          }),
        );
        say(`Tier ${tier.key} created`);
      } catch (e) {
        setState('tf', { busy: false, error: err(e) });
      }
    },
    deleteTier: async (tierId) => {
      const gen = identityGen;
      try {
        await client.deleteTier(tierId);
        if (gen !== identityGen) return; // completed under a previous principal — inert
        // Retire any queued/in-flight writer for this tier and tombstone it so a late
        // PUT response can't resurrect its snapshot or raise a misleading 404 toast.
        tierDesired.delete(tierId);
        deletedTiers.add(tierId);
        // Drop any drag hold on this tier BEFORE its state goes: applying a deferred
        // snapshot afterwards would resurrect a tombstoned tier's entries.
        if (dragHold === tierId) dragHold = null;
        tierPending.delete(tierId);
        bumpRouting();
        setState(
          produce((s) => {
            s.routingTiers = s.routingTiers.filter((t) => t.id !== tierId);
            delete s.tierEntries[tierId];
            delete s.confirmedEntries[tierId];
          }),
        );
        say('Tier deleted');
      } catch (e) {
        if (gen !== identityGen) return; // stale: the old session's error is not this one's
        say(err(e));
      }
    },
    createRule: async () => {
      if (state.rf.busy) return; // single-flight — no double-submit duplicates (A-27)
      const value = state.rf.value.trim();
      const target = state.rf.target.trim();
      if (!value || !target) {
        setState('rf', 'error', 'A header value and target tier are required');
        return;
      }
      setState('rf', { busy: true, error: null });
      try {
        const rule = await client.createRule({
          matchType: 'header',
          headerName: TIER_HEADER_NAME,
          headerValue: value,
          target: `tier:${target}`,
        });
        setState(
          produce((s) => {
            s.rules = [...s.rules, rule]; // optimistic preview…
            s.rf = { value: '', target: '', busy: false, error: null };
          }),
        );
        void reconcileRules(); // …converging on the authoritative re-list
        say('Header rule created');
      } catch (e) {
        setState('rf', { busy: false, error: err(e) });
      }
    },
    deleteRule: async (id) => {
      try {
        await client.deleteRule(id);
        setState('rules', (rules) => rules.filter((r) => r.id !== id)); // preview
        void reconcileRules(); // converge (r2-High-1 — one discipline for ALL rule writes)
      } catch (e) {
        say(err(e));
      }
    },
    setBandTarget: async (band, target) => {
      if (state.bt.busy[band] || state.bt.unverified) return; // per-band single-flight; unverified disables
      setState('bt', 'busy', band, true);
      setState('bt', 'errors', band, null);
      bumpRouting();
      // The snapshot's effective rule — the proxy's pick (priority DESC,
      // createdAt, id). PESSIMISTIC: display changes only via the reconcile.
      // ONE comparator — the VM's exported proxy order (no drift).
      const ofBand = state.rules.filter((r) => r.matchType === band).sort(effectiveRuleOrder);
      const effective = ofBand[0];
      let wrote = false;
      let mayHaveLanded = false;
      let failed: string | null = null;
      try {
        if (effective !== undefined) {
          await client.updateRule(effective.id, { target });
        } else {
          await client.createRule({ matchType: band, target });
        }
        wrote = true;
      } catch (e) {
        failed = err(e);
        // A definitive HTTP response (4xx/5xx) means the server REJECTED the
        // write — nothing landed. Only a transport-level failure (no
        // response) is genuinely ambiguous (r3-Med-3).
        mayHaveLanded = !isApiError(e);
      }
      // Reconcile after success AND failure (an ambiguous failure may have
      // landed — a retry-minted duplicate must surface as shadowed).
      const verified = (await reconcileRules()) === 'committed';
      setState('bt', 'busy', band, false);
      setState('bt', 'errors', band, failed);
      setState('bt', 'unverified', !verified && (wrote || mayHaveLanded));
      if (wrote && verified) say('Band target saved');
    },
    clearBand: async (band) => {
      if (state.bt.busy[band] || state.bt.unverified) return;
      setState('bt', 'busy', band, true);
      setState('bt', 'errors', band, null);
      bumpRouting();
      const snapshot = state.rules.filter((r) => r.matchType === band);
      let failed: string | null = null;
      let touched = false;
      let mayHaveLanded = false;
      for (const r of snapshot) {
        try {
          await client.deleteRule(r.id);
          touched = true;
        } catch (e) {
          failed = err(e); // abort — the remainder stays visible, retry-able
          mayHaveLanded = !isApiError(e);
          break;
        }
      }
      const verified = (await reconcileRules()) === 'committed';
      setState('bt', 'busy', band, false);
      setState('bt', 'errors', band, failed);
      setState('bt', 'unverified', !verified && (touched || mayHaveLanded));
      if (failed === null && verified && snapshot.length > 0) say('Band cleared');
    },
    cleanShadowed: async (band) => {
      if (state.bt.busy[band] || state.bt.unverified) return;
      setState('bt', 'busy', band, true);
      setState('bt', 'errors', band, null);
      bumpRouting();
      // ONE comparator — the VM's exported proxy order (no drift).
      const ofBand = state.rules.filter((r) => r.matchType === band).sort(effectiveRuleOrder);
      let failed: string | null = null;
      let touched = false;
      let mayHaveLanded = false;
      for (const r of ofBand.slice(1)) {
        try {
          await client.deleteRule(r.id);
          touched = true;
        } catch (e) {
          failed = err(e);
          mayHaveLanded = !isApiError(e);
          break;
        }
      }
      const verified = (await reconcileRules()) === 'committed';
      setState('bt', 'busy', band, false);
      setState('bt', 'errors', band, failed);
      setState('bt', 'unverified', !verified && (touched || mayHaveLanded));
      if (failed === null && verified && ofBand.length > 1) say('Duplicates removed');
    },
    retryRulesReconcile: async () => {
      const verified = (await reconcileRules()) === 'committed';
      if (verified) {
        setState('bt', 'errors', { auto_high: null, auto_low: null });
      }
    },
    toggleAutoLayer: (layer) => {
      const cur = state.autoLayers;
      if (!cur) return Promise.resolve();
      const available =
        layer === 'structural'
          ? cur.structuralAvailable
          : layer === 'cascade'
            ? cur.cascadeAvailable
            : cur.semanticAvailable;
      // Off instance-wide — the toggle is inert (greyed in the UI); no write.
      if (!available) return Promise.resolve();
      let structural = cur.structural;
      let cascade = cur.cascade;
      let semantic = cur.semantic;
      if (layer === 'structural') {
        structural = !structural;
        if (!structural) {
          cascade = false; // cascade requires structural
          semantic = false; // semantic requires structural (dependency-down)
        }
      } else if (layer === 'cascade') {
        cascade = !cascade;
        if (cascade) structural = true; // enabling cascade forces structural (mirrors the server)
      } else {
        semantic = !semantic;
        if (semantic) structural = true; // enabling semantic forces structural (mirrors the server)
      }
      // Optimistic update + serialized write (rapid toggles send the latest state).
      setState('autoLayers', { ...cur, structural, cascade, semantic });
      scheduleAutoLayers({ structural, cascade, semantic });
      return Promise.resolve();
    },
    setCalibration: async (on) => {
      const cur = state.autoLayers;
      if (!cur || !cur.structuralAvailable) return;
      try {
        // Sends the CURRENT layer flags + the new calibration flag — the
        // server preserves the pair and, on omission elsewhere, the flag.
        const next = await client.setAutoLayers({
          structural: cur.structural,
          cascade: cur.cascade,
          calibration: on,
        });
        setState('autoLayers', next);
      } catch (e) {
        say(err(e));
      }
    },
    revertCalibration: async () => {
      try {
        const next = await client.calibrationRevert();
        setState('autoLayers', next);
        await loadCalHistory(); // the revert appended an event — refresh
      } catch (e) {
        say(err(e));
      }
    },
    loadCalHistory,
    setSemanticLearning: (on) => {
      const cur = state.autoLayers;
      if (!cur || !cur.semanticAvailable) return Promise.resolve();
      // Optimistic, then serialize through the SAME drain as every other
      // auto-layer write (clink change-4 Med-2) — a direct PUT could land after
      // a later structural-off and stale-re-enable the layers. The drain's
      // post-settle reload reconciles source/counts/enabled with the server
      // (which normalizes learning ⇒ effective semantic). The card is only
      // visible when semantic is already effective, so the pair is untouched.
      setState('autoLayers', { ...cur, semanticLearning: on });
      setState('semLearn', 'status', (s) => (s ? { ...s, enabled: on } : s));
      scheduleAutoLayers({
        structural: cur.structural,
        cascade: cur.cascade,
        semantic: cur.semantic,
        semanticLearning: on,
      });
      return Promise.resolve();
    },
    revertSemanticLearning: async () => {
      try {
        const status = await client.semanticLearningRevert();
        setState('semLearn', { status, loaded: true, error: null });
      } catch (e) {
        say(err(e));
      }
    },
    loadSemanticLearning,
    loadPricingStatus,
    runPricingRefresh,
    loadBodyCapture,
    setBodyCaptureMode,
    setBodyCaptureRetention,
    purgeBodies,
    setAgentBodyOverride,
    loadSelectedBodies,
    deleteSelectedBodies,

    loadLimits,
    openBudget: (budget) => {
      setState({ modal: 'newLimit', bf: budget ? budgetFormFrom(budget) : emptyBudgetForm() });
    },
    saveBudget: async () => {
      if (state.bf.busy) return; // single-flight — no double-submit duplicates
      const f = state.bf;
      const name = f.name.trim();
      if (!name) {
        setState('bf', 'error', 'Name is required');
        return;
      }
      const amount = Number(f.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setState('bf', 'error', 'Amount must be a positive number');
        return;
      }
      setState('bf', { busy: true, error: null });
      const body: CreateBudgetInput = {
        name,
        scope: f.scope,
        window: f.window,
        action: f.action,
        meteringBasis: f.meteringBasis,
        amount,
        notifyChannelIds: f.notifyChannelIds,
        enabled: f.enabled,
        ...(f.scope === 'agent' && f.agentId ? { agentId: f.agentId } : {}),
      };
      try {
        if (f.id) {
          const patch: UpdateBudgetInput = body;
          const updated = await client.updateBudget(f.id, patch);
          bumpBudgets(); // invalidate an in-flight budgets loader (stale-overwrite)
          setState(
            produce((s) => {
              const i = s.budgets.findIndex((b) => b.id === updated.id);
              if (i >= 0) s.budgets[i] = updated;
              s.modal = null;
              s.bf = emptyBudgetForm();
            }),
          );
          say('Budget updated');
        } else {
          const created = await client.createBudget(body);
          bumpBudgets();
          setState(
            produce((s) => {
              s.budgets = [...s.budgets, created];
              s.modal = null;
              s.bf = emptyBudgetForm();
            }),
          );
          say('Budget created');
        }
      } catch (e) {
        setState('bf', { busy: false, error: err(e) });
      }
    },
    deleteBudget: async (id) => {
      try {
        await client.deleteBudget(id);
        bumpBudgets();
        setState('budgets', (list) => list.filter((b) => b.id !== id));
        say('Budget deleted');
      } catch (e) {
        say(err(e));
      }
    },

    loadChannels,
    openChannel: (channel) => {
      setState({ modal: 'channel', cf: channel ? channelFormFrom(channel) : emptyChannelForm() });
    },
    saveChannel: async () => {
      if (state.cf.busy) return; // single-flight — no double-submit duplicates
      const f = state.cf;
      const name = f.name.trim();
      if (!name) {
        setState('cf', 'error', 'Name is required');
        return;
      }
      const built = buildChannelConfig(f);
      if (built.error !== null) {
        setState('cf', 'error', built.error);
        return;
      }
      const config = built.config;
      if (f.id === null && config === null) {
        setState('cf', 'error', 'Channel config is required');
        return;
      }
      setState('cf', { busy: true, error: null });
      try {
        if (f.id) {
          // Always send `kind` so a kind change persists; when the kind changes a
          // full new config is required (enforced above via buildChannelConfig).
          const patch: UpdateChannelInput = {
            name,
            kind: f.kind,
            eventsSubscribed: f.events,
            ...(config !== null ? { config } : {}),
          };
          const updated = await client.updateChannel(f.id, patch);
          bumpChannels(); // invalidate an in-flight channels loader (stale-overwrite)
          // Reconcile the returned row directly (a failed re-list must not read as
          // success and leave stale UI, should-fix #5).
          setState(
            produce((s) => {
              const i = s.channels.findIndex((c) => c.id === updated.id);
              if (i >= 0) s.channels[i] = updated;
              s.modal = null;
              s.cf = emptyChannelForm();
            }),
          );
          say('Channel updated');
        } else {
          const created = await client.createChannel({
            name,
            kind: f.kind,
            eventsSubscribed: f.events,
            config: config as ChannelConfigInput,
          });
          bumpChannels();
          setState(
            produce((s) => {
              s.channels = [...s.channels, created];
              s.modal = null;
              s.cf = emptyChannelForm();
            }),
          );
          say('Channel created');
        }
      } catch (e) {
        setState('cf', { busy: false, error: err(e) });
      }
    },
    deleteChannel: async (id) => {
      try {
        await client.deleteChannel(id);
        bumpChannels();
        setState('channels', (list) => list.filter((c) => c.id !== id));
        say('Channel deleted');
      } catch (e) {
        say(err(e));
      }
    },
    toggleChannelEnabled: async (channel) => {
      if (state.channelToggling[channel.id]) return; // coalesce rapid clicks (#5)
      setState('channelToggling', channel.id, true);
      try {
        const updated = await client.updateChannel(channel.id, { enabled: !channel.enabled });
        bumpChannels(); // invalidate an in-flight channels loader (stale-overwrite)
        setState('channels', (c) => c.id === channel.id, updated);
      } catch (e) {
        say(err(e));
      } finally {
        setState('channelToggling', channel.id, false);
      }
    },
    testChannelById: async (id) => {
      if (state.channelTesting[id]) return; // per-channel single-flight (no double-fire)
      setState('channelTesting', id, true);
      try {
        const result = await client.testChannel(id);
        setState('channelTests', id, result);
        // Reconcile lastTest* locally from the result (avoid a swallowed re-list).
        const status = result.ok ? 'success' : `failed:${result.error ?? 'error'}`;
        bumpChannels(); // invalidate an in-flight channels loader (stale-overwrite)
        setState(
          produce((s) => {
            const ch = s.channels.find((c) => c.id === id);
            if (ch) {
              ch.lastTestStatus = status;
              ch.lastTestAt = new Date().toISOString();
            }
          }),
        );
        say(result.ok ? 'Test sent' : `Test failed — ${result.error ?? 'unknown error'}`);
      } catch (e) {
        setState('channelTests', id, { ok: false, error: err(e) });
      } finally {
        setState('channelTesting', id, false);
      }
    },

    obGo: (step) => setState('ob', 'step', step),
    obCreateAgent: async () => {
      const name = state.ob.name.trim() || 'my-agent';
      setState('ob', { busy1: true, error1: null });
      try {
        const reveal = await client.createAgent({ name, harness: state.ob.harness });
        setState(
          produce((s) => {
            s.ob.agentId = reveal.id;
            s.ob.key = reveal.key;
            s.ob.snippet = reveal.snippet;
            s.ob.done1 = true;
            s.ob.busy1 = false;
            s.ob.error1 = null;
            s.agents = [toAgent(reveal), ...s.agents.filter((a) => a.id !== reveal.id)];
          }),
        );
      } catch (e) {
        setState('ob', { busy1: false, error1: err(e) });
      }
    },
    obConnectProvider: async () => {
      // Single-flight (E12.4): the step's control isn't a disabled button, so a
      // double-click would otherwise mint a duplicate provider and race the
      // read-then-replace tier append (losing one model). Bail if already running.
      if (state.ob.busy2) return;
      const form = state.ob.prov;
      if (!form.name.trim()) {
        setState('ob', 'error2', 'Provider name is required');
        return;
      }
      if (!form.baseUrl.trim()) {
        setState('ob', 'error2', 'Base URL is required');
        return;
      }
      setState('ob', { busy2: true, error2: null, done2: false });
      try {
        // Reuse a provider already created for THIS onboarding attempt (a prior try that
        // succeeded at create but failed a later step) instead of minting a duplicate on
        // retry (A-26) — but only if the form is UNCHANGED. If the user edited the details
        // (e.g. corrected a bad base URL that made sync fail), create a fresh provider so
        // the edit takes effect rather than re-syncing the stale one.
        const input = buildProviderInput(form);
        // Reuse the provider from a prior attempt only when the CURRENT input fingerprint
        // matches the one that created it (input-to-input, so server-side URL canonicalization
        // can't cause a false mismatch; and it includes the credential, so a key-only edit
        // creates a fresh provider). An edited form ⇒ create anew so the edit takes effect.
        const inputKey = JSON.stringify(input);
        const reusable = state.ob.providerId !== null && state.ob.provInput === inputKey;
        let providerId: string;
        if (reusable) {
          providerId = state.ob.providerId!;
        } else {
          const created = await client.createProvider(input);
          providerId = created.id;
          setState('ob', { providerId: created.id, provInput: inputKey });
          setState(
            produce((s) => {
              s.providers = [
                ...s.providers.filter((p) => p.id !== created.id),
                toProvider(created),
              ];
            }),
          );
        }

        const sync = await client.syncModels(providerId);
        setState('providers', (p) => p.id === providerId, 'status', sync.status);
        if (!sync.ok) {
          setState('ob', { busy2: false, error2: `Model sync failed — ${sync.message}` });
          return;
        }
        if ((sync.synced ?? 0) === 0) {
          setState('ob', { busy2: false, error2: 'Provider synced but exposed no models' });
          return;
        }

        const models = await client.listModels(providerId);
        setState('models', providerId, models);
        const first = models[0];
        if (!first) {
          setState('ob', { busy2: false, error2: 'Provider synced but exposed no models' });
          return;
        }

        const tiers = await client.listTiers();
        const def = tiers.find((t) => t.key === 'default');
        if (!def) {
          setState('ob', { busy2: false, error2: 'No default tier found — cannot assign a model' });
          return;
        }

        // Non-destructive assignment (E12.4): the setup guide is always available,
        // so a user re-walking it must not have an existing default-tier chain wiped.
        // Full-replace only when the tier is empty; otherwise append (preserving the
        // existing primary + fallbacks), and no-op when the model is already routed.
        const existing = await client.listTierEntries(def.id);
        const existingIds = existing.map((e) => e.modelId);
        const alreadyRouted = existingIds.includes(first.id);
        if (!alreadyRouted && existingIds.length >= MAX_MODELS_PER_TIER) {
          // Full and this model isn't in it — don't claim a phantom assignment.
          setState('ob', {
            busy2: false,
            error2: `Default tier already has ${String(MAX_MODELS_PER_TIER)} models — remove one on the Routing page to add this one`,
          });
          return;
        }
        const nextIds = alreadyRouted ? existingIds : [...existingIds, first.id];
        if (nextIds.join('\n') !== existingIds.join('\n')) {
          await client.replaceTierEntries(def.id, nextIds);
        }
        setState(
          produce((s) => {
            s.ob.assignedModel = first.externalModelId;
            s.ob.done2 = true;
            s.ob.busy2 = false;
            s.ob.error2 = null;
          }),
        );
      } catch (e) {
        setState('ob', { busy2: false, error2: err(e) });
      }
    },
    obVerify: async () => {
      const key = state.ob.key;
      if (!key) {
        setState('ob', 'error3', 'Missing agent key — recreate the agent in step 1');
        return;
      }
      setState('ob', { busy3: true, error3: null, verifyReply: null, verifyModel: null });
      try {
        const completion = await client.proxyTest(key, {
          model: 'auto',
          messages: [
            { role: 'user', content: 'Reply with a one-line confirmation that routing works.' },
          ],
        });
        const reply = completion.choices?.[0]?.message?.content ?? '';
        setState(
          produce((s) => {
            s.ob.busy3 = false;
            s.ob.verifyReply = reply.length > 0 ? reply : '(empty response)';
            s.ob.verifyModel = completion.model ?? null;
          }),
        );
      } catch (e) {
        setState('ob', { busy3: false, error3: err(e) });
      }
    },
    obFinish: () => {
      // Clear the minted secret AND the provider-retry tracking on completion, so a later
      // onboarding run is a fresh attempt (never reuses this run's provider) (A-26).
      setState(
        produce((s) => {
          s.ob.key = '';
          s.ob.snippet = '';
          s.ob.providerId = null;
          s.ob.provInput = null;
        }),
      );
      // Through the seam, not a direct setState — otherwise state and URL
      // desynchronize on this non-navigation transition.
      navigate('overview');
      say('You’re live — point your agent at /v1');
    },
  };
}

/** Process-wide store used by the app; tests construct their own via createAppStore(fakeClient). */
export const app = createAppStore();
