/** Tier-chain reorder regression suite (fix-tier-chain-drag-reorder).
 *
 * The component's drag handlers had ZERO coverage before this file — `appState.test.ts`
 * only called `moveTierEntry` directly with already-correct indices, which is why an
 * off-by-one in the dragover handler shipped. Every assertion here drives the real
 * handlers through synthetic events.
 *
 * `happy-dom` has no `DragEvent` constructor, and the handlers only ever touch
 * `preventDefault` / `dataTransfer` / `clientY` / `currentTarget` — so a plain `Event`
 * with those properties defined is a faithful stand-in. Row rects are stubbed so the
 * midpoint arithmetic is deterministic.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDto, TierDto, TierEntryDto } from './data/api';
import { App } from './App';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-07-15T00:00:00.000Z';
const ROW_H = 40;

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
function mkEntry(tierId: string, modelId: string, position: number): TierEntryDto {
  return { id: `e-${tierId}-${modelId}`, tierId, modelId, position, model: null };
}
const TIER: TierDto = {
  id: 't1',
  key: 'default',
  displayName: 'Default',
  description: null,
  createdAt: NOW,
};
const TIER2: TierDto = {
  id: 't2',
  key: 'heavy',
  displayName: 'Heavy',
  description: null,
  createdAt: NOW,
};

interface Harness {
  host: HTMLElement;
  store: AppStore;
  fake: FakeApiClient;
  dispose: () => void;
}

function makeFake(opts: { models?: string[]; entries?: string[]; tiers?: TierDto[] } = {}) {
  const models = opts.models ?? ['m1', 'm2', 'm3', 'm4'];
  const entries = opts.entries ?? ['m1', 'm2', 'm3'];
  const tiers = opts.tiers ?? [TIER];
  const tierEntries: Record<string, TierEntryDto[]> = {};
  for (const t of tiers) {
    tierEntries[t.id] = t.id === 't1' ? entries.map((m, i) => mkEntry(t.id, m, i)) : [];
  }
  return new FakeApiClient({ models: { p1: models.map(mkModel) }, tiers, tierEntries });
}

async function mountRouting(fake: FakeApiClient = makeFake()): Promise<Harness> {
  const store = createAppStore(fake);
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
  const nav = [...host.querySelectorAll<HTMLElement>('.nav-item span')].find(
    (e) => e.textContent?.trim() === 'Routing',
  );
  nav?.click();
  await flush();
  return {
    host,
    store,
    fake,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

/** The chain rows of the first tier card, in DOM order. */
function rows(host: HTMLElement): HTMLElement[] {
  const card = host.querySelector<HTMLElement>('.panel');
  return card ? [...card.querySelectorAll<HTMLElement>('.chain-row')] : [];
}
/** Visible model-id order of the first tier's chain. */
function order(host: HTMLElement): string[] {
  return rows(host).map((r) => r.dataset['modelId'] ?? '?');
}
/** The model id of the row currently rendered as the dragged (ghosted) one. */
function ghost(host: HTMLElement): string {
  const g = rows(host).filter((r) => r.dataset['dragging'] === 'true');
  return g.map((r) => r.dataset['modelId'] ?? '?').join(',') || 'none';
}

/** Recorded `replaceTierEntries` calls (fake.calls is method NAMES only; callLog has args). */
function writesOf(fake: FakeApiClient): { method: string; args: unknown[] }[] {
  return fake.callLog.filter((c) => c.method === 'replaceTierEntries');
}

/** Stub each row's rect so row i spans [i*ROW_H, (i+1)*ROW_H) — midpoint at +ROW_H/2. */
function stubRects(host: HTMLElement, heights?: number[]): void {
  let top = 0;
  rows(host).forEach((row, i) => {
    const h = heights?.[i] ?? ROW_H;
    const t = top;
    top += h;
    row.getBoundingClientRect = (): DOMRect =>
      ({ top: t, bottom: t + h, height: h, left: 0, right: 100, width: 100, x: 0, y: t }) as DOMRect;
  });
}

interface DragBag {
  data: Record<string, string>;
  effectAllowed: string;
  dropEffect: string;
  setData: (t: string, v: string) => void;
}
function makeBag(): DragBag {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: '',
    dropEffect: '',
    setData: (t: string, v: string) => {
      data[t] = v;
    },
  };
}

function fire(el: HTMLElement, type: string, bag: DragBag, clientY?: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: bag });
  if (clientY !== undefined) Object.defineProperty(ev, 'clientY', { value: clientY });
  el.dispatchEvent(ev);
  return ev;
}

/** `loadRouting` awaits in TWO rounds (the list GETs, then per-tier entries), so a gated
 *  load needs the gate opened twice to complete. */
async function releaseLoad(fake: FakeApiClient): Promise<void> {
  fake.openGate();
  await flush();
  fake.openGate();
  await flush();
}

/** Pointer parked at absolute y; dragover fires on whichever row occupies that slot. */
function hoverY(host: HTMLElement, bag: DragBag, y: number): void {
  const idx = Math.min(Math.floor(y / ROW_H), rows(host).length - 1);
  const row = rows(host)[idx];
  if (row) fire(row, 'dragover', bag, y);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tier chain drag reorder', () => {
  it('keeps the ghost on the grabbed row through a multi-position drag', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      expect(ghost(h.host)).toBe('m1');
      // Cross the midpoint of the row at index 2 (spans 80..120, midpoint 100).
      hoverY(h.host, bag, 110);
      expect(order(h.host)).toEqual(['m2', 'm3', 'm1']);
      // The ghost must still be the grabbed entry — NOT the displaced one.
      expect(ghost(h.host)).toBe('m1');
    } finally {
      h.dispose();
    }
  });

  it('does not oscillate while the pointer is parked on one slot', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      // Park just past the midpoint of slot 1 (spans 40..80, midpoint 60).
      hoverY(h.host, bag, 70);
      const settled = order(h.host);
      expect(settled).toEqual(['m2', 'm1', 'm3']);
      const trace: string[] = [];
      for (let i = 0; i < 5; i++) {
        hoverY(h.host, bag, 70);
        trace.push(order(h.host).join(''));
      }
      // Every repeat at the unchanged position must be idempotent.
      expect(trace).toEqual(['m2m1m3', 'm2m1m3', 'm2m1m3', 'm2m1m3', 'm2m1m3']);
      expect(ghost(h.host)).toBe('m1');
    } finally {
      h.dispose();
    }
  });

  it('does not reorder until the pointer crosses the midpoint', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      hoverY(h.host, bag, 45); // inside slot 1 but above its midpoint (60)
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
      hoverY(h.host, bag, 61); // now past it
      expect(order(h.host)).toEqual(['m2', 'm1', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('reorders upward only past the upper row midpoint, and survives a reversal', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      const bag = makeBag();
      fire(rows(h.host)[2]!, 'dragstart', bag); // grab m3
      hoverY(h.host, bag, 35); // slot 0 spans 0..40, midpoint 20 — 35 is BELOW it
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
      hoverY(h.host, bag, 15); // above the midpoint → moves to the top
      expect(order(h.host)).toEqual(['m3', 'm1', 'm2']);
      // Reverse back down across the opposite midpoint.
      hoverY(h.host, bag, 70);
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);
      expect(ghost(h.host)).toBe('m3');
    } finally {
      h.dispose();
    }
  });

  it('honours unequal row heights when computing the midpoint', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host, [20, 100, 20]); // row1 spans 20..120, midpoint 70
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      const tallRow = rows(h.host)[1]!;
      fire(tallRow, 'dragover', bag, 60); // inside row 1, above its midpoint
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
      fire(tallRow, 'dragover', bag, 80); // past it
      expect(order(h.host)).toEqual(['m2', 'm1', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('sets drag data so browsers that require it can start the drag', async () => {
    const h = await mountRouting();
    try {
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      expect(bag.data['text/plain']).toBe('ext-m1'); // the displayed model id
      expect(bag.effectAllowed).toBe('move');
    } finally {
      h.dispose();
    }
  });

  it('accepts the drop and commits exactly one persisted order', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      const bag = makeBag();
      fire(rows(h.host)[2]!, 'dragstart', bag);
      hoverY(h.host, bag, 15);
      expect(order(h.host)).toEqual(['m3', 'm1', 'm2']);
      const dropEv = fire(rows(h.host)[0]!, 'drop', bag, 15);
      expect(dropEv.defaultPrevented).toBe(true); // not rendered as a cancelled drag
      fire(rows(h.host)[0]!, 'dragend', bag);
      await flush();
      const writes = writesOf(h.fake);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.args[1]).toEqual(['m3', 'm1', 'm2']);
    } finally {
      h.dispose();
    }
  });

  it('completes a drag that ends outside the chain', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      hoverY(h.host, bag, 70);
      fire(rows(h.host)[1]!, 'dragend', bag); // no drop at all
      await flush();
      expect(ghost(h.host)).toBe('none');
      const writes = writesOf(h.fake);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.args[1]).toEqual(['m2', 'm1', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('marks the tier while dragging so the hover band cannot chase rows', async () => {
    const h = await mountRouting();
    try {
      stubRects(h.host);
      const bag = makeBag();
      const card = h.host.querySelector<HTMLElement>('.panel');
      fire(rows(h.host)[0]!, 'dragstart', bag);
      expect(card?.dataset['dragging']).toBe('true');
      fire(rows(h.host)[0]!, 'dragend', bag);
      await flush();
      expect(card?.dataset['dragging']).toBeUndefined();
    } finally {
      h.dispose();
    }
  });
});

describe('tier chain drag vs concurrent server state', () => {
  it('an in-flight chain write cannot discard an in-progress drag', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      // A prior edit whose PUT is still in flight.
      fake.deferTierWrites = true;
      h.store.setPrimaryTierModel('t1', 'm2');
      await flush();
      stubRects(h.host);
      expect(order(h.host)).toEqual(['m2', 'm1', 'm3']);

      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      hoverY(h.host, bag, 110); // m2 to the bottom
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);

      // The earlier PUT now lands mid-drag — it must NOT repaint the chain.
      fake.tierWriteQueue.shift()?.settle('resolve');
      await flush();
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);

      fake.deferTierWrites = false;
      fire(rows(h.host)[2]!, 'drop', bag, 110);
      fire(rows(h.host)[2]!, 'dragend', bag);
      await flush();
      const writes = writesOf(fake);
      expect(writes[writes.length - 1]?.args[1]).toEqual(['m1', 'm3', 'm2']);
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);
    } finally {
      h.dispose();
    }
  });

  it('a routing refresh cannot repaint the tier being dragged', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      fake.gateReads = true;
      void h.store.loadRouting(); // refresh in flight over still-draggable rows
      await flush();

      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      hoverY(h.host, bag, 110);
      expect(order(h.host)).toEqual(['m2', 'm3', 'm1']);

      await releaseLoad(fake); // the refresh lands mid-drag
      expect(order(h.host)).toEqual(['m2', 'm3', 'm1']);

      fire(rows(h.host)[2]!, 'drop', bag, 110);
      fire(rows(h.host)[2]!, 'dragend', bag);
      await flush();
      const writes = writesOf(fake);
      expect(writes[writes.length - 1]?.args[1]).toEqual(['m2', 'm3', 'm1']);
    } finally {
      h.dispose();
    }
  });

  it('a no-op drag applies the deferred order and issues no write', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      const before = writesOf(fake).length;
      fake.gateReads = true;
      // Server truth diverges while the drag is held.
      fake.tierEntries['t1'] = [
        mkEntry('t1', 'm3', 0),
        mkEntry('t1', 'm2', 1),
        mkEntry('t1', 'm1', 2),
      ];
      void h.store.loadRouting();
      await flush();

      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      await releaseLoad(fake);
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']); // held — not repainted

      fire(rows(h.host)[0]!, 'dragend', bag); // nothing moved
      await flush();
      expect(order(h.host)).toEqual(['m3', 'm2', 'm1']); // deferred truth applied
      expect(writesOf(fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });

  it('a failed write rolls back to the LATEST confirmed order, not a stale capture', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      fake.deferTierWrites = true;
      h.store.setPrimaryTierModel('t1', 'm2'); // captures baseline [m1,m2,m3]
      await flush();

      // A refresh confirms a NEWER server order while the write is still in flight.
      fake.gateReads = true;
      fake.tierEntries['t1'] = [
        mkEntry('t1', 'm3', 0),
        mkEntry('t1', 'm1', 1),
        mkEntry('t1', 'm2', 2),
      ];
      void h.store.loadRouting();
      await flush();

      stubRects(h.host);
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      await releaseLoad(fake);
      fake.tierWriteQueue.shift()?.settle('reject'); // rollback, suppressed behind the drag
      await flush();

      fire(rows(h.host)[0]!, 'dragend', bag); // no-op drag → apply the pending snapshot
      await flush();
      // Must be the newer confirmed order, never the pre-refresh capture.
      expect(order(h.host)).toEqual(['m3', 'm1', 'm2']);
    } finally {
      h.dispose();
    }
  });

  it('starting a drag on another tier does not strand the first tier', async () => {
    const fake = makeFake({ tiers: [TIER, TIER2] });
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      fake.gateReads = true;
      fake.tierEntries['t1'] = [
        mkEntry('t1', 'm3', 0),
        mkEntry('t1', 'm2', 1),
        mkEntry('t1', 'm1', 2),
      ];
      void h.store.loadRouting();
      await flush();

      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      await releaseLoad(fake);
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']); // held

      // A drag begins on the OTHER tier — tier 1's deferred state must not be stranded.
      const card2 = h.host.querySelectorAll<HTMLElement>('.panel')[1];
      const bag2 = makeBag();
      const row2 = card2?.querySelector<HTMLElement>('.chain-row');
      h.store.beginTierDrag('t2');
      if (row2) fire(row2, 'dragstart', bag2);
      await flush();
      expect(order(h.host)).toEqual(['m3', 'm2', 'm1']);
    } finally {
      h.dispose();
    }
  });

  it('discards deferred state on sign-out instead of painting it', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      fake.gateReads = true;
      fake.tierEntries['t1'] = [mkEntry('t1', 'm3', 0), mkEntry('t1', 'm2', 1)];
      void h.store.loadRouting();
      await flush();
      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      await releaseLoad(fake);

      await h.store.signOut();
      await flush();
      // Identity reset does not clear `tierEntries` wholesale — what matters is that the
      // PREVIOUS principal's deferred order is never painted into the new session.
      expect(h.store.state.tierEntries['t1']?.map((e) => e.modelId)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('abandons the drag when the held tier vanishes from a refresh', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      stubRects(h.host);
      fake.gateReads = true;
      fake.tiers = []; // deleted by another session
      fake.tierEntries = {};
      void h.store.loadRouting();
      await flush();

      const bag = makeBag();
      fire(rows(h.host)[0]!, 'dragstart', bag);
      await releaseLoad(fake);

      expect(h.store.state.routingTiers).toHaveLength(0);
      expect(h.store.state.tierEntries['t1']).toBeUndefined();
      const before = writesOf(fake).length;
      h.store.endTierDrag('t1', 'changed'); // a late completion must do nothing
      await flush();
      expect(writesOf(fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });
});

describe('tier chain keyboard reorder', () => {
  const press = (el: HTMLElement, key: string, altKey = true): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };
  const handles = (host: HTMLElement): HTMLButtonElement[] =>
    rows(host).map((r) => r.querySelector<HTMLButtonElement>('.drag-handle')!);

  it('moves an entry with Alt+Arrow, persists it, and takes focus along', async () => {
    const h = await mountRouting();
    try {
      const handle = handles(h.host)[2]!;
      handle.focus();
      const ev = press(handle, 'ArrowUp');
      expect(ev.defaultPrevented).toBe(true);
      await flush();
      expect(order(h.host)).toEqual(['m1', 'm3', 'm2']);
      // Focus follows the moved entry to its new row.
      const focusedRow = document.activeElement?.closest('.chain-row') as HTMLElement | null;
      expect(focusedRow?.dataset['modelId']).toBe('m3');
      const writes = writesOf(h.fake);
      expect(writes[writes.length - 1]?.args[1]).toEqual(['m1', 'm3', 'm2']);
    } finally {
      h.dispose();
    }
  });

  it('moves down and is a no-op at both boundaries', async () => {
    const h = await mountRouting();
    try {
      press(handles(h.host)[0]!, 'ArrowDown');
      await flush();
      expect(order(h.host)).toEqual(['m2', 'm1', 'm3']);

      const before = writesOf(h.fake).length;
      press(handles(h.host)[0]!, 'ArrowUp'); // already first
      press(handles(h.host)[2]!, 'ArrowDown'); // already last
      await flush();
      expect(order(h.host)).toEqual(['m2', 'm1', 'm3']);
      expect(writesOf(h.fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });

  it('ignores the arrows without Alt so page scrolling is not swallowed', async () => {
    const h = await mountRouting();
    try {
      const ev = press(handles(h.host)[0]!, 'ArrowDown', false);
      await flush();
      expect(ev.defaultPrevented).toBe(false);
      expect(order(h.host)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      h.dispose();
    }
  });

  it('announces the new position in a region distinct from the picker count', async () => {
    const h = await mountRouting();
    try {
      press(handles(h.host)[0]!, 'ArrowDown');
      await flush();
      const live = h.host.querySelector<HTMLElement>('[data-testid="reorder-status"]');
      expect(live?.getAttribute('role')).toBe('status');
      expect(live?.textContent).toContain('Fallback 1');
      // The picker's own status node is a different element and still empty while closed.
      const all = [...h.host.querySelectorAll('[role="status"]')];
      expect(all.length).toBeGreaterThan(1);
    } finally {
      h.dispose();
    }
  });

  it('announces only in the tier the move happened in', async () => {
    const h = await mountRouting(makeFake({ tiers: [TIER, TIER2] }));
    try {
      press(handles(h.host)[0]!, 'ArrowDown');
      await flush();
      const regions = [...h.host.querySelectorAll<HTMLElement>('[data-testid="reorder-status"]')];
      expect(regions).toHaveLength(2); // one per tier
      expect(regions[0]?.textContent).toContain('Fallback 1');
      // The other tier's region must stay silent — a page-global message would announce
      // the same move once per tier.
      expect(regions[1]?.textContent).toBe('');
    } finally {
      h.dispose();
    }
  });

  it('names the handle with the model and its position', async () => {
    const h = await mountRouting();
    try {
      const label = handles(h.host)[1]?.getAttribute('aria-label') ?? '';
      expect(label).toContain('ext-m2');
      expect(label).toContain('2 of 3');
      expect(handles(h.host)[1]?.getAttribute('aria-hidden')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('collapses a rapid burst into strictly fewer writes than keypresses', async () => {
    const fake = makeFake({
      models: ['m1', 'm2', 'm3', 'm4'],
      entries: ['m1', 'm2', 'm3', 'm4'],
    });
    const h = await mountRouting(fake);
    try {
      fake.deferTierWrites = true;
      const before = writesOf(fake).length;
      // Walk m1 to the bottom: three presses, faster than a write completes.
      const KEYPRESSES = 3;
      for (let i = 0; i < KEYPRESSES; i++) {
        press(handles(h.host)[i]!, 'ArrowDown');
        await flush();
      }
      expect(order(h.host)).toEqual(['m2', 'm3', 'm4', 'm1']);
      // The first PUT went out immediately; presses 2 and 3 coalesce into ONE follow-up
      // carrying the final order, so the burst must cost strictly fewer than 3 writes.
      let guard = 0;
      while (fake.tierWriteQueue.length > 0 && guard++ < 6) {
        fake.tierWriteQueue.shift()?.settle('resolve');
        await flush();
      }
      const writes = writesOf(fake);
      expect(writes.length - before).toBeLessThan(KEYPRESSES);
      expect(writes[writes.length - 1]?.args[1]).toEqual(['m2', 'm3', 'm4', 'm1']);
    } finally {
      h.dispose();
    }
  });
});

describe('tier chain reorder — store-level hold semantics', () => {
  it('updates the confirmed baseline while holding the visible chain', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      fake.deferTierWrites = true;
      h.store.setPrimaryTierModel('t1', 'm3');
      await flush();
      h.store.beginTierDrag('t1');
      fake.tierWriteQueue.shift()?.settle('resolve');
      await flush();
      // Visible state held; the rollback baseline still tracks server truth.
      expect(h.store.state.confirmedEntries['t1']).toEqual(['m3', 'm1', 'm2']);
      h.store.endTierDrag('t1', 'abandon');
      await flush();
    } finally {
      h.dispose();
    }
  });

  it('abandon discards without applying or committing', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      fake.gateReads = true;
      fake.tierEntries['t1'] = [mkEntry('t1', 'm3', 0)];
      void h.store.loadRouting();
      await flush();
      h.store.beginTierDrag('t1');
      await releaseLoad(fake);
      const before = writesOf(fake).length;
      h.store.endTierDrag('t1', 'abandon');
      await flush();
      expect(h.store.state.tierEntries['t1']?.map((e) => e.modelId)).toEqual(['m1', 'm2', 'm3']);
      expect(writesOf(fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });

  it('deleting the held tier discards its deferred state', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      fake.gateReads = true;
      fake.tierEntries['t1'] = [mkEntry('t1', 'm3', 0)];
      void h.store.loadRouting();
      await flush();
      h.store.beginTierDrag('t1');
      await releaseLoad(fake);
      await h.store.deleteTier('t1');
      await flush();
      expect(h.store.state.tierEntries['t1']).toBeUndefined();
      const before = writesOf(fake).length;
      h.store.endTierDrag('t1', 'unchanged');
      await flush();
      expect(h.store.state.tierEntries['t1']).toBeUndefined(); // never resurrected
      expect(writesOf(fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });

  it('a completion arriving after the hold was abandoned writes nothing', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      h.store.beginTierDrag('t1');
      await h.store.signOut(); // clears the hold out from under the still-live drag
      await flush();
      const before = writesOf(fake).length;
      // The drag that owned the hold still completes afterwards (a real pointer drag
      // always fires its dragend). Abandoned means no-op: without the ownership guard in
      // `endTierDrag` this falls into the `changed` branch and schedules a write.
      h.store.endTierDrag('t1', 'changed');
      await flush();
      expect(writesOf(fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });

  it('a write completing after sign-out neither writes state nor toasts', async () => {
    const fake = makeFake();
    const h = await mountRouting(fake);
    try {
      fake.deferTierWrites = true;
      h.store.setPrimaryTierModel('t1', 'm3');
      await flush();
      await h.store.signOut();
      await flush();
      const before = writesOf(fake).length;
      fake.tierWriteQueue.shift()?.settle('reject');
      await flush();
      // The old principal's failure must not surface in the new session. (State is not
      // asserted here: sign-out re-bootstraps and reloads routing, which would mask a
      // rollback either way — the toast is what the identity guard actually controls.)
      expect(h.host.querySelector('.toast')).toBeNull();
      expect(writesOf(fake)).toHaveLength(before);
    } finally {
      h.dispose();
    }
  });
});

describe('drag handle lint-surface', () => {
  it('is a real button, not a click-handling glyph', async () => {
    const h = await mountRouting();
    try {
      const handle = rows(h.host)[0]?.querySelector('.drag-handle');
      expect(handle?.tagName).toBe('BUTTON');
      expect(handle?.getAttribute('type')).toBe('button');
    } finally {
      h.dispose();
    }
  });

  it('keeps rows draggable so pointer reordering still works', async () => {
    const h = await mountRouting();
    try {
      expect(rows(h.host)[0]?.getAttribute('draggable')).toBe('true');
    } finally {
      h.dispose();
    }
  });
});

// Guard against the suite silently passing because the handlers never ran.
describe('harness sanity', () => {
  it('renders the tier chain it is asserting on', async () => {
    const h = await mountRouting();
    try {
      expect(rows(h.host)).toHaveLength(3);
      expect(vi.isMockFunction(() => 0)).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
