/**
 * Every destructive trigger carries the destructive ghost, and nothing else does
 * (adopt-red-destructive-actions task 5.3; dashboard-core "The destructive treatment marks only
 * destructive actions" and "The red fill appears only on a destructive commit").
 *
 * The source guards (`destructiveTreatment.test.ts`) read what the code says. This one reads
 * what the app renders: each surface is mounted on the test fake, put in the state that shows
 * its triggers, and each trigger is found by the label a user reads. Every destructive trigger
 * the requirement lists must carry `btn-ghost btn-ghost--destructive`; the recoverable actions
 * beside them (Edit, Test, Sync, Rotate key, Enable, Revoke, Revert to bundled and its Confirm
 * revert) must not. A trigger that is not found FAILS, naming itself and the state it should
 * render in, so the guard can never pass by not rendering it. And on each surface, every
 * destructive ghost on screen is one of the listed triggers, no button carries amber, and the
 * red fill is nowhere outside a confirmation.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type {
  AdminInviteDto,
  AdminUserDto,
  AgentDto,
  AutoLayers,
  BatchJobDto,
  BudgetDto,
  ChannelDto,
  ModelDto,
  ProviderDto,
  SemanticLearningStatus,
} from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import {
  DEFAULT_CALIBRATION,
  DEFAULT_SESSION,
  FakeApiClient,
  UNRECORDED_HEALTH,
} from './test/fakeClient';
import { labelText } from './test/labelText';
import { openAutoTab, openTuning } from './test/routingTabs';
import type { Page } from './types';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-09-24T12:00:00.000Z';

const AGENT: AgentDto = {
  id: 'a1',
  name: 'openclaw',
  harness: 'other',
  prefix: 'poly_abc',
  lastUsedAt: null,
  createdAt: NOW,
};

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

const mkModel = (id: string, over: Partial<ModelDto> = {}): ModelDto => ({
  id,
  providerId: PROVIDER.id,
  externalModelId: id,
  displayName: null,
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
  ...over,
});

/** A model the provider no longer lists (its Remove sits on its base row), one it still lists,
 * and an orphan batch twin with no base row (its Remove sits on its own row). */
const RETIRED = mkModel('gpt-5.4-mini', { unlistedSince: '2026-09-22T09:00:00.000Z' });
const OFFERED = mkModel('gpt-6-luna');
const ORPHAN = mkModel('vendor/gone:batch', {
  variant: 'batch',
  baseExternalModelId: null,
  unlistedSince: '2026-09-22T09:00:00.000Z',
});

const BUDGET: BudgetDto = {
  id: 'b1',
  name: 'monthly cap',
  scope: 'global',
  agentId: null,
  window: 'month',
  action: 'block',
  meteringBasis: 'cash',
  amount: 10,
  notifyChannelIds: [],
  enabled: true,
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

const user = (over: Partial<AdminUserDto> & { id: string; email: string }): AdminUserDto => ({
  name: over.email.split('@')[0] ?? '',
  role: null,
  disabled: false,
  createdAt: NOW,
  ...over,
});
/** The signed-in admin, an active member, and a disabled one. */
const USERS: AdminUserDto[] = [
  user({ id: DEFAULT_SESSION.userId, email: DEFAULT_SESSION.email, role: 'admin' }),
  user({ id: 'u2', email: 'bob@example.com' }),
  user({ id: 'u3', email: 'carol@example.com', disabled: true }),
];
const INVITE: AdminInviteDto = {
  id: 'i1',
  email: 'new@example.com',
  tokenPrefix: 'abcdef123456',
  createdAt: NOW,
  expiresAt: '2099-01-01T00:00:00.000Z',
  consumedAt: null,
};

const ACTIVE_JOB: BatchJobDto = {
  id: 'j1',
  upstreamBatchId: 'up-j1',
  status: 'in_progress',
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId: AGENT.id,
  providerId: PROVIDER.id,
  providerLabel: 'OpenRouter',
  modelId: 'm1',
  modelLabel: 'model-j1',
  tierAssigned: 'nightly',
  counts: { total: 50, completed: 12, failed: 0 },
  submittedAt: new Date(Date.now() - 3_600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  terminalAt: null,
  reservedCeilingMicros: 25_000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
};

/** Semantic learning on, with learned centroids active: the drawer offers Revert to bundled. */
const LAYERS: AutoLayers = {
  structural: true,
  cascade: true,
  structuralAvailable: true,
  cascadeAvailable: true,
  semantic: true,
  semanticAvailable: true,
  semanticLearning: true,
  semanticLearningAvailable: true,
  calibration: { ...DEFAULT_CALIBRATION },
};
const LEARNED: SemanticLearningStatus = {
  enabled: true,
  available: true,
  epoch: 1,
  generation: 2,
  source: 'learned',
  freshHigh: 5,
  freshLow: 12,
  lastAppliedAt: '2026-07-03T00:00:00.000Z',
  history: [],
};

/** One fake holding every surface's fixtures; each surface mounts its own app on a fresh one. */
const fake = (): FakeApiClient =>
  new FakeApiClient({
    agents: [AGENT],
    providers: [PROVIDER],
    models: { [PROVIDER.id]: [RETIRED, OFFERED, ORPHAN] },
    budgets: [BUDGET],
    channels: [CHANNEL],
    adminUsers: USERS,
    adminInvites: [INVITE],
    batchJobs: [ACTIVE_JOB],
    autoLayers: LAYERS,
    semanticLearningStatus: LEARNED,
    // `bodyCaptureStatus` keeps the fake's default, `available: true`, which renders the
    // body-capture card and its Purge all bodies.
  });

interface Mounted {
  host: HTMLElement;
  store: AppStore;
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  globalThis.history.replaceState(null, '', '/');
});

async function mountOn(page: Page): Promise<Mounted> {
  const store = createAppStore(fake());
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
  return { host, store };
}

/** Every button in `scope` whose visible label (or, for an icon-sized label, its accessible
 * name) is `label`. */
const buttons = (scope: ParentNode | null, label: string): HTMLButtonElement[] =>
  scope === null
    ? []
    : [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => labelText(b) === label || b.getAttribute('aria-label') === label,
      );
const main = (h: Mounted): HTMLElement | null => h.host.querySelector('main');
const drawer = (h: Mounted): HTMLElement | null => h.host.querySelector('#inspector-drawer');
const userRow = (h: Mounted, email: string): HTMLElement | null =>
  [...h.host.querySelectorAll<HTMLElement>('main tbody tr')].find(
    (r) => r.textContent?.includes(email) ?? false,
  ) ?? null;

interface Trigger {
  /** The label a user reads. */
  name: string;
  /** The state it renders in, named in the failure when it is not found. */
  state: string;
  find: (h: Mounted) => HTMLButtonElement[];
}

interface Surface {
  name: string;
  /** Mounts the surface and puts it in the state its triggers render in. */
  open: () => Promise<Mounted>;
  destructive: readonly Trigger[];
  neutral: readonly Trigger[];
}

/** Opens a provider card's model list, where a model's Remove renders. */
async function providersWithModels(): Promise<Mounted> {
  const h = await mountOn('providers');
  await h.store.loadModels(PROVIDER.id);
  await flush();
  buttons(main(h), 'Models')[0]?.click();
  await flush();
  return h;
}

/** Opens the inspector on a request with stored bodies, and shows them. */
async function inspectorWithPayload(): Promise<Mounted> {
  const h = await mountOn('requests');
  const row = h.store.state.requestList.find((r) => r.hasBodies);
  if (row !== undefined) h.store.select(row.id);
  await flush();
  buttons(drawer(h), 'Show bodies')[0]?.click();
  await flush();
  return h;
}

/** Opens the Semantic learning drawer; with `ask`, presses Revert to bundled so its inline
 * Confirm revert shows. */
async function learningDrawer(ask: boolean): Promise<Mounted> {
  const h = await mountOn('routing');
  await openAutoTab(h.host);
  const d = await openTuning(h.host, 'learning');
  if (ask) {
    buttons(d, 'Revert to bundled')[0]?.click();
    await flush();
  }
  return h;
}

const SURFACES: readonly Surface[] = [
  {
    name: 'Agents',
    open: () => mountOn('agents'),
    destructive: [
      { name: 'Delete', state: 'on a listed agent', find: (h) => buttons(main(h), 'Delete') },
    ],
    neutral: [
      {
        name: 'Rotate key',
        state: 'on a listed agent',
        find: (h) => buttons(main(h), 'Rotate key'),
      },
    ],
  },
  {
    name: 'Providers',
    open: providersWithModels,
    destructive: [
      {
        name: 'Delete',
        state: 'on a provider card',
        find: (h) => buttons(main(h), 'Delete'),
      },
      {
        name: 'Remove',
        state: 'on an unlisted model’s base row, its model list open',
        find: (h) =>
          buttons(main(h), `Remove ${RETIRED.externalModelId}`).filter(
            (b) => b.closest('[data-orphan-batch]') === null,
          ),
      },
      {
        name: 'Remove',
        state: 'on an unlisted orphan batch twin, its model list open',
        find: (h) =>
          buttons(
            h.host.querySelector(`[data-orphan-batch="${ORPHAN.externalModelId}"]`),
            `Remove ${ORPHAN.externalModelId}`,
          ),
      },
    ],
    neutral: [
      { name: 'Edit', state: 'on a provider card', find: (h) => buttons(main(h), 'Edit') },
      { name: 'Test', state: 'on a provider card', find: (h) => buttons(main(h), 'Test') },
      {
        name: 'Sync models',
        state: 'on a provider card',
        find: (h) => buttons(main(h), 'Sync models'),
      },
    ],
  },
  {
    name: 'Limits',
    open: () => mountOn('limits'),
    destructive: [
      { name: 'Delete', state: 'on a budget card', find: (h) => buttons(main(h), 'Delete') },
    ],
    neutral: [{ name: 'Edit', state: 'on a budget card', find: (h) => buttons(main(h), 'Edit') }],
  },
  {
    name: 'Settings',
    open: () => mountOn('settings'),
    destructive: [
      {
        name: 'Delete',
        state: 'on a notification channel',
        find: (h) => buttons(main(h), 'Delete'),
      },
      {
        name: 'Purge all bodies',
        state: 'on the body-capture card, capture available',
        find: (h) => buttons(main(h), 'Purge all bodies'),
      },
    ],
    neutral: [
      { name: 'Edit', state: 'on a notification channel', find: (h) => buttons(main(h), 'Edit') },
      {
        name: 'Send test',
        state: 'on a notification channel',
        find: (h) => buttons(main(h), 'Send test'),
      },
    ],
  },
  {
    name: 'Users',
    open: () => mountOn('users'),
    destructive: [
      {
        name: 'Delete',
        state: 'on every user’s row: the signed-in admin, an active and a disabled member',
        find: (h) =>
          [DEFAULT_SESSION.email, 'bob@example.com', 'carol@example.com'].flatMap((email) =>
            buttons(userRow(h, email), 'Delete'),
          ),
      },
      {
        name: 'Disable',
        state: 'on an active member’s row',
        find: (h) => buttons(userRow(h, 'bob@example.com'), 'Disable'),
      },
      {
        name: 'Disable',
        state: 'on the signed-in admin’s own row',
        find: (h) => buttons(userRow(h, DEFAULT_SESSION.email), 'Disable'),
      },
    ],
    neutral: [
      {
        name: 'Enable',
        state: 'on a disabled member’s row',
        find: (h) => buttons(userRow(h, 'carol@example.com'), 'Enable'),
      },
      {
        name: 'Revoke',
        state: 'on a pending invitation',
        find: (h) => buttons(userRow(h, INVITE.email), 'Revoke'),
      },
    ],
  },
  {
    name: 'Batches',
    open: () => mountOn('batches'),
    destructive: [
      {
        name: 'Cancel',
        state: 'on an active job',
        find: (h) => buttons(main(h), `Cancel batch on ${String(ACTIVE_JOB.modelLabel)}`),
      },
    ],
    neutral: [],
  },
  {
    name: 'the inspector',
    open: inspectorWithPayload,
    destructive: [
      {
        name: 'Delete',
        state: 'on the payload of a request with stored bodies, after Show bodies',
        find: (h) => buttons(drawer(h), 'Delete'),
      },
    ],
    neutral: [],
  },
  {
    name: 'Routing, the Semantic learning drawer',
    open: () => learningDrawer(false),
    destructive: [],
    neutral: [
      {
        name: 'Revert to bundled',
        state: 'with learned centroids active',
        find: (h) => buttons(h.host, 'Revert to bundled'),
      },
    ],
  },
  {
    name: 'Routing, the Semantic learning drawer asking to revert',
    open: () => learningDrawer(true),
    destructive: [],
    neutral: [
      {
        name: 'Confirm revert',
        state: 'after Revert to bundled was pressed',
        find: (h) => buttons(h.host, 'Confirm revert'),
      },
    ],
  },
];

const names = (ts: readonly Trigger[]): string =>
  ts.length === 0 ? 'none' : [...new Set(ts.map((t) => t.name))].join(', ');

describe('every destructive trigger carries the destructive ghost, and nothing else does (5.3)', () => {
  for (const s of SURFACES) {
    it(`${s.name}: destructive ${names(s.destructive)}; neutral ${names(s.neutral)}`, async () => {
      const h = await s.open();
      const listed = new Set<HTMLButtonElement>();

      for (const t of s.destructive) {
        const found = t.find(h);
        expect(found.length, `${s.name}: ${t.name} ${t.state} is not rendered`).toBeGreaterThan(0);
        for (const b of found) {
          listed.add(b);
          expect(
            b.classList.contains('btn-ghost') && b.classList.contains('btn-ghost--destructive'),
            `${s.name}: ${t.name} ${t.state} carries "${b.className}", not the destructive ghost`,
          ).toBe(true);
        }
      }

      for (const t of s.neutral) {
        const found = t.find(h);
        expect(found.length, `${s.name}: ${t.name} ${t.state} is not rendered`).toBeGreaterThan(0);
        for (const b of found) {
          expect(
            b.classList.contains('btn-ghost--destructive') ||
              b.classList.contains('btn-destructive'),
            `${s.name}: ${t.name} ${t.state} is recoverable, yet carries "${b.className}"`,
          ).toBe(false);
        }
      }

      // The destructive ghost appears only on a listed trigger: nothing else on screen wears it.
      const strays = [...h.host.querySelectorAll<HTMLButtonElement>('.btn-ghost--destructive')]
        .filter((b) => !listed.has(b))
        .map((b) => b.getAttribute('aria-label') ?? labelText(b));
      expect(strays, `${s.name}: destructive ghosts that are not destructive triggers`).toEqual([]);

      // No button carries amber, a status hue.
      expect(h.host.querySelector('.btn-ghost--amber'), `${s.name}: an amber button`).toBeNull();

      // The red fill is the commit of a destructive confirmation, and none is open here.
      const fills = [...h.host.querySelectorAll('.btn-destructive')].filter(
        (b) => b.closest('[role="dialog"].confirm-card') === null,
      );
      expect(
        fills.map((b) => labelText(b)),
        `${s.name}: the red fill outside a confirmation`,
      ).toEqual([]);
    });
  }
});
