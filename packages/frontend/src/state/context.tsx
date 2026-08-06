import { createContext, useContext, type ParentProps } from 'solid-js';
import type { AppStore } from './appState';

/**
 * Solid context holding the app store, so `App`/pages consume the store from the
 * tree rather than the module singleton. This is the test seam: specs render
 * `<AppProvider store={createAppStore(fakeClient)}>` to inject a `FakeApiClient`.
 * `index.tsx` provides the default singleton for production.
 */
const AppContext = createContext<AppStore>();

export function AppProvider(props: ParentProps<{ store: AppStore }>) {
  return <AppContext.Provider value={props.store}>{props.children}</AppContext.Provider>;
}

/** The store if one is provided, else undefined.
 *
 * The test seam for components that are deliberately store-independent: `ModelPicker`'s
 * suite mounts it standalone, and requiring a provider there would rewrite 24 passing specs
 * to test the harness rather than the component. A component using this must behave
 * correctly with no store — for the picker that means its own keyboard handling still
 * works; it simply does not participate in layer ordering when there is no registry. */
export function useAppOptional(): AppStore | undefined {
  return useContext(AppContext);
}

export function useApp(): AppStore {
  const store = useContext(AppContext);
  if (!store) throw new Error('useApp must be used within an AppProvider');
  return store;
}
