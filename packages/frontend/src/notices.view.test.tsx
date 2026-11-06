/**
 * Notices: one anatomy, four tones, tone → role (adopt-design-tokens-v2 task 10.1, design.md
 * D15; dashboard-core "Notices share one anatomy and four tones").
 *
 * The banners D15 migrates are walked in the real App on a fake client, each in the state that
 * raises it. Every one is a `Notice`: a status-word title in the Section role, its sentence
 * kept verbatim as the body, at most one ghost action, and no dismiss. The role follows the
 * tone: `alert` for the failure tone, `status` for info, success and caution — including the
 * four load failures, which take Info so this change agrees with adopt-figure-states' neutral
 * notice.
 *
 * A background poll over a failing load must not insert the notice again: every loader clears
 * its error as it starts, so a notice shown straight from the error would unmount and remount
 * — and be announced again — on every poll. The notice node is captured and must be the same
 * node, still connected, through a poll in flight and after it fails again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { Notice, NOTICE_ROLE, type NoticeTone } from './components/Notice';
import { ApiError, type ProviderDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import {
  DEFAULT_SESSION,
  FakeApiClient,
  UNRECORDED_HEALTH,
  type FakeOptions,
} from './test/fakeClient';
import { labelText } from './test/labelText';
import type { Page } from './types';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
const NOW = '2026-11-01T12:00:00.000Z';

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

let sheet: HTMLStyleElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  store: AppStore;
  fake: FakeApiClient;
  host: HTMLElement;
}

async function mount(page: Page, opts: Partial<FakeOptions> = {}): Promise<Harness> {
  globalThis.history.replaceState(null, '', `/#/${page}`);
  const fake = new FakeApiClient({ session: DEFAULT_SESSION, ...opts });
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
  return { store, fake, host };
}

const DOWN = new ApiError(503, 'unavailable', 'analytics down');

/** The Overview agent strip, which reports its own read's failure in its own notice
 * (adopt-figure-states D5, flag F9). */
const AGENT_STRIP = '[data-testid="agent-strip"]';

/** Every page-level notice on screen whose title reads `title`. The Overview agent strip's
 * notice is left out: it reports a different read (the strip rides the range, not the
 * page's poll), so the page's Retry and recovery neither raise nor clear it. Its own anatomy
 * is checked below. */
function noticesTitled(h: Harness, title: string): HTMLElement[] {
  return [...h.host.querySelectorAll<HTMLElement>('.notice')].filter(
    (n) =>
      n.closest(AGENT_STRIP) === null && n.querySelector('.notice-title')?.textContent === title,
  );
}
function only(h: Harness, title: string): HTMLElement {
  const found = noticesTitled(h, title);
  expect(found, `exactly one "${title}" notice`).toHaveLength(1);
  return found[0]!;
}

interface Anatomy {
  tone: string;
  role: string | null;
  title: string;
  titleRole: boolean;
  body: string;
  actions: string[];
}
/** What a notice is made of: its tone class, role, title (and that the title takes the
 * Section role), body, and the labels of its buttons. */
function anatomy(n: HTMLElement): Anatomy {
  const tone = [...n.classList].find((c) => c.startsWith('notice--'))?.slice('notice--'.length);
  const title = n.querySelector<HTMLElement>('.notice-title');
  return {
    tone: tone ?? '',
    role: n.getAttribute('role'),
    title: title?.textContent ?? '',
    titleRole: title?.classList.contains('t-section') ?? false,
    body: n.querySelector('.notice-body')?.textContent ?? '',
    actions: [...n.querySelectorAll('button')].map((b) => labelText(b)),
  };
}
/** Each button in a notice is a ghost button — and there is at most one. */
function expectGhostAction(n: HTMLElement): void {
  const buttons = [...n.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons.length, 'at most one action').toBeLessThanOrEqual(1);
  for (const b of buttons) expect(b.classList.contains('btn-ghost'), 'a ghost action').toBe(true);
}

describe('the Notice component maps tone to fill, title colour and role (D15)', () => {
  const TONES: readonly NoticeTone[] = ['info', 'success', 'caution', 'failure'];

  it('failure is an alert; info, success and caution are status regions', () => {
    expect(NOTICE_ROLE).toEqual({
      info: 'status',
      success: 'status',
      caution: 'status',
      failure: 'alert',
    });
  });

  for (const tone of TONES) {
    it(`${tone}: one anatomy, on its tone class, with the role its tone sets`, () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      dispose = render(
        () => (
          <Notice tone={tone} title="Status" action={{ label: 'Act', onClick: () => undefined }}>
            One sentence.
          </Notice>
        ),
        host,
      );
      const n = host.querySelector<HTMLElement>('.notice')!;
      expect(anatomy(n)).toEqual({
        tone,
        role: tone === 'failure' ? 'alert' : 'status',
        title: 'Status',
        titleRole: true,
        body: 'One sentence.',
        actions: ['Act'],
      });
      expect(n.querySelector('.notice-body')?.classList.contains('t-body')).toBe(true);
      expectGhostAction(n);
    });
  }

  it('the stylesheet gives each tone its wash and its title colour, a 6px radius and 12px padding, and no border', () => {
    const rule = (sel: string): string => {
      const m = new RegExp(
        `(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`,
      ).exec(css);
      expect(m, `${sel} is declared`).not.toBeNull();
      return m![1]!.replace(/\s+/g, ' ').trim();
    };
    expect(rule('.notice')).toMatch(/padding: 12px;/);
    expect(rule('.notice')).toMatch(/border-radius: 6px;/);
    expect(rule('.notice')).not.toMatch(/border(?:-left)?:/);
    expect(rule('.notice-body')).toMatch(/color: var\(--text2\);/);
    const WASH = { info: 'chip', success: 'green-bg', caution: 'amber-bg', failure: 'red-bg' };
    const TITLE = {
      info: 'text2',
      success: 'green-text',
      caution: 'amber-text',
      failure: 'red-text',
    };
    for (const tone of TONES) {
      expect(rule(`.notice--${tone}`)).toBe(`background: var(--${WASH[tone]});`);
      expect(rule(`.notice--${tone} .notice-title`)).toBe(`color: var(--${TITLE[tone]});`);
    }
    // The action's label never sits on a wash: a Panel fill except while pressed.
    expect(rule('.notice .notice-action:not(:active)')).toBe('background: var(--panel);');
  });

  it('a busy-capable action is natively disabled and stacks both labels while busy', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    dispose = render(
      () => (
        <Notice
          tone="caution"
          title="Unverified"
          action={{ label: 'Retry', busyLabel: 'Retrying…', busy: true, onClick: () => undefined }}
        >
          Routing may have changed.
        </Notice>
      ),
      host,
    );
    const b = host.querySelector<HTMLButtonElement>('.notice button')!;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(labelText(b)).toBe('Retrying…');
    expect(
      [...b.querySelectorAll('.stacked-label-item')].map((i) => i.textContent),
      'both labels stay in the one cell',
    ).toEqual(['Retry', 'Retrying…']);
  });
});

describe('the migrated banners are notices, each with its role and its sentence (D15)', () => {
  it('the four load failures are Info status notices titled Couldn’t load, each with a Retry', async () => {
    const cases: {
      page: Page;
      opts?: Partial<FakeOptions>;
      prepare?: (h: Harness) => void;
      body: string;
    }[] = [
      {
        page: 'overview',
        opts: { analyticsFailure: DOWN },
        // adopt-figure-states 3.2: the body names what failed, without the raw error.
        body: 'Analytics couldn’t be loaded. Routing is unaffected.',
      },
      {
        page: 'costs',
        opts: { analyticsFailure: DOWN },
        body: 'Cost analytics couldn’t be loaded. Routing is unaffected.',
      },
      {
        page: 'requests',
        opts: { analyticsFailure: DOWN },
        body: 'Requests couldn’t be loaded. Routing is unaffected.',
      },
      {
        page: 'routing',
        prepare: (h) => h.store.setState('routingError', 'routing unavailable'),
        body: 'Couldn’t load routing — routing unavailable',
      },
    ];
    for (const c of cases) {
      const h = await mount(c.page, c.opts);
      c.prepare?.(h);
      await flush();
      const n = only(h, 'Couldn’t load');
      expect(anatomy(n), c.page).toEqual({
        tone: 'info',
        role: 'status',
        title: 'Couldn’t load',
        titleRole: true,
        body: c.body,
        actions: ['Retry'],
      });
      expectGhostAction(n);
      dispose?.();
      dispose = undefined;
      document.body.innerHTML = '';
    }
  });

  it('the Overview agent strip reports its own failed read in the same Info notice, with its own Retry', async () => {
    const h = await mount('overview', { analyticsFailure: DOWN });
    const strip = h.host.querySelector<HTMLElement>(AGENT_STRIP)!;
    const inStrip = [...strip.querySelectorAll<HTMLElement>('.notice')];
    expect(inStrip, 'exactly one notice in the agent strip').toHaveLength(1);
    expect(anatomy(inStrip[0]!)).toEqual({
      tone: 'info',
      role: 'status',
      title: 'Couldn’t load',
      titleRole: true,
      body: 'Agent activity couldn’t be loaded. Routing is unaffected.',
      actions: ['Retry'],
    });
    expectGhostAction(inStrip[0]!);
    // The page's own notice is a separate one, for the polled analytics read.
    expect(only(h, 'Couldn’t load')).not.toBe(inStrip[0]);
  });

  it('the Targets matrix unverified notice: Caution, Unverified, a busy-capable Retry, and a focus target', async () => {
    const h = await mount('routing');
    h.store.setRoutingSection('auto');
    await flush();
    h.store.setState('bt', 'unverified', true);
    await flush();
    const n = only(h, 'Unverified');
    expect(anatomy(n)).toEqual({
      tone: 'caution',
      role: 'status',
      title: 'Unverified',
      titleRole: true,
      body: 'Routing may have changed — the refresh failed, so the Strong and Cheap columns wait until it succeeds.',
      actions: ['Retry'],
    });
    expectGhostAction(n);
    expect(n.id).toBe('auto-targets-unverified');
    expect(n.getAttribute('tabindex')).toBe('-1');
    expect(n.dataset['testid']).toBe('targets-unverified');
    // Its Retry stays shown while the reconcile runs, so it stacks its busy label (D14).
    expect([...n.querySelectorAll('.stacked-label-item')].map((i) => i.textContent)).toEqual([
      'Retry',
      'Retrying…',
    ]);
  });

  it('the provider reconnect-required banner: Caution, Reconnect needed, with the one Reconnect', async () => {
    const h = await mount('providers', {
      providers: [
        {
          ...PROVIDER,
          id: 'prov-dead',
          name: 'Expired',
          kind: 'subscription',
          oauthPreset: 'chatgpt',
          credentialError: 'reauthorize_required',
          health: {
            state: 'reauthorize_required',
            kind: 'credential',
            message: 'credential needs reauthorization',
            source: 'refresh',
            at: new Date().toISOString(),
          },
        },
      ],
    });
    const n = only(h, 'Reconnect needed');
    const a = anatomy(n);
    expect({ ...a, body: '' }).toEqual({
      tone: 'caution',
      role: 'status',
      title: 'Reconnect needed',
      titleRole: true,
      body: '',
      actions: ['Reconnect'],
    });
    // The health text is kept verbatim as the body, and it is still the card's one status line.
    expect(a.body).toMatch(/Sign-in expired/);
    expect(n.hasAttribute('data-health-line')).toBe(true);
    expectGhostAction(n);
  });

  it('the subscription terms notice: Caution, Terms risk, Add a pay-per-token fallback', async () => {
    const h = await mount('providers', {
      providers: [{ ...PROVIDER, kind: 'subscription', oauthPreset: 'chatgpt' }],
    });
    const n = only(h, 'Terms risk');
    expect(anatomy(n)).toEqual({
      tone: 'caution',
      role: 'status',
      title: 'Terms risk',
      titleRole: true,
      body: 'Reusing a flat-rate subscription may violate the provider’s ToS.',
      actions: ['Add a pay-per-token fallback'],
    });
    expectGhostAction(n);
    n.querySelector<HTMLButtonElement>('button')!.click();
    await flush();
    expect(h.store.state.modal, 'the action still opens the provider form').toBe('newProvider');
  });

  it('the Setup test-request failure: Failure, Test failed, an alert with no action', async () => {
    const h = await mount('setup');
    h.store.setState('ob', 'key', 'poly_test_key');
    h.store.obGo(3);
    h.store.setState('ob', 'error3', 'upstream down');
    await flush();
    const n = only(h, 'Test failed');
    expect(anatomy(n)).toEqual({
      tone: 'failure',
      role: 'alert',
      title: 'Test failed',
      titleRole: true,
      body: 'upstream down',
      actions: [],
    });
  });
});

describe('a background refresh does not insert the notice again (D15)', () => {
  /** Run a background reload (what the page's poller calls) and check the notice node is the
   * same element throughout: before, while the reload is in flight, and once it fails again. */
  async function holdsThroughReload(h: Harness, reload: () => Promise<void>): Promise<void> {
    const before = only(h, 'Couldn’t load');
    const run = reload();
    // In flight: the loader has cleared its error, but the notice is held.
    expect(before.isConnected, 'the notice left while the reload was in flight').toBe(true);
    await run;
    await flush();
    const after = only(h, 'Couldn’t load');
    expect(after, 'the notice was inserted again').toBe(before);
    expect(after.isConnected).toBe(true);
  }

  it('Overview: the 15-second poll over a failing load', async () => {
    const h = await mount('overview', { analyticsFailure: DOWN });
    await holdsThroughReload(h, () =>
      h.store.requestAggregateRefresh(() => h.store.loadOverview(), true),
    );
  });

  it('Costs: the 15-second poll over a failing load', async () => {
    const h = await mount('costs', { analyticsFailure: DOWN });
    await holdsThroughReload(h, () =>
      h.store.requestAggregateRefresh(() => h.store.loadCosts(), true),
    );
  });

  it('Requests: the freshness refresh over a failing load', async () => {
    const h = await mount('requests', { analyticsFailure: DOWN });
    await holdsThroughReload(h, () => h.store.refreshRequestsPage());
  });

  it('Routing: a reload over a failing load', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    fake.listTiers = () => Promise.reject(new ApiError(503, 'unavailable', 'routing down'));
    globalThis.history.replaceState(null, '', '/#/routing');
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
    store.go('routing');
    await flush();
    await holdsThroughReload({ store, fake, host }, () => store.loadRouting());
  });

  it('a recovery removes it, and Retry drops it at once so a fresh failure is a new notice', async () => {
    const h = await mount('overview', { analyticsFailure: DOWN });
    const first = only(h, 'Couldn’t load');
    // Retry: the notice (and the Retry in it) leaves as the user's own reload starts.
    first.querySelector<HTMLButtonElement>('button')!.click();
    expect(first.isConnected, 'Retry left the notice up').toBe(false);
    await flush();
    const second = only(h, 'Couldn’t load');
    expect(second, 'the retried failure is a new notice').not.toBe(first);
    // A reload that succeeds ends the condition, and the notice with it.
    h.fake.analyticsFailure = null;
    await h.store.loadOverview();
    await flush();
    expect(noticesTitled(h, 'Couldn’t load')).toEqual([]);
  });
});
