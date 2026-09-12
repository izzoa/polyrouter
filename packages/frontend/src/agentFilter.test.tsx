/** The requests agent filter (add-agent-request-attribution, task groups 4 and 5).
 *
 * Three of these assert things that are silently wrong rather than visibly broken:
 * a probe that ignores the filter (announcing "N new" for traffic you filtered
 * out), an agent id surviving a principal change, and a live band emptied with no
 * disclosure. None would fail a type check or show up on screen as an error.
 */
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Requests } from './pages/Requests';
import { agentToRequestParams } from './data/analytics';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { buildRequestRows, DEFAULT_SESSION, FakeApiClient } from './test/fakeClient';
import type { BatchJobDto, InflightRow, RequestsQuery } from './data/api';

/** Two live in-flight rows. The DEFAULT fake returns an EMPTY in-flight snapshot and
 * no batch jobs, so a band test that did not seed these would assert nothing at all
 * while passing — the exact failure this fixture exists to prevent. */
const LIVE: InflightRow[] = [
  {
    id: 'live-1',
    startedAt: Date.now() - 1_200,
    decisionLayer: 'explicit',
    tierAssigned: 'default',
    modelLabel: 'gpt-4o',
    providerLabel: 'OpenAI',
    protocol: 'openai',
    status: 'running',
  },
  {
    id: 'live-2',
    startedAt: Date.now() - 400,
    decisionLayer: 'header',
    tierAssigned: 'utility',
    modelLabel: 'haiku',
    providerLabel: 'Anthropic',
    protocol: 'anthropic',
    status: 'running',
  },
];

const job = (id: string, agentId: string | null): BatchJobDto => ({
  id,
  upstreamBatchId: `up_${id}`,
  status: 'in_progress',
  terminal: false,
  endpoint: '/v1/chat/completions',
  agentId,
  providerId: 'p1',
  providerLabel: 'OpenAI',
  modelId: 'm1',
  modelLabel: 'gpt-4o',
  tierAssigned: 'default',
  counts: { total: 10, completed: 2, failed: 0 },
  submittedAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:05:00.000Z',
  terminalAt: null,
  reservedCeilingMicros: 1000,
  settledCostMicros: null,
  resultsExpireAt: null,
  errorKind: null,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

describe('agentToRequestParams (pure)', () => {
  it('contributes nothing when there is no selection', () => {
    expect(agentToRequestParams(null)).toEqual({});
    // Defensive: an empty string is a 400 server-side, so it must never be sent.
    expect(agentToRequestParams('')).toEqual({});
  });
  it('sends the id when one is selected', () => {
    expect(agentToRequestParams('agent-1')).toEqual({ agentId: 'agent-1' });
  });
});

describe('the agent filter travels with the window, the probe and the identity', () => {
  let fake: FakeApiClient;
  let store: AppStore;

  beforeEach(() => {
    // 90 rows cycle three agents, so agent-1 owns 30 — more than the 25-row page
    // size, which is what makes the append path reachable at all. The DEFAULT 30
    // rows give agent-1 only 10 and silently remove page 2 from existence.
    fake = new FakeApiClient({ requestRows: buildRequestRows(90) });
    store = createAppStore(fake);
  });

  const lastRequestsQuery = (): RequestsQuery =>
    fake.lastArgs('requests')?.[0] as RequestsQuery;

  it('sends the agent on the listing query and composes with the routing filter', async () => {
    store.setAgentFilter('agent-1');
    await flush();
    expect(lastRequestsQuery().agentId).toBe('agent-1');

    // Composition: the routing chips are a SEPARATE axis and must survive.
    store.setFilter('escalated');
    await flush();
    const q = lastRequestsQuery();
    expect(q.agentId).toBe('agent-1');
    expect(q.escalated).toBe(true);

    // …and the mode axis too.
    store.setMode('batch');
    await flush();
    const q2 = lastRequestsQuery();
    expect(q2.agentId).toBe('agent-1');
    expect(q2.mode).toBe('batch');
    expect(q2.escalated).toBe(true);
  });

  it('freezes the agent onto the window, so a page-2 append stays on the same agent', async () => {
    store.setAgentFilter('agent-1');
    await flush();
    expect(store.state.requestWindow?.agentId).toBe('agent-1');

    // The append path must reuse the FROZEN window, or page 2 would be a different
    // agent's rows stitched onto page 1. Asserted, not guarded: without a cursor
    // there is no second page and this test would pass by not running.
    expect(store.state.requestCursor, 'the fixture produced only one page').not.toBeNull();
    await store.loadRequests(false);
    expect(lastRequestsQuery().agentId).toBe('agent-1');
    expect(lastRequestsQuery().cursor).toBeDefined();
  });

  it('probes for new rows under the SAME agent, not unfiltered', async () => {
    store.setAgentFilter('agent-1');
    await flush();
    // Put the store into a paging session so the freshness path probes rather
    // than reloading, and age the window so the probe's range is non-empty.
    await store.loadRequests(false);
    await flush();
    const before = fake.countOf('requests');
    await store.requestAggregateRefresh(() => store.refreshRequestsPage(), true);
    await flush();
    // Asserted, not guarded: a refresh that issued no call would make the agent
    // assertion below vacuous, which is the bug this test exists to catch.
    expect(fake.countOf('requests'), 'the refresh issued no query').toBeGreaterThan(before);
    expect(lastRequestsQuery().agentId).toBe('agent-1');
  });

  it('clears the agent on a principal change — an agent id belongs to one tenant', async () => {
    await store.bootstrap();
    store.setAgentFilter('agent-1');
    await flush();
    expect(store.state.reqAgentId).toBe('agent-1');

    // The same switch the identity-scope suites use: a different session, then
    // re-bootstrap — which is what calls `resetIdentityScoped`.
    fake.session = { ...DEFAULT_SESSION, userId: 'user-B', email: 'b@x.test' };
    await store.bootstrap();
    await flush();

    expect(store.state.reqAgentId).toBeNull();
    // The routing filter is a display preference and is deliberately KEPT — the
    // asymmetry is the point of this test.
    expect(store.state.reqFilter).toBeDefined();
  });
});

describe('the live bands under an agent filter', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const mount = (store: AppStore): HTMLElement => {
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(
      () => (
        <AppProvider store={store}>
          <Requests live={false} />
        </AppProvider>
      ),
      host,
    );
    return host;
  };

  it('discloses hidden in-flight work rather than emptying the band silently', async () => {
    const fake = new FakeApiClient({
      inflight: { items: LIVE, available: true, truncated: false },
    });
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadInflight();
    await flush();

    // The band is genuinely populated — otherwise everything below is vacuous.
    expect(store.state.inflightRows.length, 'the fixture seeded no live rows').toBe(2);
    // With no filter there is no disclosure: a permanent banner would be noise.
    expect(host.querySelector('.rs-inflight-hidden')).toBeNull();

    store.setAgentFilter('agent-1');
    await flush();

    // Work exists and cannot be attributed: the page must SAY so.
    const notice = host.querySelector('.rs-inflight-hidden');
    expect(notice, 'the in-flight band emptied with no disclosure').not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent ?? '').toMatch(/attributed/i);
    expect(notice?.textContent ?? '').toContain('2');

    store.setAgentFilter(null);
    await flush();
    expect(host.querySelector('.rs-inflight-hidden')).toBeNull();
  });

  it('shows no disclosure when the filter hides nothing', async () => {
    // Nothing running: an agent filter must NOT render a notice about absent work.
    const fake = new FakeApiClient();
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadInflight();
    store.setAgentFilter('agent-1');
    await flush();
    expect(store.state.inflightRows).toHaveLength(0);
    expect(host.querySelector('.rs-inflight-hidden')).toBeNull();
  });

  it('filters the batch band rather than emptying it — a job carries its agent', async () => {
    const fake = new FakeApiClient({
      batchJobs: [job('j-a', 'agent-1'), job('j-b', 'agent-2'), job('j-c', 'agent-1')],
    });
    const store = createAppStore(fake);
    const host = mount(store);
    await store.loadBatchBand();
    await flush();
    expect(store.state.batchRows.length, 'the fixture seeded no jobs').toBe(3);
    expect(host.querySelectorAll('[data-batch-row]')).toHaveLength(3);

    store.setAgentFilter('agent-1');
    await flush();
    // FILTERED, not emptied: the two agent-1 jobs survive and agent-2's does not.
    // This is the half the in-flight band cannot do, because a job carries its agent.
    const rendered = [...host.querySelectorAll('[data-batch-row]')].map((e) =>
      e.getAttribute('data-batch-row'),
    );
    expect(rendered).toEqual(['j-a', 'j-c']);

    store.setAgentFilter('agent-3');
    await flush();
    expect(host.querySelectorAll('[data-batch-row]')).toHaveLength(0);
  });
});
