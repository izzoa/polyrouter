/** Agent attribution in the request table (add-agent-request-attribution).
 *
 * WHAT THESE TESTS ARE. The grouping decision is a pure function over the rows, so
 * most of this is unit-level and needs no DOM. The render specs assert the two
 * things the spec forbids — a raw `agentId` reaching the screen, and a tenth grid
 * track appearing — because both are silent failures that a type check cannot see.
 *
 * `happy-dom` evaluates no container query, so nothing here proves the boundary
 * survives the stacked reflow; that is the browser suite's job (task 3.4). What
 * holds at every width is asserted here: there is only ONE DOM, and the column
 * template is a single CSS rule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestRows } from './components/RequestTable';
import { AGENT_UNATTRIBUTED, agentRunLabel, startsAgentRun } from './data/analytics';
import type { RequestRow } from './data/api';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** A minimal completed row — only the fields the boundary and the cells read. */
function row(agentId: string | null, agentLabel: string | null, id = crypto.randomUUID()): RequestRow {
  return {
    id,
    createdAt: '2026-09-12T10:00:00.000Z',
    agentId,
    providerId: 'p1',
    modelId: 'm1',
    tierAssigned: 'default',
    decisionLayer: 'explicit',
    routingReason: 'explicit',
    routingHeaderName: null,
    routingHeaderValue: null,
    status: 'success',
    escalated: false,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputPriceSnapshot: null,
    outputPriceSnapshot: null,
    cacheReadPriceSnapshot: null,
    cacheWritePriceSnapshot: null,
    cost: 0.01,
    attemptCostMicros: 0,
    durationMs: 100,
    usageEstimated: false,
    priceSource: null,
    batchId: null,
    priceMode: null,
    priceEstimated: false,
    qualitySignal: null,
    modelLabel: 'gpt-4o',
    providerLabel: 'OpenAI',
    agentLabel,
    structuralBand: null,
    structuralScore: null,
    structuralBandSource: null,
  } as unknown as RequestRow;
}

describe('startsAgentRun — the boundary rule (pure)', () => {
  it('opens the first run and marks only the changes within X,X,X,Y,Y,X', () => {
    const rows = [
      row('X', 'Alpha'),
      row('X', 'Alpha'),
      row('X', 'Alpha'),
      row('Y', 'Beta'),
      row('Y', 'Beta'),
      row('X', 'Alpha'),
    ];
    const starts = rows.map((_, i) => startsAgentRun(rows, i));
    // Index 0 opens; 3 and 5 are the changes; nothing fires inside a run.
    expect(starts).toEqual([true, false, false, true, false, true]);
  });

  it('separates two DIFFERENT agents that share a name', () => {
    // Keyed on id, never the label — a name collision must not merge two agents.
    const rows = [row('X', 'worker'), row('Y', 'worker')];
    expect(startsAgentRun(rows, 1)).toBe(true);
  });

  it('separates a keyless row from a deleted agent, though both label as null', () => {
    const rows = [row(null, null), row('gone', null)];
    expect(startsAgentRun(rows, 1)).toBe(true);
    // …while two consecutive keyless rows are ONE run: same agent (none).
    const keyless = [row(null, null), row(null, null)];
    expect(startsAgentRun(keyless, 1)).toBe(false);
  });

  it('handles degenerate row counts', () => {
    expect(startsAgentRun([], 0)).toBe(false); // zero rows -> no boundary
    expect(startsAgentRun([row('X', 'Alpha')], 0)).toBe(true); // one row -> one boundary
  });

  it('never yields a raw id as the label', () => {
    expect(agentRunLabel(row('some-uuid-value', null))).toBe(AGENT_UNATTRIBUTED);
    expect(agentRunLabel(row('X', 'Alpha'))).toBe('Alpha');
  });
});

describe('RequestRows renders the boundaries', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const mount = (rows: RequestRow[]): HTMLElement => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createAppStore(new FakeApiClient());
    dispose = render(
      () => (
        <AppProvider store={store}>
          <RequestRows rows={rows} />
        </AppProvider>
      ),
      host,
    );
    return host;
  };

  it('draws exactly three boundaries for X,X,X,Y,Y,X, in order', () => {
    const host = mount([
      row('X', 'Alpha'),
      row('X', 'Alpha'),
      row('X', 'Alpha'),
      row('Y', 'Beta'),
      row('Y', 'Beta'),
      row('X', 'Alpha'),
    ]);
    const labels = [...host.querySelectorAll('.rs-agent-boundary')].map((e) => e.textContent);
    expect(labels).toEqual(['Alpha', 'Beta', 'Alpha']);
    // Six rows, three boundaries — the boundary is not a per-row decoration.
    expect(host.querySelectorAll('.req-row')).toHaveLength(6);
  });

  it('renders the unattributed marker and NEVER the raw agent id', () => {
    const host = mount([row('a-secret-looking-uuid', null), row(null, null)]);
    const labels = [...host.querySelectorAll('.rs-agent-boundary')].map((e) => e.textContent);
    expect(labels).toEqual([AGENT_UNATTRIBUTED, AGENT_UNATTRIBUTED]);
    expect(host.innerHTML).not.toContain('a-secret-looking-uuid');
  });

  it('renders nothing for an empty list', () => {
    const host = mount([]);
    expect(host.querySelectorAll('.rs-agent-boundary')).toHaveLength(0);
  });
});

describe('the boundary costs the table no grid track', () => {
  it('leaves the request table at exactly NINE columns', () => {
    const rule = /\.rs-table-requests \.table-head,\s*\.rs-table-requests \.req-row \{([^}]*)\}/.exec(
      css,
    );
    expect(rule, 'the request table column rule moved or was renamed').not.toBeNull();
    const template = /grid-template-columns:([^;]*);/.exec(rule![1]!)?.[1] ?? '';
    // `minmax(0, …)` tracks plus the fixed first column. Count the track heads, not
    // the commas inside minmax().
    const tracks = (template.match(/minmax\(/g) ?? []).length + 1;
    expect(tracks).toBe(9);
  });

  it('styles the boundary in greyscale only — the palette is single-accent', () => {
    const rule = /\.rs-agent-boundary \{([^}]*)\}/.exec(css);
    expect(rule, '.rs-agent-boundary is not styled').not.toBeNull();
    const body = rule![1]!;
    // No accent, and no semantic status hue: those are reserved meanings.
    expect(body).not.toMatch(/--accent/);
    expect(body).not.toMatch(/--(green|amber|red)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // It is NOT a grid participant, so it cannot shift the row template.
    expect(body).not.toMatch(/grid-template-columns/);
  });
});
