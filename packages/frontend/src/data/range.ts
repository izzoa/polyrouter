import type { Range } from '../types';

/** The concrete analytics query window a UI `Range` maps to. `from`/`to` are ISO
 * strings (the API just filters `[from, to)`); `bucket` is the timeseries grain. */
export interface RangeParams {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
}

const DAY_MS = 86_400_000;

/** Pure `Range` → `{ from, to, bucket }` on the client clock (fine — the API only
 * filters a range). `24h` → last 24h at hourly grain; `7d`/`30d` → daily grain.
 * Kept pure + `now`-injected so it is unit-testable and a frozen `now` yields a
 * stable window (the requests page freezes this, never re-deriving from the clock). */
export function rangeToParams(range: Range, now: number): RangeParams {
  const to = new Date(now).toISOString();
  if (range === '24h') {
    return { from: new Date(now - DAY_MS).toISOString(), to, bucket: 'hour' };
  }
  const days = range === '7d' ? 7 : 30;
  return { from: new Date(now - days * DAY_MS).toISOString(), to, bucket: 'day' };
}
