import { createEffect, createMemo, on, Show, splitProps, type JSX } from 'solid-js';
import { createFocusReturn } from './busy';
import { Icon } from './Icon';
import { StackedLabel } from './StackedLabel';

/** A notice's tone (adopt-design-tokens-v2 D15; DESIGN.md Notices). */
export type NoticeTone = 'info' | 'success' | 'caution' | 'failure';

/** Tone → role. Info, success and caution are polite status regions; a failure is an alert
 * (dashboard-core "Notices share one anatomy and four tones"). The fill and the title colour
 * hang on `.notice--<tone>` in `styles.css`. */
export const NOTICE_ROLE: Readonly<Record<NoticeTone, 'status' | 'alert'>> = {
  info: 'status',
  success: 'status',
  caution: 'status',
  failure: 'alert',
};

/** The notice's one action, always a ghost button. A request-starting action that stays
 * shown while its request is in flight passes `busyLabel` and `busy` (D14): it is then
 * natively disabled, `aria-busy`, and stacks both labels so it keeps its width. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
  busy?: boolean;
  busyLabel?: string;
}

/** The notice's dismiss control (add-dismissible-terms-risk, design D5). ONLY a standing advisory
 * passes it — a property of the configuration that nothing in the dashboard can fix, such as a
 * subscription's terms risk. A notice about a condition that ends once its cause is fixed never
 * does (dashboard-core "Notices share one anatomy and four tones"); `notices.view.test.tsx`
 * holds every call site to that. `label` is the accessible name and says what is dismissed. A
 * dismissal that sends a request passes `busy` while it is in flight (D14): the control is then
 * natively disabled and `aria-busy`, and focus comes back to it if the notice survives. */
export interface NoticeDismiss {
  label: string;
  onDismiss: () => void;
  busy?: boolean;
  /** The accessible name while `busy`: a glyph-only control carries its progressive label in
   * its name, never in its glyph, so its width never changes (D14). */
  busyLabel?: string;
}

export type NoticeProps = Pick<JSX.HTMLAttributes<HTMLDivElement>, 'id' | 'tabindex' | 'style'> & {
  tone: NoticeTone;
  /** A status word: `Couldn’t load`, `Unverified`, `Reconnect needed`. */
  title: string;
  /** One or two sentences, in Ink 2. */
  children: JSX.Element;
  /** At most one action: the type allows one, never a list. */
  action?: NoticeAction;
  /** A standing advisory's `×`, at the end of the title's row (see `NoticeDismiss`). */
  dismiss?: NoticeDismiss;
  /** Data attributes pass through (`data-testid`, a page's own markers). */
  [data: `data-${string}`]: string | boolean | undefined;
};

/** One notice anatomy in four tones (D15): a status-word title in the Section role and the
 * tone's text colour, a body in Ink 2, at most one ghost action on a Panel fill, on the tone's
 * wash with a 6px radius and 12px padding — no icon-only variant, no coloured side stripe.
 *
 * It renders once and never re-keys itself: a caller shows it under a non-keyed `<Show>`, so
 * a background refresh that re-renders its surface updates the text in place and the region
 * is not announced again. An `id` and `tabindex` pass through, for a notice that is a focus
 * target (the Targets matrix's unverified notice). A notice about a condition that ends once its
 * cause is fixed has no dismiss control; only a standing advisory passes `dismiss`, which adds one
 * icon-only `×` at the end of the title's row, apart from the one ghost action
 * (add-dismissible-terms-risk). */
export function Notice(props: NoticeProps) {
  const [local, rest] = splitProps(props, ['tone', 'title', 'children', 'action', 'dismiss']);
  // A busy action is natively disabled, which drops its focus to <body>; when the caller's
  // request settles and the action survives (a Targets Retry that failed again), focus goes
  // back to it (`createFocusReturn`, D14).
  const focus = createFocusReturn();
  createEffect(
    on(
      () => local.action?.busy === true,
      (busy, was) => {
        if (was === true && !busy) focus.restore();
      },
    ),
  );
  // The dismiss control keeps the same rule: busy while its request is in flight, and focus back
  // on it when the request settles and the notice survives (a failed dismissal). A success
  // unmounts the notice, so the caller places focus (design D6).
  const dismissFocus = createFocusReturn();
  createEffect(
    on(
      () => local.dismiss?.busy === true,
      (busy, was) => {
        if (was === true && !busy) dismissFocus.restore();
      },
    ),
  );
  return (
    <div
      {...rest}
      class={`notice notice--${local.tone}${local.dismiss ? ' notice--dismissible' : ''}`}
      role={NOTICE_ROLE[local.tone]}
    >
      <div class="notice-text">
        <Show
          when={local.dismiss}
          fallback={<div class="notice-title t-section">{local.title}</div>}
        >
          {(dismiss) => (
            // The `×` shares the title's row (design D5, as applied): the title wraps before it,
            // the body runs the full width below it, and nothing is positioned over the text.
            <div class="notice-head">
              <div class="notice-title t-section">{local.title}</div>
              <button
                type="button"
                class="notice-dismiss"
                aria-label={
                  dismiss().busy === true && dismiss().busyLabel !== undefined
                    ? dismiss().busyLabel
                    : dismiss().label
                }
                title={dismiss().label}
                disabled={dismiss().busy === true}
                aria-busy={dismiss().busy === true ? true : undefined}
                onClick={() => {
                  dismissFocus.capture();
                  dismiss().onDismiss();
                  if (local.dismiss?.busy !== true) dismissFocus.drop();
                }}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}
        </Show>
        <div class="notice-body t-body">{local.children}</div>
      </div>
      <Show when={local.action}>
        {(action) => (
          <button
            type="button"
            class="btn-ghost notice-action"
            disabled={action().busy === true}
            aria-busy={action().busy === true ? true : undefined}
            onClick={() => {
              focus.capture();
              action().onClick();
              // A click that started no request (its caller declined) holds nothing.
              if (local.action?.busy !== true) focus.drop();
            }}
          >
            <Show when={action().busyLabel} fallback={action().label}>
              {(busyLabel) => (
                <StackedLabel
                  alt={action().busy === true}
                  rest={action().label}
                  altLabel={busyLabel()}
                />
              )}
            </Show>
          </button>
        )}
      </Show>
    </div>
  );
}

/** A load failure, held across a reload that has not settled (D15: a background refresh does
 * not announce a notice again).
 *
 * Every page loader clears its error when it starts and sets it again if it fails. Shown
 * straight from the error, a load-failure notice would therefore unmount and be inserted
 * again — announced again — on every poll of a failing load. This keeps the last message
 * while a reload is in flight and drops it only when a load settles without one.
 *
 * `release()` is the Retry: called just before the user's own reload starts, it lets that
 * load's start clear the notice at once, so the Retry inside it unmounts as its load starts
 * (`test/busyActionsTable.ts`, class `unmounts`) and the retry's outcome is announced as new.
 * A load that settles ends the release. */
export function createHeldFailure(
  failure: () => string | null,
  loading: () => boolean,
): { message: () => string | null; release: () => void } {
  let released = false;
  const message = createMemo<string | null>((shown) => {
    const now = failure();
    const inFlight = loading();
    if (!inFlight) released = false;
    if (now !== null) return now;
    return inFlight && !released ? shown : null;
  }, null);
  return {
    message,
    release: () => {
      released = true;
    },
  };
}
