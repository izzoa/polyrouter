import { onCleanup, Show } from 'solid-js';
import type { ToastKind } from '../state/appState';
import { useApp } from '../state/context';

/** The toast's two live regions (adopt-design-tokens-v2 D13; dashboard-core "Dashboard
 * controls are semantic, keyboard-operable, and announced").
 *
 * Both regions are ALWAYS mounted, empty until a message arrives: a live region inserted
 * together with its text is not reliably announced, so the region must already be in the
 * document when the text lands. A confirmation goes to the polite `status` region, a failure
 * that is still a toast to the `alert` region; one toast shows at a time, in its kind's region,
 * and a toast of the other kind waits for its time rather than cutting it short (the store's
 * `showToast`; dashboard-core "A toast gives its reader time").
 *
 * Each region is `position: fixed` inline, so the shell's in-flow pane contract
 * (`shellLayout.test.tsx`) reads it as out of flow; it has no box of its own. The visible bar
 * inside is `.toast`, which carries the geometry.
 *
 * The timer pauses while the pointer rests on the bar or focus is inside it, and resumes on
 * leave (the store keeps the time left). A bar that unmounts while held — cleared, or reset
 * with its account — releases the hold, since no leave event follows a removed node. */
export function Toast() {
  return (
    <>
      <div role="status" aria-live="polite" data-toast-region="confirm" style="position:fixed">
        <ToastBar kind="confirm" />
      </div>
      <div role="alert" data-toast-region="failure" style="position:fixed">
        <ToastBar kind="failure" />
      </div>
    </>
  );
}

function ToastBar(props: { kind: ToastKind }) {
  const app = useApp();
  const text = (): string | null =>
    app.state.toast?.kind === props.kind ? app.state.toast.text : null;
  return (
    <Show when={text()}>
      {(message) => {
        let hovered = false;
        let focused = false;
        const sync = (): void => app.holdToast(hovered || focused);
        onCleanup(() => app.holdToast(false));
        return (
          <div
            class="toast"
            onPointerEnter={() => {
              hovered = true;
              sync();
            }}
            onPointerLeave={() => {
              hovered = false;
              sync();
            }}
            onFocusIn={() => {
              focused = true;
              sync();
            }}
            onFocusOut={(e) => {
              // Focus moving between two controls inside the bar stays inside it.
              if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))
                return;
              focused = false;
              sync();
            }}
          >
            {message()}
          </div>
        );
      }}
    </Show>
  );
}
