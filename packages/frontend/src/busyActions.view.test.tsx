/**
 * Every busy button shows that it is working, and every button that unmounts on click is
 * gone while its request is pending (adopt-design-tokens-v2 task 4.4, design.md D14;
 * dashboard-core "A card action shows that it is working" and "A busy button keeps its
 * width").
 *
 * Data-driven from `test/busyActionsTable.ts`: every `busy` and `unmounts` row there must
 * have a scenario here, and every scenario a row, so neither list can drift from the other.
 *
 * Per busy row: the real App is mounted on a fake client, the surface is reached, every
 * client call is HELD pending, the button is clicked, and it must be natively `disabled`,
 * `aria-busy`, and showing its progressive label, with both labels still rendered in its one
 * grid cell and the inactive one `visibility: hidden` — the structure that keeps its width
 * (happy-dom does no layout, so the width itself is measured in `heightFamily.spec.ts`). The
 * request is then released and the button is back at rest (or, where its success removes
 * it, gone — stated per row, never inferred).
 *
 * A glyph-only control (the header rule's `×`) carries its progressive label in its
 * accessible name: its glyph, and so its width, never changes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import type {
  AdminInviteDto,
  AdminUserDto,
  AgentDto,
  BudgetDto,
  ChannelDto,
  ModelDto,
  ProviderDto,
  RequestRow,
} from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { BUSY_ACTIONS } from './test/busyActionsTable';
import {
  buildRequestRows,
  DEFAULT_PRICING_STATUS,
  DEFAULT_SESSION,
  FakeApiClient,
  UNRECORDED_HEALTH,
  type FakeOptions,
} from './test/fakeClient';
import type { Page } from './types';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
const NOW = '2026-11-01T12:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

// ── Fixtures: one tenant with something on every page ─────────────────────────────────────

const PROVIDER: ProviderDto = {
  id: 'p1',
  name: 'homelab-vllm',
  kind: 'custom',
  protocol: 'openai_compatible',
  baseUrl: 'https://1.1.1.1/v1',
  status: 'ok',
  maxTokensSpelling: 'auto',
  hasCredential: true,
  oauthPreset: null,
  credentialExpiresAt: null,
  credentialError: null,
  firstByteTimeoutMs: null,
  idleTimeoutMs: null,
  createdAt: NOW,
  ...UNRECORDED_HEALTH,
};
const MODEL: ModelDto = {
  id: 'm1',
  providerId: 'p1',
  externalModelId: 'qwen3-coder',
  displayName: 'Qwen3 Coder',
  contextWindow: 128000,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: null,
  outputPricePer1m: null,
  effectivePrice: null,
  listedPrice: null,
  variant: null,
  baseExternalModelId: null,
  batchCapable: false,
  batchEffectivePrice: null,
  lastSyncedAt: NOW,
  unlistedSince: null,
};
const AGENT: AgentDto = {
  id: 'a1',
  name: 'claude-code',
  harness: 'claude_code',
  prefix: 'poly_abcd',
  lastUsedAt: null,
  createdAt: NOW,
};
const CHANNEL: ChannelDto = {
  id: 'c1',
  name: 'homelab email',
  kind: 'smtp',
  enabled: true,
  eventsSubscribed: ['budget_alert'],
  hasConfig: true,
  lastTestAt: null,
  lastTestStatus: null,
};
const USERS: AdminUserDto[] = [
  {
    id: 'u1',
    email: 'admin@localhost',
    name: 'Admin',
    role: 'admin',
    disabled: false,
    createdAt: NOW,
  },
  { id: 'u2', email: 'bob@example.com', name: 'Bob', role: null, disabled: true, createdAt: NOW },
];
const INVITE: AdminInviteDto = {
  id: 'i1',
  email: 'new@example.com',
  tokenPrefix: 'abcdef123456',
  createdAt: NOW,
  expiresAt: FUTURE,
  consumedAt: null,
};
const BUDGET: BudgetDto = {
  id: 'b1',
  name: 'Monthly cap',
  scope: 'global',
  agentId: null,
  amount: 25,
  window: 'month',
  action: 'alert',
  enabled: true,
  notifyChannelIds: [],
  meteringBasis: 'cash',
  createdAt: NOW,
};
const ROWS: RequestRow[] = buildRequestRows(3).map((r, i) => ({ ...r, hasBodies: i === 0 }));

function baseOptions(): FakeOptions {
  return {
    session: DEFAULT_SESSION,
    agents: [AGENT],
    providers: [PROVIDER],
    models: { p1: [MODEL] },
    channels: [CHANNEL],
    adminUsers: USERS,
    adminInvites: [INVITE],
    budgets: [BUDGET],
    requestRows: ROWS,
    pricingStatus: {
      ...DEFAULT_PRICING_STATUS,
      scheduler: { ...DEFAULT_PRICING_STATUS.scheduler, modePermitted: true },
    },
    tiers: [
      { id: 'tier-default', key: 'default', displayName: null, description: null, createdAt: NOW },
      { id: 'tier-heavy', key: 'heavy', displayName: null, description: null, createdAt: NOW },
    ],
    rules: [
      {
        id: 'r1',
        matchType: 'header',
        workloadClass: null,
        headerName: 'x-polyrouter-tier',
        headerValue: 'heavy',
        target: 'tier:heavy',
        priority: 0,
        createdAt: NOW,
      },
    ],
  };
}

// ── Mounting and holding ──────────────────────────────────────────────────────────────────

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
}

let dispose: (() => void) | undefined;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
  // Destructive triggers ask natively today; nothing here should reach one.
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(page: Page, opts: Partial<FakeOptions> = {}): Promise<Harness> {
  globalThis.history.replaceState(null, '', `/#/${page}`);
  const fake = new FakeApiClient({ ...baseOptions(), ...opts });
  const store = createAppStore(fake);
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AppProvider store={store}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  store.go(page);
  await flush();
  return { host, store, fake };
}

/** Hold every client call pending until `release` — so whatever the click starts stays in
 * flight. Released calls run the real fake, so the store settles as it would in the app. */
function holdAll(fake: FakeApiClient): { held: () => number; release: () => Promise<void> } {
  const target = fake as unknown as Record<string, unknown>;
  const queue: (() => void)[] = [];
  const names = new Set<string>();
  for (
    let proto: object | null = Object.getPrototypeOf(fake) as object;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const n of Object.getOwnPropertyNames(proto)) {
      if (n !== 'constructor' && typeof target[n] === 'function') names.add(n);
    }
  }
  const originals = new Map<string, unknown>();
  for (const n of names) {
    const orig = target[n] as (...a: unknown[]) => unknown;
    originals.set(n, orig);
    target[n] = (...a: unknown[]) =>
      new Promise((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(() => orig.apply(fake, a))
            .then(resolve, reject);
        });
      });
  }
  return {
    held: () => queue.length,
    release: async () => {
      for (const n of names) delete target[n];
      for (const run of queue.splice(0)) run();
      await flush();
    },
  };
}

// ── Finding controls ──────────────────────────────────────────────────────────────────────

/** The label a reader sees on a button: its showing stacked label, or its own text. */
function shownLabel(b: HTMLElement): string {
  const cell = b.querySelector(':scope .stacked-label');
  if (!cell) return (b.textContent ?? '').trim();
  const items = [...cell.querySelectorAll<HTMLElement>(':scope > .stacked-label-item')];
  return items.find((i) => getComputedStyle(i).visibility !== 'hidden')?.textContent?.trim() ?? '';
}

/** A button in `scope` by the label it shows at rest. */
function byLabel(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => shownLabel(b) === label) ??
    null
  );
}
/** The scope a control lives in, or an empty fragment once that scope is gone (a modal a
 * successful save closed) — so a `find` after the request settles answers null, never
 * throws. */
const within = (h: Harness, sel: string): ParentNode =>
  h.host.querySelector(sel) ?? document.querySelector(sel) ?? document.createDocumentFragment();

// ── The scenarios ─────────────────────────────────────────────────────────────────────────

interface Scenario {
  page: Page;
  opts?: Partial<FakeOptions>;
  /** Reach the state the button lives in. */
  prepare?: (h: Harness) => Promise<void> | void;
  find: (h: Harness) => HTMLButtonElement | null;
  /** Busy rows: what the released request leaves — the button at rest, or gone. */
  settled?: 'rest' | 'gone';
  /** A glyph-only control: the busy label is in its accessible name. */
  glyph?: boolean;
}

const openModal = async (h: Harness, kind: Parameters<AppStore['openModal']>[0]): Promise<void> => {
  h.store.openModal(kind);
  await flush();
};

/** The open dialog whose accessible name is exactly `name`, or an empty fragment once it is
 * gone (a commit that succeeded closed it). */
const dialogNamed = (name: string): ParentNode =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (d) => d.getAttribute('aria-label') === name,
  ) ?? document.createDocumentFragment();

const SCENARIOS: Record<string, Scenario> = {
  // ── busy ──
  // The shared destructive confirmation's commit (adopt-red-destructive-actions D6), opened
  // from an agent's Delete: the trigger only opens it, and the commit carries the busy state.
  'components/ConfirmDialog.tsx settle': {
    page: 'agents',
    prepare: async (h) => {
      const trigger = [
        ...h.host.querySelectorAll<HTMLButtonElement>('main button.btn-ghost--destructive'),
      ].find((b) => shownLabel(b) === 'Delete');
      expect(trigger, 'the agent row’s Delete').toBeDefined();
      trigger!.focus();
      trigger!.click();
      await flush();
    },
    find: () => byLabel(dialogNamed('Delete agent "claude-code"?'), 'Delete agent'),
    settled: 'gone',
  },
  'components/Modals.tsx app.completeOauthConnect': {
    page: 'providers',
    prepare: async (h) => {
      await openModal(h, 'newProvider');
      h.store.setState('np', 'kind', 'sub');
      h.store.setState('ow', {
        presets: [{ id: 'chatgpt', displayName: 'ChatGPT' }],
        active: {
          preset: 'chatgpt',
          sessionId: 's1',
          authorizeUrl: 'https://auth.example/authorize',
          reauthorizeProviderId: null,
        },
        pasted: 'https://localhost/callback?code=abc&state=xyz',
      });
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Connect'),
    settled: 'gone',
  },
  'components/Modals.tsx app.createAgent': {
    page: 'agents',
    prepare: async (h) => {
      await openModal(h, 'newAgent');
      h.store.setState('na', 'name', 'reviewer');
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Create & mint key'),
    settled: 'gone',
  },
  'components/Modals.tsx app.startOauthConnect#1': {
    page: 'providers',
    prepare: async (h) => {
      await openModal(h, 'newProvider');
      h.store.setState('np', 'kind', 'sub');
      h.store.setState('ow', 'presets', [{ id: 'chatgpt', displayName: 'ChatGPT' }]);
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'ChatGPT'),
    settled: 'gone',
  },
  'components/Modals.tsx app.startOauthConnect#2': {
    page: 'providers',
    prepare: async (h) => {
      await openModal(h, 'newProvider');
      h.store.setState('np', 'kind', 'sub');
      h.store.setState('ow', 'presets', [
        { id: 'stub-identity', displayName: 'Fixture Plan', clientIdentity: { label: 'Fixture' } },
      ]);
      await flush();
      // A declaring preset opens its identity step first; the step's Continue is the button.
      byLabel(within(h, '.modal-card'), 'Fixture Plan')?.click();
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Continue to sign-in'),
    settled: 'gone',
  },
  'components/Modals.tsx app.addProvider': {
    page: 'providers',
    prepare: async (h) => {
      await openModal(h, 'newProvider');
      h.store.setState('np', { kind: 'custom', name: 'edge-vllm', baseUrl: 'https://2.2.2.2/v1' });
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Add provider'),
    settled: 'gone',
  },
  'components/Modals.tsx app.saveBudget': {
    page: 'limits',
    prepare: async (h) => {
      await openModal(h, 'newLimit');
      h.store.setState('bf', { name: 'Daily cap', amount: '5' });
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Create budget'),
    settled: 'gone',
  },
  'components/Modals.tsx app.saveChannel': {
    page: 'settings',
    prepare: async (h) => {
      await openModal(h, 'channel');
      h.store.setState('cf', {
        name: 'ops',
        kind: 'apprise',
        appriseUrls: 'ntfy://homelab/polyrouter',
      });
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Add channel'),
    settled: 'gone',
  },
  'pages/Agents.tsx app.rotateKey': {
    page: 'agents',
    find: (h) => byLabel(h.host, 'Rotate key'),
    settled: 'rest',
  },
  'pages/Providers.tsx props.onSave#1': {
    page: 'providers',
    prepare: async (h) => {
      byLabel(h.host, 'Models')?.click();
      await flush();
      const free = h.host.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(free, 'the price editor’s Free checkbox').not.toBeNull();
      free!.click();
      await flush();
    },
    find: (h) => byLabel(h.host, 'Save price'),
    settled: 'rest',
  },
  'pages/Providers.tsx props.onSave#2': {
    page: 'providers',
    prepare: async (h) => {
      byLabel(h.host, 'Models')?.click();
      await flush();
      for (const [label, value] of [
        ['Input price per 1M tokens (USD)', '1'],
        ['Output price per 1M tokens (USD)', '2'],
      ] as const) {
        const input = h.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
        expect(input, label).not.toBeNull();
        input!.value = value;
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await flush();
    },
    find: (h) => byLabel(h.host, 'Save price'),
    settled: 'rest',
  },
  'pages/Providers.tsx app.testProviderById': {
    page: 'providers',
    find: (h) => byLabel(h.host, 'Test'),
    settled: 'rest',
  },
  'pages/Providers.tsx app.syncProvider': {
    page: 'providers',
    find: (h) => byLabel(h.host, 'Sync models'),
    settled: 'rest',
  },
  'pages/Requests.tsx app.loadRequests#4': {
    page: 'requests',
    prepare: async (h) => {
      h.store.setState('requestCursor', 'cursor-2');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Load more'),
    settled: 'gone',
  },
  'pages/Limits.tsx app.requestAggregateRefresh': {
    page: 'limits',
    prepare: async (h) => {
      // A refresh that failed over recorded progress: the progress stays, marked stale,
      // with its Retry beside it.
      h.store.setState('budgetProgress', 'b1', 'error', 'progress unavailable');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Retry progress'),
    settled: 'gone',
  },
  'pages/Routing.tsx app.retryRulesReconcile': {
    page: 'routing',
    prepare: async (h) => {
      h.store.setRoutingSection('auto');
      await flush();
      h.store.setState('bt', 'unverified', true);
      await flush();
    },
    find: (h) => byLabel(within(h, '[data-testid="targets-unverified"]'), 'Retry'),
    settled: 'gone',
  },
  'pages/Routing.tsx clear': {
    page: 'routing',
    opts: {
      rules: [
        {
          id: 'g-high',
          matchType: 'auto_high',
          workloadClass: null,
          headerName: 'x-polyrouter-tier',
          headerValue: null,
          target: 'tier:heavy',
          priority: 0,
          createdAt: NOW,
        },
      ],
    },
    prepare: async (h) => {
      h.store.setRoutingSection('auto');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Clear'),
    settled: 'gone',
  },
  'pages/Routing.tsx cleanUp': {
    page: 'routing',
    opts: {
      rules: [
        {
          id: 'g-high',
          matchType: 'auto_high',
          workloadClass: null,
          headerName: 'x-polyrouter-tier',
          headerValue: null,
          target: 'tier:heavy',
          priority: 5,
          createdAt: NOW,
        },
        {
          id: 'g-high-dupe',
          matchType: 'auto_high',
          workloadClass: null,
          headerName: 'x-polyrouter-tier',
          headerValue: null,
          target: 'tier:default',
          priority: 0,
          createdAt: NOW,
        },
      ],
    },
    prepare: async (h) => {
      h.store.setRoutingSection('auto');
      await flush();
    },
    find: (h) => byLabel(h.host, 'clean up'),
    settled: 'gone',
  },
  'pages/Routing.tsx app.deleteTier': {
    page: 'routing',
    find: (h) => h.host.querySelector<HTMLButtonElement>('button[aria-label="Delete tier heavy"]'),
    settled: 'gone',
  },
  'pages/Routing.tsx app.deleteRule': {
    page: 'routing',
    find: (h) => h.host.querySelector<HTMLButtonElement>('button[aria-label^="Delete rule heavy"]'),
    settled: 'gone',
    glyph: true,
  },
  'pages/Routing.tsx app.createRule': {
    page: 'routing',
    prepare: async (h) => {
      h.store.setState('rf', { value: 'light', target: 'heavy' });
      await flush();
    },
    find: (h) => byLabel(within(h, '[data-testid="header-rule-form"]'), 'Add'),
    settled: 'rest',
  },
  'pages/Routing.tsx app.createTier': {
    page: 'routing',
    prepare: async (h) => {
      h.store.setState('tf', 'key', 'nightly');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Add tier'),
    settled: 'rest',
  },
  'pages/Settings.tsx app.testChannelById': {
    page: 'settings',
    find: (h) => byLabel(h.host, 'Send test'),
    settled: 'rest',
  },
  'pages/Settings.tsx app.runPricingRefresh': {
    page: 'settings',
    find: (h) => byLabel(h.host, 'Refresh now'),
    settled: 'rest',
  },
  'pages/Settings.tsx app.loadPricingStatus#2': {
    page: 'settings',
    prepare: async (h) => {
      h.store.setState('pc', 'loadError', 'pricing status unavailable');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Retry'),
    settled: 'gone',
  },
  'pages/Setup.tsx app.obCreateAgent': {
    page: 'setup',
    prepare: async (h) => {
      h.store.setState('ob', 'name', 'reviewer');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Create agent & mint key'),
    settled: 'gone',
  },
  'pages/Setup.tsx app.obConnectProvider': {
    page: 'setup',
    prepare: async (h) => {
      h.store.obGo(2);
      h.store.setState('ob', 'prov', {
        ...h.store.state.ob.prov,
        kind: 'custom',
        name: 'edge-vllm',
        baseUrl: 'https://2.2.2.2/v1',
      });
      await flush();
    },
    find: (h) => byLabel(h.host, 'Connect provider & sync models'),
    settled: 'gone',
  },
  'pages/Setup.tsx app.obVerify': {
    page: 'setup',
    prepare: async (h) => {
      h.store.setState('ob', 'key', 'poly_test_key');
      h.store.obGo(3);
      await flush();
    },
    find: (h) => byLabel(h.host, 'Send test request'),
    settled: 'gone',
  },
  'pages/Users.tsx app.uaSetRegistration': {
    page: 'users',
    // The fake's registration is open sign-up, so Invite only is the one that writes.
    find: (h) => byLabel(h.host, 'Invite only'),
    settled: 'rest',
  },
  'pages/Users.tsx app.uaCreateInvite': {
    page: 'users',
    prepare: async (h) => {
      h.store.setState('ua', 'inviteEmail', 'carol@example.com');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Invite'),
    settled: 'rest',
  },
  'pages/Users.tsx app.uaRevokeInvite': {
    page: 'users',
    find: (h) => byLabel(h.host, 'Revoke'),
    settled: 'gone',
  },
  'pages/Users.tsx app.uaSetRole': {
    page: 'users',
    find: (h) => byLabel(h.host, 'Make admin'),
    settled: 'gone',
  },
  'pages/Users.tsx app.uaSetDisabled': {
    page: 'users',
    find: (h) => byLabel(h.host, 'Enable'),
    settled: 'gone',
  },

  // ── unmounts on click ──
  'App.tsx app.retry': {
    page: 'overview',
    opts: { meFailure: new ApiError(503, 'unavailable', 'down') },
    find: (h) => byLabel(h.host, 'Retry'),
  },
  'components/BodyCaptureCard.tsx app.setBodyCaptureMode#2': {
    page: 'settings',
    prepare: async (h) => {
      const radios = h.host.querySelectorAll<HTMLInputElement>('input[name="bc-mode"]');
      radios[2]?.click();
      await flush();
    },
    find: () =>
      byLabel(
        document.querySelector('[aria-label="Confirm body capture"]') ?? document,
        'Capture bodies',
      ),
  },
  'components/Inspector.tsx app.loadSelectedBodies': {
    page: 'requests',
    prepare: async (h) => {
      h.store.select(ROWS[0]!.id);
      await flush();
    },
    find: (h) => byLabel(h.host, 'Show bodies'),
  },
  'components/Modals.tsx app.startOauthReauthorize#1': {
    page: 'providers',
    prepare: async (h) => {
      await openModal(h, 'newProvider');
      h.store.setState('np', 'kind', 'sub');
      h.store.setState('ow', {
        reconnect: { providerId: 'p1', name: 'homelab-vllm' },
        active: null,
        busy: false,
        error: 'the sign-in did not start',
      });
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Try again'),
  },
  'components/Modals.tsx app.startOauthReauthorize#2': {
    page: 'providers',
    opts: {
      providers: [{ ...PROVIDER, kind: 'subscription', oauthPreset: 'chatgpt' }],
    },
    prepare: async (h) => {
      h.store.openEditProvider(h.store.state.providers[0]!);
      await flush();
    },
    find: (h) => byLabel(within(h, '.modal-card'), 'Reconnect'),
  },
  'pages/Agents.tsx app.loadAgentStats#2': {
    page: 'agents',
    opts: { agents: [AGENT], analyticsFailure: new ApiError(500, 'internal', 'analytics down') },
    find: (h) => byLabel(h.host, 'Retry'),
  },
  'pages/Costs.tsx app.loadCosts#2': {
    page: 'costs',
    opts: { analyticsFailure: new ApiError(500, 'internal', 'analytics down') },
    find: (h) => byLabel(h.host, 'Retry'),
  },
  'pages/Overview.tsx app.loadOverview#2': {
    page: 'overview',
    opts: { analyticsFailure: new ApiError(500, 'internal', 'analytics down') },
    // The page's notice comes first; the agent strip's own Retry sits in the strip below it.
    find: (h) => byLabel(h.host, 'Retry'),
  },
  'pages/Overview.tsx app.loadAgentStrip#2': {
    page: 'overview',
    opts: { analyticsFailure: new ApiError(500, 'internal', 'analytics down') },
    find: (h) => byLabel(within(h, '[data-testid="agent-strip"]'), 'Retry'),
  },
  'pages/Requests.tsx app.loadRequests#2': {
    page: 'requests',
    prepare: async (h) => {
      h.store.setState('requestListError', 'requests unavailable');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Retry'),
  },
  'pages/Requests.tsx app.loadRequests#3': {
    page: 'requests',
    prepare: async (h) => {
      h.store.setState({
        requestsPaged: true,
        requestsNew: { count: 3, atLeast: false, unknown: false },
      });
      await flush();
    },
    find: (h) =>
      [...h.host.querySelectorAll<HTMLButtonElement>('[role="status"] button.btn-ghost')][0] ??
      null,
  },
  'pages/Routing.tsx app.retryAutoPerf': {
    page: 'routing',
    prepare: async (h) => {
      h.store.setRoutingSection('auto');
      await flush();
      h.store.setState('autoPerf', {
        data: null,
        loaded: true,
        error: 'auto performance unavailable',
      });
      await flush();
    },
    find: (h) => byLabel(h.host, 'Retry'),
  },
  'pages/Routing.tsx app.loadRouting#2': {
    page: 'routing',
    prepare: async (h) => {
      h.store.setState('routingError', 'routing unavailable');
      await flush();
    },
    find: (h) => byLabel(h.host, 'Retry'),
  },
};

describe('every busy and unmounts row has a scenario, and every scenario a row', () => {
  it('the scenario list and the table agree', () => {
    const walked = BUSY_ACTIONS.filter((r) => r.cls === 'busy' || r.cls === 'unmounts').map(
      (r) => r.key,
    );
    expect(Object.keys(SCENARIOS).sort()).toEqual([...walked].sort());
  });
});

describe('a busy button shows that it is working, at its width (D14)', () => {
  for (const row of BUSY_ACTIONS.filter((r) => r.cls === 'busy')) {
    const sc = SCENARIOS[row.key];
    it(row.key, async () => {
      expect(sc, `${row.key} has no scenario`).toBeDefined();
      const h = await mount(sc!.page, sc!.opts);
      await sc!.prepare?.(h);
      const button = sc!.find(h);
      expect(button, `${row.key}: the button is not rendered`).not.toBeNull();
      const rest = shownLabel(button!);
      expect(button!.disabled, `${row.key}: disabled at rest`).toBe(false);

      const hold = holdAll(h.fake);
      button!.click();
      await flush();
      expect(hold.held(), `${row.key}: the click started no request`).toBeGreaterThan(0);
      expect(button!.disabled, `${row.key}: natively disabled while in flight`).toBe(true);
      expect(button!.getAttribute('aria-busy'), `${row.key}: aria-busy`).toBe('true');
      if (sc!.glyph === true) {
        expect(button!.getAttribute('aria-label') ?? '', `${row.key}: busy name`).toContain(
          row.busyLabel ?? '',
        );
        expect(shownLabel(button!), `${row.key}: the glyph does not change`).toBe(rest);
      } else {
        expect(shownLabel(button!), `${row.key}: the busy label shows`).toBe(row.busyLabel);
        const items = [
          ...button!.querySelectorAll<HTMLElement>('.stacked-label > .stacked-label-item'),
        ];
        expect(
          items.map((i) => i.textContent?.trim()),
          `${row.key}: both labels stay`,
        ).toEqual([rest, row.busyLabel]);
        for (const i of items) expect(getComputedStyle(i).gridArea).toMatch(/^1 \/ 1/);
        expect(getComputedStyle(items[0]!).visibility, `${row.key}: rest label hidden`).toBe(
          'hidden',
        );
      }

      await hold.release();
      const after = sc!.find(h);
      if (sc!.settled === 'gone' && after === null) return;
      expect(after, `${row.key}: the button left (settled: ${sc!.settled ?? ''})`).not.toBeNull();
      expect(after!.disabled, `${row.key}: enabled again`).toBe(false);
      expect(after!.getAttribute('aria-busy'), `${row.key}: no longer busy`).toBeNull();
      expect(shownLabel(after!), `${row.key}: back at rest`).not.toBe(row.busyLabel);
      if (sc!.settled === 'rest') expect(shownLabel(after!)).toBe(rest);
    });
  }
});

describe('a button that unmounts on click is gone while its request is pending', () => {
  for (const row of BUSY_ACTIONS.filter((r) => r.cls === 'unmounts')) {
    const sc = SCENARIOS[row.key];
    it(row.key, async () => {
      expect(sc, `${row.key} has no scenario`).toBeDefined();
      const h = await mount(sc!.page, sc!.opts);
      await sc!.prepare?.(h);
      const button = sc!.find(h);
      expect(button, `${row.key}: the button is not rendered`).not.toBeNull();
      const hold = holdAll(h.fake);
      button!.click();
      await flush();
      expect(hold.held(), `${row.key}: the click started no request`).toBeGreaterThan(0);
      expect(button!.isConnected, `${row.key}: the button is still mounted`).toBe(false);
      await hold.release();
    });
  }
});

// ── A busy action holds through its whole request, and hands focus back ───────────────────

describe("a provider card's Sync models is busy until its whole sync settles (D14)", () => {
  it('stays disabled through the provider reload until the models load, on the same card', async () => {
    const h = await mount('providers');
    const sync = byLabel(h.host, 'Sync models');
    expect(sync, 'the card renders Sync models').not.toBeNull();
    // The sync and the provider reload answer; the model list it then loads is held.
    let releaseModels: () => void = () => undefined;
    const models = new Promise<void>((r) => {
      releaseModels = r;
    });
    const listModels = h.fake.listModels.bind(h.fake);
    h.fake.listModels = (id?: string) => models.then(() => listModels(id));
    sync!.click();
    await flush();
    expect(h.fake.calls).toContain('listProviders');
    // The reload rewrote the providers, and the card — with its busy button — is still there.
    expect(sync!.isConnected, 'the reload re-created the card').toBe(true);
    expect(sync!.disabled, 'Sync models is enabled while its models still load').toBe(true);
    expect(shownLabel(sync!)).toBe('Syncing…');
    releaseModels();
    await flush();
    expect(sync!.disabled).toBe(false);
    expect(shownLabel(sync!)).toBe('Sync models');
  });
});

describe('a busy button that survives its request gets keyboard focus back (D14)', () => {
  // Native `disabled` drops a focused button's focus to <body> in a real browser (the focus
  // fixup). happy-dom runs no fixup and will not blur a disabled button, so each case leaves
  // focus on <body> the one way happy-dom allows — focus a scratch field, then remove it —
  // exactly where the browser's fixup would.
  const fixup = (b: HTMLButtonElement): void => {
    expect(b.disabled, 'the button is natively disabled while busy').toBe(true);
    const scratch = document.createElement('input');
    document.body.append(scratch);
    scratch.focus();
    scratch.remove();
    expect(document.activeElement).toBe(document.body);
  };

  it("a Users row's Make admin, on its failure path (createBusyMap)", async () => {
    const h = await mount('users');
    h.fake.adminSetRoleFailure = 'cannot change this account';
    const button = byLabel(h.host, 'Make admin');
    expect(button).not.toBeNull();
    const hold = holdAll(h.fake);
    button!.focus();
    button!.click();
    await flush();
    fixup(button!);
    await hold.release();
    expect(button!.isConnected, 'the row survived the failure').toBe(true);
    expect(document.activeElement, 'focus is back on Make admin').toBe(button);
  });

  it("a provider card's Test, on its failure path (createBusy)", async () => {
    const h = await mount('providers');
    h.fake.testResult = { ok: false, status: 'error', message: '401 from upstream', traceId: 't' };
    const button = byLabel(h.host, 'Test');
    expect(button).not.toBeNull();
    const hold = holdAll(h.fake);
    button!.focus();
    button!.click();
    await flush();
    fixup(button!);
    await hold.release();
    expect(button!.isConnected, 'the card survived the provider reload').toBe(true);
    expect(document.activeElement, 'focus is back on Test').toBe(button);
  });

  it('focus the user moved elsewhere meanwhile is never taken back', async () => {
    const h = await mount('providers');
    const button = byLabel(h.host, 'Test');
    const hold = holdAll(h.fake);
    button!.focus();
    button!.click();
    await flush();
    fixup(button!);
    const elsewhere = byLabel(h.host, 'Sync models');
    elsewhere!.focus();
    await hold.release();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("a notice's busy action (the Targets Retry's path), when its request settles", async () => {
    const { Notice } = await import('./components/Notice');
    const { createSignal } = await import('solid-js');
    const [busy, setBusy] = createSignal(false);
    const host = document.createElement('div');
    document.body.appendChild(host);
    dispose = render(
      () => (
        <Notice
          tone="caution"
          title="Unverified"
          action={{
            label: 'Retry',
            busyLabel: 'Retrying…',
            busy: busy(),
            onClick: () => setBusy(true),
          }}
        >
          Last loaded targets.
        </Notice>
      ),
      host,
    );
    const button = host.querySelector<HTMLButtonElement>('button.notice-action')!;
    button.focus();
    button.click();
    await flush();
    fixup(button);
    setBusy(false);
    await flush();
    expect(document.activeElement, 'focus is back on Retry').toBe(button);
  });
});
