/** The aggregate analytics slices are identity-scoped (fix-analytics-identity-scope).
 *
 * `runSlice` drives `summary`, `series`, `breakdown` and `recent`. Its guard is a slice
 * token, and its own comment says what that token is for: *"a stale (old-range) reply can't
 * overwrite newer state"* — range, not identity. So an account's spend totals, timeseries
 * and cost breakdowns survived a switch, and a response begun under the previous owner could
 * still commit under the next.
 *
 * Fixed in the RUNNER rather than per caller, so every current caller is covered at once and
 * every future one by default — a per-loader fix has to be remembered each time, which is
 * how the gap appeared.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsSummary } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { DEFAULT_SESSION, DEFAULT_SUMMARY, FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Holds each `summary` call open individually, so a response can land AFTER the switch. */
class HeldClient extends FakeApiClient {
  readonly summaries: ((s: AnalyticsSummary) => void)[] = [];
  hold = true;
  override summary(range: { from: string; to: string }): Promise<AnalyticsSummary> {
    if (!this.hold) return super.summary(range);
    return new Promise((resolve) => this.summaries.push(resolve));
  }
}

const A_SPEND: AnalyticsSummary = { ...DEFAULT_SUMMARY, spend: 4242.42, requests: 999 };

async function switchAccount(store: AppStore, client: FakeApiClient): Promise<void> {
  client.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
  await store.bootstrap();
  await flush();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe("a previous account's aggregates cannot commit or linger", () => {
  it('discards a summary response that lands after the account changed', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadOverview(); // begun as A
    await flush();
    expect(client.summaries.length, 'the load did not reach the client').toBeGreaterThan(0);

    client.hold = false;
    await switchAccount(store, client);

    client.summaries[0]?.(A_SPEND); // A's spend lands only now
    await flush();

    expect(
      store.state.analyticsSummary?.spend,
      "a previous account's spend was committed",
    ).not.toBe(4242.42);
  });

  it('clears aggregates already on screen at the boundary', async () => {
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadOverview();
    await flush();
    client.summaries[0]?.(A_SPEND);
    await flush();
    expect(store.state.analyticsSummary?.spend).toBe(4242.42);

    client.hold = false;
    await switchAccount(store, client);

    // Guarding the in-flight response alone would leave A's figures on screen.
    expect(
      store.state.analyticsSummary,
      "A's spend totals were still displayed to B",
    ).toBeNull();
    expect(store.state.analyticsSeries).toEqual([]);
    expect(store.state.analyticsBreakdown.model).toEqual([]);
    expect(store.state.analyticsBreakdown.provider).toEqual([]);
    expect(store.state.analyticsBreakdown.agent).toEqual([]);
  });

  it('does not latch a loading indicator', async () => {
    // Same trap as the request view: a superseded slice's completion path is inert by
    // design, so the boundary has to normalise the indicator itself.
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadOverview();
    await flush();
    expect(store.state.analyticsSummaryLoading).toBe(true);

    client.hold = false;
    await switchAccount(store, client);
    client.summaries[0]?.(A_SPEND);
    await flush();

    expect(store.state.analyticsSummaryLoading, 'stuck loading forever').toBe(false);
    expect(store.state.analyticsSummaryError).toBeNull();
  });
});

describe('the ordinary within-identity guard still works', () => {
  it('keeps the NEWER of two loads when the older lands last', async () => {
    // The slice token's original job. Adding identity awareness must not break it.
    const client = new HeldClient({});
    const store = createAppStore(client);
    await store.bootstrap();

    void store.loadOverview(); // older
    await flush();
    void store.loadOverview(); // newer
    await flush();
    expect(client.summaries.length).toBeGreaterThanOrEqual(2);

    client.summaries[1]?.({ ...DEFAULT_SUMMARY, spend: 22 }); // newer lands first
    await flush();
    client.summaries[0]?.({ ...DEFAULT_SUMMARY, spend: 11 }); // older lands last
    await flush();

    expect(store.state.analyticsSummary?.spend, 'the stale reply won').toBe(22);
  });
});
