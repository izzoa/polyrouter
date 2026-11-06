import type { JSX } from 'solid-js';

/** The skeleton block's shape: its width is set in `ch` to the expected string, except where
 * the placeholder stands for something that is not text (`styles.css`, "The shared figure
 * skeleton"). */
export type FigureSkeletonSize =
  'count' | 'cell' | 'line' | 'short' | 'note' | 'display' | 'title' | 'bar';

/**
 * A figure's loading placeholder (adopt-figure-states design D5; DESIGN.md Figures and their
 * states → Loading): the one shared skeleton block (`.fig-skel`: Chip Tone, 4px radius, the
 * stylesheet's 1.6s `pulse`, which reduced motion stills) paired with visually hidden
 * `Loading <what>`, so the slot names its state in words and never reads as a dash, a zero
 * or a blank. The block itself is decorative.
 *
 * Render it only while a figure FIRST loads: a refetch keeps the previous figures, and a
 * failed first load ends in the failed state, never a skeleton that pulses on.
 */
export function FigureSkeleton(props: {
  /** What is loading, as the hidden text finishes it: `requests` reads `Loading requests`. */
  what: string;
  size: FigureSkeletonSize;
}): JSX.Element {
  return (
    <>
      <span class={`fig-skel fig-skel-${props.size}`} aria-hidden="true" />
      <span class="sr-only">{`Loading ${props.what}`}</span>
    </>
  );
}
