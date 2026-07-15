import { Show } from 'solid-js';
import { app } from '../state/appState';

export function Toast() {
  return (
    <Show when={app.state.toast}>
      <div class="toast">{app.state.toast}</div>
    </Show>
  );
}
