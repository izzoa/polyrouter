/* @refresh reload */
// MUST STAY FIRST. This neutralises a non-conforming `navigator.language` before uPlot's
// module body reads it (`App → Overview → Chart → uplot`, all eager). Imports evaluate in
// source order, so moving this below `./App` — as an alphabetical import sort would — puts it
// after the throw and silently restores the blank-page bug. `browser/bootResilience.spec.ts`
// loads this real entry point under a rejected tag and is what catches that.
import './localeGuard';
import { render } from 'solid-js/web';
import { App } from './App';
import { app } from './state/appState';
import { AppProvider } from './state/context';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element missing in index.html');
}
render(
  () => (
    <AppProvider store={app}>
      <App />
    </AppProvider>
  ),
  root,
);
