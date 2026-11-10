import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../state/appState';
import { AppProvider } from '../state/context';
import { FakeApiClient } from '../test/fakeClient';
import { Chart } from './Chart';

describe('<Chart> (uPlot wrapper)', () => {
  it('smoke-mounts a single-series line without throwing (canvas shim)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore(new FakeApiClient());
    let dispose = (): void => {};
    expect(() => {
      dispose = render(
        () => (
          <AppProvider store={store}>
            <Chart
              data={[
                [1_600_000_000, 1_600_003_600, 1_600_007_200],
                [5, 8, 6],
              ]}
              height={120}
            />
          </AppProvider>
        ),
        host,
      );
    }).not.toThrow();
    // uPlot created its root element into the wrapper.
    expect(host.querySelector('.uplot')).not.toBeNull();
    dispose();
    host.remove();
  });

  it('draws a usage graph’s options through the real uPlot: only nulls, a lone point, a dashed reset (add-subscription-usage-history)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore(new FakeApiClient());
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
    };
    globalThis.addEventListener('error', onError);
    const graph = (data: [number[], (number | null)[]]) => (
      <Chart
        data={data}
        height={64}
        accentFirst={false}
        neutralTone="ink2"
        isolatedPoints
        hideXAxis
        xExtent={[1_600_000_000, 1_600_018_000]}
        yExtent={[0, 100]}
        ySplits={[0, 50, 100]}
        yAxisSize={44}
        yFormat={(v) => (v >= 100 ? '100%' : v <= 0 ? '0' : '')}
        referenceX={1_600_018_000}
      />
    );
    let dispose = (): void => {};
    expect(() => {
      dispose = render(
        () => (
          <AppProvider store={store}>
            {/* The empty track, and a lone reading between unknown ones. */}
            {graph([
              [1_600_000_000, 1_600_018_000],
              [null, null],
            ])}
            {graph([
              [1_600_000_000, 1_600_003_600, 1_600_007_200],
              [null, 42, null],
            ])}
          </AppProvider>
        ),
        host,
      );
    }).not.toThrow();
    // uPlot commits and draws (the reference hook included) on a microtask.
    await new Promise((r) => setTimeout(r, 0));
    globalThis.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(host.querySelectorAll('.uplot')).toHaveLength(2);
    dispose();
    host.remove();
  });
});
