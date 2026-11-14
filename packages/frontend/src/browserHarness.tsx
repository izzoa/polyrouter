/** Browser-test fixture seam (phase1-responsive-dashboard-layout, task 8.2).
 *
 * Mounts the REAL `App` against the existing `FakeApiClient`, so the responsive browser
 * suite needs no Postgres, no Redis and no running backend — and, more importantly, gets
 * byte-identical data on every run. A suite that asserts layout cannot tolerate rows that
 * change between runs.
 *
 * Deliberately NOT part of the shipped app: this module is referenced only by
 * `browser-harness.html`, which the production build excludes (see `vite.config.ts`).
 *
 * Content is adversarial on purpose (task 8.3). Overflow is the whole subject of this
 * change, so the fixture carries the longest realistic values a self-hoster would see —
 * a 26-character model id, a 50-character enterprise email, a long provider label —
 * rather than the short placeholders that would make every assertion pass trivially.
 */
// MUST STAY FIRST — see the note in `index.tsx`. The harness pulls in the same eager
// `App → Overview → Chart → uplot` chain, so it has the same failure and needs the same guard.
import './localeGuard';
import { render } from 'solid-js/web';
import { App } from './App';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import {
  DEFAULT_AUTO_PERF,
  DEFAULT_CALIBRATION,
  FakeApiClient,
  UNRECORDED_HEALTH,
} from './test/fakeClient';
import { fakeBudgetProgress } from './test/budgetProgressFixture';
import type {
  AdminInviteDto,
  AgentDto,
  AutoPerformance,
  BatchJobDto,
  BudgetDto,
  RequestRow,
  WorkloadMix,
} from './data/api';
import './styles.css';

const params = new URLSearchParams(globalThis.location.search);
const role = params.get('role') === 'member' ? 'member' : 'admin';

// Workload-mix fixture variants (fix-workload-mix-phone-overflow), opt-in via
// `?workload=…` so the DEFAULT harness stays byte-identical for every other
// browser suite. The default fixture already reproduces the shipped 320px
// overflow; these two variants exercise the row states the default never
// carries, so the narrow-width geometry checks cover the whole contract.
//
// `boundary` covers, in one range: a positive routed count, a null-spend row
// (the bare word `unpriced`, no dash), a free row (`$0.0000` with no qualifier), an
// ordinary priced row,
// a partial-pricing row (`N unpriced`), and a request-zero attempt-only class
// (`0%`). Requests sum to `evaluated` so the shares read 100%.
const BOUNDARY_WORKLOAD_MIX: WorkloadMix = {
  evaluated: 20,
  unclassified: 0,
  since: '2026-07-12T00:00:00.000Z',
  revisions: [{ revision: 'structural/v1/c1/boundary01', requests: 20 }],
  classes: [
    // ordinary priced + positive routed count
    {
      class: 'code',
      requests: 10,
      unpricedRequests: 0,
      unpricedAttempts: 0,
      spendUsd: 12.34,
      routed: 7,
    },
    // null spend → the bare word "unpriced", with no dash (adopt-figure-states 4.2).
    // Producer-reachable: the aggregation only reports `spendUsd: null` when NOTHING is
    // costable, i.e. every request is unpriced (workload-mix.ts: costable = requests -
    // unpricedRequests > 0 || …), so all 5 requests must be unpriced. The numeric
    // qualifier is suppressed when spend is null, so this renders exactly "unpriced".
    {
      class: 'vision',
      requests: 5,
      unpricedRequests: 5,
      unpricedAttempts: 0,
      spendUsd: null,
      routed: 0,
    },
    // priced but partially unpriced → "1 unpriced" qualifier beside the figure
    {
      class: 'structured',
      requests: 3,
      unpricedRequests: 1,
      unpricedAttempts: 0,
      spendUsd: 9.99,
      routed: 2,
    },
    // free (subscription/no-charge) → "$0.0000" with NO qualifier, never "unpriced"
    {
      class: 'none',
      requests: 2,
      unpricedRequests: 0,
      unpricedAttempts: 0,
      spendUsd: 0,
      routed: 0,
    },
    // request-zero class reachable only through attempt spend → 0% share
    {
      class: 'writing',
      requests: 0,
      unpricedRequests: 0,
      unpricedAttempts: 1,
      spendUsd: 3.21,
      routed: 0,
    },
  ],
};

// `attempt-only` is the non-empty `evaluated === 0` path: no classified parent
// rows, but a class carrying attempt spend — the block renders the row + the
// attempt-only note, NOT the empty affordance.
const ATTEMPT_ONLY_WORKLOAD_MIX: WorkloadMix = {
  evaluated: 0,
  unclassified: 0,
  since: '2026-07-12T00:00:00.000Z',
  revisions: [],
  classes: [
    {
      class: 'code',
      requests: 0,
      unpricedRequests: 0,
      unpricedAttempts: 0,
      spendUsd: 4.56,
      routed: 0,
    },
  ],
};

function workloadAutoPerf(): AutoPerformance | undefined {
  const which = params.get('workload');
  // `exits.workload` is Σ classes[].routed (7 code + 2 structured), taken from the
  // confident-band exit so the five still sum to `evaluated`.
  if (which === 'boundary')
    return {
      ...DEFAULT_AUTO_PERF,
      exits: { workload: 9, structural: 13, semantic: 5, cascade: 10, default: 3 },
      workloadMix: BOUNDARY_WORKLOAD_MIX,
    };
  // Every class routes 0, so the default fixture's exits already hold.
  if (which === 'attempt-only')
    return { ...DEFAULT_AUTO_PERF, workloadMix: ATTEMPT_ONLY_WORKLOAD_MIX };
  return undefined;
}

// Pipeline-state fixtures (adopt-figure-states task 4.3, design Risk "Wider strings in fixed
// tracks"), opt-in via `?auto=…` so the default harness stays byte-identical for every other
// suite. `zero` is a range with no evaluated requests: the `No requests` notice, and every
// stage share reading the words `not applicable`, which are wider than the share track.
// `legacy` is an older server that sends no stage breakdown: the `Unavailable` notice, and no
// per-stage figure on stages 2–6.
function pipelineAutoPerf(): AutoPerformance | undefined {
  const which = params.get('auto');
  if (which === 'zero')
    return {
      ...DEFAULT_AUTO_PERF,
      evaluated: 0,
      bands: {
        high: { requests: 0, declared: 0, unroutable: 0 },
        low: { requests: 0, declared: 0, unroutable: 0 },
        ambiguous: { requests: 0 },
      },
      cascade: {
        requests: 0,
        qualityPassed: 0,
        qualityUnknown: 0,
        failedOrCancelled: 0,
        escalated: 0,
      },
      semantic: {
        evaluated: 0,
        routed: { high: 0, low: 0 },
        outcomes: { success: 0, fallback: 0, error: 0, cancelled: 0 },
        source: { bundled: 0, learned: 0 },
      },
      fallthrough: 0,
      exits: { workload: 0, structural: 0, semantic: 0, cascade: 0, default: 0 },
      series: [],
      savings: null,
      signalQuality: [],
      workloadMix: { evaluated: 0, unclassified: 0, since: null, revisions: [], classes: [] },
    };
  if (which === 'legacy') {
    const legacy: AutoPerformance = { ...DEFAULT_AUTO_PERF };
    delete legacy.exits;
    return legacy;
  }
  return undefined;
}

const LONG_MODEL = 'claude-sonnet-4-5-20250929';
const LONG_PROVIDER = 'anthropic-production-eu-west-1';
const LONG_EMAIL = 'alexandra.hartmann@enterprise-customer.example.com';

const AGENTS: AgentDto[] = [
  {
    id: 'a1',
    name: 'claude-code-production-worker',
    harness: 'claude-code',
    prefix: 'poly_a1b2c3d4',
    lastUsedAt: '2026-08-06T11:58:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'a2',
    name: 'nightly-batch',
    harness: 'custom',
    prefix: 'poly_e5f6g7h8',
    lastUsedAt: null,
    createdAt: '2026-08-02T09:00:00.000Z',
  },
];

const ADMIN_USERS = [
  {
    id: 'u1',
    email: LONG_EMAIL,
    name: 'Alexandra Hartmann',
    role: 'admin',
    disabled: false,
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'u2',
    email: 'sam@example.com',
    name: 'Sam',
    role: 'member',
    disabled: true,
    createdAt: '2026-08-03T09:00:00.000Z',
  },
];

const INVITES: AdminInviteDto[] = [
  {
    id: 'i1',
    email: LONG_EMAIL,
    tokenPrefix: 'poly_inv_9f3a2b',
    createdAt: '2026-08-05T09:00:00.000Z',
    expiresAt: '2026-08-12T09:00:00.000Z',
    consumedAt: null,
  },
];

// A populated default tier, so the Routing page renders real chain rows
// (phase3-touch-reorder). The fake defaults to an EMPTY chain, which meant the row that
// carries the reorder controls did not exist in the browser fixture at all — a suite
// asserting it would have found nothing and passed.
//
// Three entries, not one: the reorder boundaries (first, last) and the middle behave
// differently, and a single-entry chain exercises none of them.
//
// OPT-IN via `?chain=1`, not the default. Populating the chain makes the Routing page
// ~96px taller, which moves everything below it — enough to invalidate the picker's pinned
// desktop geometry and to push the auto-layer switch out of reach of a hit test. Those
// suites are asserting other things entirely, so the fixture this change needs is scoped
// to the suite that needs it rather than perturbing them.
// FOUR entries, and deliberately NOT uniform: the columns can only be shown to be
// shared if the rows differ in what would otherwise size them
// (fix-batch-capability-and-chain-alignment). One row carries no reservation control
// (so its cell is the empty placeholder), one model id is long enough to wrap, and the
// price label differs in width on every row — under a per-ROW grid each of those sizes
// its own tracks and the trailing cells land at four different positions, which is the
// defect these fixtures exist to expose.
const TIER_ENTRIES = [
  'claude-sonnet-4-5-20250929',
  'gpt-5-mini-2025-08-07',
  'llama-3.3-70b',
  'deepseek-ai/deepseek-v4-0324-instruct-experimental-longcontext-preview-20260401',
].map((externalModelId, i) => ({
  id: `te-${String(i)}`,
  tierId: 'tier-default',
  modelId: `m-${String(i)}`,
  position: i,
  // The middle entry is RESERVED for batch (add-batch-mode-routing), so the
  // browser suite measures a chain that actually carries the reservation control
  // and its warning states rather than a uniform row.
  mode: i === 1 ? ('batch' as const) : ('any' as const),
  model: {
    id: `m-${String(i)}`,
    providerId: 'p1',
    externalModelId,
    displayName: null,
  },
}));

// Batch jobs (add-batch-inference, task 7.3). Ten columns is the widest table in the
// app, so the batches fixture carries the worst case for EVERY one of them at once: the
// long model id and provider label that already drive requests-table overflow, plus the
// three cells that are wider than their header — a stacked ceiling with its "reserved,
// not spent" caption, a progress column carrying a count AND a status note, and a
// retention cell that falls back to the full "retention unknown" sentence.
//
// Four rows, because the row STATES render differently: one active (bar, ceiling,
// Cancel), one reconciling (the note under the count), one terminal (settled cost, a
// retention date, no action), and one lost submission (the "nothing charged" note).
const BATCH_JOBS: BatchJobDto[] = [
  {
    id: 'bj-active',
    upstreamBatchId: 'batch_01HZX9K2QRSTUVWXYZ0123456',
    status: 'in_progress',
    terminal: false,
    endpoint: '/v1/chat/completions',
    agentId: 'a2',
    providerId: 'p1',
    providerLabel: LONG_PROVIDER,
    modelId: 'm-0',
    modelLabel: LONG_MODEL,
    tierAssigned: 'nightly-reprocessing',
    counts: { total: 12_500, completed: 4_318, failed: 12 },
    submittedAt: '2026-08-06T02:14:00.000Z',
    updatedAt: '2026-08-06T11:58:00.000Z',
    terminalAt: null,
    reservedCeilingMicros: 184_250_000,
    settledCostMicros: null,
    resultsExpireAt: null,
    errorKind: null,
  },
  {
    id: 'bj-reconciling',
    upstreamBatchId: null,
    status: 'submission_unknown',
    terminal: false,
    endpoint: '/v1/messages',
    agentId: 'a2',
    providerId: 'p1',
    providerLabel: LONG_PROVIDER,
    modelId: 'm-1',
    modelLabel: LONG_MODEL,
    tierAssigned: null,
    counts: { total: 800, completed: 0, failed: 0 },
    submittedAt: '2026-08-06T11:52:00.000Z',
    updatedAt: '2026-08-06T11:58:00.000Z',
    terminalAt: null,
    reservedCeilingMicros: 9_600_000,
    settledCostMicros: null,
    resultsExpireAt: null,
    errorKind: null,
  },
  {
    id: 'bj-done',
    upstreamBatchId: 'msgbatch_01HZX9K2QRSTUVWXYZ0123456',
    status: 'completed',
    terminal: true,
    endpoint: '/v1/chat/completions',
    agentId: 'a1',
    providerId: 'p1',
    providerLabel: LONG_PROVIDER,
    modelId: 'm-0',
    modelLabel: LONG_MODEL,
    tierAssigned: 'nightly-reprocessing',
    counts: { total: 12_500, completed: 12_461, failed: 39 },
    submittedAt: '2026-08-05T02:14:00.000Z',
    updatedAt: '2026-08-05T09:41:00.000Z',
    terminalAt: '2026-08-05T09:41:00.000Z',
    reservedCeilingMicros: null,
    settledCostMicros: 172_913_400,
    resultsExpireAt: '2026-09-03T09:41:00.000Z',
    errorKind: null,
  },
  {
    id: 'bj-lost',
    upstreamBatchId: null,
    status: 'failed',
    terminal: true,
    endpoint: '/v1/chat/completions',
    agentId: 'a2',
    providerId: 'p1',
    providerLabel: LONG_PROVIDER,
    modelId: 'm-2',
    modelLabel: 'llama-3.3-70b-instruct-turbo',
    tierAssigned: null,
    counts: { total: 400, completed: 0, failed: 0 },
    submittedAt: '2026-08-04T22:03:00.000Z',
    updatedAt: '2026-08-04T22:08:00.000Z',
    terminalAt: '2026-08-04T22:08:00.000Z',
    reservedCeilingMicros: null,
    settledCostMicros: 0,
    resultsExpireAt: null,
    errorKind: 'submit_lost',
  },
];

// Batch figure-state fixture (adopt-figure-states task 5.3, design Risk "Wider strings in
// fixed tracks"), opt-in via `?batches=states` so the default harness stays byte-identical for
// every other suite. It heads the list with the two Cost-cell states the vocabulary adds: an
// active job's `≤ $3.00` ceiling above `reserved, not spent`, and a terminal job whose settled
// cost is null, which reads `unpriced`. Both carry the long model id and provider label.
const BATCH_STATE_JOBS: BatchJobDto[] = [
  {
    ...BATCH_JOBS[0]!,
    id: 'bj-ceiling',
    upstreamBatchId: 'batch_01HZX9K2QRSTUVWXYZ0CEILING',
    reservedCeilingMicros: 3_000_000,
  },
  {
    ...BATCH_JOBS[2]!,
    id: 'bj-unpriced',
    upstreamBatchId: 'msgbatch_01HZX9K2QRSTUVWXYZ0UNPRICED',
    settledCostMicros: null,
  },
];

/** The chain fixture's models, so the reservation control has a capability to read
 * (add-batch-mode-routing task 5.5). Without these the entries reference ids absent
 * from the catalog and the control renders only where a reservation is already
 * stored — a real state, but not the one the geometry checks need to measure. */
const CHAIN_PRICES = [
  { inputPricePer1m: 3, outputPricePer1m: 15, isFree: false, source: 'bundled', estimated: false },
  { inputPricePer1m: 0, outputPricePer1m: 0, isFree: true, source: 'local', estimated: false },
  { inputPricePer1m: 0.3, outputPricePer1m: 1.1, isFree: false, source: 'listed', estimated: true },
  null,
] as const;
const CHAIN_MODELS = TIER_ENTRIES.map((e, i) => ({
  id: e.modelId,
  providerId: 'p1',
  externalModelId: e.model.externalModelId,
  displayName: null,
  // contextWindow omitted: absent = unknown (honest-model-capabilities)
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: 1,
  outputPricePer1m: 2,
  // Four price labels of four different widths ("$3.0000 / $15.0000 per 1M", "free",
  // an ` · est.`-tagged pair, and "unpriced"), so a price column that is not shared
  // is measurably not shared.
  effectivePrice: CHAIN_PRICES[i] ?? null,
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  // The THIRD row's provider offers no batch tier for it, so that row renders the empty
  // reservation cell rather than the control — the case a grid declared per row gets
  // wrong, because an absent cell there is a zero-width track and every cell after it
  // shifts left.
  batchCapable: i !== 2,
  batchEffectivePrice: null,
  lastSyncedAt: null,
  unlistedSince: null,
}));

// `?bodies=1` (compact-settings-layout): capture on, with enough agents for the override
// grid to have more than one row and column to measure. Opt-in, so the default Settings
// baseline (one agent, capture off) is untouched.
const BODY_CAPTURE_AGENTS = [
  'Eigent',
  'Warp',
  'Zed',
  'BrowserOS',
  'markus',
  'Lobechat',
  'Cline',
  'Aider',
].map((name, i) => ({ id: `bc-agent-${String(i)}`, name, override: null }));
const bodyCaptureStatus =
  params.get('bodies') === '1'
    ? {
        mode: 'all' as const,
        retentionDays: 30,
        droppedCount: 0,
        lastPurgeAt: null,
        lastPurgeCount: 0,
        available: true,
        agents: BODY_CAPTURE_AGENTS,
      }
    : undefined;

// Semantic-layer fixture (split-auto-routing-readout-setup, task 3.3), opt-in via
// `?semantic=1` so the default harness stays byte-identical for every other suite. The
// default fake has Layer 2 unavailable, so the Semantic learning drawer — gated on the
// semantic layer being EFFECTIVE — could never open; this makes it effective, with a
// learned state that offers the revert confirmation.
const semanticFixture =
  params.get('semantic') === '1'
    ? {
        autoLayers: {
          structural: true,
          cascade: true,
          structuralAvailable: true,
          cascadeAvailable: true,
          semantic: true,
          semanticAvailable: true,
          semanticLearning: true,
          semanticLearningAvailable: true,
          calibration: DEFAULT_CALIBRATION,
        },
        semanticLearningStatus: {
          enabled: true,
          available: true,
          epoch: 1,
          generation: 2,
          source: 'learned' as const,
          freshHigh: 5,
          freshLow: 12,
          lastAppliedAt: '2026-07-03T00:00:00.000Z',
          history: [],
        },
      }
    : {};

const autoPerf = workloadAutoPerf() ?? pipelineAutoPerf();
const client = new FakeApiClient({
  ...semanticFixture,
  agents: AGENTS,
  adminUsers: ADMIN_USERS,
  adminInvites: INVITES,
  batchJobs: params.get('batches') === 'states' ? [...BATCH_STATE_JOBS, ...BATCH_JOBS] : BATCH_JOBS,
  ...(params.get('chain') === '1'
    ? { tierEntries: { 'tier-default': TIER_ENTRIES }, models: { p1: CHAIN_MODELS } }
    : {}),
  ...(autoPerf ? { autoPerf } : {}),
  ...(bodyCaptureStatus ? { bodyCaptureStatus } : {}),
});
// Budget-progress fixtures are opt-in; the existing layout baselines retain their data.
if (params.has('budget')) {
  const base: BudgetDto = {
    id: 'budget-progress-1',
    name: 'Daily cap for Lobechat — production research and document processing',
    scope: 'agent',
    agentId: AGENTS[0]!.id,
    amount: 25,
    window: 'day',
    action: 'block',
    meteringBasis: 'cash',
    enabled: true,
    notifyChannelIds: [],
    createdAt: '2026-10-08T00:00:00.000Z',
  };
  client.budgets = [
    base,
    {
      ...base,
      id: 'budget-progress-2',
      name: 'Monthly subscription value',
      scope: 'global',
      agentId: null,
      window: 'month',
      meteringBasis: 'notional',
      action: 'alert',
      amount: 100,
    },
    {
      ...base,
      id: 'budget-progress-3',
      name: 'Disabled budget with recorded overage',
      enabled: false,
    },
    {
      ...base,
      id: 'budget-progress-4',
      name: 'Tiny threshold with unpriced and estimated usage',
      amount: 0.0000001,
    },
    { ...base, id: 'budget-progress-5', name: 'Weekly budget with no activity', window: 'week' },
  ];
  client.progressReply = (ids) => {
    if (params.get('budget') === 'unavailable')
      return Promise.reject(new Error('progress unavailable'));
    const asOf = '2026-10-08T12:00:00.000Z';
    return Promise.resolve({
      asOf,
      results: ids.map((id) => {
        const b = client.budgets.find((row) => row.id === id);
        if (!b) return { id, availability: 'not_found' as const };
        const spent =
          id === 'budget-progress-5'
            ? 0
            : id === 'budget-progress-3'
              ? 26500000
              : id === 'budget-progress-4'
                ? 1
                : 12400000;
        const result = fakeBudgetProgress(b, asOf, spent, id === 'budget-progress-1' ? 3000000 : 0);
        if (id === 'budget-progress-4')
          result.provenance = {
            meteredRows: 4,
            unpricedRows: 1,
            unknownSpendMicros: 1,
            usageEstimated: true,
            priceEstimated: true,
          };
        if (spent > 1) {
          const start = Date.parse(result.period.start),
            end = Date.parse(asOf);
          result.points = [0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction, i) => ({
            at: new Date(start + (end - start) * fraction).toISOString(),
            spentMicros: Math.round(spent * [0, 0.1, 0.15, 0.65, 0.8, 1][i]!),
          }));
        }
        return result;
      }),
    });
  };
}
if (client.session) client.session = { ...client.session, role, email: LONG_EMAIL };
// Keep the fake's own well-formed rows and lengthen only what drives overflow: a long
// model id and provider label are the realistic worst case for the requests table.
client.requestRows = client.requestRows.map((r) => ({
  ...r,
  modelLabel: LONG_MODEL,
  providerLabel: LONG_PROVIDER,
}));

// Not-billed fixture (zero-cost-unbilled-errors), opt-in via `?unbilled=1` so the default
// harness stays byte-identical for every other suite. `$0 · not billed` is wider than the
// 0.6fr cost track, so a layout suite needs a row that actually carries it: every error
// row becomes a request no provider ran (cost 0, `billed = false`, estimated tokens kept),
// and the summary reports them so the Costs caption renders.
if (params.get('unbilled') === '1') {
  client.requestRows = client.requestRows.map((r) =>
    r.status === 'error'
      ? { ...r, billed: false, cost: 0, attemptCostMicros: 0, usageEstimated: true }
      : r,
  );
  client.summaryResult = { ...client.summaryResult, notBilledRequests: 6 };
}

// Figure-state fixture (adopt-figure-states task 2.2, design Risks 1 and 2), opt-in via
// `?requests=states` so the default harness stays byte-identical for every other suite. One
// row per cost-cell state the vocabulary adds, each wider than the old `$0.0000` in the
// 0.7fr cost track, plus the usage-estimated row whose `· est. usage` marker may wrap the
// tokens cell onto a second line (at adversarial counts, `912.3k↑ 45.7k↓ · est. usage`). They
// are the newest rows, so they head the list, and carry the long model id and provider label.
if (params.get('requests') === 'states') {
  const head = client.requestRows[0]!;
  const at = (n: number): string => new Date(Date.parse(head.createdAt) + n * 1000).toISOString();
  const row = (id: string, n: number, over: Partial<RequestRow>): RequestRow => ({
    ...head,
    id,
    createdAt: at(n),
    status: 'success',
    billed: true,
    attemptCostMicros: 0,
    usageEstimated: false,
    priceEstimated: false,
    priceSource: 'bundled',
    inputPriceSnapshot: 3,
    outputPriceSnapshot: 15,
    cost: 0.0123,
    ...over,
  });
  const free = { cost: 0, inputPriceSnapshot: 0, outputPriceSnapshot: 0 };
  client.requestRows = [
    // `· est. usage` on the tokens cell, at counts that fill the track.
    row('state-usage', 6, { usageEstimated: true, inputTokens: 912_345, outputTokens: 45_678 }),
    row('state-free', 5, free), // `$0 free`
    // `$0 free · est.`, the widest priced state; usage estimated too, so both axes at once.
    row('state-free-est', 4, {
      ...free,
      priceSource: 'listed',
      priceEstimated: true,
      usageEstimated: true,
      inputTokens: 912_345,
      outputTokens: 45_678,
    }),
    row('state-unpriced', 3, { cost: null, priceSource: null }), // `unpriced`
    row('state-speck', 2, { cost: 0.00004 }), // `<$0.0001`
    // `$0 · not billed`, the widest cost string of all.
    row('state-not-billed', 1, {
      status: 'error',
      cost: 0,
      billed: false,
      usageEstimated: true,
      priceSource: 'native_family',
      priceEstimated: true,
    }),
    ...client.requestRows,
  ];
}

// State-marks fixture (add-docked-inspector task 6.1), opt-in via `?marks=1` so the default
// harness stays byte-identical for every other suite. The default rows have escalated cascade
// requests but no settled batch item (`batchId` and `priceMode` are null on every one), so the
// newest row here carries BOTH marks — the escalated mark and the `batch` chip — the widest
// status cell the docked compact list can show, where both move from the Decided-by cell. A
// synthetic worst case (a batch item's decision is explicit in practice): it proves each mark
// is named exactly once in every form. A served row, so the inspector lights its trace.
if (params.get('marks') === '1') {
  const head = client.requestRows[0]!;
  client.requestRows = [
    {
      ...head,
      id: 'marks-batch-escalated',
      createdAt: new Date(Date.parse(head.createdAt) + 8000).toISOString(),
      status: 'success',
      decisionLayer: 'cascade',
      escalated: true,
      escalationSource: 'quality_gate',
      batchId: 'bj-marks',
      priceMode: 'batch',
      // Priced at the batch rate, so the inspector's receipt carries its provenance (the
      // "recorded at submission" caption and the `batch · bundled` source row).
      cost: 0.0042,
      inputPriceSnapshot: 0.75,
      outputPriceSnapshot: 3,
      priceSource: 'bundled',
      priceEstimated: false,
      durationMs: 2 * 3_600_000 + 7 * 60_000,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: null,
    },
    ...client.requestRows,
  ];
}

// Route-trace fixture (add-route-trace-inspector task 4.6), opt-in via `?trace=cascade` so the
// default harness stays byte-identical for every other suite. The longest route the trace can
// draw, as the newest row (so the first `button.req-row` opens it): an escalated cascade walk
// with a failed cheap-leg member carrying its markers, a skipped one, the superseded call with
// its score and an estimated attempt cost, a failed escalation member, and the served outcome
// on the long model id. Every label is wider than a 320px sheet's 248px text column, so the
// narrow sheet is measured with wrapped labels and Mono ids that must break rather than
// overflow. The agent and provider names are free text of up to 80 characters (the agent and
// provider DTOs' limit), here at that limit as one camel-case run with no break opportunity,
// wider than the 440px drawer's 368px text column too.
const TRACE_AGENT =
  'NightlySummariserBatchRunnerForTheEuropeanCustomerSupportTriageQueueProduction01';
const TRACE_PROVIDER =
  'AnthropicProductionEuWest1PrimaryAccountReservedCapacityForBatchSummariesTeam001';
if (params.get('trace') === 'cascade') {
  const head = client.requestRows[0]!;
  client.requestRows = [
    {
      ...head,
      id: 'trace-cascade',
      createdAt: new Date(Date.parse(head.createdAt) + 7000).toISOString(),
      agentLabel: TRACE_AGENT,
      providerLabel: TRACE_PROVIDER,
      status: 'fallback',
      decisionLayer: 'cascade',
      routingReason: `cascade cheap → quality_gate q=0.42 → strong ${LONG_MODEL}`,
      tierAssigned: 'default',
      escalated: true,
      escalationSource: 'quality_gate',
      qualitySignal: 0.42,
      attemptCostMicros: 3_100,
      cost: 0.012346,
      billed: true,
      priceSource: 'bundled',
      priceEstimated: true,
      usageEstimated: false,
      inputPriceSnapshot: 3,
      outputPriceSnapshot: 15,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'prov-0',
          model: 'meta-llama/llama-3.3-70b-instruct-turbo-free',
          kind: 'rate_limit',
          status: 429,
          dispatched: true,
          markers: ['rate_limit_exceeded', 'tokens_per_minute'],
          leg: 'cheap',
        },
        {
          // An Azure-style deployment name: user-chosen, often one camel-case run with no
          // break opportunity, wider than the sheet's 248px text column in Mono.
          index: 1,
          providerId: 'prov-1',
          model: 'azureGpt4oMiniEuWestProductionDeployment01',
          kind: 'unavailable',
          dispatched: false,
          leg: 'cheap',
        },
        {
          index: 0,
          providerId: 'prov-0',
          model: 'anthropic/claude-opus-4-1-20250805-thinking',
          kind: 'server_error',
          status: 503,
          dispatched: true,
          leg: 'escalation',
        },
      ],
    },
    // add-route-trace-cascade-legs (task 3.5): the second and third rows, so the first row stays
    // the longest route. An escalation whose cheap leg did not serve and left no record — a row
    // recorded before keep-cheap-leg-attempt-trail, which now keeps the cheap leg's trail on a
    // served escalation — whose two leg-row details must fit one line of a 320px sheet; and a
    // kept cheap answer whose passing verdict rides the served node's second line.
    {
      ...head,
      id: 'trace-cascade-unrecorded',
      createdAt: new Date(Date.parse(head.createdAt) + 6000).toISOString(),
      agentLabel: 'Lobechat',
      providerLabel: 'XiaomiMiMo',
      status: 'success',
      decisionLayer: 'cascade',
      routingReason:
        'cascade: escalated cheap→heavy; esc[capability_deferred ~z-ai/glm-latest(vision)] (q=0.00)',
      tierAssigned: 'heavy',
      escalated: true,
      escalationSource: 'cheap_error',
      qualitySignal: 0,
      attemptCostMicros: 0,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: null,
    },
    {
      ...head,
      id: 'trace-cascade-kept',
      createdAt: new Date(Date.parse(head.createdAt) + 5000).toISOString(),
      status: 'success',
      decisionLayer: 'cascade',
      routingReason: 'cascade: cheap served (q=0.87)',
      tierAssigned: 'default',
      escalated: false,
      escalationSource: null,
      qualitySignal: 0.87,
      attemptCostMicros: 0,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: null,
    },
    // keep-cheap-leg-attempt-trail (task 5.3): the fourth row is the same escalation as it
    // now records — the cheap call the cheap deadline cut off, on a long model id, and the
    // heavy tier served cleanly, so the row is still `success`.
    {
      ...head,
      id: 'trace-cascade-deadline',
      createdAt: new Date(Date.parse(head.createdAt) + 4000).toISOString(),
      agentLabel: 'Lobechat',
      providerLabel: 'XiaomiMiMo',
      status: 'success',
      decisionLayer: 'cascade',
      routingReason: 'cascade: escalated cheap→heavy (q=0.00)',
      tierAssigned: 'heavy',
      escalated: true,
      escalationSource: 'cheap_error',
      qualitySignal: 0,
      attemptCostMicros: 0,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'prov-0',
          model: 'meta-llama/llama-3.3-70b-instruct-turbo-free',
          kind: 'unavailable',
          dispatched: true,
          leg: 'cheap',
          stopReason: 'deadline',
        },
      ],
    },
    // record-route-legs (task 7.4): three rows that carry a route record, listed after the
    // deadline row so the four rows above keep their places. Their model ids are realistic, so
    // the layout suite holds each new row (a deferral, a clamped or stopping member, an escalation
    // row with its time) to at most two lines of the 320px sheet.
    //
    // The fifth row: an escalation whose cheap leg the cheap deadline ended at 30.02s, with a
    // deferral on each leg, the cut cheap call clamped, and the served member clamped too.
    {
      ...head,
      id: 'trace-cascade-deferral',
      createdAt: new Date(Date.parse(head.createdAt) + 3000).toISOString(),
      agentLabel: 'Lobechat',
      providerLabel: 'XiaomiMiMo',
      status: 'success',
      decisionLayer: 'cascade',
      // A short reason: this row measures the trace. (A real reason's capacity note, such as
      // `cheap[output_cap_deferred gemma2-9b-it(8192<100000)]`, is one unbroken run the Decision
      // section's reason row does not wrap at 320px: a separate, pre-existing layout gap.)
      routingReason: 'cascade: escalated cheap→heavy (q=0.00)',
      tierAssigned: 'heavy',
      escalated: true,
      escalationSource: 'cheap_error',
      qualitySignal: 0,
      attemptCostMicros: 0,
      durationMs: 38_890,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'prov-0',
          model: 'llama-3.1-8b-instant',
          kind: 'unavailable',
          dispatched: true,
          leg: 'cheap',
          stopReason: 'deadline',
        },
      ],
      routeLegs: [
        {
          leg: 'cheap',
          end: 'deadline',
          endedMs: 30_020,
          ask: 100_000,
          stopped: { index: 0, model: 'llama-3.1-8b-instant', sent: true },
          deferred: [
            { index: 1, model: 'gemma2-9b-it', reason: 'capability', capabilities: ['tools'] },
            { index: 1, model: 'gemma2-9b-it', reason: 'output_cap', cap: 8_192 },
          ],
          clamps: [{ index: 0, model: 'llama-3.1-8b-instant', to: 4_096 }],
        },
        {
          leg: 'escalation',
          end: 'served',
          endedMs: 38_100,
          servedIndex: 0,
          ask: 100_000,
          deferred: [
            { index: 1, model: 'gpt-4o-mini', reason: 'capability', capabilities: ['vision'] },
          ],
          clamps: [{ index: 0, model: LONG_MODEL, to: 16_384 }],
        },
      ],
    },
    // The sixth row: a cascade request whose cheap leg a non-retryable `policy_block` stopped at
    // its second member, so the outcome names no provider or model.
    {
      ...head,
      id: 'trace-cascade-stopped',
      createdAt: new Date(Date.parse(head.createdAt) + 2000).toISOString(),
      agentLabel: 'Lobechat',
      status: 'error',
      decisionLayer: 'cascade',
      routingReason: 'cascade: cheap stopped (policy_block@claude-3-5-haiku-latest)',
      tierAssigned: 'default',
      escalated: false,
      escalationSource: null,
      qualitySignal: null,
      attemptCostMicros: 0,
      durationMs: 1_900,
      errorKind: 'policy_block',
      errorStatus: 451,
      errorMessage: 'The request was blocked by the provider’s content policy.',
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'prov-0',
          model: 'llama-3.1-8b-instant',
          kind: 'rate_limit',
          status: 429,
          dispatched: true,
          leg: 'cheap',
        },
      ],
      routeLegs: [
        {
          leg: 'cheap',
          end: 'stopped',
          endedMs: 1_840,
          stopped: {
            index: 1,
            model: 'claude-3-5-haiku-latest',
            sent: true,
            kind: 'policy_block',
            status: 451,
          },
        },
      ],
    },
    // The seventh row: an escalation the client left while its clamped member was in flight.
    {
      ...head,
      id: 'trace-cascade-in-flight',
      createdAt: new Date(Date.parse(head.createdAt) + 1000).toISOString(),
      agentLabel: 'Lobechat',
      status: 'cancelled',
      decisionLayer: 'cascade',
      routingReason: 'cascade: escalated cheap→heavy (q=0.00)',
      tierAssigned: 'heavy',
      escalated: true,
      escalationSource: 'cheap_error',
      qualitySignal: 0,
      attemptCostMicros: 0,
      durationMs: 4_200,
      errorKind: null,
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'prov-0',
          model: 'llama-3.1-8b-instant',
          kind: 'server_error',
          status: 503,
          dispatched: true,
          leg: 'cheap',
        },
      ],
      routeLegs: [
        { leg: 'cheap', end: 'exhausted', endedMs: 2_450 },
        {
          leg: 'escalation',
          end: 'cancelled',
          endedMs: 4_190,
          ask: 100_000,
          stopped: { index: 0, model: 'claude-3-5-sonnet-latest', sent: true },
          clamps: [{ index: 0, model: 'claude-3-5-sonnet-latest', to: 8_192 }],
        },
      ],
    },
    ...client.requestRows,
  ];
}

// Costs-split fixture (adopt-design-tokens-v2 task 12.2), opt-in via `?costs=split` so the
// default harness stays byte-identical for every other suite. The range holds every figure the
// Costs readout strip can state at once — subscription value, an estimate-priced portion and
// spend from before subscription tracking — so the strip's narrow layout is measured with all
// three cells and the longest spend qualification, not with the spend cell alone.
if (params.get('costs') === 'split') {
  client.summaryResult = {
    ...client.summaryResult,
    subscriptionSpend: 48.1234,
    nativeFamilySpend: 3.4567,
    unknownSpend: 12.3456,
    estimatedCount: 1234,
  };
}

// Targets-matrix fixture (redesign-auto-routing-pipeline, task 7.2), opt-in via
// `?targets=1` so the default harness stays byte-identical for every other suite. It is
// the measured worst case for the matrix's `table-fit-targets` threshold: every cell
// state at once — a model target carrying the long model id, the long provider label and
// a price, a tier target with fallbacks, a shadowed duplicate, an unresolved scoped rule
// under a usable claim, an empty-tier claim and scoped band, and an API-created rule on
// an inert reserved row — over a catalog whose labels push every picker to its cap.
if (params.get('targets') === '1') {
  const pid = 'p-targets';
  client.providers = [
    {
      id: pid,
      name: LONG_PROVIDER,
      kind: 'api_key',
      protocol: 'anthropic',
      baseUrl: null,
      status: 'ok',
      maxTokensSpelling: 'auto',
      hasCredential: true,
      oauthPreset: null,
      credentialExpiresAt: null,
      credentialError: null,
      firstByteTimeoutMs: null,
      idleTimeoutMs: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      ...UNRECORDED_HEALTH,
    },
  ];
  const ids = [
    LONG_MODEL,
    'gpt-5-mini-2025-08-07',
    'deepseek-ai/deepseek-v4-0324-instruct-experimental-longcontext-preview-20260401',
  ];
  client.models = {
    [pid]: ids.map((externalModelId, i) => ({
      ...CHAIN_MODELS[i]!,
      id: `m-t${String(i)}`,
      providerId: pid,
      externalModelId,
    })),
  };
  const tier = (id: string, key: string) => ({
    id,
    key,
    displayName: null,
    description: null,
    createdAt: '2026-08-01T09:00:00.000Z',
  });
  client.tiers = [
    tier('tier-default', 'default'),
    tier('t-nightly', 'nightly-reprocessing'),
    tier('t-empty', 'empty-staging'),
  ];
  client.tierEntries = {
    't-nightly': ids.map((_, i) => ({
      id: `te-n${String(i)}`,
      tierId: 't-nightly',
      modelId: `m-t${String(i)}`,
      position: i,
      mode: 'any' as const,
      model: null,
    })),
    't-empty': [],
  };
  const rule = (
    id: string,
    matchType: 'auto_high' | 'auto_low' | 'auto_workload',
    workloadClass: string | null,
    target: string,
    priority = 0,
  ) => ({
    id,
    matchType,
    workloadClass,
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    target,
    priority,
    createdAt: '2026-08-01T09:00:00.000Z',
  });
  client.rules = [
    rule('g-high', 'auto_high', null, 'model:m-t0', 5),
    rule('g-high-dupe', 'auto_high', null, 'model:m-t1'),
    rule('g-low', 'auto_low', null, 'tier:nightly-reprocessing'),
    rule('code-claim', 'auto_workload', 'code', 'tier:nightly-reprocessing'),
    rule('code-high', 'auto_high', 'code', 'tier:retired-coding-tier', 5),
    rule('code-high-dupe', 'auto_high', 'code', 'tier:retired-coding-tier'),
    rule('vision-high', 'auto_high', 'vision', 'model:m-t0'),
    rule('structured-claim', 'auto_workload', 'structured', 'tier:empty-staging'),
    rule('structured-high', 'auto_high', 'structured', 'tier:empty-staging'),
    rule('research-claim', 'auto_workload', 'research', 'model:m-t0', 5),
    rule('research-claim-dupe', 'auto_workload', 'research', 'model:m-t1'),
  ];
}

// Client-identity fixture (allow-preset-client-identity task 8.5), opt-in via `?identity=1` so
// the default harness stays byte-identical for every other suite. One OAuth-connected
// subscription provider whose preset declares an identity, so its edit modal carries the
// imitation switch and the `confirm:clientIdentity` surface can be opened from it.
if (params.get('identity') === '1') {
  client.providers = [
    {
      id: 'p-identity',
      name: 'Fixture Plan',
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.fixture.example/v1',
      status: 'ok',
      maxTokensSpelling: 'auto',
      hasCredential: true,
      oauthPreset: 'stub-identity',
      credentialExpiresAt: '2026-11-07T09:00:00.000Z',
      credentialError: null,
      firstByteTimeoutMs: null,
      idleTimeoutMs: null,
      autoPruneUnlisted: true,
      imitateClientIdentity: false,
      clientIdentity: { label: 'Fixture Client' },
      createdAt: '2026-11-01T09:00:00.000Z',
      ...UNRECORDED_HEALTH,
    },
  ];
}

// Plan-pause fixture (classify-plan-quota-errors task 9.3), opt-in via `?pause=1` so the default
// harness stays byte-identical for every other suite. One key-preset subscription provider paused
// for `risk_control`, so its card carries the pause line and Resume now, and the
// `confirm:planCooldownResume` surface can be opened from it. The end is far ahead, so no expiry
// timer fires during a sweep.
if (params.get('pause') === '1') {
  client.providers = [
    {
      id: 'p-paused',
      name: 'Kimi Code',
      kind: 'subscription',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.kimi.com/coding/v1',
      status: 'ok',
      maxTokensSpelling: 'auto',
      hasCredential: true,
      oauthPreset: null,
      keyPreset: 'kimi-code',
      credentialExpiresAt: null,
      credentialError: null,
      firstByteTimeoutMs: null,
      idleTimeoutMs: null,
      autoPruneUnlisted: true,
      imitateClientIdentity: false,
      clientIdentity: null,
      createdAt: '2026-11-01T09:00:00.000Z',
      ...UNRECORDED_HEALTH,
      planCooldown: {
        kind: 'risk_control',
        until: new Date(Date.now() + 5 * 3_600_000).toISOString(),
        untilSource: 'default',
      },
    },
  ];
}

// Plan-usage fixture (add-subscription-quota-display task 7.4), opt-in via `?usage=1` so the
// default harness stays byte-identical for every other suite. Adversarial on purpose: a Claude plan
// whose line carries five windows, a scoped one, the billing phrase and a bucket with a 26-character
// name; a Kimi Code key plan with an unlabelled summary window and a Refresh usage button at rest;
// and a second key plan whose refresh is cooling down, so its text beside the button is on screen.
// Every reset is far ahead, so no timer fires during a sweep.
if (params.get('usage') === '1') {
  const hour = 3_600_000;
  const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
  const seen = at(-5 * 60_000);
  const win = (
    key: string,
    span: '5h' | 'daily' | 'weekly' | 'monthly' | 'annual' | null,
    usedPercent: number,
    resetMs: number,
    over: Record<string, unknown> = {},
  ) => ({
    key,
    group: 'account' as const,
    span,
    minutes: null,
    scope: null,
    usedPercent,
    resetAt: at(resetMs),
    observedAt: seen,
    source: 'traffic' as const,
    ...over,
  });
  const base = {
    kind: 'subscription',
    status: 'ok',
    maxTokensSpelling: 'auto',
    hasCredential: true,
    credentialError: null,
    firstByteTimeoutMs: null,
    idleTimeoutMs: null,
    autoPruneUnlisted: true,
    imitateClientIdentity: false,
    clientIdentity: null,
    createdAt: '2026-11-01T09:00:00.000Z',
    ...UNRECORDED_HEALTH,
  } as const;
  client.providers = [
    {
      ...base,
      id: 'p-usage-claude',
      name: 'Claude Max',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      oauthPreset: 'claude',
      credentialExpiresAt: at(8 * hour),
      planUsage: {
        windows: [
          win('account:5h', '5h', 100, 2 * hour),
          win('account:daily', 'daily', 64, 10 * hour),
          win('account:weekly', 'weekly', 31, 72 * hour),
          win('account:weekly:Fable', 'weekly', 12, 72 * hour, { scope: 'Fable' }),
          win('account:monthly', 'monthly', 8, 400 * 24 * hour),
          win('model:gpt_5_2_codex_sonic', null, 80, 5 * hour, {
            group: 'model',
            scope: 'gpt-5.2-codex-sonic-ex',
          }),
          win('model:other', null, 3, 9 * hour, { group: 'model', scope: 'other' }),
        ],
        billing: { state: 'extra_usage', observedAt: seen },
      },
      // add-subscription-usage-history: the Claude preset now declares a usage endpoint, so its
      // card offers Refresh usage and carries its graphs.
      planUsageRefresh: { availableAt: null },
    },
    {
      ...base,
      id: 'p-usage-kimi',
      name: 'Kimi Code',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.kimi.com/coding/v1',
      oauthPreset: null,
      keyPreset: 'kimi-code',
      credentialExpiresAt: null,
      planUsage: {
        windows: [
          win('account:m300', null, 40, 3 * hour, { minutes: 300 }),
          win('account:unsized', null, 22, 40 * 24 * hour),
        ],
        billing: null,
      },
      planUsageRefresh: { availableAt: null },
    },
    {
      ...base,
      id: 'p-usage-cooling',
      name: 'Z.ai GLM Coding Plan',
      protocol: 'openai_compatible',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      oauthPreset: null,
      keyPreset: 'zai-coding-plan',
      credentialExpiresAt: null,
      planUsage: { windows: [win('account:5h', '5h', 55, 4 * hour)], billing: null },
      planUsageRefresh: { availableAt: at(4 * 60_000) },
    },
  ];
  // add-subscription-usage-history: each card's graphs. Claude's 5h and weekly windows and one
  // model bucket have samples (the 5h one with an unknown reading, a gap); its other windows read
  // `no reading yet`. Kimi's 5-hour window has a lone reading between unknown ones (a dot). The
  // cooling Z.ai card has no sample at all, so it shows its window as the empty track.
  const series = (
    resetMs: number,
    lengthMs: number,
    stepMs: number,
    percents: readonly (number | null)[],
  ) => {
    const from = Date.now() + resetMs - lengthMs;
    return {
      from: new Date(from).toISOString(),
      resetAt: at(resetMs),
      samples: percents.map((usedPercent, i) => ({
        at: new Date(from + (i + 1) * stepMs).toISOString(),
        usedPercent,
        resetAt: at(resetMs),
      })),
    };
  };
  const rising = (n: number, to: number): (number | null)[] =>
    Array.from({ length: n }, (_, i) => Math.round(((i + 1) / n) * to));
  client.planUsageHistories = {
    'p-usage-claude': {
      windows: [
        {
          key: 'account:5h',
          group: 'account',
          span: '5h',
          minutes: 300,
          scope: null,
          label: '5h',
          ...series(2 * hour, 5 * hour, 15 * 60_000, [...rising(5, 60), null, ...rising(6, 100)]),
        },
        {
          key: 'account:weekly',
          group: 'account',
          span: 'weekly',
          minutes: 10_080,
          scope: null,
          label: 'weekly',
          ...series(72 * hour, 168 * hour, 6 * hour, rising(16, 31)),
        },
        {
          key: 'model:gpt_5_2_codex_sonic',
          group: 'model',
          span: null,
          minutes: null,
          scope: 'gpt-5.2-codex-sonic-ex',
          label: 'gpt-5.2-codex-sonic-ex',
          ...series(5 * hour, 168 * hour, 12 * hour, rising(10, 80)),
        },
      ],
    },
    'p-usage-kimi': {
      windows: [
        {
          key: 'account:m300',
          group: 'account',
          span: null,
          minutes: 300,
          scope: null,
          label: '5h window',
          ...series(3 * hour, 5 * hour, 15 * 60_000, [12, 18, 25, null, 33, null, 40, null]),
        },
      ],
    },
  };
}

// Paused-member trace fixture (classify-plan-quota-errors task 9.4), opt-in via `?trace=paused`: a
// request whose terminal member was skipped because its provider's plan was paused, so the route
// trace draws the pause label and the ERROR card names the pause. The default and `?trace=cascade`
// harnesses are untouched.
if (params.get('trace') === 'paused') {
  const head = client.requestRows[0]!;
  client.requestRows = [
    {
      ...head,
      id: 'trace-paused',
      createdAt: new Date(Date.parse(head.createdAt) + 7000).toISOString(),
      status: 'error',
      errorKind: 'quota_exhausted',
      errorStatus: null,
      errorMessage: null,
      errorRequestId: null,
      errorMarkers: null,
      attemptFailures: [
        {
          index: 0,
          providerId: 'prov-0',
          model: 'kimi-for-coding',
          kind: 'quota_exhausted',
          dispatched: false,
          terminal: true,
          skipReason: 'plan_cooldown',
        },
      ],
    },
    ...client.requestRows,
  ];
}

const store = createAppStore(client);
const host = document.getElementById('root');
if (!host) throw new Error('harness root missing');

// `live={false}` — no polling and no event stream. A layout suite must not race a timer.
render(
  () => (
    <AppProvider store={store}>
      <App live={false} />
    </AppProvider>
  ),
  host,
);

// Store handle for the overlay suite (phase2-responsive-overlays, task 9.1).
//
// Driving every overlay through the UI is not viable for an ENUMERATION: the six modal
// kinds are reached from six different pages behind buttons whose labels change, and a
// selector that silently matches nothing yields a test that passes without opening
// anything — which is exactly how a first pass at this measured only `newAgent` and
// concluded the modals were fine.
//
// Deliberately only on the harness, which the production build excludes
// (`rollupOptions.input`), so this cannot reach a shipped bundle. Assertions still run
// against the real rendered surface; this only decides WHICH surface is on screen.
(globalThis as unknown as { __harnessStore?: unknown }).__harnessStore = store;

// Signals readiness to Playwright. Waits for FONTS, not just a paint: Geist's metrics
// decide every height and wrap point in this suite, and measuring against the fallback
// face silently produces different numbers.
void document.fonts.ready.then(() => {
  document.documentElement.dataset['harnessReady'] = 'true';
});
