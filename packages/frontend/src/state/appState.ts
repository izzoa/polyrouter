import { connectionSnippet, isHarnessType, type HarnessType } from '@polyrouter/shared';
import { createStore, produce, type SetStoreFunction } from 'solid-js/store';
import { filterToRequestParams } from '../data/analytics';
import {
  isApiError,
  realClient,
  type AgentDto,
  type AnalyticsSummary,
  type ApiClient,
  type ApiProviderKind,
  type BreakdownRow,
  type CreateProviderInput,
  type ModelPricingInput,
  type ProviderDto,
  type RequestRow,
  type TimeseriesPoint,
} from '../data/api';
import { BASE_URL } from '../data/catalog';
import { rangeToParams } from '../data/range';
import { SEED_CHANNELS, SEED_LIMITS, SEED_RULES, SEED_TIERS } from '../data/seed';
import type {
  Agent,
  AuthView,
  Channel,
  Harness,
  HeaderRule,
  Limit,
  LimitAction,
  LimitWindow,
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
  Tier,
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

  // still-simulated slices (deferred config pages #20: routing/limits/notifications)
  tiers: Tier[];
  autoLayers: { structural: boolean; cascade: boolean; semantic: boolean };
  rules: HeaderRule[];
  limits: Limit[];
  channels: Channel[];
  bodyLog: boolean;
  nl: { scope: string; amount: string; window: LimitWindow; action: LimitAction };

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
    tiers: SEED_TIERS.map((t) => ({ ...t, chain: [...t.chain] })),
    autoLayers: { structural: true, cascade: true, semantic: false },
    rules: SEED_RULES.map((r) => ({ ...r })),
    limits: SEED_LIMITS.map((l) => ({ ...l })),
    channels: SEED_CHANNELS.map((c) => ({ ...c })),
    bodyLog: false,
    nl: { scope: 'Global', amount: '10.00', window: 'day', action: 'alert' },

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
  // routing (simulated)
  reorderChain: (tierIndex: number, from: number, to: number) => void;
  removeFromChain: (tierIndex: number, model: string) => void;
  addToChain: (tierIndex: number, model: string) => boolean;
  toggleLayer: (layer: 'structural' | 'cascade' | 'semantic') => void;
  removeRule: (id: number) => void;
  // limits & notifications (simulated)
  createLimit: () => void;
  toggleBodyLog: () => void;
  toggleChannel: (id: number) => void;
  testChannel: (id: number) => void;
  addChannel: () => void;
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

  const copy = (txt: string, msg?: string): void => {
    try {
      void navigator.clipboard.writeText(txt).catch(() => undefined);
    } catch {
      // clipboard unavailable (non-secure context) — the toast still confirms intent
    }
    say(msg ?? 'Copied');
  };

  // --- realized loaders ---

  const loadAgents = async (): Promise<void> => {
    try {
      const rows = await client.listAgents();
      setState({ agents: rows.map(toAgent), agentsError: null });
    } catch (e) {
      setState('agentsError', errMessage(e));
    }
  };

  const loadProviders = async (): Promise<void> => {
    try {
      const rows = await client.listProviders();
      setState({ providers: rows.map(toProvider), providersError: null });
    } catch (e) {
      setState('providersError', errMessage(e));
    }
  };

  const loadModels = async (providerId: string): Promise<void> => {
    try {
      const rows = await client.listModels(providerId);
      setState('models', providerId, rows);
    } catch (e) {
      say(errMessage(e));
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
      setError(errMessage(e));
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
      setState('analyticsBreakdownError', errMessage(e));
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
      setState('requestListError', errMessage(e));
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
        setState({ authView: 'error', authError: errMessage(e) });
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
      setState('authError', errMessage(e));
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
        setState({ authError: errMessage(e), authBusy: false });
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
        setState('na', { busy: false, error: errMessage(e) });
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
        say(errMessage(e));
      }
    },
    deleteAgent: async (agent) => {
      try {
        await client.deleteAgent(agent.id);
        setState('agents', (list) => list.filter((a) => a.id !== agent.id));
        say(`Agent ${agent.name} deleted`);
      } catch (e) {
        say(errMessage(e));
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
        setState('np', { busy: false, error: errMessage(e) });
      }
    },
    testProviderById: async (id) => {
      try {
        const result = await client.testProvider(id);
        setState('providers', (p) => p.id === id, 'status', result.status);
        say(result.ok ? 'Connection ok' : `Connection failed — ${result.message}`);
      } catch (e) {
        say(errMessage(e));
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
        say(errMessage(e));
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
        say(errMessage(e));
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
        say(errMessage(e));
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
      setState(
        produce((s) => {
          s.kr = emptyKeyReveal();
          s.np.busy = false;
          s.np.error = null;
          s.modal = null;
        }),
      );
    },

    reorderChain: (tierIndex, from, to) => {
      setState(
        produce((s) => {
          const tier = s.tiers[tierIndex];
          if (!tier) return;
          const [moved] = tier.chain.splice(from, 1);
          if (moved !== undefined) tier.chain.splice(to, 0, moved);
        }),
      );
    },
    removeFromChain: (tierIndex, model) => {
      setState(
        produce((s) => {
          const tier = s.tiers[tierIndex];
          if (!tier) return;
          tier.chain = tier.chain.filter((m) => m !== model);
        }),
      );
    },
    addToChain: (tierIndex, model) => {
      const tier = state.tiers[tierIndex];
      if (!tier || tier.chain.length >= 5) {
        say('Max 5 models per tier');
        return false;
      }
      setState(
        produce((s) => {
          s.tiers[tierIndex]?.chain.push(model);
        }),
      );
      return true;
    },
    toggleLayer: (layer) => {
      if (layer === 'semantic') {
        say('Layer 2 is a cloud-tier graduation');
        return;
      }
      setState('autoLayers', layer, (on) => !on);
    },
    removeRule: (id) => setState('rules', (rules) => rules.filter((r) => r.id !== id)),

    createLimit: () => {
      const amount = parseFloat(state.nl.amount) || 10;
      setState(
        produce((s) => {
          s.limits.push({
            id: Date.now(),
            scope: s.nl.scope,
            threshold: amount,
            window: s.nl.window,
            action: s.nl.action,
            current: 0,
            note:
              s.nl.action === 'alert'
                ? 'notifies: all enabled channels'
                : 'hard stop — requests rejected at limit',
          });
          s.modal = null;
        }),
      );
      say('Budget created');
    },
    toggleBodyLog: () => setState('bodyLog', (on) => !on),
    toggleChannel: (id) =>
      setState(
        'channels',
        (c) => c.id === id,
        'enabled',
        (on) => !on,
      ),
    testChannel: (id) => {
      setState('channels', (c) => c.id === id, 'testing', true);
      setTimeout(
        () =>
          setState(
            'channels',
            (c) => c.id === id,
            (c) => ({ ...c, testing: false, last: 'test ok · just now', lastOk: true }),
          ),
        1100,
      );
    },
    addChannel: () =>
      setState(
        produce((s) => {
          s.channels.push({
            id: Date.now(),
            name: 'discord alerts',
            kind: 'apprise',
            enabled: true,
            detail: 'discord://webhook…',
            last: 'never tested',
            lastOk: null,
            testing: false,
          });
        }),
      ),

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
        setState('ob', { busy1: false, error1: errMessage(e) });
      }
    },
    obConnectProvider: async () => {
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

        await client.replaceTierEntries(def.id, [first.id]);
        setState(
          produce((s) => {
            s.ob.assignedModel = first.externalModelId;
            s.ob.done2 = true;
            s.ob.busy2 = false;
            s.ob.error2 = null;
          }),
        );
      } catch (e) {
        setState('ob', { busy2: false, error2: errMessage(e) });
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
        setState('ob', { busy3: false, error3: errMessage(e) });
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
