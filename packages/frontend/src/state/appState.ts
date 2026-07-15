import { createStore, produce, type SetStoreFunction } from 'solid-js/store';
import { BASE_URL } from '../data/catalog';
import {
  SEED_AGENTS,
  SEED_CHANNELS,
  SEED_CHART,
  SEED_LIMITS,
  SEED_PROVIDERS,
  SEED_RULES,
  SEED_STATS,
  SEED_TIERS,
} from '../data/seed';
import { generateRequest, mintKey, seedRequests } from '../data/simulator';
import type {
  Harness,
  LimitAction,
  LimitWindow,
  ModalKind,
  OnboardingState,
  Page,
  ProviderKindId,
  RequestFilter,
  Range,
  RoutedRequest,
  Theme,
} from '../types';
import type { Agent, Channel, HeaderRule, Limit, Provider, Stats, Tier } from '../types';

export interface AppState {
  page: Page;
  theme: Theme;
  range: Range;
  reqFilter: RequestFilter;
  requests: RoutedRequest[];
  selId: string | null;
  toast: string | null;
  stats: Stats;
  chart: number[];
  tiers: Tier[];
  autoLayers: { structural: boolean; cascade: boolean; semantic: boolean };
  rules: HeaderRule[];
  providers: Provider[];
  agents: Agent[];
  limits: Limit[];
  channels: Channel[];
  bodyLog: boolean;
  modal: ModalKind | null;
  na: { name: string; harness: Harness };
  kr: { title: string; key: string; harness: Harness };
  np: { kind: ProviderKindId | null; value: string; test: 'idle' | 'testing' | 'ok' };
  nl: { scope: string; amount: string; window: LimitWindow; action: LimitAction };
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

export function snippetFor(harness: Harness, key: string): string {
  if (harness === 'anthropic_sdk')
    return `import anthropic\n\nclient = anthropic.Anthropic(\n    base_url="${BASE_URL.replace('/v1', '')}",\n    api_key="${key}")\n# model="auto" lets the router decide`;
  if (harness === 'curl')
    return `curl ${BASE_URL}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{"model":"auto","messages":[...]}'`;
  if (harness === 'openclaw')
    return `# ~/.openclaw/config.toml\n[llm]\nbase_url = "${BASE_URL}"\napi_key  = "${key}"\nmodel    = "auto"`;
  return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${BASE_URL}",\n    api_key="${key}")\n# model="auto" lets the router decide`;
}

function initialState(): AppState {
  return {
    page: 'overview',
    theme: 'light',
    range: '24h',
    reqFilter: 'all',
    requests: seedRequests(26),
    selId: null,
    toast: null,
    stats: { ...SEED_STATS },
    chart: [...SEED_CHART],
    tiers: SEED_TIERS.map((t) => ({ ...t, chain: [...t.chain] })),
    autoLayers: { structural: true, cascade: true, semantic: false },
    rules: SEED_RULES.map((r) => ({ ...r })),
    providers: SEED_PROVIDERS.map((p) => ({ ...p })),
    agents: SEED_AGENTS.map((a) => ({ ...a })),
    limits: SEED_LIMITS.map((l) => ({ ...l })),
    channels: SEED_CHANNELS.map((c) => ({ ...c })),
    bodyLog: false,
    modal: null,
    na: { name: '', harness: 'openai_sdk' },
    kr: { title: '', key: '', harness: 'openai_sdk' },
    np: { kind: null, value: '', test: 'idle' },
    nl: { scope: 'Global', amount: '10.00', window: 'day', action: 'alert' },
    ob: {
      step: 1,
      name: 'my-agent',
      harness: 'openai_sdk',
      key: '',
      provPicked: null,
      done1: false,
      done2: false,
    },
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
  /** Clears the toast and its pending auto-dismiss timer (tests, teardown). */
  clearToast: () => void;
  copy: (txt: string, msg?: string) => void;
  // live feed
  pushLiveRequest: () => void;
  // routing
  reorderChain: (tierIndex: number, from: number, to: number) => void;
  removeFromChain: (tierIndex: number, model: string) => void;
  addToChain: (tierIndex: number, model: string) => boolean;
  toggleLayer: (layer: 'structural' | 'cascade' | 'semantic') => void;
  removeRule: (id: number) => void;
  // agents & providers
  openModal: (modal: ModalKind) => void;
  closeModal: () => void;
  createAgent: () => void;
  revealSnippet: (agent: Agent) => void;
  rotateKey: (agent: Agent) => void;
  pickProviderKind: (kind: ProviderKindId) => void;
  setNpValue: (value: string) => void;
  testProvider: () => void;
  addProvider: () => void;
  // limits & settings
  createLimit: () => void;
  toggleBodyLog: () => void;
  toggleChannel: (id: number) => void;
  testChannel: (id: number) => void;
  addChannel: () => void;
  // onboarding
  obGo: (step: 1 | 2 | 3) => void;
  obCreateAgent: () => void;
  obPickProvider: (kind: ProviderKindId) => void;
  obFinish: () => void;
}

export function createAppStore(): AppStore {
  const [state, setState] = createStore<AppState>(initialState());
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  // Invalidates in-flight simulated connection tests: any change to the tested
  // form (kind, value, modal close) bumps the token so a stale timeout can't
  // mark an untested configuration as ok.
  let npTestToken = 0;

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
    setFilter: (reqFilter) => setState('reqFilter', reqFilter),
    select: (id) => setState('selId', id),
    say,
    clearToast: () => {
      clearTimeout(toastTimer);
      setState('toast', null);
    },
    copy,

    pushLiveRequest: () => {
      const r = generateRequest(Date.now());
      setState(
        produce((s) => {
          s.requests = [r, ...s.requests].slice(0, 40);
          const last = s.chart.length - 1;
          s.chart[last] = Math.min(98, (s.chart[last] ?? 0) + 1);
          s.stats.spend += r.cost;
          s.stats.reqs += 1;
          s.stats.tin += r.tin;
          s.stats.tout += r.tout;
          if (r.status === 'fallback') s.stats.fb += 1;
          if (r.escalated) s.stats.esc += 1;
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

    openModal: (modal) => {
      if (modal === 'newAgent') setState({ modal, na: { name: '', harness: 'openai_sdk' } });
      else if (modal === 'newProvider') {
        npTestToken++;
        setState({ modal, np: { kind: null, value: '', test: 'idle' } });
      } else setState('modal', modal);
    },
    closeModal: () => {
      npTestToken++;
      setState('np', 'test', 'idle');
      setState('modal', null);
    },
    createAgent: () => {
      const name = state.na.name.trim() || 'my-agent';
      const key = mintKey();
      setState(
        produce((s) => {
          s.agents.push({
            id: `a${String(s.agents.length + 1)}${Math.random().toString(36).slice(2, 5)}`,
            name,
            harness: s.na.harness,
            prefix: key.slice(0, 9),
            reqs: 0,
            spend: '$0.00',
            last: 'never',
          });
          s.modal = 'keyReveal';
          s.kr = { title: `Key minted — ${name}`, key, harness: s.na.harness };
        }),
      );
    },
    revealSnippet: (agent) =>
      setState({
        modal: 'keyReveal',
        kr: {
          title: `Connection snippet — ${agent.name}`,
          key: `${agent.prefix}••••••••••••••••••••`,
          harness: agent.harness,
        },
      }),
    rotateKey: (agent) =>
      setState({
        modal: 'keyReveal',
        kr: { title: `New key — ${agent.name}`, key: mintKey(), harness: agent.harness },
      }),
    pickProviderKind: (kind) => {
      npTestToken++;
      setState('np', { kind, value: '', test: 'idle' });
    },
    setNpValue: (value) => {
      npTestToken++;
      setState('np', (np) => ({ ...np, value, test: 'idle' }));
    },
    testProvider: () => {
      const token = ++npTestToken;
      setState('np', 'test', 'testing');
      setTimeout(() => {
        if (token === npTestToken) setState('np', 'test', 'ok');
      }, 900);
    },
    addProvider: () => {
      if (state.np.test !== 'ok' || state.np.kind === null) return;
      const kind = state.np.kind;
      setState(
        produce((s) => {
          s.providers.push({
            id: `p${Math.random().toString(36).slice(2, 6)}`,
            name: kind === 'local' ? 'LM Studio' : kind === 'custom' ? 'mylab-endpoint' : 'Mistral',
            kind: kind === 'api' ? 'API key' : kind === 'sub' ? 'subscription' : kind,
            status: 'ok',
            models: 12,
            reqs: 0,
            spend: '$0.00',
          });
          s.modal = null;
        }),
      );
      say('Provider added — 12 models synced');
    },

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
    obCreateAgent: () => setState('ob', (ob) => ({ ...ob, key: mintKey(), done1: true })),
    obPickProvider: (kind) => setState('ob', (ob) => ({ ...ob, provPicked: kind, done2: true })),
    obFinish: () => {
      setState('page', 'overview');
      say('You’re live — point your agent at /v1');
    },
  };
}

/** Process-wide store used by the app; tests construct their own via createAppStore(). */
export const app = createAppStore();
