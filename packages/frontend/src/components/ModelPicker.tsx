import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from 'solid-js';
import type { Model } from '../types';

export interface ModelGroup {
  label: string;
  models: Model[];
}

/** Case-insensitive substring filter over grouped models: a query matches a model's
 * `externalModelId` OR its group's provider name (a group-name match keeps the whole
 * group); empty groups are dropped; a trimmed-empty query is the identity. */
export function filterModelGroups(groups: readonly ModelGroup[], query: string): ModelGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...groups];
  const out: ModelGroup[] = [];
  for (const g of groups) {
    if (g.label.toLowerCase().includes(q)) {
      out.push({ label: g.label, models: g.models });
      continue;
    }
    const models = g.models.filter((m) => m.externalModelId.toLowerCase().includes(q));
    if (models.length > 0) out.push({ label: g.label, models });
  }
  return out;
}

interface PanelPos {
  left: number;
  width: number;
  top: number | null;
  bottom: number | null;
  listMax: number;
}

interface ModelPickerProps {
  /** Unfiltered addable models, grouped by provider (already sorted). */
  groups: ModelGroup[];
  /** id of the tier card's visible header — the accessible-name base. */
  labelledBy: string;
  priceLabel: (m: Model) => string;
  onCommit: (modelId: string) => void;
}

/** Hand-rolled WAI-ARIA combobox for the tier add-model flow: a single-tab-stop
 * input that opens a provider-grouped listbox and filters by model id or provider
 * name. Focus never leaves the input (aria-activedescendant tracks the active row).
 * The panel renders position:fixed — the tier card clips (`overflow:hidden`) — and
 * closes when any ancestor scrolls (the app scrolls `<main>`, not window) or the
 * window resizes. */
export function ModelPicker(props: ModelPickerProps) {
  const uid = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [activeIdx, setActiveIdx] = createSignal(0);
  const [pos, setPos] = createSignal<PanelPos>({
    left: 0,
    width: 220,
    top: 0,
    bottom: null,
    listMax: 320,
  });
  let inputEl: HTMLInputElement | undefined;
  let rootEl: HTMLDivElement | undefined;

  const filtered = createMemo(() => filterModelGroups(props.groups, query()));
  const flat = createMemo(() => filtered().flatMap((g) => g.models));
  const total = createMemo(() => props.groups.reduce((n, g) => n + g.models.length, 0));
  const activeModel = (): Model | undefined => flat()[activeIdx()];
  const optId = (m: Model): string => `${uid}-opt-${m.id}`;
  const countText = (): string => `${String(flat().length)} of ${String(total())} models`;

  const measure = (): void => {
    if (!inputEl) return;
    const rect = inputEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const MARGIN = 8;
    const GAP = 4;
    const DESIRED = 360; // listbox max (320) + footer + gap
    const below = vh - rect.bottom - MARGIN;
    const above = rect.top - MARGIN;
    // Below unless it can't fit the desired height AND above has more room.
    const side = below >= DESIRED || below >= above ? 'below' : 'above';
    const avail = side === 'below' ? below : above;
    const width = Math.min(Math.max(rect.width, 320), Math.max(160, vw - 2 * MARGIN));
    const left = Math.min(Math.max(MARGIN, rect.left), Math.max(MARGIN, vw - width - MARGIN));
    setPos({
      left,
      width,
      top: side === 'below' ? rect.bottom + GAP : null,
      bottom: side === 'above' ? vh - rect.top + GAP : null,
      listMax: Math.max(96, Math.min(320, avail - 40)),
    });
  };

  const openPanel = (initial: 'first' | 'last'): void => {
    measure();
    setActiveIdx(initial === 'last' ? Math.max(0, flat().length - 1) : 0);
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
  };

  const commit = (m: Model): void => {
    props.onCommit(m.id);
    setQuery('');
    close();
    inputEl?.focus();
  };

  // While open: close when anything OUTSIDE the picker scrolls (capture-phase — the
  // app's scroller is `<main>`, and scroll events don't bubble), on window resize,
  // and on outside click. Scrolls inside the root are internal: the listbox, and the
  // input itself — a long query horizontally scrolls the input to keep the caret
  // visible, which must never self-close the popup. Cleanup runs on close and unmount.
  createEffect(() => {
    if (!open()) return;
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && rootEl?.contains(e.target)) return;
      close();
    };
    const onResize = (): void => close();
    const onDocClick = (e: MouseEvent): void => {
      if (!(e.target instanceof Node && rootEl?.contains(e.target))) close();
    };
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('click', onDocClick);
    onCleanup(() => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', onDocClick);
    });
  });

  // Keep the active row visible as keyboard navigation moves it.
  createEffect(() => {
    if (!open()) return;
    const m = activeModel();
    if (m) document.getElementById(optId(m))?.scrollIntoView?.({ block: 'nearest' });
  });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return; // IME: accepting a candidate must never navigate/commit
    const len = flat().length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (open()) setActiveIdx(len === 0 ? 0 : (activeIdx() + 1) % len);
        else openPanel('first');
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open()) setActiveIdx(len === 0 ? 0 : (activeIdx() - 1 + len) % len);
        else openPanel('last');
        break;
      case 'Home':
        if (open()) {
          e.preventDefault();
          setActiveIdx(0);
        }
        break;
      case 'End':
        if (open()) {
          e.preventDefault();
          setActiveIdx(Math.max(0, len - 1));
        }
        break;
      case 'Enter': {
        e.preventDefault(); // defensive: never submit an enclosing form
        if (open()) {
          const m = activeModel();
          if (m) commit(m);
        } else if (query() !== '') {
          openPanel('first');
        }
        break;
      }
      case 'Escape':
        if (open()) {
          e.preventDefault();
          close(); // first Escape closes, keeps text
        } else if (query() !== '') {
          e.preventDefault();
          setQuery(''); // second Escape clears
        }
        break;
      case 'Tab':
        if (open()) close(); // no preventDefault — focus moves on, nothing commits
        break;
      default:
        break;
    }
  };

  const onInput = (value: string): void => {
    setQuery(value);
    setActiveIdx(0); // active row resets on every input event (delete/paste/IME too)
    if (!open()) openPanel('first');
  };

  return (
    <div
      ref={(el) => {
        rootEl = el;
      }}
      style="position:relative;display:inline-block"
    >
      <input
        ref={(el) => {
          inputEl = el;
        }}
        class="mp-input"
        role="combobox"
        aria-expanded={open() ? 'true' : 'false'}
        aria-controls={`${uid}-lb`}
        aria-autocomplete="list"
        aria-activedescendant={
          open() && activeModel() !== undefined ? optId(activeModel() as Model) : undefined
        }
        aria-labelledby={`${props.labelledBy} ${uid}-lbl`}
        placeholder="+ Add model…"
        value={query()}
        onClick={() => (open() ? close() : openPanel('first'))}
        onKeyDown={onKeyDown}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <span class="sr-only" id={`${uid}-lbl`}>
        add model
      </span>
      <span class="mp-chevron" aria-hidden="true">
        ▾
      </span>
      <Show when={open()}>
        <div
          class="mp-panel"
          style={{
            left: `${String(pos().left)}px`,
            width: `${String(pos().width)}px`,
            ...(pos().top !== null
              ? { top: `${String(pos().top ?? 0)}px` }
              : { bottom: `${String(pos().bottom ?? 0)}px` }),
          }}
          onMouseDown={(e) => e.preventDefault()} // the input keeps focus (blur race)
        >
          <div
            role="listbox"
            id={`${uid}-lb`}
            aria-labelledby={`${props.labelledBy} ${uid}-lbl`}
            class="mp-listbox"
            style={{ 'max-height': `${String(pos().listMax)}px` }}
          >
            <For each={filtered()}>
              {(g, gi) => (
                <div role="group" aria-labelledby={`${uid}-g${String(gi())}`}>
                  <div class="mp-group-h" id={`${uid}-g${String(gi())}`}>
                    {g.label}
                  </div>
                  <For each={g.models}>
                    {(m) => (
                      /* eslint-disable-next-line a11y-guard/no-noninteractive-click --
                         pointer-only redundancy: keyboard users commit this row via
                         Enter on the combobox input (aria-activedescendant pattern);
                         a focusable <button> here would break the single tab stop. */
                      <div
                        role="option"
                        id={optId(m)}
                        aria-selected={activeModel()?.id === m.id ? 'true' : 'false'}
                        class="mp-option"
                        classList={{ active: activeModel()?.id === m.id }}
                        onClick={() => commit(m)}
                      >
                        <span>{m.externalModelId}</span>
                        <span class="mp-price">{props.priceLabel(m)}</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
          <Show when={flat().length === 0}>
            <div class="mp-empty">
              {query().trim() === '' ? 'No addable models.' : 'No models match — clear the filter.'}
            </div>
          </Show>
          <div class="mp-footer" aria-hidden="true">
            {countText()}
          </div>
        </div>
      </Show>
      {/* Always mounted, EMPTY while closed: a stable live region announces filter
          results reliably, and a closed picker never announces data updates. */}
      <div role="status" aria-atomic="true" class="sr-only">
        {open() ? countText() : ''}
      </div>
    </div>
  );
}
