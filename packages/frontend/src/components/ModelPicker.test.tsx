import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '../types';
import { filterModelGroups, ModelPicker, type ModelGroup } from './ModelPicker';

const model = (id: string, externalModelId: string): Model => ({
  id,
  providerId: 'p1',
  externalModelId,
  displayName: null,
  contextWindow: null,
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  isFree: false,
  inputPricePer1m: null,
  outputPricePer1m: null,
  effectivePrice: null,
  listedPrice: null,
  lastSyncedAt: null,
});

const GROUPS: ModelGroup[] = [
  {
    label: 'ChatGPT Plus / Pro',
    models: [model('m1', 'gpt-5.4-mini'), model('m2', 'gpt-5.6-sol')],
  },
  {
    label: 'Openrouter',
    models: [model('m3', 'anthropic/claude-sonnet-5'), model('m4', 'x-ai/grok-4.5')],
  },
];

describe('filterModelGroups', () => {
  it('matches model ids as case-insensitive substrings', () => {
    const out = filterModelGroups(GROUPS, 'SONNET');
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('Openrouter');
    expect(out[0]!.models.map((m) => m.externalModelId)).toEqual(['anthropic/claude-sonnet-5']);
  });

  it('a provider-name match keeps the ENTIRE group', () => {
    const out = filterModelGroups(GROUPS, 'chatgpt');
    expect(out).toHaveLength(1);
    expect(out[0]!.models).toHaveLength(2);
  });

  it('trims the query and treats blank as identity', () => {
    expect(filterModelGroups(GROUPS, '  ')).toEqual(GROUPS);
    expect(filterModelGroups(GROUPS, '')).toEqual(GROUPS);
    expect(filterModelGroups(GROUPS, ' grok ')).toHaveLength(1);
  });

  it('no match yields [] and empty groups are dropped', () => {
    expect(filterModelGroups(GROUPS, 'zzz')).toEqual([]);
    const out = filterModelGroups(GROUPS, 'gpt-5.4');
    expect(out.map((g) => g.label)).toEqual(['ChatGPT Plus / Pro']);
  });
});

interface Mounted {
  host: HTMLElement;
  input: HTMLInputElement;
  onCommit: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

let mountSeq = 0;
function mountPicker(groups: ModelGroup[] = GROUPS): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onCommit = vi.fn();
  const hdrId = `hdr-${String(mountSeq++)}`; // distinct per tier, as in Routing.tsx
  const dispose = render(
    () => (
      <>
        <span id={hdrId}>default</span>
        <ModelPicker
          groups={groups}
          labelledBy={hdrId}
          priceLabel={() => '$1 / $2 per 1M'}
          onCommit={onCommit}
        />
      </>
    ),
    host,
  );
  const input = host.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!input) throw new Error('combobox input missing');
  return {
    host,
    input,
    onCommit,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

const key = (el: Element, k: string, init: KeyboardEventInit = {}): void => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  if (init.isComposing === true && !ev.isComposing) {
    Object.defineProperty(ev, 'isComposing', { value: true });
  }
  el.dispatchEvent(ev);
};

const type = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const panelOf = (host: HTMLElement): HTMLElement | null => host.querySelector('.mp-panel');
const optionsOf = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
const activeDesc = (input: HTMLInputElement): string | null =>
  input.getAttribute('aria-activedescendant');

let scrollIntoView: ReturnType<typeof vi.fn>;
let mounted: Mounted[] = [];
const track = (m: Mounted): Mounted => {
  mounted.push(m);
  return m;
};

beforeEach(() => {
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  for (const m of mounted) m.dispose();
  mounted = [];
  vi.restoreAllMocks();
});

describe('ModelPicker — ARIA wiring', () => {
  it('wires the combobox pattern: roles, expanded, controls, labelledby on input AND listbox', () => {
    const { host, input } = track(mountPicker());
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(panelOf(host)).toBeNull();

    key(input, 'ArrowDown');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = host.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(input.getAttribute('aria-controls')).toBe(listbox?.id);
    // Input and listbox share the accessible-name association: visible tier
    // header + the sr-only "add model" suffix.
    const labelledBy = input.getAttribute('aria-labelledby');
    expect(listbox?.getAttribute('aria-labelledby')).toBe(labelledBy);
    const [hdrId, sufId] = (labelledBy ?? '').split(' ');
    expect(document.getElementById(hdrId ?? '')?.textContent).toBe('default');
    expect(document.getElementById(sufId ?? '')?.textContent).toBe('add model');
    expect(document.getElementById(sufId ?? '')?.classList.contains('sr-only')).toBe(true);
  });

  it('renders provider sections as role=group named by their header elements', () => {
    const { host, input } = track(mountPicker());
    key(input, 'ArrowDown');
    const groups = [...host.querySelectorAll('[role="group"]')];
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      const headerId = g.getAttribute('aria-labelledby') ?? '';
      expect(document.getElementById(headerId)?.textContent).toBeTruthy();
    }
    expect(optionsOf(host)).toHaveLength(4);
  });

  it('the chevron is decorative and pointer-transparent; the input is the only tab stop', () => {
    const { host } = track(mountPicker());
    const chevron = host.querySelector('.mp-chevron');
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
    const focusables = host.querySelectorAll('input, button, select, textarea, [tabindex]');
    expect(focusables).toHaveLength(1);
  });

  it('TWO pickers mounted: zero duplicate ids anywhere in the document', () => {
    const a = track(mountPicker());
    const b = track(mountPicker());
    key(a.input, 'ArrowDown');
    key(b.input, 'ArrowDown');
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ModelPicker — keyboard', () => {
  it('ArrowDown opens with the first option active; navigation wraps; Home/End jump', () => {
    const { host, input } = track(mountPicker());
    key(input, 'ArrowDown');
    expect(activeDesc(input)).toContain('m1');
    key(input, 'ArrowDown');
    expect(activeDesc(input)).toContain('m2');
    key(input, 'End');
    expect(activeDesc(input)).toContain('m4');
    key(input, 'ArrowDown'); // wraps
    expect(activeDesc(input)).toContain('m1');
    key(input, 'ArrowUp'); // wraps back
    expect(activeDesc(input)).toContain('m4');
    key(input, 'Home');
    expect(activeDesc(input)).toContain('m1');
    const active = host.querySelector('[role="option"].active');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('ArrowUp from closed opens with the LAST option active', () => {
    const { input } = track(mountPicker());
    key(input, 'ArrowUp');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(activeDesc(input)).toContain('m4');
  });

  it('Enter commits the active option, resets the field, closes, and keeps focus', () => {
    const { host, input, onCommit } = track(mountPicker());
    input.focus();
    type(input, 'grok');
    key(input, 'Enter');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('m4');
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(host)).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('first Escape closes keeping the text; second Escape clears it', () => {
    const { host, input } = track(mountPicker());
    type(input, 'gpt');
    expect(panelOf(host)).not.toBeNull();
    key(input, 'Escape');
    expect(panelOf(host)).toBeNull();
    expect(input.value).toBe('gpt');
    key(input, 'Escape');
    expect(input.value).toBe('');
  });

  it('Tab closes without committing', () => {
    const { host, input, onCommit } = track(mountPicker());
    key(input, 'ArrowDown');
    key(input, 'Tab');
    expect(panelOf(host)).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores every combobox shortcut while an IME composition is active', () => {
    const { input, onCommit } = track(mountPicker());
    key(input, 'ArrowDown', { isComposing: true });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    type(input, 'gpt'); // filtering still tracks input events during composition
    expect(input.getAttribute('aria-expanded')).toBe('true');
    key(input, 'Enter', { isComposing: true }); // accepting a candidate
    expect(onCommit).not.toHaveBeenCalled();
    key(input, 'Enter');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('m1');
  });
});

describe('ModelPicker — filtering', () => {
  it('typing filters and resets the active row to the first match on every input event', () => {
    const { host, input } = track(mountPicker());
    key(input, 'ArrowDown');
    key(input, 'End');
    expect(activeDesc(input)).toContain('m4');
    type(input, 'gpt-5.6');
    expect(optionsOf(host)).toEqual(['gpt-5.6-sol$1 / $2 per 1M']);
    expect(activeDesc(input)).toContain('m2');
    type(input, 'chatgpt'); // provider-name match keeps the whole group
    expect(optionsOf(host)).toHaveLength(2);
    expect(activeDesc(input)).toContain('m1');
  });

  it('no match renders the explicit empty state, an honest count, and NO activedescendant', () => {
    const { host, input } = track(mountPicker());
    type(input, 'zzz');
    expect(host.querySelector('.mp-empty')?.textContent).toContain('No models match');
    expect(host.querySelector('.mp-footer')?.textContent).toBe('0 of 4 models');
    expect(activeDesc(input)).toBeNull();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it('zero addable models shows the empty state, never a blank panel', () => {
    const { host, input } = track(mountPicker([]));
    key(input, 'ArrowDown');
    expect(host.querySelector('.mp-empty')?.textContent).toBe('No addable models.');
    expect(host.querySelector('.mp-footer')?.textContent).toBe('0 of 0 models');
  });
});

describe('ModelPicker — pointer', () => {
  it('option mousedown is prevented and commits NOTHING; only the click commits (touch-safe)', () => {
    const { host, input, onCommit } = track(mountPicker());
    input.focus();
    input.click();
    expect(panelOf(host)).not.toBeNull();
    const option = host.querySelectorAll<HTMLElement>('[role="option"]')[2];
    if (!option) throw new Error('option missing');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const notPrevented = option.dispatchEvent(down);
    expect(notPrevented).toBe(false); // preventDefault() ran — the blur race is dead
    expect(onCommit).not.toHaveBeenCalled(); // a finger resting to scroll adds nothing
    option.click();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('m3');
    expect(panelOf(host)).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('clicking the field toggles; clicking outside closes without committing', () => {
    const { host, input, onCommit } = track(mountPicker());
    input.click();
    expect(panelOf(host)).not.toBeNull();
    input.click();
    expect(panelOf(host)).toBeNull();
    input.click();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panelOf(host)).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('ModelPicker — scroll/resize close + listener hygiene', () => {
  it('a scrolling ancestor (the app scrolls <main>, not window) closes the popup', () => {
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    const m = track(mountPicker());
    scroller.appendChild(m.host);
    key(m.input, 'ArrowDown');
    expect(panelOf(m.host)).not.toBeNull();
    scroller.dispatchEvent(new Event('scroll'));
    expect(panelOf(m.host)).toBeNull();
    expect(activeDesc(m.input)).toBeNull();
    scroller.remove();
  });

  it("the listbox's own scrolling does NOT close the popup", () => {
    const { host, input } = track(mountPicker());
    key(input, 'ArrowDown');
    const listbox = host.querySelector('[role="listbox"]');
    listbox?.dispatchEvent(new Event('scroll'));
    expect(panelOf(host)).not.toBeNull();
  });

  it("the input's OWN horizontal scroll (long query keeping the caret visible) does not close it", () => {
    const { host, input } = track(mountPicker());
    type(input, 'anthropic/claude-sonnet');
    expect(panelOf(host)).not.toBeNull();
    input.dispatchEvent(new Event('scroll'));
    expect(panelOf(host)).not.toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('window resize closes the popup', () => {
    const { host, input } = track(mountPicker());
    key(input, 'ArrowDown');
    window.dispatchEvent(new Event('resize'));
    expect(panelOf(host)).toBeNull();
  });

  it('document/window listeners are removed on close AND on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const scrollAdds = (): number => addSpy.mock.calls.filter((c) => c[0] === 'scroll').length;
    const scrollRemoves = (): number =>
      removeSpy.mock.calls.filter((c) => c[0] === 'scroll').length;

    const m = track(mountPicker());
    key(m.input, 'ArrowDown');
    expect(scrollAdds()).toBe(1);
    key(m.input, 'Escape'); // close removes
    expect(scrollRemoves()).toBe(1);
    key(m.input, 'ArrowDown'); // reopen re-attaches…
    expect(scrollAdds()).toBe(2);
    m.dispose(); // …and unmount-while-open removes
    mounted = mounted.filter((x) => x !== m);
    expect(scrollRemoves()).toBe(2);
  });
});

describe('ModelPicker — aria-activedescendant clears on EVERY close path', () => {
  const closePaths: Array<[string, (m: Mounted) => void]> = [
    ['Escape', (m) => key(m.input, 'Escape')],
    ['Tab', (m) => key(m.input, 'Tab')],
    [
      'outside click',
      () => document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    ],
    ['ancestor scroll', () => document.body.dispatchEvent(new Event('scroll'))],
    ['window resize', () => window.dispatchEvent(new Event('resize'))],
    ['commit', (m) => key(m.input, 'Enter')],
  ];

  for (const [name, closeVia] of closePaths) {
    it(`removes aria-activedescendant on ${name}`, () => {
      const m = track(mountPicker());
      key(m.input, 'ArrowDown');
      expect(activeDesc(m.input)).not.toBeNull();
      closeVia(m);
      expect(activeDesc(m.input)).toBeNull();
      expect(m.input.getAttribute('aria-expanded')).toBe('false');
    });
  }
});

describe('ModelPicker — status live region lifecycle', () => {
  it('is always mounted but EMPTY while closed; populated only while open', () => {
    const { host, input } = track(mountPicker());
    const status = host.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(status?.textContent).toBe('');
    key(input, 'ArrowDown');
    expect(status?.textContent).toBe('4 of 4 models');
    type(input, 'grok');
    expect(status?.textContent).toBe('1 of 4 models');
    key(input, 'Escape');
    expect(status?.textContent).toBe('');
  });
});
