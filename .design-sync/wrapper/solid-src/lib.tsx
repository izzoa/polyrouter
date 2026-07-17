/* Stage-1 (Solid) half of @polyrouter/design-kit.
 *
 * Everything imported below is the dashboard's REAL source, compiled by the
 * repo's own toolchain (vite-plugin-solid) — never a rewrite. The React
 * adapters in ../src mount these components through the two mounters at the
 * bottom; app-context components get the app's own store, backed by the
 * repo's own FakeApiClient seeded with the demo corpus in this file.
 */
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

// ── real app code ────────────────────────────────────────────────────────
import { AppProvider } from '../../../packages/frontend/src/state/context';
import { createAppStore, type AppStore } from '../../../packages/frontend/src/state/appState';
import {
  FakeApiClient,
  DEFAULT_SESSION,
  type FakeOptions,
} from '../../../packages/frontend/src/test/fakeClient';
import type {
  AgentDto,
  AnalyticsSummary,
  AutoLayers,
  BreakdownRow,
  BudgetDto,
  ChannelDto,
  ModelDto,
  ProviderDto,
  RequestRow,
  RuleDto,
  TierDto,
  TierEntryDto,
  TimeseriesPoint,
} from '../../../packages/frontend/src/data/api';
import type { SpendDatum } from '../../../packages/frontend/src/types';

import { BarRows } from '../../../packages/frontend/src/components/BarRows';
import { Chart } from '../../../packages/frontend/src/components/Chart';
import { Inspector } from '../../../packages/frontend/src/components/Inspector';
import { HarnessSelect, Modals } from '../../../packages/frontend/src/components/Modals';
import { RangeSelector } from '../../../packages/frontend/src/components/RangeSelector';
import {
  RequestRows,
  RequestTableHead,
} from '../../../packages/frontend/src/components/RequestTable';
import { Sidebar } from '../../../packages/frontend/src/components/Sidebar';
import { Toast } from '../../../packages/frontend/src/components/Toast';
import { Toggle } from '../../../packages/frontend/src/components/Toggle';
import { Topbar } from '../../../packages/frontend/src/components/Topbar';

import { Agents } from '../../../packages/frontend/src/pages/Agents';
import { Costs } from '../../../packages/frontend/src/pages/Costs';
import { Limits } from '../../../packages/frontend/src/pages/Limits';
import { Login } from '../../../packages/frontend/src/pages/Login';
import { Overview } from '../../../packages/frontend/src/pages/Overview';
import { Providers } from '../../../packages/frontend/src/pages/Providers';
import { Requests } from '../../../packages/frontend/src/pages/Requests';
import { Routing } from '../../../packages/frontend/src/pages/Routing';
import { Settings } from '../../../packages/frontend/src/pages/Settings';
import { Setup } from '../../../packages/frontend/src/pages/Setup';

// The dashboard's full stylesheet (tokens + component classes, light+dark).
// Vite extracts this — together with uPlot's CSS imported by Chart — into
// solid/design-kit.css, which the converter ships as _ds_bundle.css.
import '../../../packages/frontend/src/styles.css';

// ── component registry (internal to the bundle; adapters mount from here) ──
/* eslint-disable @typescript-eslint/no-explicit-any */
export const solid: Record<string, (p: any) => JSX.Element> = {
  BarRows,
  Chart,
  HarnessSelect,
  Inspector,
  Modals,
  RangeSelector,
  RequestRows,
  RequestTableHead,
  Sidebar,
  Toast,
  Toggle,
  Topbar,
  Agents,
  Costs,
  Limits,
  Login,
  Overview,
  Providers,
  Requests,
  Routing,
  Settings,
  Setup,
};

// ── demo corpus (composition data for previews & the design agent) ────────
const T0 = '2026-07-15T09:00:00.000Z';
const t0 = Date.parse(T0);
const iso = (msAgo: number): string => new Date(t0 - msAgo).toISOString();

export const demoProviders: ProviderDto[] = [
  { id: 'prov-anthropic', name: 'Anthropic', kind: 'api_key', protocol: 'anthropic_compatible', baseUrl: 'https://api.anthropic.com', status: 'ok', hasCredential: true, createdAt: iso(86_400_000 * 21) },
  { id: 'prov-openai', name: 'OpenAI', kind: 'api_key', protocol: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', status: 'ok', hasCredential: true, createdAt: iso(86_400_000 * 21) },
  { id: 'prov-ollama', name: 'Ollama (local)', kind: 'local', protocol: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', status: 'ok', hasCredential: false, createdAt: iso(86_400_000 * 6) },
];

function model(
  id: string, providerId: string, ext: string, name: string,
  inPrice: number | null, outPrice: number | null, free = false,
): ModelDto {
  return {
    id, providerId, externalModelId: ext, displayName: name,
    contextWindow: 200_000, supportsTools: true, supportsVision: !free,
    supportsReasoning: id.includes('sonnet') || id.includes('gpt-5'),
    isFree: free, inputPricePer1m: inPrice, outputPricePer1m: outPrice,
    lastSyncedAt: T0,
  };
}
export const demoModels: Record<string, ModelDto[]> = {
  'prov-anthropic': [
    model('m-sonnet', 'prov-anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', 3, 15),
    model('m-haiku', 'prov-anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 1, 5),
  ],
  'prov-openai': [
    model('m-gpt5', 'prov-openai', 'gpt-5', 'GPT-5', 1.25, 10),
    model('m-gpt5m', 'prov-openai', 'gpt-5-mini', 'GPT-5 mini', 0.25, 2),
  ],
  'prov-ollama': [model('m-llama', 'prov-ollama', 'llama-3.3-70b', 'Llama 3.3 70B', 0, 0, true)],
};

export const demoAgents: AgentDto[] = [
  { id: 'agent-0', name: 'openclaw', harness: 'openclaw', prefix: 'poly_a1b2c', lastUsedAt: iso(240_000), createdAt: iso(86_400_000 * 20) },
  { id: 'agent-1', name: 'ci-summarizer', harness: 'openai_sdk', prefix: 'poly_9f8e7', lastUsedAt: iso(3_600_000), createdAt: iso(86_400_000 * 14) },
  { id: 'agent-2', name: 'support-bot', harness: 'vercel_ai_sdk', prefix: 'poly_55aa0', lastUsedAt: null, createdAt: iso(86_400_000 * 2) },
];

export const demoTiers: TierDto[] = [
  { id: 'tier-default', key: 'default', displayName: 'Default', description: 'Balanced chain for unrouted requests', createdAt: iso(86_400_000 * 21) },
  { id: 'tier-fast', key: 'fast', displayName: 'Fast', description: 'Cheap-first for bulk work', createdAt: iso(86_400_000 * 20) },
  { id: 'tier-smart', key: 'smart', displayName: 'Smart', description: 'Frontier models for hard problems', createdAt: iso(86_400_000 * 20) },
];

function entries(tierId: string, modelIds: string[]): TierEntryDto[] {
  const all = Object.values(demoModels).flat();
  return modelIds.map((modelId, position) => {
    const m = all.find((x) => x.id === modelId);
    return {
      id: `entry-${tierId}-${String(position)}`, tierId, modelId, position,
      model: m
        ? { id: m.id, providerId: m.providerId, externalModelId: m.externalModelId, displayName: m.displayName }
        : null,
    };
  });
}
export const demoTierEntries: Record<string, TierEntryDto[]> = {
  'tier-default': entries('tier-default', ['m-sonnet', 'm-gpt5m', 'm-llama']),
  'tier-fast': entries('tier-fast', ['m-haiku', 'm-gpt5m', 'm-llama']),
  'tier-smart': entries('tier-smart', ['m-gpt5', 'm-sonnet']),
};

export const demoRules: RuleDto[] = [
  { id: 'rule-1', matchType: 'header', headerName: 'x-polyrouter-tier', headerValue: 'fast', target: 'tier:fast', priority: 10, createdAt: iso(86_400_000 * 12) },
  { id: 'rule-2', matchType: 'header', headerName: 'x-polyrouter-tier', headerValue: 'smart', target: 'tier:smart', priority: 10, createdAt: iso(86_400_000 * 12) },
];

export const demoBudgets: BudgetDto[] = [
  { id: 'budget-1', name: 'Monthly cap', scope: 'global', agentId: null, window: 'month', action: 'alert', amount: 120, notifyChannelIds: ['chan-1'], enabled: true, createdAt: iso(86_400_000 * 18) },
  { id: 'budget-2', name: 'openclaw / day', scope: 'agent', agentId: 'agent-0', window: 'day', action: 'block', amount: 5, notifyChannelIds: ['chan-1', 'chan-2'], enabled: true, createdAt: iso(86_400_000 * 9) },
];

export const demoChannels: ChannelDto[] = [
  { id: 'chan-1', name: 'Ops email', kind: 'smtp', enabled: true, eventsSubscribed: ['budget_alert', 'budget_block'], hasConfig: true, lastTestAt: iso(86_400_000 * 3), lastTestStatus: 'success' },
  { id: 'chan-2', name: 'ntfy push', kind: 'apprise', enabled: true, eventsSubscribed: ['budget_block', 'provider_down'], hasConfig: true, lastTestAt: null, lastTestStatus: null },
];

export const demoAutoLayers: AutoLayers = {
  structural: true, cascade: false, structuralAvailable: true, cascadeAvailable: true,
};

const HOURLY = [8, 6, 5, 4, 6, 9, 14, 22, 31, 38, 42, 45, 44, 41, 39, 42, 46, 44, 38, 30, 24, 18, 14, 11];
export function demoTimeseries(): TimeseriesPoint[] {
  const base = t0 - 23 * 3_600_000;
  return HOURLY.map((requests, i) => ({
    bucket: new Date(base + i * 3_600_000).toISOString(),
    requests,
    spend: Number((requests * 0.11).toFixed(2)),
    inputTokens: requests * 3_200,
    outputTokens: requests * 900,
    errorCount: i % 9 === 0 ? 1 : 0,
    fallbackCount: i % 6 === 0 ? 1 : 0,
    escalatedCount: i % 5 === 0 ? 2 : 0,
  }));
}

export function demoSummary(): AnalyticsSummary {
  const pts = demoTimeseries();
  const requests = pts.reduce((a, p) => a + p.requests, 0);
  return {
    spend: Number(pts.reduce((a, p) => a + p.spend, 0).toFixed(2)),
    requests,
    inputTokens: pts.reduce((a, p) => a + p.inputTokens, 0),
    outputTokens: pts.reduce((a, p) => a + p.outputTokens, 0),
    cacheReadTokens: 214_000, cacheWriteTokens: 88_000,
    successCount: requests - 31, fallbackCount: 19, errorCount: 12,
    escalatedCount: 44, estimatedCount: 9,
    freeRequests: 168, paidRequests: requests - 180, unpricedRequests: 12,
  };
}

const demoBreakdown: Record<'model' | 'provider' | 'agent' | 'tier', BreakdownRow[]> = {
  model: [
    { key: 'm-sonnet', label: 'claude-sonnet-5', spend: 31.42, requests: 214 },
    { key: 'm-gpt5', label: 'gpt-5', spend: 18.9, requests: 96 },
    { key: 'm-gpt5m', label: 'gpt-5-mini', spend: 9.77, requests: 163 },
    { key: 'm-haiku', label: 'claude-haiku-4-5', spend: 6.1, requests: 71 },
    { key: 'm-llama', label: 'llama-3.3-70b', spend: 0, requests: 97 },
  ],
  provider: [
    { key: 'prov-anthropic', label: 'Anthropic', spend: 37.52, requests: 285 },
    { key: 'prov-openai', label: 'OpenAI', spend: 28.67, requests: 259 },
    { key: 'prov-ollama', label: 'Ollama (local)', spend: 0, requests: 97 },
  ],
  agent: [
    { key: 'agent-0', label: 'openclaw', spend: 41.03, requests: 388 },
    { key: 'agent-1', label: 'ci-summarizer', spend: 19.66, requests: 174 },
    { key: 'agent-2', label: 'support-bot', spend: 5.5, requests: 79 },
  ],
  tier: [{ key: 'default', label: 'default', spend: 66.19, requests: 641 }],
};

const LAYER_REASON: Record<string, string> = {
  explicit: 'model pinned by request body',
  header: 'x-polyrouter-tier: fast',
  default: 'default tier chain, primary healthy',
  structural: 'fingerprint match — code-review agent baseline',
  cascade: 'escalated: quality signal 0.42 < 0.60',
};

/** Deterministic realistic request-log corpus (newest-first). */
export function demoRequestRows(n = 30): RequestRow[] {
  const picks = [
    { model: 'm-sonnet', modelLabel: 'claude-sonnet-5', prov: 'prov-anthropic', provLabel: 'Anthropic', inP: 3, outP: 15 },
    { model: 'm-gpt5m', modelLabel: 'gpt-5-mini', prov: 'prov-openai', provLabel: 'OpenAI', inP: 0.25, outP: 2 },
    { model: 'm-llama', modelLabel: 'llama-3.3-70b', prov: 'prov-ollama', provLabel: 'Ollama (local)', inP: 0, outP: 0 },
    { model: 'm-haiku', modelLabel: 'claude-haiku-4-5', prov: 'prov-anthropic', provLabel: 'Anthropic', inP: 1, outP: 5 },
    { model: 'm-gpt5', modelLabel: 'gpt-5', prov: 'prov-openai', provLabel: 'OpenAI', inP: 1.25, outP: 10 },
  ];
  const layers = ['explicit', 'header', 'default', 'structural', 'cascade'];
  const statuses = ['success', 'success', 'success', 'fallback', 'success', 'error'];
  const agents = [
    { id: 'agent-0', label: 'openclaw' },
    { id: 'agent-1', label: 'ci-summarizer' },
    { id: 'agent-2', label: 'support-bot' },
  ];
  const rows: RequestRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = picks[i % picks.length]!;
    const layer = layers[i % layers.length]!;
    const status = statuses[i % statuses.length]!;
    const agent = agents[i % agents.length]!;
    const free = p.inP === 0;
    const inputTokens = 900 + ((i * 517) % 6_400);
    const outputTokens = 140 + ((i * 211) % 1_900);
    const cost = free ? 0 : Number(((inputTokens * p.inP + outputTokens * p.outP) / 1_000_000).toFixed(6));
    rows.push({
      id: `req-${String(1000 - i)}`,
      createdAt: iso(i * 137_000),
      agentId: agent.id,
      providerId: p.prov,
      modelId: p.model,
      tierAssigned: layer === 'explicit' ? null : layer === 'header' ? 'fast' : 'default',
      decisionLayer: layer,
      routingReason: LAYER_REASON[layer] ?? layer,
      status,
      escalated: layer === 'cascade',
      inputTokens,
      outputTokens,
      cacheReadTokens: i % 3 === 0 ? 2_048 : null,
      cacheWriteTokens: i % 4 === 0 ? 512 : null,
      inputPriceSnapshot: free ? 0 : p.inP,
      outputPriceSnapshot: free ? 0 : p.outP,
      cacheReadPriceSnapshot: i % 3 === 0 ? Number((p.inP * 0.1).toFixed(4)) : null,
      cacheWritePriceSnapshot: i % 4 === 0 ? Number((p.inP * 1.25).toFixed(4)) : null,
      cost,
      attemptCostMicros: status === 'fallback' ? 240 : 0,
      durationMs: 800 + ((i * 397) % 6_200),
      usageEstimated: i % 8 === 0,
      qualitySignal: layer === 'cascade' ? 0.42 : i % 3 === 0 ? 0.81 : null,
      modelLabel: p.modelLabel,
      providerLabel: p.provLabel,
      agentLabel: agent.label,
    } as RequestRow);
  }
  return rows;
}

export const demoSpend: SpendDatum[] = [
  { n: 'claude-sonnet-5', v: 31.42 },
  { n: 'gpt-5', v: 18.9 },
  { n: 'gpt-5-mini', v: 9.77 },
  { n: 'claude-haiku-4-5', v: 6.1 },
  { n: 'llama-3.3-70b', v: 0, fv: 12.3, free: true },
];

export function demoChartData(): [number[], number[]] {
  const pts = demoTimeseries();
  return [pts.map((p) => Math.floor(Date.parse(p.bucket) / 1000)), pts.map((p) => p.requests)];
}

/** Everything the pages need to self-load realistically, as the app's own
 * FakeApiClient options. */
export function demoFakeOptions(): FakeOptions {
  return {
    session: DEFAULT_SESSION,
    agents: demoAgents.map((a) => ({ ...a })),
    providers: demoProviders.map((p) => ({ ...p })),
    models: Object.fromEntries(Object.entries(demoModels).map(([k, v]) => [k, v.map((m) => ({ ...m }))])),
    tiers: demoTiers.map((t) => ({ ...t })),
    tierEntries: Object.fromEntries(Object.entries(demoTierEntries).map(([k, v]) => [k, v.map((e) => ({ ...e }))])),
    rules: demoRules.map((r) => ({ ...r })),
    budgets: demoBudgets.map((b) => ({ ...b })),
    channels: demoChannels.map((c) => ({ ...c })),
    autoLayers: { ...demoAutoLayers },
    summary: demoSummary(),
    timeseries: demoTimeseries(),
    breakdown: {
      model: demoBreakdown.model.map((r) => ({ ...r })),
      provider: demoBreakdown.provider.map((r) => ({ ...r })),
      agent: demoBreakdown.agent.map((r) => ({ ...r })),
      tier: demoBreakdown.tier.map((r) => ({ ...r })),
    },
    requestRows: demoRequestRows(60),
  };
}

// ── mounters (the only Solid-rendering surface the adapters touch) ────────
export type Disposer = () => void;

export function mountPlain(
  el: HTMLElement,
  Comp: (p: Record<string, unknown>) => JSX.Element,
  props: Record<string, unknown>,
): Disposer {
  return render(() => <Comp {...props} />, el);
}

export interface AppMountOptions {
  fake?: FakeOptions;
  seed?: Record<string, unknown>;
  init?: (store: AppStore) => void;
}

export function mountWithApp(
  el: HTMLElement,
  Comp: (p: Record<string, unknown>) => JSX.Element,
  props: Record<string, unknown>,
  opts: AppMountOptions = {},
): Disposer {
  const store = createAppStore(new FakeApiClient(opts.fake ?? {}));
  if (opts.seed) {
    (store.setState as unknown as (patch: Record<string, unknown>) => void)(opts.seed);
  }
  opts.init?.(store);
  return render(
    () => (
      <AppProvider store={store}>
        <Comp {...props} />
      </AppProvider>
    ),
    el,
  );
}
