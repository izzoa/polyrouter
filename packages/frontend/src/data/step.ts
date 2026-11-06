/** Stepping the inspector's selection (add-docked-inspector design D8).
 *
 * A step moves the selection to the adjacent OPENABLE request — a completed row, the only kind
 * with a detail surface. Its input is the rendered order of completed rows alone (the request
 * list on Requests, the Overview card's recent requests there), so a running or finishing row,
 * a batch job row, an agent group boundary, the "N new" offer and "Load more" are not in it and
 * cannot be stepped to: stepping passes over them by construction, not by a skip rule. */

/** Which way a step goes: Previous / ArrowUp is toward the top of the list, Next / ArrowDown
 * toward its end. */
export type StepDirection = 'previous' | 'next';

/** The id a step from `fromId` lands on, or `null` when there is none: at either end (a step
 * never wraps, never pages and never takes the new-rows offer) and for an id that is not in
 * the order (a request that has left the loaded rows has no neighbours). Pure: it reads only
 * its arguments. */
export function stepTarget(
  order: readonly string[],
  fromId: string | null,
  dir: StepDirection,
): string | null {
  if (fromId === null) return null;
  const i = order.indexOf(fromId);
  if (i === -1) return null;
  return order[dir === 'next' ? i + 1 : i - 1] ?? null;
}

/** The step a keydown asks for, or `null` when stepping must stay out of the way (design D8):
 * an input method is composing, or Alt, Control, Meta or Shift is held, or the key is not
 * ArrowUp / ArrowDown. The caller checks the rest — that the target is a request row or a
 * Previous / Next control, and that the inspector is the topmost layer. */
export function stepKey(e: KeyboardEvent): StepDirection | null {
  if (e.isComposing) return null;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowUp') return 'previous';
  if (e.key === 'ArrowDown') return 'next';
  return null;
}

/** How long the selection must stay on one request before its step is announced (design D10;
 * dashboard-analytics "A burst of steps is announced once, where it stops"). A held arrow key
 * repeats at roughly 30 a second, well inside it, so a burst is announced once, where it stops;
 * a deliberate step, spaced further apart than this, is announced on its own. */
export const STEP_ANNOUNCE_SETTLE_MS = 250;
