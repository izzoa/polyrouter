import { APP_NAME } from '@polyrouter/shared';
import { render } from 'solid-js/web';
import { ApiError } from './data/api';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelDto, ModelDto, RuleDto, TierDto, TierEntryDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import {
  DEFAULT_PRICING_STATUS,
  DEFAULT_SESSION,
  DEFAULT_CALIBRATION,
  FakeApiClient,
} from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-07-15T00:00:00.000Z';
function mkModel(id: string): ModelDto {
  return {
    id,
    providerId: 'p1',
    externalModelId: `ext-${id}`,
    displayName: null,
    contextWindow: null,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    isFree: false,
    inputPricePer1m: 1,
    outputPricePer1m: 2,
    effectivePrice: {
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      isFree: false,
      source: 'model',
      estimated: false,
    },
    listedPrice: null,
    lastSyncedAt: null,
  };
}
function mkEntry(modelId: string, position: number): TierEntryDto {
  return { id: `e-${modelId}`, tierId: 't1', modelId, position, model: null };
}
const DEFAULT_TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: 'Default',
  description: null,
  createdAt: NOW,
};

function mount(store: AppStore = createAppStore(new FakeApiClient())): {
  host: HTMLElement;
  store: AppStore;
  dispose: () => void;
} {
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
  return {
    host,
    store,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

function clickByText(host: HTMLElement, selector: string, text: string): void {
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find(
    (e) => e.textContent?.trim() === text,
  );
  if (!el) throw new Error(`No element ${selector} with text "${text}"`);
  el.click();
}

describe('dashboard shell (auth-gated)', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('shows the login gate when unauthenticated (me 401)', async () => {
    const { host, dispose } = mount(createAppStore(new FakeApiClient({ session: null })));
    try {
      await flush();
      expect(host.textContent).toContain('Sign in');
      expect(host.querySelector('nav')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('renders the branded shell with all nav items once ready', async () => {
    const { host, dispose } = mount();
    try {
      await flush();
      expect(APP_NAME).toBe('polyrouter');
      expect(host.textContent).toContain(APP_NAME);
      for (const label of [
        'Overview',
        'Requests',
        'Costs',
        'Agents',
        'Providers',
        'Routing',
        'Limits',
        'Settings',
      ]) {
        expect(host.querySelector('nav')?.textContent).toContain(label);
      }
      expect(host.textContent).toContain('Recent requests');
    } finally {
      dispose();
    }
  });

  it('navigates between pages from the sidebar', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      expect(store.state.page).toBe('routing');
      expect(host.textContent).toContain('Automatic routing');
      expect(host.textContent).toContain('x-polyrouter-tier');
      clickByText(host, '.nav-item span', 'Settings');
      expect(host.textContent).toContain('Prompt & response bodies');
    } finally {
      dispose();
    }
  });

  it('opens the decision inspector on a request row and shows the routing reason', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const row = host.querySelector<HTMLElement>('.req-row');
      expect(row).not.toBeNull();
      row?.click();
      const first = store.state.requestList[0];
      expect(first).toBeDefined();
      expect(store.state.selId).toBe(first?.id);
      const drawer = host.querySelector('.drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent).toContain('Decision');
      expect(drawer?.textContent).toContain('Usage & cost');
      expect(drawer?.textContent).toContain('Timing');
      if (first) expect(drawer?.textContent).toContain(first.routingReason);
      host.querySelector<HTMLElement>('.overlay')?.click();
      expect(store.state.selId).toBeNull();
    } finally {
      dispose();
    }
  });

  it('shows the matched routing header row only when recorded (add-routing-header-visibility)', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const rows = host.querySelectorAll<HTMLElement>('.req-row');
      // buildRequestRows: header rows are i ≡ 1 (mod 5); i%15 cycles the shape —
      // 1 → built-in (name+value), 6 → custom rule (name only), 11 → legacy (null).
      rows[1]?.click();
      expect(store.state.requestList[1]?.routingHeaderName).toBe('x-polyrouter-tier');
      expect(host.querySelector('.drawer')?.textContent).toContain('x-polyrouter-tier: default');
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[6]?.click(); // custom rule → bare name, never a trailing colon/value
      expect(store.state.requestList[6]?.routingHeaderValue).toBeNull();
      const drawer = host.querySelector('.drawer');
      expect(drawer?.textContent).toContain('x-team');
      expect(drawer?.textContent).not.toContain('x-team:');
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[11]?.click(); // legacy header-layer row (pre-capture) → no header row at all
      expect(store.state.requestList[11]?.routingHeaderName).toBeNull();
      const drawer2 = host.querySelector('.drawer');
      expect(drawer2?.textContent).not.toContain('x-polyrouter-tier');
      expect(drawer2?.textContent).not.toContain('x-team');
    } finally {
      dispose();
    }
  });

  it('shows the ERROR card for a detailed error row and hides it for others (add-request-error-detail)', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const rows = host.querySelectorAll<HTMLElement>('.req-row');
      // buildRequestRows: status cycles success,success,fallback,error → index 3 errors.
      rows[3]?.click();
      const errRow = store.state.requestList[3];
      expect(errRow?.status).toBe('error');
      const drawer = host.querySelector('.drawer');
      expect(drawer?.textContent).toContain('Error');
      expect(drawer?.textContent).toContain('rate_limit · HTTP 429');
      expect(drawer?.textContent).toContain('provider said');
      expect(drawer?.textContent).toContain(errRow!.errorMessage!);
      expect(drawer?.textContent).toContain(errRow!.errorRequestId!);
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[0]?.click(); // a success row renders exactly as before — no card
      const drawer2 = host.querySelector('.drawer');
      expect(drawer2?.textContent).not.toContain('provider said');
    } finally {
      dispose();
    }
  });

  it('toggles the theme, persists it, and re-applies it on a fresh mount', async () => {
    const first = mount();
    try {
      await flush();
      // The theme toggle lives in the current-user menu (user-administration).
      first.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
      await flush();
      clickByText(first.host, '[role="menuitem"]', 'Switch to dark');
      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(localStorage.getItem('polyrouter-theme')).toBe('dark');
    } finally {
      first.dispose();
    }
    delete document.documentElement.dataset['theme'];
    const second = mount();
    try {
      await flush();
      expect(document.documentElement.dataset['theme']).toBe('dark');
    } finally {
      second.dispose();
    }
  });

  it('enforces the 5-model tier cap through the Routing UI with a toast', async () => {
    const fake = new FakeApiClient({
      models: { p1: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(mkModel) },
      tiers: [DEFAULT_TIER],
      tierEntries: { t1: [mkEntry('m1', 0), mkEntry('m2', 1), mkEntry('m3', 2)] },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const firstTierCard = host.querySelector<HTMLElement>('.panel');
      expect(firstTierCard).not.toBeNull();
      if (!firstTierCard) return;
      // Commit through the combobox: ArrowDown opens with the first addable model
      // active, Enter adds it (the same addTierModel chain the old select drove).
      const addViaPicker = (): void => {
        const input = firstTierCard.querySelector<HTMLInputElement>('input[role="combobox"]');
        if (!input) throw new Error('add-model combobox missing');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      };
      const rows = () => firstTierCard.querySelectorAll('.chain-row').length;
      const start = rows();
      expect(start).toBe(3);
      addViaPicker();
      addViaPicker();
      expect(rows()).toBe(5);
      addViaPicker();
      expect(rows()).toBe(5);
      expect(host.querySelector('.toast')?.textContent).toBe('Max 5 models per tier');
    } finally {
      dispose();
    }
  });

  it('greys an instance-disabled auto layer with the ROUTING_AUTO_LAYERS hint', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: false,
        cascade: false,
        structuralAvailable: false,
        cascadeAvailable: false,
        calibration: DEFAULT_CALIBRATION,
      },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      expect(host.textContent).toContain('off instance-wide (ROUTING_AUTO_LAYERS)');
      // add-auto-performance-view: no structural layer -> no performance section
      expect(host.textContent).not.toContain('Auto performance');
    } finally {
      dispose();
    }
  });

  it('Band targets: set, retarget, clear, shadowed cleanup, warnings, cascade note (add-band-target-ui)', async () => {
    const mkRule = (over: Partial<RuleDto>): RuleDto => ({
      id: 'r-b1',
      matchType: 'auto_high',
      headerName: 'x-polyrouter-tier',
      headerValue: null,
      target: 'tier:premium',
      priority: 0,
      createdAt: NOW,
      ...over,
    });
    const premium: TierDto = {
      id: 't-premium',
      key: 'premium',
      displayName: null,
      description: null,
      createdAt: NOW,
    };
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER, premium],
      tierEntries: {
        t1: [mkEntry('m1', 0)],
        't-premium': [{ id: 'ep1', tierId: 't-premium', modelId: 'm2', position: 0, model: null }],
      },
      models: { p1: [mkModel('m1'), mkModel('m2')] },
      rules: [
        mkRule({ id: 'r-eff', priority: 5 }),
        mkRule({ id: 'r-shadow', priority: 0 }), // shadowed duplicate
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const panel = () =>
        [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
          p.textContent?.includes('Band targets'),
        );
      const text = () => panel()?.textContent ?? '';
      // Effective (priority 5) shown with chain preview; duplicate disclosed.
      expect(text()).toContain('tier: premium');
      expect(text()).toContain('1 shadowed duplicate rule');
      // The cheap band is unset with its consequence copy; cascade needs both.
      expect(text()).toContain('Not set — confident low verdicts fall through to default');
      expect(text()).toContain('Cascade needs both bands usable');
      // Cleanup removes only the shadowed rule.
      const cleanup = [...panel()!.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'clean up',
      );
      cleanup?.click();
      await flush();
      expect(store.state.rules.filter((r) => r.matchType === 'auto_high')).toHaveLength(1);
      expect(store.state.rules.some((r) => r.id === 'r-eff')).toBe(true);
      // Keyboard-native picker: setting the cheap band via the select.
      const selects = panel()!.querySelectorAll<HTMLSelectElement>('select');
      // The pickers REST on their placeholder — never on a real option (the
      // v0.5.0 bug showed "default" because nothing selected the placeholder).
      expect(selects[0]!.value).toBe('');
      expect(selects[1]!.value).toBe('');
      const cheapSelect = selects[1]!;
      cheapSelect.value = 'tier:default';
      cheapSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(store.state.rules.some((r) => r.matchType === 'auto_low')).toBe(true);
      expect(cheapSelect.value).toBe(''); // back on the placeholder after applying
      expect(text()).not.toContain('Cascade needs both bands usable');
      expect(text()).toContain('uses the Layer-0 default chain');
      // Clear removes the whole band again.
      const clear = [...panel()!.querySelectorAll<HTMLElement>('button')].filter(
        (b) => b.textContent?.trim() === 'Clear',
      )[1];
      clear?.click();
      await flush();
      expect(store.state.rules.some((r) => r.matchType === 'auto_low')).toBe(false);
    } finally {
      dispose();
    }
  });

  it('body-capture card: consent-gated enable flips the badge; master-kill copy (add-body-capture)', async () => {
    const { host, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Settings');
      await flush();
      const card = () =>
        [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
          p.textContent?.includes('Prompt & response bodies'),
        )!;
      expect(card().textContent).toContain('Metadata-only'); // off = green truth
      expect(card().textContent).toContain('Off by default');
      // Picking a capture mode opens the consent modal — nothing applies yet.
      const radio = [...card().querySelectorAll<HTMLInputElement>('input[type=radio]')][2]!; // All requests
      radio.click();
      await flush();
      const modal = host.querySelector<HTMLElement>('[aria-label="Confirm body capture"]');
      expect(modal).not.toBeNull();
      expect(modal!.textContent).toContain('secrets');
      expect(card().textContent).toContain('Metadata-only'); // still off pre-consent
      [...modal!.querySelectorAll<HTMLElement>('button')]
        .find((b) => b.textContent?.trim() === 'Capture bodies')!
        .click();
      await flush();
      expect(card().textContent).toContain('Bodies captured'); // amber, honest
      // Disable offers keep-or-purge.
      [...card().querySelectorAll<HTMLInputElement>('input[type=radio]')][0]!.click();
      await flush();
      const off = host.querySelector<HTMLElement>('[aria-label="Disable body capture"]');
      expect(off).not.toBeNull();
      [...off!.querySelectorAll<HTMLElement>('button')]
        .find((b) => b.textContent?.trim() === 'Keep until retention')!
        .click();
      await flush();
      expect(card().textContent).toContain('Metadata-only');
      expect(card().textContent).toContain('Inert while capture is off'); // overrides = master kill
    } finally {
      dispose();
    }
  });

  it('inspector Payload: lazy fetch, truncation notice, delete collapses; absent rows unchanged (add-body-capture)', async () => {
    const { host, store, dispose } = mount();
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Requests');
      await flush();
      const rows = host.querySelectorAll<HTMLElement>('.req-row');
      rows[0]?.click(); // req-000: hasBodies fixture
      await flush();
      const drawer = () => host.querySelector<HTMLElement>('.drawer')!;
      expect(drawer().textContent).toContain('Payload');
      expect(drawer().textContent).not.toContain('prompt for req-000'); // lazy — not yet fetched
      [...drawer().querySelectorAll<HTMLElement>('button')]
        .find((b) => b.textContent?.trim() === 'Show bodies')!
        .click();
      await flush();
      expect(drawer().textContent).toContain('prompt for req-000');
      expect(drawer().textContent).toContain('answer for req-000');
      // Delete removes the payloads and the section (hasBodies flips).
      [...drawer().querySelectorAll<HTMLElement>('button')]
        .find((b) => b.textContent?.trim() === 'Delete')!
        .click();
      await flush();
      expect(drawer().textContent).not.toContain('Payload');
      expect(store.state.requestList[0]?.hasBodies).toBe(false);
      // A row with no stored bodies renders no Payload section at all.
      host.querySelector<HTMLElement>('.overlay')?.click();
      rows[1]?.click();
      await flush();
      expect(store.state.requestList[1]?.hasBodies).toBe(false);
      expect(drawer().textContent).not.toContain('Payload');
    } finally {
      dispose();
    }
  });

  it('Settings pricing-catalog panel: status, never-refreshed callout, refresh flow (add-pricing-refresh-ui)', async () => {
    const { host, dispose } = mount(); // DEFAULT_SESSION is an admin
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Settings');
      await flush();
      const panel = () =>
        [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
          p.textContent?.includes('Pricing catalog'),
        );
      const text = () => panel()?.textContent ?? '';
      expect(text()).toContain('67 models');
      expect(text()).toContain('newest: bundled');
      expect(text()).toContain('never'); // the literal never-refreshed callout
      expect(text()).toContain('scheduled — 30 4 * * * (UTC)'); // cadence-neutral copy (r3-Low-7)
      expect(text()).toContain('recorded costs never change');
      const btn = [...panel()!.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'Refresh now',
      );
      btn?.click();
      await flush();
      expect(text()).not.toContain('Last refreshed: never');
      expect(text()).toContain('+124');
    } finally {
      dispose();
    }
  });

  it('pricing panel branches: +0 toast, empty catalog, opted-out line, refresh error (add-pricing-refresh-ui)', async () => {
    // +0 completion is a SUCCESS with its own honest toast.
    const zero = new FakeApiClient({ pricingRefreshAdded: 0 });
    const a = mount(createAppStore(zero));
    try {
      await flush();
      clickByText(a.host, '.nav-item span', 'Settings');
      await flush();
      const btn = [...a.host.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'Refresh now',
      );
      btn?.click();
      await flush();
      expect(a.store.state.toast).toBe('+0 — no changes');
      expect(a.host.textContent).not.toContain('Last refreshed: never');
    } finally {
      a.dispose();
    }
    // Empty catalog → neutral copy, no diagnosed cause.
    const empty = new FakeApiClient({
      pricingStatus: { ...DEFAULT_PRICING_STATUS, entryCount: 0, newest: null },
    });
    const b = mount(createAppStore(empty));
    try {
      await flush();
      clickByText(b.host, '.nav-item span', 'Settings');
      await flush();
      expect(b.host.textContent).toContain('Catalog is empty; pricing is unavailable.');
    } finally {
      b.dispose();
    }
    // Opted out → the off state names the flag; refresh failure → inline
    // report, the button itself re-enabled as the retry.
    const err = new FakeApiClient({
      pricingStatus: {
        ...DEFAULT_PRICING_STATUS,
        scheduler: {
          configuredEnabled: false,
          modePermitted: true,
          effectiveEnabled: false,
          cron: '30 4 * * *',
        },
      },
    });
    err.pricingRefresh = () => Promise.reject(new ApiError(502, 'BadGateway', 'source down'));
    const c = mount(createAppStore(err));
    try {
      await flush();
      clickByText(c.host, '.nav-item span', 'Settings');
      await flush();
      expect(c.host.textContent).toContain('off — PRICING_REFRESH_SCHED_ENABLED=false is set');
      const btn = [...c.host.querySelectorAll<HTMLElement>('button')].find(
        (x) => x.textContent?.trim() === 'Refresh now',
      );
      btn?.click();
      await flush();
      expect(c.host.textContent).toContain('Refresh failed — source down');
      expect((btn as HTMLButtonElement).disabled).toBe(false); // the retry IS the button
    } finally {
      c.dispose();
    }
  });

  it('the pricing panel hides for non-admins and drops the button in cloud mode', async () => {
    // Non-admin: no panel at all.
    const nonAdmin = new FakeApiClient({
      session: { ...DEFAULT_SESSION, role: null },
    });
    const a = mount(createAppStore(nonAdmin));
    try {
      await flush();
      clickByText(a.host, '.nav-item span', 'Settings');
      await flush();
      expect(a.host.textContent).not.toContain('Pricing catalog');
    } finally {
      a.dispose();
    }
    // Cloud admin: read-only status, no doomed button.
    const cloud = new FakeApiClient({
      pricingStatus: {
        ...DEFAULT_PRICING_STATUS,
        scheduler: {
          configuredEnabled: true,
          modePermitted: false,
          effectiveEnabled: false,
          cron: '30 4 * * *',
        },
      },
    });
    const b = mount(createAppStore(cloud));
    try {
      await flush();
      clickByText(b.host, '.nav-item span', 'Settings');
      await flush();
      const panel = [...b.host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Pricing catalog'),
      );
      expect(panel?.textContent).toContain('unavailable in cloud mode');
      expect(
        [...(panel?.querySelectorAll<HTMLElement>('button') ?? [])].some(
          (x) => x.textContent?.trim() === 'Refresh now',
        ),
      ).toBe(false);
    } finally {
      b.dispose();
    }
  });

  it('renders Self-calibration: toggle, thresholds line, revert only when calibrated, history', async () => {
    const fake = new FakeApiClient({
      tiers: [DEFAULT_TIER],
      autoLayers: {
        structural: true,
        cascade: true,
        structuralAvailable: true,
        cascadeAvailable: true,
        calibration: {
          enabled: true,
          calibratedHigh: 0.58,
          calibratedLow: 0.27,
          instanceHigh: 0.6,
          instanceLow: 0.25,
          effectiveHigh: 0.58,
          effectiveLow: 0.27,
        },
      },
      calibrationEvents: [
        {
          id: 'ev1',
          trigger: 'calibrator',
          oldHigh: 0.6,
          oldLow: 0.27,
          newHigh: 0.58,
          newLow: 0.27,
          anchorHigh: 0.6,
          anchorLow: 0.25,
          windowFrom: null,
          windowTo: null,
          edge: 'high',
          edgeSamples: 57,
          edgeFailures: 43,
          reason: 'r',
          createdAt: '2026-07-19T04:00:00.000Z',
        },
      ],
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const text = host.textContent ?? '';
      expect(text).toContain('Self-calibration');
      expect(text).toContain('high 0.58 · low 0.27');
      expect(text).toContain('calibrated');
      expect(text).toContain('Revert to defaults');
      expect(text).toContain('0.6 → 0.58 (high)');
      expect(text).toContain('57 samples · 75% failed');
      // Revert: one click clears the pair; the section returns to defaults.
      const btn = [...host.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'Revert to defaults',
      );
      btn?.click();
      await flush();
      expect(fake.calls).toContain('calibrationRevert');
      expect(host.textContent).toContain('instance defaults');
      expect(host.textContent).not.toContain('Revert to defaults');
    } finally {
      dispose();
    }
  });

  it('renders the Auto performance section with rates, savings + coverage, and a local range', async () => {
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER] });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const text = host.textContent ?? '';
      expect(text).toContain('Auto performance');
      // DEFAULT_AUTO_PERF: evaluated 40; cascade 10 with 7 passed / 1 escalated.
      expect(text).toContain('evaluated');
      expect(text).toContain('40');
      expect(text).toContain('70%');
      // Savings honesty contract: net + basis label + '· est.' + visible coverage.
      expect(text).toContain('$1.6200');
      expect(text).toContain('premium');
      expect(text).toContain('est.');
      expect(text).toContain('based on 6 of 7 quality-passed requests');
      // Unroutable diagnostic (1 in the fixture, high band): the perf panel
      // names the AFFECTED band and points at Band targets (cause-neutral —
      // scoped to the panel so the band section's keys can't satisfy it).
      const perfPanel = [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Auto performance'),
      );
      expect(perfPanel?.textContent).toContain('strong (auto_high)');
      expect(perfPanel?.textContent).toContain('Band targets above');
      // The section's range control is LOCAL: clicking 30d must not move the
      // global Observe range (24h default), only autoPerf.range.
      expect(store.state.autoPerf.range).toBe('7d');
      const globalBefore = store.state.range;
      const section = [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Auto performance'),
      );
      if (!section) throw new Error('Auto performance panel missing');
      const btn = [...section.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === '30d',
      );
      if (!btn) throw new Error('30d range button missing');
      btn.click();
      await flush();
      expect(store.state.autoPerf.range).toBe('30d');
      expect(store.state.range).toBe(globalBefore);
      expect(fake.calls.filter((c) => c === 'autoPerformance').length).toBeGreaterThanOrEqual(2);
    } finally {
      dispose();
    }
  });

  it('provider patience fields: server-fetched placeholders, set + clear round-trip (fix-long-call-timeouts)', async () => {
    const fake = new FakeApiClient({
      providers: [
        {
          id: 'prov-1',
          name: 'OpenRouter',
          kind: 'api_key',
          protocol: 'openai_compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          status: 'ok',
          hasCredential: true,
          oauthPreset: null,
          credentialExpiresAt: null,
          credentialError: null,
          firstByteTimeoutMs: null,
          idleTimeoutMs: null,
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ],
    });
    const { host, store, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Providers');
      await flush();
      // Edit the first provider — the modal's advanced section shows the
      // SERVER default as the placeholder (never a hard-coded value).
      const editBtn = [...host.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'Edit',
      );
      if (!editBtn) throw new Error('provider Edit button missing');
      editBtn.click();
      await flush();
      const fb = host.querySelector<HTMLInputElement>('#f-np-firstbyte');
      expect(fb).not.toBeNull();
      expect(fb!.placeholder).toContain('30 · instance default'); // fake default 30000ms
      expect(fake.calls).toContain('providerTimeoutDefaults');
      // Set 1800s and save → the PATCH carries ms; idle stays blank → null (inherit).
      fb!.value = '1800';
      fb!.dispatchEvent(new Event('input', { bubbles: true }));
      clickByText(host, 'button', 'Save changes');
      await flush();
      const edited = store.state.providers[0]!;
      expect(edited.firstByteTimeoutMs).toBe(1_800_000);
      expect(edited.idleTimeoutMs).toBeNull();
      // Re-open: the field shows the stored seconds; blanking it clears to inherit.
      [...host.querySelectorAll<HTMLElement>('button')]
        .find((b) => b.textContent?.trim() === 'Edit')!
        .click();
      await flush();
      const fb2 = host.querySelector<HTMLInputElement>('#f-np-firstbyte')!;
      expect(fb2.value).toBe('1800');
      fb2.value = '';
      fb2.dispatchEvent(new Event('input', { bubbles: true }));
      clickByText(host, 'button', 'Save changes');
      await flush();
      expect(store.state.providers[0]!.firstByteTimeoutMs).toBeNull();
    } finally {
      dispose();
    }
  });

  it('Auto performance refreshes on every page visit, not just the first (stale-card bug)', async () => {
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER] });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      const first = fake.calls.filter((c) => c === 'autoPerformance').length;
      expect(first).toBeGreaterThanOrEqual(1);
      clickByText(host, '.nav-item span', 'Requests'); // leave…
      await flush();
      clickByText(host, '.nav-item span', 'Routing'); // …and return
      await flush();
      // A revisit refetches (stale-while-revalidate: old data stayed visible).
      expect(fake.calls.filter((c) => c === 'autoPerformance').length).toBeGreaterThan(first);
      expect(host.textContent).toContain('Auto performance');
    } finally {
      dispose();
    }
  });

  it('shows only header rules in the Header rules panel (auto rules stay read-only)', async () => {
    const rules: RuleDto[] = [
      {
        id: 'r-hdr',
        matchType: 'header',
        headerName: 'x-polyrouter-tier',
        headerValue: 'heavy',
        target: 'tier:heavy',
        priority: 0,
        createdAt: NOW,
      },
      {
        id: 'r-auto',
        matchType: 'auto_high',
        headerName: 'x-polyrouter-tier',
        headerValue: null,
        target: 'model:auto-band-xyz',
        priority: 0,
        createdAt: NOW,
      },
    ];
    const fake = new FakeApiClient({ tiers: [DEFAULT_TIER], rules });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Routing');
      await flush();
      expect(host.textContent).toContain('tier:heavy'); // the header rule is shown + deletable
      // The auto rule stays OUT of the Header-rules panel — but IS now
      // presented by Band targets (add-band-target-ui), as unresolved here.
      const headerPanel = [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Header rules'),
      );
      expect(headerPanel?.textContent).not.toContain('auto-band-xyz');
      const bandPanel = [...host.querySelectorAll<HTMLElement>('.panel')].find((p) =>
        p.textContent?.includes('Band targets'),
      );
      expect(bandPanel?.textContent).toContain('model:auto-band-xyz');
      expect(bandPanel?.textContent).toContain('Target unresolved');
    } finally {
      dispose();
    }
  });

  it('renders a failed channel test-send result inline in Settings', async () => {
    const channel: ChannelDto = {
      id: 'chan-1',
      name: 'homelab email',
      kind: 'smtp',
      enabled: true,
      eventsSubscribed: ['budget_alert'],
      hasConfig: true,
      lastTestAt: null,
      lastTestStatus: null,
    };
    const fake = new FakeApiClient({
      channels: [channel],
      channelTestResult: { ok: false, error: 'smtp_auth' },
    });
    const { host, dispose } = mount(createAppStore(fake));
    try {
      await flush();
      clickByText(host, '.nav-item span', 'Settings');
      await flush();
      clickByText(host, '.btn-ghost', 'Send test');
      await flush();
      expect(host.textContent).toContain('test failed — smtp_auth');
    } finally {
      dispose();
    }
  });
});
