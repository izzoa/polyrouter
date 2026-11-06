/**
 * The endpoint chip confirms a copy in place (adopt-design-tokens-v2 task 4.5, design.md D19;
 * dashboard-core "The endpoint chip confirms a copy in place").
 *
 * After a successful `copy()` the chip reads `Copied` until the confirmation toast clears,
 * with its accessible name unchanged and its width held by stacked labels: both labels are
 * rendered in one grid cell and the inactive one is `visibility: hidden`. A rejected
 * clipboard write shows no `Copied`.
 *
 * happy-dom does no layout — `offsetWidth` is always 0 — so the width is asserted twice: as
 * `offsetWidth` here (as the task asks; a structural change that unmounted a label would still
 * show here as a lost node), and as the stacked-label structure that makes the width hold. The
 * rendered width itself is measured in the browser (`heightFamily.spec.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topbar } from './components/Topbar';
import { createAppStore } from './state/appState';
import { AppProvider } from './state/context';
import { FakeApiClient } from './test/fakeClient';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

let sheet: HTMLStyleElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  sheet.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(): { chip: HTMLButtonElement; store: ReturnType<typeof createAppStore> } {
  const store = createAppStore(new FakeApiClient());
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () => (
      <AppProvider store={store}>
        <Topbar />
      </AppProvider>
    ),
    host,
  );
  const chip = host.querySelector<HTMLButtonElement>('button.endpoint-chip');
  expect(chip, 'the top bar renders the endpoint chip').not.toBeNull();
  return { chip: chip!, store };
}

/** The chip's two labels, in document order: [rest, alt]. */
function labels(chip: HTMLElement): HTMLElement[] {
  const cell = chip.querySelector<HTMLElement>('.stacked-label');
  expect(cell, 'the chip stacks its labels in one cell').not.toBeNull();
  return [...cell!.querySelectorAll<HTMLElement>(':scope > .stacked-label-item')];
}

/** The label a reader sees: the one that is not `visibility: hidden`. */
function shown(chip: HTMLElement): string {
  const visible = labels(chip).filter((l) => getComputedStyle(l).visibility !== 'hidden');
  expect(visible, 'exactly one label is visible').toHaveLength(1);
  return visible[0]!.textContent ?? '';
}

/** Let the clipboard promise and the store's continuation run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('the endpoint chip confirms a copy in place', () => {
  it('reads Copied after a successful copy, keeping its width and name, until the toast clears', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { chip, store } = mount();
    const name = chip.getAttribute('aria-label');
    const width = chip.offsetWidth;
    expect(shown(chip)).toBe('/v1');

    chip.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(store.state.toast, 'the confirmation toast is showing').not.toBeNull();
    expect(shown(chip)).toBe('Copied');
    // Both labels still occupy the one grid cell, the inactive one hidden — the structure
    // that holds the width.
    const [rest, alt] = labels(chip);
    expect(rest!.textContent).toBe('/v1');
    expect(alt!.textContent).toBe('Copied');
    for (const l of [rest!, alt!]) expect(getComputedStyle(l).gridArea).toMatch(/^1 \/ 1/);
    expect(getComputedStyle(rest!).visibility).toBe('hidden');
    expect(chip.offsetWidth).toBe(width);
    expect(chip.getAttribute('aria-label'), 'the accessible name does not change').toBe(name);

    // The toast clears on its timer, and the chip reads /v1 again.
    await vi.runAllTimersAsync();
    expect(store.state.toast).toBeNull();
    expect(shown(chip)).toBe('/v1');
    expect(chip.offsetWidth).toBe(width);
  });

  it('shows no Copied when the clipboard write is rejected', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { chip, store } = mount();
    chip.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(store.state.toast?.kind, 'the failure is still reported, as a failure').toBe('failure');
    expect(store.state.toast?.text).toMatch(/Copy failed/);
    expect(shown(chip)).toBe('/v1');
  });

  it('shows no Copied while some other toast is up', () => {
    const { chip, store } = mount();
    store.say('Agent created');
    expect(shown(chip)).toBe('/v1');
  });
});

describe("the chip's Copied is its own copy's, never another control's", () => {
  it('a copy of the same URL from elsewhere (Settings) does not flip the chip', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { chip, store } = mount();
    // Settings' Instance strip copies the endpoint with the same confirmation words.
    store.copy('http://localhost:3001/v1', 'Endpoint copied');
    await settle();
    expect(store.state.toast, 'the Settings copy confirmed').toEqual({
      kind: 'confirm',
      text: 'Endpoint copied',
    });
    expect(shown(chip), 'the chip was never pressed').toBe('/v1');
  });

  it('pressed while a failure shows, it reads Copied when its confirmation takes the screen', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { chip, store } = mount();
    store.sayFailure('Sync failed — upstream 502');
    chip.click();
    await settle();
    // The confirmation waits for the failure's time (D13); the chip claims nothing meanwhile.
    expect(store.state.toast?.kind).toBe('failure');
    expect(shown(chip)).toBe('/v1');
    await vi.advanceTimersByTimeAsync(8000);
    expect(store.state.toast).toEqual({ kind: 'confirm', text: 'Endpoint copied' });
    expect(shown(chip)).toBe('Copied');
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.state.toast).toBeNull();
    expect(shown(chip)).toBe('/v1');
    // And a later Settings copy, after the chip's own has cleared, leaves it at rest.
    store.copy('http://localhost:3001/v1', 'Endpoint copied');
    await settle();
    expect(shown(chip)).toBe('/v1');
  });
});
