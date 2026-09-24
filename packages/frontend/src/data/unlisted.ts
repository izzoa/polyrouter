import { fmtWhen } from './format';

/** add-live-subscription-models: how a model the provider no longer lists is said —
 * "No longer offered · noticed 2d ago" in words and a neutral tone (never colour
 * alone), with the calendar date in the accessible name and tooltip. One wording for
 * every surface (the Providers models list, the model picker, batch rows). */
export function unlistedText(
  iso: string,
  now: number = Date.now(),
): { line: string; label: string; day: string } {
  const t = Date.parse(iso);
  const day = Number.isNaN(t) ? 'an unknown date' : new Date(t).toLocaleDateString();
  return {
    line: `No longer offered by the provider · noticed ${fmtWhen(iso, now)}`,
    label: `No longer offered by the provider since ${day}`,
    day,
  };
}
