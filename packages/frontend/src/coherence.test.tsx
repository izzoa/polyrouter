/**
 * Destructive actions are consistent and confirmed (dashboard-core; adopt-red-destructive-actions
 * task 4.1, design.md D6 / D7 / D8).
 *
 * Delete on an agent, a provider, a budget and a notification channel asks first in the ONE
 * shared dashboard dialog, never the browser's native prompt, and each trigger carries the
 * destructive ghost. These tests drive that dialog as a user would: they open it from the real
 * page, decline and accept it, and fail the request behind it. `confirm` is stubbed only to prove
 * it is never called — a test that answered it would pass whatever the page did.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import type { AgentDto, BudgetDto, ChannelDto, ProviderDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient, UNRECORDED_HEALTH, type FakeOptions } from './test/fakeClient';
import { labelText } from './test/labelText';
import type { Page } from './types';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

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
  createdAt: new Date(2026, 0, 1).toISOString(),
};

const AGENT: AgentDto = {
  id: 'a1',
  name: 'openclaw',
  harness: 'other',
  prefix: 'poly_abc',
  lastUsedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
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
  createdAt: new Date(2026, 0, 1).toISOString(),
  ...UNRECORDED_HEALTH,
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  client: FakeApiClient;
  dispose: () => void;
}

async function mount(opts: FakeOptions, page: Page): Promise<Harness> {
  const client = new FakeApiClient(opts);
  const store = createAppStore(client);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
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
  return {
    host,
    store,
    client,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

/** The page's own Delete: the destructive ghost labelled `Delete`. */
function deleteTrigger(h: Harness): HTMLButtonElement {
  const btn = [
    ...h.host.querySelectorAll<HTMLButtonElement>('main button.btn-ghost--destructive'),
  ].find((b) => labelText(b) === 'Delete');
  expect(btn, 'the page renders no destructive Delete').toBeDefined();
  return btn!;
}

/** The open shared confirmation, or null. It is mounted at the shell, outside `main`. */
const dialogOf = (h: Harness): HTMLElement | null =>
  h.host.querySelector<HTMLElement>('[role="dialog"].confirm-card');

/** Activate the trigger from the keyboard's point of view: focused, then clicked. */
async function openFrom(h: Harness, trigger: HTMLButtonElement): Promise<HTMLElement> {
  trigger.focus();
  trigger.click();
  await flush();
  const dialog = dialogOf(h);
  expect(dialog, 'Delete opened no dashboard dialog').not.toBeNull();
  return dialog!;
}

const buttons = (dialog: HTMLElement): HTMLButtonElement[] => [
  ...dialog.querySelectorAll<HTMLButtonElement>('button'),
];
const commitOf = (dialog: HTMLElement): HTMLButtonElement =>
  dialog.querySelector<HTMLButtonElement>('button.btn-destructive')!;

/** The page itself, without the dialog: what a reader sees still listed. */
const pageText = (h: Harness): string => h.host.querySelector('main')?.textContent ?? '';

interface Site {
  name: string;
  page: Page;
  opts: FakeOptions;
  /** The fake client method the commit calls. */
  method: 'deleteAgent' | 'deleteProvider' | 'deleteBudget' | 'deleteChannel';
  /** The resource's name, as the page lists it. */
  resource: string;
  title: string;
  body: string;
  commit: string;
}

const SITES: Site[] = [
  {
    name: 'an agent',
    page: 'agents',
    opts: { agents: [AGENT] },
    method: 'deleteAgent',
    resource: 'openclaw',
    title: 'Delete agent "openclaw"?',
    body: 'New requests with its key will be refused.',
    commit: 'Delete agent',
  },
  {
    name: 'a provider',
    page: 'providers',
    opts: { providers: [PROVIDER] },
    method: 'deleteProvider',
    resource: 'homelab-vllm',
    title: 'Delete provider "homelab-vllm"?',
    body: 'Its models and routing entries go too.',
    commit: 'Delete provider',
  },
  {
    name: 'a budget',
    page: 'limits',
    opts: { budgets: [BUDGET] },
    method: 'deleteBudget',
    resource: 'monthly cap',
    title: 'Delete budget "monthly cap"?',
    body: 'New requests will no longer be enforced by it.',
    commit: 'Delete budget',
  },
  {
    name: 'a notification channel',
    page: 'settings',
    opts: { channels: [CHANNEL] },
    method: 'deleteChannel',
    resource: 'homelab email',
    title: 'Delete channel "homelab email"?',
    body: 'Future alerts will no longer be delivered to it.',
    commit: 'Delete channel',
  },
];

describe('destructive actions are confirmed in the shared dialog (dashboard-core coherence)', () => {
  let nativeConfirm: MockInstance<(message?: string) => boolean>;

  afterEach(() => {
    // The browser's prompt is never the confirmation (adopt-red-destructive-actions D6).
    expect(nativeConfirm, 'the native confirm prompt was shown').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  const stubConfirm = (): void => {
    nativeConfirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
  };

  for (const site of SITES) {
    describe(`Delete on ${site.name}`, () => {
      it('names the resource and the consequence, puts Cancel first, and commits with the verb', async () => {
        stubConfirm();
        const h = await mount(site.opts, site.page);
        try {
          const dialog = await openFrom(h, deleteTrigger(h));
          expect(dialog.getAttribute('aria-label')).toBe(site.title);
          expect(dialog.querySelector('.section-title')?.textContent).toBe(site.title);
          expect(dialog.textContent).toContain(site.body);
          const [first, ...rest] = buttons(dialog);
          expect(labelText(first!)).toBe('Cancel');
          expect(document.activeElement, 'Cancel holds the initial focus').toBe(first);
          expect(labelText(rest[rest.length - 1]!)).toBe(site.commit);
          expect(commitOf(dialog).className).toBe('btn-destructive');
          expect(
            dialog.querySelector('.btn-primary'),
            'an indigo primary in the dialog',
          ).toBeNull();
        } finally {
          h.dispose();
        }
      });

      it('declining sends no delete and keeps the resource', async () => {
        stubConfirm();
        const h = await mount(site.opts, site.page);
        try {
          const trigger = deleteTrigger(h);
          const dialog = await openFrom(h, trigger);
          buttons(dialog)[0]!.click();
          await flush();
          expect(dialogOf(h)).toBeNull();
          expect(h.client.countOf(site.method)).toBe(0);
          expect(pageText(h)).toContain(site.resource);
          expect(document.activeElement, 'focus returns to the trigger').toBe(trigger);
        } finally {
          h.dispose();
        }
      });

      it('accepting sends exactly one delete, however often the commit is pressed', async () => {
        stubConfirm();
        const h = await mount(site.opts, site.page);
        try {
          const dialog = await openFrom(h, deleteTrigger(h));
          const commit = commitOf(dialog);
          commit.click();
          commit.click();
          await flush();
          expect(h.client.countOf(site.method)).toBe(1);
          expect(dialogOf(h)).toBeNull();
          expect(pageText(h)).not.toContain(site.resource);
          // The row and its Delete are gone: focus lands on the page title (D8), never the body.
          // happy-dom focuses any element; a browser focuses only a focusable one, so the
          // landing spot must carry `tabindex="-1"` to be reachable at all.
          expect(document.activeElement?.id).toBe('page-title');
          expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
        } finally {
          h.dispose();
        }
      });

      it('a rejected delete leaves the dialog open with an alert, and the resource listed', async () => {
        stubConfirm();
        const h = await mount(site.opts, site.page);
        const spy = vi
          .spyOn(h.client, site.method)
          .mockRejectedValueOnce(new ApiError(409, 'Conflict', `${site.resource} is in use`));
        try {
          const dialog = await openFrom(h, deleteTrigger(h));
          commitOf(dialog).click();
          await flush();
          expect(spy).toHaveBeenCalledTimes(1);
          expect(dialogOf(h), 'the failure closed the dialog').toBe(dialog);
          const alert = dialog.querySelector('[role="alert"]');
          expect(alert?.textContent).toContain(`${site.resource} is in use`);
          expect(pageText(h)).toContain(site.resource);
          // Reported in the dialog, nowhere else: no failure toast.
          expect(h.store.state.toast).toBeNull();
          for (const b of buttons(dialog)) expect(b.disabled, labelText(b)).toBe(false);
        } finally {
          h.dispose();
        }
      });
    });
  }

  it('Delete (not Rotate key) carries the destructive treatment on Agents', async () => {
    stubConfirm();
    const h = await mount({ agents: [AGENT] }, 'agents');
    try {
      const destructive = [
        ...h.host.querySelectorAll<HTMLButtonElement>('button.btn-ghost--destructive'),
      ];
      expect(destructive.map((b) => labelText(b))).toEqual(['Delete']);
      expect(destructive[0]!.classList.contains('btn-ghost')).toBe(true);
      const rotate = [...h.host.querySelectorAll<HTMLButtonElement>('button.btn-ghost')].find(
        (b) => labelText(b) === 'Rotate key',
      );
      expect(rotate).toBeDefined();
      expect(rotate!.classList.contains('btn-ghost--destructive')).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('the agent dialog promises what will happen, never that it happens "immediately"', async () => {
    stubConfirm();
    const h = await mount({ agents: [AGENT] }, 'agents');
    try {
      const dialog = await openFrom(h, deleteTrigger(h));
      const body = dialog.querySelector('.t-dense')?.textContent ?? '';
      expect(body).toBe('New requests with its key will be refused.');
      expect(dialog.textContent).not.toMatch(/immediately/i);
    } finally {
      h.dispose();
    }
  });
});
