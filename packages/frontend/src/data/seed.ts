import type {
  Agent,
  Channel,
  Limit,
  MonthCostSummary,
  OverviewNotes,
  Provider,
  SpendDatum,
  Stats,
  Tier,
} from '../types';

/** Initial simulated dashboard state, ported from the design prototype. */

export const SEED_STATS: Stats = {
  spend: 4.12,
  reqs: 1284,
  tin: 1.92e6,
  tout: 0.49e6,
  fb: 8,
  esc: 2,
};

export const SEED_CHART: number[] = [
  22, 25, 21, 30, 28, 38, 34, 46, 42, 55, 49, 62, 58, 70, 64, 76, 71, 84, 78, 88, 82, 90, 86, 92,
];

export const SEED_TIERS: Tier[] = [
  {
    key: 'default',
    desc: 'Serves everything unless told otherwise',
    chain: ['gpt-5.2-mini', 'deepseek-v3.2', 'claude-sonnet-4.5'],
  },
  {
    key: 'heavy',
    desc: 'Hard reasoning & long generations',
    chain: ['claude-sonnet-4.5', 'claude-opus-4.6', 'gpt-5.2'],
  },
  {
    key: 'background',
    desc: 'Bulk / non-urgent — free first',
    chain: ['llama3.3:70b', 'qwen3-coder-30b', 'deepseek-v3.2'],
  },
];

export const SEED_RULES = [
  { id: 1, value: 'heavy', target: 'tier heavy' },
  { id: 2, value: 'background', target: 'tier background' },
];

export const SEED_PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'API key',
    status: 'ok',
    models: 6,
    reqs: 214,
    spend: '$1.92',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'API key',
    status: 'ok',
    models: 9,
    reqs: 517,
    spend: '$1.31',
  },
  {
    id: 'claude-max',
    name: 'Claude Max',
    kind: 'subscription',
    status: 'ok',
    models: 3,
    reqs: 41,
    spend: '$0.00',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'API key',
    status: 'ok',
    models: 4,
    reqs: 202,
    spend: '$0.71',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    status: 'ok',
    models: 5,
    reqs: 268,
    spend: 'free',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'API key',
    status: 'warn',
    models: 42,
    reqs: 42,
    spend: '$0.18',
  },
];

export const SEED_AGENTS: Agent[] = [
  {
    id: 'a1',
    name: 'openclaw',
    harness: 'openclaw',
    prefix: 'poly_k7Jf',
    reqs: 641,
    spend: '$2.04',
    last: '12s ago',
  },
  {
    id: 'a2',
    name: 'vscode-continue',
    harness: 'openai_sdk',
    prefix: 'poly_mQ2x',
    reqs: 388,
    spend: '$1.42',
    last: '2m ago',
  },
  {
    id: 'a3',
    name: 'cron-summarizer',
    harness: 'curl',
    prefix: 'poly_R8na',
    reqs: 196,
    spend: '$0.38',
    last: '31m ago',
  },
  {
    id: 'a4',
    name: 'research-notebook',
    harness: 'anthropic_sdk',
    prefix: 'poly_Zt5c',
    reqs: 59,
    spend: '$0.28',
    last: '3h ago',
  },
];

export const SEED_LIMITS: Limit[] = [
  {
    id: 1,
    scope: 'Global',
    threshold: 10,
    window: 'day',
    action: 'alert',
    current: 4.12,
    note: 'notifies: homelab email, ntfy push',
  },
  {
    id: 2,
    scope: 'Agent · openclaw',
    threshold: 25,
    window: 'week',
    action: 'block',
    current: 9.84,
    note: 'hard stop — requests rejected at limit',
  },
  {
    id: 3,
    scope: 'Global',
    threshold: 80,
    window: 'month',
    action: 'alert',
    current: 61.48,
    note: 'notifies: homelab email',
  },
];

export const SEED_CHANNELS: Channel[] = [
  {
    id: 1,
    name: 'homelab email',
    kind: 'smtp',
    enabled: true,
    detail: 'smtp.fastmail.com · to admin@izzo.one',
    last: 'test ok · 2d ago',
    lastOk: true,
    testing: false,
  },
  {
    id: 2,
    name: 'ntfy push',
    kind: 'apprise',
    enabled: true,
    detail: 'ntfy://homelab/polyrouter',
    last: 'test ok · 5h ago',
    lastOk: true,
    testing: false,
  },
];

/* Simulated analytics datasets (prototype values). Pages read these through the
 * data boundary so the analytics-api change swaps them without touching JSX. */

export const SEED_SPEND_BY_MODEL_24H: SpendDatum[] = [
  { n: 'claude-sonnet-4.5', v: 1.86 },
  { n: 'gpt-5.2-mini', v: 0.94 },
  { n: 'deepseek-v3.2', v: 0.71 },
  { n: 'kimi-k2', v: 0.38 },
  { n: 'llama3.3:70b', v: 0, fv: 0.62, free: true },
];

export const SEED_COST_BY_MODEL_30D: SpendDatum[] = [
  { n: 'claude-sonnet-4.5', v: 27.4 },
  { n: 'gpt-5.2', v: 12.1 },
  { n: 'gpt-5.2-mini', v: 10.22 },
  { n: 'deepseek-v3.2', v: 7.94 },
  { n: 'kimi-k2', v: 3.82 },
  { n: 'llama3.3:70b', v: 0, fv: 9.1, free: true },
];

export const SEED_COST_BY_PROVIDER_30D: SpendDatum[] = [
  { n: 'Anthropic', v: 27.4 },
  { n: 'OpenAI', v: 22.32 },
  { n: 'DeepSeek', v: 7.94 },
  { n: 'Ollama', v: 0, fv: 12, free: true },
];

export const SEED_COST_BY_AGENT_30D: SpendDatum[] = [
  { n: 'openclaw', v: 31.2 },
  { n: 'vscode-continue', v: 19.44 },
  { n: 'cron-summarizer', v: 6.9 },
  { n: 'research-notebook', v: 3.94 },
];

/** Chart x-positions of the simulated fallback events on the Overview chart. */
export const SEED_FALLBACK_DOTS: number[] = [208, 291, 457];

export const SEED_MONTH_COST_SUMMARY: MonthCostSummary = {
  spend: 61.48,
  listPrice: 99.2,
  estimatedFlagged: 3,
  splitPct: { free: 23, subscription: 12, api: 65 },
};

export const SEED_OVERVIEW_NOTES: OverviewNotes = {
  spendVsList: '38% below list price',
  requestsTrend: '↑ 12% vs yesterday',
};
