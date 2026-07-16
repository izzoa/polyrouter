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

export function useApp(): AppStore {
  const store = useContext(AppContext);
  if (!store) throw new Error('useApp must be used within an AppProvider');
  return store;
}
