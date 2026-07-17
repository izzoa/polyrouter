/** Shared mount for full-page adapters: the app's real page component inside
 * its own store, backed by the FakeApiClient demo corpus (pages self-load from
 * it exactly like they load from the real API). */
import { demoFakeOptions, mountWithApp, solid, type Disposer } from '../../solid/design-kit.mjs';

export function mountPage(
  el: HTMLElement,
  name: string,
  props: Record<string, unknown> = {},
  seed?: Record<string, unknown>,
): Disposer {
  const fake = demoFakeOptions() as Record<string, unknown>;
  return mountWithApp(el, solid[name]!, props, {
    fake,
    seed: {
      session: fake['session'],
      agents: fake['agents'],
      providers: fake['providers'],
      models: fake['models'],
      ...seed,
    },
  });
}
