/**
 * The request inspector's Route Trace and Price Receipt on screen (add-route-trace-inspector
 * tasks 4.1, 4.3 and 4.5; design D5–D8; dashboard-analytics "The inspector draws the recorded
 * route as a trace", "The route trace lights only a served outcome", "The route trace states
 * every outcome in text", "The inspector's Decision section states the served tier" and the
 * price-receipt requirements; DESIGN.md Route Trace, Price Receipt).
 *
 * The real App renders the Requests page on a fake client with the real stylesheet loaded, and
 * the inspector is opened on rows of each shape the trace draws: an `error` row with its ERROR
 * card, a recovered `fallback` row with a failed and a skipped member, a `success` row with no
 * agent, an escalated cascade row whose superseded call sits between its legs, and a settled
 * batch item. The node rules themselves are table-driven in `data/analytics.test.ts`; this
 * asserts they reach the screen as an ordered list of text, with the decoration hidden.
 *
 * happy-dom resolves `font-family` and `white-space` from the stylesheet in `getComputedStyle`
 * (neither is layout); widths, the 32px gutter and the 20px chip are measured in the browser
 * suites (`browser/responsive.spec.ts`, `browser/heightFamily.spec.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { SKIP_LABEL, TRACE_NOT_RECORDED } from './data/analytics';
import type { RequestRow, TierDto, TierEntryDto } from './data/api';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { buildRequestRows, FakeApiClient, type FakeOptions } from './test/fakeClient';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const BASE = buildRequestRows(1)[0]!;
const at = (n: number): string =>
  new Date(Date.parse('2026-11-03T12:00:00Z') - n * 1000).toISOString();

/** A settled row with nothing the trace would draw beyond source, decision and outcome. */
const plain: Partial<RequestRow> = {
  status: 'success',
  decisionLayer: 'explicit',
  routingReason: 'explicit model requested',
  routingHeaderName: null,
  routingHeaderValue: null,
  tierAssigned: null,
  escalated: false,
  escalationSource: null,
  qualitySignal: null,
  attemptFailures: null,
  attemptCostMicros: 0,
  agentLabel: 'billing-bot',
  providerLabel: 'Provider C',
  modelLabel: 'model-c',
  durationMs: 1_240,
  cost: 0.0123,
  billed: true,
  priceSource: 'bundled',
  priceEstimated: false,
  usageEstimated: false,
  priceMode: null,
  batchId: null,
  hasBodies: false,
  workloadClass: null,
  workloadSource: null,
  semanticSource: null,
  semanticBand: null,
  errorKind: null,
  errorStatus: null,
  errorMessage: null,
  errorRequestId: null,
  errorMarkers: null,
};

/** The fixture rows, newest first. */
const ROWS: Record<'error' | 'fallback' | 'success' | 'cascade' | 'batch', RequestRow> = {
  // An exhausted chain: its terminal member is a dispatched failure, so the outcome reads
  // `Provider A · failed · 2.10s` and names no model again. Its one member is the recorded
  // provider, so that provider is the last one tried (flag RF-1).
  error: {
    ...BASE,
    ...plain,
    id: 'rt-error',
    createdAt: at(0),
    status: 'error',
    providerId: 'p1',
    providerLabel: 'Provider A',
    durationMs: 2_100,
    errorKind: 'rate_limit',
    errorStatus: 429,
    errorMessage: 'Rate limit reached for requests',
    errorRequestId: 'req_upstream_1',
    attemptFailures: [
      {
        index: 0,
        providerId: 'p1',
        model: 'gpt-a',
        kind: 'rate_limit',
        status: 429,
        dispatched: true,
        terminal: true,
      },
    ],
  },
  // A recovered request: A rate-limited with HTTP 429, B skipped (circuit open), C served.
  fallback: {
    ...BASE,
    ...plain,
    id: 'rt-fallback',
    createdAt: at(1),
    status: 'fallback',
    decisionLayer: 'header',
    routingReason: 'header x-polyrouter-tier: heavy → rate_limit@gpt-a → skip@gpt-b → model-c',
    routingHeaderName: 'x-polyrouter-tier',
    routingHeaderValue: 'heavy',
    tierAssigned: 'heavy',
    attemptFailures: [
      {
        index: 0,
        providerId: 'p1',
        model: 'gpt-a',
        kind: 'rate_limit',
        status: 429,
        dispatched: true,
        markers: ['rate_limit_exceeded'],
      },
      { index: 1, providerId: 'p2', model: 'gpt-b', kind: 'unavailable', dispatched: false },
    ],
  },
  // A keyless request, priced exactly, with no tier.
  success: {
    ...BASE,
    ...plain,
    id: 'rt-success',
    createdAt: at(2),
    agentId: null,
    agentLabel: null,
    durationMs: 412,
  },
  // design D2: a cheap-leg failure, the superseded call, an escalation-leg failure, the outcome.
  cascade: {
    ...BASE,
    ...plain,
    id: 'rt-cascade',
    createdAt: at(3),
    status: 'fallback',
    decisionLayer: 'cascade',
    routingReason: 'cascade cheap → quality_gate q=0.42 → strong',
    tierAssigned: 'default',
    escalated: true,
    escalationSource: 'quality_gate',
    qualitySignal: 0.42,
    attemptCostMicros: 3_100,
    cost: 0.012346,
    providerLabel: 'Provider S',
    modelLabel: 'model-strong',
    attemptFailures: [
      {
        index: 0,
        providerId: 'p1',
        model: 'cheap-a',
        kind: 'timeout',
        dispatched: true,
        leg: 'cheap',
      },
      {
        index: 0,
        providerId: 'p2',
        model: 'strong-a',
        kind: 'server_error',
        status: 503,
        dispatched: true,
        leg: 'escalation',
      },
    ],
  },
  // A settled batch item: its latency is the job's wall time.
  batch: {
    ...BASE,
    ...plain,
    id: 'rt-batch',
    createdAt: at(4),
    batchId: 'batch_01',
    priceMode: 'batch',
    durationMs: 7_412_300,
    routingReason: 'explicit model requested (batch)',
  },
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  client: FakeApiClient;
  dispose: () => void;
}

let h: Harness | null = null;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
});

afterEach(() => {
  h?.dispose();
  h = null;
  sheet.remove();
  document.body.innerHTML = '';
});

async function mount(
  rows: RequestRow[] = Object.values(ROWS),
  opts: Omit<FakeOptions, 'requestRows'> = {},
): Promise<Harness> {
  const client = new FakeApiClient({ ...opts, requestRows: rows });
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
  store.go('requests');
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

/** Opens the inspector on one fixture row and returns its root. */
async function open(id: keyof typeof ROWS): Promise<HTMLElement> {
  return openRow(ROWS[id].id);
}

/** Opens the inspector on a mounted row by its id and returns its root. */
async function openRow(rowId: string): Promise<HTMLElement> {
  h ??= await mount();
  h.store.select(rowId);
  await flush();
  const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer');
  if (drawer === null) throw new Error(`the inspector did not open on ${rowId}`);
  return drawer;
}

const trace = (drawer: HTMLElement): HTMLOListElement => {
  const ol = drawer.querySelector<HTMLOListElement>('ol.rt');
  if (ol === null) throw new Error('no route trace');
  return ol;
};
const items = (drawer: HTMLElement): HTMLLIElement[] => [
  ...trace(drawer).querySelectorAll<HTMLLIElement>(':scope > li'),
];
const texts = (drawer: HTMLElement): string[] =>
  items(drawer).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());

/** The Decision section's row value, found by its key. */
function decisionRow(drawer: HTMLElement, key: string): HTMLElement | null {
  const box = drawer.querySelector('[data-testid="inspector-decision"]');
  const row = [...(box?.querySelectorAll<HTMLElement>(':scope > div') ?? [])].find(
    (d) => d.firstElementChild?.textContent === key,
  );
  return (row?.lastElementChild as HTMLElement | null | undefined) ?? null;
}

/** A stylesheet rule's body, whitespace-collapsed (the `notices.view.test.tsx` pattern). */
const rule = (sel: string): string => {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(
    css,
  );
  expect(m, `${sel} is declared`).not.toBeNull();
  return m![1]!.replace(/\s+/g, ' ').trim();
};

const family = (el: Element): string => getComputedStyle(el).fontFamily.replace(/["']/g, '');

/** Does `a` come before `b` in document order? */
const before = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the inspector draws the recorded route as a trace (task 4.1)', () => {
  it('the ERROR card sits above the trace, and the routing reason below it', async () => {
    const drawer = await open('error');
    const card = drawer.querySelector('[data-testid="inspector-error"]');
    expect(card, 'an error row with detail shows its card').not.toBeNull();
    const ol = trace(drawer);
    const reason = decisionRow(drawer, 'routing reason');
    expect(reason?.textContent).toBe(ROWS.error.routingReason);
    expect(before(card!, ol), 'the ERROR card comes first').toBe(true);
    expect(before(ol, reason!), 'the reason row comes after the trace').toBe(true);
    // The trace still renders beneath the card, ending in its unlit outcome.
    expect(texts(drawer)).toEqual([
      'billing-bot',
      'router · explicit',
      'gpt-a · rate_limit · HTTP 429',
      'Provider A · failed · 2.10s',
    ]);
    // The receipt follows the Decision section; nothing of the removed layout is left.
    const receipt = drawer.querySelector('[data-testid="inspector-receipt"]')!;
    expect(before(reason!, receipt)).toBe(true);
    expect(drawer.textContent).not.toContain('Fallback trail');
    expect(drawer.textContent).not.toContain('Timing');
    expect(drawer.textContent).not.toContain('Usage & cost');
  });

  it('the ERROR label and headline are the red text token', async () => {
    const drawer = await open('error');
    const card = drawer.querySelector<HTMLElement>('[data-testid="inspector-error"]')!;
    const label = card.querySelector<HTMLElement>('.upper-label')!;
    expect(label.textContent?.trim()).toBe('Error');
    const headline = [...card.querySelectorAll<HTMLElement>('span')].find(
      (s) => s.textContent === 'rate_limit · HTTP 429',
    );
    expect(headline, 'the card headline').toBeDefined();
    // happy-dom resolves the custom property from the loaded sheet, so the computed colour is
    // the token's own value: the text token, never the `--red` fill.
    const root = getComputedStyle(document.documentElement);
    const redText = root.getPropertyValue('--red-text').trim();
    expect(redText, 'the stylesheet defines --red-text').not.toBe('');
    expect(redText).not.toBe(root.getPropertyValue('--red').trim());
    for (const el of [label, headline!]) {
      expect(el.style.color).toBe('var(--red-text)');
      expect(getComputedStyle(el).color).toBe(redText);
    }
  });

  it('a fallback row reads its walk in order, as an ordered list of text', async () => {
    const drawer = await open('fallback');
    expect(trace(drawer).tagName).toBe('OL');
    // `.rt` removes the list markers, and WebKit stops exposing a marker-less list as a list
    // (VoiceOver reads its items as plain text), so the list role is explicit.
    expect(trace(drawer).getAttribute('role')).toBe('list');
    expect(texts(drawer)).toEqual([
      'billing-bot',
      'router · header',
      'gpt-a · rate_limit · HTTP 429 · rate_limit_exceeded',
      `gpt-b · ${SKIP_LABEL}`,
      'Provider C · model-c · served · 1.24s',
    ]);
    // A recovered row with recorded attempts carries no not-recorded caption.
    expect(drawer.textContent).not.toContain(TRACE_NOT_RECORDED);
    // No node is drawn for a member the request never walked, and no raw agent id shows.
    expect(drawer.querySelector('ol.rt')!.textContent).not.toContain(BASE.agentId ?? 'agent-0');
  });

  it("a deleted agent's request reads `(no agent)` on its source node, never the raw id", async () => {
    // dashboard-analytics "The source node never shows a raw id": the agent id is recorded but
    // its label no longer resolves (the agent was deleted), the shape where the old chip row's
    // `labelOf(agentLabel, agentId)` printed the id.
    const deleted: RequestRow = {
      ...ROWS.success,
      id: 'rt-deleted-agent',
      agentId: 'agent-raw-7f3a',
      agentLabel: null,
    };
    h = await mount([deleted, ROWS.fallback]);
    const drawer = await openRow(deleted.id);
    const source = items(drawer)[0]!;
    expect(source.dataset['kind']).toBe('source');
    expect(source.textContent).toBe('(no agent)');
    expect(trace(drawer).textContent).not.toContain('agent-raw-7f3a');
    // A request whose label is present reads that label.
    const labelled = await open('fallback');
    expect(items(labelled)[0]!.textContent).toBe('billing-bot');
  });

  it('editing the tier afterwards (removing B, adding D) leaves the open trace unchanged', async () => {
    // dashboard-analytics "A fallback request draws its walk, not its tier": the request's tier
    // chain was [A, B, C]; A was rate-limited, B skipped, and C served.
    const tier: TierDto = {
      id: 'tier-heavy',
      key: 'heavy',
      displayName: 'Heavy',
      description: null,
      createdAt: at(60),
    };
    const member = (modelId: string, position: number): TierEntryDto => ({
      id: `e-${modelId}`,
      tierId: tier.id,
      modelId,
      position,
      mode: 'any',
      model: null,
    });
    h = await mount(Object.values(ROWS), {
      tiers: [tier],
      tierEntries: { [tier.id]: [member('gpt-a', 0), member('gpt-b', 1), member('model-c', 2)] },
    });
    await h.store.loadRouting();
    await flush();
    const chain = (): string[] => (h!.store.state.tierEntries[tier.id] ?? []).map((e) => e.modelId);
    expect(chain(), 'the store holds the tier as configured').toEqual([
      'gpt-a',
      'gpt-b',
      'model-c',
    ]);
    const walk = texts(await open('fallback'));
    expect(walk).toEqual([
      'billing-bot',
      'router · header',
      'gpt-a · rate_limit · HTTP 429 · rate_limit_exceeded',
      `gpt-b · ${SKIP_LABEL}`,
      'Provider C · model-c · served · 1.24s',
    ]);
    // Today's configuration moves on while the inspector is open: B is removed and D added,
    // and the store reloads it.
    await h.client.replaceTierEntries(tier.id, [
      { modelId: 'gpt-a' },
      { modelId: 'model-c' },
      { modelId: 'model-d' },
    ]);
    await h.store.loadRouting();
    await flush();
    expect(chain(), 'the store saw the edit').toEqual(['gpt-a', 'model-c', 'model-d']);
    const drawer = h.host.querySelector<HTMLElement>('#inspector-drawer');
    expect(drawer, 'the inspector stays open').not.toBeNull();
    expect(texts(drawer!)).toEqual(walk);
    expect(trace(drawer!).textContent).not.toContain('model-d');
  });

  it('every node label may break where it must, never overflowing its column', () => {
    // DESIGN.md Long content: identifiers and agent names wrap with `overflow-wrap: anywhere`
    // in the inspector. The free-text agent and provider names are plain text in the block, so
    // the rule is on the block itself (laid out in browser/responsive.spec.ts, at 320px and
    // 440px, on 80-character names with no break opportunity).
    expect(rule('.rt-text')).toBe('overflow-wrap: anywhere;');
  });

  it('every stroke and node mark is aria-hidden, and no item is', async () => {
    for (const id of ['error', 'fallback', 'cascade'] as const) {
      const drawer = await open(id);
      const lis = items(drawer);
      expect(lis.length).toBeGreaterThanOrEqual(3);
      for (const li of lis) {
        expect(li.getAttribute('aria-hidden'), `${id}: an item is announced`).toBeNull();
        const marks = [...li.querySelectorAll<HTMLElement>('.rt-spine, .rt-branch, .rt-dot')];
        expect(marks.length, `${id}: each node draws a spine and a node mark`).toBeGreaterThan(1);
        for (const m of marks) expect(m.getAttribute('aria-hidden')).toBe('true');
        // The decoration holds no text: every word is in the text block.
        for (const m of marks) expect(m.textContent).toBe('');
        // Decoration is styled spans, never a glyph or a registry icon.
        expect(li.querySelector('svg')).toBeNull();
      }
    }
  });

  it('the failure label is its own Mono red-text span; nothing else in the trace is', async () => {
    const drawer = await open('fallback');
    const failures = [...trace(drawer).querySelectorAll<HTMLElement>('.rt-failure')];
    expect(failures, 'exactly one failure label (the skip label is not one)').toHaveLength(1);
    const failure = failures[0]!;
    expect(failure.textContent).toBe('rate_limit · HTTP 429');
    expect(failure.classList.contains('mono')).toBe(true);
    expect(family(failure)).toMatch(/^Geist Mono,/);
    expect(rule('.rt-failure')).toBe('color: var(--red-text);');
    // The model id, the markers and the leg tag sit outside it.
    const failedLi = failure.closest('li')!;
    expect(failedLi.textContent).toContain('gpt-a');
    expect(failure.textContent).not.toContain('gpt-a');
    expect(failure.textContent).not.toContain('rate_limit_exceeded');
    const skipped = items(drawer).find((li) => li.classList.contains('rt-node--skipped'))!;
    expect(skipped.querySelector('.rt-failure')).toBeNull();
    // On an exhausted chain the unlit `<provider> · failed · <latency>` outcome is not a
    // failure label.
    const error = await open('error');
    const outcome = items(error).at(-1)!;
    expect(outcome.textContent).toBe('Provider A · failed · 2.10s');
    expect(outcome.querySelector('.rt-failure')).toBeNull();
    expect(trace(error).querySelectorAll('.rt-failure')).toHaveLength(1);
  });

  it('the decision chip is the neutral static chip, with no accent token', async () => {
    for (const id of ['success', 'fallback', 'cascade'] as const) {
      const drawer = await open(id);
      const decision = items(drawer).find((li) => li.dataset['kind'] === 'decision')!;
      const chip = decision.querySelector<HTMLElement>('.chip');
      expect(chip, `${id}: the decision chip`).not.toBeNull();
      expect(chip!.textContent).toBe(`router · ${ROWS[id].decisionLayer}`);
      expect(chip!.style.color).toBe('var(--text2)');
      expect(chip!.getAttribute('style') ?? '').not.toMatch(/--accent/);
      expect(decision.classList.contains('rt-node--neutral')).toBe(true);
      // It is the trace's only chip: no node is an inline-padded tag.
      expect(trace(drawer).querySelectorAll('.chip')).toHaveLength(1);
      expect(trace(drawer).innerHTML).not.toMatch(/padding/);
    }
  });

  it('only a served outcome is lit, and it is the focal series root', async () => {
    for (const [id, lit] of [
      ['success', true],
      ['fallback', true],
      ['error', false],
    ] as const) {
      const drawer = await open(id);
      const litNodes = items(drawer).filter((li) => li.classList.contains('rt-node--lit'));
      expect(
        litNodes.map((li) => li.dataset['kind']),
        id,
      ).toEqual(lit ? ['outcome'] : []);
      const focal = [...drawer.querySelectorAll<HTMLElement>('[data-series="focal"]')];
      expect(focal, id).toEqual(litNodes);
      for (const f of focal) expect(f.dataset['measure']).toBe('route-trace');
    }
  });

  it('an unrecognised status renders neutrally: a verbatim badge and an unlit outcome', async () => {
    // `request_log.status` is unconstrained text, so `RequestStatus` admits any string.
    const throttled: RequestRow = { ...ROWS.success, id: 'rt-throttled', status: 'throttled' };
    const blank: RequestRow = { ...ROWS.success, id: 'rt-blank', status: '' };
    h = await mount([throttled, blank]);
    for (const [row, word] of [
      [throttled, 'throttled'],
      [blank, 'unknown'],
    ] as const) {
      const drawer = await openRow(row.id);
      const badge = drawer.querySelector<HTMLElement>('.drawer-head .chip')!;
      expect(badge.textContent, `${word}: the status badge`).toBe(word);
      expect(badge.style.background).toBe('var(--chip)');
      expect(badge.style.color).toBe('var(--text3)');
      const outcome = items(drawer).at(-1)!;
      expect(outcome.textContent).toBe(`Provider C · ${word} · 412ms`);
      expect(outcome.classList.contains('rt-node--neutral')).toBe(true);
      expect(drawer.querySelectorAll('[data-series="focal"]')).toHaveLength(0);
    }
  });

  it('an unlit outcome names the recorded provider only when it was the last one tried (flag RF-1)', async () => {
    // A cancelled row keeps no trail; its outcome names the recorded provider, then the model.
    const cancelled: RequestRow = { ...ROWS.success, id: 'rt-cancelled', status: 'cancelled' };
    // An exhausted chain whose terminal member is on another provider: the row records the
    // first member's provider, which was not the last one tried, so the outcome names none.
    const elsewhere: RequestRow = {
      ...ROWS.error,
      id: 'rt-elsewhere',
      attemptFailures: [
        { index: 0, providerId: 'p1', model: 'gpt-a', kind: 'rate_limit', dispatched: true },
        {
          index: 1,
          providerId: 'p2',
          model: 'gpt-b',
          kind: 'unavailable',
          status: 503,
          dispatched: true,
          terminal: true,
        },
      ],
    };
    h = await mount([cancelled, elsewhere]);
    const drawer = await openRow(cancelled.id);
    const outcome = items(drawer).at(-1)!;
    expect(outcome.textContent).toBe('Provider C · model-c · cancelled by client · 412ms');
    expect(outcome.classList.contains('rt-node--neutral')).toBe(true);
    // The provider name is plain text, outside the Mono model id; nothing is a failure label.
    expect(outcome.querySelector('.rt-model')?.textContent).toBe('model-c');
    expect(outcome.querySelector('.rt-failure')).toBeNull();
    expect(drawer.querySelectorAll('[data-series="focal"]')).toHaveLength(0);
    const other = await openRow(elsewhere.id);
    expect(texts(other).at(-1)).toBe('failed · 2.10s');
  });

  it('the outcome carries the latency in the table format, as a tabular figure', async () => {
    for (const [id, latency] of [
      ['success', '412ms'],
      ['fallback', '1.24s'],
      ['batch', '2h 3m'],
    ] as const) {
      const drawer = await open(id);
      const figure = drawer.querySelectorAll<HTMLElement>('[data-testid="rt-latency"]');
      expect(figure, `${id}: one latency`).toHaveLength(1);
      expect(figure[0]!.textContent).toBe(latency);
      expect(figure[0]!.classList.contains('figure')).toBe(true);
      expect(family(figure[0]!)).toMatch(/^Geist,/);
      // The model id on the outcome is an identifier.
      const model = items(drawer).at(-1)!.querySelector('.rt-model');
      if (model !== null) expect(family(model)).toMatch(/^Geist Mono,/);
    }
  });

  it('a cascade walk keeps its legs, with the superseded call between them', async () => {
    const drawer = await open('cascade');
    expect(texts(drawer)).toEqual([
      'billing-bot',
      'router · cascade',
      'cheap-a · timeout · cheap leg',
      'cheap attempt superseded · q=0.42 · $0.0031',
      'strong-a · server_error · HTTP 503 · escalation',
      'Provider S · model-strong · served · 1.24s',
    ]);
    const superseded = items(drawer)[3]!;
    expect(superseded.dataset['kind']).toBe('superseded');
    for (const f of superseded.querySelectorAll('.figure')) expect(family(f)).toMatch(/^Geist,/);
  });

  it('a recovered row without recorded attempts says so under the trace', async () => {
    h = await mount([{ ...ROWS.fallback, attemptFailures: null }]);
    const drawer = await open('fallback');
    expect(texts(drawer)).toEqual([
      'billing-bot',
      'router · header',
      'Provider C · model-c · served · 1.24s',
    ]);
    const caption = drawer.querySelector<HTMLElement>('.rt-caption');
    expect(caption?.textContent).toBe(TRACE_NOT_RECORDED);
    expect(before(trace(drawer), caption!)).toBe(true);
  });
});

describe("the inspector's Decision section (task 4.1)", () => {
  it('states the served tier when one was recorded, and draws no row when none was', async () => {
    const heavy = await open('fallback');
    expect(decisionRow(heavy, 'tier')?.textContent).toBe('heavy');
    // A tier name is an identifier: the kv-box's Mono, wrapping only where it must (DESIGN.md
    // Long content), never split mid-token by `word-break: break-all`.
    expect(family(decisionRow(heavy, 'tier')!)).toMatch(/^Geist Mono,/);
    expect(decisionRow(heavy, 'tier')!.style.overflowWrap).toBe('anywhere');
    expect(decisionRow(heavy, 'tier')!.style.wordBreak).toBe('');
    // The trace never names the tier.
    expect(trace(heavy).textContent).not.toContain('heavy');
    const none = await open('success');
    expect(decisionRow(none, 'tier')).toBeNull();
    expect(none.querySelector('[data-testid="inspector-tier"]')).toBeNull();
    for (const d of [heavy, none]) {
      expect(decisionRow(d, 'decision layer')).not.toBeNull();
      expect(decisionRow(d, 'routing reason')).not.toBeNull();
    }
  });

  it('keeps the decision layer row beside the header row, and beside the batch mode and job', async () => {
    const header = await open('fallback');
    expect(decisionRow(header, 'decision layer')?.textContent).toBe('header');
    expect(decisionRow(header, 'header')?.textContent).toBe('x-polyrouter-tier: heavy');
    const batch = await open('batch');
    expect(decisionRow(batch, 'decision layer')?.textContent).toBe('explicit');
    expect(decisionRow(batch, 'mode')?.textContent).toBe('batch');
    expect(decisionRow(batch, 'batch job')?.textContent).toBe('batch_01');
    expect(decisionRow(batch, 'routing reason')?.textContent).toBe(ROWS.batch.routingReason);
    expect(texts(batch).slice(1, 2)).toEqual(['router · explicit']);
  });
});

describe('the price receipt on screen (task 4.1)', () => {
  it('is headed Price snapshot with its caption, rows of count × unit price, and an exact total', async () => {
    const drawer = await open('cascade');
    const receipt = drawer.querySelector<HTMLElement>('[data-testid="inspector-receipt"]')!;
    expect(receipt.firstElementChild?.textContent?.trim()).toBe('Price snapshot');
    expect(receipt.querySelector('[data-testid="receipt-caption"]')?.textContent).toBe(
      'Recorded with the request — later price changes never apply.',
    );
    const rows = [...receipt.querySelectorAll<HTMLElement>('[data-testid="receipt-token-row"]')];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      const groups = [...r.querySelectorAll<HTMLElement>('.rt-nowrap')];
      // A count group and a price group, each one no-wrap unit, split only at the ` × `.
      expect(groups.length === 2 || groups.length === 1, r.textContent ?? '').toBe(true);
      for (const g of groups) expect(getComputedStyle(g).whiteSpace).toBe('nowrap');
      if (groups.length === 2) expect(r.lastElementChild?.textContent).toMatch(/ × /);
    }
    // The count test ids sit on the count group alone; the price id on each price group.
    const input = receipt.querySelector<HTMLElement>('[data-testid="inspector-input-tokens"]')!;
    expect(input.textContent).toBe(ROWS.cascade.inputTokens.toLocaleString());
    expect(input.classList.contains('rt-nowrap')).toBe(true);
    for (const p of receipt.querySelectorAll<HTMLElement>('[data-testid="inspector-price"]'))
      expect(p.classList.contains('rt-nowrap')).toBe(true);
    expect(receipt.querySelector('[data-testid="receipt-source"]')?.textContent).toBe('bundled');
    expect(receipt.querySelector('[data-testid="inspector-served-cost"]')?.textContent).toBe(
      '$0.0123',
    );
    expect(receipt.querySelector('[data-testid="inspector-attempt-cost"]')?.textContent).toBe(
      '$0.0031',
    );
    // 12,346 + 3,100 micro-dollars (the half-unit case, where the rounded rows would sum to a
    // different figure, is table-driven in data/analytics.test.ts).
    expect(receipt.querySelector('[data-testid="inspector-total-cost"]')?.textContent).toBe(
      '$0.0154',
    );
  });

  it('draws no attempts row without attempt cost, and a batch row names submission pricing', async () => {
    const drawer = await open('batch');
    const receipt = drawer.querySelector<HTMLElement>('[data-testid="inspector-receipt"]')!;
    expect(receipt.querySelector('[data-testid="inspector-attempt-cost"]')).toBeNull();
    expect(receipt.querySelector('[data-testid="receipt-caption"]')?.textContent).toBe(
      'Batch rate, recorded at submission.',
    );
    expect(receipt.querySelector('[data-testid="receipt-source"]')?.textContent).toBe(
      'batch · bundled',
    );
    expect(drawer.textContent).not.toMatch(/snapshotted\s+at\s+request\s+time/);
  });
});

describe('the route trace states every outcome in text and never animates (tasks 4.3, 4.5)', () => {
  it('a skipped and a failed member differ in their text, not only in their stroke', async () => {
    const drawer = await open('fallback');
    const failed = items(drawer).find((li) => li.classList.contains('rt-node--failed'))!;
    const skipped = items(drawer).find((li) => li.classList.contains('rt-node--skipped'))!;
    // Forced colours or greyscale drop every colour and dash: the words still tell them apart.
    const words = (li: HTMLElement): string => (li.textContent ?? '').replace(/^\S+ · /, '');
    expect(words(failed)).toBe('rate_limit · HTTP 429 · rate_limit_exceeded');
    expect(words(skipped)).toBe(SKIP_LABEL);
    expect(words(failed)).not.toBe(words(skipped));
  });

  it('no rt-* rule declares a transition or an animation', () => {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ sel: (m[1] ?? '').trim(), body: m[2] ?? '' }))
      .filter((r) => /\.rt(?:-[\w-]+)?\b/.test(r.sel));
    expect(rules.length, 'the trace rules were read').toBeGreaterThan(10);
    for (const r of rules) {
      expect(r.body, `${r.sel} moves`).not.toMatch(/(?:^|;)\s*(?:transition|animation)[\w-]*\s*:/);
    }
  });

  it('changing the selection re-renders the trace in its final state, with no animation class', async () => {
    const first = await open('fallback');
    const before1 = texts(first);
    const second = await open('cascade');
    expect(texts(second)).not.toEqual(before1);
    expect(texts(second).at(-1)).toBe('Provider S · model-strong · served · 1.24s');
    for (const el of [trace(second), ...trace(second).querySelectorAll<HTMLElement>('*')]) {
      const cls = el.getAttribute('class') ?? '';
      expect(cls, 'an animation class').not.toMatch(/anim|enter|fade|slide|draw|transition/i);
      const cs = getComputedStyle(el);
      expect(cs.animationName === '' || cs.animationName === 'none').toBe(true);
      expect(el.getAttribute('style') ?? '').not.toMatch(/animation|transition/);
    }
  });
});
