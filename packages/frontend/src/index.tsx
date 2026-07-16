/* @refresh reload */
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
