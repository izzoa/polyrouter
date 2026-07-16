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
});
