/**
 * The help / invalid pattern shared by every entry field (adopt-design-tokens-v2 task 8.2;
 * design.md D20; DESIGN.md Inputs / Fields).
 *
 * Under a field sits one note: its help (`.field-help`, what the field takes), or — while
 * one of the dashboard's own checks fails — the message that REPLACES it (`.field-error`,
 * the problem and its fix). The field names whichever note is showing through
 * `aria-describedby`, and carries `aria-invalid="true"` while its check fails, which also
 * draws its red edge (`styles.css`). Checks run on blur and on submit, never on a keystroke:
 * an edit only clears a message the value now passes.
 *
 * Store-backed forms keep their messages in `state.fieldErrors` (`useFields`); the two forms
 * that keep their values in component signals — sign-in and a model's price editor — use
 * `createLocalFields` with the same contract.
 */
import { createSignal, Show, type JSX } from 'solid-js';
import { useApp } from '../state/context';
import { focusFirstFailing, type FieldId } from '../state/fieldChecks';

/** The id of a field's help node. */
export const helpId = (field: string): string => `${field}-help`;
/** The id of a field's invalid message node. */
export const errorId = (field: string): string => `${field}-error`;

/** The note under a field: its help, or the message that replaces it while it is invalid.
 * `role="alert"` is for the one field whose message is the only feedback an attempt gets
 * (the subscription paste, which every attempt clears). */
export function FieldNote(props: {
  for: string;
  error: string | null;
  help?: JSX.Element;
  alert?: boolean;
}): JSX.Element {
  return (
    <Show
      when={props.error}
      fallback={
        <Show when={props.help !== undefined}>
          <div id={helpId(props.for)} class="field-help">
            {props.help}
          </div>
        </Show>
      }
    >
      {(message) => (
        <div
          id={errorId(props.for)}
          class="field-error"
          role={props.alert === true ? 'alert' : undefined}
        >
          {message()}
        </div>
      )}
    </Show>
  );
}

/** What a field binds: its message, its ARIA, and the blur / edit hooks. */
export interface Fields<K extends string> {
  /** The field's showing message, or null. */
  error: (id: K) => string | null;
  /** `aria-invalid` while the field's check fails. */
  invalid: (id: K) => 'true' | undefined;
  /** `aria-describedby`: the message while invalid, else the help when it has one. */
  describedBy: (id: K, hasHelp?: boolean) => string | undefined;
  /** On blur: run the field's check. */
  check: (id: K) => void;
  /** On input or change: clear a message the value now passes; never set one. */
  edit: (id: K) => void;
}

function describe(id: string, message: string | null, hasHelp: boolean): string | undefined {
  if (message !== null) return errorId(id);
  return hasHelp ? helpId(id) : undefined;
}

/** The store-backed fields (`state.fieldErrors`, checks in `state/fieldChecks.ts`). */
export function useFields(): Fields<FieldId> {
  const app = useApp();
  const error = (id: FieldId): string | null => app.state.fieldErrors[id] ?? null;
  return {
    error,
    invalid: (id) => (error(id) !== null ? 'true' : undefined),
    describedBy: (id, hasHelp = false) => describe(id, error(id), hasHelp),
    check: (id) => app.checkField(id),
    edit: (id) => app.editField(id),
  };
}

/** Fields whose values live in component signals, keyed by their DOM id. `submit` runs the
 * named checks and answers whether all pass. */
export function createLocalFields(
  checks: Record<string, () => string | null>,
): Fields<string> & { submit: (ids: readonly string[]) => boolean } {
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const set = (id: string, message: string | null): void => {
    setErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  };
  const run = (id: string): string | null => {
    const check = checks[id];
    return check === undefined ? null : check();
  };
  const error = (id: string): string | null => errors()[id] ?? null;
  return {
    error,
    invalid: (id) => (error(id) !== null ? 'true' : undefined),
    describedBy: (id, hasHelp = false) => describe(id, error(id), hasHelp),
    check: (id) => set(id, run(id)),
    edit: (id) => {
      if (error(id) !== null && run(id) === null) set(id, null);
    },
    submit: (ids) => {
      const failing: string[] = [];
      for (const id of ids) {
        const message = run(id);
        set(id, message);
        if (message !== null) failing.push(id);
      }
      // As a store-backed submit does: the first failing field takes focus, so its message
      // is announced with it.
      focusFirstFailing(failing);
      return failing.length === 0;
    },
  };
}
