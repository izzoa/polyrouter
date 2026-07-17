import { connectionSnippet, isHarnessType, type HarnessType } from '@polyrouter/shared';
import { createStore, produce, type SetStoreFunction } from 'solid-js/store';
import { filterToRequestParams } from '../data/analytics';
import {
  EVENT_TYPES,
  isApiError,
  MAX_MODELS_PER_TIER,
  realClient,
  TIER_HEADER_NAME,
  type AgentDto,
  type AnalyticsSummary,
  type ApiClient,
  type ApiProviderKind,
  type AutoLayers,
  type BreakdownRow,
  type BudgetDto,
  type ChannelConfigInput,
  type ChannelDto,
  type ChannelTestResult,
  type CreateBudgetInput,
  type CreateProviderInput,
  type ModelPricingInput,
  type ProviderDto,
  type RequestRow,
  type RuleDto,
  type TierDto,
  type TierEntryDto,
  type TimeseriesPoint,
  type UpdateBudgetInput,
  type UpdateChannelInput,
} from '../data/api';
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
  range: Range;
  reqFilter: RequestFilter;
  selId: string | null;
  toast: string | null;
  modal: ModalKind | null;

  // auth / account (realized)
  authView: AuthView;
  authError: string | null;
  authBusy: boolean;
  session: SessionInfo | null;
  loginConfig: LoginConfig | null;

  // realized data slices — initialize EMPTY, loaded from the API on `ready`
  agents: Agent[];
  agentsError: string | null;
  providers: Provider[];
  providersError: string | null;
  models: Record<string, Model[]>;

  // realized modal/form state
  na: { name: string; harness: Harness; busy: boolean; error: string | null };
  np: ProviderForm & { busy: boolean; error: string | null };
  /** Transient key-reveal — raw key/snippet live here ONLY, never persisted. */
  kr: { title: string; key: string; snippet: string; harness: Harness };

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
  /** Overview's unfiltered first-6 — independent of the Requests page's window. */
  recentRequests: RequestRow[];
  recentRequestsLoading: boolean;
  recentRequestsError: string | null;
  requestList: RequestRow[];
  requestListLoading: boolean;
  requestListError: string | null;
  requestCursor: string | null;
  requestWindow: RequestWindow | null;

  // Routing config (#20) — loaded on the Routing page mount. `tierEntries` is the
  // (optimistic) ordered chain per tier id; `confirmedEntries` is the last
  // server-CONFIRMED order per tier (the rollback target); `allModels` feeds the
  // picker + labels/prices.
  routingTiers: TierDto[];
  tierEntries: Record<string, TierEntryDto[]>;
  confirmedEntries: Record<string, string[]>;
  allModels: Model[];
  rules: RuleDto[];
  autoLayers: AutoLayers | null;
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

  /** Body-logging toggle — no opt-in API yet (#20 out of scope); left inert. */
  bodyLog: boolean;

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
    id: 'custom',
    name: 'Custom endpoint',
    desc: 'Any OpenAI/Anthropic-compatible base URL',
    field: 'Base URL',
    ph: 'https://llm.mylab.net/v1',
  },
  {
    id: 'local',
    name: 'Local',
    desc: 'Ollama, LM Studio, llama.cpp — free, on this box',
    field: 'Base URL',
    ph: 'http://127.0.0.1:11434/v1',
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
    createdAt: p.createdAt,
  };
}

function errMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unexpected error';
}

function emptyProviderForm(): ProviderForm {
  return { name: '', kind: 'api', protocol: 'openai_compatible', baseUrl: '', credential: '' };
}

function buildProviderInput(form: ProviderForm): CreateProviderInput {
  const base: CreateProviderInput = {
    name: form.name.trim(),
    kind: UI_TO_API_KIND[form.kind],
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
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
    range: '24h',
    reqFilter: 'all',
    selId: null,
    toast: null,
    modal: null,

    authView: 'loading',
    authError: null,
    authBusy: false,
    session: null,
    loginConfig: null,

    agents: [],
    agentsError: null,
    providers: [],
    providersError: null,
    models: {},

    na: { name: '', harness: 'openai_sdk', busy: false, error: null },
    np: { ...emptyProviderForm(), busy: false, error: null },
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
    recentRequests: [],
    recentRequestsLoading: false,
    recentRequestsError: null,
    requestList: [],
    requestListLoading: false,
    requestListError: null,
    requestCursor: null,
    requestWindow: null,

    routingTiers: [],
    tierEntries: {},
    confirmedEntries: {},
    allModels: [],
    rules: [],
    autoLayers: null,
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

    bodyLog: false,

    ob: initialOnboarding(),
  };
}

export interface AppStore {
  state: AppState;
  setState: SetStoreFunction<AppState>;
  // navigation & chrome
  go: (page: Page) => void;
  toggleTheme: () => void;
  setRange: (range: Range) => void;
  setFilter: (filter: RequestFilter) => void;
  select: (id: string | null) => void;
  say: (msg: string) => void;
  clearToast: () => void;
  copy: (txt: string, msg?: string) => void;
  // observe (analytics, realized)
  loadOverview: () => Promise<void>;
  loadCosts: () => Promise<void>;
  loadRecentRequests: () => Promise<void>;
  loadRequests: (reset: boolean) => Promise<void>;
  // auth / account
  bootstrap: () => Promise<void>;
  retry: () => Promise<void>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signUp: (input: { name: string; email: string; password: string }) => Promise<void>;
  oauth: (provider: string) => Promise<void>;
  signOut: () => Promise<void>;
  // agents (realized)
  loadAgents: () => Promise<void>;
  createAgent: () => Promise<void>;
  rotateKey: (agent: Agent) => Promise<void>;
  deleteAgent: (agent: Agent) => Promise<void>;
  // providers (realized)
  loadProviders: () => Promise<void>;
  addProvider: () => Promise<void>;
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
  addTierModel: (tierId: string, modelId: string) => void;
  removeTierModel: (tierId: string, modelId: string) => void;
  setPrimaryTierModel: (tierId: string, modelId: string) => void;
  createTier: () => Promise<void>;
  deleteTier: (tierId: string) => Promise<void>;
  createRule: () => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  toggleAutoLayer: (layer: 'structural' | 'cascade') => Promise<void>;
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
  toggleBodyLog: () => void;
  // onboarding (realized)
  obGo: (step: 1 | 2 | 3) => void;
  obCreateAgent: () => Promise<void>;
  obConnectProvider: () => Promise<void>;
  obVerify: () => Promise<void>;
  obFinish: () => void;
}

export function createAppStore(client: ApiClient = realClient): AppStore {
  const [state, setState] = createStore<AppState>(initialState());
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

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

  const loadProviders = async (): Promise<void> => {
    try {
      const rows = await client.listProviders();
      setState({ providers: rows.map(toProvider), providersError: null });
    } catch (e) {
      setState('providersError', err(e));
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
  const tierDesired = new Map<string, string[]>();
  const tierInFlight = new Set<string>();

  // Auto-layer single-flight: serialize `setAutoLayers` so rapid toggles apply in
  // order, sending the latest desired state; roll back to the last confirmed view.
  let autoLayersDesired: { structural: boolean; cascade: boolean } | null = null;
  let autoLayersInFlight = false;
  let autoLayersConfirmed: AutoLayers | null = null;

  // Per-domain mutation sequences (the #19 generation-guard pattern applied to
  // load-vs-mutation): every config mutation bumps its domain counter; each loader
  // captures the counter before its GET(s) and discards its (now-stale) result if a
  // mutation raced in during the load — the optimistic/confirmed state is newer.
  let routingSeq = 0;
  let budgetsSeq = 0;
  let channelsSeq = 0;
  const bumpRouting = (): void => {
    routingSeq += 1;
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
    try {
      const [tiers, models, rules, autoLayers] = await Promise.all([
        client.listTiers(),
        client.listModels(),
        client.listRules(),
        client.getAutoLayers(),
      ]);
      const entries = await Promise.all(tiers.map((t) => client.listTierEntries(t.id)));
      if (routingSeq !== seq) return; // a mutation raced in — keep the newer state
      setState(
        produce((s) => {
          s.routingTiers = tiers;
          s.allModels = models;
          s.rules = rules;
          s.autoLayers = autoLayers;
          s.tierEntries = {};
          s.confirmedEntries = {};
          tiers.forEach((t, i) => {
            const list = entries[i] ?? [];
            s.tierEntries[t.id] = list;
            s.confirmedEntries[t.id] = list.map((e) => e.modelId);
          });
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
    tierDesired.set(tierId, modelIds);
    if (!tierInFlight.has(tierId)) void drainTierWrites(tierId);
  };

  const drainTierWrites = async (tierId: string): Promise<void> => {
    tierInFlight.add(tierId);
    try {
      while (tierDesired.has(tierId)) {
        const desired = tierDesired.get(tierId) ?? [];
        tierDesired.delete(tierId);
        // Capture the confirmed order BEFORE this PUT — the rollback target.
        const confirmed = [...(state.confirmedEntries[tierId] ?? [])];
        try {
          const entries = await client.replaceTierEntries(tierId, desired);
          if (deletedTiers.has(tierId)) continue; // deleted mid-flight — don't resurrect
          bumpRouting();
          setState(
            'confirmedEntries',
            tierId,
            entries.map((e) => e.modelId),
          );
          // Reconcile the visible chain to the server truth ONLY when no newer edit
          // is queued — else the newer optimistic state stays and the next PUT wins.
          if (!tierDesired.has(tierId)) setState('tierEntries', tierId, entries);
        } catch (e) {
          if (deletedTiers.has(tierId)) continue; // deleted — no misleading 404 toast
          // Roll back to the last CONFIRMED order (never the failed optimistic one),
          // and only when no newer edit is queued.
          if (!tierDesired.has(tierId)) {
            setState('tierEntries', tierId, buildEntries(tierId, confirmed));
          }
          say(err(e));
        }
      }
    } finally {
      tierInFlight.delete(tierId);
    }
  };

  const scheduleAutoLayers = (desired: { structural: boolean; cascade: boolean }): void => {
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
  const generation = { summary: 0, series: 0, breakdown: 0, recent: 0, requests: 0 };
  type SliceKey = keyof typeof generation;
  const bump = (key: SliceKey): number => (generation[key] += 1);
  const isCurrent = (key: SliceKey, token: number): boolean => generation[key] === token;

  /** Run a single-slice fetch with loading/error + the stale-response guard. */
  async function runSlice<T>(
    key: SliceKey,
    setLoading: (v: boolean) => void,
    setError: (v: string | null) => void,
    fetchFn: () => Promise<T>,
    apply: (data: T) => void,
  ): Promise<void> {
    const token = bump(key);
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFn();
      if (!isCurrent(key, token)) return;
      apply(data);
    } catch (e) {
      if (!isCurrent(key, token)) return;
      setError(err(e));
    } finally {
      if (isCurrent(key, token)) setLoading(false);
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
  const loadBreakdowns = async (dims: CostDimension[]): Promise<void> => {
    const { from, to } = currentRange();
    const range = { from, to };
    const token = bump('breakdown');
    setState({ analyticsBreakdownLoading: true, analyticsBreakdownError: null });
    try {
      const results = await Promise.all(dims.map((d) => client.breakdown(d, range)));
      if (!isCurrent('breakdown', token)) return;
      setState(
        produce((s) => {
          dims.forEach((d, i) => {
            s.analyticsBreakdown[d] = results[i] ?? [];
          });
        }),
      );
    } catch (e) {
      if (!isCurrent('breakdown', token)) return;
      setState('analyticsBreakdownError', err(e));
    } finally {
      if (isCurrent('breakdown', token)) setState('analyticsBreakdownLoading', false);
    }
  };

  const loadRecentRequests = async (): Promise<void> => {
    const { from, to } = currentRange();
    await runSlice(
      'recent',
      (v) => setState('recentRequestsLoading', v),
      (v) => setState('recentRequestsError', v),
      () => client.requests({ from, to, limit: 6 }),
      (page) => setState('recentRequests', page.rows),
    );
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
      loadBreakdowns(['model']),
      loadRecentRequests(),
    ]);
  };

  const loadCosts = async (): Promise<void> => {
    const { from, to } = currentRange();
    await Promise.all([loadSummary({ from, to }), loadBreakdowns(['model', 'provider', 'agent'])]);
  };

  // On `reset` FREEZE {from,to}+filter into `requestWindow` and fetch page 1; on
  // append reuse the frozen window + cursor (never re-derive the range from the
  // clock). Window/list/cursor update atomically on success, so a failed reset
  // keeps the last-good page consistent with its cursor.
  const loadRequests = async (reset: boolean): Promise<void> => {
    if (!reset && (state.requestWindow === null || state.requestCursor === null)) return;
    const token = bump('requests');
    setState({ requestListLoading: true, requestListError: null });
    try {
      if (reset) {
        const { from, to } = currentRange();
        const window: RequestWindow = { from, to, filter: state.reqFilter };
        const page = await client.requests({
          from,
          to,
          limit: REQUEST_PAGE_SIZE,
          ...filterToRequestParams(window.filter),
        });
        if (!isCurrent('requests', token)) return;
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
        const page = await client.requests({
          from: window.from,
          to: window.to,
          limit: REQUEST_PAGE_SIZE,
          cursor,
          ...filterToRequestParams(window.filter),
        });
        if (!isCurrent('requests', token)) return;
        setState(
          produce((s) => {
            s.requestList = [...s.requestList, ...page.rows];
            s.requestCursor = page.nextCursor;
          }),
        );
      }
    } catch (e) {
      if (!isCurrent('requests', token)) return;
      setState('requestListError', err(e));
    } finally {
      if (isCurrent('requests', token)) setState('requestListLoading', false);
    }
  };

  // --- auth bootstrap / gate ---

  const bootstrap = async (): Promise<void> => {
    setState({ authView: 'loading', authError: null });
    let session: SessionInfo;
    try {
      session = await client.me();
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
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
    setState('session', session);
    await Promise.all([loadAgents(), loadProviders()]);
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

  // --- store shape ---

  return {
    state,
    setState,

    go: (page) => setState({ page, selId: null }),
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
    setRange: (range) => setState('range', range),
    setFilter: (reqFilter) => {
      setState('reqFilter', reqFilter);
      void loadRequests(true);
    },
    select: (id) => setState('selId', id),
    say,
    clearToast: () => {
      clearTimeout(toastTimer);
      setState('toast', null);
    },
    copy,

    loadOverview,
    loadCosts,
    loadRecentRequests,
    loadRequests,

    bootstrap,
    retry: bootstrap,
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
      // Clear ALL raw agent keys first — reveal + onboarding secrets.
      setState(
        produce((s) => {
          s.kr = emptyKeyReveal();
          s.ob.key = '';
          s.ob.snippet = '';
          s.modal = null;
        }),
      );
      try {
        await client.signOut();
      } catch {
        // ignore — bootstrap decides the resulting view (loopback stays ready)
      }
      await bootstrap();
    },

    loadAgents,
    createAgent: async () => {
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
    addProvider: async () => {
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
      try {
        const created = await client.createProvider(buildProviderInput(form));
        setState(
          produce((s) => {
            s.providers = [...s.providers, toProvider(created)];
            s.np = { ...emptyProviderForm(), busy: false, error: null };
            s.modal = null;
          }),
        );
        say(`Provider ${created.name} added — test the connection & sync models`);
      } catch (e) {
        setState('np', { busy: false, error: err(e) });
      }
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
      if (modal === 'newAgent') {
        setState({ modal, na: { name: '', harness: 'openai_sdk', busy: false, error: null } });
      } else if (modal === 'newProvider') {
        setState({ modal, np: { ...emptyProviderForm(), busy: false, error: null } });
      } else {
        setState('modal', modal);
      }
    },
    closeModal: () => {
      // Don't dismiss a budget/channel modal while its save is in flight — a
      // cancel→reopen→save would let the first completion reset the newer modal.
      if (
        (state.modal === 'newLimit' && state.bf.busy) ||
        (state.modal === 'channel' && state.cf.busy)
      ) {
        return;
      }
      setState(
        produce((s) => {
          s.kr = emptyKeyReveal();
          s.np.busy = false;
          s.np.error = null;
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
      try {
        await client.deleteTier(tierId);
        // Retire any queued/in-flight writer for this tier and tombstone it so a late
        // PUT response can't resurrect its snapshot or raise a misleading 404 toast.
        tierDesired.delete(tierId);
        deletedTiers.add(tierId);
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
        say(err(e));
      }
    },
    createRule: async () => {
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
            s.rules = [...s.rules, rule];
            s.rf = { value: '', target: '', busy: false, error: null };
          }),
        );
        say('Header rule created');
      } catch (e) {
        setState('rf', { busy: false, error: err(e) });
      }
    },
    deleteRule: async (id) => {
      try {
        await client.deleteRule(id);
        setState('rules', (rules) => rules.filter((r) => r.id !== id));
      } catch (e) {
        say(err(e));
      }
    },
    toggleAutoLayer: (layer) => {
      const cur = state.autoLayers;
      if (!cur) return Promise.resolve();
      const available = layer === 'structural' ? cur.structuralAvailable : cur.cascadeAvailable;
      // Off instance-wide — the toggle is inert (greyed in the UI); no write.
      if (!available) return Promise.resolve();
      let structural = cur.structural;
      let cascade = cur.cascade;
      if (layer === 'structural') {
        structural = !structural;
        if (!structural) cascade = false; // cascade requires structural
      } else {
        cascade = !cascade;
        if (cascade) structural = true; // enabling cascade forces structural (mirrors the server)
      }
      // Optimistic update + serialized write (rapid toggles send the latest state).
      setState('autoLayers', { ...cur, structural, cascade });
      scheduleAutoLayers({ structural, cascade });
      return Promise.resolve();
    },

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
    toggleBodyLog: () => setState('bodyLog', (on) => !on),

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
        const created = await client.createProvider(buildProviderInput(form));
        setState('ob', 'providerId', created.id);
        setState(
          produce((s) => {
            s.providers = [...s.providers.filter((p) => p.id !== created.id), toProvider(created)];
          }),
        );

        const sync = await client.syncModels(created.id);
        setState('providers', (p) => p.id === created.id, 'status', sync.status);
        if (!sync.ok) {
          setState('ob', { busy2: false, error2: `Model sync failed — ${sync.message}` });
          return;
        }
        if ((sync.synced ?? 0) === 0) {
          setState('ob', { busy2: false, error2: 'Provider synced but exposed no models' });
          return;
        }

        const models = await client.listModels(created.id);
        setState('models', created.id, models);
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
      // Clear the minted secret on completion.
      setState(
        produce((s) => {
          s.ob.key = '';
          s.ob.snippet = '';
        }),
      );
      setState('page', 'overview');
      say('You’re live — point your agent at /v1');
    },
  };
}

/** Process-wide store used by the app; tests construct their own via createAppStore(fakeClient). */
export const app = createAppStore();
