import { render } from 'solid-js/web';
import { APP_NAME } from '@polyrouter/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { SEED_TIERS } from './data/seed';
import { app } from './state/appState';

function mount(): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(() => <App live={false} />, host);
  return {
    host,
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

describe('dashboard shell (dashboard-prototype)', () => {
  afterEach(() => {
    // The render tests share the process-wide store — restore everything they touch,
    // including the toast's pending auto-dismiss timer. (Simulated live-feed growth
    // from pushLiveRequest is deliberately not rolled back: no assertion depends on
    // request counts, and regenerating seeds would just shuffle random data.)
    app.clearToast();
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
    app.setState({
      page: 'overview',
      selId: null,
      modal: null,
      theme: 'light',
      reqFilter: 'all',
      tiers: SEED_TIERS.map((t) => ({ ...t, chain: [...t.chain] })),
    });
  });

  it('renders the branded shell with all nav items (shared resolves via ESM)', () => {
    const { host, dispose } = mount();
    try {
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

  it('navigates between pages from the sidebar', () => {
    const { host, dispose } = mount();
    try {
      clickByText(host, '.nav-item span', 'Routing');
      expect(app.state.page).toBe('routing');
      expect(host.textContent).toContain('Automatic routing');
      expect(host.textContent).toContain('x-polyrouter-tier');
      clickByText(host, '.nav-item span', 'Settings');
      expect(host.textContent).toContain('Log prompt & response bodies');
    } finally {
      dispose();
    }
  });

  it('opens the inspector on a structural request and shows the L1 evidence', () => {
    // Guarantee a structural request exists (P(none in 26 seeds) is tiny but nonzero).
    for (let guard = 0; guard < 100; guard++) {
      if (app.state.requests.some((r) => r.layer === 'structural')) break;
      app.pushLiveRequest();
    }
    const { host, dispose } = mount();
    try {
      clickByText(host, '.nav-item span', 'Requests');
      const index = app.state.requests.findIndex((r) => r.layer === 'structural');
      expect(index).toBeGreaterThanOrEqual(0);
      const row = host.querySelectorAll<HTMLElement>('.req-row')[index];
      expect(row).toBeDefined();
      row?.click();
      expect(app.state.selId).toBe(app.state.requests[index]?.id);
      const drawer = host.querySelector('.drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent).toContain('Decision trace');
      expect(drawer?.textContent).toContain('Structural features (L1)');
      expect(drawer?.textContent).toContain('price snapshot');
      expect(drawer?.textContent).toContain('routing decision');
      host.querySelector<HTMLElement>('.overlay')?.click();
      expect(app.state.selId).toBeNull();
    } finally {
      dispose();
    }
  });

  it('toggles the theme, persists it, and re-applies it on a fresh mount', () => {
    const first = mount();
    try {
      clickByText(first.host, '.theme-toggle span', 'Switch to dark');
      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(localStorage.getItem('polyrouter-theme')).toBe('dark');
    } finally {
      first.dispose();
    }
    // simulate a reload: fresh mount must re-apply the stored theme in onMount
    delete document.documentElement.dataset['theme'];
    const second = mount();
    try {
      expect(document.documentElement.dataset['theme']).toBe('dark');
    } finally {
      second.dispose();
    }
  });

  it('enforces the 5-model tier cap through the Routing UI with a toast', () => {
    const { host, dispose } = mount();
    try {
      clickByText(host, '.nav-item span', 'Routing');
      const firstTierCard = host.querySelector<HTMLElement>('.panel');
      expect(firstTierCard).not.toBeNull();
      if (!firstTierCard) return;
      const addViaSelect = (): void => {
        const select = firstTierCard.querySelector<HTMLSelectElement>('select');
        if (!select) throw new Error('add-model select missing');
        const option = [...select.options].find((o) => o.value !== '');
        if (!option) throw new Error('no addable models left');
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const rows = () => firstTierCard.querySelectorAll('.chain-row').length;
      const start = rows();
      addViaSelect();
      addViaSelect();
      expect(rows()).toBe(Math.min(5, start + 2));
      addViaSelect(); // 6th — must be rejected with the toast
      expect(rows()).toBe(5);
      expect(host.querySelector('.toast')?.textContent).toBe('Max 5 models per tier');
    } finally {
      dispose();
    }
  });
});
