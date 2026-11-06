/** Costs page subscription/cash split (split-subscription-spend).
 *
 * The headline reports money owed. A subscription request is prepaid at a flat monthly
 * rate, so its recorded cost — the vendor's API rate for that traffic — is reported
 * BESIDE the headline, never inside it.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsSummary } from './data/api';
import { App } from './App';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_SUMMARY, FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mountCosts(summary: Partial<AnalyticsSummary>): Promise<{
  host: HTMLElement;
  dispose: () => void;
}> {
  const fake = new FakeApiClient({ summary: { ...DEFAULT_SUMMARY, ...summary } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <AppProvider store={createAppStore(fake)}>
        <App live={false} />
      </AppProvider>
    ),
    host,
  );
  await flush();
  const nav = [...host.querySelectorAll<HTMLElement>('.nav-item span')].find(
    (e) => e.textContent?.trim() === 'Costs',
  );
  nav?.click();
  await flush();
  return {
    host,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Costs — subscription value sits beside spend, never inside it', () => {
  it('reports cash in the headline and subscription separately', async () => {
    const h = await mountCosts({ spend: 2, subscriptionSpend: 5, cashSpend: 2 });
    try {
      expect(h.host.textContent).toContain('$2.00');
      // Case-insensitive since the readout strip (adopt-design-tokens-v2 task 12.2): the value
      // is now its own cell, labelled "Served on subscription" (notes/flags.md F9).
      expect(h.host.textContent).toMatch(/served on subscription/i);
      expect(h.host.textContent).toContain('5.0000');
      // The headline must not silently present a combined total.
      expect(h.host.textContent).toContain('excludes subscription');
      expect(h.host.textContent).not.toContain('$7.00');
    } finally {
      h.dispose();
    }
  });

  it('renders no subscription line at all when the range has none', async () => {
    const h = await mountCosts({ spend: 2, subscriptionSpend: 0, cashSpend: 2 });
    try {
      // Absent, not a "$0.00 on subscription" claim.
      // Case-insensitive, or the capitalised cell label would pass this vacuously (F9).
      expect(h.host.textContent).not.toMatch(/served on subscription/i);
    } finally {
      h.dispose();
    }
  });

  it('discloses unclassified spend rather than calling it cash', async () => {
    const h = await mountCosts({ spend: 3, cashSpend: 1, unknownSpend: 2 });
    try {
      expect(h.host.textContent).toContain('before subscription tracking');
    } finally {
      h.dispose();
    }
  });

  it('hides the unclassified note once history has aged out', async () => {
    const h = await mountCosts({ spend: 3, cashSpend: 3, unknownSpend: 0 });
    try {
      expect(h.host.textContent).not.toContain('before subscription tracking');
    } finally {
      h.dispose();
    }
  });
});

describe('Costs — the four-way request mix', () => {
  it('shows every category with a count beside its percentage', async () => {
    const h = await mountCosts({
      freeRequests: 5,
      subscriptionPricedRequests: 3,
      cashPricedRequests: 1,
      unpricedRequests: 1,
    });
    try {
      const text = h.host.textContent ?? '';
      expect(text).toContain('free 50% (5)');
      expect(text).toContain('subscription 30% (3)');
      expect(text).toContain('other priced 10% (1)');
      expect(text).toContain('unpriced 10% (1)');
      // "API keys only" would be false — the cash bucket also holds custom/local rows.
      expect(text).not.toContain('API key');
    } finally {
      h.dispose();
    }
  });

  it('keeps the two priced categories adjacent and in one accent family', async () => {
    const h = await mountCosts({
      freeRequests: 5,
      subscriptionPricedRequests: 3,
      cashPricedRequests: 1,
      unpricedRequests: 1,
    });
    try {
      const bar = h.host.querySelector<HTMLElement>('[data-testid="mix-bar"]');
      const segs = [...(bar?.children ?? [])] as HTMLElement[];
      expect(segs).toHaveLength(4);
      // Order matters: subscription and cash sit next to each other so the pair still
      // reads as one "paid" block subdivided.
      expect(segs[1]?.style.background).toBe('var(--accent-bg)');
      expect(segs[2]?.style.background).toBe('var(--accent)');
      // A single-accent lock — no second hue was introduced for the fourth segment.
      expect(segs.map((s) => s.style.background)).not.toContain('var(--amber)');
    } finally {
      h.dispose();
    }
  });

  it('keeps a non-zero category visible instead of rounding it away', async () => {
    const h = await mountCosts({
      freeRequests: 999,
      subscriptionPricedRequests: 1,
      cashPricedRequests: 0,
      unpricedRequests: 0,
    });
    try {
      const bar = h.host.querySelector<HTMLElement>('[data-testid="mix-bar"]');
      const segs = [...(bar?.children ?? [])] as HTMLElement[];
      // 1 of 1000 rounds to 0% — it must still be drawn, or the card would claim the
      // category is empty.
      expect(parseFloat(segs[1]?.style.width ?? '0')).toBeGreaterThan(0);
      // A genuinely empty category stays empty.
      expect(parseFloat(segs[3]?.style.width ?? '0')).toBe(0);
    } finally {
      h.dispose();
    }
  });
});

describe('Costs — requests no provider ran are captioned, not counted (zero-cost-unbilled-errors)', () => {
  // 8 free + 20 paid ran; 6 more were never sent or were rejected. `requests` counts all 34
  // and the mix is computed over the 28 that ran.
  const RAN_AND_NOT_BILLED = {
    requests: 34,
    freeRequests: 8,
    subscriptionPricedRequests: 0,
    cashPricedRequests: 20,
    unpricedRequests: 0,
    notBilledRequests: 6,
  };

  it('computes the segments over the 28 requests that ran and shows a muted "6 not billed" caption', async () => {
    const h = await mountCosts(RAN_AND_NOT_BILLED);
    try {
      const text = h.host.textContent ?? '';
      // 8/28 = 29% and 20/28 = 71%. Over 34 they would read 24% and 59% — the 6 not-billed
      // rows must not sit in the denominator, and must not inflate "free".
      expect(text).toContain('free 29% (8)');
      expect(text).toContain('other priced 71% (20)');
      const caption = h.host.querySelector<HTMLElement>('[data-testid="not-billed-caption"]');
      expect(caption?.textContent).toContain('6 not billed');
      // Muted, never a new colour: the existing text3 token.
      expect(caption?.getAttribute('style')).toContain('var(--text3)');
      // No fifth category: still exactly four bar segments and four legend entries.
      const bar = h.host.querySelector<HTMLElement>('[data-testid="mix-bar"]');
      expect(bar?.children).toHaveLength(4);
      const widths = [...(bar?.children ?? [])].map((s) =>
        parseFloat((s as HTMLElement).style.width),
      );
      expect(widths).toEqual([29, 0, 71, 0]);
    } finally {
      h.dispose();
    }
  });

  it('renders no caption, and the mix exactly as before, when the range has none', async () => {
    const h = await mountCosts({ ...RAN_AND_NOT_BILLED, requests: 28, notBilledRequests: 0 });
    try {
      expect(h.host.querySelector('[data-testid="not-billed-caption"]')).toBeNull();
      expect(h.host.textContent).not.toContain('not billed');
      expect(h.host.textContent).toContain('free 29% (8)');
    } finally {
      h.dispose();
    }
  });
});
