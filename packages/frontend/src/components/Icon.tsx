/** Interface iconography (replace-fallback-symbol-glyphs).
 *
 * These were symbol CHARACTERS — `⧉`, `✕`, `▾`, `⋮⋮` and friends — none of which the bundled
 * Geist files contain. A character the fonts lack is drawn with whatever font the viewer's
 * operating system supplies, so the same control rendered as FreeSerif on one machine and an
 * Apple symbol face on another: different shapes, weights and metrics, on the axis the design
 * lock cares most about.
 *
 * Same shape as `PageIcon`, deliberately — one registry, lucide geometry, `currentColor`,
 * stroke 1.5, nothing fetched at runtime, no icon-library dependency. Two registries would let
 * the same idea drift between them, which is the problem this is fixing.
 *
 * ALWAYS DECORATIVE. Every icon here is `aria-hidden`. Where a mark indicates a state, the
 * state belongs in text — see `dashboard-core`'s "a state is never indicated by a decorative
 * mark alone". Artwork can fail to render, be restyled, or be replaced; meaning must not ride
 * on it.
 */
import type { JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

const Copy = (): JSX.Element => (
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>
);

const Close = (): JSX.Element => (
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>
);

const ChevronDown = (): JSX.Element => <path d="m6 9 6 6 6-6" />;
const ChevronUp = (): JSX.Element => <path d="m18 15-6-6-6 6" />;
const ChevronRight = (): JSX.Element => <path d="m9 18 6-6-6-6" />;

/** Drag handle. Replaces `⋮⋮`, which was two glyphs pretending to be one control. */
const Grip = (): JSX.Element => (
  <>
    <circle cx="9" cy="5" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="19" r="1" />
  </>
);

/** Opens somewhere else. Deliberately NOT the same drawing as `escalated`: they were the same
 * character (`↗`) doing two unrelated jobs, and inheriting that collision would make a link
 * cue and a routing outcome look identical. */
const ExternalLink = (): JSX.Element => (
  <>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </>
);

/** A request that was escalated to a stronger model. */
const Escalated = (): JSX.Element => (
  <>
    <path d="M7 7h10v10" />
    <path d="M7 17 17 7" />
  </>
);

/** Flows-to, between two chips. */
const ArrowRight = (): JSX.Element => (
  <>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </>
);

const Check = (): JSX.Element => <path d="M20 6 9 17l-5-5" />;

export const ICONS = {
  copy: Copy,
  close: Close,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronRight: ChevronRight,
  grip: Grip,
  externalLink: ExternalLink,
  escalated: Escalated,
  arrowRight: ArrowRight,
  check: Check,
} satisfies Record<string, () => JSX.Element>;

export type IconName = keyof typeof ICONS;

/** Decorative artwork. `data-icon` is a stable test hook. */
export function Icon(props: { name: IconName; size?: number; style?: string }): JSX.Element {
  return (
    <svg
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={`flex:none;vertical-align:-0.125em;${props.style ?? ''}`}
      data-icon={props.name}
      aria-hidden="true"
    >
      <Dynamic component={ICONS[props.name]} />
    </svg>
  );
}
