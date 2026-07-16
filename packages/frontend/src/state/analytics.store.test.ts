import { describe, expect, it } from 'vitest';
import { ApiError, type AnalyticsRangeParams, type AnalyticsSummary } from '../data/api';
import { DEFAULT_SESSION, DEFAULT_SUMMARY, FakeApiClient } from '../test/fakeClient';
import { createAppStore } from './appState';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fake whose `summary` resolution is deferred so response ordering is testable. */
class DeferredSummaryFake extends FakeApiClient {
  private resolvers: ((v: AnalyticsSummary) => void)[] = [];
  override summary(_range: AnalyticsRangeParams): Promise<AnalyticsSummary> {
    return new Promise<AnalyticsSummary>((resolve) => this.resolvers.push(resolve));
  }
  resolveSummary(index: number, value: AnalyticsSummary): void {
    this.resolvers[index]?.(value);
  }
}

describe('Observe loaders', () => {
  it('loadOverview populates summary, series, model breakdown and recent requests', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    await s.loadOverview();
    expect(s.state.analyticsSummary?.requests).toBe(30);
    expect(s.state.analyticsSeries.length).toBeGreaterThan(0);
    expect(s.state.analyticsBreakdown.model.length).toBeGreaterThan(0);
    expect(s.state.recentRequests.length).toBe(6);
  });

  it('loadCosts populates all three breakdown dimensions', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    await s.loadCosts();
    expect(s.state.analyticsBreakdown.model.length).toBeGreaterThan(0);
    expect(s.state.analyticsBreakdown.provider.length).toBeGreaterThan(0);
    expect(s.state.analyticsBreakdown.agent.length).toBeGreaterThan(0);
  });
});

describe('generation guard (per shared slice)', () => {
  it('discards a stale summary response even if it resolves last', async () => {
    const fake = new DeferredSummaryFake({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    const a: AnalyticsSummary = { ...DEFAULT_SUMMARY, requests: 111 };
    const b: AnalyticsSummary = { ...DEFAULT_SUMMARY, requests: 222 };

    void s.loadOverview(); // call A → summary[0] pending
    void s.loadOverview(); // call B → summary[1] pending (newer)
    // Resolve the NEWER call first, then the older one — the older must be dropped.
    fake.resolveSummary(1, b);
    fake.resolveSummary(0, a);
    await flush();

    expect(s.state.analyticsSummary?.requests).toBe(222);
  });
});

describe('requests window + pagination', () => {
  it('freezes the window on reset and appends over it with no dupes/skips', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    await s.loadRequests(true);
    expect(s.state.requestWindow).not.toBeNull();
    const firstWindow = s.state.requestWindow;
    expect(s.state.requestList.length).toBe(25);
    expect(s.state.requestCursor).not.toBeNull();

    await s.loadRequests(false); // append reuses the frozen window + cursor
    expect(s.state.requestWindow).toEqual(firstWindow); // window unchanged by append
    expect(s.state.requestList.length).toBe(30);
    expect(s.state.requestCursor).toBeNull();

    const ids = s.state.requestList.map((r) => r.id);
    expect(new Set(ids).size).toBe(30); // no duplicates
    expect(ids).toEqual(Array.from({ length: 30 }, (_v, i) => `req-${String(i).padStart(3, '0')}`));
  });

  it('setFilter re-freezes and narrows the list server-side', async () => {
    const s = createAppStore(new FakeApiClient({ session: DEFAULT_SESSION }));
    await s.loadRequests(true);
    s.setFilter('fallback');
    await flush();
    expect(s.state.requestList.length).toBeGreaterThan(0);
    expect(s.state.requestList.every((r) => r.status === 'fallback')).toBe(true);
    expect(s.state.requestWindow?.filter).toBe('fallback');
  });
});

describe('error handling', () => {
  it('keeps the last-good summary and exposes the error on a failed reload', async () => {
    const fake = new FakeApiClient({ session: DEFAULT_SESSION });
    const s = createAppStore(fake);
    await s.loadOverview();
    expect(s.state.analyticsSummary?.requests).toBe(30);

    fake.analyticsFailure = new ApiError(500, 'Internal', 'boom');
    await s.loadOverview();
    expect(s.state.analyticsSummaryError).toBe('boom');
    expect(s.state.analyticsSummary?.requests).toBe(30); // last-good retained
  });
});
