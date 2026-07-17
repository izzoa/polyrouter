import { Show } from 'solid-js';
import { useApp } from '../state/context';

export function Toast() {
  const app = useApp();
  return (
    <Show when={app.state.toast}>
      <div class="toast" role="status">
        {app.state.toast}
      </div>
    </Show>
  );
}
