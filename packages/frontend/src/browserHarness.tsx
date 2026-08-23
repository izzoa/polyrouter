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
import { DEFAULT_AUTO_PERF, FakeApiClient } from './test/fakeClient';
import type { AdminInviteDto, AgentDto, AutoPerformance, WorkloadMix } from './data/api';
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
// (`— unpriced`), a free row (`$0` with no qualifier), an ordinary priced row,
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
    // null spend → a dash + "unpriced". Producer-reachable: the aggregation only
    // reports `spendUsd: null` when NOTHING is costable, i.e. every request is
    // unpriced (workload-mix.ts: costable = requests - unpricedRequests > 0 || …),
    // so all 5 requests must be unpriced. The numeric qualifier is suppressed when
    // spend is null, so this still renders exactly "— unpriced".
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
    // free (subscription/no-charge) → "$0" with NO qualifier, never "unpriced"
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
  if (which === 'boundary') return { ...DEFAULT_AUTO_PERF, workloadMix: BOUNDARY_WORKLOAD_MIX };
  if (which === 'attempt-only')
    return { ...DEFAULT_AUTO_PERF, workloadMix: ATTEMPT_ONLY_WORKLOAD_MIX };
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
const TIER_ENTRIES = ['claude-sonnet-4-5-20250929', 'gpt-5-mini-2025-08-07', 'llama-3.3-70b'].map(
  (externalModelId, i) => ({
    id: `te-${String(i)}`,
    tierId: 'tier-default',
    modelId: `m-${String(i)}`,
    position: i,
    model: {
      id: `m-${String(i)}`,
      providerId: 'p1',
      externalModelId,
      displayName: null,
    },
  }),
);

const autoPerf = workloadAutoPerf();
const client = new FakeApiClient({
  agents: AGENTS,
  adminUsers: ADMIN_USERS,
  adminInvites: INVITES,
  ...(params.get('chain') === '1' ? { tierEntries: { 'tier-default': TIER_ENTRIES } } : {}),
  ...(autoPerf ? { autoPerf } : {}),
});
if (client.session) client.session = { ...client.session, role, email: LONG_EMAIL };
// Keep the fake's own well-formed rows and lengthen only what drives overflow: a long
// model id and provider label are the realistic worst case for the requests table.
client.requestRows = client.requestRows.map((r) => ({
  ...r,
  modelLabel: LONG_MODEL,
  providerLabel: LONG_PROVIDER,
}));

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
